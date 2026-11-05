// Motion contract for the Office view: intro, stable DOM across ticks, hover, live step effects, reduced motion, frame rate.
// Usage: node checks/motion.check.mjs [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'checks', 'out', 'motion')); fs.mkdirSync(out, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);
const dashPort = await freePort(); const cdpPort = await freePort();
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(dashPort)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${dashPort}`;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(process.env.TEMP || ROOT, 'ca-motion-' + Date.now())}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
const timer = setTimeout(() => { console.log('FAIL timeout after 150 s'); cleanup(); process.exit(1); }, 150000);
try {
  for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(base + '/api/lanes')).ok) break; } catch {} }
  let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr, awaitPromise = false) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })).result?.result?.value;
  const st = () => ev('window.__office && window.__office.state()');
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  // intro
  await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(250);
  let s = await st();
  check('intro is running right after load', s && s.anim && s.anim.intro === 'running', JSON.stringify(s && s.anim));
  await shot('1-intro-early');
  await wait(450); await shot('2-intro-mid');
  await wait(2600); s = await st();
  check('intro done within 3.3 s', s.anim.intro === 'done', s.anim.intro);
  check('ambient animations run (rims, packets, idle float)', (await ev('document.getAnimations().length')) >= 4, String(await ev('document.getAnimations().length')));
  check('not reduced motion by default', s.anim.reducedMotion === false);
  await shot('3-settled');

  // frame rate while ambient motion runs
  const fps = await ev(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(f); else r(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); })`, true);
  check('frame rate stays smooth (>= 40 fps headless)', fps >= 40, `${Math.round(fps)} fps`);
  check('only transform/opacity/filter/stroke-dashoffset are animated', await ev(`document.getAnimations().every((a) => { const k = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : []; return k.every((f) => Object.keys(f).every((p) => ['offset', 'easing', 'composite', 'computedOffset', 'transform', 'opacity', 'filter', 'strokeDashoffset', 'offsetDistance', 'translate', 'scale', 'rotate'].includes(p))); })`));

  // DOM stays stable across data ticks (no innerHTML rebuild that restarts animations)
  await ev(`(() => { const e = document.querySelector('[data-node="office-scene"]'); if (e) e.__mark = 7; return !!e; })()`);
  const ticks0 = s.ticks || 0; await wait(4500); s = await st();
  check('demo ticks every 2 s through the same render path', (s.ticks || 0) - ticks0 >= 2, `${ticks0} -> ${s.ticks}`);
  check('platform element survives ticks (keyed update)', (await ev(`(() => { const e = document.querySelector('[data-node="office-scene"]'); return e ? e.__mark : 'missing'; })()`)) === 7);

  // hover lift
  const n = s.nodes.find((x) => x.id === 'office-scene');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: n.x, y: n.y }); await wait(400); s = await st();
  check('hover tracks the platform', s.hovered === 'office-scene', String(s.hovered));
  await shot('4-hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await wait(300);

  // card pop + stagger
  await ev(`window.__office.select('office-scene')`); await wait(60); s = await st();
  check('card opening animates', s.anim.card === 'opening', s.anim.card);
  await wait(900); s = await st(); check('card settles open', s.anim.card === 'open' && s.card.open, s.anim.card);
  await shot('5-card');

  // live step completion effect
  const before = s.nodes.find((x) => x.id === 'office-scene').steps.done;
  await ev(`window.__office.demoAdvance('office-scene')`); await wait(120); s = await st();
  check('demoAdvance completes a step', s.nodes.find((x) => x.id === 'office-scene').steps.done === before + 1);
  check('step-done effect fires', s.anim.lastEffect === 'step-done:office-scene', s.anim.lastEffect);
  check('ripple element appears on the platform', (await ev(`document.querySelectorAll('.ripple').length`)) >= 1);
  check('card checklist updated in place', s.card.steps.filter((x) => x.state === 'done').length === before + 1);
  await shot('6-step-done');
  await wait(1600);
  check('ripple cleans itself up', (await ev(`document.querySelectorAll('.ripple').length`)) === 0);
  for (let i = 0; i < 6; i++) await ev(`window.__office.demoAdvance('office-scene')`);
  await wait(200); s = await st();
  check('finishing a lane fires lane-done', s.nodes.find((x) => x.id === 'office-scene').health === 'done' && /lane-done:office-scene/.test((s.anim.effects || []).join(' ')), JSON.stringify(s.anim.effects));
  await ev(`window.__office.demoFail && window.__office.demoFail('office-sprites')`); await wait(150); s = await st();
  check('a failing lane fires lane-failed', /lane-failed:office-sprites/.test((s.anim.effects || []).join(' ')), JSON.stringify(s.anim.effects));
  await wait(1200); await shot('7-after-events');

  // completion counters
  await send('Page.navigate', { url: base + '/office?demo=done' }); await wait(500);
  const mid = await ev(`(() => { const e = document.querySelector('#complete [data-count]'); return e ? e.textContent : null; })()`);
  await wait(3500);
  const end = await ev(`(() => { const e = document.querySelector('#complete [data-count]'); return e ? { t: e.textContent, want: e.getAttribute('data-count') } : null; })()`);
  check('completion counters count up to their value', end && String(end.t).replace(/[^\d.]/g, '') === String(end.want).replace(/[^\d.]/g, ''), JSON.stringify({ mid, end }));
  const sentence = await ev(`(() => { const e = document.querySelector('#complete'); return e ? e.textContent.replace(/\\s+/g, ' ') : ''; })()`);
  check('completion time is human readable (e.g. 1h 26m), not raw seconds', /\b\d+h( \d+m)?\b|\b\d+m( \d+s)?\b/.test(sentence) && !/\b\d{3,} s\b/.test(sentence), sentence.slice(0, 160));
  await shot('8-complete');

  // reduced motion
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(300); s = await st();
  check('reduced motion: flag set and intro skipped', s.anim.reducedMotion === true && s.anim.intro === 'done', JSON.stringify(s.anim));
  check('reduced motion: no infinite animations', await ev(`document.getAnimations().every((a) => !a.effect || a.effect.getComputedTiming().iterations !== Infinity)`));
  await wait(2200); await ev(`window.__office.demoFail('office-sprites')`); await wait(60);
  const rmFx = await ev(`document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().duration > 0 && a.effect.getComputedTiming().duration <= 200).length`);
  s = await st();
  check('reduced motion: lane-failed still logged and shown as a short fade', /lane-failed:office-sprites/.test((s.anim.effects || []).join(' ')) && rmFx >= 1, `fx=${rmFx} ${JSON.stringify(s.anim.effects)}`);
  await send('Emulation.setEmulatedMedia', { features: [] });

  // resize across the small breakpoint: platforms re-bake their geometry in place
  await send('Page.navigate', { url: base + '/office?demo=1' }); await wait(3200);
  await ev(`(() => { const e = document.querySelector('[data-node="office-scene"]'); if (e) e.__mark = 9; return !!e; })()`);
  const geo = () => ev(`(() => { const g = window.__office.state().geometry; const rx = [...document.querySelectorAll('[data-node] .plat-top')].map((e) => Number(e.getAttribute('rx'))); return { g, rx }; })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 650, height: 800, deviceScaleFactor: 1, mobile: false }); await wait(2500);
  let gs = await geo();
  check('resize to small: geometry.small and every platform top uses the new RX', gs && gs.g && gs.g.small === true && gs.rx.length >= 4 && gs.rx.every((x) => x === gs.g.RX), JSON.stringify(gs));
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }); await wait(2500);
  gs = await geo();
  const kept = await ev(`(() => { const e = document.querySelector('[data-node="office-scene"]'); return e ? e.__mark : 'missing'; })()`);
  check('resize back: large RX again, same elements (no rebuild)', gs && gs.g && gs.g.small === false && gs.rx.every((x) => x === gs.g.RX) && kept === 9, JSON.stringify({ gs, kept }));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer); cleanup();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
