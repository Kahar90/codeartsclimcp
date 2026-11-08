// End-to-end check for the Office view glance: starts `ca dash` on a free port, drives /office in
// headless Chrome over CDP, and asserts the sign, the tab title and favicon for every glance state.
// Usage: node checks/glanceoffice.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP glance: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const profile = chromeProfileDir('glance');
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null; let finished = false;
const finish = (code) => { if (finished) return Promise.resolve(); finished = true; return settle({ socket: sock, children: [chrome, dash], code }); };
const timer = setTimeout(() => { console.log('FAIL timeout after 120 s'); finish(1); }, 120000);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  const page = await fetch(base + '/office'); const html = await page.text();
  check('GET /office serves the page', page.ok && /glanceSign/.test(html) && /<title>/.test(html), String(page.status));

  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');
  // Pin motion on so the check is deterministic; reduced motion is a separate concern.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  const glance = () => ev('window.__office && window.__office.glance()');
  const glanceReady = async () => { let v; for (let i = 0; i < 12; i++) { v = await glance(); if (v && v.state) return v; await wait(400); } return v; };
  // The sign must not cover any visible station nameplate button.
  const overlap = () => ev(`(function(){
    var sign = document.getElementById("glanceSign");
    if (!sign || sign.hidden) return { ok: false, why: "sign hidden" };
    var s = sign.getBoundingClientRect();
    var btns = [].slice.call(document.querySelectorAll("#plates .plate")).filter(function(b){ var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    for (var i = 0; i < btns.length; i++) {
      var r = btns[i].getBoundingClientRect();
      if (s.left < r.right && r.left < s.right && s.top < r.bottom && r.top < s.bottom) return { ok: false, why: btns[i].id };
    }
    return { ok: true, n: btns.length };
  })()`);

  const cases = [
    { url: 'demo=1', state: 'working', word: 'Working', glyph: '\u25CF' },
    { url: 'demo=done', state: 'done', word: 'Done', glyph: '\u2713' },
    { url: 'demo=needs', state: 'needs-you', word: 'Needs you', glyph: '!' },
    { url: 'demo=failed', state: 'failed', word: 'Failed', glyph: '\u2715' },
    { url: 'demo=quiet', state: 'quiet', word: 'Check Claude', glyph: '?' },
  ];
  await size(1280, 800);
  for (const c of cases) {
    await send('Page.navigate', { url: base + '/office?' + c.url + '&still=1' }); await wait(1800);
    const g = await glanceReady();
    check(`${c.url}: sign data-state ${c.state}`, !!g && g.state === c.state, g && String(g.state));
    check(`${c.url}: sign word ${c.word}`, !!g && g.word === c.word, g && String(g.word));
    check(`${c.url}: tab title starts ${c.glyph} ${c.word} - `, !!g && typeof g.title === 'string' && g.title.startsWith(c.glyph + ' ' + c.word + ' - '), g && g.title);
    check(`${c.url}: canvas data: favicon`, !!g && /^data:image\//.test(g.favicon || ''), g && String(g.favicon).slice(0, 24));
    const ov = await overlap();
    check(`${c.url}: sign clears the station buttons`, !!ov && ov.ok, JSON.stringify(ov));
    await shot(`glance-${c.state}`);
  }

  // A 390 px wide phone shot of the needs state.
  await size(390, 844); await wait(500);
  await send('Page.navigate', { url: base + '/office?demo=needs&still=1' }); await wait(1800);
  const gn = await glanceReady();
  check('demo=needs phone: still needs-you', !!gn && gn.state === 'needs-you', gn && String(gn.state));
  const scrollW = await ev('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)');
  check('demo=needs phone: no horizontal overflow at 390 px', scrollW <= 391, String(scrollW));
  await shot('glance-needs-phone');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
