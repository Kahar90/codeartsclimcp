// Contract check for dashboard poll cost (fake lanes, never starts CodeArts). Both pages poll
// /api/plans and /api/lanes every 2 s, so these must stay cheap as plans and lanes pile up:
// 8 plans x 10 lanes plus 20 loose lanes, median answer time per route under a budget.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const BUDGET = Number(process.env.PERF_BUDGET_MS || 60);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-perf-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(path.join(reg, 'plans'), { recursive: true });
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const T = Date.now() - 3 * 3600e3;
function lane(repo, task, i, running) {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  const s = { pid: running ? process.pid : 999999, startedAt: T + i * 60e3, runStartedAt: T + i * 60e3, lastEventAt: Date.now(), phase: running ? 'build' : 'finished',
    result: running ? null : (i % 3 ? 'done' : 'failed'), finishedAt: running ? null : T + i * 60e3 + 20 * 60e3, exitCode: running ? null : 0, commits: 1, steps: 2,
    stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }], tokens: { input: 1000, output: 100 },
    phases: [{ phase: 'starting', at: T + i * 60e3 }, { phase: 'build', at: T + i * 60e3 + 30e3 }], gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'x', models: {} };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
  const id = `${path.basename(repo)}--${task}`;
  fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo, task }));
}
let n = 0;
for (let p = 0; p < 8; p++) {
  const repo = path.join(tmp, `proj${p}`); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  const tasks = Array.from({ length: 10 }, (_, k) => `t${k}`);
  tasks.forEach((t, k) => lane(repo, t, n++, p < 2 && k === 0));
  const file = path.join(repo, 'tasks', 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ title: `Plan ${p}`, status: p < 4 ? 'running' : 'done', startedAt: new Date(T).toISOString(),
    waves: [{ name: 'W', lanes: tasks }], lanes: tasks.map((task) => ({ task })), decisions: [{ at: new Date(T).toISOString(), text: 'd' }] }));
  fs.writeFileSync(path.join(reg, 'plans', `proj${p}.json`), JSON.stringify({ id: `proj${p}`, file }));
}
const loose = path.join(tmp, 'loose'); fs.mkdirSync(path.join(loose, 'tasks'), { recursive: true });
for (let k = 0; k < 20; k++) lane(loose, `l${k}`, n++, false);

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' } });
try {
  let up = false; for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); try { up = (await fetch(`http://127.0.0.1:${port}/api/lanes`)).ok; } catch {} }
  check('dash starts on the 100-lane fixture', up);
  const plans = await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json();
  const lanes = await (await fetch(`http://127.0.0.1:${port}/api/lanes`)).json();
  check('fixture is complete: 8 plans, 100 lanes', plans.length === 8 && lanes.length === 100, `${plans.length} plans, ${lanes.length} lanes`);
  check('two plans have a running lane', plans.filter((p) => p.counts && p.counts.running === 1).length === 2);
  for (const r of ['/api/plans', '/api/lanes', '/api/overview']) {
    const ms = [];
    for (let i = 0; i < 9; i++) { const t0 = performance.now(); await (await fetch(`http://127.0.0.1:${port}${r}`)).text(); ms.push(performance.now() - t0); }
    const med = ms.sort((a, b) => a - b)[4];
    check(`${r} median under ${BUDGET} ms`, med < BUDGET, `${Math.round(med)} ms`);
  }
  // A lane that changes must show up on the next poll (no stale cache).
  const st = path.join(tmp, 'proj0', 'tasks', 't0.lane', 'state.json');
  const s = JSON.parse(fs.readFileSync(st, 'utf8')); s.activity = 'changed by the check'; s.lastEventAt = Date.now() + 1000;
  fs.writeFileSync(st, JSON.stringify(s)); const f = new Date(Date.now() + 2000); fs.utimesSync(st, f, f);
  const again = await (await fetch(`http://127.0.0.1:${port}/api/lanes`)).json();
  check('a changed state.json is seen on the next poll', again.some((l) => l.id === 'proj0--t0' && /changed by the check/.test(JSON.stringify(l))));
  const pf = path.join(tmp, 'proj1', 'tasks', 'plan.json'); const pj = JSON.parse(fs.readFileSync(pf, 'utf8')); pj.title = 'Renamed plan';
  fs.writeFileSync(pf, JSON.stringify(pj)); fs.utimesSync(pf, f, f);
  const p2 = await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json();
  check('a changed plan.json is seen on the next poll', p2.some((p) => p.title === 'Renamed plan'));
} finally { try { dash.kill(); } catch {} }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
