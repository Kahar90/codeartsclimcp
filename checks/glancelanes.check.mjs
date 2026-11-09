// Check for the Lanes glance surfaces: starts `ca dash` on a free port and drives ?demo=1 in headless
// Chrome over CDP. Asserts the banner state on both routes, the ?glance= overrides, the tab title
// prefix, a data: favicon and the one-shot plan-glance notification.
// Usage: node checks/glancelanes.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP glancelanes: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('glancelanes');
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
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const clickSel = async (sel) => {
    const c = await ev(`(function(){const el=document.querySelector('${sel}');if(!el)return null;const r=el.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const over=(cx>=0&&cy>=0&&cx<=innerWidth&&cy<=innerHeight)?document.elementFromPoint(cx,cy):null;const clear=!!over&&(over===el||el.contains(over));if(!clear)el.scrollIntoView({block:'center',inline:'center'});const r2=el.getBoundingClientRect();return {x:r2.left+r2.width/2,y:r2.top+r2.height/2};})()`);
    if (!c) return false; await click(c.x, c.y); return true;
  };
  const banner = () => ev('(function(){const b=document.getElementById("glanceBanner");if(!b)return null;const cs=getComputedStyle(b);return {state:b.dataset.state,word:b.querySelector(".glance-word")?.textContent||"",detail:b.querySelector(".glance-detail")?.textContent||"",role:b.getAttribute("role"),live:b.getAttribute("aria-live"),stripe:cs.borderLeftWidth,bg:cs.backgroundColor,wordSize:getComputedStyle(b.querySelector(".glance-word")).fontSize,link:b.querySelector(".glance-link")?.getAttribute("href")||"",track:!!b.querySelector(".glance-track")};})()');
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await size(1280, 800);

  // ---------- Control room: the worst open glance, needs-you, with the plan link ----------
  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1600);
  let b = await banner();
  check('the Control room banner shows the worst open glance, needs-you', !!b && b.state === 'needs-you' && b.word === 'Needs you', JSON.stringify(b && { state: b.state, word: b.word }));
  check('the banner is a polite status region', !!b && b.role === 'status' && b.live === 'polite', JSON.stringify(b && { role: b.role, live: b.live }));
  check('the banner carries the 6 px state stripe and a soft tint', !!b && b.stripe === '6px' && b.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(b && { stripe: b.stripe, bg: b.bg }));
  check('the banner word is large and bold (28 px)', !!b && b.wordSize === '28px', b && b.wordSize);
  check('the Control room banner links to the worst plan', !!b && b.link === '#/plan/string-utils', b && b.link);
  await shot('glance-lanes-needs-you');

  // ---------- plan home: the plan's own glance, working, with the lanes bar ----------
  await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1600);
  b = await banner();
  check('the plan home banner shows the plan glance, working', !!b && b.state === 'working' && b.word === 'Working', JSON.stringify(b && { state: b.state, word: b.word }));
  check('a working glance draws the thin lanes bar', !!b && b.track === true, JSON.stringify(b && { track: b.track }));
  check('the plans rail puts a glance dot before each plan name', (await ev('document.querySelectorAll("#railBody .glance-dot").length')) === 2, String(await ev('document.querySelectorAll("#railBody .glance-dot").length')));
  // The banner must not push a required control (the lane step disclosure) off the fold: lanes.check
  // clicks it with viewport coordinates, so keep it on screen.
  const stepGeom = await ev('(function(){const b=document.querySelector("[data-steps]");const r=b.getBoundingClientRect();const h=document.querySelector("#glanceBanner");const hr=h&&h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:Math.round(r.top),ih:innerHeight,bannerH:hr&&Math.round(hr.height)};})()');
  check('the plan banner keeps the first step disclosure on screen', !!stepGeom && stepGeom.y > 0 && stepGeom.y < stepGeom.ih, JSON.stringify(stepGeom));
  await click(stepGeom.x, stepGeom.y); await wait(400);
  check('a raw viewport click still opens the step disclosure under the banner', (await ev('document.querySelector("[data-steps]").getAttribute("aria-expanded")')) === 'true');
  await shot('glance-lanes-working');

  // ---------- the ?glance= override forces the first plan's glance ----------
  for (const st of ['done', 'failed', 'quiet']) {
    await send('Page.navigate', { url: `${base}/?demo=1&glance=${st}#/plan/office-polish` }); await wait(1500);
    b = await banner();
    check(`the glance=${st} override shows on the banner`, !!b && b.state === st, JSON.stringify(b && { state: b.state, word: b.word }));
    await shot(`glance-lanes-${st}`);
  }

  // ---------- tab title prefix and the data: favicon ----------
  await send('Page.navigate', { url: base + '/?demo=1#/plan/string-utils' }); await wait(1500);
  let t = await ev('document.title');
  check('the plan home title starts with the needs-you glyph and count', /^! Needs you \(\d+\) - String utils for sandbox$/.test(t || ''), t);
  check('the favicon is a data: PNG drawn from the glance', (await ev('(document.querySelector(\'link[rel="icon"]\')?.href || "").startsWith("data:image/png")')) === true, String(await ev('document.querySelector(\'link[rel="icon"]\')?.href || ""')).slice(0, 30));
  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1500);
  t = await ev('document.title');
  check('the Control room title shows the worst open plan with its count', /^! Needs you \(\d+\) - String utils for sandbox$/.test(t || ''), t);
  const g = await ev('window.__lanes.glance()');
  check('window.__lanes.glance() returns state, word, detail, title and favicon', !!g && g.state === 'needs-you' && g.word === 'Needs you' && typeof g.detail === 'string' && g.title === t && String(g.favicon).startsWith('data:image/png'), JSON.stringify(g && { state: g.state, word: g.word, title: g.title, favicon: String(g.favicon).slice(0, 20) }));

  // ---------- one notification when a plan's glance turns done, never on first load ----------
  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1400);
  await ev('(function(){window.__notes=[];function N(t,o){window.__notes.push({title:t,tag:o&&o.tag});}N.permission="granted";try{window.Notification=N;}catch(e){}return true;})()');
  check('the notification stub is installed', (await ev('typeof window.Notification === "function" && window.Notification.permission === "granted"')) === true);
  check('the Notify button turns on', await clickSel('#notify'));
  await wait(400);
  check('Notify reads as on', (await ev('document.getElementById("notify").getAttribute("aria-pressed")')) === 'true', String(await ev('document.getElementById("notify").getAttribute("aria-pressed")')));
  await wait(3200); // one poll with Notify on but no glance change
  check('no notification on the first poll after enabling Notify', ((await ev('window.__notes.length')) || 0) === 0, JSON.stringify(await ev('window.__notes')));
  await ev('history.replaceState(null, "", "?demo=1&glance=done")');
  let notes = null;
  for (let i = 0; i < 44 && !(notes && notes.length); i++) { await wait(250); notes = await ev('window.__notes'); }
  check('a forced glance change from working to done fires one notification tagged by plan and state', Array.isArray(notes) && notes.length === 1 && notes[0].tag === 'office-polish:done', JSON.stringify(notes));
  await size(390, 844); await wait(300);
  check('no horizontal overflow on the phone plan home with a banner', (await ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
