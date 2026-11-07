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
