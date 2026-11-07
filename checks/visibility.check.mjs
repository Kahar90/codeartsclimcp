// Every running lane is visible, always: in the Office view (whatever plan is shown, including an old
// closed plan picked by hand), in the Control room's Running section and in the Lanes sidebar, and a lane
// started while the pages are open shows up within a poll, without a reload. Private registry, fake lanes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP visibility: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const t = Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-visible-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const lane = (project, task, st) => {
  const repo = path.join(tmp, project); const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ steps: 3, commits: 1, stepList: [], commitLog: [], tokens: { input: 1000, output: 100 }, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: { build: 'maas/deepseek-v4.1-flash' }, ...st }));
  fs.writeFileSync(path.join(dir, 'live.log'), 'x\n');
  fs.writeFileSync(path.join(reg, `${project}--${task}.json`), JSON.stringify({ id: `${project}--${task}`, dir, repo, task }));
  return repo;
};
const running = () => ({ pid: process.pid, startedAt: Date.now(), lastEventAt: Date.now(), phase: 'build', busy: true, activity: 'running' });
// an old project with a closed plan and its finished lanes
const oldRepo = lane('oldproj', 'shipped', { pid: 999999, startedAt: t - 9e6, finishedAt: t - 8e6, lastEventAt: t - 8e6, phase: 'finished', result: 'done', verdict: 'ready', exitCode: 0, activity: 'done' });
lane('oldproj', 'polish', { pid: 999999, startedAt: t - 9e6, finishedAt: t - 8e6, lastEventAt: t - 8e6, phase: 'finished', result: 'done', verdict: 'ready', exitCode: 0, activity: 'done' });
const planFile = path.join(oldRepo, 'tasks', 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({ title: 'Old shipped plan', status: 'done', waves: [{ name: 'W1', lanes: ['shipped', 'polish'] }], lanes: [{ task: 'shipped' }, { task: 'polish' }] }));
spawnSync(process.execPath, [CA, 'plan', planFile], { env, encoding: 'utf8' });
spawnSync(process.execPath, [CA, 'plan', 'close', 'oldproj', '--reason', 'shipped'], { env, encoding: 'utf8' });
// a quick lane started from chat, no plan, another project
lane('chatproj', 'quickfix', running());

const dp = await free(), cp = await free();
const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { stdio: 'ignore', env });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('visible')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
const timer = setTimeout(() => { console.log('FAIL timeout'); cleanup(); process.exit(1); }, 150000);
try {
  let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const plates = `[...document.querySelectorAll('.plate')].filter((p) => p.style.display !== 'none' && getComputedStyle(p).display !== 'none').map((p) => (p.querySelector('.p-name') || p).textContent.trim())`;
  const until = async (expr, ms = 8000) => { let v; for (let i = 0; i < ms / 250; i++) { v = await ev(expr); if (v) return v; await wait(250); } return v; };

  // Office, default view
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/office` });
  let ok = await until(`${plates}.includes('quickfix')`);
  check('Office default view: the running lane without a plan has a desk (not hidden behind the old closed plan)', !!ok, JSON.stringify(await ev(plates)));
  // Office, old closed plan picked by hand: the running lane is still on screen
  await ev(`(() => { const s = document.getElementById('planSel'); const o = [...s.options].find((x) => /Old shipped plan/.test(x.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
  await wait(800);
  const picked = await ev(plates);
  check('Office with an old closed plan picked by hand: its lanes and the running lane are all on screen', Array.isArray(picked) && picked.includes('shipped') && picked.includes('quickfix'), JSON.stringify(picked));
  // a lane started now, while the page is open
  lane('chatproj', 'newlane', running());
  ok = await until(`${plates}.includes('newlane')`, 10000);
  check('a lane started while the Office is open appears within a poll, no reload', !!ok, JSON.stringify(await ev(plates)));
  // a new plan registered while the page is open (the old plan is still picked by hand)
  const newRepo = path.join(tmp, 'planproj'); fs.mkdirSync(path.join(newRepo, 'tasks'), { recursive: true });
  const newPlan = path.join(newRepo, 'tasks', 'plan.json');
  fs.writeFileSync(newPlan, JSON.stringify({ title: 'Brand new plan', status: 'running', now: 'starting wave 1', waves: [{ name: 'W1', lanes: ['alpha'] }], lanes: [{ task: 'alpha' }] }));
  spawnSync(process.execPath, [CA, 'plan', newPlan], { env, encoding: 'utf8' });
  const shownPlan = `(() => { const s = document.getElementById('planSel'); const o = s && s.options[s.selectedIndex]; return o ? o.textContent : ''; })()`;
  ok = await until(`/Brand new plan/.test(${shownPlan})`, 10000);
  check('a new plan registered while the Office is open is picked up and shown, even over a hand-picked plan', !!ok, await ev(shownPlan));
  const withPlan = await ev(plates);
  check('with the new plan shown, every running lane is still on screen', Array.isArray(withPlan) && withPlan.includes('quickfix') && withPlan.includes('newlane'), JSON.stringify(withPlan));
  check('the Office header shows the new plan title', /Brand new plan/.test(await ev(`(document.getElementById('planTitle') || {}).textContent`) || ''));

  // Control room and Lanes sidebar
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/` });
  const runSec = `(() => { const s = document.querySelector('.cr-sec[data-bucket="running"]'); return s ? s.textContent : ''; })()`;
  ok = await until(`/quickfix/.test(${runSec}) && /newlane/.test(${runSec})`);
  check('Control room Running lists both running lanes', !!ok, (await ev(runSec)).slice(0, 200));
  const rail = `(() => { const r = document.getElementById('railBody'); return r ? r.textContent : ''; })()`;
  ok = await until(`/Other lanes/.test(${rail}) && /quickfix/.test(${rail}) && /newlane/.test(${rail})`);
  check('Lanes sidebar lists both under Other lanes', !!ok);
  ok = await until(`/Brand new plan/.test(${rail})`);
  check('Lanes sidebar lists the plan registered during the session', !!ok);
  const newPlan2 = path.join(tmp, 'planproj2', 'tasks', 'plan.json'); fs.mkdirSync(path.dirname(newPlan2), { recursive: true });
  fs.writeFileSync(newPlan2, JSON.stringify({ title: 'Second fresh plan', status: 'running', waves: [{ name: 'W1', lanes: ['beta'] }], lanes: [{ task: 'beta' }] }));
  spawnSync(process.execPath, [CA, 'plan', newPlan2], { env, encoding: 'utf8' });
  ok = await until(`/Second fresh plan/.test(${rail})`, 10000);
  check('a plan registered while the Lanes page is open appears in the sidebar within a poll', !!ok);
  lane('chatproj', 'third', running());
  ok = await until(`/third/.test(${runSec})`, 10000);
  check('a lane started while the Control room is open appears within a poll', !!ok);
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
