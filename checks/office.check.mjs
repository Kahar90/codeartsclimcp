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
  const keyEv = async (args) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', ...args }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...args }); };
  await send('Runtime.enable');

  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const winIn = (s) => s.window.x >= s.stage.x - 1 && s.window.y >= s.stage.y - 1 && s.window.x + s.window.w <= s.stage.x + s.stage.w + 1 && s.window.y + s.window.h <= s.stage.y + s.stage.h + 1;
  const platesIn = (s) => s.stations.every((x) => x.plate.w === 0 || (x.plate.x >= s.stage.x - 1 && x.plate.y >= s.stage.y - 1 && x.plate.x + x.plate.w <= s.stage.x + s.stage.w + 1 && x.plate.y + x.plate.h <= s.stage.y + s.stage.h + 1));
  const feetIn = (s, m = 40) => s.stations.every((x) => x.foot.x >= s.stage.x - m && x.foot.y >= s.stage.y - m && x.foot.x <= s.stage.x + s.stage.w + m && x.foot.y <= s.stage.y + s.stage.h + m);

  await size(1280, 800); await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1800);
  let s = await st();
  check('test hook window.__office.state()', !!s && s.mode === 'demo', s && s.mode);
  if (s) {
    check('stage fills the width at 1280x800', near(s.stage.w, 1280), `${s.stage.w}x${s.stage.h}`);
    check('stage reaches the viewport bottom at 1280x800', near(s.stage.y + s.stage.h, 800), `bottom ${s.stage.y + s.stage.h}`);
    check('demo has the goal line', typeof s.goal === 'string' && s.goal.length > 10);
    check('demo=1 has the three scene lanes', s.lanes.map((l) => l.id).join(',') === 'office-scene,office-sprites,office-review', s.lanes.map((l) => l.id).join(','));
    check('reviewer lane starts running', s.lanes.find((l) => l.id === 'office-review')?.running === true);
    check('builder lane starts waiting', s.lanes.find((l) => l.id === 'office-scene')?.running === false);
    check('four stations with lanes and names', s.stations.length === 4 && s.stations.every((x) => x.laneId && x.name), s.stations.map((x) => `${x.station}:${x.laneId}`).join(','));
    check('sprites inside the stage', feetIn(s), s.stations.map((x) => `${Math.round(x.foot.x)},${Math.round(x.foot.y)}`).join(' '));
    check('nameplates inside the stage', platesIn(s));
  }
  await shot('1-scene');

  const stage0 = s && { ...s.stage };
  await ev('window.__office.press("office-review")'); await wait(300);
  s = await st();
  check('press opens the window', s.window.open && s.window.laneId === 'office-review', s.window.laneId);
  check('stage rect identical before and after opening the window', near(s.stage.x, stage0.x, 0.5) && near(s.stage.y, stage0.y, 0.5) && near(s.stage.w, stage0.w, 0.5) && near(s.stage.h, stage0.h, 0.5), `${s.stage.w}x${s.stage.h} vs ${stage0.w}x${stage0.h}`);
  check('one [role=dialog] in the DOM', (await ev('document.querySelectorAll("[role=dialog]").length')) === 1);
  check('window rect inside the stage at 1280x800', winIn(s), `${Math.round(s.window.x)},${Math.round(s.window.y)} ${Math.round(s.window.w)}x${Math.round(s.window.h)}`);
  await shot('2-window');
  const first = { x: s.window.x, y: s.window.y };
  await ev('window.__office.press("office-scene")'); await wait(300);
  s = await st();
  check('pressing another station moves the window', s.window.open && s.window.laneId === 'office-scene' && (!near(s.window.x, first.x, 1) || !near(s.window.y, first.y, 1)), `${Math.round(s.window.x)},${Math.round(s.window.y)} after ${Math.round(first.x)},${Math.round(first.y)}`);
  check('still one [role=dialog] after switching', (await ev('document.querySelectorAll("[role=dialog]").length')) === 1);
  await shot('3-window-switched');

  await ev('window.__office.press("office-sprites")'); await wait(250);
  const cont = await ev('document.getElementById("winCont").textContent');
  check('continuation line under the model line', cont === 'Run 2 \u00b7 continues office-v2 (paused at 6/8)', cont);

  await ev('window.__office.press("office-review")'); await wait(250);
  await ev('document.getElementById("winInput").focus()');
  await send('Input.insertText', { text: 'keep this draft' });
  await ev('window.__office.press("office-sprites")'); await wait(250);
  await ev('window.__office.press("office-review")'); await wait(250);
  const draft = await ev('document.getElementById("winInput").value');
  check('steer draft survives switching lanes and back', draft === 'keep this draft', draft);

  s = await st();
  const e0 = s.effects.length;
  await ev('window.__office.demoAdvance("office-scene")'); await wait(300);
  s = await st();
  check('demoAdvance adds exactly one step effect', s.effects.length === e0 + 1 && s.effects[e0].type === 'step' && s.effects[e0].laneId === 'office-scene', JSON.stringify(s.effects.slice(e0)));
  const e1 = s.effects.length;
  s = await st();
  check('a second state() call adds no effects', s.effects.length === e1);

  await ev('window.__office.press("office-review")'); await wait(250);
  check('pressing the active trigger again closes it', !(await st()).window.open);
  await ev('document.activeElement && document.activeElement.blur()');
  let plateCls = ''; let tabLane = '';
  for (let i = 0; i < 24 && !plateCls.includes('plate'); i++) {
    await keyEv({ key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    plateCls = await ev('document.activeElement ? document.activeElement.className : ""');
  }
  tabLane = await ev('document.activeElement ? (document.activeElement.dataset.lane || "") : ""');
  check('Tab reaches a nameplate', plateCls.includes('plate'), plateCls);
  await keyEv({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await wait(300);
  s = await st();
  check('Enter opens the window from the nameplate', s.window.open && s.window.laneId === tabLane, `${s.window.laneId} vs ${tabLane}`);
  check('keyboard open puts focus inside the window', s.window.focusInside, await ev('document.activeElement ? document.activeElement.id : ""'));
  await keyEv({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(250);
  s = await st();
  check('Escape closes the window', !s.window.open);
  check('Escape returns focus to the trigger', (await ev('document.activeElement ? document.activeElement.className : ""')).includes('plate') && (await ev('document.activeElement ? (document.activeElement.dataset.lane || "") : ""')) === tabLane);

  await ev('window.__office.press("office-scene")'); await wait(250);
  check('window reopened for the outside click test', (await st()).window.open);
  const stg = (await st()).stage;
  await click(stg.x + 25, stg.y + 25);
  await wait(250);
  check('outside click closes the window', !(await st()).window.open);

  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1800);
  s = await st();
  check('reload with the same state adds no effects', s.effects.length === 0, JSON.stringify(s.effects));

  await size(1920, 1080); await wait(500);
  s = await st();
  check('stage fills the width at 1920x1080', near(s.stage.w, 1920), `${s.stage.w}x${s.stage.h}`);
  check('stage reaches the bottom at 1920x1080', near(s.stage.y + s.stage.h, 1080), `bottom ${s.stage.y + s.stage.h}`);
  check('nameplates inside the stage at 1920x1080', platesIn(s));
  await size(2560, 1080); await wait(500);
  s = await st();
  check('stage fills the width at 2560x1080', near(s.stage.w, 2560), `${s.stage.w}x${s.stage.h}`);
  check('stage reaches the bottom at 2560x1080', near(s.stage.y + s.stage.h, 1080), `bottom ${s.stage.y + s.stage.h}`);
  check('nameplates inside the stage at 2560x1080', platesIn(s));

  await size(1280, 800); await wait(400);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait(500);
  const frames = await ev('(function(){ var m = window.PixelSprites.manifest; var st = window.__office.state(); return st.stations.map(function(x){ var c = m.roles[x.station] && m.roles[x.station].clips[x.clip]; return { station: x.station, clip: x.clip, frame: x.frame, want: c ? (c.staticFrame || 0) : -1 }; }); })()');
  check('reduced motion freezes every sprite on its static frame', Array.isArray(frames) && frames.every((f) => f.frame === f.want), JSON.stringify(frames));
  await send('Emulation.setEmulatedMedia', { features: [] });

  await size(390, 844); await wait(600);
  s = await st();
  check('narrow mode below 700 px', (await ev('document.body.classList.contains("narrow")')) === true);
  check('stage fills the width at 390x844', near(s.stage.w, 390), `${s.stage.w}x${s.stage.h}`);
  check('stage reaches the bottom at 390x844', near(s.stage.y + s.stage.h, 844), `bottom ${s.stage.y + s.stage.h}`);
  check('nameplates hidden when narrow', s.stations.every((x) => x.plate.w === 0));
  const rows = await ev('document.querySelectorAll("#stlist .st-row").length');
  check('station list shows lead and workers when narrow', rows === 4, String(rows));
  await ev('window.__office.press("office-review")'); await wait(300);
  s = await st();
  check('window opens as a card when narrow', s.window.open && s.window.laneId === 'office-review', s.window.laneId);
  check('window rect inside the stage at 390x844', winIn(s), `${Math.round(s.window.x)},${Math.round(s.window.y)} ${Math.round(s.window.w)}x${Math.round(s.window.h)}`);
  await shot('4-phone');

  await size(1280, 800); await wait(400);
  await send('Page.navigate', { url: base + '/office?demo=big' }); await wait(1800);
  s = await st();
  check('demo=big has 8 lanes', s.lanes.length === 8, String(s.lanes.length));
  check('demo=big sends 5 lanes to the overflow list', s.overflow.length === 5, s.overflow.join(','));
  await shot('5-big');

  await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(5000);
  s = await st();
  check('timeline assignment starts the builder lane', s.lanes.find((l) => l.id === 'office-scene')?.running === true);
  check('timeline press opens the builder window', s.window.open && s.window.laneId === 'office-scene', s.window.laneId);
  await wait(1600);
  s = await st();
  check('timeline stepComplete adds a step effect', s.effects.some((e) => e.type === 'step' && e.laneId === 'office-scene'), JSON.stringify(s.effects));

  await send('Page.navigate', { url: base + '/office' }); await wait(2500);
  s = await st();
  check('live mode renders from the runner API', s && s.mode === 'live', s && s.mode);
  await shot('6-live');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
