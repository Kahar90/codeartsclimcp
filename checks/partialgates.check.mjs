import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

function lane(name, script, lines) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(root, 'checks/lib/fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `Goal: one page.\n1. Write page1.html. Commit.\n` + lines.map((c) => `CHECK: ${c}`).join('\n') + '\n');
  const g = (...args) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'fixture');
  const r = spawnSync(process.execPath, [path.join(root, 'runner/ca.mjs'), 'lane', repo, 'work'], {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 90000,
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
  let r = lane('fresh', ['commit:1+run:1'], [counter(1), counter(2)]);
  check('S1 lane DONE', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result}`);
  check('S1 fresh first check is not rerun merely because check 2 has no cached result', r.runs(1) === 1 && r.runs(2) === 1, `count1 ${r.runs(1)} count2 ${r.runs(2)}`);
  check('S1 the fresh check is reused and the missing check ran', r.gates.length === 2 && r.gates[0].reused === true && r.gates[0].ok && !r.gates[1].reused && r.gates[1].ok,
    JSON.stringify(r.gates.map((x) => [!!x.reused, x.ok])));

  // S2: the worker ran check 1, then committed again, then ran check 2. The later commit left check 1's
  // fingerprint stale so it reruns, while check 2 stays fresh and is reused.
  r = lane('stale', ['commit:1+run:1+commit:2+run:2+ok'], [counter(1), counter(2)]);
  check('S2 lane DONE', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result}`);
  check('S2 the line a later commit made stale is rerun while the fresh line is reused', r.runs(1) === 2 && r.runs(2) === 1, `count1 ${r.runs(1)} count2 ${r.runs(2)}`);
  check('S2 the stale line is not marked reused and the fresh line is', r.gates.length === 2 && !r.gates[0].reused && r.gates[0].ok && r.gates[1].reused === true && r.gates[1].ok,
    JSON.stringify(r.gates.map((x) => [!!x.reused, x.ok])));

  // S3: the worker's own run of check 1 failed. A failing run is never reused, so the gate reruns it and
  // it now passes.
  r = lane('failed', ['commit:1+run:1'], [failOnce, counter(2)]);
  check('S3 lane DONE after the rerun passes', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result}`);
  check('S3 a failing worker run is never reused (it is rerun and now passes)', r.workerChecks.some((x) => x.n === 1 && x.code === 3) && r.runs(1) === 2 && r.gates[0].ok === true && !r.gates[0].reused,
    `wc ${JSON.stringify(r.workerChecks.map((x) => [x.n, x.code]))} count1 ${r.runs(1)} gates ${JSON.stringify(r.gates.map((x) => [!!x.reused, x.ok]))}`);

  // S4: check 1 has no cached result and, when it runs, mutates the content under test. The cached check 2
  // was fingerprinted before that change, so it must not be reused. A fix turn commits the new file,
  // then the final gate rechecks the resulting clean tree.
  r = lane('mutate', ['commit:1+run:2+ok'], [mutate, counter(2)]);
  check('S4 lane DONE', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.st?.result}`);
  check('S4 a mutation invalidates the later cached line and the committed result is rechecked', r.runs(1) === 2 && r.runs(2) === 3 && !r.gates[1].reused && r.gates[1].ok,
    `count1 ${r.runs(1)} count2 ${r.runs(2)} gates ${JSON.stringify(r.gates.map((x) => [!!x.reused, x.ok]))}`);
  check('S4 completion leaves the working tree clean', !r.status.trim(), r.status);

  // S5: check 1 runs first and fails; the sequential gate stops. Check 2 (cached green) must not be
  // accepted as reused and check 3 (never cached) must not run: neither may appear as a gate row.
  r = lane('stop', ['commit:1+run:2+ok', 'ok'], [alwaysFail, counter(2), counter(3)]);
  const c2 = counter(2), c3 = counter(3);
  const later = r.gates.filter((g) => g.gate === c2 || g.gate === c3);
  const anyReused = r.gates.some((g) => g.reused === true);
  check('S5 lane fails (the first check never passes)', r.code !== 0, `${r.code} ${r.st?.result}`);
  check('S5 the later cached and uncached lines are neither accepted nor executed after the first failure', r.runs(2) === 1 && r.runs(3) === 0 && later.length === 0 && !anyReused,
    `count2 ${r.runs(2)} count3 ${r.runs(3)} laterRows ${later.length} reused ${anyReused} gates ${JSON.stringify(r.gates.map((g) => ['..' + g.gate.slice(-8), !!g.reused, g.ok]))}`);
} finally {
  for (const l of results) console.log(l);
  fails = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  const target = path.resolve(tmp), base = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(base)) throw Error('unsafe cleanup path');
  fs.rmSync(target, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
