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

// ---------- dash.html: the same buckets, and the step bar and pipeline take the server tone ----------
const dash = html('dash.html');
const dashBucket = fn(dash, 'laneBucket');
const dashProg = fn(dash, 'prog');
const dashPipeline = fn(dash, 'pipeline', { esc: (s) => String(s ?? '') });

// The server sends bucket on every lane; the fallback must mirror runner/controls.mjs laneBucket.
check('dash: an explicit bucket wins', dashBucket({ bucket: 'ended', result: 'failed' }) === 'ended');
for (const r of ['done', 'continued']) check(`dash: result ${r} buckets done`, dashBucket({ result: r }) === 'done');
for (const r of ['stopped', 'killed', 'dropped']) check(`dash: result ${r} buckets ended`, dashBucket({ result: r }) === 'ended');
for (const r of ['failed', 'paused', 'needs review', 'unverified', 'checks failing']) {
  check(`dash: result ${r} buckets attention`, dashBucket({ result: r }) === 'attention');
}
check('dash: a stalled health buckets attention', dashBucket({ health: 'stalled (12m, no tool call)' }) === 'attention');
check('dash: a dead health buckets attention', dashBucket({ health: 'DEAD' }) === 'attention');
check('dash: a running lane buckets running', dashBucket({ running: true }) === 'running');
check('dash: a lane with nothing buckets ended', dashBucket({}) === 'ended');

// The step bar colour follows the server tone when a status is present, and only an older payload
// without one falls back to the raw result rule.
check('dash: prog takes a bad status tone', /prog bad/.test(dashProg({ done: 1, total: 3 }, 'done', { tone: 'bad' })));
check('dash: prog takes a done status tone', /prog ok/.test(dashProg({ done: 3, total: 3 }, 'failed', { tone: 'done' })));
check('dash: prog ignores the result when a status is present', /prog ">/.test(dashProg({ done: 1, total: 3 }, 'failed', { tone: 'idle' })));
check('dash: prog falls back to a failed result without a status', /prog bad/.test(dashProg({ done: 1, total: 3 }, 'failed')));
check('dash: prog falls back to a done result without a status', /prog ok/.test(dashProg({ done: 3, total: 3 }, 'done')));

// The pipeline result cell shows the server status label and tone, and only falls back to the result.
const lane = (over) => Object.assign({ phases: [{ phase: 'build' }], gates: [{ ok: true }], result: 'done' }, over);
const lastSeg = (out) => out.slice(out.lastIndexOf('<span class="seg '));
const doneCell = lastSeg(dashPipeline(lane({ status: { label: 'Merged', tone: 'done' } })));
check('dash: pipeline paints a done status cell done', /^<span class="seg done">/.test(doneCell) && doneCell.includes('Merged'));
const badCell = lastSeg(dashPipeline(lane({ status: { label: 'Failed after 2 fixes', tone: 'bad' } })));
check('dash: pipeline paints a bad status cell fail', /^<span class="seg fail">/.test(badCell) && badCell.includes('Failed after 2 fixes'));
const idleCell = lastSeg(dashPipeline(lane({ status: { label: 'Handled by lead', tone: 'idle' } })));
check('dash: pipeline leaves a neutral status cell uncoloured', /^<span class="seg ">/.test(idleCell) && idleCell.includes('Handled by lead'));
const oldDone = lastSeg(dashPipeline(lane({ result: 'done' })));
check('dash: pipeline falls back to a done result without a status', /^<span class="seg done">/.test(oldDone));
const oldFail = lastSeg(dashPipeline(lane({ result: 'failed' })));
check('dash: pipeline falls back to a failed result without a status', /^<span class="seg fail">/.test(oldFail));

console.log('viewstruth: all checks passed');
