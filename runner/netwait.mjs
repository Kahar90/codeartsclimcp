// Network resilience helpers for the lane supervisor: classify a network error, wait for the
// network to come back, detect a laptop sleep between watchdog ticks and cap lanes per model.
// Pure functions plus a small default probe; no dependencies (Node 22 ESM).
import dns from 'node:dns';

// A network error means the transport itself is down: DNS, connect, reset, unreachable or a
// fetch/socket failure. It is NOT an auth problem, a rate limit, an infer timeout, an HTTP 5xx
// or an abort: those are the model service answering and keep the existing behaviour.
const NET_ERROR_PATTERNS = [
  /\bENOTFOUND\b/i, /\bEAI_AGAIN\b/i, /\bECONNRESET\b/i, /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i, /\bENETUNREACH\b/i, /\bEHOSTUNREACH\b/i,
  /fetch failed/i, /socket hang up/i, /network socket disconnected/i,
  /Cannot connect to the model service/i,
];

export function isNetworkError(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  return NET_ERROR_PATTERNS.some((re) => re.test(s));
}

// The MaaS host a lane talks to; MAAS_BASE_URL can point at a proxy or a test double.
export function modelHost(base = process.env.MAAS_BASE_URL || 'https://api-ap-southeast-1.modelarts-maas.com/openai/v1') {
  try { return new URL(base).hostname || 'api-ap-southeast-1.modelarts-maas.com'; }
  catch { return 'api-ap-southeast-1.modelarts-maas.com'; }
}

// Default liveness probe: resolve the model host, then a HEAD request with a 5 s timeout. A DNS
// failure or a thrown fetch means offline; any HTTP answer (even 404/503) means the network is up.
export async function defaultProbe() {
  const host = modelHost();
  try { await dns.promises.lookup(host); } catch { return false; }
  try { const r = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(5000) }); return !!r; }
  catch { return false; }
}

// Poll probe() until it answers true. A throw counts as offline. onWait runs after every failed
// try (for live.log and the lane activity). Resolves { online, tries, waitedMs }; never rejects.
// shouldStop(): checked every second while waiting; true ends the wait with { online: false, stopped: true }.
export async function waitOnline({ probe, intervalMs = 15000, timeoutMs, onWait, shouldStop } = {}) {
  const p = probe || defaultProbe;
  const t0 = Date.now();
  const deadline = Number.isFinite(timeoutMs) ? t0 + timeoutMs : Infinity;
  let tries = 0;
  for (;;) {
    let online = false;
    try { online = (await p()) === true; } catch { online = false; }
    tries++;
    if (online) return { online: true, tries, waitedMs: Date.now() - t0 };
    const waitedMs = Date.now() - t0;
    if (onWait) { try { onWait({ tries, waitedMs }); } catch { /* status only, never fatal */ } }
    if (Date.now() >= deadline) return { online: false, tries, waitedMs: Date.now() - t0 };
    const nap = Math.max(0, Math.min(intervalMs, deadline - Date.now()));
    if (nap <= 0) return { online: false, tries, waitedMs: Date.now() - t0 };
    for (let left = nap; left > 0; left -= 1000) {
      if (shouldStop && shouldStop()) return { online: false, stopped: true, tries, waitedMs: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, Math.min(1000, left)));
    }
  }
}

// A watchdog tick far later than its interval means the machine slept (or was suspended), not that
// the model stalled: treat any gap over max(2 min, 4 x interval) as a sleep.
export function detectSleep(prevTickMs, nowTickMs, intervalMs) {
  const gap = (nowTickMs || 0) - (prevTickMs || 0);
  return gap > Math.max(120000, 4 * (intervalMs || 0));
}

// One limit value: 0 or "off" means no cap (Infinity); a positive number is the cap. Anything else
// (empty, garbage) is null and leaves the default in place.
function limitValue(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (s === 'off') return Infinity;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n <= 0 ? Infinity : n;
}

// parseLimits("maas/glm-5.3=2,default=4") -> { limitFor(model) }. Default: 3 for any model whose id
// contains glm (case-insensitive), 4 for others. "default=N" overrides the non-matching default.
// "0" or "off" disables the cap (Infinity); a bare "off" disables every cap.
export function parseLimits(spec) {
  const perModel = new Map();
  let def = null;
  let allOff = false;
  for (const raw of String(spec == null ? '' : spec).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.toLowerCase() === 'off') { allOff = true; continue; }
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (!key) continue;
    const value = limitValue(eq < 0 ? '' : part.slice(eq + 1));
    if (value == null) continue;
    if (key === 'default') def = value; else perModel.set(key, value);
  }
  const limitFor = (model) => {
    if (allOff) return Infinity;
    const id = String(model == null ? '' : model).toLowerCase();
    if (perModel.has(id)) return perModel.get(id);
    if (def != null) return def;
    return /glm/.test(id) ? 3 : 4;
  };
  return { limitFor };
}

// laneSlots({ model, running, limits }) where running is the list of models the other running lanes
// use: ok when fewer than the model's limit are on it, else a reason a human can read.
export function laneSlots({ model, running, limits } = {}) {
  const limit = limits && typeof limits.limitFor === 'function' ? limits.limitFor(model) : 4;
  if (!Number.isFinite(limit)) return { ok: true };
  const n = (running || []).filter((m) => m === model).length;
  if (n >= limit) return { ok: false, reason: `${n} lanes already use ${model} (limit ${limit})` };
  return { ok: true };
}
