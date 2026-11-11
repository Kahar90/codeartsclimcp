// Lane controls for a human at the dashboard: what may be done with a lane right now, what
// the runner suggests first, which attention bucket the lane sits in, and the one status a
// person sees for it. Pure module: the caller supplies alive(pid), health(s) and canResume;
// it imports only the end reader of the state machine, and it has no side effects.
import { endOf } from './lanestate.mjs';

// Classify a finished CHECK run: 'pass' the work is good, 'fail' the work is wrong, 'infra' the
// check itself could not run (missing tool, sandbox, timeout): not the worker's fault.
export function classifyCheck({ code, out }) {
  if (!code) return 'pass';
  const o = String(out || '');
  // A missing command or file: the check could not run, whoever is at fault (not the worker's).
  const missing = /command not found|is not recognized as an internal or external command|ENOENT|cannot find module|No such file or directory/i.test(o);
  // 126/127 only means "infra" when the check never ran: the shell could not find the command or file, or
  // it said nothing at all. A worker's check that got to run and crashed after printing PASS lines (a Node
  // Assertion failed abort) still exits non-zero: that is a real "fail", not a check that could not run.
  if (code === 126 || code === 127) return (missing || !o.trim()) ? 'infra' : 'fail';
  if (/command not found|is not recognized as an internal or external command|ENOENT|EACCES|Sandbox Network Error|cannot find module 'node'|\[runner: timed out/i.test(o)) return 'infra';
  return 'fail';
}

// Is the git dir inside the folder of repoDir? A clone keeps .git in the lane folder (inside); a
// git worktree keeps its git dir in the MAIN repo's .git/worktrees/<name> (outside), which the
// CodeArts sandbox refuses to write, so every sandboxed commit fails. String logic only (no path
// import): separators normalize to '/', case folds so Windows drive letters compare equal.
export function gitDirInsideRepo(repoDir, gitDir) {
  const norm = (p) => String(p == null ? '' : p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(repoDir); const b = norm(gitDir);
  if (!a || !b) return true;
  return b === a || b.startsWith(a + '/');
}

// Did the worker's own commit get refused? Read its last reply and tool output for the git errors a
// sandboxed commit prints. Returns the first offending line (the reason) or '' when none matched.
export function commitRefused(text) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  const line = s.split(/\r?\n/).find((l) => /Unable to create|index\.lock|Permission denied|\bfatal:/i.test(l));
  return line ? line.trim() : '';
}

// The runner's decision when the tree is dirty at the gate: if the worker's commit was refused and
// the runner itself can write, the runner commits the work (action 'commit'); if the runner cannot
// write either, the lane fails with reason "commit failed: <first error line>" (action 'fail'). No
// refusal means the ordinary uncommitted-changes handling (action 'none').
export function commitFallbackDecision({ dirty, refused, writable } = {}) {
  if (!dirty) return { action: 'skip' };
  if (!refused) return { action: 'none' };
  if (!writable) return { action: 'fail', reason: `commit failed: ${refused}` };
  return { action: 'commit' };
}

// A worker bash call that waits with `sleep N` (N >= 20 s) wastes tokens: the model replays the whole
// context on every idle turn. Returns N (a number >= 20) when a long sleep is present, else 0.
// `sleep 5` is fine; `sleep 200; cat x` and `sleep 30 && tail` both count.
export function sleepPoll(text) {
  const s = String(text == null ? '' : text);
  const re = /\bsleep\s+(\d+(?:\.\d+)?)\b/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 20) return n;
  }
  return 0;
}

// The one status a person sees for a lane, shown the same way everywhere (CLI, MCP, Lanes, Office).
// key: the status name; label: the badge text; tone: run | done | warn | bad | idle (the badge
// colour); reason: one human line for tooltips and the "Now:" line. Live lanes keep their health
// states, and a lane waiting on the lead (a question asked, no progress, thinking without acting)
// is attention like the Needs you bucket. Ended lanes read their cause from the structured end
// (endOf in runner/lanestate.mjs), never from a regex on free text; legacy states without one are
// classified there too, in one place.
// Besides { key, label, tone, reason } it carries { attention, steps, glyph } (status contract part 1).
export function laneOutcome({ s, health, handled, note, closed, progress }) {
  const end = endOf(s) || {};
  const res = end.result || null;
  const cause = end.cause || null;
  let o;
  if (handled && res) {
    const merged = /merg/i.test(note || '');
    o = { key: 'handled', label: merged ? 'Merged' : 'Handled by lead', tone: merged ? 'done' : 'idle', reason: note || 'handled by the lead' };
  } else if (!res) {
    const h = String(health || '');
    if (/^dead/i.test(h)) o = { key: 'failed', label: 'Supervisor died', tone: 'bad', reason: 'the supervisor died; resume restarts the lane in place' };
    else if (s.blocker && s.blocker.text) o = { key: 'running', label: s.blocker.kind === 'question' ? 'Asked lead' : 'No progress', tone: 'warn', reason: s.blocker.text };
    else if (/^stalled/i.test(h)) o = { key: 'running', label: 'Stalled', tone: 'bad', reason: 'stalled: no model activity for a while' };
    else if (/no tool call/i.test(h)) o = { key: 'running', label: 'Not acting', tone: 'warn', reason: h };
    else if (/^thinking/i.test(h)) o = { key: 'running', label: 'Thinking', tone: 'warn', reason: h };
    else if (/^quiet/i.test(h)) o = { key: 'running', label: 'Quiet', tone: 'warn', reason: h };
    else o = { key: 'running', label: 'Running', tone: 'run', reason: String(s.activity || h || 'running') };
  } else {
    const gates = Array.isArray(s.gates) ? s.gates : [];
    if (res === 'done') {
      // Verified only when the last gate round really ran the checks and they all passed; a brief
      // without CHECK lines (or a lane rebuilt from its log, which keeps no gates) stays plain Done.
      const i = gates.map((g) => g && g.gate).lastIndexOf('git clean');
      const round = (i >= 0 ? gates.slice(i + 1) : gates).filter((g) => !!g && g.gate !== 'git clean');
      o = round.length && round.every((g) => g.ok)
        ? { key: 'verified', label: 'Verified', tone: 'done', reason: 'every check ran and passed' }
        : { key: 'done', label: 'Done', tone: 'done', reason: 'finished' };
    } else if (res === 'unverified') o = { key: 'unverified', label: 'Unverified', tone: 'warn', reason: end.detail || s.reason || 'checks could not run' };
    else if (res === 'checks failing') o = { key: 'checks failing', label: 'Checks failing', tone: 'bad', reason: end.detail || s.reason || 'a check still fails after the fix rounds' };
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

// The glance glyphs (status contract part 1): the one marker a person reads at a glance.
export const GLYPHS = { working: '\u25CF', 'needs-you': '!', failed: '\u2715', done: '\u2713', idle: '\u2013' };

// The live labels that need the lead now, the same lanes the Needs you bucket holds: a question
// asked, no progress, stalled, or a worker that keeps thinking without acting.
const NEEDS_YOU = new Set(['Asked lead', 'No progress', 'Stalled', 'Not acting']);

// Add the three contract fields to a lane status: attention (the human must act), steps (live |
// complete | hide) and glyph (one glance glyph). A lane the lead handled, and every ended lane of a
// closed plan, is never attention: nothing is left for the human.
export function withStatusFields(o, { res, handled, closed, progress } = {}) {
  const attention = !(handled || (closed && res)) && (o.key === 'failed' || o.key === 'checks failing'
    || o.key === 'unverified' || o.key === 'needs review' || o.key === 'paused' || (o.key === 'running' && NEEDS_YOU.has(o.label)));
  const merged = o.key === 'handled' && o.tone === 'done';
  const stoppedHandled = !!handled && res === 'stopped';
  // Truthful steps: driven by the actual step evidence, never by the result alone. A lane with a real
  // fraction is complete only when every step is done, partial while steps are open (even done/merged),
  // and hidden when no step list is known (a legacy lane whose progress cannot be trusted).
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

// actions: what may be done now. suggest: one action worth trying first ('' when all is
// well). why: one human sentence explaining the suggestion or the refusal.
export function laneActions({ s, alive, health, canResume, handled }) {
  const end = endOf(s) || {};
  const res = end.result || null;
  const cause = end.cause || null;
  const acts = [];
  let suggest = '';
  let why = '';
  if (!s.result && alive) {
    acts.push('steer', 'stop', 'attach');
    if (['build', 'fix', 'review', 'restart'].includes(s.phase)) {
      acts.push('kick', 'fresh', 'restart-server');
      if (/stalled/i.test(health)) { suggest = 'kick'; why = 'stalled: no model activity for a while; kick aborts the turn and resumes it'; }
      else if (/no tool call/i.test(health)) { suggest = 'kick'; why = 'the model keeps thinking without acting; kick nudges it'; }
      else if (/^quiet/i.test(health)) { suggest = 'kick'; why = 'no activity for a while; kick retries the turn'; }
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
  } else if (!s.result && !alive) {
    acts.push('stop');
    if (canResume) { acts.push('resume'); suggest = 'resume'; why = 'the supervisor died; resume restarts the lane in place'; }
  } else if (res && canResume && ['paused', 'stopped', 'failed', 'killed', 'needs review', 'unverified', 'checks failing'].includes(res)) {
    acts.push('resume');
    const o = laneOutcome({ s, health });
    if (o.key === 'paused') { suggest = 'resume'; why = 'paused at the time limit; resume continues it in place'; }
    else if (o.key === 'checks failing') { suggest = 'resume'; why = 'resume gives the worker another fix round'; }
    else if (o.key === 'unverified') { why = "checks couldn't run: fix the environment, then resume to rerun them"; }
    else if (o.key === 'failed' && /supervisor (gone|died)/i.test(s.reason || '')) { suggest = 'resume'; why = 'the supervisor died; resume restarts the lane in place'; }
    else if (o.key === 'failed' && cause === 'auth') { why = 'missing credentials: run ca auth'; }
    if (handled) { suggest = ''; why = ''; }
  }
  return { actions: acts, suggest, why };
}

// Attention buckets for the office view: attention (needs a human), running, done, ended.
// reason: short human text for the badge tooltip.
export function laneBucket({ s, alive, health }) {
  const end = endOf(s) || {};
  const res = end.result || null;
  const cause = end.cause || null;
  const idleMin = () => Math.max(1, Math.round((Date.now() - (s.lastEventAt || s.startedAt || Date.now())) / 60000));
  if (res === 'done') return { bucket: 'done', reason: 'done' };
  if (res === 'continued') return { bucket: 'ended', reason: 'continued in another lane' };
  if (res === 'dropped') return { bucket: 'ended', reason: 'dropped by the lead, never started' };
  if (res === 'stopped') return { bucket: 'ended', reason: 'stopped by the lead' };
  if (res === 'killed') return { bucket: 'ended', reason: 'killed' };
  if (res === 'paused') return { bucket: 'attention', reason: 'paused at time limit' };
  if (res === 'needs review') return { bucket: 'attention', reason: 'review says needs fixes' };
  if (res === 'failed' || res === 'unverified' || res === 'checks failing') {
    const o = laneOutcome({ s, health });
    if (o.key === 'unverified' || o.key === 'checks failing') return { bucket: 'attention', reason: o.reason };
    if (cause === 'auth') return { bucket: 'attention', reason: 'missing credentials: run ca auth' };
    return { bucket: 'attention', reason: `failed: ${s.reason || 'see the summary'}` };
  }
  if (!alive) return { bucket: 'attention', reason: 'supervisor died' };
  // A worker that raised a question or went silent without a commit needs the lead now, not when it ends.
  if (s.blocker && s.blocker.text) return { bucket: 'attention', reason: s.blocker.kind === 'question' ? `asked the lead: ${s.blocker.text}` : String(s.blocker.text) };
  if (/stalled/i.test(health)) return { bucket: 'attention', reason: `stalled: no model activity ${idleMin()}m` };
  if (/no tool call/i.test(health)) return { bucket: 'attention', reason: String(health) };
  if (/^quiet/i.test(health)) return { bucket: 'running', reason: `quiet ${idleMin()}m` };
  return { bucket: 'running', reason: String(s.activity || health || 'running') };
}

// What kind of work a lane does, for the Office characters (code: robot, art: painter, review: inspector, docs: writer).
// An explicit `KIND: <kind>` brief line or a plan lane "kind" wins; otherwise keywords score the task name (x3),
// the files the lane touched and the first part of the brief. Unclear lanes are code.
export const LANE_KINDS = ['code', 'art', 'review', 'docs'];
const KIND_RX = {
  code: /\b(api|server|cli|runner|backend|supervisor|refactor|parser|database|db|endpoint|worker|engine)\b|\.(m?js|cjs|ts|tsx|jsx|py|rs|go|java|kt|cs|cpp|c|h|rb|php|swift|sh|sql)\b/gi,
  art: /\b(ui|ux|css|scss|style[sd]?|theme|design|layout|visual|sprites?|art|icons?|svg|png|pixel|office|page|dashboard|frontend|front-end|animation|motion|colou?rs?|html)\b|\.(css|scss|html|svg|png)\b/gi,
  review: /\b(review|audit|tests?|testing|checks?|qa|verify|verification|lint|bench(mark)?|regression|e2e|smoke|probe)\b|\.(test|spec)\.|checks\//gi,
  docs: /\b(docs?|readme|guide|documentation|changelog|manual|tutorial|handbook|notes?|write-?up|copy)\b|\.md\b|docs\//gi,
};
export function laneKind({ task = '', brief = '', files = [], override = '' } = {}) {
  const o = String(override || (String(brief).match(/^\s*KIND:\s*(\w+)/m) || [])[1] || '').toLowerCase();
  if (LANE_KINDS.includes(o)) return o;
  const name = String(task).replace(/[-_]+/g, ' ');
  // Every brief has CHECK lines, "run its checks" and a self-check step: that boilerplate says nothing about the work.
  const body = String(brief).split(/\r?\n/)
    .filter((l) => !/^\s*(MODEL|REVIEW_MODEL|FALLBACK_MODEL|KIND|CHECK)\s*:|\bchecks?\b.*\b(before each commit|runner also runs|run these)\b|self[- ]check|safety rules|never kill|git commit/i.test(l))
    .join('\n').replace(/\b(run (its|the|every) checks?|test hook|checks\/[\w.-]+)/gi, '').slice(0, 800);
  // Lanes add their own check files: count test paths only when the lane touches nothing else.
  const all = [].concat(files || []); const isTest = (f) => /(^|\/)(checks?|tests?|__tests__)\/|\.(test|spec)\./.test(f);
  const fileText = (all.every(isTest) ? all : all.filter((f) => !isTest(f))).join(' ');
  let best = 'code', bestScore = 1; // a kind needs at least 2 points, and more than code itself, to win
  for (const [k, rx] of Object.entries(KIND_RX)) {
    const hits = (t) => (String(t).match(rx) || []).length;
    const n = hits(name), fh = Math.min(hits(fileText), 4), bh = Math.min(hits(body), 4);
    // the brief text alone only decides when it is strongly one-sided; otherwise the name or the files must agree
    const score = n || fh ? n * 3 + fh + Math.min(bh, 2) : bh >= 4 ? bh - 1 : 0;
    if (score > bestScore) { best = k; bestScore = score; }
  }
  return best;
}
