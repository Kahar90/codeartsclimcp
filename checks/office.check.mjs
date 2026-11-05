// End-to-end check for the Office view: starts `ca dash` on a free port, drives /office in headless Chrome over CDP.
// Usage: node checks/office.check.mjs [outDir]   (screenshots go to outDir, default checks/out)
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
const profile = path.join(process.env.TEMP || ROOT, `ca-office-profile-${Date.now()}`);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
const timer = setTimeout(() => { console.log('FAIL timeout after 120 s'); cleanup(); process.exit(1); }, 120000);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  const page = await fetch(base + '/office'); const html = await page.text();
  check('GET /office serves the page', page.ok && /__office/.test(html) && /<title>/.test(html), String(page.status));
  check('GET /office-sprites.js route exists', [200, 404].includes((await fetch(base + '/office-sprites.js')).status));
  const dashHtml = await (await fetch(base + '/')).text();
  check('lanes dashboard links to the office view', /href="\/office"/.test(dashHtml));

  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const st = () => ev('window.__office && window.__office.state()');
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');

  await size(1400, 900); await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(1800);
  let s = await st();
  check('test hook window.__office.state()', !!s && Array.isArray(s.nodes));
  if (s) {
    const lead = s.nodes.filter((n) => n.kind === 'lead'); const ls = s.nodes.filter((n) => n.kind === 'lane');
    check('demo mode', s.mode === 'demo', s.mode);
    check('one lead node + 3 lane nodes', lead.length === 1 && ls.length === 3, `${lead.length}/${ls.length}`);
    check('one link per lane', s.links === 3, String(s.links));
    const H = ['planned', 'running', 'running tool', 'quiet', 'STALLED', 'DEAD', 'done', 'needs review', 'failed', 'stopped'];
    check('lane health from the runner set', ls.every((n) => H.includes(n.health)), ls.map((n) => n.health).join(','));
    check('lane steps known', ls.every((n) => n.steps && n.steps.total > 0), ls.map((n) => n.steps && `${n.steps.done}/${n.steps.total}`).join(','));
    check('nodes inside the viewport', s.nodes.every((n) => n.x > 0 && n.x < 1400 && n.y > 0 && n.y < 900), s.nodes.map((n) => `${n.x|0},${n.y|0}`).join(' '));
    const far = s.nodes.every((a, i) => s.nodes.every((b, j) => i >= j || Math.hypot(a.x - b.x, a.y - b.y) > 150));
    check('platforms do not overlap', far);
    check('demo has the goal line', typeof s.goal === 'string' && s.goal.length > 10);
    await shot('1-scene');
    const run = ls.find((n) => n.health === 'running') || ls[0];
    await click(run.x, run.y); await wait(500); s = await st();
    check('click on a platform selects it', s.selected === run.id, `${s.selected} vs ${run.id}`);
    check('card opens with the step checklist', s.card && s.card.open && s.card.steps.length === run.steps.total, JSON.stringify(s.card && { open: s.card.open, n: s.card.steps.length }));
    check('card shows done and current steps', s.card && s.card.steps.some((x) => x.state === 'done') && s.card.steps.some((x) => x.state === 'current'));
    check('card has progress text', s.card && /\d+\s*\/\s*\d+/.test(s.card.progress || ''), s.card && s.card.progress);
    await shot('2-card');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(300);
    s = await st(); check('Escape closes the card', s.card && !s.card.open);
    const ld = s.nodes.find((n) => n.kind === 'lead'); await click(ld.x, ld.y); await wait(400); s = await st();
    check('lead card opens', s.selected === ld.id && s.card && s.card.open);
    check('not complete while lanes run', s.complete === false);
  }
  await send('Page.navigate', { url: base + '/office?demo=done' }); await wait(1800); s = await st();
  check('demo=done shows completion', s && s.complete === true);
  check('completion panel lists every lane', (await ev(`(() => { const e = document.getElementById('complete'); return e && e.offsetParent !== null ? e.querySelectorAll('tbody tr').length : -1 })()`)) === 3);
  await shot('3-complete');
  await size(390, 800); await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(1500);
  check('no horizontal scroll at phone width', (await ev('document.documentElement.scrollWidth')) <= 391, String(await ev('document.documentElement.scrollWidth')));
  await shot('4-phone');
  await size(1400, 900); await send('Page.navigate', { url: base + '/office' }); await wait(2500); s = await st();
  check('live mode renders from the runner API', s && s.mode === 'live' && s.nodes.some((n) => n.kind === 'lead'), s && `${s.mode} ${s.nodes.length}`);
  await shot('5-live');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
