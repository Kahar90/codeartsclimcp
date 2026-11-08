// Every running lane is accounted for. The Office shows the plan that is working (a plan with a running
// lane, else the newest open plan), never lanes outside that plan: a plan picked by hand shows only its own
// lanes, and a lane that starts running in another plan switches the view to that plan, even over the hand
// pick. A brand-new plan registered while the page is open is shown within a poll. A running lane with no
// plan is not in the Office (it belongs to no plan) but is still listed in the Control room's Running
// section and in the Lanes sidebar, so no running lane is ever lost. Private registry, fake lanes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
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
const finished = () => ({ pid: 999999, startedAt: t - 9e6, finishedAt: t - 8e6, lastEventAt: t - 8e6, phase: 'finished', result: 'done', verdict: 'ready', exitCode: 0, activity: 'done' });
const plan = (repo, title, tasks, status = 'running') => { const f = path.join(repo, 'tasks', 'plan.json'); fs.writeFileSync(f, JSON.stringify({ title, status, waves: [{ name: 'W1', lanes: tasks }], lanes: tasks.map((task) => ({ task })) })); spawnSync(process.execPath, [CA, 'plan', f], { env, encoding: 'utf8' }); };
// an old project with a closed plan and its finished lanes
const oldRepo = lane('oldproj', 'shipped', finished());
lane('oldproj', 'polish', finished());
plan(oldRepo, 'Old shipped plan', ['shipped', 'polish'], 'done');
spawnSync(process.execPath, [CA, 'plan', 'close', 'oldproj', '--reason', 'shipped'], { env, encoding: 'utf8' });
// a project with a running lane and its open plan: the plan that is working
const workRepo = lane('workproj', 'active', running());
plan(workRepo, 'Work plan', ['active']);
// another project whose plan exists but is idle; its lane starts running later, while the Office is open
const helperRepo = lane('helperproj', 'helper', finished());
plan(helperRepo, 'Helper plan', ['helper']);
// a lane started from chat, no plan at all
lane('chatproj', 'quickfix', running());

const dp = await free(), cp = await free();
const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { stdio: 'ignore', env });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('visible')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null;
const finish = (code) => settle({ socket: sock, children: [chrome, dash], code });
guard({ children: [chrome, dash] });
const timer = setTimeout(() => { console.log('FAIL timeout'); finish(1); }, 150000);
try {
  let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
  let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const title = `(document.getElementById('planTitle') || {}).textContent || ''`;
  const plates = `[...document.querySelectorAll('.plate')].filter((p) => p.style.display !== 'none' && getComputedStyle(p).display !== 'none').map((p) => (p.querySelector('.p-name') || p).textContent.trim())`;
  const until = async (expr, ms = 8000) => { let v; for (let i = 0; i < ms / 250; i++) { v = await ev(expr); if (v) return v; await wait(250); } return v; };

  // Office, default view: the plan with a running lane, not the old closed plan
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/office` });
  let ok = await until(`/Work plan/.test(${title})`);
  check('Office opens on the plan that is working (a running lane), not the newest or the old closed plan', !!ok, await ev(title));
  let shown = await ev(plates);
  check('the working plan shows its running lane', Array.isArray(shown) && shown.includes('active'), JSON.stringify(shown));
  check('the picker offers only plans (no "Recent lanes" when plans exist)', !(await ev(`[...document.getElementById('planSel').options].some((o) => /Recent lanes/.test(o.textContent))`)));
  // Office, old closed plan picked by hand: only that plan's lanes are on screen
  await ev(`(() => { const s = document.getElementById('planSel'); const o = [...s.options].find((x) => /Old shipped plan/.test(x.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
  await wait(800);
  shown = await ev(plates);
  check('a hand-picked old closed plan shows only its own lanes, no running lanes from other plans', Array.isArray(shown) && shown.includes('shipped') && shown.includes('polish') && !shown.includes('active') && !shown.includes('quickfix'), JSON.stringify(shown));
  // a lane that starts running in another plan switches the Office to that plan, even over the hand pick
  lane('helperproj', 'helper', running());
  ok = await until(`/Helper plan/.test(${title}) && ${plates}.includes('helper')`, 10000);
  check('a lane that starts running in another plan switches the Office to that plan, even over a hand pick', !!ok, await ev(title));
  shown = await ev(plates);
  check('the followed plan shows its newly running lane and nothing outside it', Array.isArray(shown) && shown.includes('helper') && !shown.includes('active') && !shown.includes('quickfix'), JSON.stringify(shown));
  // a new plan registered while the page is open is shown within a poll
  const freshRepo = lane('freshproj', 'f1', running());
  plan(freshRepo, 'Fresh plan', ['f1']);
  ok = await until(`/Fresh plan/.test(${title})`, 10000);
  check('a new plan registered while the Office is open is shown within a poll, even over a hand pick', !!ok, await ev(title));
  check('the new plan is in the picker', !!(await ev(`[...document.getElementById('planSel').options].some((o) => /Fresh plan/.test(o.textContent))`)));

  // Control room and Lanes sidebar: every running lane is listed, with a plan or without
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/` });
  const runSec = `(() => { const s = document.querySelector('.cr-sec[data-bucket="running"]'); return s ? s.textContent : ''; })()`;
  ok = await until(`/active/.test(${runSec}) && /helper/.test(${runSec}) && /quickfix/.test(${runSec})`);
  check('Control room Running lists every running lane, including the one without a plan', !!ok, (await ev(runSec)).slice(0, 200));
  const rail = `(() => { const r = document.getElementById('railBody'); return r ? r.textContent : ''; })()`;
  ok = await until(`/Work plan/.test(${rail}) && /Helper plan/.test(${rail}) && /Fresh plan/.test(${rail}) && /quickfix/.test(${rail})`);
  check('Lanes sidebar lists the plans and the running lane without a plan', !!ok, (await ev(rail)).slice(0, 200));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await settle({ socket: sock, children: [chrome, dash], code: fails ? 1 : 0 });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
