// Contract check for paused lanes, `ca lane --resume` and plan "continues" (fake lanes, never starts CodeArts).
// A lane that hits LANE_TIMEOUT is paused (exit 5), not failed; old "failed (timeout)" states read as paused;
// a plan lane with "continues": "<task>" shows the older lane as continued.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-resume-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);

const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const fake = (task, result, reason) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  const t = Date.now() - 600000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t, finishedAt: t + 300000, lastEventAt: t + 300000, phase: 'finished', result, reason, exitCode: 1,
    commits: 1, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: result, models: {} }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
fake('legacy', 'failed', 'timeout'); fake('paused', 'paused', 'timeout'); fake('broken', 'failed', 'gates still failing'); fake('first', 'failed', 'timeout'); fake('donelane', 'done', '');

const st = JSON.parse(ca(['status', '--json']).out || '[]');
const row = (t) => st.find((x) => x.task === t) || {};
check('legacy failed (timeout) reads as paused', row('legacy').health === 'paused', row('legacy').health);
check('paused lane health is paused', row('paused').health === 'paused');
check('a real failure stays failed', row('broken').health === 'failed');
let r = ca(['wait', 'demo-repo--paused', '--quiet']); check('ca wait on a paused lane exits 5', r.code === 5, `exit ${r.code}`);
r = ca(['wait', 'demo-repo--broken', 'demo-repo--paused', '--quiet']); check('failed outranks paused in ca wait', r.code === 1, `exit ${r.code}`);
r = ca(['help']); check('help documents --resume and exit 5', /--resume/.test(r.out) && /5 paused/.test(r.out));
r = ca(['lane', repo, 'donelane', '--resume']); check('--resume refuses a done lane', r.code === 2 && /nothing to resume/.test(r.err + r.out), (r.err + r.out).slice(0, 160));
const src = runnerSource();
check('timeout ends as paused in the runner', /reason === 'timeout' \? 'paused'/.test(src));
check('resume keeps the base commit', /resumed && resumed\.start/.test(src));

// plan "continues": the older lane reads as continued and its wave is not "attention"
fs.writeFileSync(path.join(repo, 'tasks', 'second.md'), '1. a. Commit.\n');
const plan = path.join(repo, 'tasks', 'plan.json');
fs.writeFileSync(plan, JSON.stringify({ title: 'p', lanes: [{ task: 'first' }, { task: 'second', continues: 'first' }], waves: [{ name: 'W1', lanes: ['first'] }, { name: 'W2', lanes: ['second'] }] }));
ca(['plan', plan]);
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env });
guard({ children: [dash] });
try {
  let plans = null; for (let i = 0; i < 40 && !plans; i++) { await new Promise((x) => setTimeout(x, 250)); try { plans = await (await fetch(`http://127.0.0.1:${port}/api/plans`)).json(); } catch {} }
  const p = (plans || []).find((x) => x.title === 'p');
  const tasks = p ? p.waves.flatMap((w) => w.lanes.map((l) => l.task)) : [];
  const second = p && p.waves.flatMap((w) => w.lanes).find((l) => l.task === 'second');
  check('continued lane is folded into its successor (one station)', p && !tasks.includes('first') && tasks.includes('second'), JSON.stringify(tasks));
  check('a wave whose lanes all continued is dropped', p && p.waves.length === 1 && p.waves[0].name === 'W2', p && p.waves.map((w) => w.name).join(','));
  check('successor carries the earlier run', second && second.continues && second.continues[0].task === 'first' && second.runs === 2, JSON.stringify(second && { c: second.continues, runs: second.runs }));
} finally { await settle({ children: [dash], code: 0 }); }

// shared UI labels
const ctx = { window: {}, document: { addEventListener() {}, hidden: false }, localStorage: { getItem() { return null; }, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }), performance, requestAnimationFrame: () => 0, fetch: () => Promise.reject(new Error('x')), Image: function () {} };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(ROOT, 'runner', 'assets', 'workshop.js'), 'utf8'), ctx);
const S = (h) => ctx.window.CAUI.status(h);
check('CAUI: paused is amber Paused', S('paused').key === 'warn' && S('paused').label === 'Paused');
check('CAUI: continued is neutral Continued', S('continued').key === 'idle' && S('continued').label === 'Continued');

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
process.exitCode = bad ? 1 : 0;
