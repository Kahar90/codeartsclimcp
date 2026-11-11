// Contract check for the fast gates.
// Step 1: the runner must not repeat a CHECK line whose tested content is unchanged, must be able to run
// CHECK lines side by side when a lane opts in, and must keep the old stop-at-the-first-failure behaviour
// when it does not. End to end against the fake CodeArts server; private registry and settings.
//   A. Run every CHECK green on a dirty tree, then commit byte-identical content: the gate reuses the
//      runs (the old HEAD+clean cache could not, the tree was dirty).
//   B. A commit that changes the content disables the reuse: the gate runs the lines itself.
//   C. By default the CHECK lines run one at a time and keep CHECK order.
//   D. With CHECK_PARALLEL set, independent slow lines run together and the gate span drops by more
//      than half, while the gate output stays in CHECK order.
//   E. A failing first CHECK line stops the run: the second line never executes its side effect.
//   F. A file whose path has a non-ASCII character and a space is fingerprinted (reuse still works).
//   G. Changing such a file's content after the worker run disables the reuse.
//   J. The worker runs the same helper twice on identical content: the check service runs it once.
//   K. Content changes between the two helper runs: the second is not reused.
//   L. A `CHECK_PARALLEL: N` brief line opts in without env (a lead using only the MCP brief workflow).
//   M. The CHECK_PARALLEL env var overrides the brief line.
// Step 2: the final review must be handed prepared context, must fall back for a large diff, and must
// still run and keep its gate.
//   H. A small change: the prompt carries the brief, the commits, the diff stat and the inline diff.
//   I. A large change: the prompt carries the diff stat and an explicit read-it-yourself pointer, not
//      the whole diff (a bounded read that overflows is never presented as an empty successful diff).
//   N. A healthy speculative review past its polling budget is adopted on the same session (no replay).
//   O. CHECK_PARALLEL=0 in the env forces the sequential path over a brief CHECK_PARALLEL value.
//   P. A parallel run records every line that actually ran in the gates, naming the first failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fastgates-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240' };
delete base.STEP_REVIEW; delete base.CHECK_PARALLEL;

const count = (n) => `node -e "require('fs').appendFileSync('tasks/work.lane/count${n}.txt','x')"`;
const sleep = (ms) => `node -e "setTimeout(()=>{}, ${ms})"`;
const pass = `node -e "process.exit(0)"`;
const SLOW = [sleep(500), sleep(500), sleep(500), sleep(500)];
const countBrief = `Goal: counter checks.\n1. Write page1.html. Commit.\nCHECK: ${count(1)}\nCHECK: ${count(2)}\n`;
const slowBrief = `Goal: slow checks.\n1. Write page1.html. Commit.\n${SLOW.map((c) => 'CHECK: ' + c).join('\n')}\n`;
const slowBriefParallel = (n) => `Goal: slow checks.\nCHECK_PARALLEL: ${n}\n1. Write page1.html. Commit.\n${SLOW.map((c) => 'CHECK: ' + c).join('\n')}\n`;
const failFirstBrief = `Goal: stop at the first failure.\n1. Write page1.html. Commit.\nCHECK: node -e "process.exit(5)"\nCHECK: ${count(2)}\n`;
const reviewBrief = (goal) => `Goal: ${goal}.\n1. Write page1.html. Commit.\nCHECK: ${pass}\n`;
const BIG = Array.from({ length: 800 }, (_, i) => `LARGE_LINE_${i}_${'x'.repeat(40)}`).join('\n') + '\n';
const UNI = { 'caf\u00e9 notes.txt': 'hello \u03b1\n' };
const REV = { NO_REVIEW: '', STEP_REVIEW: '0', FAKE_REVIEW_MS: '600' };
const multiFailBrief = `Goal: multi fail.\nCHECK_PARALLEL: 4\n1. Write page1.html. Commit.\nCHECK: node -e "process.exit(3)"\nCHECK: ${sleep(300)}\nCHECK: node -e "process.exit(7)"\nCHECK: ${sleep(300)}\n`;

const jsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

async function lane(name, brief, script, env = {}, extra = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  for (const [rel, text] of Object.entries(extra)) { const full = path.join(repo, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = await run(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, timeout: 220000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  const gates = (st?.gates || []).filter((x) => x.gate !== 'git clean');
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, gates,
    count1: read('tasks/work.lane/count1.txt').length, count2: read('tasks/work.lane/count2.txt').length,
    prompts: jsonl(path.join(repo, 'fake-prompts.log')), aborts: read('fake-aborts.log'), status: g('status', '--porcelain').stdout };
}
const span = (gates) => Math.max(...gates.map((g) => g.at + (g.ms || 0))) - Math.min(...gates.map((g) => g.at));
const orderOf = (gates) => JSON.stringify(gates.map((g) => g.gate));

// Every scenario is independent (own repo, shared registry), so start them all first and await the pool.
const [a, b, c, d, e, f, g, j, k, l, m, o0, p, h, i, n] = await pool(4, [
  () => lane('reuse', countBrief, ['write:page1.html=<p>thing 1</p>\n+run:all+commit:1']),
  () => lane('mutate', countBrief, ['commit:1+run:all+commit:2']),
  () => lane('seq', slowBrief, ['commit:1']),
  () => lane('par', slowBrief, ['commit:1'], { CHECK_PARALLEL: '4' }),
  () => lane('stopfirst', failFirstBrief, ['commit:1'], { MAX_FIXES: '0' }),
  () => lane('unicode', countBrief, ['write:page1.html=<p>thing 1</p>\n+run:all+commit:1'], {}, UNI),
  () => lane('unicode-mutate', countBrief, ['run:all+write:caf\u00e9 notes.txt=CHANGED\n+commit:1'], {}, UNI),
  () => lane('serverreuse', countBrief, ['commit:1+run:all+run:all']),
  () => lane('serverinvalidate', countBrief, ['run:all+write:page1.html=<p>thing 1</p>\n+run:all+commit:1']),
  () => lane('briefpar', slowBriefParallel(4), ['commit:1']),
  () => lane('envwins', slowBriefParallel(1), ['commit:1'], { CHECK_PARALLEL: '4' }),
  () => lane('envzero', slowBriefParallel(4), ['commit:1'], { CHECK_PARALLEL: '0' }),
  () => lane('parmulti', multiFailBrief, ['commit:1'], { MAX_FIXES: '0' }),
  () => lane('revsmall', reviewBrief('review small'), ['commit:1'], REV),
  () => lane('revlarge', reviewBrief('review large'), [`write:big.txt=${BIG}+commit:1`], REV),
  () => lane('specadopt', reviewBrief('review adopt'), ['commit:1'], { NO_REVIEW: '', STEP_REVIEW: '0', FAKE_REVIEW_MS: '8000', STEP_REVIEW_TIMEOUT: '1' }),
]);

// A: run every CHECK green on a dirty tree, then commit the identical content.
check('A lane ends DONE', a.code === 0 && a.st?.result === 'done', `${a.code} ${a.st?.result} ${a.st?.reason || ''}`);
const aWc = a.st?.workerChecks || [];
check('A the worker run records a content fingerprint for every line', aWc.length >= 2 && aWc.every((x) => typeof x.fp === 'string' && x.fp),
  JSON.stringify(aWc.map((x) => [x.n, x.code, x.clean, !!x.fp])).slice(0, 300));
check('A the gate reused the green runs across the commit (reused: true, checks ran once)',
  a.gates.length === 2 && a.gates.every((x) => x.ok && x.reused === true) && a.count1 === 1 && a.count2 === 1,
  `count1 ${a.count1} count2 ${a.count2} gates ${JSON.stringify(a.gates.map((x) => [x.gate.slice(0, 24), x.ok, x.reused]))}`);

// B: a later commit changes the content, so the reuse is disabled.
check('B a commit that changes content: the gate runs the checks again (no reuse)',
  b.code === 0 && b.count1 === 2 && b.count2 === 2 && !b.gates.some((x) => x.reused),
  `${b.code} count1 ${b.count1} count2 ${b.count2} reused ${b.gates.filter((x) => x.reused).length}`);

// C: default is sequential.
check('C default: the CHECK lines run one at a time and all pass', c.code === 0 && c.gates.length === 4 && c.gates.every((x) => x.ok && !x.reused), JSON.stringify(c.gates.map((x) => [x.gate.slice(0, 30), x.ok, x.ms])));
check('C default: the gate output keeps CHECK order', orderOf(c.gates) === JSON.stringify(SLOW), orderOf(c.gates).slice(0, 200));
const seqSpan = c.gates.length === 4 ? span(c.gates) : 0;

// D: opt-in parallelism.
check('D CHECK_PARALLEL: the CHECK lines run together and all pass', d.code === 0 && d.gates.length === 4 && d.gates.every((x) => x.ok), JSON.stringify(d.gates.map((x) => [x.gate.slice(0, 30), x.ok, x.ms])));
check('D parallelism keeps the gate output in CHECK order', orderOf(d.gates) === JSON.stringify(SLOW), orderOf(d.gates).slice(0, 200));
const parSpan = d.gates.length === 4 ? span(d.gates) : 0;
check('D parallelism cuts the gate span by more than half', seqSpan > 1500 && parSpan > 0 && parSpan * 2 < seqSpan, `sequential ${seqSpan}ms parallel ${parSpan}ms`);

// E: a failing first check must stop the run (no second side effect).
check('E the lane fails on the first failing CHECK line', e.code !== 0 && e.st?.result !== 'done', `${e.code} ${e.st?.result}`);
check('E the second CHECK line never ran its side effect', e.count2 === 0 && e.gates.length === 1 && e.gates[0].ok === false,
  `count2 ${e.count2} gates ${JSON.stringify(e.gates.map((x) => [x.gate.slice(0, 30), x.ok, x.code]))}`);

// F / G: a non-ASCII path with a space must still be fingerprinted (and its change must invalidate).
check('F a non-ASCII, spaced filename is fingerprinted: the gate still reuses',
  f.code === 0 && f.count1 === 1 && f.count2 === 1 && f.gates.every((x) => x.ok && x.reused === true),
  `${f.code} count1 ${f.count1} count2 ${f.count2} reused ${f.gates.filter((x) => x.reused).length}`);
check('G changing the non-ASCII file after the run disables the reuse',
  g.code === 0 && g.count1 === 2 && g.count2 === 2 && !g.gates.some((x) => x.reused),
  `${g.code} count1 ${g.count1} count2 ${g.count2} reused ${g.gates.filter((x) => x.reused).length}`);

// J: the worker runs the same helper twice on identical content: the check service runs it once.
check('J a repeated helper on identical content executes the check only once',
  j.code === 0 && j.count1 === 1 && j.count2 === 1 && (j.st?.workerChecks || []).some((x) => x.cached === true),
  `${j.code} count1 ${j.count1} count2 ${j.count2} cached ${(j.st?.workerChecks || []).filter((x) => x.cached).length}`);

// K: content changes between the two helper runs, so the second is not reused.
check('K a content change between helper runs invalidates the check-service cache',
  k.code === 0 && k.count1 === 2 && k.count2 === 2,
  `${k.code} count1 ${k.count1} count2 ${k.count2}`);

// L: a brief line opts in without env, for leads using only the MCP brief workflow.
check('L a CHECK_PARALLEL brief line opts in without env',
  l.code === 0 && l.gates.length === 4 && l.gates.every((x) => x.ok) && orderOf(l.gates) === JSON.stringify(SLOW) && span(l.gates) * 2 < seqSpan,
  `span ${span(l.gates)} vs sequential ${seqSpan}`);

// M: the env var overrides a brief value.
check('M the CHECK_PARALLEL env var overrides the brief line',
  m.code === 0 && m.gates.length === 4 && span(m.gates) * 2 < seqSpan,
  `span ${span(m.gates)} vs sequential ${seqSpan}`);

// O: CHECK_PARALLEL=0 in the env must force the sequential path over a brief value (the env wins).
check('O CHECK_PARALLEL=0 forces sequential over the brief value',
  o0.code === 0 && o0.gates.length === 4 && o0.gates.every((x) => x.ok) && orderOf(o0.gates) === JSON.stringify(SLOW) && span(o0.gates) > parSpan * 2,
  `span ${span(o0.gates)} parallel ${parSpan}`);

// P: in a parallel run every line that ran is recorded in the gates, not only up to the first failure.
check('P a parallel run records every CHECK line that ran, in CHECK order',
  p.code !== 0 && p.st?.result !== 'done' && p.gates.length === 4 && p.gates.map((x) => x.ok).join() === 'false,true,false,true',
  `${p.code} ${p.st?.result} gates ${JSON.stringify(p.gates.map((x) => [x.gate.slice(0, 24), x.ok]))}`);

// H: the small-change review gets prepared context and the review gate is unchanged.
const htext = (h.prompts || []).filter((p) => p.agent === 'plan').map((p) => p.text).join('\n\n');
check('H the final review still runs once and keeps its gate',
  h.code === 0 && h.st?.result === 'done' && h.st?.verdict === 'ready' && (h.st?.reviewRounds || []).length === 1,
  `${h.code} ${h.st?.result} ${h.st?.verdict} rounds ${(h.st?.reviewRounds || []).length}`);
check('H the review prompt carries the brief, the commits, the diff stat and the small diff',
  htext.includes('Task brief (tasks/work.md):') && htext.includes('Goal: review small') && htext.includes('Commits (') &&
  htext.includes('step 1: thing 1') && htext.includes('Diff stat (') && htext.includes('Diff (') && htext.includes('page1.html') &&
  !htext.includes('not inlined here'),
  htext.slice(0, 300));

// I: a large change falls back to the diff stat and an explicit pointer, and the review still runs.
const itext = (i.prompts || []).filter((p) => p.agent === 'plan').map((p) => p.text).join('\n\n');
check('I the large diff falls back to the diff stat and a read-it-yourself pointer, not the whole diff',
  i.code === 0 && itext.includes('Diff stat (') && itext.includes('big.txt') && itext.includes('not inlined here') &&
  itext.includes('git diff ') && !itext.includes('LARGE_LINE_'),
  itext.slice(0, 300));
check('I the review still runs and keeps its gate',
  i.st?.result === 'done' && i.st?.verdict === 'ready' && (i.st?.reviewRounds || []).length === 1,
  `${i.st?.result} ${i.st?.verdict} rounds ${(i.st?.reviewRounds || []).length}`);

// N: a healthy speculative review that outruns its polling budget is adopted, not aborted and replayed.
const np = (n.prompts || []).filter((p) => p.agent === 'plan');
check('N a speculative review past its polling budget is adopted on the same session',
  n.code === 0 && n.st?.result === 'done' && n.st?.verdict === 'ready' && (n.st?.reviewRounds || []).length === 1,
  `${n.code} ${n.st?.result} ${n.st?.verdict} rounds ${(n.st?.reviewRounds || []).length}`);
check('N exactly one final-review prompt for the HEAD (no replay)',
  np.length === 1 && np[0].text.includes('Prepared context from the runner'),
  `prompts ${np.length} aborts ${JSON.stringify(n.aborts.slice(0, 120))}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
