// Lane controls for a human at the dashboard: what may be done with a lane right now, what
// the runner suggests first, which attention bucket the lane sits in, and the one status a
// person sees for it. Pure module: the caller supplies alive(pid), health(s) and canResume;
// no imports, no side effects.

// Classify a finished CHECK run: 'pass' the work is good, 'fail' the work is wrong, 'infra' the
// check itself could not run (missing tool, sandbox, timeout): not the worker's fault.
export function classifyCheck({ code, out }) {
  if (!code) return 'pass';
  if (code === 126 || code === 127
    || /command not found|is not recognized as an internal or external command|ENOENT|EACCES|Sandbox Network Error|cannot find module 'node'|\[runner: timed out/i.test(String(out || ''))) return 'infra';
  return 'fail';
}

// The one status a person sees for a lane, shown the same way everywhere (CLI, MCP, Lanes, Office).
// key: the status name; label: the badge text; tone: run | done | warn | bad | idle (the badge
// colour); reason: one human line for tooltips and the "Now:" line. Live lanes keep their health
// states. It reads legacy states too: "failed (gates still failing)" was both a check that could
// not run and a check that really failed; the last failed gate tells them apart.
export function laneOutcome({ s, health, handled, note }) {
  const res = s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s.result; // legacy pause
  if (handled && res) {
    const merged = /merg/i.test(note || '');
    return { key: 'handled', label: merged ? 'Merged' : 'Handled', tone: merged ? 'done' : 'idle', reason: note || 'handled by the lead' };
  }
  if (!res) {
    const h = String(health || '');
    if (/^dead/i.test(h)) return { key: 'failed', label: 'Supervisor died', tone: 'bad', reason: 'the supervisor died; resume restarts the lane in place' };
    if (/^stalled/i.test(h)) return { key: 'running', label: 'Stalled', tone: 'bad', reason: 'stalled: no model activity for a while' };
    if (/^thinking/i.test(h)) return { key: 'running', label: 'Thinking', tone: 'warn', reason: h };
    if (/^quiet/i.test(h)) return { key: 'running', label: 'Quiet', tone: 'warn', reason: h };
    return { key: 'running', label: 'Running', tone: 'run', reason: String(s.activity || h || 'running') };
  }
  const gates = Array.isArray(s.gates) ? s.gates : [];
  const isCheck = (g) => !!g && g.gate !== 'git clean';
  const lastFail = [...gates].reverse().find((g) => isCheck(g) && g.ok === false);
  const infra = (g) => !!g && (g.code === 126 || g.code === 127 || g.kind === 'infra');
  if (res === 'done') {
    // Verified only when the last gate round really ran the checks and they all passed; a brief
    // without CHECK lines (or a lane rebuilt from its log, which keeps no gates) stays plain Done.
    const i = gates.map((g) => g && g.gate).lastIndexOf('git clean');
    const round = (i >= 0 ? gates.slice(i + 1) : gates).filter(isCheck);
    return round.length && round.every((g) => g.ok)
      ? { key: 'verified', label: 'Verified', tone: 'done', reason: 'every check ran and passed' }
      : { key: 'done', label: 'Done', tone: 'done', reason: 'finished' };
  }
  if (res === 'unverified') return { key: 'unverified', label: 'Unverified', tone: 'warn', reason: s.reason || 'checks could not run' };
  if (res === 'checks failing') return { key: 'checks failing', label: 'Checks failing', tone: 'bad', reason: s.reason || 'a check still fails after the fix rounds' };
  if (res === 'failed' && /gates still failing/i.test(s.reason || '')) {
    if (infra(lastFail)) return { key: 'unverified', label: 'Unverified', tone: 'warn', reason: `checks couldn't run: ${lastFail.gate} (exit ${lastFail.code})` };
    return { key: 'checks failing', label: 'Checks failing', tone: 'bad', reason: lastFail ? `checks failing: ${lastFail.gate} (exit ${lastFail.code})` : `checks failing: ${s.reason}` };
  }
  if (res === 'needs review') return { key: 'needs review', label: 'Needs review', tone: 'warn', reason: 'the reviewer asked for fixes' };
  if (res === 'paused') return { key: 'paused', label: 'Paused', tone: 'warn', reason: 'paused at the time limit; resume continues it in place' };
  if (res === 'stopped') return { key: 'stopped', label: 'Stopped', tone: 'idle', reason: /stopped/i.test(`${s.reason || ''} ${s.activity || ''}`) ? 'stopped by the lead' : 'Stopped' };
  if (res === 'killed') return { key: 'killed', label: 'Killed', tone: 'idle', reason: 'killed' };
  if (res === 'continued') return { key: 'continued', label: 'Continued', tone: 'idle', reason: s.reason || 'continued in another lane' };
  if (res === 'dropped') return { key: 'dropped', label: 'Dropped', tone: 'idle', reason: s.reason || 'dropped by the lead, never started' };
  if (res === 'failed') {
    if (s.exitCode === 3 || /auth/i.test(s.reason || '')) return { key: 'failed', label: 'Failed', tone: 'bad', reason: 'missing credentials: run ca auth' };
    return { key: 'failed', label: 'Failed', tone: 'bad', reason: `failed: ${s.reason || 'see the summary'}` };
  }
  return { key: res, label: res.charAt(0).toUpperCase() + res.slice(1), tone: 'idle', reason: s.reason || res };
}

// actions: what may be done now. suggest: one action worth trying first ('' when all is
// well). why: one human sentence explaining the suggestion or the refusal.
export function laneActions({ s, alive, health, canResume, handled }) {
  const res = s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s.result; // legacy pause
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
    else if (o.key === 'failed' && (s.exitCode === 3 || /auth/i.test(s.reason || ''))) { why = 'missing credentials: run ca auth'; }
    if (handled) { suggest = ''; why = ''; }
  }
  return { actions: acts, suggest, why };
}

// Attention buckets for the office view: attention (needs a human), running, done, ended.
// reason: short human text for the badge tooltip.
export function laneBucket({ s, alive, health }) {
  const res = s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s.result; // legacy pause
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
    if (s.exitCode === 3 || /auth/i.test(s.reason || '')) return { bucket: 'attention', reason: 'missing credentials: run ca auth' };
    return { bucket: 'attention', reason: `failed: ${s.reason || 'see the summary'}` };
  }
  if (!alive) return { bucket: 'attention', reason: 'supervisor died' };
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
