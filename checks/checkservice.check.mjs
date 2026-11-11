// Contract check for the runner's check service (runner/ca.mjs). The CodeArts sandbox blocks the worker's
// loopback network, so checks that start a local server hang or fail in the worker's own shell. The runner
// gives the worker a helper that asks the supervisor (outside the sandbox) to run a CHECK line:
//   node tasks/<task>.lane/check.mjs <N>     run CHECK line N (1-based); `all` runs every line in order and
//                                            stops at the first failure; no argument lists the lines
// It prints the check output (tail) and exits with the check's exit code (2 for a bad N, 124 when the
// runner does not answer). The first build prompt tells the worker about it. Every run is recorded in
// state.workerChecks [{n, cmd, code, ms, head, clean}]. When the worker ran every CHECK line green on the
// final HEAD with a clean tree, the gate reuses those results (state.gates rows carry reused: true)
// instead of running them again; any newer commit makes the gate run them as before.
// End to end against the fake CodeArts server; private registry and settings, no real CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-checksvc-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240' };
delete base.STEP_REVIEW;
// CHECK 1 counts its runs and serves HTTP on loopback; CHECK 2 fails unless page2.html exists.
const C1 = 'node -e "require(\'fs\').appendFileSync(\'tasks/work.lane/count1.txt\',\'x\');const s=require(\'http\').createServer((q,r)=>r.end(\'pong\')).listen(0,\'127.0.0.1\',async()=>{const t=await (await fetch(\'http://127.0.0.1:\'+s.address().port)).text();console.log(\'got \'+t);s.close()})"';
const C2 = 'node -e "require(\'fs\').appendFileSync(\'tasks/work.lane/count2.txt\',\'x\');if(!require(\'fs\').existsSync(\'page2.html\')){console.log(\'boom: page2 missing\');process.exit(3)}console.log(\'page2 ok\')"';
async function lane(name, script) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: ${C1}\nCHECK: ${C2}\n`);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = await run(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: base, timeout: 200000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const jsonl = (f) => read(f).trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, runs: jsonl('fake-checks.log'), prompts: jsonl('fake-prompts.log'),
    count1: read('tasks/work.lane/count1.txt').length, count2: read('tasks/work.lane/count2.txt').length, status: g('status', '--porcelain').stdout };
}

// A: worker runs check 2 too early (fails), lists checks, asks for a bad N, then finishes and runs all green
// B: worker runs all, then commits again: the gate must run the checks itself
const [rA, rB] = await pool(4, [
  () => lane('svc', ['commit:1+run:2+run:+run:9+commit:2+run:all+ok']),
  () => lane('stale', ['commit:1+commit:2+run:all+commit:3+ok']),
]);
const r = rA;
check('lane ends DONE', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result} ${r.st?.reason || ''}`);
check('the helper exists at tasks/work.lane/check.mjs', fs.existsSync(path.join(r.repo, 'tasks', 'work.lane', 'check.mjs')));
check('the first build prompt tells the worker about the helper', /node tasks\/work\.lane\/check\.mjs/.test(r.prompts.find((p) => p.agent !== 'plan')?.text || ''), (r.prompts[0]?.text || '').slice(-400));
const early = r.runs.find((x) => x.arg === '2');
check('run 2 before page2 exists: exit code 3 passes through and the output is printed', early && early.code === 3 && /boom: page2 missing/.test(early.out), JSON.stringify(early));
const list = r.runs.find((x) => x.arg === '');
check('no argument lists the CHECK lines with their numbers (exit 0)', list && list.code === 0 && /1[.):]/.test(list.out) && /count1/.test(list.out) && /count2/.test(list.out), JSON.stringify(list).slice(0, 300));
const bad = r.runs.find((x) => x.arg === '9');
check('a CHECK number that does not exist exits 2 with a message', bad && bad.code === 2 && /no CHECK|1 to 2|out of range/i.test(bad.out), JSON.stringify(bad));
const all = r.runs.find((x) => x.arg === 'all');
check('run all after both commits: exit 0, the loopback check ran outside the sandbox and printed "got pong"', all && all.code === 0 && /got pong/.test(all.out) && /page2 ok/.test(all.out), JSON.stringify(all).slice(0, 300));
const wc = r.st?.workerChecks || [];
check('state.workerChecks records every run with n, cmd, code, ms, head and clean', wc.length >= 4 && wc.every((x) => Number.isFinite(x.n) && typeof x.cmd === 'string' && Number.isFinite(x.code) && Number.isFinite(x.ms) && x.head && typeof x.clean === 'boolean'), JSON.stringify(wc).slice(0, 300));
check('the gate reused the green results on the same HEAD (reused: true, no rerun)', (r.st?.gates || []).filter((x) => x.gate !== 'git clean').every((x) => x.ok && x.reused === true) && r.count1 === 1 && r.count2 === 2,
  `count1 ${r.count1} count2 ${r.count2} gates ${JSON.stringify((r.st?.gates || []).map((x) => [x.gate.slice(0, 20), x.ok, x.reused]))}`);
check('the request and result files leave the work tree clean', !/tasks\/work\.lane/.test(r.status) && !/check/.test(r.status), r.status);

check('a commit after the worker run: lane DONE and the gate ran both checks again (no reuse)', rB.code === 0 && rB.count1 === 2 && rB.count2 === 2 && !(rB.st?.gates || []).some((x) => x.reused),
  `${rB.code} count1 ${rB.count1} count2 ${rB.count2}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
