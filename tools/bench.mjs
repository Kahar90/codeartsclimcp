#!/usr/bin/env node
// tools/bench.mjs: time the lead's real loop on a fixed task, so speed claims are measured, not guessed.
//   node tools/bench.mjs --label <name> [--runs 2] [--ca <path to ca.mjs>] [--fixes 2] [--env K=V ...]
// Copies bench/fixture (a notes API with a loopback contract check and a 4-step brief) into
// D:/Coding/ca-bench/<label>-<i>-<stamp> (or $CA_BENCH_DIR), makes it a git repo and runs `ca lane <dir> notes`
// for every run at once (parallel, like real lanes). Then it does what the lead does: while the lane ends
// without VERDICT ready or the contract check fails, it writes tasks/notes-fix<k>.md with the reviewer's
// findings (or the failing check) and runs that as a new lane, up to --fixes times. A run passes when the
// last lane ends done with VERDICT ready AND the contract check passes when rerun here, outside the lanes.
// The time is the whole loop. Each run appends a row to bench/results.jsonl; the summary prints the median
// time of the passing runs. Lane logs go next to the run folder (<dir>.log), never into the repo.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const label = opt('--label'); if (!label) { console.error('usage: node tools/bench.mjs --label <name> [--runs N] [--ca <ca.mjs>] [--fixes N] [--env K=V ...]'); process.exit(2); }
const runs = Number(opt('--runs', '2'));
const maxFixes = Number(opt('--fixes', '2'));
const caPath = opt('--ca', '');
const extraEnv = Object.fromEntries(argv.flatMap((a, i) => (a === '--env' ? [argv[i + 1]] : [])).map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
const base = process.env.CA_BENCH_DIR || 'D:/Coding/ca-bench';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const win = process.platform === 'win32';
const caCmd = caPath ? [process.execPath, path.resolve(caPath)] : [win ? 'ca.cmd' : 'ca'];
const version = spawnSync(caCmd[0], [...caCmd.slice(1), '--version'], { encoding: 'utf8', shell: win && !caPath }).stdout.trim();
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;

function prepare(i) {
  const dir = path.join(base, `${label}-${i}-${stamp}`);
  fs.cpSync(path.join(ROOT, 'bench', 'fixture'), dir, { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.email=bench@x', '-c', 'user.name=bench', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'bench fixture');
  return dir;
}
const lane = (dir, task) => new Promise((res) => {
  const t0 = Date.now();
  const ch = spawn(caCmd[0], [...caCmd.slice(1), 'lane', dir, task], { cwd: dir, env: { ...process.env, CA_DASH: '0', ...extraEnv }, shell: win && !caPath, windowsHide: true });
  ch.stdout.on('data', (d) => fs.appendFileSync(`${dir}.log`, d)); ch.stderr.on('data', (d) => fs.appendFileSync(`${dir}.log`, d));
  ch.on('close', (code) => {
    let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', `${task}.lane`, 'state.json'), 'utf8')); } catch {}
    let review = ''; try { review = fs.readFileSync(path.join(dir, 'tasks', `${task}.lane`, 'review.md'), 'utf8'); } catch {}
    const ph = st.phases || []; const byPhase = {};
    ph.forEach((p, k) => { const end = ph[k + 1]?.at ?? st.finishedAt ?? Date.now(); byPhase[p.phase] = (byPhase[p.phase] || 0) + (end - p.at); });
    res({ task, exit: code, ms: Date.now() - t0, result: st.result, verdict: st.verdict, fixes: st.fixes ?? null, byPhase, review,
      stepReviews: (st.stepReviews || []).length, workerChecks: (st.workerChecks || []).length, reusedGate: (st.gates || []).some((x) => x.reused),
      tokens: st.tokens ? st.tokens.input + st.tokens.output + st.tokens.cacheRead : 0 });
  });
});
const contract = (dir) => spawnSync(process.execPath, ['checks/api.check.mjs'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
function fixBrief(dir, k, prev, ck) {
  const bugs = (prev.review.split(/\r?\n/).filter((l) => l.trim() && !/^\s*VERDICT:/i.test(l)).join('\n') || '(no review text)').slice(0, 4000);
  const failing = ck.status === 0 ? '' : `\nThe contract check fails:\n\`\`\`\n${(ck.stdout + ck.stderr).split(/\r?\n/).filter((l) => /FAIL|Error|passed/.test(l)).slice(0, 30).join('\n')}\n\`\`\`\n`;
  fs.writeFileSync(path.join(dir, 'tasks', `notes-fix${k}.md`), `You are working in a git repo (current directory): a Node notes API in \`server.mjs\`. The spec is tasks/notes.md and the
contract is checks/api.check.mjs (do not edit it). The previous lane ended "${prev.result}" with verdict "${prev.verdict}".
Reviewer findings:
${bugs}
${failing}
1. Fix every real bug above (ignore a finding that contradicts tasks/notes.md). Run the check, then
   \`git add -A && git commit -m "step 1: fix review findings"\`. Do not ask questions.

Safety rules (hard): never kill processes you did not start; never change permissions; if git commit fails, stop and report the error.
CHECK: node checks/api.check.mjs
Constraints: no em dashes. Only touch server.mjs and .gitignore.
`);
}
async function runOne(i) {
  const dir = prepare(i); const t0 = Date.now(); const lanes = [];
  let l = await lane(dir, 'notes'); lanes.push(l); let ck = contract(dir);
  for (let k = 1; k <= maxFixes && !(l.result === 'done' && l.verdict === 'ready' && ck.status === 0); k++) {
    fixBrief(dir, k, l, ck); spawnSync('git', ['-C', dir, '-c', 'user.email=bench@x', '-c', 'user.name=bench', 'commit', '-qm', `lead: fix brief ${k}`, '--', `tasks/notes-fix${k}.md`]);
    l = await lane(dir, `notes-fix${k}`); lanes.push(l); ck = contract(dir);
  }
  const wall = Date.now() - t0;
  const row = { at: new Date().toISOString(), label, version, env: extraEnv, run: i, dir, wallMs: wall, lanes: lanes.map(({ review, ...x }) => x),
    fixLanes: lanes.length - 1, checkOk: ck.status === 0, pass: l.result === 'done' && l.verdict === 'ready' && ck.status === 0, tokens: lanes.reduce((a, x) => a + x.tokens, 0) };
  fs.appendFileSync(path.join(ROOT, 'bench', 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(`run ${i}: ${row.pass ? 'PASS' : 'FAIL'} ${mins(wall)} lanes ${lanes.map((x) => `${x.task} ${mins(x.ms)} ${x.result}/${x.verdict || '-'}`).join(' -> ')} check ${row.checkOk ? 'ok' : 'FAIL'} tokens ${(row.tokens / 1e6).toFixed(1)}M`);
  return row;
}
fs.mkdirSync(base, { recursive: true });
console.log(`bench ${label}: ${runs} parallel run(s) with ca ${version || '(unknown)'}${Object.keys(extraEnv).length ? ' env ' + JSON.stringify(extraEnv) : ''}`);
const rows = await Promise.all(Array.from({ length: runs }, (_, i) => runOne(i + 1)));
const ok = rows.filter((r) => r.pass);
console.log(`bench ${label}: ${ok.length}/${rows.length} passed; median ${ok.length ? mins(median(ok.map((r) => r.wallMs))) : 'n/a'} (all runs: ${rows.map((r) => mins(r.wallMs)).join(', ')})`);
process.exit(ok.length === rows.length ? 0 : 1);
