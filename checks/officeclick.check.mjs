// Office view on live data (a private registry with fake running lanes, not ?demo): every robot is
// clickable and opens its own lane, including the hot desks (lanes 4 to 8). Regression: every click
// area was 0 x 0 on live dashboards because it copied the sprite's size while the sprite was hidden.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP officeclick: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// six finished lanes that never change (like a real Control room): four take the main stations, the rest sit at hot desks
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-officeclick-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const repo = path.join(tmp, 'click-repo'); const t = Date.now();
const ids = [];
['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].forEach((task, i) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t - 600000 - i * 1000, finishedAt: t - 60000, lastEventAt: t - 60000, phase: 'finished', result: 'done', verdict: 'ready', exitCode: 0, busy: false, activity: 'done', steps: 3, commits: 1, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }], commitLog: [], tokens: { input: 1000, output: 100 }, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: { build: 'maas/deepseek-v4.1-flash' } }));
  fs.writeFileSync(path.join(dir, 'live.log'), 'x\n');
  const id = `click-repo--${task}`; ids.push(id);
  fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo, task }));
});

const dp = await free(), cp = await free();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dp)], { stdio: 'ignore', env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' } });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('officeclick')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null;
const finish = (code) => settle({ socket: sock, children: [chrome, dash], code });
guard({ children: [chrome, dash] });
const timer = setTimeout(() => { console.log('FAIL timeout'); finish(1); }, 120000);
try {
  let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
  let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/office` });
  let hits = []; for (let i = 0; i < 40; i++) { await wait(250); hits = await ev(`[...document.querySelectorAll('#sprites .hit')].filter((h) => h.style.display !== 'none' && h.dataset.lane).map((h) => { const r = h.getBoundingClientRect(); return { lane: h.dataset.lane, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })`) || []; if (hits.length >= 2) break; }
  await wait(Number(process.env.OC_SETTLE || 0)); // measure the moment the lanes are seated: the old code only got its size from a later relayout, if any
  hits = await ev(`[...document.querySelectorAll("#sprites .hit")].filter((h) => h.style.display !== "none" && h.dataset.lane).map((h) => { const r = h.getBoundingClientRect(); return { lane: h.dataset.lane, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })`) || hits;
  check('two lanes sit at hot desks with click areas', hits.length >= 2, JSON.stringify(hits));
  check('every visible robot click area has a real size (not 0 x 0)', hits.length > 0 && hits.every((h) => h.w > 20 && h.h > 20), JSON.stringify(hits.map((h) => `${h.w}x${h.h}`)));
  const main = await ev(`[...document.querySelectorAll('#sprites .hit')].filter((h) => h.style.display !== 'none' && !h.dataset.lane).map((h) => { const r = h.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })`);
  check('main station click areas have a real size too', Array.isArray(main) && main.length >= 1 && main.every((s) => !/^0x|x0$/.test(s)), JSON.stringify(main));
  // click where a person clicks: on the robot itself, just above its hot-desk nameplate
  const robots = await ev(`[...document.querySelectorAll('.plate.compact')].filter((p) => p.style.display !== 'none').map((p) => { const r = p.getBoundingClientRect(); return { plate: p.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 40) }; })`) || [];
  check('every seated hot desk shows a nameplate', robots.length === hits.length, `${robots.length} plates, ${hits.length} lanes`);
  const opened = new Set();
  for (const rb of robots) {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await wait(200);
    const top = await ev(`(() => { const e = document.elementFromPoint(${rb.x}, ${rb.y}); return e ? e.className : ''; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: rb.x, y: rb.y, button: 'left', clickCount: 1 });
    let w = null; for (let i = 0; i < 10; i++) { await wait(150); w = await ev('window.__office.state().window'); if (w?.open) break; }
    const ok = top === 'hit' && w?.open === true && hits.some((h) => h.lane === w.laneId) && !opened.has(w.laneId);
    if (w?.laneId) opened.add(w.laneId);
    check(`clicking the robot at ${rb.plate} opens its own hot-desk lane`, ok, `top=${top} ${JSON.stringify(w && { open: w.open, laneId: w.laneId })}`);
  }
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
