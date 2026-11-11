// The lane state machine: the declared phases, results and end causes of a lane, the one decision
// for its final result and exit code, the one reader that turns a persisted state into a
// structured end (the recorded { result, cause, detail } first, the legacy free-text rules after),
// and the one atomic terminal writer. Pure logic: it starts nothing, and it never throws; a
// corrupted or missing state fails closed (unknown cause, no rewrite, no crash of a live lane).
import path from 'node:path';
import { writeAtomic } from './common.mjs';

export const PHASES = ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart', 'finished'];
export const RESULTS = ['done', 'needs review', 'unverified', 'checks failing', 'paused', 'stopped', 'failed', 'killed'];
export const CAUSES = ['ok', 'review', 'checks', 'infra', 'timeout', 'lead-stop', 'supervisor-died', 'repo-gone', 'auth', 'not-writable', 'runner-error', 'unknown'];

// Every phase but 'finished' is live, and a live phase may move to any other live phase: the loop
// between build, gate, fix, review, backoff and restart is real (gates fail, reviews ask for
// fixes, waits expire), and 'starting' hands over to whichever comes first. Any live phase may
// finish. 'finished' is terminal, and a phase or target outside the declaration is illegal; the
// caller records the anomaly and carries on, it never throws.
export function canTransition(from, to) {
  if (!PHASES.includes(from) || !PHASES.includes(to)) return false;
  if (from === 'finished') return false;
  return true;
}

// The one decision for a lane's final result and exit code, the old inline ternary in lane.mjs
// unchanged: a review verdict other than 'ready' ends the lane at 'needs review' unless reviews
// are off, exit 0 is done, a forced result wins, and otherwise the reason says stopped, paused
// (timeout) or failed. The cause says what ended the lane, for every reader after this.
export function decideEnd({ exitCode, forcedResult, reason, verdict, noReview } = {}) {
  const needsReview = !!verdict && verdict !== 'ready' && !noReview;
  const result = exitCode === 0 ? (needsReview ? 'needs review' : 'done')
    : forcedResult === 'unverified' && exitCode === 4 ? (needsReview ? 'needs review' : 'unverified')
    : (forcedResult || (reason === 'stopped' ? 'stopped' : reason === 'timeout' ? 'paused' : 'failed'));
  const code = result === 'needs review' ? 4 : result === 'paused' ? 5 : result === 'unverified' ? 4 : result === 'checks failing' ? 1 : exitCode;
  const cause = result === 'done' ? 'ok'
    : result === 'needs review' ? 'review'
    : result === 'unverified' ? 'infra'
    : result === 'checks failing' ? 'checks'
    : result === 'paused' ? 'timeout'
    : result === 'stopped' ? 'lead-stop'
    : (exitCode === 3 || reason === 'auth') ? 'auth'
    : /^repo not writable/.test(String(reason || '')) ? 'not-writable'
    : /^runner error/.test(String(reason || '')) ? 'runner-error'
    : 'unknown';
  return { result, exitCode: code, cause };
}

// The one reader: what ended this lane, as { result, cause, detail }. null while it still runs.
// The recorded structured end wins when its cause is declared; the legacy rules follow only for
// old states, so every free-text regex lives here, in one place. Never throws, never mutates.
export function endOf(s) {
  if (!s || !s.result) return null;
  const reason = String(s.reason || '');
  const activity = String(s.activity || '');
  const res = s.result === 'failed' && reason === 'timeout' ? 'paused' : s.result; // legacy pause
  const e = s.end;
  if (e && typeof e === 'object' && CAUSES.includes(e.cause)) {
    return { result: RESULTS.includes(e.result) ? e.result : res, cause: e.cause, detail: String(e.detail || '') };
  }
  if (res === 'done') return { result: 'done', cause: 'ok', detail: reason };
  if (res === 'needs review') return { result: 'needs review', cause: 'review', detail: reason };
  if (res === 'unverified') return { result: 'unverified', cause: 'infra', detail: reason };
  if (res === 'checks failing') return { result: 'checks failing', cause: 'checks', detail: reason };
  if (res === 'paused') return { result: 'paused', cause: 'timeout', detail: reason };
  if (res === 'stopped') {
    if (reason === 'stopped') return { result: 'stopped', cause: 'lead-stop', detail: reason };
    if (activity.startsWith('stopped (supervisor had died)')) return { result: 'stopped', cause: 'supervisor-died', detail: activity };
    if (activity.startsWith('repo deleted')) return { result: 'stopped', cause: 'repo-gone', detail: activity };
    return { result: 'stopped', cause: 'unknown', detail: reason || activity };
  }
  if (res === 'failed') {
    // 'auth' matches the reason exactly: a failure that merely mentions an author or a module
    // called authsignal is not a credentials problem.
    if (s.exitCode === 3 || reason === 'auth') return { result: 'failed', cause: 'auth', detail: reason };
    if (/^repo not writable/.test(reason)) return { result: 'failed', cause: 'not-writable', detail: reason };
    if (/^runner error/.test(reason)) return { result: 'failed', cause: 'runner-error', detail: reason };
    if (/gates still failing/i.test(reason)) {
      // A 'failed (gates still failing)' state was both a check that could not run and a check
      // that really failed: the last failed gate tells them apart, as the old status code did.
      const gates = Array.isArray(s.gates) ? s.gates : [];
      const isCheck = (g) => !!g && g.gate !== 'git clean';
      const isInfra = (g) => !!g && (g.code === 126 || g.code === 127 || g.kind === 'infra');
      const lastFail = [...gates].reverse().find((g) => isCheck(g) && g.ok === false);
      if (isInfra(lastFail)) return { result: 'unverified', cause: 'infra', detail: `checks couldn't run: ${lastFail.gate} (exit ${lastFail.code})` };
      return { result: 'checks failing', cause: 'checks', detail: lastFail ? `checks failing: ${lastFail.gate} (exit ${lastFail.code})` : `checks failing: ${reason}` };
    }
    return { result: 'failed', cause: 'unknown', detail: reason };
  }
  return { result: res, cause: 'unknown', detail: reason || activity };
}

// Close a live state in place: record the structured end, the reason (only when empty), the
// finished phase and the timestamps. A missing state, a finished state (a terminal state is
// written once) or an undeclared result changes nothing. Returns the state.
export function finishState(s, end = {}) {
  if (!s || s.result || !RESULTS.includes(end.result)) return s;
  s.result = end.result;
  s.end = { result: end.result, cause: CAUSES.includes(end.cause) ? end.cause : 'unknown', detail: String(end.detail || '') };
  if (!s.reason && end.detail) s.reason = String(end.detail);
  s.phase = 'finished';
  s.busy = false;
  s.updatedAt = Date.now();
  s.finishedAt = Date.now();
  if (end.activity) s.activity = end.activity;
  return s;
}

// The one atomic terminal writer: finish a live lane's state and persist it with one atomic
// write, so a reader never sees half a terminal state. A finished lane, a missing dir or an
// unusable end changes nothing on disk and returns false.
export function finishLaneFile(dir, s, end = {}) {
  if (!dir || !s || s.result || !RESULTS.includes(end.result)) return false;
  finishState(s, end);
  writeAtomic(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
  return true;
}
