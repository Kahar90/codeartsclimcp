// Pure signal classifier for the lane supervisor: no imports, no side effects.
//
// A worker that is waiting on a human decision, or that hit an environment failure it cannot fix
// alone, must reach the lead in seconds instead of looping unseen. The supervisor calls
// classifySignal() on the worker's finished reply text and on failed tool output; a non-null result
// becomes S.blocker, so `ca wait`, `ca status` and the dashboard surface it at once.
//
// It stays quiet for noise: quoted code and fenced snippets, rhetorical questions, review sessions,
// and the transient network or rate-limit errors the supervisor already retries.

export const DECISION = 'decision'; // the worker asks the lead to decide or to grant permission
export const ENV = 'env';           // an actionable environment failure (commit refused, missing tool)
export const SANDBOX_CHECK = 'sandbox-check'; // the worker ran a lane CHECK line directly in its sandbox
export const REPEAT_FAIL = 'repeat-fail';     // the same tool keeps failing with no progress

// The worker must run this lane's CHECK lines through tasks/<task>.lane/check.mjs: the runner runs them
// outside the sandbox, where the loopback network works. A bash command that runs a CHECK line (or a
// checks/*.check.* file) directly hangs the worker, so return the offending command, else ''.
export function directCheckInvocation(command, { checks = [], helper = '' } = {}) {
  const cmd = String(command == null ? '' : command).replace(/\s+/g, ' ').trim();
  if (!cmd) return '';
  if (helper && cmd.includes(String(helper).replace(/\s+/g, ' ').trim())) return ''; // the lane helper: correct
  if (/\.lane[\\/]check\.mjs/.test(cmd)) return '';                                   // any lane helper path: correct
  for (const c of checks) {
    const cc = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
    if (cc && cmd.includes(cc)) return cc;
  }
  const m = cmd.match(/\b(?:node|npx|ts-node|python3?)\s+(checks[\\/][\w./-]+\.(?:mjs|cjs|js|py))/i);
  return m ? m[1] : '';
}

export const REPEAT_FAIL_LIMIT = 3;
// Track one tool command's failures. prev = { n, commits } (commits = the lane commit count when it
// first failed). Returns the next counter and whether this is the same command failing again with no
// progress (no new commit since it started) past the limit.
export function noteFailure(prev, { commits, limit = REPEAT_FAIL_LIMIT } = {}) {
  const st = prev && prev.commits === commits ? { n: (prev.n || 0) + 1, commits } : { n: 1, commits };
  return { state: st, repeat: st.n >= limit };
}

// A stable key for "the same tool doing the same thing", so repeated failures of one command collapse.
export function toolKey(tool, input) {
  const cmd = typeof input === 'object' && input ? (input.command ?? input.filePath ?? input.path ?? '') : input;
  return `${String(tool || 'tool')}:${String(cmd == null ? '' : cmd).replace(/\s+/g, ' ').trim().slice(0, 120)}`;
}

// Explicit first/second-person requests for a lead decision or permission. The strong phrases need
// no question mark; the weak ones only count inside a real question.
const STRONG = [
  /\bshould I\b/i,
  /\bshall I\b/i,
  /\b(do|would) you (want|like|prefer) me to\b/i,
  /\bplease (confirm|choose|decide|advise|clarify|approve|authori[sz]e)\b/i,
  /\b(can|may|should) I (proceed|continue|commit|push|delete|remove|overwrite|install|write|modify|create)\b/i,
  /\bI (need|require) (you|the lead|a human|your)\b/i,
  /\b(need|want|await|awaiting|waiting for) (your|the lead'?s?|a) (input|decision|confirmation|approval|guidance|answer|permission)\b/i,
  /\bwaiting for (you|the lead|confirmation|approval|permission)\b/i,
];
const WEAK_Q = [
  /\bwhich\b.*\b(you|I|lead|prefer|should|choose|use|pick)\b/i,
  /\b(you|your|lead)\b.*\b(prefer|recommend|suggest|choose|decide|want|approve)\b/i,
  /\bwhat (should|do) (I|you|we)\b/i,
];

// Actionable environment failures: the worker cannot fix these alone.
const ENV_RX = [
  /Unable to create/i,
  /index\.lock/i,
  /Permission denied/i,
  /\bEACCES\b|\bEPERM\b/,
  /permission denied by (the )?(system|policy|sandbox)/i,
  /\bfatal:\s/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /Cannot find (module|package)/i,
  /\bMODULE_NOT_FOUND\b/,
  /\bENOENT\b|No such file or directory/i,
  /would be overwritten by (checkout|merge|pull)/i,
  /Please commit your changes or stash/i,
  /tool permission/i,
];

// Transient transport or quota problems the supervisor already retries: never a blocker.
const TRANSIENT_RX = [
  /\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bENOTFOUND\b/i,
  /fetch failed|socket hang ?up|Cannot connect/i,
  /\bnetwork\b/i,
  /\b429\b|rate.?limit|too many requests|quota|Queuing/i,
  /\b50[0234]\b/,
  /\btimed? ?out\b/i,
];

const clip = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 160);
// A question that answers itself or quotes the brief is not a request for the lead.
const isRhetorical = (line) => /^(why|how come|isn'?t|aren'?t|doesn'?t|don'?t|surely|obviously)\b/i.test(line);
// Lines that are fenced code or quoted text are never read as a request or an error.
const isQuoted = (line) => /^[>»|]/.test(line);

function envLine(s) {
  let fenced = false;
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || isQuoted(line)) continue;
    if (TRANSIENT_RX.some((rx) => rx.test(line))) continue;
    if (ENV_RX.some((rx) => rx.test(line))) return line;
  }
  return '';
}

function decisionLine(s) {
  let fenced = false; const usable = [];
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || isQuoted(line) || isRhetorical(line)) continue;
    usable.push(line);
  }
  for (const line of usable) if (STRONG.some((rx) => rx.test(line))) return line;
  for (const line of usable) if (line.includes('?') && WEAK_Q.some((rx) => rx.test(line))) return line;
  return '';
}

// classifySignal(text) or classifySignal({ text, agentRole }) -> { kind, text, why } | null.
// A review session (agentRole 'review') never blocks the lead: its text is report, not a request.
export function classifySignal(input) {
  const o = typeof input === 'string' ? { text: input } : (input || {});
  if (o.agentRole === 'review' || o.review) return null;
  const s = String(o.text == null ? '' : o.text).replace(/\r/g, '');
  if (!s.trim()) return null;
  const el = envLine(s);
  if (el) return { kind: ENV, text: clip(el), why: 'an environment failure the worker cannot fix alone' };
  const dl = decisionLine(s);
  if (dl) return { kind: DECISION, text: clip(dl), why: 'the worker asks the lead to decide or grant permission' };
  return null;
}
