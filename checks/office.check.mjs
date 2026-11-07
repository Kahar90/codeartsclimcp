// End-to-end check for the Office view: starts `ca dash` on a free port, drives /office in headless Chrome over CDP.
// Usage: node checks/office.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP office: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('office');
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
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
  const stReady = async () => { let v; for (let i = 0; i < 12 && !v; i++) { v = await st(); if (!v) await wait(400); } return v; };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const keyEv = async (args) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', ...args }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...args }); };
  await send('Runtime.enable');
  // CI runners often have system animations off (prefers-reduced-motion: reduce), which correctly turns
  // the step effects off: pin motion on so the checks are deterministic; reduced motion is tested on its own.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const fmtTokens = (n) => n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)) + 'k' : (n < 1e7 ? (n / 1e6).toFixed(2) : (n / 1e6).toFixed(1)) + 'M';
  const noOverlap = (st) => {
    const ps = st.stations.filter((x) => x.plate.w > 0);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i].plate, b = ps[j].plate;
      if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) return false;
    }
    return true;
  };
  const winIn = (s) => s.window.x >= s.stage.x - 1 && s.window.y >= s.stage.y - 1 && s.window.x + s.window.w <= s.stage.x + s.stage.w + 1 && s.window.y + s.window.h <= s.stage.y + s.stage.h + 1;
  const platesIn = (s) => s.stations.every((x) => x.plate.w === 0 || (x.plate.x >= s.stage.x - 1 && x.plate.y >= s.stage.y - 1 && x.plate.x + x.plate.w <= s.stage.x + s.stage.w + 1 && x.plate.y + x.plate.h <= s.stage.y + s.stage.h + 1));
  const feetIn = (s, m = 40) => s.stations.every((x) => x.foot.x >= s.stage.x - m && x.foot.y >= s.stage.y - m && x.foot.x <= s.stage.x + s.stage.w + m && x.foot.y <= s.stage.y + s.stage.h + m);

  await size(1280, 800); await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1800);
  let s = await stReady();
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
  await ev('window.__office.demoAdvance("office-scene")');
  for (let i = 0; i < 25; i++) { await wait(200); s = await st(); if (s.effects.length > e0) break; } // poll: slow CI runners
  check('demoAdvance adds exactly one step effect', s.effects.length === e0 + 1 && s.effects[e0].type === 'step' && s.effects[e0].laneId === 'office-scene', JSON.stringify(s.effects.slice(e0)));
  // accessibility: with reduced motion the same step adds no effect
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await wait(300);
  s = await st(); const eReduced = s.effects.length;
  await ev('window.__office.demoAdvance("office-scene")'); await wait(1500); s = await st();
  check('prefers-reduced-motion: a step adds no effect', s.effects.length === eReduced, JSON.stringify(s.effects.slice(eReduced)));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await wait(300);
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
  s = await stReady();
  check('reload with the same state adds no effects', s.effects.length === 0, JSON.stringify(s.effects));

  await size(1920, 1080); await wait(500);
  s = await st();
  check('stage fills the width at 1920x1080', near(s.stage.w, 1920), `${s.stage.w}x${s.stage.h}`);
  check('stage reaches the bottom at 1920x1080', near(s.stage.y + s.stage.h, 1080), `bottom ${s.stage.y + s.stage.h}`);
  check('nameplates inside the stage at 1920x1080', platesIn(s));
  check('nameplates do not overlap at 1920x1080', noOverlap(s));
  await size(2560, 1080); await wait(500);
  s = await st();
  check('stage fills the width at 2560x1080', near(s.stage.w, 2560), `${s.stage.w}x${s.stage.h}`);
  check('stage reaches the bottom at 2560x1080', near(s.stage.y + s.stage.h, 1080), `bottom ${s.stage.y + s.stage.h}`);
  check('nameplates inside the stage at 2560x1080', platesIn(s));
  check('nameplates do not overlap at 2560x1080', noOverlap(s));

  await size(1280, 800); await wait(400);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait(500);
  const frames = await ev('(function(){ var m = window.PixelSprites.manifest; var st = window.__office.state(); return st.stations.map(function(x){ var c = m.roles[x.station] && m.roles[x.station].clips[x.clip]; return { station: x.station, clip: x.clip, frame: x.frame, want: c ? (c.staticFrame || 0) : -1 }; }); })()');
  check('reduced motion freezes every sprite on its static frame', Array.isArray(frames) && frames.every((f) => f.frame === f.want), JSON.stringify(frames));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); // back to the pinned value, not the OS setting

  await size(390, 844); await wait(600);
  s = await st();
  check('narrow mode below 700 px', (await ev('document.body.classList.contains("narrow")')) === true);
  check('stage fills the width at 390x844', near(s.stage.w, 390), `${s.stage.w}x${s.stage.h}`);
  check('narrow stage shows the whole room at 16:9', near(s.stage.h, (s.stage.w * 720) / 1280), `${s.stage.w}x${s.stage.h}`);
  const listTop = await ev('Math.round(document.getElementById("stlist").getBoundingClientRect().top)');
  check('station list starts right below the narrow stage', Math.abs(listTop - (s.stage.y + s.stage.h)) < 24, `list ${listTop} stage bottom ${s.stage.y + s.stage.h}`);
  check('nameplates hidden when narrow', s.stations.every((x) => x.plate.w === 0));
  const rows = await ev('document.querySelectorAll("#stlist .st-row").length');
  check('station list shows lead and workers when narrow', rows === 4, String(rows));
  await ev('window.__office.press("office-review")'); await wait(300);
  s = await st();
  check('window opens as a card when narrow', s.window.open && s.window.laneId === 'office-review', s.window.laneId);
  check('narrow window is a bottom sheet: full width, docked to the viewport bottom, tall enough to read', near(s.window.x, 0) && near(s.window.w, 390) && near(s.window.y + s.window.h, 844) && s.window.h >= 300 && s.window.h <= 844 * 0.86, `${Math.round(s.window.x)},${Math.round(s.window.y)} ${Math.round(s.window.w)}x${Math.round(s.window.h)}`);
  await shot('4-phone');

  await size(1280, 800); await wait(400);
  await send('Page.navigate', { url: base + '/office?demo=big' }); await wait(1800);
  s = await stReady();
  check('demo=big has 8 lanes', s.lanes.length === 8, String(s.lanes.length));
  check('demo=big seats all 8 lanes at the main stations and hot desks', s.overflow.count === 0, s.overflow.ids.join(','));
  await shot('5-big');

  await size(1280, 800); await wait(400);
  await send('Page.navigate', { url: base + '/office?demo=crowd' }); await wait(1800);
  s = await stReady();
  check('demo=crowd has 10 lanes', s && s.lanes.length === 10, s && String(s.lanes.length));
  check('demo=crowd seats 8 lane sprites plus the lead', s.stations.filter((x) => x.laneId).length === 9 && s.stations.filter((x) => x.station !== 'lead' && x.laneId).length === 8, s.stations.filter((x) => x.laneId).map((x) => x.station + ':' + x.laneId).join(','));
  const hotSeated = s.stations.filter((x) => /^hot/.test(x.station));
  check('demo=crowd puts five extra lanes at the hot desks', hotSeated.length === 5 && hotSeated.every((x) => x.laneId), hotSeated.map((x) => x.station + ':' + x.laneId).join(','));
  check('demo=crowd seats both needs-you lanes and keeps them out of the pill', ['cli-dx', 'mcp'].every((id) => s.stations.some((x) => x.laneId === id)) && ['cli-dx', 'mcp'].every((id) => !s.overflow.ids.includes(id)), s.overflow.ids.join(','));
  check('demo=crowd draws a desk under every seated hot worker', hotSeated.length > 0 && hotSeated.every((x) => x.desk === true), hotSeated.map((x) => x.station + ':' + x.desk).join(','));
  check('demo=crowd nameplates stay inside the stage', platesIn(s));
  check('demo=crowd nameplates do not overlap', noOverlap(s));
  // Found by the lead in the screenshot: depth-sorted sprites and desks drew over a nameplate. Every plate centre must hit its own plate.
  const covered = await ev('(function(){ return [...document.querySelectorAll("#plates .plate")].filter(function(p){ var r = p.getBoundingClientRect(); if (!r.width) return false; var e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !e || e.closest(".plate") !== p; }).map(function(p){ return p.id || p.textContent.slice(0, 20); }); })()');
  check('demo=crowd no sprite or desk covers a nameplate', Array.isArray(covered) && covered.length === 0, JSON.stringify(covered));
  const pillS = await ev('(function(){ var p = document.getElementById("needsPill"); return { shown: getComputedStyle(p).display !== "none", n: document.getElementById("needsPillN").textContent }; })()');
  check('demo=crowd Needs you pill counts the stalled and failed lanes', pillS && pillS.shown && pillS.n === '2', JSON.stringify(pillS));
  check('demo=crowd pill shows the two overflow lanes', s.overflow.count === 2 && s.overflow.ids.join(',') === 'docs-site,perf-pass', JSON.stringify(s.overflow.ids));
  const kindInfo = await ev('(function(){ var m = window.PixelSprites.manifest; var hot = window.__office.state().stations.filter(function(x){ return /^hot/.test(x.station); }); var roleOk = hot.every(function(x){ return x.role && x.role.indexOf(m.kinds[x.kind].rolePrefix) === 0; }); var propOk = hot.every(function(x){ var d = m.props[m.kinds[x.kind].prop]; return !!d && (x.deskImage || "").indexOf(d.image) >= 0; }); var kinds = Array.from(new Set(hot.map(function(x){ return x.kind; }))); return { roleOk: roleOk, propOk: propOk, n: kinds.length, roles: hot.map(function(x){ return x.station + ":" + x.role; }), desks: hot.map(function(x){ return x.station + ":" + x.deskImage; }) }; })()');
  check('demo=crowd hot desks: every role starts with its kind rolePrefix', kindInfo && kindInfo.roleOk, JSON.stringify(kindInfo && kindInfo.roles));
  check('demo=crowd hot desks: every desk image is that kind prop', kindInfo && kindInfo.propOk, JSON.stringify(kindInfo && kindInfo.desks));
  check('demo=crowd hot desks show at least 3 different kinds', kindInfo && kindInfo.n >= 3, JSON.stringify(kindInfo && kindInfo.n));
  await shot('8-crowd');
  await shot('9-kinds');

  await ev('window.__office.press("cli-dx")'); await wait(300);
  s = await st();
  check('demo=crowd clicking a hot worker opens its window', s.window.open && s.window.laneId === 'cli-dx', s.window.laneId);
  check('demo=crowd window carries the lane kind', s.window.kind === 'code', String(s.window.kind));
  check('demo=crowd puts the suggested action first for the stalled lane', s.window.suggest === 'kick' && s.window.actions[0] === 'kick', s.window.actions.join(','));
  await ev('window.__office.press("mcp")'); await wait(250);
  s = await st();
  check('demo=crowd puts the suggested action first for the failed lane', s.window.open && s.window.laneId === 'mcp' && s.window.suggest === 'resume' && s.window.actions[0] === 'resume', s.window.actions.join(','));
  await ev('window.__office.press("mcp")'); await wait(200);

  await size(390, 844); await wait(600);
  s = await st();
  const crowdPill = await ev('(function(){ var p = document.getElementById("ovPill"); return { hidden: p.hidden, text: p.textContent, inBar: getComputedStyle(document.getElementById("overflow")).left === "0px" }; })()');
  check('demo=crowd pill stays visible as a bar when narrow', crowdPill && crowdPill.hidden === false && crowdPill.text === '+2 more', JSON.stringify(crowdPill));
  const scrollCrowd = await ev('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)');
  check('demo=crowd no horizontal overflow at 390 px', scrollCrowd <= 391, String(scrollCrowd));
  await shot('8-crowd-phone');
  await size(1280, 800); await wait(400);

  await send('Page.navigate', { url: base + '/office?demo=stuck&still=1' }); await wait(1800);
  s = await stReady();
  check('demo=stuck: builder STALLED, artist running, reviewer failed',
    s.lanes.find((l) => l.id === 'office-scene')?.health === 'STALLED' &&
    s.lanes.find((l) => l.id === 'office-sprites')?.running === true &&
    s.lanes.find((l) => l.id === 'office-review')?.health === 'failed',
    s.lanes.map((l) => `${l.id}:${l.health}`).join(' '));
  check('demo=stuck: stations suggest kick and resume, artist none',
    s.stations.find((x) => x.station === 'builder')?.suggest === 'kick' &&
    s.stations.find((x) => x.station === 'artist')?.suggest === '' &&
    s.stations.find((x) => x.station === 'reviewer')?.suggest === 'resume',
    s.stations.map((x) => `${x.station}:${x.suggest}`).join(' '));
  const bb = await ev('(function(){ var b = document.querySelector("#plate-builder .p-badge"); var r = b.getBoundingClientRect(); return { hidden: b.hidden, title: b.title, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  check('builder nameplate has the attention badge with the why', !!bb && bb.hidden === false && bb.title === 'no model activity for 6m', JSON.stringify(bb));
  await click(bb.x, bb.y); await wait(300);
  s = await st();
  check('badge click opens the builder window', s.window.open && s.window.laneId === 'office-scene', s.window.laneId);
  check('first control is the suggested kick', s.window.suggest === 'kick' && s.window.actions[0] === 'kick' && s.window.actions.join(',') === 'kick,fresh,restart-server,attach,stop', s.window.actions.join(','));
  const kickBtn = await ev('(function(){ var b = document.querySelector("#winBtns .ctl-btn"); var r = b.getBoundingClientRect(); return { action: b.dataset.action, cls: b.className, label: b.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  check('kick button is primary and labeled Retry turn', kickBtn.action === 'kick' && /primary/.test(kickBtn.cls) && kickBtn.label === 'Retry turn', JSON.stringify(kickBtn));
  check('why text shows under the controls row', (await ev('document.getElementById("winWhy").hidden')) === false && (await ev('document.getElementById("winWhy").textContent')) === 'no model activity for 6m');
  await shot('7-stuck-controls');
  await click(kickBtn.x, kickBtn.y); await wait(250);
  s = await st();
  check('Retry turn opens the note box', s.window.noteOpen === true, String(s.window.noteOpen));
  await ev('document.getElementById("noteText").focus()');
  await send('Input.insertText', { text: 'pick up at the data layer step' });
  const noteSend = await ev('(function(){ var b = document.getElementById("noteSend"); var r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await click(noteSend.x, noteSend.y); await wait(300);
  s = await st();
  const kickLog = s.controls[s.controls.length - 1];
  check('Send logs a kick with mode turn and the typed note', s.controls.length === 1 && kickLog?.laneId === 'office-scene' && kickLog?.action === 'kick' && kickLog?.body?.mode === 'turn' && kickLog?.body?.text === 'pick up at the data layer step', JSON.stringify(s.controls));
  check('note box closes after Send', s.window.noteOpen === false, String(s.window.noteOpen));
  check('toast confirms the control', (await ev('document.getElementById("toast").hidden')) === false && (await ev('document.getElementById("toast").textContent')) === 'Retry turn sent (demo)');

  await ev('window.__office.press("office-review")'); await wait(300);
  s = await st();
  check('reviewer window offers Resume', s.window.open && s.window.laneId === 'office-review' && s.window.actions.join(',') === 'resume', s.window.actions.join(','));
  const resBtn = await ev('(function(){ var b = document.querySelector("#winBtns .ctl-btn"); var r = b.getBoundingClientRect(); return { action: b.dataset.action, cls: b.className, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  check('Resume is the primary control', resBtn.action === 'resume' && /primary/.test(resBtn.cls), JSON.stringify(resBtn));
  await click(resBtn.x, resBtn.y); await wait(250);
  s = await st();
  check('Resume opens the note box', s.window.noteOpen === true, String(s.window.noteOpen));
  await ev('document.getElementById("noteText").focus()');
  await send('Input.insertText', { text: 'resume after the transport failures' });
  const noteSend2 = await ev('(function(){ var b = document.getElementById("noteSend"); var r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await click(noteSend2.x, noteSend2.y); await wait(300);
  s = await st();
  const resLog = s.controls[s.controls.length - 1];
  check('Resume note logs body.note', s.controls.length === 2 && resLog?.laneId === 'office-review' && resLog?.action === 'resume' && resLog?.body?.note === 'resume after the transport failures' && resLog?.body?.mode === undefined, JSON.stringify(s.controls));
  check('window token total equals the sum of the three agent parts', s.window.tokens && s.window.tokens.total === s.window.tokens.build + s.window.tokens.review + s.window.tokens.other, JSON.stringify(s.window.tokens));
  const chip = await ev('(function(){ var c = document.getElementById("tokenChip"); return { hidden: c.hidden, text: c.textContent, label: c.getAttribute("aria-label") || "" }; })()');
  check('top bar shows the plan token total', chip && chip.hidden === false && chip.text === 'Tokens ' + fmtTokens(s.planTokens) && chip.text === 'Tokens 1.24M', `${chip?.text} planTokens=${s.planTokens}`);
  check('token chip label carries the by-agent split', /^Tokens [\d.]+[kM]?: Builder [\d.]+[kM]?, Reviewer [\d.]+[kM]?, Hidden sessions [\d.]+[kM]?/.test(chip.label), chip.label);
  await ev('document.getElementById("tokenChip").dispatchEvent(new MouseEvent("mouseenter"))');
  const card = await ev('(function(){ var c = document.getElementById("hoverCard"); var r = c.getBoundingClientRect(); return { hidden: c.hidden, text: c.innerText, w: r.width, left: r.left, right: r.right, vw: innerWidth }; })()');
  check('hovering the token chip opens the styled token card', card && !card.hidden && /Builder/.test(card.text) && /Reviewer/.test(card.text) && card.left >= 0 && card.right <= card.vw, JSON.stringify(card));
  await ev('document.getElementById("tokenChip").dispatchEvent(new MouseEvent("mouseleave"))');
  check('leaving the token chip hides the card', await ev('document.getElementById("hoverCard").hidden'));

  await ev('window.__office.press("office-sprites")'); await wait(300);
  s = await st();
  check('quick steer chips render for a running lane', s.quickSteers === 5, String(s.quickSteers));
  const qchip = await ev('(function(){ var b = document.querySelector("#winChips .qchip"); var r = b.getBoundingClientRect(); return { text: b.title, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await click(qchip.x, qchip.y); await wait(200);
  const draftVal = await ev('document.getElementById("winInput").value');
  check('a quick chip fills the steer draft without sending', draftVal === qchip.text && (await st()).controls.length === 2, `${String(draftVal).slice(0, 40)}...`);
  s = await st();
  check('nameplates do not overlap with token counts', noOverlap(s));
  await size(390, 844); await wait(600);
  const scrollW = await ev('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)');
  check('no horizontal overflow at 390 px', scrollW <= 391, String(scrollW));
  await size(1280, 800); await wait(400);

  await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(5000);
  s = await st();
  check('timeline assignment starts the builder lane', s.lanes.find((l) => l.id === 'office-scene')?.running === true);
  check('timeline press opens the builder window', s.window.open && s.window.laneId === 'office-scene', s.window.laneId);
  for (let i = 0; i < 40; i++) { await wait(250); s = await st(); if (s.effects.some((e) => e.type === 'step' && e.laneId === 'office-scene')) break; } // poll: slow CI runners
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
