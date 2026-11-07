// Lane controls for a human at the dashboard: what may be done with a lane right now, what
// the runner suggests first, and which attention bucket the lane sits in. Pure module:
// the caller supplies alive(pid), health(s) and canResume; no imports, no side effects.

// actions: what may be done now. suggest: one action worth trying first ('' when all is
// well). why: one human sentence explaining the suggestion or the refusal.
export function laneActions({ s, alive, health, canResume }) {
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
  } else if (res && canResume && ['paused', 'stopped', 'failed', 'killed', 'needs review'].includes(res)) {
    acts.push('resume');
    if (res === 'paused' || res === 'failed') {
      if (s.exitCode === 3 || /auth/i.test(s.reason || '')) why = 'missing credentials: run ca auth';
      else { suggest = 'resume'; why = res === 'paused' ? 'paused at the time limit; resume continues it in place' : 'it failed; resume continues where it stopped'; }
    }
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
  if (res === 'failed') {
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
