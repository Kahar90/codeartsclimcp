// Contract check: a lane's step completion comes from real step evidence ("step N" subjects), never
// from the result or from arbitrary commits. The status contract's `steps` field must never claim
// completion for a lane whose steps are actually open.
import assert from 'node:assert/strict';
import { stepProgress } from '../runner/common.mjs';
import { laneOutcome } from '../runner/controls.mjs';

const steps = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `s${i + 1}` }));
const state = (p, n) => p.list.find((x) => x.n === n).state;

// 1. Unrelated commits (wip, housekeeping, fix) never complete a numbered step.
let p = stepProgress({ stepList: steps(3), result: 'done', commitLog: [
  { hash: 'a', subject: 'wip: investigate' },
  { hash: 'b', subject: 'housekeeping: tidy the tree' },
  { hash: 'c', subject: 'fix: correct a typo' },
] });
assert.equal(p.total, 3);
assert.equal(p.done, 0, 'unrelated commits must not complete numbered steps');
console.log('PASS unrelated commits leave numbered steps open');

// 2. An explicit "step N" subject maps to its own step, uniquely.
p = stepProgress({ stepList: steps(3), result: 'done', commitLog: [
  { hash: 'a', subject: 'wip: noise' },
  { hash: 'b', subject: 'step 2: second' },
] });
assert.equal(p.done, 1);
assert.equal(state(p, 2), 'done', 'step 2 completes step 2');
assert.equal(state(p, 1), 'open', 'step 1 stays open');
assert.equal(state(p, 3), 'open');
console.log('PASS explicit step subjects map to their own step');

// 3. A stray "step N" mentioned inside another subject is not a step.
p = stepProgress({ stepList: steps(2), commitLog: [{ hash: 'a', subject: 'fix: step 1 handoff was wrong' }] });
assert.equal(p.done, 0, 'a step mention inside an unrelated subject is not completion');
console.log('PASS a step mention inside another subject is ignored');

// 4. A legacy lane with no step evidence keeps every step open; commits are never mapped positionally.
p = stepProgress({ stepList: steps(3), result: 'done', commitLog: [
  { hash: 'a', subject: 'initial work' },
  { hash: 'b', subject: 'more work' },
] });
assert.equal(p.done, 0, 'commits without a step subject are never mapped to steps');
console.log('PASS commits without a step subject are never inferred as steps');

// 5. The status never reports complete for a known incomplete fraction, even done / handled / merged.
const doneAt0 = laneOutcome({ s: { result: 'done' }, progress: { done: 0, total: 3 } });
assert.equal(doneAt0.steps, 'partial', 'done with 0/3 steps is partial, not complete');
const doneAt1 = laneOutcome({ s: { result: 'done' }, progress: { done: 1, total: 3 } });
assert.equal(doneAt1.steps, 'partial', 'done with 1/3 steps is partial, not complete');
console.log('PASS done lanes with open steps never report complete');

// 6. A handled/merged lane with open steps is partial and never attention.
const merged = laneOutcome({ s: { result: 'done' }, handled: true, note: 'merged into main', progress: { done: 1, total: 3 } });
assert.equal(merged.key, 'handled');
assert.equal(merged.steps, 'partial', 'a merged lane with open steps is partial, not complete');
assert.equal(merged.attention, false, 'a handled lane is never attention');
console.log('PASS a merged lane with open steps stays partial and not attention');

// 7. Complete only when every step is done.
const full = laneOutcome({ s: { result: 'done' }, progress: { done: 3, total: 3 } });
assert.equal(full.steps, 'complete', 'a fully done lane is complete');
const verified = laneOutcome({ s: { result: 'done' }, progress: { done: 3, total: 3 } });
assert.equal(verified.steps, 'complete');
console.log('PASS a fully done lane is complete');

// 8. Absent legacy progress is hidden, never faked as complete.
const absent = laneOutcome({ s: { result: 'done' }, progress: { done: 0, total: 0 } });
assert.equal(absent.steps, 'hide', 'no known step list hides the fraction instead of faking completion');
console.log('PASS absent legacy progress is hidden, not faked');

// Stale payloads and demo variants can carry a complete status beside an incomplete fraction.
const { readFileSync } = await import('node:fs');
const { runInNewContext } = await import('node:vm');
const load = (file, name) => {
  const html = readFileSync(new URL('../runner/' + file, import.meta.url), 'utf8');
  const source = html.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'))[0];
  return runInNewContext(source + '; ' + name);
};
const stale = { status: { steps: 'complete' }, progress: { done: 1, total: 3 } };
assert.equal(load('dash.html', 'laneStepsMode')(stale), 'partial');
assert.equal(load('office.html', 'stepsFraction')(stale.status, stale), '1/3');
console.log('PASS both views reject stale complete status beside unfinished steps');
assert.equal(stepProgress({ stepList: steps(1), commitLog: [{ hash: 'wip', subject: 'step 1 WIP draft' }] }).done, 0, 'progress requires the same colon-delimited step proof as the completion gate');
console.log('stepstruth: all checks passed');
