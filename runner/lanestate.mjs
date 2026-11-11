// The lane state machine: the declared phases, results and end causes of a lane, the one decision
// for its final result and exit code, the one reader that turns a persisted state into a
// structured end (the recorded { result, cause, detail } first, the legacy free-text rules after),
// and the one atomic terminal writer. Pure logic: it starts nothing, and it never throws; a
// corrupted or missing state fails closed (unknown cause, no rewrite, no crash of a live lane).
import path from 'node:path';
import { writeAtomic, alive as isAlive, dur } from './common.mjs';
import { progressAge } from './watchdog.mjs';

export const PHASES = ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart', 'finished'];
export const RESULTS = ['done', 'needs review', 'unverified', 'checks failing', 'paused', 'stopped', 'failed', 'killed'];
export const CAUSES = ['ok', 'review', 'checks', 'infra', 'timeout', 'lead-stop', 'supervisor-died', 'repo-gone', 'auth', 'not-writable', 'runner-error', 'unknown'];

// Every phase but 'finished' is live, and a working phase runs a model turn, so a kick is allowed
// there (build, fix, review, restart).
export const LIVE_PHASES = PHASES.filter((p) => p !== 'finished');
export const WORK_PHASES = ['build', 'fix', 'review', 'restart'];

// Every phase but 'finished' is live, and a live phase may move to any other live phase: the loop
// between build, gate, fix, review, backoff and restart is real (gates fail, reviews ask for
// fixes, waits expire). 'starting' hands over to one of those five, never to 'fix': a fix round
// follows a failed gate, it never opens a lane. Any live phase may finish. 'finished' is terminal,
// and a phase or target outside the declaration is illegal; the caller records the anomaly and
// carries on, it never throws.
const STARTING_TARGETS = ['build', 'gate', 'review', 'backoff', 'restart'];
export function canTransition(from, to) {
  if (!PHASES.includes(from) || !PHASES.includes(to)) return false;
  if (from === 'finished') return false;
  if (to === 'finished') return true;
  if (from === 'starting') return STARTING_TARGETS.includes(to);
  // A run begins at 'starting' exactly once (a resume starts a fresh run state): no live phase goes back.
  return to !== 'starting';
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
// The recorded structured end wins when its cause is a real classification; an 'unknown' cause
// means the decision could not classify (a gates failure say), so the legacy rules follow and
// every free-text regex lives here, in one place. Never throws, never mutates.
export function endOf(s) {
  if (!s || !s.result) return null;
  const reason = String(s.reason || '');
  const activity = String(s.activity || '');
  const res = s.result === 'failed' && reason === 'timeout' ? 'paused' : s.result; // legacy pause
  const e = s.end;
  if (e && typeof e === 'object' && CAUSES.includes(e.cause) && e.cause !== 'unknown') {
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
    // ca wait synthesizes reason 'supervisor gone' for a DEAD lane: it ended because the supervisor
    // died, not because the work failed, so every reader sees one cause instead of a reason regex.
    if (/supervisor (gone|died)/i.test(reason)) return { result: 'failed', cause: 'supervisor-died', detail: reason };
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

// ---------- stage 2: the one classifier ----------
// The result a state really ended with: a lane written before 'paused' existed recorded a timeout as
// failed (timeout). This is the only place the legacy pause rule lives.
export function resultOf(s) {
  if (!s || !s.result) return s && s.result;
  return s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s.result;
}

// The one health of a live lane as { kind, text }: kind is running, tool, quiet, thinking, stalled,
// dead or ended; text is exactly the string the dashboard and the CLI have always shown.
export function healthOf(s, { alive: live, now: t } = {}) {
  const st = s || {};
  if (st.result) return { kind: 'ended', text: resultOf(st) };
  const isLive = live === undefined ? isAlive(st.pid) : !!live;
  if (!isLive) return { kind: 'dead', text: 'DEAD (ca stop cleans up)' };
  const at = t === undefined ? Date.now() : t;
  const idle = at - (st.lastEventAt || st.startedAt);
  if (['gate', 'backoff', 'restart', 'starting'].includes(st.phase)) return { kind: 'running', text: 'running' };
  if (!st.busy) return { kind: 'running', text: 'running' };
  if (st.tools?.length) return { kind: 'tool', text: 'running tool' };
  if (idle > (st.config?.stall || 240) * 1000) return { kind: 'stalled', text: 'STALLED' };
  if (st.turnStartAt || st.lastToolAt || st.lastTextAt) {
    const thinkS = st.config?.think ?? 480;
    const age = progressAge({ turnStartAt: st.turnStartAt, lastToolAt: st.lastToolAt, lastTextAt: st.lastTextAt, now: at });
    if (thinkS > 0 && age > thinkS * 1000) return { kind: 'thinking', text: `thinking (${dur(age)}, no tool call)` };
  }
  if (idle > 60000) return { kind: 'quiet', text: 'quiet' };
  return { kind: 'running', text: 'running' };
}

// The one place that turns an old health string back into a kind, for callers that only pass text.
export function healthKind(text) {
  const h = String(text == null ? '' : text);
  if (RESULTS.includes(h)) return 'ended';
  if (/^dead/i.test(h)) return 'dead';
  if (/^stalled/i.test(h)) return 'stalled';
  if (/^thinking/i.test(h) || /no tool call/i.test(h)) return 'thinking';
  if (/^quiet/i.test(h)) return 'quiet';
  if (/tool/i.test(h)) return 'tool';
  return 'running';
}

// The glance glyphs (status contract part 1): the one marker a person reads at a glance.
export const GLYPHS = { working: '\u25CF', 'needs-you': '!', failed: '\u2715', done: '\u2713', idle: '\u2013' };

// The live labels that need the lead now, the same lanes the Needs you bucket holds.
const NEEDS_YOU = new Set(['Asked lead', 'No progress', 'Stalled', 'Not acting']);

// Add the three contract fields to a lane status: attention (the human must act), steps (live |
// complete | partial | hide) and glyph (one glance glyph). A lane the lead handled, and every ended
// lane of a closed plan, is never attention: nothing is left for the human.
export function withStatusFields(o, { res, handled, closed, progress } = {}) {
  const attention = !(handled || (closed && res)) && (o.key === 'failed' || o.key === 'checks failing'
    || o.key === 'unverified' || o.key === 'needs review' || o.key === 'paused' || (o.key === 'running' && NEEDS_YOU.has(o.label)));
  const merged = o.key === 'handled' && o.tone === 'done';
  const stoppedHandled = !!handled && res === 'stopped';
  // Truthful steps: driven by the actual step evidence, never by the result alone.
  const steps = o.key === 'running' || o.key === 'planned' ? 'live'
    : progress && progress.total ? (progress.done >= progress.total ? 'complete' : 'partial') : 'hide';
  let glyph;
  if (o.key === 'failed' || o.key === 'checks failing' || o.key === 'killed') glyph = GLYPHS.failed;
  else if (attention) glyph = GLYPHS['needs-you'];
  else if (o.key === 'running' || o.key === 'planned') glyph = GLYPHS.working;
  else if (o.key === 'done' || o.key === 'verified' || (o.key === 'handled' && (!stoppedHandled || o.label === 'Merged'))) glyph = GLYPHS.done;
  else glyph = GLYPHS.idle;
  return { ...o, attention, steps, glyph };
}

// The status half of classify: the old laneOutcome, reading the health kind, never a regex on text.
function statusOf({ s, res, cause, end, hk, ht, handled, note, closed, progress }) {
  let o;
  if (handled && res) {
    const merged = /merg/i.test(note || '');
    o = { key: 'handled', label: merged ? 'Merged' : 'Handled by lead', tone: merged ? 'done' : 'idle', reason: note || 'handled by the lead' };
  } else if (!res) {
    if (hk === 'dead') o = { key: 'failed', label: 'Supervisor died', tone: 'bad', reason: 'the supervisor died; resume restarts the lane in place' };
    else if (s.blocker && s.blocker.text) o = { key: 'running', label: s.blocker.kind === 'question' ? 'Asked lead' : 'No progress', tone: 'warn', reason: s.blocker.text };
    else if (hk === 'stalled') o = { key: 'running', label: 'Stalled', tone: 'bad', reason: 'stalled: no model activity for a while' };
    else if (hk === 'thinking') o = { key: 'running', label: 'Not acting', tone: 'warn', reason: ht };
    else if (hk === 'quiet') o = { key: 'running', label: 'Quiet', tone: 'warn', reason: ht };
    else o = { key: 'running', label: 'Running', tone: 'run', reason: String(s.activity || ht || 'running') };
  } else {
    const gates = Array.isArray(s.gates) ? s.gates : [];
    if (res === 'done') {
      const i = gates.map((g) => g && g.gate).lastIndexOf('git clean');
      const round = (i >= 0 ? gates.slice(i + 1) : gates).filter((g) => !!g && g.gate !== 'git clean');
      o = round.length && round.every((g) => g.ok)
        ? { key: 'verified', label: 'Verified', tone: 'done', reason: 'every check ran and passed' }
        : { key: 'done', label: 'Done', tone: 'done', reason: 'finished' };
    } else if (res === 'unverified') o = { key: 'unverified', label: 'Unverified', tone: 'warn', reason: (end && end.detail) || s.reason || 'checks could not run' };
    else if (res === 'checks failing') o = { key: 'checks failing', label: 'Checks failing', tone: 'bad', reason: (end && end.detail) || s.reason || 'a check still fails after the fix rounds' };
    else if (res === 'needs review') o = { key: 'needs review', label: 'Needs review', tone: 'warn', reason: s.reason || 'the reviewer asked for fixes' };
    else if (res === 'paused') o = { key: 'paused', label: 'Paused', tone: 'warn', reason: 'paused at the time limit; resume continues it in place' };
    else if (res === 'stopped') {
      o = cause === 'lead-stop' ? { key: 'stopped', label: 'Stopped by lead', tone: 'idle', reason: 'stopped by the lead' }
        : cause === 'supervisor-died' ? { key: 'stopped', label: 'Stopped (supervisor died)', tone: 'idle', reason: 'the supervisor had died; the lane was marked stopped' }
        : { key: 'stopped', label: 'Stopped', tone: 'idle', reason: 'Stopped' };
    } else if (res === 'killed') o = { key: 'killed', label: 'Killed', tone: 'idle', reason: 'killed' };
    else if (res === 'continued') o = { key: 'continued', label: 'Continued', tone: 'idle', reason: s.reason || 'continued in another lane' };
    else if (res === 'dropped') o = { key: 'dropped', label: 'Dropped', tone: 'idle', reason: s.reason || 'dropped by the lead, never started' };
    else if (res === 'failed') {
      o = cause === 'auth'
        ? { key: 'failed', label: 'Failed', tone: 'bad', reason: 'missing credentials: run ca auth' }
        : { key: 'failed', label: 'Failed', tone: 'bad', reason: `failed: ${s.reason || 'see the summary'}` };
    } else o = { key: res, label: res.charAt(0).toUpperCase() + res.slice(1), tone: 'idle', reason: s.reason || res };
  }
  return withStatusFields(o, { res, handled, closed, progress });
}

// The bucket half of classify: the old laneBucket, reading the health kind and the computed status.
function bucketOf({ s, live, hk, ht, res, cause, status, NOW }) {
  const idleMin = () => Math.max(1, Math.round((NOW - (s.lastEventAt || s.startedAt || NOW)) / 60000));
  if (res === 'done') return { bucket: 'done', reason: 'done' };
  if (res === 'continued') return { bucket: 'ended', reason: 'continued in another lane' };
  if (res === 'dropped') return { bucket: 'ended', reason: 'dropped by the lead, never started' };
  if (res === 'stopped') return { bucket: 'ended', reason: 'stopped by the lead' };
  if (res === 'killed') return { bucket: 'ended', reason: 'killed' };
  if (res === 'paused') return { bucket: 'attention', reason: 'paused at time limit' };
  if (res === 'needs review') return { bucket: 'attention', reason: 'review says needs fixes' };
  if (res === 'failed' || res === 'unverified' || res === 'checks failing') {
    if (status.key === 'unverified' || status.key === 'checks failing') return { bucket: 'attention', reason: status.reason };
    if (cause === 'auth') return { bucket: 'attention', reason: 'missing credentials: run ca auth' };
    return { bucket: 'attention', reason: `failed: ${s.reason || 'see the summary'}` };
  }
  if (!live) return { bucket: 'attention', reason: 'supervisor died' };
  // A worker that raised a question or went silent without a commit needs the lead now, not when it ends.
  if (s.blocker && s.blocker.text) return { bucket: 'attention', reason: s.blocker.kind === 'question' ? `asked the lead: ${s.blocker.text}` : String(s.blocker.text) };
  if (hk === 'stalled') return { bucket: 'attention', reason: `stalled: no model activity ${idleMin()}m` };
  if (hk === 'thinking') return { bucket: 'attention', reason: ht };
  if (hk === 'quiet') return { bucket: 'running', reason: `quiet ${idleMin()}m` };
  return { bucket: 'running', reason: String(s.activity || ht || 'running') };
}

// The actions half of classify: the old laneActions, reading the health kind and the end cause.
function actionsOf({ s, live, hk, res, cause, status, canResume, handled }) {
  const acts = []; let suggest = ''; let why = '';
  if (!s.result && live) {
    acts.push('steer', 'stop', 'attach');
    if (WORK_PHASES.includes(s.phase)) {
      acts.push('kick', 'fresh', 'restart-server');
      if (hk === 'stalled') { suggest = 'kick'; why = 'stalled: no model activity for a while; kick aborts the turn and resumes it'; }
      else if (hk === 'thinking') { suggest = 'kick'; why = 'the model keeps thinking without acting; kick nudges it'; }
      else if (hk === 'quiet') { suggest = 'kick'; why = 'no activity for a while; kick retries the turn'; }
    } else if (s.phase === 'backoff') {
      acts.push('skip-wait', 'restart-server');
      suggest = 'skip-wait';
      why = 'the lane waits out a backoff after an interruption; skip it and resume now';
    }
    // A blocked lane is waiting on the lead: a steer answers the question or unsticks the silent run.
    if (s.blocker && s.blocker.text) {
      suggest = 'steer';
      why = s.blocker.kind === 'question' ? `the worker asked the lead a question: ${s.blocker.text}; answer it with a steer` : `${s.blocker.text}; the lead has not seen this yet: steer the lane or ack the blocker`;
    }
  } else if (!s.result && !live) {
    acts.push('stop');
    if (canResume) { acts.push('resume'); suggest = 'resume'; why = 'the supervisor died; resume restarts the lane in place'; }
  } else if (res && canResume && ['paused', 'stopped', 'failed', 'killed', 'needs review', 'unverified', 'checks failing'].includes(res)) {
    acts.push('resume');
    if (status.key === 'paused') { suggest = 'resume'; why = 'paused at the time limit; resume continues it in place'; }
    else if (status.key === 'checks failing') { suggest = 'resume'; why = 'resume gives the worker another fix round'; }
    else if (status.key === 'unverified') { why = "checks couldn't run: fix the environment, then resume to rerun them"; }
    else if (status.key === 'failed' && cause === 'supervisor-died') { suggest = 'resume'; why = 'the supervisor died; resume restarts the lane in place'; }
    else if (status.key === 'failed' && cause === 'auth') { why = 'missing credentials: run ca auth'; }
    if (handled) { suggest = ''; why = ''; }
  }
  return { actions: acts, suggest, why };
}

// The one classifier for a lane: health kind, status, bucket and actions in one pass, the single
// source every older helper projects from. Pure: no file reads, no git, no clock past the caller's
// `now`. `alive` is the caller's liveness (derived from s.pid when omitted); `health` is an old
// health string (turned back into a kind); `handled` and `closed` carry the ack and closed-plan
// overlays of the old bucketFor. The end comes from endOf, never a regex on the health text.
export function classify({ s, alive, health, handled, note, closed, progress, canResume, now } = {}) {
  const st = s || {};
  const live = alive === undefined ? isAlive(st.pid) : !!alive;
  const NOW = now === undefined ? Date.now() : now;
  const h = health === undefined
    ? healthOf(st, { alive: live, now: NOW })
    : { kind: healthKind(health), text: String(health) };
  const end = endOf(st);
  const res = end ? end.result : null;
  const cause = end ? end.cause : null;
  const status = statusOf({ s: st, res, cause, end, hk: h.kind, ht: h.text, handled: !!handled, note: note || '', closed: !!closed, progress });
  const b = bucketOf({ s: st, live, hk: h.kind, ht: h.text, res, cause, status, NOW });
  let bucket = b.bucket; let bucketReason = b.reason;
  if (handled && st.result) {
    if (bucket === 'attention') bucket = 'ended';
    bucketReason = `handled${note ? ': ' + note : ''} (was ${bucketReason})`;
  } else if (closed && st.result && bucket === 'attention') {
    bucket = 'ended';
  }
  const a = actionsOf({ s: st, live, hk: h.kind, res, cause, status, canResume: !!canResume, handled: !!handled });
  return { key: status.key, label: status.label, tone: status.tone, reason: status.reason, attention: status.attention,
    steps: status.steps, glyph: status.glyph, bucket, bucketReason, actions: a.actions, suggest: a.suggest, why: a.why,
    health: { kind: h.kind, text: h.text }, end: end || null };
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
