// End-to-end check for poll-driven renders: a poll must never rebuild a region whose output did not
// change, so a hover card, a title tooltip, the plan menu and the selection survive the 2 s (Office)
// and 2.5 s (Lanes) polls. Starts `ca dash` on a free port, drives /office?demo=1 and /?demo=1 in
// headless Chrome over CDP and reads the window.__office.renders() / window.__lanes.renders() counters.
// Usage: node checks/hover.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP hover: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('hover');
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null;
const finish = (code) => settle({ socket: sock, children: [chrome, dash], code });
guard({ children: [chrome, dash] });
const timer = setTimeout(() => { console.log('FAIL timeout after 300 s'); finish(1); }, 300000);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const rect = (sel) => ev(`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
  const waitFor = async (fn, tries = 30) => { let v; for (let i = 0; i < tries && !v; i++) { v = await fn(); if (!v) await wait(300); } return v; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await send('Runtime.enable');
  // CI runners often have system animations off (prefers-reduced-motion: reduce): pin motion on so the
  // polls are deterministic; the reduced-motion path is covered by the office and lanes checks.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await size(1280, 800);

  // ---------- Office: a hover card survives the 2 s poll ----------
  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1500);
  const officeReady = await waitFor(() => ev('!!(window.__office && window.__office.renders && window.__office.state && window.__office.state().mode === "demo")'));
  check('the Office page and its renders hook are ready', officeReady === true);
  const chip = await rect('#tokenChip');
  check('the Office token chip is visible in demo', !!chip && chip.w > 0, JSON.stringify(chip));
  if (chip) {
    await move(chip.x, chip.y); await wait(300);
    let shown = await ev('!document.getElementById("hoverCard").hidden');
    if (!shown) { await move(chip.x, chip.y); await wait(300); shown = await ev('!document.getElementById("hoverCard").hidden'); }
    if (!shown) { await ev('document.getElementById("tokenChip").dispatchEvent(new MouseEvent("mouseenter"))'); await wait(200); shown = await ev('!document.getElementById("hoverCard").hidden'); }
    check('hovering the token chip opens the hover card', shown === true);
    await ev('(function(){var el=document.getElementById("tokenChip");el.__tag="hov-"+Math.random().toString(36).slice(2);})()');
    const tagBefore = await ev('document.getElementById("tokenChip").__tag');
    const before = await ev('window.__office.renders()');
    await wait(7000);
    const tagAfter = await ev('document.getElementById("tokenChip").__tag');
    const after = await ev('window.__office.renders()');
    check('the hover card is still open after three Office polls', (await ev('!document.getElementById("hoverCard").hidden')) === true);
    check('the hovered token chip is the same DOM node after three Office polls', !!tagBefore && tagAfter === tagBefore, `${tagBefore} vs ${tagAfter}`);
    check('the token chip keeps its tooltip title across Office polls', String(await ev('document.getElementById("tokenChip").title || ""')).length > 0);
    check('Office hover polls rebuild no region', same(before, after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await shot('hover-office-card');
    await ev('document.getElementById("tokenChip").dispatchEvent(new MouseEvent("mouseleave"))');
  }

  // ---------- Office: the open plan menu survives the 2 s poll ----------
  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1500);
  await waitFor(() => ev('!!(window.__office && window.__office.renders)'));
  const pbtn = await rect('#planBtn');
  check('the plan button is visible in demo', !!pbtn && pbtn.w > 0, JSON.stringify(pbtn));
  if (pbtn) {
    await click(pbtn.x, pbtn.y); await wait(300);
    const open = await ev('!document.getElementById("planMenu").hidden');
    check('the plan button opens the plan menu', open === true);
    if (open) {
      await ev('(function(){var m=document.getElementById("planMenu");m.__tag="pm-"+Math.random().toString(36).slice(2);})()');
      const menuTag = await ev('document.getElementById("planMenu").__tag');
      const active0 = await ev('document.getElementById("planMenu").getAttribute("aria-activedescendant")');
      const before = await ev('window.__office.renders()');
      await wait(7000);
      const menuTagAfter = await ev('document.getElementById("planMenu").__tag');
      const after = await ev('window.__office.renders()');
      const activeNow = await ev('document.getElementById("planMenu").getAttribute("aria-activedescendant")');
      check('the plan menu is still open after three Office polls', (await ev('!document.getElementById("planMenu").hidden')) === true);
      check('the plan menu is the same DOM node after three Office polls', !!menuTag && menuTagAfter === menuTag, `${menuTag} vs ${menuTagAfter}`);
      check('the plan menu keeps its active item across Office polls', activeNow === active0, `${active0} vs ${activeNow}`);
      check('Office plan menu polls rebuild no region', same(before, after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      await shot('hover-office-menu');
      await ev('document.getElementById("planBtn").click()');
    }
  }

  // ---------- Office: the running lane's current step shows the CSS spinner (Bug C) ----------
  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(1500);
  await waitFor(() => ev('!!(window.__office && window.__office.state)'));
  await ev('window.__office.press("office-review")'); await wait(400);
  const spinAnim = await ev('(function(){var e=document.querySelector("#winSteps .st-current .st-spin");return e?getComputedStyle(e).animationName:null;})()');
  check('the running lane shows a spinner on its current step', String(spinAnim || '').indexOf('spin') >= 0, String(spinAnim));
  await ev('window.__office.press("office-scene")'); await wait(300);
  const staticMark = await ev('(function(){var e=document.querySelector("#winSteps .st-current .mark");if(!e)return null;return e.querySelector(".st-spin")?"spin":e.textContent;})()');
  check('a non-running lane keeps a static current-step mark', staticMark === '\u25cf', JSON.stringify(staticMark));
  await shot('hover-office-spinner');

  // ---------- Lanes: a plan-home token chip survives the 2.5 s poll ----------
  await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1800);
  const lanesReady = await waitFor(() => ev('!!(window.__lanes && window.__lanes.renders && document.querySelector(".plan-tok"))'));
  check('the Lanes plan home and its renders hook are ready', lanesReady === true);
  const tchip = await rect('.plan-tok');
  check('the plan token chip renders on the Lanes plan home', !!tchip && tchip.w > 0, JSON.stringify(tchip));
  if (tchip) {
    await move(tchip.x, tchip.y); await wait(200);
    await ev('(function(){var el=document.querySelector(".plan-tok");el.__tag="tk-"+Math.random().toString(36).slice(2);})()');
    const ttag = await ev('document.querySelector(".plan-tok").__tag');
    const before = await ev('window.__lanes.renders()');
    await wait(7000);
    const ttagAfter = await ev('document.querySelector(".plan-tok").__tag');
    const after = await ev('window.__lanes.renders()');
    check('the Lanes token chip is the same DOM node after three polls', !!ttag && ttagAfter === ttag, `${ttag} vs ${ttagAfter}`);
    check('the Lanes token chip keeps its tooltip title across polls', String(await ev('document.querySelector(".plan-tok").title || ""')).length > 0);
    check('Lanes plan polls rebuild neither the rail nor the view', same(before, after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await shot('hover-lanes-tokens');
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
