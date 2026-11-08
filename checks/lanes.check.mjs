// End-to-end check for the Lanes dashboard: starts `ca dash` on a free port, drives /?demo=1 in headless Chrome over CDP.
// Usage: node checks/lanes.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP lanes: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('lanes');
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
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
  const clickSel = async (sel) => {
    // Scroll the target into view first, including when the sticky action bar (#bar) covers it: the
    // page is taller than the viewport, so a raw coordinate click on an off-screen button or one
    // hidden under the bar (evidence tabs, quick-steer chips, lane cards) would miss. A target counts
    // as ready only when it is inside the viewport and the topmost element at its centre is itself.
    const c = await ev(`(function(){const el=document.querySelector('${sel}');if(!el)return null;const r=el.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const over=(cx>=0&&cy>=0&&cx<=innerWidth&&cy<=innerHeight)?document.elementFromPoint(cx,cy):null;const clear=!!over&&(over===el||el.contains(over));if(!clear)el.scrollIntoView({block:'center',inline:'center'});const r2=el.getBoundingClientRect();return {x:r2.left+r2.width/2,y:r2.top+r2.height/2};})()`);
    if (!c) return false; await click(c.x, c.y); return true;
  };
  await send('Runtime.enable');
  // CI runners often have system animations off (prefers-reduced-motion: reduce), which correctly turns
  // the step effects off: pin motion on so the checks are deterministic; reduced motion is tested on its own.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---------- Control room (the default route): what needs me, what runs, finished, ended ----------
  await size(1280, 800);
  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1000);
  await ev('try{["ca-cr-filter","ca-cr-project","ca-cr-group","ca-cr-open","ca-cr-seen"].forEach((k)=>localStorage.removeItem(k))}catch{}');
  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1600);
  check('the default route is the Control room', (await ev('location.hash')) === '' && (await ev('!!document.querySelector(".cr-head h1")')) === true, String(await ev('location.hash')));
  let cr = await st();
  check('overview counts the buckets', !!cr?.overview?.counts && cr.overview.counts.attention === 5 && cr.overview.counts.running === 2 && cr.overview.counts.done === 2 && cr.overview.counts.ended === 3, JSON.stringify(cr?.overview?.counts));
  check('Needs you comes first and holds the stuck and failed lanes', (() => { const s0 = cr?.overview?.sections?.[0]; return !!s0 && s0.bucket === 'attention' && s0.ids.includes('demo-repo--stuck') && s0.ids.includes('demo-repo--stall'); })(), JSON.stringify(cr?.overview?.sections));
  check('the tab title carries the Needs you count', /^\((5)\) Needs you . Lanes$/.test(cr?.overview?.title || ''), cr?.overview?.title);
  check('no stale banner while polls succeed', cr?.overview?.banner === false, String(cr?.overview?.banner));
  await shot('lanes-control-room');
  check('a bucket tile is a filter toggle', await clickSel('[data-cr="running"]'));
  await wait(400);
  cr = await st();
  check('tile filter shows only that bucket', cr?.overview?.filter === 'running' && cr.overview.sections.length === 1 && cr.overview.sections[0].bucket === 'running' && cr.overview.sections[0].ids.length === 2, JSON.stringify(cr?.overview));
  await clickSel('[data-cr="running"]'); await wait(300);
  check('the project toggle is clickable', await clickSel('[data-crgroup="project"]'));
  await wait(400);
  cr = await st();
  check('By project groups by key', cr?.overview?.group === 'project' && Array.isArray(cr.overview.projects) && cr.overview.projects.length === 2 && cr.overview.projects.includes('demo-repo') && cr.overview.projects.includes('sandbox'), JSON.stringify(cr?.overview?.projects));
  await clickSel('[data-crgroup="status"]'); await wait(300);
  await clickSel('[data-crsec="done"]'); await wait(300);
  cr = await st();
  check('Done lists the unseen done lanes', ((cr?.overview?.sections?.find((s) => s.bucket === 'done')?.ids) || []).includes('demo-repo--cli-dx'), JSON.stringify(cr?.overview?.sections));
  const ackSel = '[data-ack-id="demo-repo--cli-dx"][data-ack-mark="1"]';
  check('an unseen done row offers Mark seen', await clickSel(ackSel));
  await wait(700);
  cr = await st();
  const seenBlock = await ev('!!document.querySelector(".cr-seen")');
  check('Mark seen moves the row behind Seen earlier', seenBlock === true && !((cr?.overview?.sections?.find((s) => s.bucket === 'done')?.ids) || []).includes('demo-repo--cli-dx'), JSON.stringify(cr?.overview?.sections));
  await clickSel('[data-crseen="1"]'); await wait(300);
  cr = await st();
  const doneIds = (cr?.overview?.sections?.find((s) => s.bucket === 'done')?.ids) || [];
  check('Seen earlier holds the marked lane', doneIds.includes('demo-repo--cli-dx') && doneIds.includes('demo-repo--path-join'), JSON.stringify(doneIds));
  await ev('window.__lanes.fail(true)');
  let banner = false; for (let i = 0; i < 25 && !banner; i++) { await wait(600); cr = await st(); banner = cr?.overview?.banner === true; }
  check('a simulated API failure shows the stale banner', banner, JSON.stringify(cr?.overview?.banner));
  check('the banner names the runner', /cannot reach the runner/.test(await ev('document.getElementById("stale")?.textContent || ""')), String(await ev('document.getElementById("stale")?.textContent || ""')));
  await ev('window.__lanes.fail(false)');
  await size(390, 844); await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1600);
  cr = await st();
  check('no horizontal overflow in the Control room at 390 px', cr?.overview != null && (await ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true, JSON.stringify({ overflowX: cr?.overflowX }));
  await shot('lanes-control-room-phone');

  // ---------- plan home (explicit route now that #/ is the Control room) ----------
  await size(1280, 800); await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1800);
  const text = await ev('document.body.innerText');
  check('demo fixture renders the first plan', /Office view polish: sprites and layout/.test(text || ''));
  check('demo counts render', /2 plans/.test(text || ''), (text || '').split('\n')[0]);
  const counts = await ev('(function(){const r=document.getElementById("counts").getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),w:window.innerWidth};})()');
  check('top bar counts inside the viewport at 1280x800', !!counts && counts.left >= 0 && counts.right <= counts.w, JSON.stringify(counts));
  const railJ = JSON.parse(await ev('(function(){return JSON.stringify({plans:document.querySelectorAll("#railBody .rail-card:not(.cr)").length,fin:document.querySelectorAll("#railBody .rail-fin").length});})()') || '{}');
  check('rail lists 2 plans and 9 finished lanes', railJ.plans === 2 && railJ.fin === 9, JSON.stringify(railJ));
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
  const det = JSON.parse(await ev('(function(){return JSON.stringify({hash:location.hash,back:document.querySelector(".backlink")?.getAttribute("href"),planBack:[...document.querySelectorAll(".backlink")].map((a)=>a.getAttribute("href")).find((h)=>h.startsWith("#/plan/")),h1:document.querySelector(".idrow h1")?.innerText,metrics:document.querySelectorAll(".metrics .m").length,mtokens:document.querySelector(".metrics")?.innerText||"",tokTitle:document.querySelector(".metrics .m[title]")?.getAttribute("title")||"",tokRows:document.querySelectorAll(".tokrow").length,segs:document.querySelectorAll(".seg").length,now:document.querySelector(".nowband")?.innerText||"",steps:document.querySelectorAll(".steprow").length,ctx:document.querySelectorAll(".ctxrow").length,sprite:document.querySelectorAll(".px-sprite:not(.px-fallback)").length});})()') || '{}');
  check('lane detail renders identity, metrics and context', det.hash === '#/lane/demo-repo--office-layout' && det.planBack === '#/plan/office-polish' && det.back === '#/' && det.h1 === 'office-layout' && det.metrics === 7 && det.segs === 5 && det.steps === 7 && det.ctx === 3 && det.sprite === 1, JSON.stringify(det));
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
  let flashed = ''; for (let i = 0; i < 80 && !flashed; i++) { await wait(250); flashed = await ev('document.querySelector(".steprow.flash .n")?.innerText || ""'); }
  check('finished step flashes between polls', flashed === '1', String(flashed));
  let gone = false; for (let i = 0; i < 16 && !gone; i++) { await wait(500); gone = (await ev('document.querySelectorAll(".steprow.flash").length')) === 0; }
  check('flash clears on the next render', gone);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: base + '/?demo=1&advance=1#/lane/demo-repo--office-layout' }); await wait(1000);
  let sawFlash = false; for (let i = 0; i < 24; i++) { await wait(500); if ((await ev('document.querySelectorAll(".steprow.flash").length')) > 0) { sawFlash = true; break; } }
  check('reduced motion skips the flash', !sawFlash);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
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
  await size(390, 844); await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1600);
  const pc = await ev('(function(){const r=document.getElementById("counts").getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),w:window.innerWidth};})()');
  s = await st();
  check('top bar counts inside the viewport at 390x844', !!pc && pc.left >= 0 && pc.right <= pc.w, JSON.stringify(pc));
  check('no horizontal overflow on the phone plan home', s?.overflowX === false, JSON.stringify({ overflowX: s?.overflowX }));
  await shot('lanes-phone-home');
  await ev('location.hash = "#/lane/demo-repo--office-layout"'); await wait(1500);
  s = await st();
  check('no horizontal overflow on the phone lane detail', s?.overflowX === false, JSON.stringify({ overflowX: s?.overflowX }));
  await shot('lanes-phone-detail');
  // tokens and lane controls (step 4-7)
  await size(1280, 800); await send('Page.navigate', { url: base + '/?demo=1#/lane/demo-repo--office-layout' }); await wait(1500);
  s = await st();
  const trowSum = await ev('[...document.querySelectorAll(".tokrow")].reduce((a,r)=>a+(+r.dataset.total||0),0)');
  check('running lane token total equals the sum of its three agent rows', !!s?.lane?.tokens && s.lane.tokens.total === s.lane.tokens.build + s.lane.tokens.review + s.lane.tokens.other && s.lane.tokens.total === trowSum, JSON.stringify({ tokens: s?.lane?.tokens, trowSum }));
  check('running lane control ids render in order with attach and stop', Array.isArray(s?.lane?.actions) && s.lane.actions[0] === 'kick' && s.lane.actions.includes('attach') && s.lane.actions.includes('stop'), JSON.stringify(s?.lane?.actions));
  await shot('lanes-detail-controls');
  await ev('location.hash = "#/lane/demo-repo--stuck"'); await wait(1300);
  s = await st();
  check('stuck lane suggests kick and renders it first', s?.lane?.suggest === 'kick' && s?.lane?.actions?.[0] === 'kick', JSON.stringify({ suggest: s?.lane?.suggest, actions: s?.lane?.actions }));
  const kickPrimary = await ev('(function(){const b=document.querySelector("#bar .ctlbar .sugbtn");return b?{action:b.dataset.action,primary:b.classList.contains("primary")}:null;})()');
  check('the suggested kick button is primary', !!kickPrimary && kickPrimary.action === 'kick' && kickPrimary.primary === true, JSON.stringify(kickPrimary));
  await clickSel('#bar .ctlbar .sugbtn'); await wait(300);
  s = await st();
  check('clicking the suggested kick opens the note box', s?.lane?.noteOpen === true && (await ev('!!document.querySelector("#bar .notebox textarea")')) === true, JSON.stringify({ noteOpen: s?.lane?.noteOpen }));
  await clickSel('#bar .notebox textarea'); await type('continue the turn'); await wait(150);
  await clickSel('#bar .notebox [data-note-send]');
  let kickCtl = null; for (let i = 0; i < 30 && !kickCtl; i++) { await wait(150); kickCtl = await ev('(window.__lanes.state().controls||[]).find(c=>c.action==="kick")'); }
  check('kick note flow logs {action kick, mode turn, text}', !!kickCtl && kickCtl.body?.mode === 'turn' && kickCtl.body?.text === 'continue the turn', JSON.stringify(kickCtl));
  check('the kick flow keeps the lane route', (await ev('location.hash')) === '#/lane/demo-repo--stuck', String(await ev('location.hash')));
  await ev('location.hash = "#/lane/demo-repo--stall"'); await wait(1300);
  s = await st();
  check('failed lane offers resume as its first control', s?.lane?.actions?.[0] === 'resume', JSON.stringify(s?.lane?.actions));
  await clickSel('#bar .ctlbar .sugbtn'); await wait(300);
  await clickSel('#bar .notebox textarea'); await type('pick up where you left off'); await wait(150);
  await clickSel('#bar .notebox [data-note-send]');
  let resCtl = null; for (let i = 0; i < 30 && !resCtl; i++) { await wait(150); resCtl = await ev('(window.__lanes.state().controls||[]).find(c=>c.action==="resume")'); }
  check('resume note flow logs body.note', !!resCtl && resCtl.body?.note === 'pick up where you left off', JSON.stringify(resCtl));
  // plan home: token total and a one-click suggested action on the stuck card
  await ev('location.hash = "#/plan/string-utils"'); await wait(1300);
  s = await st();
  check('plan home shows a plan token total', typeof s?.plan?.tokens === 'number' && s.plan.tokens > 0, String(s?.plan?.tokens));
  check('plan home marks the stuck card for one-click', Array.isArray(s?.plan?.suggestButtons) && s.plan.suggestButtons.includes('demo-repo--stuck'), JSON.stringify(s?.plan?.suggestButtons));
  await shot('lanes-plan-home-tokens');
  await clickSel('.lane-card .sugbtn'); await wait(300);
  await clickSel('.lane-card .notebox textarea'); await type('retry the stuck turn'); await wait(150);
  await clickSel('.lane-card .notebox [data-note-send]');
  let planKick = null; for (let i = 0; i < 30 && !planKick; i++) { await wait(150); planKick = await ev('(window.__lanes.state().controls||[]).find(c=>c.action==="kick" && c.body && c.body.text==="retry the stuck turn")'); }
  check('one-click on the stuck card logs a kick without changing the route', !!planKick && (await ev('location.hash')) === '#/plan/string-utils', JSON.stringify(planKick));
  // quick steering fills the draft only
  await ev('location.hash = "#/lane/demo-repo--office-layout"'); await wait(1300);
  const chipTxt = await ev('(function(){const c=document.querySelector("#quickSteers .qchip");return c?c.title:"";})()');
  const chipN = await ev('document.querySelectorAll("#quickSteers .qchip").length');
  await clickSel('#quickSteers .qchip'); await wait(250);
  s = await st();
  check('quick steering chips render and a click fills the steer draft', chipN === 5 && !!chipTxt && s?.quickSteers === 5 && s?.lane?.draft === chipTxt && (await ev('document.getElementById("msg").value')) === chipTxt, JSON.stringify({ chipN, chipTxt, draft: s?.lane?.draft }));
  // / without demo and with an empty registry shows the onboarding panel
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lanes-empty-'));
  const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
  const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
  // A temp credentials file with fake keys plus CA_CREDENTIALS_ONLY keeps POST /api/auth off the real keys.
  const cred = path.join(tmp, 'credentials.json'); fs.writeFileSync(cred, JSON.stringify({ CODEARTS_CLI_AK: 'check-ak', CODEARTS_CLI_SK: 'check-sk' }));
  const dash2Port = await freePort();
  const dash2 = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dash2Port)], { stdio: 'ignore', env: { ...process.env, CA_SETTINGS: settings, CA_REGISTRY: reg, CA_CREDENTIALS: cred, CA_CREDENTIALS_ONLY: '1', CA_DASH: '0', CODEX_HOME: path.join(tmp, 'codex') } });
  process.on('exit', () => { try { dash2.kill(); } catch {} });
  let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await wait(250); try { up2 = (await fetch(`http://127.0.0.1:${dash2Port}/api/lanes`)).ok; } catch {} }
  await send('Page.navigate', { url: `http://127.0.0.1:${dash2Port}/` }); await wait(1800);
  check('/ without demo and an empty registry shows the onboarding panel', up2 && (await ev('!!document.getElementById("onboard")')) === true, `up=${up2}`);
  // the first-run test hook: the panel state, the setup prompt and the manual command
  const onb = await ev('window.__lanes.onboard && window.__lanes.onboard()');
  check('the onboard hook reports the panel', !!onb && onb.shown === true, JSON.stringify(onb && { shown: onb.shown, fails: onb.fails, warns: onb.warns }));
  check('the onboard hook exposes the setup prompt with INSTALL.md', !!onb && typeof onb.prompt === 'string' && onb.prompt.includes('INSTALL.md'), onb && onb.prompt);
  check('the onboard hook lists every doctor row with a status', !!onb && Array.isArray(onb.rows) && onb.rows.length >= 5 && onb.rows.every((r) => r.name && ['ok', 'warn', 'fail'].includes(r.status)), JSON.stringify(onb && onb.rows));
  // clicking a harness chip swaps the manual command
  check('the codex chip is clickable', await clickSel('.onb-hchip[data-harness="codex"]'));
  await wait(200);
  const onbCmdNow = await ev('window.__lanes.onboard && window.__lanes.onboard().cmd');
  const onbHarnessNow = await ev('window.__lanes.onboard && window.__lanes.onboard().harness');
  check('clicking the codex chip changes the manual command', typeof onbCmdNow === 'string' && onbCmdNow.includes('--harness codex') && onbHarnessNow === 'codex', String(onbCmdNow));
  // every doctor row name and its status chip keep at least 4 px apart
  const gaps = await ev('[...document.querySelectorAll("#onb-doctor .onb-row")].map((r)=>{const n=r.querySelector(".onb-name").getBoundingClientRect(),c=r.querySelector(".onb-chip").getBoundingClientRect();return {gap:c.left-n.right, overlap:n.right>c.left&&n.left<c.right&&n.bottom>c.top&&n.top<c.bottom};})');
  check('every doctor row name and chip do not overlap and keep a >=4 px gap', Array.isArray(gaps) && gaps.length > 0 && gaps.every((g) => !g.overlap && g.gap >= 4), JSON.stringify(gaps));
  // at 1280x900 the sidebar never scrolls sideways
  await size(1280, 900); await wait(300);
  const rail = await ev('(function(){const r=document.getElementById("rail");return {sw:r.scrollWidth,cw:r.clientWidth};})()');
  check('the sidebar does not scroll horizontally at 1280x900', !!rail && rail.sw <= rail.cw, JSON.stringify(rail));
  // at 390x844 nothing in the panel runs past the viewport
  await size(390, 844); await wait(400);
  const wide = await ev('[...document.querySelectorAll("#onboard *")].filter((el)=>el.getBoundingClientRect().right>document.documentElement.clientWidth+1).map((el)=>el.tagName+"."+el.className)');
  check('no element in the panel is wider than the phone viewport', Array.isArray(wide) && wide.length === 0, JSON.stringify(wide && wide.slice(0, 4)));
  // POST /api/auth answers JSON (never a reset); the temp credentials keep the real keys out
  let authRes = null;
  try {
    const r = await fetch(`http://127.0.0.1:${dash2Port}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    authRes = { status: r.status, ct: String(r.headers.get('content-type') || ''), body: await r.text() };
  } catch (e) { authRes = { error: String(e && e.message || e) }; }
  let authJson = null; try { authJson = JSON.parse(authRes && authRes.body); } catch {}
  check('POST /api/auth answers JSON with 200 or 4xx and never resets', !!authRes && !authRes.error && (authRes.status === 200 || (authRes.status >= 400 && authRes.status < 500)) && /application\/json/i.test(authRes.ct || '') && !!authJson && typeof authJson.ready === 'boolean', JSON.stringify(authRes));
  try { dash2.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
