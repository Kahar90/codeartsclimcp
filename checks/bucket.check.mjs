// Contract check for lane buckets (attention/running/done/ended), the /api/overview call,
// the project key (a worktree lane reports the main repo) and per-model token counters
// (tokensByModel in the status, summary, lane and plan views).
// Fake lanes in a private registry; never starts CodeArts (CA_RESUME_DRY=1, no browser).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-bucket-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_RESUME_DRY: '1', CODEARTS_EXE: path.join(tmp, process.platform === 'win32' ? 'no-codearts.exe' : 'no-codearts') };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const norm = (p) => path.resolve(String(p)).toLowerCase();
// os.tmpdir() may use 8.3 short names while git reports long ones: compare real paths.
const real = (p) => { for (const f of [fs.realpathSync.native, fs.realpathSync]) { try { return norm(f(String(p))); } catch {} } return norm(p); };

// ---------- pure module ----------
let C = null;
try { C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href); } catch (e) { check('runner/controls.mjs loads', false, e.message); }
if (C) {
  const B = (o) => C.laneBucket(o);
  check('done lane buckets done', B({ s: { result: 'done', phase: 'finished' }, alive: false, health: 'done' }).bucket === 'done');
  check('stopped lane buckets ended', B({ s: { result: 'stopped', phase: 'finished' }, alive: false, health: 'stopped' }).bucket === 'ended');
  check('continued lane buckets ended', B({ s: { result: 'continued' }, alive: false, health: 'continued' }).bucket === 'ended');
  check('dropped lane buckets ended', B({ s: { result: 'dropped' }, alive: false, health: 'dropped' }).bucket === 'ended');
  check('paused lane buckets attention with a reason', (() => { const b = B({ s: { result: 'paused', phase: 'finished' }, alive: false, health: 'paused' }); return b.bucket === 'attention' && /paused/i.test(b.reason); })());
  check('failed lane buckets attention with the reason', (() => { const b = B({ s: { result: 'failed', reason: 'gave up after 3 interruptions', phase: 'finished' }, alive: false, health: 'failed' }); return b.bucket === 'attention' && /gave up/.test(b.reason); })());
  check('credential failure says so', /auth|credential/i.test(B({ s: { result: 'failed', exitCode: 3, reason: 'auth', phase: 'finished' }, alive: false, health: 'failed' }).reason));
  check('needs review buckets attention', B({ s: { result: 'needs review', phase: 'finished' }, alive: false, health: 'needs review' }).bucket === 'attention');
  check('DEAD lane buckets attention: supervisor died', (() => { const b = B({ s: { phase: 'build' }, alive: false, health: 'DEAD (ca stop cleans up)' }); return b.bucket === 'attention' && /died/i.test(b.reason); })());
  check('STALLED lane buckets attention', (() => { const b = B({ s: { phase: 'build', busy: true, lastEventAt: Date.now() - 360000 }, alive: true, health: 'STALLED' }); return b.bucket === 'attention' && /stalled/i.test(b.reason); })());
  check('thinking lane buckets attention', B({ s: { phase: 'build', busy: true }, alive: true, health: 'thinking (12m, no tool call)' }).bucket === 'attention');
  check('running tool lane buckets running', B({ s: { phase: 'build', busy: true, activity: 'tool bash: ls' }, alive: true, health: 'running tool' }).bucket === 'running');
  check('quiet lane buckets running with minutes', (() => { const b = B({ s: { phase: 'review', busy: true, lastEventAt: Date.now() - 120000 }, alive: true, health: 'quiet' }); return b.bucket === 'running' && /quiet \d+m/.test(b.reason); })());
  check('backoff lane buckets running', B({ s: { phase: 'backoff' }, alive: true, health: 'running' }).bucket === 'running');
  check('gate lane buckets running', B({ s: { phase: 'gate' }, alive: true, health: 'running' }).bucket === 'running');
}

// ---------- fake lanes, one in a git worktree ----------
const main = path.join(tmp, 'main-repo'); fs.mkdirSync(path.join(main, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: main });
spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
const wt = path.join(tmp, 'main-repo-wt-demo');
const wtr = spawnSync('git', ['worktree', 'add', wt, '-b', 'wt-branch'], { cwd: main, encoding: 'utf8' });
check('git worktree add works', wtr.status === 0, (wtr.stderr || '').slice(0, 160));
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' }); // a live "supervisor" pid
const fake = (repo, task, st) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n');
  const t = Date.now() - 600000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: `${path.basename(repo)}--${task}`, task, repo, dir, pid: 999999, startedAt: t, lastEventAt: Date.now(), phase: 'build', busy: true, result: null,
    commits: 0, steps: 1, stepList: [{ n: 1, text: 'a' }], commitLog: [], gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'x', models: {}, config: {}, ...st }));
  fs.writeFileSync(path.join(reg, `${path.basename(repo)}--${task}.json`), JSON.stringify({ id: `${path.basename(repo)}--${task}`, dir, repo, task }));
  return dir;
};
const fin = { phase: 'finished', busy: false };
const mt = (i, o, r = 0, c = 0, st = 1) => ({ input: i, output: o, reasoning: r, cacheRead: c, steps: st });
fake(wt, 'demo', { pid: sleeper.pid, tokensByModel: { 'maas/glm-5.3': mt(900, 150, 40, 4000, 3), 'huaweicloud-maas/GLM-5.1': mt(100, 50, 0, 0, 1) } }); // running, in the worktree
fake(main, 'paused', { ...fin, finishedAt: Date.now() - 60000, result: 'paused', reason: 'timeout', exitCode: 5, tokensByModel: { 'maas/glm-5.3': mt(500, 100, 0, 0, 1) } });
fake(main, 'stopped', { ...fin, finishedAt: Date.now() - 60000, result: 'stopped' });
fake(main, 'old', { ...fin, finishedAt: Date.now() - 4 * 24 * 3600e3, result: 'done', verdict: 'ready', exitCode: 0 }); // over 3 days: overview skips it

// ---------- per-model tokens (CLI, no dashboard needed) ----------
const ca = (a) => { const x = spawnSync(process.execPath, [CA, ...a], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: x.status, out: x.stdout || '', err: x.stderr || '' }; };
let r = ca(['status', '--json']); let st = []; try { st = JSON.parse(r.out); } catch {}
const row = (t) => st.find((x) => x.task === t) || {};
check('status --json has tokensByModel with a total per model', row('demo').tokensByModel?.['maas/glm-5.3']?.total === 5090 && row('demo').tokensByModel?.['huaweicloud-maas/GLM-5.1']?.total === 150, JSON.stringify(row('demo').tokensByModel));
r = ca(['summary', 'main-repo--paused', '--json']); let sm = {}; try { sm = JSON.parse(r.out); } catch {}
check('summary --json has tokensByModel', sm.tokensByModel?.['maas/glm-5.3']?.total === 600, JSON.stringify(sm.tokensByModel));
check('the lane summary line breaks tokens down by model', /by model: \$\{/.test(runnerSource()));
const plan = path.join(main, 'tasks', 'plan.json');
fs.writeFileSync(plan, JSON.stringify({ title: 'models', lanes: [{ task: 'demo', repo: path.basename(wt) }, { task: 'paused' }], waves: [{ name: 'W1', lanes: ['demo', 'paused'] }] }));
ca(['plan', plan]);

// ---------- dashboard API ----------
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env });
guard({ children: [dash, sleeper] });
const base = `http://127.0.0.1:${port}`;
try {
  let lanes = null; for (let i = 0; i < 40 && !lanes; i++) { await new Promise((x) => setTimeout(x, 250)); try { lanes = await (await fetch(base + '/api/lanes')).json(); } catch {} }
  const L = (t) => (lanes || []).find((x) => x.task === t) || {};
  check('/api/lanes has bucket and bucketWhy', ['demo', 'paused', 'stopped'].every((t) => L(t).bucket && typeof L(t).bucketWhy === 'string'), JSON.stringify(['demo', 'paused', 'stopped'].map((t) => [t, L(t).bucket])));
  check('running lane buckets running', L('demo').bucket === 'running', JSON.stringify(L('demo').bucket));
  check('paused lane buckets attention', L('paused').bucket === 'attention', JSON.stringify(L('paused').bucket));
  check('stopped lane buckets ended', L('stopped').bucket === 'ended', JSON.stringify(L('stopped').bucket));
  check('worktree lane reports the main repo as its project', real(L('demo').project?.key) === real(main) && L('demo').project?.name === 'main-repo', JSON.stringify(L('demo').project));
  check('main repo lane reports itself as its project', real(L('paused').project?.key) === real(main), JSON.stringify(L('paused').project));
  check('/api/lanes carries tokensByModel per lane', L('demo').tokensByModel?.['maas/glm-5.3']?.total === 5090 && L('demo').tokensByModel?.['huaweicloud-maas/GLM-5.1']?.total === 150, JSON.stringify(L('demo').tokensByModel));
  const plans = await (await fetch(base + '/api/plans')).json(); const mp = plans.find((x) => x.title === 'models') || {};
  check('/api/plans sums tokensByModel over its lanes', mp.tokensByModel?.['maas/glm-5.3']?.total === 5690 && mp.tokensByModel?.['huaweicloud-maas/GLM-5.1']?.total === 150, JSON.stringify(mp.tokensByModel));
  let ov = null; try { ov = await (await fetch(base + '/api/overview')).json(); } catch {}
  check('/api/overview counts the buckets', ov && ov.counts && ov.counts.attention === 1 && ov.counts.running === 1 && ov.counts.ended === 1 && ov.counts.done === 0, JSON.stringify(ov?.counts));
  check('/api/overview skips lanes finished over 3 days ago', Array.isArray(ov?.lanes) && ov.lanes.length === 3 && !ov.lanes.some((x) => x.task === 'old'), JSON.stringify((ov?.lanes || []).map((x) => x.task)));
  check('/api/overview lanes carry bucket and project', (ov?.lanes || []).every((x) => x.bucket && x.project?.key), '');
} catch (e) { check('the dashboard API section ran to the end', false, String((e && e.stack) || e)); }

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
await settle({ children: [dash, sleeper], code: bad ? 1 : 0 });
// Kill and await the children first: on Windows a live process still holding a file makes rmSync
// throw EBUSY/EPERM, which is a cleanup nuisance, not a check failure.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
