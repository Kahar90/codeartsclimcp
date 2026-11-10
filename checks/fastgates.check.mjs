// Contract check for the fast gates: the runner must not repeat a CHECK line whose tested content is
// unchanged, and it must be able to run CHECK lines side by side when a lane opts in. End to end
// against the fake CodeArts server; private registry and settings, no real CodeArts.
//   A. The worker runs every CHECK line green on a dirty tree and then commits content that is
//      byte-identical: the commit does not change the tested content, so the gate reuses the runs
//      instead of running them again (the old HEAD+clean cache could not, because the tree was dirty).
//   B. A commit that changes the content disables the reuse: the gate runs the lines itself.
//   C. By default the CHECK lines run one at a time (checks may depend on order) and keep CHECK order.
//   D. With CHECK_PARALLEL set, independent slow lines run together and the gate span drops by more
//      than half, while the gate output stays in CHECK order.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const SLOW = [sleep(500), sleep(500), sleep(500), sleep(500)];
const countBrief = `Goal: counter checks.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: ${count(1)}\nCHECK: ${count(2)}\n`;
const slowBrief = `Goal: slow checks.\n1. Write page1.html. Commit.\n${SLOW.map((c) => 'CHECK: ' + c).join('\n')}\n`;

function lane(name, brief, script, env = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = spawnSync(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, encoding: 'utf8', timeout: 220000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  const gates = (st?.gates || []).filter((x) => x.gate !== 'git clean');
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, gates,
    count1: read('tasks/work.lane/count1.txt').length, count2: read('tasks/work.lane/count2.txt').length,
    status: g('status', '--porcelain').stdout };
}
const span = (gates) => Math.max(...gates.map((g) => g.at + (g.ms || 0))) - Math.min(...gates.map((g) => g.at));
const orderOf = (gates) => JSON.stringify(gates.map((g) => g.gate));

// A: run every CHECK green on a dirty tree, then commit the identical content.
const a = lane('reuse', countBrief, ['write:page1.html=<p>thing 1</p>\n+run:all+commit:1']);
check('A lane ends DONE', a.code === 0 && a.st?.result === 'done', `${a.code} ${a.st?.result} ${a.st?.reason || ''}`);
const aWc = a.st?.workerChecks || [];
check('A the worker run records a content fingerprint for every line', aWc.length >= 2 && aWc.every((x) => typeof x.fp === 'string' && x.fp),
  JSON.stringify(aWc.map((x) => [x.n, x.code, x.clean, !!x.fp])).slice(0, 300));
check('A the gate reused the green runs across the commit (reused: true, checks ran once)',
  a.gates.length === 2 && a.gates.every((x) => x.ok && x.reused === true) && a.count1 === 1 && a.count2 === 1,
  `count1 ${a.count1} count2 ${a.count2} gates ${JSON.stringify(a.gates.map((x) => [x.gate.slice(0, 24), x.ok, x.reused]))}`);

// B: a later commit changes the content, so the reuse is disabled.
const b = lane('mutate', countBrief, ['commit:1+run:all+commit:2']);
check('B a commit that changes content: the gate runs the checks again (no reuse)',
  b.code === 0 && b.count1 === 2 && b.count2 === 2 && !b.gates.some((x) => x.reused),
  `${b.code} count1 ${b.count1} count2 ${b.count2} reused ${b.gates.filter((x) => x.reused).length}`);

// C: default is sequential.
const c = lane('seq', slowBrief, ['commit:1']);
check('C default: the CHECK lines run one at a time and all pass', c.code === 0 && c.gates.length === 4 && c.gates.every((x) => x.ok && !x.reused), JSON.stringify(c.gates.map((x) => [x.gate.slice(0, 30), x.ok, x.ms])));
check('C default: the gate output keeps CHECK order', orderOf(c.gates) === JSON.stringify(SLOW), orderOf(c.gates).slice(0, 200));
const seqSpan = c.gates.length === 4 ? span(c.gates) : 0;

// D: opt-in parallelism.
const d = lane('par', slowBrief, ['commit:1'], { CHECK_PARALLEL: '4' });
check('D CHECK_PARALLEL: the CHECK lines run together and all pass', d.code === 0 && d.gates.length === 4 && d.gates.every((x) => x.ok), JSON.stringify(d.gates.map((x) => [x.gate.slice(0, 30), x.ok, x.ms])));
check('D parallelism keeps the gate output in CHECK order', orderOf(d.gates) === JSON.stringify(SLOW), orderOf(d.gates).slice(0, 200));
const parSpan = d.gates.length === 4 ? span(d.gates) : 0;
check('D parallelism cuts the gate span by more than half', seqSpan > 1500 && parSpan > 0 && parSpan * 2 < seqSpan, `sequential ${seqSpan}ms parallel ${parSpan}ms`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
