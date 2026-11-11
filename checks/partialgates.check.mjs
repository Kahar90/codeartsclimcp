import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-partial-')));
const reg = path.join(tmp, 'registry');
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, '{"security":{"trustedFolders":[]}}');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
// A CHECK line that counts its own runs by appending to a per-line file under the lane dir (which the
// runner keeps out of git, so writing it never changes the content fingerprint).
const counter = (n) => `node -e "require('fs').appendFileSync('tasks/work.lane/count${n}.txt','x')"`;
// Fails the first time it runs and passes afterwards: a failed worker run whose marker also lives in the
// ignored lane dir, so the retry passes without the marker changing the fingerprint.
const failOnce = `node -e "const fs=require('fs');fs.appendFileSync('tasks/work.lane/count1.txt','x');if(!fs.existsSync('tasks/work.lane/once.txt')){fs.writeFileSync('tasks/work.lane/once.txt','1');console.log('first run fails');process.exit(3)}console.log('ok now')"`;
// Writes an untracked, non-ignored file: a check that mutates the content under test.
const mutate = `node -e "const fs=require('fs');fs.appendFileSync('tasks/work.lane/count1.txt','x');fs.writeFileSync('mutated.txt','m')"`;
// Always fails, without touching the tree.
const alwaysFail = `node -e "require('fs').appendFileSync('tasks/work.lane/count1.txt','x');console.log('boom');process.exit(3)"`;

async function lane(name, script, lines) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(root, 'checks/lib/fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `Goal: one page.\n1. Write page1.html. Commit.\n` + lines.map((c) => `CHECK: ${c}`).join('\n') + '\n');
  const g = (...args) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'fixture');
  const r = await run(process.execPath, [path.join(root, 'runner/ca.mjs'), 'lane', repo, 'work'], {
    cwd: repo, timeout: 90000,
    env: { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath, NO_REVIEW: '1', MAX_FIXES: '1', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '200', CODEARTS_CLI_AK: 'fake', CODEARTS_CLI_SK: 'fake' },
  });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  const gateRows = (st?.gates || []).filter((x) => x.gate !== 'git clean');
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, gates: gateRows, workerChecks: st?.workerChecks || [],
    runs: (n) => read(`tasks/work.lane/count${n}.txt`).length, status: g('status', '--porcelain').stdout };
}

let fails = 0;
try {
  // S1: check 1 already passed on the current content, check 2 has no cached result. Check 1 is reused;
  // only the missing check 2 runs. (The lead's regression: all-or-nothing reuse reran both.)
  // S2: the worker ran check 1, then committed again, then ran check 2. The later commit left check 1's
  // fingerprint stale so it reruns, while check 2 stays fresh and is reused.
  // S3: the worker's own run of check 1 failed. A failing run is never reused, so the gate reruns it and
  // it now passes.
  // S4: check 1 has no cached result and, when it runs, mutates the content under test. The cached check 2
  // was fingerprinted before that change, so it must not be reused. A fix turn commits the new file,
  // then the final gate rechecks the resulting clean tree.
  // S5: check 1 runs first and fails; the sequential gate stops. Check 2 (cached green) must not be
  // accepted as reused and check 3 (never cached) must not run: neither may appear as a gate row.
  const [r1, r2, r3, r4, r5] = await pool(4, [
    () => lane('fresh', ['commit:1+run:1'], [counter(1), counter(2)]),
    () => lane('stale', ['commit:1+run:1+commit:2+run:2+ok'], [counter(1), counter(2)]),
    () => lane('failed', ['commit:1+run:1'], [failOnce, counter(2)]),
    () => lane('mutate', ['commit:1+run:2+ok'], [mutate, counter(2)]),
    () => lane('stop', ['commit:1+run:2+ok', 'ok'], [alwaysFail, counter(2), counter(3)]),
  ]);
  const r = r1;
  check('S1 lane DONE', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result}`);
  check('S1 fresh first check is not rerun merely because check 2 has no cached result', r.runs(1) === 1 && r.runs(2) === 1, `count1 ${r.runs(1)} count2 ${r.runs(2)}`);
  check('S1 the fresh check is reused and the missing check ran', r.gates.length === 2 && r.gates[0].reused === true && r.gates[0].ok && !r.gates[1].reused && r.gates[1].ok,
    JSON.stringify(r.gates.map((x) => [!!x.reused, x.ok])));

  check('S2 lane DONE', r2.code === 0 && r2.st?.result === 'done', `${r2.code} ${r2.st?.result}`);
  check('S2 the line a later commit made stale is rerun while the fresh line is reused', r2.runs(1) === 2 && r2.runs(2) === 1, `count1 ${r2.runs(1)} count2 ${r2.runs(2)}`);
  check('S2 the stale line is not marked reused and the fresh line is', r2.gates.length === 2 && !r2.gates[0].reused && r2.gates[0].ok && r2.gates[1].reused === true && r2.gates[1].ok,
    JSON.stringify(r2.gates.map((x) => [!!x.reused, x.ok])));

  check('S3 lane DONE after the rerun passes', r3.code === 0 && r3.st?.result === 'done', `${r3.code} ${r3.st?.result}`);
  check('S3 a failing worker run is never reused (it is rerun and now passes)', r3.workerChecks.some((x) => x.n === 1 && x.code === 3) && r3.runs(1) === 2 && r3.gates[0].ok === true && !r3.gates[0].reused,
    `wc ${JSON.stringify(r3.workerChecks.map((x) => [x.n, x.code]))} count1 ${r3.runs(1)} gates ${JSON.stringify(r3.gates.map((x) => [!!x.reused, x.ok]))}`);

  check('S4 lane DONE', r4.code === 0 && r4.st?.result === 'done', `${r4.code} ${r4.st?.result}`);
  check('S4 a mutation invalidates the later cached line and the committed result is rechecked', r4.runs(1) === 2 && r4.runs(2) === 3 && !r4.gates[1].reused && r4.gates[1].ok,
    `count1 ${r4.runs(1)} count2 ${r4.runs(2)} gates ${JSON.stringify(r4.gates.map((x) => [!!x.reused, x.ok]))}`);
  check('S4 completion leaves the working tree clean', !r4.status.trim(), r4.status);

  const c2 = counter(2), c3 = counter(3);
  const later = r5.gates.filter((g) => g.gate === c2 || g.gate === c3);
  const anyReused = r5.gates.some((g) => g.reused === true);
  check('S5 lane fails (the first check never passes)', r5.code !== 0, `${r5.code} ${r5.st?.result}`);
  check('S5 the later cached and uncached lines are neither accepted nor executed after the first failure', r5.runs(2) === 1 && r5.runs(3) === 0 && later.length === 0 && !anyReused,
    `count2 ${r5.runs(2)} count3 ${r5.runs(3)} laterRows ${later.length} reused ${anyReused} gates ${JSON.stringify(r5.gates.map((g) => ['..' + g.gate.slice(-8), !!g.reused, g.ok]))}`);
} finally {
  for (const l of results) console.log(l);
  fails = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  const target = path.resolve(tmp), base = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(base)) throw Error('unsafe cleanup path');
  fs.rmSync(target, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
