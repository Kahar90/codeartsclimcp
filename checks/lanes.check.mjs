// End-to-end check for the Lanes dashboard: starts `ca dash` on a free port, drives /?demo=1 in headless Chrome over CDP.
// Usage: node checks/lanes.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
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
const profile = path.join(process.env.TEMP || ROOT, `ca-lanes-profile-${Date.now()}`);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
const timer = setTimeout(() => { console.log('FAIL timeout after 120 s'); cleanup(); process.exit(1); }, 120000);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const st = () => ev('window.__lanes && window.__lanes.state()');
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');

  await size(1280, 800); await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1800);
  const text = await ev('document.body.innerText');
  check('demo fixture renders the first plan', /Office view polish: sprites and layout/.test(text || ''));
  check('demo counts render', /2 plans/.test(text || ''), (text || '').split('\n')[0]);
  const railJ = JSON.parse(await ev('(function(){return JSON.stringify({plans:document.querySelectorAll("#railBody .rail-card").length,fin:document.querySelectorAll("#railBody .rail-fin").length});})()') || '{}');
  check('rail lists 2 plans and 5 finished lanes', railJ.plans === 2 && railJ.fin === 5, JSON.stringify(railJ));
  const laneHref = await ev('document.querySelector(".lane-name")?.getAttribute("href")');
  check('lane card links to the lane route', laneHref === '#/lane/demo-repo--office-layout', String(laneHref));
  check('plan home renders one wave', (await ev('document.querySelectorAll(".wave").length')) === 1);
  check('wave spans the full content width', (await ev('(function(){const w=document.querySelector(".wave"),p=document.querySelector(".pad"),cs=getComputedStyle(p);return w.offsetWidth===p.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);})()')) === true);
  const cur = await ev('document.querySelector(".curband")?.innerText || ""');
  check('current step band shows step 1 of 7', /current step 1\/7/i.test(cur) && /Demo fixture/.test(cur), cur.slice(0, 90));
  check('current step band shows file chips', (await ev('document.querySelectorAll(".curband .chip").length')) === 2);
  check('lead and lane sprites mounted', (await ev('document.querySelectorAll(".px-sprite:not(.px-fallback)").length')) === 2);
  check('decisions log lists entries', (await ev('document.querySelectorAll(".dec li").length')) === 3);
  check('no horizontal overflow on the plan home', (await ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true);
  await shot('lanes-home');
  const hash0 = await ev('location.hash');
  const pt = JSON.parse(await ev('(function(){const b=document.querySelector("[data-steps]");if(!b)return "{}";const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()') || '{}');
  if (pt.x != null) { await click(pt.x, pt.y); await wait(400); }
  const opened = JSON.parse(await ev('(function(){const b=document.querySelector("[data-steps]");return JSON.stringify({hash:location.hash,open:b?b.getAttribute("aria-expanded"):"",items:document.querySelectorAll(".steplist li").length});})()') || '{}');
  check('step disclosure opens without route change', opened.hash === hash0 && opened.open === 'true' && opened.items === 7, JSON.stringify(opened));
  await ev('document.querySelector(".lane-name").click()'); await wait(900);
  const det = JSON.parse(await ev('(function(){return JSON.stringify({hash:location.hash,back:document.querySelector(".backlink")?.getAttribute("href"),h1:document.querySelector(".idrow h1")?.innerText,metrics:document.querySelectorAll(".metrics .m").length,mtokens:document.querySelector(".metrics")?.innerText||"",segs:document.querySelectorAll(".seg").length,now:document.querySelector(".nowband")?.innerText||"",steps:document.querySelectorAll(".steprow").length,ctx:document.querySelectorAll(".ctxrow").length,sprite:document.querySelectorAll(".px-sprite:not(.px-fallback)").length});})()') || '{}');
  check('lane detail renders identity, metrics and context', det.hash === '#/lane/demo-repo--office-layout' && det.back === '#/plan/office-polish' && det.h1 === 'office-layout' && det.metrics === 7 && det.segs === 5 && det.steps === 7 && det.ctx === 3 && det.sprite === 1, JSON.stringify(det));
  check('metrics format thousands and n/a', /52,764 in \/ 202 out/.test(det.mtokens) && /Build/.test(det.mtokens), det.mtokens.slice(0, 120));
  check('now band shows the current step', /Step 1/.test(det.now), det.now.slice(0, 80));
  const cpt = JSON.parse(await ev('(function(){const b=document.querySelector("[data-ctx=gates]");if(!b)return "{}";const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()') || '{}');
  if (cpt.x != null) { await click(cpt.x, cpt.y); await wait(200); }
  check('lane context row expands', (await ev('(function(){const b=document.querySelector("[data-ctx=gates]");const body=b.parentElement.querySelector(".ctxbody");return b.getAttribute("aria-expanded")==="true" && body.style.display!=="none" && body.innerText.length>0;})()')) === true);
  await ev('history.back()'); await wait(700);
  check('history.back returns to the plan', (await ev('location.hash')) === hash0);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
