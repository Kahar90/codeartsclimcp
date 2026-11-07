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
const timer = setTimeout(() => { console.log('FAIL timeout after 300 s'); cleanup(); process.exit(1); }, 300000);
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
  const key = (k, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }));
  const type = (text) => send('Input.insertText', { text });
  const center = (sel) => ev(`(function(){const el=document.querySelector('${sel}');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const clickSel = async (sel) => { const c = await center(sel); if (!c) return false; await click(c.x, c.y); return true; };
  await send('Runtime.enable');

  await size(1280, 800); await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1800);
  const text = await ev('document.body.innerText');
  check('demo fixture renders the first plan', /Office view polish: sprites and layout/.test(text || ''));
  check('demo counts render', /2 plans/.test(text || ''), (text || '').split('\n')[0]);
  const counts = await ev('(function(){const r=document.getElementById("counts").getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),w:window.innerWidth};})()');
  check('top bar counts inside the viewport at 1280x800', !!counts && counts.left >= 0 && counts.right <= counts.w, JSON.stringify(counts));
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
  const det = JSON.parse(await ev('(function(){return JSON.stringify({hash:location.hash,back:document.querySelector(".backlink")?.getAttribute("href"),h1:document.querySelector(".idrow h1")?.innerText,metrics:document.querySelectorAll(".metrics .m").length,mtokens:document.querySelector(".metrics")?.innerText||"",tokTitle:document.querySelector(".metrics .m[title]")?.getAttribute("title")||"",tokRows:document.querySelectorAll(".tokrow").length,segs:document.querySelectorAll(".seg").length,now:document.querySelector(".nowband")?.innerText||"",steps:document.querySelectorAll(".steprow").length,ctx:document.querySelectorAll(".ctxrow").length,sprite:document.querySelectorAll(".px-sprite:not(.px-fallback)").length});})()') || '{}');
  check('lane detail renders identity, metrics and context', det.hash === '#/lane/demo-repo--office-layout' && det.back === '#/plan/office-polish' && det.h1 === 'office-layout' && det.metrics === 7 && det.segs === 5 && det.steps === 7 && det.ctx === 3 && det.sprite === 1, JSON.stringify(det));
  check('metrics show the compact token total with detail in its title', /66k/.test(det.mtokens) && /53k in \/ 202 out \/ 4\.2k reasoning \/ 9\.0k cache/.test(det.tokTitle) && /Build/.test(det.mtokens), `${det.mtokens.slice(0, 60)} | ${det.tokTitle}`);
  check('lane detail shows three tokens-by-agent rows', det.tokRows === 3, String(det.tokRows));
  check('now band shows the current step', /Step 1/.test(det.now), det.now.slice(0, 80));
  const cpt = JSON.parse(await ev('(function(){const b=document.querySelector("[data-ctx=gates]");if(!b)return "{}";const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()') || '{}');
  if (cpt.x != null) { await click(cpt.x, cpt.y); await wait(200); }
  check('lane context row expands', (await ev('(function(){const b=document.querySelector("[data-ctx=gates]");const body=b.parentElement.querySelector(".ctxbody");return b.getAttribute("aria-expanded")==="true" && body.style.display!=="none" && body.innerText.length>0;})()')) === true);
  await ev('history.back()'); await wait(700);
  check('history.back returns to the plan', (await ev('location.hash')) === hash0);
  // step-done flash: ?advance=1 finishes office-layout step 1 six seconds after load
  await send('Page.navigate', { url: base + '/?demo=1&advance=1#/lane/demo-repo--office-layout' }); await wait(1500);
  check('no step flashes on first load', (await ev('document.querySelectorAll(".steprow.flash").length')) === 0);
  let flashed = ''; for (let i = 0; i < 20 && !flashed; i++) { await wait(500); flashed = await ev('document.querySelector(".steprow.flash .n")?.innerText || ""'); }
  check('finished step flashes between polls', flashed === '1', String(flashed));
  let gone = false; for (let i = 0; i < 16 && !gone; i++) { await wait(500); gone = (await ev('document.querySelectorAll(".steprow.flash").length')) === 0; }
  check('flash clears on the next render', gone);
  await ev('localStorage.setItem("ca-motion","off")');
  await send('Page.navigate', { url: base + '/?demo=1&advance=1#/lane/demo-repo--office-layout' }); await wait(1000);
  let sawFlash = false; for (let i = 0; i < 24; i++) { await wait(500); if ((await ev('document.querySelectorAll(".steprow.flash").length')) > 0) { sawFlash = true; break; } }
  check('reduced motion skips the flash', !sawFlash);
  await ev('localStorage.removeItem("ca-motion")');
  // desktop action bar: sticky at the scrollport bottom, opaque, 80 px of pad above it
  await size(1586, 992); await send('Page.navigate', { url: base + '/?demo=1#/lane/demo-repo--office-layout' }); await wait(1500);
  const bar = JSON.parse(await ev('(function(){const b=document.getElementById("bar"),p=document.querySelector(".pad.has-bar"),v=document.getElementById("view");if(!b)return "{}";const r=b.getBoundingClientRect();const cs=getComputedStyle(b);return JSON.stringify({pos:cs.position,bg:cs.backgroundColor,top:Math.round(r.top),bottom:Math.round(r.bottom),ih:window.innerHeight,pad:p?getComputedStyle(p).paddingBottom:"",vpad:getComputedStyle(v).paddingBottom});})()') || '{}');
  check('desktop action bar pins to the scrollport bottom', bar.pos === 'sticky' && bar.bottom === bar.ih && bar.pad === '80px' && bar.vpad === '0px' && bar.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(bar));
  // demo lookups: the short task name resolves like the server; transcript prefix; continues line
  await send('Page.navigate', { url: base + '/?demo=1#/lane/office-layout' }); await wait(1300);
  const sn = JSON.parse(await ev('(function(){const o=document.getElementById("out");const t=o?o.innerText:"";const ls=t.split("\\n").filter(Boolean);return JSON.stringify({h1:document.querySelector(".idrow h1")?.innerText||"",steps:document.querySelectorAll(".steprow").length,cont:document.querySelector(".cont-line")?.innerText||"",lines:ls.length,head:ls[0]||""});})()') || '{}');
  check('short task name resolves the lane and its steps', sn.h1 === 'office-layout' && sn.steps === 7, JSON.stringify(sn));
  check('lane detail shows the continues line under the metrics', sn.cont === 'Run 2 · continues office-v2 (paused at 6/8)', sn.cont);
  check('transcript starts with the lane history prefix', sn.lines >= 16 && /Lane started/.test(sn.head), `${sn.lines} lines; head: ${sn.head.slice(0, 50)}`);
  await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1200);
  const ph = JSON.parse(await ev('(function(){const h=document.querySelector(".wave-head");return JSON.stringify({chevFirst:!!h&&h.firstElementChild===h.querySelector(".chev"),cont:document.querySelector(".lane-card .cont-line")?.innerText||"",who:document.querySelector(".leadband .who")?.innerText||""});})()') || '{}');
  check('wave chevron sits left of the wave title', ph.chevFirst === true, JSON.stringify(ph));
  check('wave lane card shows the continues line under the model line', ph.cont === 'Run 2 · continues office-v2 (paused at 6/8)', ph.cont);
  check('lead band is labelled Lead now', ph.who === 'Lead now', ph.who);
  // second plan: collapsing the wave and expanding it again keeps an open step disclosure open
  await send('Page.navigate', { url: base + '/?demo=1#/plan/string-utils' }); await wait(1300);
  check('second plan opens its step disclosure', await clickSel('[data-steps="demo-repo--string-utils"]'));
  await wait(600);
  let s = await st();
  check('second plan step disclosure shows the steps', s?.plan?.waves?.[0]?.lanes?.[0]?.stepsOpen === true && (await ev('document.querySelectorAll(".steplist li").length')) === 4, JSON.stringify(s?.plan?.waves?.[0]));
  await clickSel('.chev'); await wait(300);
  s = await st();
  check('wave collapse hides the body without changing the route', s?.plan?.waves?.[0]?.collapsed === true && (await ev('document.querySelectorAll(".steplist").length')) === 0 && s?.route?.id === 'string-utils', JSON.stringify(s?.plan?.waves?.[0]));
  await clickSel('.chev'); await wait(300);
  s = await st();
  check('wave expand keeps the step disclosure open', s?.plan?.waves?.[0]?.collapsed === false && s?.plan?.waves?.[0]?.lanes?.[0]?.stepsOpen === true && (await ev('document.querySelectorAll(".steplist li").length')) === 4, JSON.stringify(s?.plan?.waves?.[0]));
  // lane transcript: follow live, scroll position, tabs, steer draft
  await send('Page.navigate', { url: base + '/?demo=1#/lane/demo-repo--office-layout' }); await wait(1500);
  s = await st();
  check('follow live defaults on', s?.lane?.follow === true && s?.lane?.tab === 'log', JSON.stringify({ follow: s?.lane?.follow, tab: s?.lane?.tab }));
  let grew = 0; for (let i = 0; i < 44 && grew < 120; i++) { grew = await ev('(function(){const o=document.getElementById("out");return o.scrollHeight - o.clientHeight;})()'); if (grew < 120) await wait(500); }
  s = await st();
  check('follow live keeps the transcript at the bottom as lines arrive', s?.lane?.follow === true && s?.lane?.transcriptAtBottom === true && grew >= 120, `grew=${grew} follow=${s?.lane?.follow} atBottom=${s?.lane?.transcriptAtBottom}`);
  await shot('lanes-detail-transcript');
  check('follow checkbox turns tracking off', await clickSel('#follow'));
  await wait(200);
  await ev('document.getElementById("out").scrollTop = 40;');
  await wait(3000);
  s = await st();
  const outTop = await ev('document.getElementById("out").scrollTop');
  check('follow off and scrolled up keeps the position over 3 s', s?.lane?.follow === false && s?.lane?.transcriptScrollTop === 40 && outTop === 40, JSON.stringify({ follow: s?.lane?.follow, top: s?.lane?.transcriptScrollTop, outTop }));
  check('brief tab click switches', await clickSel('[data-tab="brief"]'));
  await wait(300);
  s = await st();
  check('brief tab shows the brief text', s?.lane?.tab === 'brief' && /office-layout/.test(String(await ev('document.getElementById("out").textContent') || '')), JSON.stringify({ tab: s?.lane?.tab }));
  await shot('lanes-detail-brief');
  await wait(3000);
  check('transcript tab click returns', await clickSel('[data-tab="log"]'));
  await wait(300);
  s = await st();
  const outTop2 = await ev('document.getElementById("out").scrollTop');
  check('back to transcript keeps follow off and restores the position', s?.lane?.tab === 'log' && s?.lane?.follow === false && s?.lane?.transcriptScrollTop === 40 && outTop2 === 40, JSON.stringify({ tab: s?.lane?.tab, follow: s?.lane?.follow, top: s?.lane?.transcriptScrollTop, outTop2 }));
  await ev('document.getElementById("etab-log")?.focus()');
  await key('ArrowRight', 39); await wait(300);
  s = await st();
  check('arrow right on the focused transcript tab selects review', s?.lane?.tab === 'review' && (await ev('document.getElementById("etab-review")?.getAttribute("aria-selected")')) === 'true', JSON.stringify({ tab: s?.lane?.tab }));
  await clickSel('#msg'); await type('keep the phone counts inside the viewport'); await wait(200);
  s = await st();
  check('typed steer draft is kept in the lane state', s?.lane?.draft === 'keep the phone counts inside the viewport', JSON.stringify(s?.lane?.draft));
  await ev('location.hash = "#/lane/demo-repo--string-utils"'); await wait(1300);
  s = await st();
  check('the other lane starts with an empty draft', s?.lane?.id === 'demo-repo--string-utils' && s?.lane?.draft === '', JSON.stringify({ id: s?.lane?.id, draft: s?.lane?.draft }));
  await ev('location.hash = "#/lane/demo-repo--office-layout"'); await wait(1300);
  s = await st();
  check('returning to the lane restores the steer draft', s?.lane?.id === 'demo-repo--office-layout' && s?.lane?.draft === 'keep the phone counts inside the viewport' && (await ev('document.getElementById("msg")?.value')) === 'keep the phone counts inside the viewport', JSON.stringify({ draft: s?.lane?.draft }));
  // steer on a finished lane: inline error, text kept
  await ev('location.hash = "#/lane/demo-repo--path-join"'); await wait(1300);
  await clickSel('#msg'); await type('steer a finished lane'); await wait(200);
  let steer = null;
  for (let a = 0; a < 3 && !steer; a++) {
    await clickSel('#send');
    for (let i = 0; i < 22 && !steer; i++) { await wait(100); const r = await ev('(function(){return {err:document.getElementById("steerErr")?.textContent||"",msg:document.getElementById("msg")?.value||""};})()'); if (r && r.err) steer = r; }
  }
  s = await st();
  check('steer on a finished lane shows the inline error and keeps the text', !!steer && steer.err === 'lane not running' && steer.msg === 'steer a finished lane' && s?.lane?.draft === 'steer a finished lane', JSON.stringify(steer));
  // phone width: counts fit, no overflow, both routes
  await size(390, 844); await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1600);
  const pc = await ev('(function(){const r=document.getElementById("counts").getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),w:window.innerWidth};})()');
  s = await st();
  check('top bar counts inside the viewport at 390x844', !!pc && pc.left >= 0 && pc.right <= pc.w, JSON.stringify(pc));
  check('no horizontal overflow on the phone plan home', s?.overflowX === false, JSON.stringify({ overflowX: s?.overflowX }));
  await shot('lanes-phone-home');
  await ev('location.hash = "#/lane/demo-repo--office-layout"'); await wait(1500);
  s = await st();
  check('no horizontal overflow on the phone lane detail', s?.overflowX === false, JSON.stringify({ overflowX: s?.overflowX }));
  await shot('lanes-phone-detail');
  // / without demo and with an empty registry shows the onboarding panel
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || ROOT, 'ca-lanes-empty-'));
  const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
  const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
  const dash2Port = await freePort();
  const dash2 = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dash2Port)], { stdio: 'ignore', env: { ...process.env, CA_SETTINGS: settings, CA_REGISTRY: reg, CA_DASH: '0', CODEX_HOME: path.join(tmp, 'codex') } });
  process.on('exit', () => { try { dash2.kill(); } catch {} });
  let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await wait(250); try { up2 = (await fetch(`http://127.0.0.1:${dash2Port}/api/lanes`)).ok; } catch {} }
  await send('Page.navigate', { url: `http://127.0.0.1:${dash2Port}/` }); await wait(1800);
  check('/ without demo and an empty registry shows the onboarding panel', up2 && (await ev('!!document.getElementById("onboard")')) === true, `up=${up2}`);
  try { dash2.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
