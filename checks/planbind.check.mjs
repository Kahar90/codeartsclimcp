// Contract check: every lane belongs to a plan, and the Office always shows the plan that is working.
// Runner: `ca lane` adds a lane that is not in the repo's open plan to it, creates and registers a plan when
// there is none (archiving a closed one, which stays listed), finds the main repo for worktree lanes, never
// duplicates a lane the lead already planned, registers a plan the lead forgot to register, and leaves
// CA_NO_PLAN=1 lanes (smoke tests) alone. Office: shows the plan with a running lane, else the newest open
// plan; a new plan or a lane that starts running in another plan switches the view, even over a plan picked
// by hand; it never shows lanes outside the plan. Real lanes against the fake CodeArts server, private registry.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-planbind-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1', CODEARTS_CLI_AK: 'x', CODEARTS_CLI_SK: 'y', STALL_S: '60', THINK_S: '0' };
delete env.CA_NO_PLAN;
const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const ca = (args, extra = {}, cwd = tmp) => spawnSync(process.execPath, [CA, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
const js = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const brief = (repo, task, goal) => { fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true }); fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), `You are working in a git repo (current directory). Goal: ${goal}.\n1. Do it. Commit.\n`); };
function mkrepo(name) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), '["ok"]'); fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-turns.log\n');
  g(repo, 'init', '-q'); g(repo, 'add', '-A'); g(repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}
const planList = () => ca(['plan', 'list']).stdout;
const lanesOf = (p) => (p?.lanes || []).map((l) => l.task);

// ---- 1. no plan: the runner creates and registers one from the brief ----
const repo = mkrepo('app');
brief(repo, 'first', 'add a health endpoint');
let r = ca(['lane', repo, 'first']);
const planFile = path.join(repo, 'tasks', 'plan.json');
let p = js(planFile);
check('a lane started with no plan creates tasks/plan.json in the repo', r.status === 0 && !!p, (r.stdout + r.stderr).slice(-200));
check('the new plan is open, lists the lane in a wave and takes its title from the brief goal', p && p.status !== 'done' && lanesOf(p).includes('first') && (p.waves || []).some((w) => (w.lanes || []).includes('first')) && /health endpoint/i.test(p.title || p.goal || ''), JSON.stringify(p).slice(0, 200));
check('the new plan is registered (ca plan list shows it)', /health endpoint/i.test(planList()), planList().slice(0, 200));
check('the plan says the runner created it', p && (p.decisions || []).some((d) => /runner/i.test(d.text || '')));

// ---- 2. a second lane joins the same open plan ----
brief(repo, 'second', 'add a version endpoint');
r = ca(['lane', repo, 'second']);
p = js(planFile);
check('a second lane is added to the same open plan, not a new one', r.status === 0 && lanesOf(p).includes('first') && lanesOf(p).includes('second') && planList().trim().split('\n').filter((l) => /\S/.test(l)).length === 1, JSON.stringify(lanesOf(p)) + ' | ' + planList());

// ---- 3. a worktree lane attaches to the main repo's plan with a relative repo path ----
const wt = path.join(tmp, 'app-wt-third'); g(repo, 'worktree', 'add', '-q', wt, '-b', 'lane/third');
brief(wt, 'third', 'add a metrics endpoint');
r = ca(['lane', wt, 'third']);
p = js(planFile);
const third = (p?.lanes || []).find((l) => l.task === 'third');
check('a worktree lane is added to the main repo plan with its relative repo path', r.status === 0 && third && String(third.repo).replace(/\\/g, '/') === '../app-wt-third', JSON.stringify(third));
check('no plan file was created inside the worktree', !fs.existsSync(path.join(wt, 'tasks', 'plan.json')));

// ---- 4. a lane the lead already planned is not duplicated; an unregistered plan gets registered ----
const repo2 = mkrepo('lead');
fs.writeFileSync(path.join(repo2, 'tasks', 'plan.json'), JSON.stringify({ title: 'Lead written plan', status: 'running', waves: [{ name: 'W1', lanes: ['planned'] }], lanes: [{ task: 'planned', why: 'by the lead' }] }, null, 2));
brief(repo2, 'planned', 'do the planned thing');
r = ca(['lane', repo2, 'planned']);
const p2 = js(path.join(repo2, 'tasks', 'plan.json'));
check('a lane the lead already put in the plan is not added twice and the plan is kept', r.status === 0 && lanesOf(p2).filter((t) => t === 'planned').length === 1 && p2.title === 'Lead written plan' && p2.lanes[0].why === 'by the lead', JSON.stringify(p2).slice(0, 200));
check('a plan the lead forgot to register is registered when its lane starts', /Lead written plan/.test(planList()), planList());

// ---- 5. a closed plan is archived (still listed) and a new open plan is created ----
ca(['plan', 'close', 'app', '--reason', 'shipped']);
brief(repo, 'fourth', 'add a readiness endpoint');
r = ca(['lane', repo, 'fourth']);
p = js(planFile);
check('after the plan was closed, a new lane gets a new open plan with only that lane', r.status === 0 && p && p.status !== 'done' && JSON.stringify(lanesOf(p)) === '["fourth"]', JSON.stringify(p && { status: p.status, lanes: lanesOf(p) }));
const list = planList();
check('the closed plan is archived, not lost: both plans are listed', /health endpoint/i.test(list) && /readiness endpoint/i.test(list), list);

// ---- 6. CA_NO_PLAN=1 (smoke tests) creates no plan ----
const repo3 = mkrepo('smoke');
brief(repo3, 'probe', 'smoke probe');
r = ca(['lane', repo3, 'probe'], { CA_NO_PLAN: '1' });
check('CA_NO_PLAN=1 runs the lane without creating a plan', r.status === 0 && !fs.existsSync(path.join(repo3, 'tasks', 'plan.json')) && !/smoke probe/.test(planList()));
check('onboard runs its smoke lane with CA_NO_PLAN=1', /CA_NO_PLAN/.test(fs.readFileSync(path.join(ROOT, 'runner', 'onboard.mjs'), 'utf8')));

// ---- 7. Office follows the working plan ----
const chromePath = findChrome();
if (!chromePath) results.push('PASS SKIP office part: no Chrome found (set CHROME_PATH)');
else {
  // fake running lanes registered straight into plans (the fake server lanes above already finished)
  const runLane = (rp, task) => { const dir = path.join(rp, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), lastEventAt: Date.now(), phase: 'build', busy: true, activity: 'running', steps: 2, commits: 0, stepList: [], commitLog: [], tokens: {}, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: {} }));
    fs.writeFileSync(path.join(dir, 'live.log'), 'x\n');
    const id = `${path.basename(rp)}--${task}`; fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo: rp, task })); };
  const addToPlan = (rp, title, tasks) => { const f = path.join(rp, 'tasks', 'plan.json'); fs.writeFileSync(f, JSON.stringify({ title, status: 'running', waves: [{ name: 'W1', lanes: tasks }], lanes: tasks.map((t) => ({ task: t })) })); ca(['plan', f]); };
  const repoA = mkrepo('alpha'), repoB = mkrepo('beta');
  addToPlan(repoA, 'Alpha plan', ['a1']); addToPlan(repoB, 'Beta plan', ['b1']);
  runLane(repoA, 'a1');
  const dp = await free(), cp = await free();
  const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { stdio: 'ignore', env });
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('planbind')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
  try {
    let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
    const sock = new WebSocket(ws); await new Promise((rr) => sock.addEventListener('open', rr));
    let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
    const send = (method, params = {}) => new Promise((rr) => { const i = ++n; pend.set(i, rr); sock.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 10000) => { let v; for (let i = 0; i < ms / 250; i++) { v = await ev(expr); if (v) return v; await wait(250); } return v; };
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const title = `(document.getElementById('planTitle') || {}).textContent || ''`;
    const plates = `[...document.querySelectorAll('.plate')].filter((x) => x.style.display !== 'none').map((x) => (x.querySelector('.p-name') || x).textContent.trim())`;
    await send('Page.navigate', { url: `http://127.0.0.1:${dp}/office` });
    let ok = await until(`/Alpha plan/.test(${title})`);
    check('Office opens on the plan with a running lane (Alpha), not the newest plan', !!ok, await ev(title));
    check('the picker offers only plans (no "Recent lanes" when plans exist)', !(await ev(`[...document.getElementById('planSel').options].some((o) => /Recent lanes/.test(o.textContent))`)));
    // pick Beta by hand, then a lane starts running in Alpha's repo plan... start a lane in Beta's sibling: a new running lane elsewhere
    await ev(`(() => { const s = document.getElementById('planSel'); s.value = [...s.options].find((o) => /Beta plan/.test(o.textContent)).value; s.dispatchEvent(new Event('change')); })()`);
    await wait(600);
    check('a plan picked by hand is shown', /Beta plan/.test(await ev(title)));
    const shownBeta = await ev(plates);
    check('a hand-picked plan shows only its own lanes (no running lanes from other plans)', Array.isArray(shownBeta) && !shownBeta.includes('a1'), JSON.stringify(shownBeta));
    // a lane starts running in another plan: follow it
    addToPlan(repoA, 'Alpha plan', ['a1', 'a2']); runLane(repoA, 'a2');
    ok = await until(`/Alpha plan/.test(${title}) && ${plates}.includes('a2')`);
    check('a lane that starts running in another plan switches the Office to that plan, even over a hand pick', !!ok, await ev(title));
    // a brand-new plan registered while the page is open: show it
    const repoC = mkrepo('gamma'); addToPlan(repoC, 'Gamma plan', ['g1']);
    ok = await until(`/Gamma plan/.test(${title})`);
    check('a plan registered while the Office is open is shown within a poll', !!ok, await ev(title));
    check('the new plan is in the picker', !!(await ev(`[...document.getElementById('planSel').options].some((o) => /Gamma plan/.test(o.textContent))`)));
    sock.close();
  } catch (e) { check('office part ran', false, String(e && e.stack || e)); }
  try { chrome.kill(); } catch {} try { dash.kill(); } catch {}
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
