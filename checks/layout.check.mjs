// Layout check for the Office view: sprites must stay inside the stage, must not cover other
// platforms' nameplates or each other, and must stay legible, also with many lanes (?demo=big).
// Usage: node checks/layout.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
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
const profile = path.join(process.env.TEMP || ROOT, `ca-layout-profile-${Date.now()}`);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
const timer = setTimeout(() => { console.log('FAIL timeout after 120 s'); cleanup(); process.exit(1); }, 120000);

// Geometry measured in the page: the rendered art of each sprite (the <g> inside its svg, so the
// transparent part of the sprite box does not count), each nameplate, and the stage.
const MEASURE = `(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const stage = r(document.getElementById('stage'));
  const arts = [...document.querySelectorAll('#actors .char')].map((el) => {
    const svg = el.querySelector('.cfloat svg:last-child'); const g = svg && svg.querySelector(':scope > g');
    return { id: el.dataset.char, ...(g ? r(g) : r(el)) };
  });
  const plates = [...document.querySelectorAll('#floor .node')].map((g) => ({ id: g.dataset.node, ...r(g.querySelector('.plate rect')) }));
  return { stage, arts, plates };
})()`;
const inter = (a, b, pad) => a.x + pad < b.x + b.w && b.x + pad < a.x + a.w && a.y + pad < b.y + b.h && b.y + pad < a.y + a.h;

try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');

  const cases = [
    { name: 'demo=1 desktop', url: '/office?demo=1', w: 1400, h: 900, minArt: 90 },
    { name: 'demo=big desktop', url: '/office?demo=big', w: 1400, h: 900, minArt: 90, lanes: 8 },
    { name: 'demo=big done', url: '/office?demo=big&done=1', w: 1400, h: 900, minArt: 90, lanes: 8 },
    { name: 'demo=big phone', url: '/office?demo=big', w: 390, h: 800, minArt: 45, lanes: 8 },
  ];
  for (const k of cases) {
    await size(k.w, k.h); await send('Page.navigate', { url: base + k.url }); await wait(2200);
    const s = await ev('window.__office && window.__office.state()');
    const lanes = s ? s.nodes.filter((n) => n.kind === 'lane') : [];
    if (k.lanes) {
      check(`${k.name}: ${k.lanes} lane nodes`, lanes.length === k.lanes, String(lanes.length));
      check(`${k.name}: lanes on 3+ rows`, new Set(lanes.map((n) => Math.round(n.y))).size >= 3, [...new Set(lanes.map((n) => Math.round(n.y)))].join(','));
    }
    if (k.url.includes('done=1')) check(`${k.name}: every lane done`, lanes.every((n) => n.health === 'done'), lanes.map((n) => n.health).join(','));
    // the stage may scroll vertically: measure with the stage scrolled to the top and to the bottom
    const m = await ev(MEASURE);
    check(`${k.name}: one art box per node`, m.arts.length === s.nodes.length, `${m.arts.length}/${s.nodes.length}`);
    const sh = await ev(`(() => { const st = document.getElementById('stage'); return { sh: st.scrollHeight, ch: st.clientHeight }; })()`);
    const full = { ...m.stage, h: Math.max(m.stage.h, sh.sh) };
    const outside = m.arts.filter((a) => a.x < full.x - 2 || a.y < full.y - 2 || a.x + a.w > full.x + full.w + 2 || a.y + a.h > full.y + full.h + 2);
    check(`${k.name}: every sprite inside the stage`, !outside.length, outside.map((a) => `${a.id}@${a.x | 0},${a.y | 0} ${a.w | 0}x${a.h | 0}`).join(' ') + ` stage ${full.x | 0},${full.y | 0} ${full.w | 0}x${full.h | 0}`);
    const covers = [];
    for (const a of m.arts) for (const p of m.plates) if (a.id !== p.id && inter(a, p, 3)) covers.push(`${a.id} covers plate ${p.id}`);
    check(`${k.name}: no sprite covers another nameplate`, !covers.length, covers.slice(0, 4).join('; '));
    const clash = [];
    for (let i = 0; i < m.arts.length; i++) for (let j = i + 1; j < m.arts.length; j++) if (inter(m.arts[i], m.arts[j], 6)) clash.push(`${m.arts[i].id}/${m.arts[j].id}`);
    check(`${k.name}: sprites do not overlap each other`, !clash.length, clash.slice(0, 4).join(' '));
    const small = m.arts.filter((a) => a.w < k.minArt);
    check(`${k.name}: sprites at least ${k.minArt}px wide`, !small.length, small.map((a) => `${a.id} ${a.w | 0}px`).join(' '));
    if (k.w < 500) check(`${k.name}: no horizontal page scroll`, (await ev('document.documentElement.scrollWidth')) <= k.w + 1);
    await shot('layout-' + k.name.replace(/[^\w]+/g, '-'));
  }
  check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) { check('run', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
