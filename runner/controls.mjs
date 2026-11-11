// Lane controls for a human at the dashboard: what may be done with a lane right now, what
// the runner suggests first, which attention bucket the lane sits in, and the one status a
// person sees for it. Pure module: the caller supplies alive(pid), health(s) and canResume;
// it imports only the end reader of the state machine, and it has no side effects.
import { classify, GLYPHS, withStatusFields } from './lanestate.mjs';
export { GLYPHS, withStatusFields };

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
// The one status a person sees for a lane, shown the same way everywhere (CLI, MCP, Lanes, Office).
// The decision lives once in runner/lanestate.mjs classify: this is only its status projection, so
// the key, label, tone, reason, attention, steps and glyph can never disagree with the bucket.
export function laneOutcome({ s, health, handled, note, closed, progress }) {
  const c = classify({ s, health, handled, note, closed, progress });
  return { key: c.key, label: c.label, tone: c.tone, reason: c.reason, attention: c.attention, steps: c.steps, glyph: c.glyph };
}

// actions: what may be done now. suggest: one action worth trying first ('' when all is
// well). why: one human sentence explaining the suggestion or the refusal.
// actions: what may be done now. suggest: one action worth trying first ('' when all is
// well). why: one human sentence explaining the suggestion or the refusal. The decision lives once
// in runner/lanestate.mjs classify; this is only its actions projection.
export function laneActions({ s, alive, health, canResume, handled }) {
  const c = classify({ s, alive, health, canResume, handled });
  return { actions: c.actions, suggest: c.suggest, why: c.why };
}

// Attention buckets for the office view: attention (needs a human), running, done, ended.
// reason: short human text for the badge tooltip. The decision lives once in runner/lanestate.mjs
// classify (bucket/bucketReason); this is only its projection, without the handled/closed overlay.
export function laneBucket({ s, alive, health }) {
  const c = classify({ s, alive, health });
  return { bucket: c.bucket, reason: c.bucketReason };
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
