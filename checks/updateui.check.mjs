// End to end: the update pill on a real dashboard (not the ?update=demo fixture). A fake remote
// serves a newer package.json and CHANGELOG.md; the install command is a no-op. Clicking the pill
// and "Update now" must POST /api/update, show the restart state, survive the dashboard restarting
// itself on the same port, reload, and then show no pill (the cache now says up to date).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP updateui: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const OUT = path.join(ROOT, 'checks', 'out', 'polish'); fs.mkdirSync(OUT, { recursive: true });
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const [a, b] = CUR.split('.').map(Number); const NEXT = `${a}.${b + 1}.0`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-updateui-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home); fs.mkdirSync(path.join(tmp, 'lad'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const srv = http.createServer((req, res) => {
  if (req.url.endsWith('/package.json')) { res.end(JSON.stringify({ version: NEXT })); return; }
  if (req.url.endsWith('/CHANGELOG.md')) { res.end(`# Changelog\n\n## ${NEXT} (2026-11-09)\n\n- First new thing\n- Second new thing\n\n## ${CUR} (2026-11-07)\n\n- old\n`); return; }
  res.writeHead(404); res.end();
});
const rp = await free(); await new Promise((r) => srv.listen(rp, '127.0.0.1', r));
const dp = await free(), cp = await free();
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(tmp, 'lad'), CA_REGISTRY: reg, CA_DASH: '0', CA_UPDATE_URL: `http://127.0.0.1:${rp}/`, CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(0)"` };
delete env.CA_NO_UPDATE_CHECK;
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dp)], { cwd: tmp, env, stdio: 'ignore' });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('updateui')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let newPid = null;
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} if (newPid) { try { process.kill(newPid); } catch {} } srv.close(); };
const timer = setTimeout(() => { console.log('FAIL timeout'); cleanup(); process.exit(1); }, 120000);
try {
  let ws = null; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const click = async (sel) => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); if (!r) return false; for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); return true; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // first GET /api/update has no cache yet: the dashboard checks the remote (stale-cache refresh)
  for (let i = 0; i < 40; i++) { await wait(250); try { const j = await (await fetch(`http://127.0.0.1:${dp}/api/update?refresh=1`)).json(); if (j && j.available) break; } catch {} }
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}/office` });
  let pill = false; for (let i = 0; i < 40 && !pill; i++) { await wait(250); pill = await ev(`!!document.querySelector('.ca-update')`); }
  check('a real dashboard shows the update pill when the remote has a newer version', pill);
  check('the pill names the new version', (await ev(`(document.querySelector('.ca-update') || {}).textContent || ''`)).includes(NEXT));
  await click('.ca-update'); await wait(400);
  const txt = await ev(`(document.querySelector('.ca-update-pop') || {}).textContent || ''`);
  check('the popover lists the changelog items of the new version', /First new thing/.test(txt) && /Second new thing/.test(txt) && !/\bold\b/.test(txt), txt.slice(0, 200));
  const btn = await ev(`(() => { const b = [...document.querySelectorAll('.ca-update-pop button')].find((x) => /Update now/i.test(x.textContent)); if (!b) return false; b.setAttribute('data-test-update', '1'); return true; })()`);
  check('the popover has an Update now button', btn);
  await click('[data-test-update]'); await wait(300);
  const busy = await ev(`(document.querySelector('.ca-update-pop') || document.body).textContent`);
  check('Update now shows progress (Installing or Restarting)', /Installing|Restarting/i.test(busy), busy.slice(0, 160));
  await send('Page.captureScreenshot', { format: 'png' }).then((r) => r && r.data && fs.writeFileSync(path.join(OUT, 'update-restarting.png'), Buffer.from(r.data, 'base64')));
  // the dashboard restarts on the same port; the page reloads by itself
  let back = null; for (let i = 0; i < 80; i++) { await wait(250); try { const j = await (await fetch(`http://127.0.0.1:${dp}/api/update`)).json(); if (j.pid && j.pid !== dash.pid) { back = j; break; } } catch {} }
  newPid = back && back.pid;
  check('the dashboard came back with a new process', !!back, JSON.stringify(back));
  let gone = false; for (let i = 0; i < 60 && !gone; i++) { await wait(250); gone = await ev(`document.readyState === 'complete' && !!document.querySelector('.ca-top') && !document.querySelector('.ca-update') && !document.querySelector('.ca-update-pop')`); }
  check('after the reload the pill is gone (up to date)', gone);
} catch (e) { check('no exception', false, e.stack || e.message); }
clearTimeout(timer); cleanup();
for (const r of results) console.log(r);
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
