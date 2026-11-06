// End-to-end check for the Office view: starts `ca dash` on a free port, drives /office in headless Chrome over CDP.
// Usage: node checks/office.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = path.join(process.env.TEMP || ROOT, `ca-office-profile-${Date.now()}`);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
const timer = setTimeout(() => { console.log('FAIL timeout after 120 s'); cleanup(); process.exit(1); }, 120000);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  const page = await fetch(base + '/office'); const html = await page.text();
  check('GET /office serves the page', page.ok && /__office/.test(html) && /<title>/.test(html), String(page.status));
  check('office.html loads the shared workshop assets', /\/assets\/workshop\.js/.test(html) && /\/assets\/workshop\.css/.test(html));
  check('GET /office-sprites.js route removed', (await fetch(base + '/office-sprites.js')).status === 404);
  const dashHtml = await (await fetch(base + '/')).text();
  check('lanes dashboard links to the office view', /href="\/office"/.test(dashHtml));
  const stale = await fetch(base + '/api/lane/no-such-lane-xyz/detail');
  let alive = false; try { alive = (await fetch(base + '/api/lanes')).ok; } catch {}
  check('unknown lane gives 404 and the dashboard stays up', stale.status === 404 && alive, `${stale.status} alive=${alive}`);

  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const st = () => ev('window.__office && window.__office.state()');
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');

  await size(1280, 800); await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(1800);
  let s = await st();
  check('test hook window.__office.state()', !!s && s.mode === 'demo', s && s.mode);
  if (s) {
    check('stage is full width at 1280x800', Math.abs(s.stage.w - 1280) <= 1, `${s.stage.w}x${s.stage.h}`);
    check('stage aspect is 16:9', Math.abs(s.stage.w / s.stage.h - 16 / 9) < 0.01, (s.stage.w / s.stage.h).toFixed(3));
    check('demo has the goal line', typeof s.goal === 'string' && s.goal.length > 10);
    check('demo=1 has the three scene lanes', s.lanes.map((l) => l.id).join(',') === 'office-scene,office-sprites,office-review', s.lanes.map((l) => l.id).join(','));
    check('reviewer lane starts running', s.lanes.find((l) => l.id === 'office-review')?.running === true);
    check('builder lane starts waiting', s.lanes.find((l) => l.id === 'office-scene')?.running === false);
  }
  await shot('1-scene');
  await wait(1300); s = await st();
  check('timeline assignment makes the builder lane run', s.lanes.find((l) => l.id === 'office-scene')?.running === true);
  await send('Page.navigate', { url: base + '/office?demo=done' }); await wait(1500); s = await st();
  check('demo=done: every lane done', s && s.lanes.length === 3 && s.lanes.every((l) => l.result === 'done' && l.done === l.total), s && s.lanes.map((l) => `${l.id}:${l.result}`).join(','));
  await send('Page.navigate', { url: base + '/office?demo=big' }); await wait(1500); s = await st();
  check('demo=big has 8 lanes', s && s.lanes.length === 8, s && String(s.lanes.length));
  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(2600); s = await st();
  check('still=1 keeps the builder lane waiting', s && s.lanes.find((l) => l.id === 'office-scene')?.running === false);
  await send('Page.navigate', { url: base + '/office' }); await wait(2500); s = await st();
  check('live mode renders from the runner API', s && s.mode === 'live', s && s.mode);
  await shot('6-live');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
