// Contract check (no browser): both views must take a lane's needs-you state, bucket, tone and
// result colour from the server status, and their fallbacks for payloads without those fields must
// follow the same rules as runner/controls.mjs (laneBucket and withStatusFields). It reads office.html
// and dash.html, extracts the named functions by their source text and evaluates them in a node:vm
// context, so a view that computes a status disagreeing with the server fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = (file) => readFileSync(new URL('../runner/' + file, import.meta.url), 'utf8');
const grab = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(m, `could not extract function ${name} from the view source`);
  return m[0];
};
const fn = (src, name, sandbox = {}) => runInNewContext(grab(src, name) + '\n' + name, sandbox);
const check = (name, ok, info = '') => { assert.ok(ok, `${name}${info ? '  ' + info : ''}`); console.log('PASS ' + name); };

const office = html('office.html');

// ---------- office.html: one needs-you rule, shared by seating, the bucket and the plan status ----------
const officeNeedsYou = fn(office, 'isNeedsYou');
const officeBucket = fn(office, 'laneBucket', { isNeedsYou: officeNeedsYou });
const officePlanStatus = fn(office, 'planStatus', { isNeedsYou: officeNeedsYou });

// A handled failed lane: the server sends attention false and bucket ended, but its health still
// reads "failed", so the old health-first check seated and ranked it as needs-you.
const handled = { health: 'failed', result: 'failed', bucket: 'ended', handled: true,
  status: { key: 'handled', label: 'Handled by lead', tone: 'idle', attention: false } };
check('office: a handled failed lane is not needs-you', officeNeedsYou(handled) === false);
check('office: a handled failed lane buckets ended', officeBucket(handled) === 'ended');

// status.attention is a boolean: it wins over any other signal.
check('office: status.attention true makes a lane needs-you', officeNeedsYou({ health: 'running', status: { attention: true } }) === true);
check('office: status.attention false keeps a failed lane out of needs-you', officeNeedsYou({ health: 'failed', result: 'failed', status: { attention: false } }) === false);

// A real bucket decides next, before the derivation.
check('office: bucket attention is needs-you without a status', officeNeedsYou({ bucket: 'attention' }) === true);
check('office: bucket ended is not needs-you', officeNeedsYou({ bucket: 'ended', health: 'failed' }) === false);

// The derivation the server uses for payloads with neither field.
check('office: health STALLED is needs-you', officeNeedsYou({ health: 'STALLED' }) === true);
check('office: health DEAD is needs-you', officeNeedsYou({ health: 'DEAD' }) === true);
check('office: the real thinking health is needs-you', officeNeedsYou({ health: 'thinking (12m, no tool call)' }) === true);
check('office: a blocker with text is needs-you', officeNeedsYou({ health: 'running', blocker: { kind: 'question', text: 'Which db?' } }) === true);
for (const r of ['failed', 'paused', 'needs review', 'unverified', 'checks failing']) {
  check(`office: result ${r} is needs-you`, officeNeedsYou({ result: r }) === true);
}
check('office: a plain running lane is not needs-you', officeNeedsYou({ health: 'running', running: true }) === false);
check('office: a plain done lane is not needs-you', officeNeedsYou({ result: 'done' }) === false);

// The laneBucket fallback mirrors the same rule, so a needs review lane is not seated as done.
check('office: laneBucket failed without a bucket is attention', officeBucket({ result: 'failed' }) === 'attention');
check('office: laneBucket running is running', officeBucket({ running: true }) === 'running');
check('office: laneBucket done is done', officeBucket({ result: 'done' }) === 'done');
check('office: laneBucket with nothing ends', officeBucket({}) === 'ended');

// The planStatus fallback uses the same rule, and a needs review lane is never counted as done.
check('office: planStatus never counts a needs review lane as done', officePlanStatus({}, [{ result: 'needs review' }]) !== 'done', String(officePlanStatus({}, [{ result: 'needs review' }])));
check('office: planStatus a needs-you lane reads attention', officePlanStatus({}, [{ result: 'needs review' }]) === 'attention');
check('office: planStatus turns attention for a handled-free failed lane', officePlanStatus({}, [{ result: 'failed' }]) === 'attention');
check('office: planStatus all done reads done', officePlanStatus({}, [{ result: 'done' }, { result: 'done' }]) === 'done');
check('office: planStatus a running lane reads running', officePlanStatus({}, [{ running: true }]) === 'running');
check('office: planStatus with no lanes reads planned', officePlanStatus({}, []) === 'planned');
check('office: planStatus keeps the server state when present', officePlanStatus({ state: 'verifying' }, [{ result: 'failed' }]) === 'verifying');

console.log('viewstruth: all checks passed');
