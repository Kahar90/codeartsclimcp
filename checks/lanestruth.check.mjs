// Check for the one-truth status surfaces on the Lanes view: starts `ca dash` on a free port and drives
// ?demo=1&closed=1 in headless Chrome over CDP. Asserts that a plan's pill word always equals its glance
// banner word, that a lane's step bar follows status.steps (live / complete / hide), that the Needs you
// count equals the attention lanes, and that the Glance toggle hides the banner on both routes and
// survives a reload. Usage: node checks/lanestruth.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP lanestruth: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('lanestruth');
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
  const keyG = () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, text: 'g' }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 }));
  const bannerWord = () => ev('(function(){const el=document.querySelector("#glanceBanner .glance-word");return el?el.textContent.trim():null;})()');
  const pillWord = () => ev('(function(){const el=document.querySelector(".plan-sub .ca-badge");if(!el)return null;const g=el.querySelector(".gb");return (g?el.textContent.slice(g.textContent.length):el.textContent).trim();})()');
  const cardSteps = (laneId) => ev(`(function(){const a=document.querySelector('.lane-name[href="#/lane/${laneId}"]');if(!a)return "no-card";const c=a.closest(".lane-card");const s=c&&c.querySelector(".lane-steps");return s?{text:s.textContent.trim(),prog:!!s.querySelector(".prog"),w:s.querySelector(".prog i")?s.querySelector(".prog i").getAttribute("style"):""}:null;})()`);
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await size(1280, 800);

  // ---------- Control room: the Needs you count equals the attention lanes; the title count too ----------
  await send('Page.navigate', { url: base + '/?demo=1&closed=1' }); await wait(1700);
  const cr = await ev('window.__lanes.state()');
  const tileN = await ev('(function(){const t=document.querySelector(".crtile[data-cr=\\"attention\\"] .crn");return t?Number(t.textContent):null;})()');
  const attnRows = await ev('document.querySelectorAll(".cr-sec[data-bucket=\\"attention\\"] .cr-row[data-lane]").length');
  check('the Needs you tile shows the attention lane count', tileN === 5 && attnRows === 5, JSON.stringify({ tileN, attnRows }));
  check('the overview count matches the tile and the attention section', cr?.overview?.counts?.attention === tileN && cr.overview.counts.attention === attnRows, JSON.stringify(cr?.overview?.counts));
  check('the tab title carries the Needs you count', /^\(5\) Needs you . Lanes$/.test(cr?.overview?.title || ''), cr?.overview?.title);
  check('the closed plan adds no attention lane', cr?.overview?.counts?.running === 2 && cr?.overview?.counts?.done === 2 && cr?.overview?.counts?.ended === 6, JSON.stringify(cr?.overview?.counts));
  // Every rail row and plan badge carries the status glyph.
  const railJ = JSON.parse(await ev('(function(){const rows=[...document.querySelectorAll("#railBody .rail-fin")];const plans=[...document.querySelectorAll("#railBody [data-go^=\\"plan/\\"]")];return JSON.stringify({fin:rows.length,finGlyph:rows.filter(r=>r.querySelector(".ca-badge .gb")).length,plans:plans.length,planGlyph:plans.filter(r=>r.querySelector(".ca-badge .gb")).length});})()') || '{}');
  check('the rail lists 9 finished lanes, each with a status glyph', railJ.fin === 9 && railJ.finGlyph === 9, JSON.stringify(railJ));
  check('every plan rail badge shows its glyph', railJ.plans === 3 && railJ.planGlyph === 3, JSON.stringify(railJ));
  await shot('lanestruth-control-room');

  // ---------- the plan pill word equals the banner word on every demo plan ----------
  const planIds = JSON.parse(await ev('JSON.stringify([...document.querySelectorAll("#railBody [data-go^=\\"plan/\\"]")].map(a=>a.dataset.go.slice(5)))') || '[]');
  check('the demo shows three plans under ?closed', planIds.length === 3 && planIds.includes('glance-status'), JSON.stringify(planIds));
  for (const pid of planIds) {
    await send('Page.navigate', { url: `${base}/?demo=1&closed=1#/plan/${pid}` }); await wait(1300);
    const bw = await bannerWord(), pw = await pillWord();
    check(`plan ${pid}: the pill word equals the banner word`, !!bw && bw === pw, JSON.stringify({ banner: bw, pill: pw }));
  }

  // ---------- lane truth on the closed plan: a full bar only when every step is done ----------
  await send('Page.navigate', { url: base + '/?demo=1&closed=1#/plan/glance-status' }); await wait(1400);
  const merged = await cardSteps('demo-repo--glance-merged');
  check('a fully done merged lane shows a full step bar with a check', !!merged && merged.prog === true && /6\/6/.test(merged.text) && /width:\s*100%/.test(merged.w), JSON.stringify(merged));
  const handled = await cardSteps('demo-repo--glance-handled');
  check('a merged/handled lane with open steps shows its true fraction, not a forced full bar', !!handled && handled.prog === true && /1\/3/.test(handled.text) && !/width:\s*100%/.test(handled.w), JSON.stringify(handled));
  const stopped = await cardSteps('demo-repo--glance-stopped');
  check('a stopped lane with open steps shows its true fraction', !!stopped && stopped.prog === true && /0\/2/.test(stopped.text) && !/width:\s*100%/.test(stopped.w), JSON.stringify(stopped));
  await shot('lanestruth-plan-closed');
  // the same lane still lists its steps on the lane detail page
  await send('Page.navigate', { url: base + '/?demo=1&closed=1#/lane/demo-repo--glance-handled' }); await wait(1300);
  const stepRows = await ev('document.querySelectorAll(".steprow").length');
  check('the handled lane detail page still lists its steps', stepRows === 3, String(stepRows));

  // ---------- the Glance toggle: hides the banner on the plan home, survives a reload ----------
  await send('Page.navigate', { url: base + '/?demo=1&closed=1#/plan/office-polish' }); await wait(1400);
  let g = await ev('window.__lanes.glance()');
  check('the glance banner starts on with the toggle pressed', (await bannerWord()) === 'Working' && g.glanceOn === true && (await ev('document.getElementById("glanceBtn").getAttribute("aria-pressed")')) === 'true', JSON.stringify({ bw: await bannerWord(), glanceOn: g.glanceOn }));
  await shot('lanestruth-glance-on');
  check('the Glance toggle is clickable', await clickSel('#glanceBtn'));
  await wait(500);
  g = await ev('window.__lanes.glance()');
  check('turning Glance off hides the banner but keeps the title and favicon', (await ev('!document.getElementById("glanceBanner")')) === true && g.glanceOn === false && (await ev('document.getElementById("glanceBtn").getAttribute("aria-pressed")')) === 'false' && /Working/.test(g.title || '') && String(g.favicon).startsWith('data:image/png'), JSON.stringify({ hasBanner: await ev('!!document.getElementById("glanceBanner")'), glanceOn: g.glanceOn, title: g.title }));
  await shot('lanestruth-glance-off');
  await send('Page.reload'); await wait(1500);
  g = await ev('window.__lanes.glance()');
  check('the off choice survives a reload and still hides the banner', g.glanceOn === false && (await ev('!document.getElementById("glanceBanner")')) === true, JSON.stringify({ glanceOn: g.glanceOn, hasBanner: await ev('!!document.getElementById("glanceBanner")') }));
  await keyG(); await wait(500);
  g = await ev('window.__lanes.glance()');
  check('the g key turns Glance back on', g.glanceOn === true && (await bannerWord()) === 'Working', JSON.stringify({ glanceOn: g.glanceOn, bw: await bannerWord() }));

  // ---------- the same toggle hides the Control room banner ----------
  await send('Page.navigate', { url: base + '/?demo=1&closed=1' }); await wait(1600);
  check('the Control room banner shows while Glance is on', (await bannerWord()) === 'Needs you', String(await bannerWord()));
  check('the Control room Glance toggle is clickable', await clickSel('#glanceBtn'));
  await wait(500);
  check('turning Glance off hides the Control room banner', (await ev('!document.getElementById("glanceBanner")')) === true && (await ev('window.__lanes.glance().glanceOn')) === false, String(await ev('!!document.getElementById("glanceBanner")')));
  await ev('try{localStorage.removeItem("ca.glance")}catch{}');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
