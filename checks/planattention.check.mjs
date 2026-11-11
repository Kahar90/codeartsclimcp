// Contract check for plan attention (fake registry and lanes, never starts CodeArts): the plan state,
// the wave status and the glance all read the lane's own status.attention (status contract part 1),
// never their own list of result words. A lead-stopped lane or an acked lane does not make the plan
// Needs you; a needs review lane, a stalled lane or a worker question does. One shared rule keeps the
// wave status and the plan state in step. The Office lead badges show plan.badge (part 2).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-planattention-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

const t = Date.now();
const baseState = { steps: 1, commits: 1, stepList: [{ n: 1, text: 'x' }], commitLog: [{ hash: 'h1', subject: 'step 1: x' }], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], models: {} };
// A scenario repo: plan.json plus the named lanes (a state.json and a registry entry each), registered
// through the CLI. A task in plan.lanes with no lane folder reads as "planned".
function scenario(name, body, lanes = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  for (const [task, st] of Object.entries(lanes)) {
    const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...baseState, ...st }));
    fs.writeFileSync(path.join(reg, `${name}--${task}.json`), JSON.stringify({ id: `${name}--${task}`, dir, repo, task }));
  }
  const pf = path.join(repo, 'tasks', 'plan.json'); fs.writeFileSync(pf, JSON.stringify(body));
  const r = ca(['plan', pf]);
  if (r.code !== 0) check(`plan ${name} registers`, false, r.out + r.err);
  return name;
}
const list = () => { try { return Object.fromEntries(JSON.parse(ca(['plan', 'list', '--json']).out).map((p) => [p.id, p])); } catch { return {}; } };
const fin = (result, extra = {}) => ({ pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result, exitCode: 0, activity: result, ...extra });

// 1. a lead-stopped lane and a done lane: the lane says not attention, so the plan must not read
//    Needs you or Failed (it stays quiet), even though the old result-word rule called stopped attention.
scenario('stopped_done', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['st', 'ok'] }], lanes: [{ task: 'st' }, { task: 'ok' }] },
  { st: fin('stopped', { activity: 'stopped by the lead' }), ok: fin('done') });
let p = list().stopped_done || {};
check('a lead-stopped lane does not make the plan Needs you', !!p.glance && p.glance.state !== 'needs-you', JSON.stringify(p.glance));
check('a lead-stopped lane does not make the plan Failed', !!p.glance && p.glance.state !== 'failed', JSON.stringify(p.glance));

// 1b. a killed lane is not a failure either: the lane itself says not attention.
scenario('killed_done', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['k', 'ok'] }], lanes: [{ task: 'k' }, { task: 'ok' }] },
  { k: fin('killed', { exitCode: 1, activity: 'killed' }), ok: fin('done') });
p = list().killed_done || {};
check('a killed lane does not make the plan Failed', !!p.glance && p.glance.state !== 'failed', JSON.stringify(p.glance));

// 2. a needs review lane needs a human.
scenario('needs_review', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['rev'] }], lanes: [{ task: 'rev' }] },
  { rev: fin('needs review', { exitCode: 4, activity: 'review says needs fixes' }) });
p = list().needs_review || {};
check('a needs review lane makes the plan Needs you', !!p.glance && p.glance.state === 'needs-you', JSON.stringify(p.glance));
check('a needs review lane sets the plan state to attention', p.state === 'attention', String(p.state));
check('a needs review lane agrees between the wave and the plan', !!p.waves && !!p.waves[0] && p.waves[0].status === p.state, JSON.stringify({ wave: p.waves && p.waves[0] && p.waves[0].status, state: p.state }));

// 3. a lane the lead handled (acks.json) does not need the human.
scenario('handled', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['h'] }], lanes: [{ task: 'h' }] },
  { h: fin('failed', { exitCode: 1, activity: 'failed' }) });
check('ca ack marks the failed lane handled', ca(['ack', 'handled--h']).code === 0);
p = list().handled || {};
check('an acked (handled) lane does not make the plan Needs you', !!p.glance && p.glance.state !== 'needs-you', JSON.stringify(p.glance));

// 4. a running lane whose worker asked the lead a question needs a human now.
scenario('blocked', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['q'] }], lanes: [{ task: 'q' }] },
  { q: { pid: process.pid, startedAt: t - 60e3, lastEventAt: t, phase: 'build', busy: true, activity: 'waiting on the lead', blocker: { kind: 'question', text: 'merge now?' } } });
p = list().blocked || {};
check('a running lane with a blocker question makes the plan Needs you', !!p.glance && p.glance.state === 'needs-you', JSON.stringify(p.glance));

// 5. the wave status and the plan state agree (they share one rule).
scenario('agree_run', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['r', 'r2'] }], lanes: [{ task: 'r' }, { task: 'r2' }] },
  { r: { pid: process.pid, startedAt: t - 60e3, lastEventAt: t, phase: 'build', busy: true, activity: 'building' } });
p = list().agree_run || {};
check('a running lane agrees between the wave and the plan', p.state === 'running' && !!p.waves && !!p.waves[0] && p.waves[0].status === 'running', JSON.stringify({ wave: p.waves && p.waves[0] && p.waves[0].status, state: p.state }));

// ---------- step 2: both lead plan badges in the Office view show plan.badge ----------
const html = fs.readFileSync(path.join(ROOT, 'runner', 'office.html'), 'utf8');
check('the lead station clip shows plan.badge (tone)', /function renderStations[\s\S]*?planBadge && planBadge\.tone/.test(html));
check('the lead window badge shows plan.badge (word)', /function renderWinContent[\s\S]*?planBadge && planBadge\.word/.test(html));

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} failed` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
