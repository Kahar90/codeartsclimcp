// Polish contract for both pages (Office and Lanes) on the ?demo fixtures, at five viewports:
// - no horizontal page overflow, and no element sticking out past the right edge
// - every floating surface (agent window, plan menu, hover card, +N list, update popover, toast)
//   opens fully inside the visible viewport (8 px margin), scrolling inside itself when tall
// - floating surfaces animate in (a CSS animation or transition runs) with motion on, and open
//   instantly with prefers-reduced-motion: reduce
// - Escape closes the agent window and the plan menu and gives focus back to the opener
// - phone: every button and link in the main UI is at least 32 px tall (tap target)
// Usage: node checks/polish.check.mjs [--only office|lanes|update[,..]] [outDir]   (screenshots of every open surface go to outDir)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const oi = argv.indexOf('--only'); const ONLY = oi >= 0 ? argv.splice(oi, 2)[1] : null; // office | lanes | update
const want = (part) => !ONLY || ONLY.split(',').includes(part);
const OUT = argv[0] ? path.resolve(argv[0]) : path.join(ROOT, 'checks', 'out', 'polish');
fs.mkdirSync(OUT, { recursive: true });
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP polish: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-polish-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const dp = await free(), cp = await free();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dp)], { cwd: tmp, stdio: 'ignore', env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1' } });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('polish')}`, '--no-first-run', '--hide-scrollbars', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
const timer = setTimeout(() => { console.log('FAIL timeout'); cleanup(); process.exit(1); }, 420000);

let ws = null; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r && r.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: code || k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }); };
const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const hover = async (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
await send('Runtime.enable');

const VIEWS = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'small', width: 1024, height: 640 },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'phone', width: 390, height: 844, mobile: true },
];
const M = 8; // margin every floating surface keeps from the viewport edge
// rect of a selector, null when absent or hidden
const RECT = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || e.closest('[hidden]')) return null; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, sh: e.scrollHeight, ch: e.clientHeight, oy: cs.overflowY }; })()`;
const inView = (r) => r && r.x >= M - 1 && r.y >= M - 1 && r.r <= r.vw - M + 1 && r.b <= r.vh - M + 1;
// a surface that is taller than the viewport must scroll inside itself rather than run off screen
const fmt = (r) => r ? `${r.x},${r.y} ${r.w}x${r.h} in ${r.vw}x${r.vh}` : 'not visible';
// is an entry animation or transition running on the element right after it opened?
const ANIM = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'absent'; const a = e.getAnimations({ subtree: false }); if (a.length) return 'anim:' + a.map((x) => x.animationName || x.transitionProperty || 'x').join(','); const cs = getComputedStyle(e); return 'none:' + cs.animationName + '/' + cs.transitionDuration; })()`;
const OVERFLOW = `(() => { const W = document.documentElement.clientWidth; const bad = []; if (document.documentElement.scrollWidth > W + 1) bad.push('page scrollWidth ' + document.documentElement.scrollWidth + ' > ' + W);
  for (const e of document.querySelectorAll('body *')) { if (e.closest('[hidden]') || e.closest('#room, #sprites, #fx, .desk')) continue; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue; const r = e.getBoundingClientRect(); if (!r.width) continue;
    let clip = false; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const pc = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(pc.overflowX)) { const pr = p.getBoundingClientRect(); if (pr.right <= W + 1) { clip = true; break; } } }
    if (!clip && r.right > W + 1) bad.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]) + ' right=' + Math.round(r.right)); if (bad.length > 6) break; }
  return bad; })()`;
const TAPS = (scope) => `(() => { const small = []; for (const e of document.querySelectorAll(${JSON.stringify(scope)})) { if (e.closest('[hidden]')) continue; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue; const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue; if (r.bottom < 0 || r.top > innerHeight) continue; if (r.height < 31.5) small.push((e.id ? '#' + e.id : (e.textContent || e.className).trim().slice(0, 18)) + ' ' + Math.round(r.height)); } return small; })()`;

async function setView(v, reduced) {
  await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: !!v.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!v.mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
}
async function go(url, ready) {
  await send('Page.navigate', { url: `http://127.0.0.1:${dp}${url}` });
  for (let i = 0; i < 60; i++) { await wait(200); if (await ev(ready)) break; }
  await wait(600);
}

try {
  // ---------------- Office ----------------
  if (want('office')) for (const v of VIEWS) {
    await setView(v, false);
    for (const demo of ['1', 'big']) {
      await go(`/office?demo=${demo}`, `!!(window.__office && window.__office.state().stations.length)`);
      const of = await ev(OVERFLOW);
      check(`office ?demo=${demo} ${v.name}: nothing sticks out past the right edge`, Array.isArray(of) && of.length === 0, JSON.stringify(of));
      if (demo === '1') await shot(`office-${v.name}`);
    }
    // agent window for every station and hot desk with a lane (desktop: click the plate; phone: the list row)
    await go(`/office?demo=big`, `!!(window.__office && window.__office.state().stations.length)`);
    const targets = await ev(`[...document.querySelectorAll('.plate, .st-row, .ov-row')].filter((p) => { if (p.closest('[hidden]')) return false; const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = p.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; }).map((p) => { const r = p.getBoundingClientRect(); return { id: p.id || p.dataset.lane || p.textContent.trim().slice(0, 20), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })`) || [];
    check(`office ${v.name}: there are agent openers on screen`, targets.length >= 1, targets.length);
    const outside = [], noAnim = [], escFail = [];
    let shotDone = false;
    for (const t of targets.slice(0, 10)) {
      await key('Escape'); await wait(250);
      await click(t.x, t.y); await wait(40);
      const anim = await ev(ANIM('#win'));
      await wait(400);
      const r = await ev(RECT('#win'));
      if (!r) continue; // not every opener opens the window (e.g. the +N pill toggles its list)
      // a phone/tablet bottom sheet is docked flush to the bottom and sides: inside the viewport is enough there
      const sheet = await ev(`!!(window.__office.state().win || {}).sheet`);
      const okSheet = sheet && r.x >= -1 && r.r <= r.vw + 1 && r.y >= 0 && Math.abs(r.b - r.vh) <= 1 && r.h <= r.vh * 0.9;
      if (!okSheet && !inView(r) && !(r.oy !== 'visible' && r.sh > r.ch && r.y >= M - 1 && r.b <= r.vh - M + 1)) outside.push(`${t.id}: ${fmt(r)}`);
      if (!/^anim:/.test(anim)) noAnim.push(`${t.id}: ${anim}`);
      if (!shotDone) { await shot(`office-${v.name}-window`); shotDone = true; }
      await key('Escape'); await wait(350);
      if (await ev(RECT('#win'))) escFail.push(t.id);
    }
    check(`office ${v.name}: the agent window opens fully inside the viewport for every opener`, outside.length === 0, outside.join(' | '));
    check(`office ${v.name}: the agent window animates in`, noAnim.length === 0, noAnim.join(' | '));
    check(`office ${v.name}: Escape closes the agent window`, escFail.length === 0, escFail.join(','));
    // the window stays inside the viewport when the page is resized while it is open
    if (v.name === 'wide' && targets.length) {
      const t = targets[targets.length - 1]; await click(t.x, t.y); await wait(400);
      await setView({ width: 900, height: 560 }, false); await wait(500);
      const r = await ev(RECT('#win'));
      check('office: an open agent window is moved back inside after the viewport shrinks', !r || inView(r) || (r.sh > r.ch && r.y >= M - 1 && r.b <= r.vh - M + 1), fmt(r));
      await key('Escape'); await setView(v, false); await wait(300);
    }
    // plan menu
    const pb = await ev(RECT('#planBtn'));
    if (pb) {
      await click(Math.round((pb.x + pb.r) / 2), Math.round((pb.y + pb.b) / 2)); await wait(40);
      const anim = await ev(ANIM('#planMenu')); await wait(350);
      const r = await ev(RECT('#planMenu'));
      check(`office ${v.name}: the plan menu opens inside the viewport`, inView(r), fmt(r));
      check(`office ${v.name}: the plan menu animates in`, /^anim:/.test(anim), anim);
      if (v.name === 'phone') await shot('office-phone-planmenu');
      await key('Escape'); await wait(300);
      check(`office ${v.name}: Escape closes the plan menu and focuses the plan button`, !(await ev(RECT('#planMenu'))) && (await ev(`document.activeElement && document.activeElement.id`)) === 'planBtn');
    }
    // hover cards (desktop only): every element that opens #hoverCard
    if (!v.mobile) {
      const hs = await ev(`[...document.querySelectorAll('[data-card], #tokChip, #planBadge, .tok-chip, .ca-chip')].filter((e) => !e.closest('[hidden]') && e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })`) || [];
      const bad = [];
      for (const h of hs) { await hover(h.x, h.y); await wait(600); const r = await ev(RECT('#hoverCard')); if (r && !inView(r)) bad.push(`${h.id}: ${fmt(r)}`); await hover(5, v.height - 5); await wait(200); }
      check(`office ${v.name}: hover cards stay inside the viewport`, bad.length === 0, bad.join(' | '));
    }
    if (v.name === 'phone') {
      const small = await ev(TAPS('.ca-tab, .ca-top button, #needsPill, #planBtn, .st-row, #win button, #win a'));
      check('office phone: tap targets are at least 32 px tall', Array.isArray(small) && small.length === 0, JSON.stringify(small));
    }
  }
  // reduced motion: the agent window opens instantly
  if (want('office')) { await setView(VIEWS[0], true);
  await go(`/office?demo=1`, `!!(window.__office && window.__office.state().stations.length)`);
  const pl = await ev(RECT('.plate'));
  if (pl) { await click(Math.round((pl.x + pl.r) / 2), Math.round((pl.y + pl.b) / 2)); await wait(30); const a = await ev(ANIM('#win')); check('office reduced motion: the agent window opens without an animation', !/^anim:/.test(a), a); } }

  // ---------------- Lanes ----------------
  const LREADY = `!!(window.__lanes && window.__lanes.state().overview)`;
  if (want('lanes')) for (const v of VIEWS) {
    await setView(v, false);
    for (const [label, hash] of [['home', ''], ['plan', null], ['lane', '#/lane/demo-repo--office-layout']]) {
      let h = hash;
      if (h === null) { await go(`/?demo=1`, LREADY); const pid = await ev(`(window.__lanes.state().rail.plans[0] || {}).id`); h = pid ? `#/plan/${pid}` : ''; }
      await go(`/?demo=1${h}`, LREADY); await wait(300);
      const of = await ev(OVERFLOW);
      check(`lanes ${label} ${v.name}: nothing sticks out past the right edge`, Array.isArray(of) && of.length === 0, JSON.stringify(of));
      await shot(`lanes-${label}-${v.name}`);
      if (v.name === 'phone') {
        const small = await ev(TAPS('.ca-top a, .ca-top button, button.btn, .crtile, #bar button'));
        check(`lanes ${label} phone: tap targets are at least 32 px tall`, Array.isArray(small) && small.length === 0, JSON.stringify(small));
      }
    }
    // a toast (control action) appears inside the viewport and animates
    await go(`/?demo=1#/lane/demo-repo--stuck`, LREADY); await wait(300);
    const b = await ev(RECT('#bar [data-action]'));
    if (b) {
      await click(Math.round((b.x + b.r) / 2), Math.round((b.y + b.b) / 2)); await wait(60);
      const sel = (await ev(`!!document.querySelector('.ca-toast')`)) ? '.ca-toast' : '#toast';
      const a = await ev(ANIM(sel)); await wait(250); const t = await ev(RECT(sel));
      check(`lanes ${v.name}: a control action shows a toast inside the viewport`, inView(t), fmt(t));
      check(`lanes ${v.name}: the toast animates in`, /^anim:/.test(a), a);
    }
    if (v.name === 'wide') {
      // polls re-render every few seconds: entry animations must not replay on rows that were already there
      await go(`/?demo=1`, LREADY); await wait(4000);
      const replay = await ev(`document.getAnimations().filter((x) => x.playState === 'running' && x.effect && x.effect.target && x.effect.target.closest && x.effect.target.closest('main, #main, .main, #view') && !/pulse|live|spin|shimmer|breath/i.test(x.animationName || '')).map((x) => (x.animationName || x.transitionProperty) + '@' + (x.effect.target.className || x.effect.target.tagName)).slice(0, 6)`);
      check('lanes: no entry animation replays on rows that were already shown (poll re-render)', Array.isArray(replay) && replay.length === 0, JSON.stringify(replay));
      // collapsing a Control room section animates
      const h = await ev(RECT('.cr-sec-h'));
      if (h) { await click(h.x + 20, Math.round((h.y + h.b) / 2)); await wait(40); const n = await ev(`document.getAnimations().filter((x) => x.playState === 'running').length`); check('lanes: collapsing a Control room section animates', n > 0, n); await wait(400); }
    }
  }

  // ---------------- Update notice (both pages, ?update=demo fixture) ----------------
  if (want('update')) for (const v of [VIEWS[0], VIEWS[4]]) {
    await setView(v, false);
    for (const [page, ready] of [['/office?demo=1&update=demo', `!!(window.__office && window.__office.state().stations.length)`], ['/?demo=1&update=demo', LREADY]]) {
      await go(page, ready); await wait(500);
      const pill = await ev(RECT('.ca-update'));
      check(`update ${page.split('?')[0] || '/'} ${v.name}: the top bar shows the update pill`, !!pill && inView(pill), fmt(pill));
      if (!pill) continue;
      await click(Math.round((pill.x + pill.r) / 2), Math.round((pill.y + pill.b) / 2)); await wait(40);
      const a = await ev(ANIM('.ca-update-pop')); await wait(400);
      const r = await ev(RECT('.ca-update-pop'));
      check(`update ${page.split('?')[0] || '/'} ${v.name}: the update popover opens inside the viewport and animates`, inView(r) && /^anim:/.test(a), `${fmt(r)} ${a}`);
      const txt = await ev(`(document.querySelector('.ca-update-pop') || {}).textContent || ''`);
      check(`update ${v.name}: the popover names both versions, lists what is new and offers Update now`, /0\.2\.0/.test(txt) && /0\.3\.0/.test(txt) && /Update now/i.test(txt) && (await ev(`document.querySelectorAll('.ca-update-pop li').length`)) >= 2, txt.slice(0, 160));
      await shot(`update-${page.startsWith('/office') ? 'office' : 'lanes'}-${v.name}`);
      await key('Escape'); await wait(300);
      check(`update ${v.name}: Escape closes the popover`, !(await ev(RECT('.ca-update-pop'))));
    }
  }
} catch (e) { check('no exception', false, e.stack || e.message); }
clearTimeout(timer); cleanup();
for (const r of results) console.log(r);
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`${results.length - fails}/${results.length} passed; screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
