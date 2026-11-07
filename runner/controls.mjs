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
