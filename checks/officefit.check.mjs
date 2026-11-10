// End-to-end check for the Office view fit and one-truth status work: the room fills the stage (it
// covers the stage, or the blurred #roomfill backs any leftover), every
// station sprite and label inside the stage, the sign covering none of them, the header pill matching the
// sign, the glance toggle, and the server-shaped lane clips. Starts `ca dash`, drives /office in headless
// Chrome over CDP. Usage: node checks/officefit.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP officefit: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('officefit');
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null;
const finish = (code) => settle({ socket: sock, children: [chrome, dash], code });
guard({ children: [chrome, dash] });
const timer = setTimeout(() => { console.log('FAIL timeout after 180 s'); finish(1); }, 180000);
// A rect is inside another when its box sits within, allowing one pixel of rounding.
const inside = (r, s, tol = 1) => !!r && !!s && r.x >= s.x - tol && r.y >= s.y - tol && r.x + r.w <= s.x + s.w + tol && r.y + r.h <= s.y + s.h + tol;
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  const page = await fetch(base + '/office'); const html = await page.text();
  check('GET /office serves the page', page.ok && /glanceToggle/.test(html) && /glanceSign/.test(html), String(page.status));

  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const nav = async (url) => { await send('Page.navigate', { url }); await wait(1800); };
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const layout = () => ev('window.__office && window.__office.layout()');
  const glance = () => ev('window.__office && window.__office.glance()');
  const state = () => ev('window.__office && window.__office.state()');
  const surf = () => ev(`(function(){var s=document.getElementById("glanceSign"),g=document.getElementById("glanceGlow"),b=document.getElementById("glanceBubble");return { sign:!!(s&&!s.hidden), glow:!!(g&&!g.hidden), bubble:!!(b&&!b.hidden) };})()`);
  // The blurred room copy that backs any stage area the room cannot cover, so no flat dark band shows.
  const fillShown = () => ev('(function(){var f=document.getElementById("roomfill");if(!f)return false;var r=f.getBoundingClientRect();return getComputedStyle(f).display!=="none"&&r.width>0&&r.height>0;})()');

  // Make sure a previous run's toggle choice cannot hide the sign for the fit shots.
  await nav(base + '/office?demo=1&still=1');
  await ev('localStorage.setItem("ca.glance","on")');

  // Step 1 + 2 + 3: the whole room and every station fit at each desktop size, and the sign clears them.
  const sizes = [[1920, 945], [1536, 864], [1366, 768], [1280, 720], [2560, 1440], [2560, 1080]];
  for (const [w, h] of sizes) {
    await size(w, h);
    await nav(base + '/office?demo=1&still=1');
    const L = await layout();
    if (!L || !L.stage) { check(`${w}x${h}: layout hook`, false, JSON.stringify(L)); continue; }
    const covers = inside(L.stage, L.room);
    if (w / h > 2) {
      // Ultra-wide: covering would push a station off the stage, so the blurred #roomfill backs the leftover.
      check(`${w}x${h}: room covers the stage or #roomfill shows`, covers || (await fillShown()), JSON.stringify({ room: L.room, stage: L.stage }));
    } else {
      check(`${w}x${h}: room covers the stage (no band)`, covers, JSON.stringify({ room: L.room, stage: L.stage }));
    }
    let outCount = 0, badSprites = [], badLabels = [];
    for (const s of L.stations) {
      if (s.sprite && !inside(s.sprite, L.stage)) { badSprites.push(s.station); outCount++; }
      if (s.label && !inside(s.label, L.stage)) { badLabels.push(s.station); outCount++; }
    }
    check(`${w}x${h}: every station sprite and label inside the stage`, outCount === 0, `out:${JSON.stringify(badSprites.concat(badLabels))}`);
    let covered = [];
    if (L.sign) for (const s of L.stations) { if (overlaps(L.sign, s.sprite)) covered.push(s.station + '/sprite'); if (overlaps(L.sign, s.label)) covered.push(s.station + '/label'); }
    check(`${w}x${h}: sign covers no station sprite or label`, L.sign && covered.length === 0, `sign:${!!L.sign} covered:${JSON.stringify(covered)}`);
    await shot(`fit-${w}x${h}`);
  }

  // Step 3: one truth - the header pill word equals the sign word, lanes with open steps show their real
  // fraction (no forced full bar for merged/handled) and a fully done lane shows t/t with a check.
  await size(1280, 800);
  await nav(base + '/office?demo=closed&still=1');
  const gc = await glance();
  const pillWord = await ev('(document.getElementById("statusBadge").textContent||"").replace(/[^A-Za-z ]/g,"").trim()');
  check('demo=closed: sign word Done', !!gc && gc.word === 'Done', gc && String(gc.word));
  check('demo=closed: header pill word equals the sign word', pillWord === (gc && gc.word), `pill:${pillWord} sign:${gc && gc.word}`);
  const sc = await state();
  const partialLanes = new Set((sc && sc.lanes || []).filter((l) => l.steps === 'partial').map((l) => l.id));
  const completeLanes = new Set((sc && sc.lanes || []).filter((l) => l.steps === 'complete').map((l) => l.id));
  // The plate text lives on layout().stations (state().stations has no sub): read it there so this can fail.
  const lc = await ev('window.__office.layout()');
  const partialSubs = [], completeSubs = [];
  for (const s of (lc && lc.stations) || []) {
    if (partialLanes.has(s.laneId)) partialSubs.push({ id: s.laneId, sub: String(s.sub || ''), station: s.station });
    if (completeLanes.has(s.laneId)) completeSubs.push({ id: s.laneId, sub: String(s.sub || ''), station: s.station });
  }
  const shown = partialSubs.filter((x) => /\d+\s*\/\s*\d+/.test(x.sub) || /step\s+\d/i.test(x.sub));
  check('demo=closed: lanes with open steps show their true step fraction', partialSubs.length >= 1 && shown.length === partialSubs.length, JSON.stringify({ partialSubs }));
  check('demo=closed: a fully done lane shows t/t with a check', completeSubs.length >= 1 && completeSubs.every((x) => /8\s*\/\s*8/.test(x.sub)), JSON.stringify({ completeSubs }));
  await shot('fit-closed');

  // Step 4: the glance toggle hides and shows the sign, glow and bubble, keeps title and favicon, survives a reload.
  await nav(base + '/office?demo=done&still=1');
  const g0 = await glance();
  check('toggle: button present with aria-pressed', (await ev('(function(){var b=document.getElementById("glanceToggle");return b?b.getAttribute("aria-pressed"):null;})()')) === 'true');
  check('toggle: glance on by default', !!g0 && g0.glanceOn === true && g0.state === 'done', g0 && JSON.stringify({ on: g0.glanceOn, state: g0.state }));
  const s0 = await surf();
  check('toggle: sign, glow and bubble all shown', !!s0 && s0.sign && s0.glow && s0.bubble, JSON.stringify(s0));
  await ev('document.getElementById("glanceToggle").click()'); await wait(400);
  const s1 = await surf(), g1 = await glance();
  check('toggle: off hides sign, glow and bubble', !!s1 && !s1.sign && !s1.glow && !s1.bubble, JSON.stringify(s1));
  check('toggle: off sets glanceOn false', !!g1 && g1.glanceOn === false, g1 && String(g1.glanceOn));
  check('toggle: off keeps tab title and favicon', !!g1 && g1.title.startsWith('\u2713 Done - ') && /^data:image\//.test(g1.favicon || ''), g1 && g1.title);
  await nav(base + '/office?demo=done&still=1');
  const g2 = await glance(), s2 = await surf();
  check('toggle: choice survives a reload', !!g2 && g2.glanceOn === false && !!s2 && !s2.sign, g2 && JSON.stringify({ on: g2.glanceOn, sign: s2 && s2.sign }));
  await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"g",bubbles:true}))'); await wait(400);
  const g3 = await glance(), s3 = await surf();
  check('toggle: the g key turns it back on', !!g3 && g3.glanceOn === true && !!s3 && s3.sign && s3.glow && s3.bubble, g3 && JSON.stringify({ on: g3.glanceOn, sign: s3 && s3.sign }));
  await ev('localStorage.setItem("ca.glance","on")');

  // Step 5: server-shaped lane statuses pick the clip (work / idle / blocked), not a fallback to idle.
  await nav(base + '/office?demo=clips&still=1');
  const sk = await state();
  const want = { 'office-scene': 'work', 'office-review': 'idle', 'office-sprites': 'blocked' };
  const got = {};
  for (const s of (sk && sk.stations) || []) if (s.laneId && want[s.laneId] !== undefined) got[s.laneId] = s.clip;
  const clipOk = Object.keys(want).every((k) => got[k] === want[k]);
  check('demo=clips: running works, verified idles, stalled blocks', clipOk, JSON.stringify({ want, got }));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
