#!/usr/bin/env node
// tools/bench.mjs: time a real lane on a fixed task, so speed claims are measured, not guessed.
//   node tools/bench.mjs --label <name> [--runs 2] [--ca <path to ca.mjs> | global `ca`] [--env K=V ...]
// Copies bench/fixture (a small notes API with a loopback contract check and a 3-step brief) into
// D:/Coding/ca-bench/<label>-<i>-<stamp> (or $CA_BENCH_DIR), makes it a git repo and runs
// `ca lane <dir> notes` for every run at once (parallel, like real lanes). A run counts only when
// the lane ends done with VERDICT ready AND the contract check passes when rerun here, outside
// the lane. Each run appends a row to bench/results.jsonl: label, version, wall ms, phase ms,
// fix rounds, tokens, quality. The summary prints the median wall time of the passing runs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const label = opt('--label'); if (!label) { console.error('usage: node tools/bench.mjs --label <name> [--runs N] [--ca <ca.mjs>] [--env K=V ...]'); process.exit(2); }
const runs = Number(opt('--runs', '2'));
const caPath = opt('--ca', '');
const extraEnv = Object.fromEntries(argv.flatMap((a, i) => (a === '--env' ? [argv[i + 1]] : [])).map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
const base = process.env.CA_BENCH_DIR || 'D:/Coding/ca-bench';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const caCmd = caPath ? [process.execPath, path.resolve(caPath)] : [process.platform === 'win32' ? 'ca.cmd' : 'ca'];
const version = spawnSync(caCmd[0], [...caCmd.slice(1), '--version'], { encoding: 'utf8', shell: process.platform === 'win32' && !caPath }).stdout.trim();
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;

function prepare(i) {
  const dir = path.join(base, `${label}-${i}-${stamp}`);
  fs.cpSync(path.join(ROOT, 'bench', 'fixture'), dir, { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.email=bench@x', '-c', 'user.name=bench', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'bench fixture');
  return dir;
}
function runOne(i) {
  const dir = prepare(i); const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(caCmd[0], [...caCmd.slice(1), 'lane', dir, 'notes'], { cwd: dir, env: { ...process.env, CA_DASH: '0', ...extraEnv }, shell: process.platform === 'win32' && !caPath, windowsHide: true });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    fs.writeFileSync(path.join(dir, 'bench.lane.log'), '');
    ch.on('close', (code) => {
      fs.writeFileSync(path.join(dir, 'bench.lane.log'), out);
      const wall = Date.now() - t0;
      let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 'notes.lane', 'state.json'), 'utf8')); } catch {}
      const ck = spawnSync(process.execPath, ['checks/api.check.mjs'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
      const ph = st.phases || []; const byPhase = {};
      ph.forEach((p, k) => { const end = ph[k + 1]?.at ?? st.finishedAt ?? Date.now(); byPhase[p.phase] = (byPhase[p.phase] || 0) + (end - p.at); });
      const row = { at: new Date().toISOString(), label, version, run: i, dir, exit: code, result: st.result, verdict: st.verdict, wallMs: wall,
        byPhase, fixes: st.fixes ?? null, commits: st.commits ?? null, interruptions: (st.interruptions || []).map((x) => x.kind),
        stepReviews: (st.stepReviews || []).length, tokens: st.tokens ? st.tokens.input + st.tokens.output + st.tokens.cacheRead : null,
        checkOk: ck.status === 0, pass: code === 0 && st.result === 'done' && st.verdict === 'ready' && ck.status === 0 };
      fs.appendFileSync(path.join(ROOT, 'bench', 'results.jsonl'), JSON.stringify(row) + '\n');
      console.log(`run ${i}: ${row.pass ? 'PASS' : 'FAIL'} ${mins(wall)} result ${row.result} verdict ${row.verdict} check ${row.checkOk ? 'ok' : 'FAIL'} fixes ${row.fixes} phases ${Object.entries(byPhase).map(([k, v]) => `${k} ${mins(v)}`).join(', ')}`);
      res(row);
    });
  });
}
fs.mkdirSync(base, { recursive: true });
console.log(`bench ${label}: ${runs} parallel run(s) with ca ${version || '(unknown)'}${Object.keys(extraEnv).length ? ' env ' + JSON.stringify(extraEnv) : ''}`);
const rows = await Promise.all(Array.from({ length: runs }, (_, i) => runOne(i + 1)));
const ok = rows.filter((r) => r.pass);
console.log(`bench ${label}: ${ok.length}/${rows.length} passed; median wall ${ok.length ? mins(median(ok.map((r) => r.wallMs))) : 'n/a'}`);
process.exit(ok.length === rows.length ? 0 : 1);
