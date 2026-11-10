// Contract check for plan state (fake lanes, never starts CodeArts): the plan badge comes from real lane state,
// not only the hand-written status; `ca plan close` drops never-started lanes; `ca plan rm` unregisters.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-planstate-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

const repo = path.join(tmp, 'sbx'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
const t = Date.now() - 3 * 3600e3;
const dir = path.join(repo, 'tasks', 'lib.lane'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, 'tasks', 'lib.md'), '1. a. Commit.\n2. b. Commit.\n');
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t, finishedAt: t + 60000, lastEventAt: t + 60000, phase: 'finished', result: 'done', exitCode: 0,
  commits: 2, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }, { hash: 'abc1235', subject: 'step 2: b' }],
  tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'done', models: {} }));
fs.writeFileSync(path.join(reg, 'sbx--lib.json'), JSON.stringify({ id: 'sbx--lib', dir, repo, task: 'lib' }));
const planFile = path.join(repo, 'tasks', 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({ title: 'Sandbox plan', status: 'running', waves: [{ name: 'W1', lanes: ['lib'] }, { name: 'W2', lanes: ['cli'] }], lanes: [{ task: 'lib' }, { task: 'cli' }] }));
const old = new Date(t + 60000); fs.utimesSync(planFile, old, old);

check('ca plan registers', ca(['plan', planFile]).code === 0);
let o = ca(['plan', 'list']).out;
check('stale "running" with no running lane reads as waiting', /sbx\s+waiting\s/.test(o), o.trim());
check('summary counts done, not started and idle time', /1\/2 lanes done · 1 not started · idle 3h/.test(o), o.trim());
const beforeLead = fs.readFileSync(planFile, 'utf8');
for (const phase of ['planning', 'building', 'waiting', 'verifying', 'asking']) {
  fs.writeFileSync(planFile, JSON.stringify({ ...JSON.parse(beforeLead), lead: 'Codex', phase, now: 'Checking the result', nowAt: new Date().toISOString(),
    waves: [{ name: 'W1', lanes: ['lib'] }], lanes: [{ task: 'lib' }] }));
  const view = JSON.parse(ca(['plan', 'list', '--json']).out)[0];
  check(`finished workers do not close a plan while the lead is ${phase}`, !view.closed && view.glance.state === (phase === 'asking' ? 'needs-you' : 'working'), JSON.stringify({ state: view.state, closed: view.closed, glance: view.glance }));
  check(`the ${phase} detail uses the actual lead name`, view.glance.detail.includes('Codex'), view.glance.detail);
}
fs.writeFileSync(planFile, beforeLead); fs.utimesSync(planFile, old, old);

o = ca(['plan', 'close', 'sbx', '--reason', 'demo placeholder']); check('ca plan close exits 0', o.code === 0, o.out + o.err);
const p = JSON.parse(fs.readFileSync(planFile, 'utf8'));
check('close sets status done and drops the unstarted lane', p.status === 'done' && p.lanes.find((l) => l.task === 'cli').dropped === true && !p.lanes.find((l) => l.task === 'lib').dropped, JSON.stringify(p.lanes));
check('close logs a decision with the reason', /Plan closed: demo placeholder\. Dropped, never started: cli/.test(p.decisions.at(-1).text), p.decisions.at(-1).text);
o = ca(['plan', 'list']).out;
check('closed plan with only dropped work left reads as done', /sbx\s+done\s/.test(o) && /1\/1 lanes done · 1 dropped/.test(o), o.trim());
o = ca(['plan', 'rm', 'sbx']); check('ca plan rm unregisters', o.code === 0 && !fs.existsSync(path.join(reg, 'plans', 'sbx.json')) && fs.existsSync(planFile), o.out);
check('unknown plan close exits 2', ca(['plan', 'close', 'nope']).code === 2);

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} failed` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
