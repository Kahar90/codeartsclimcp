// End-to-end check for the Delete controls on both browser pages: starts `ca dash` on a free port and
// drives /?demo=1 and /office?demo=1 in headless Chrome over CDP. Every delete goes through the real
// Delete button; the confirm dialog is stubbed in the page.
// Usage: node checks/removeui.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP removeui: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('removeui');
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
  const js = (expr) => ev(expr); // readability alias
  const clickSel = async (sel) => {
    // Scroll the target into view first; a target counts as ready only when the topmost element at its
    // centre is itself (else a sticky bar or an overlay would swallow the click).
    const c = await ev(`(function(){const el=document.querySelector('${sel}');if(!el)return null;const r=el.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const over=(cx>=0&&cy>=0&&cx<=innerWidth&&cy<=innerHeight)?document.elementFromPoint(cx,cy):null;const clear=!!over&&(over===el||el.contains(over));if(!clear)el.scrollIntoView({block:'center',inline:'center'});const r2=el.getBoundingClientRect();return {x:r2.left+r2.width/2,y:r2.top+r2.height/2};})()`);
    if (!c) return false; await click(c.x, c.y); return true;
  };
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // ---------- Lanes dashboard: Delete on a lane card and on every plan in the rail ----------
  await size(1280, 800);
  await send('Page.navigate', { url: base + '/?demo=1#/plan/office-polish' }); await wait(1600);
  await ev('window.confirm = () => true');
  const hasLaneDel = await js('(function(){var b=document.querySelector("[data-del=\\"lane:demo-repo--office-layout\\"]");return !!b && b.getAttribute("aria-label")==="Delete lane office-layout";})()');
  check('the lane card shows a labelled Delete control', hasLaneDel === true, String(hasLaneDel));
  await shot('removeui-1-lanes-before');
  await clickSel('[data-del="lane:demo-repo--office-layout"]'); await wait(900);
  const r1 = JSON.parse(await ev('(function(){return JSON.stringify({cards:document.querySelectorAll(".lane-card").length, btn:!!document.querySelector("[data-del=\\"lane:demo-repo--office-layout\\"]"), removed:window.__lanes.removed()});})()') || '{}');
  check('deleting a lane removes its card at once and records it', r1.cards === 0 && r1.btn === false && r1.removed.includes('demo-repo--office-layout'), JSON.stringify(r1));
  await shot('removeui-2-lane-deleted');

  await send('Page.navigate', { url: base + '/?demo=1#/plan/string-utils' }); await wait(1600);
  await ev('window.confirm = () => true');
  const p0 = JSON.parse(await ev('(function(){return JSON.stringify({cards:document.querySelectorAll(".lane-card").length,plans:document.querySelectorAll("#railBody .rail-card:not(.cr)").length,has:!!document.querySelector("[data-del=\\"plan:string-utils\\"]")});})()') || '{}');
  check('the rail shows a Delete control on every plan and three lane cards', p0.plans === 2 && p0.cards === 3 && p0.has === true, JSON.stringify(p0));
  await clickSel('[data-del="plan:string-utils"]'); await wait(900);
  const p1 = JSON.parse(await ev('(function(){var s=window.__lanes.state();return JSON.stringify({planIds:s.rail.plans.map(function(p){return p.id;}),removed:window.__lanes.removed(),laneDel:document.querySelectorAll("[data-del=\\"lane:demo-repo--string-utils\\"],[data-del=\\"lane:demo-repo--path-join\\"],[data-del=\\"lane:demo-repo--stuck\\"]").length});})()') || '{}');
  check('deleting a plan removes it from the rail', Array.isArray(p1.planIds) && p1.planIds.join(',') === 'office-polish', JSON.stringify(p1.planIds));
  check('deleting a plan removes its lanes and their Delete controls', p1.laneDel === 0, JSON.stringify(p1));
  check('deleting a plan records it in the removed hook', p1.removed.includes('string-utils'), JSON.stringify(p1.removed));
  await shot('removeui-3-plan-deleted');

  await send('Page.navigate', { url: base + '/?demo=1' }); await wait(1600);
  await ev('window.confirm = () => false');
  const c0 = await js('!!document.querySelector("[data-del=\\"lane:demo-repo--chaos\\"]")');
  await clickSel('[data-del="lane:demo-repo--chaos"]'); await wait(700);
  const c1 = JSON.parse(await ev('(function(){return JSON.stringify({still:!!document.querySelector("[data-del=\\"lane:demo-repo--chaos\\"]"),removed:window.__lanes.removed()});})()') || '{}');
  check('cancelling the confirm keeps the lane and deletes nothing', c0 === true && c1.still === true && Array.isArray(c1.removed) && c1.removed.length === 0, JSON.stringify({ c0, ...c1 }));
  await shot('removeui-4-lane-cancelled');

  // ---------- Office view: Delete from the plan menu and from the lane window ----------
  await size(1280, 800);
  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(2000);
  await ev('window.confirm = () => true');
  const opened = await clickSel('#planBtn'); await wait(400);
  check('the Office plan menu opens with a Delete control per plan', opened === true && (await js('!!document.querySelector("#planMenu [data-pm-del=\\"demo\\"]")')) === true);
  await shot('removeui-5-office-menu');
  await clickSel('#planMenu [data-pm-del="demo"]'); await wait(900);
  const o1 = JSON.parse(await ev('(function(){var s=window.__office.state();return JSON.stringify({plan:s.plan,lanes:s.lanes.length,removed:window.__office.removed(),empty:document.getElementById("emptyCard").hidden===false});})()') || '{}');
  check('deleting the Office plan records it and clears the scene', Array.isArray(o1.removed) && o1.removed.includes('demo') && o1.lanes === 0 && o1.plan === '', JSON.stringify(o1));
  check('the Office shows the empty state after deleting the only plan', o1.empty === true, JSON.stringify(o1));
  await shot('removeui-6-office-plan-deleted');

  await send('Page.navigate', { url: base + '/office?demo=1&still=1' }); await wait(2000);
  await ev('window.confirm = () => true');
  await ev('window.__office.press("office-review")'); await wait(500);
  const winDelLabel = await js('document.getElementById("winDel") && document.getElementById("winDel").getAttribute("aria-label")');
  check('the lane window shows a labelled Delete control', winDelLabel === 'Delete lane office-review' && (await js('document.getElementById("winDelRow").hidden')) === false, String(winDelLabel));
  await shot('removeui-7-office-window');
  await clickSel('#winDel'); await wait(900);
  const o2 = JSON.parse(await ev('(function(){var s=window.__office.state();return JSON.stringify({ids:s.lanes.map(function(l){return l.id;}),removed:window.__office.removed(),open:s.window.open});})()') || '{}');
  check('deleting a lane drops it from the scene and records it', Array.isArray(o2.ids) && !o2.ids.includes('office-review') && o2.removed.includes('office-review'), JSON.stringify(o2));
  check('the lane window closes when its lane is deleted', o2.open === false, String(o2.open));
  await shot('removeui-8-office-lane-deleted');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
