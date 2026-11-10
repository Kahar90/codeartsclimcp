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

// The output text of a failed tool, or '' when the call did not fail. Real CodeArts often reports a
// shell failure as status 'completed' with a nonzero exit code, not status 'error'; a passing command
// (exit 0, or no exit code at all) is never a failure, so output that merely quotes an error inside a
// green test run is not classified.
export function toolFailureText(st) {
  if (!st || typeof st !== 'object') return '';
  if (st.status === 'error') return String(st.error || st.output || '').trim();
  if (st.status === 'completed') {
    const code = st.metadata?.exit ?? st.metadata?.exitCode ?? st.exitCode ?? st.exit;
    if (typeof code === 'number' && code !== 0) return String(st.output || st.error || '').trim();
  }
  return '';
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
  // Git transport fatals: a transient clone/fetch/push network error (not an actionable env failure).
  /Connection reset/i,
  /Failed to connect|Could not resolve host/i,
  /\bnetwork\b/i,
  /\b429\b|rate.?limit|too many requests|quota|Queuing/i,
  /\b50[0234]\b/,
  /\btimed? ?out\b/i,
];

// Builder *assistant narration* is a report, not a failure: it only needs the lead when the worker says
// it is stuck and cannot proceed alone. A status summary that merely names an error it already handled
// ("fixed persistence: ENOENT is now distinguished from a read error") is not an incident.
const ACTIVE_RX = [
  /\b(can'?t|cannot|unable to) (proceed|continue|complete)\b/i,
  /\bnot able to (proceed|continue)\b/i,
  /\bI('?m| am) (stuck|blocked)\b/i,
  /\bblocked (by|on|because)\b/i,
  /\bunable to (create|write|commit|push|install|access|clone|fetch|proceed)\b/i,
];

// A *failed tool diagnostic* is real output, but a test run prints many lines that are not machine
// failures: an expected application assertion ("the generated file is absent: ENOENT") or a passing
// assertion description ("PASS handles Permission denied") are ordinary functional results. Keep the
// genuine, actionable environment failures: a missing executable or module, a git permission,
// authentication or certificate failure, a refused commit.
const TOOL_ENV_RX = [
  /Error: spawn\b.*\bENOENT\b/i,
  /\bspawn\b[^\n]*\bENOENT\b/i,
  /\bENOENT\b[^\n]*\buv_spawn\b/i,
  /Cannot find (module|package)/i,
  /\bMODULE_NOT_FOUND\b/,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /\bEACCES\b|\bEPERM\b/,
  /permission denied by (the )?(system|policy|sandbox)/i,
  /\bPermission denied\b/i,
  /Unable to create/i,
  /index\.lock/i,
  /\bfatal:\s/i,
  /would be overwritten by (checkout|merge|pull)/i,
  /Please commit your changes or stash/i,
  /tool permission/i,
  /Authentication failed|invalid username or password/i,
  /SSL certificate problem|certificate verify failed/i,
  /The requested URL returned error: 40[13]/i,
];

// The lines of a test run that report a *passing* assertion: their description may quote an error
// word, but nothing failed, so they are not diagnostics. ("ok 1 - name", "PASS name", "✓ name".)
const PASS_ASSERTION_RX = /^(?:ok|pass|passed)\b|^[✓√✔]/i;

// The builder's own reply must reach the lead both when the worker says it is stuck (ACTIVE_RX) and when
// it carries a genuine raw environment or commit failure (TOOL_ENV_RX). The failed tool event may never
// reach the runner, but the refusal the reply names still must. A bare application-data ENOENT is not in
// TOOL_ENV_RX, so a resolved-error summary stays quiet.
const ASSISTANT_ENV_RX = [...ACTIVE_RX, ...TOOL_ENV_RX];

// The env vocabulary depends on where the text came from: a tool's failed output, the builder's own
// narration, or (untyped) the legacy classifier used directly on reply text.
const envRxFor = (source) => (source === 'tool' ? TOOL_ENV_RX : source === 'assistant' ? ASSISTANT_ENV_RX : ENV_RX);

const clip = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 160);
// A question that answers itself or quotes the brief is not a request for the lead.
const isRhetorical = (line) => /^(why|how come|isn'?t|aren'?t|doesn'?t|don'?t|surely|obviously)\b/i.test(line);
// Lines that are fenced code or quoted text are never read as a request or an error.
const isQuoted = (line) => /^[>»|]/.test(line);
// Inline `code` spans in prose are quoted too: a builder narrating an error it already fixed
// ("I hit `Permission denied` and fixed it") must not raise an ENV blocker that survives the fix.
const stripInlineCode = (line) => line.replace(/`[^`]*`/g, ' ');

function envLine(s, source) {
  let fenced = false;
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || isQuoted(line)) continue;
    if (source === 'tool' && PASS_ASSERTION_RX.test(line)) continue; // a passing assertion is not a diagnostic
    const body = stripInlineCode(line);
    if (source === 'assistant' && /\b(?:I|we)\s+(?:have\s+)?(?:fixed|resolved|removed|generated|recovered|handled)\b|\b(?:now|already)\s+(?:fixed|resolved|working|handled)\b/i.test(body) && !/\b(?:still|cannot|can't|blocked|need help)\b/i.test(body)) continue;
    if (TRANSIENT_RX.some((rx) => rx.test(body))) continue;
    if (envRxFor(source).some((rx) => rx.test(body))) return line;
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

// classifySignal(text) or classifySignal({ text, agentRole, source }) -> { kind, text, why } | null.
// `source` names where the text came from: 'assistant' (the builder's own reply, narration) or 'tool'
// (a failed tool's output, diagnostics). It picks the env vocabulary and lets a passing assertion or a
// resolved-error summary pass as an ordinary functional result. Without it the classifier is untyped
// and keeps its legacy behaviour. A review session (agentRole 'review') never blocks the lead.
export function classifySignal(input) {
  const o = typeof input === 'string' ? { text: input } : (input || {});
  if (o.agentRole === 'review' || o.review) return null;
  const s = String(o.text == null ? '' : o.text).replace(/\r/g, '');
  if (!s.trim()) return null;
  const el = envLine(s, o.source);
  if (el) return { kind: ENV, text: clip(el), why: 'an environment failure the worker cannot fix alone' };
  const dl = decisionLine(s);
  if (dl) return { kind: DECISION, text: clip(dl), why: 'the worker asks the lead to decide or grant permission' };
  return null;
}

// Numbered brief steps that still have no explicit "step N:" commit. Positional fallback is deliberately
// NOT used: an unrelated wip commit must never be read as completing a step.
export function uncommittedSteps(stepList = [], commitLog = []) {
  const done = new Set();
  for (const c of commitLog) { const m = String((c && c.subject) || '').match(/^step\s*(\d+)\s*:/i); if (m) done.add(Number(m[1])); }
  return stepList.filter((s) => !done.has(s.n)).map((s) => s.n);
}
