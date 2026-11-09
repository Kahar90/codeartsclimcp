// Contract check for lead visibility in both views (isolated registry, fake plans, Chrome): the lead
// phase, activity, age and stale state render in the Lanes plan view and the Office, a plan update and
// activity published through CLI/MCP show up within a poll, a legacy plan reports no age, and user text
// is escaped (never injected as HTML). Uses checks/lib/chrome.mjs and window.__lanes / window.__office.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const chromePath = findChrome();
if (!chromePath) { console.log('SKIP leadui: no Chrome found (set CHROME_PATH)'); process.exit(0); }
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-leadui-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const planFile = (name, plan) => { const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true }); const f = path.join(repo, 'tasks', 'plan.json'); fs.writeFileSync(f, JSON.stringify(plan, null, 2)); return f; };
const ca = (args) => spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 30000 });
const publish = (args) => ca(args);

const iso = (ms) => new Date(ms).toISOString();
const t = Date.now();
const liveF = planFile('uiproj', { title: 'UI plan', goal: 'Original goal', status: 'running', waves: [{ name: 'W', lanes: ['build'] }], lanes: [{ task: 'build' }] });
const staleF = planFile('staleproj', { title: 'Stale plan', status: 'running', now: 'old update', nowAt: iso(t - 6 * 60e3), waves: [{ name: 'W', lanes: [] }], lanes: [] });
const noF = planFile('noproj', { title: 'No time plan', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
for (const f of [liveF, staleF, noF]) ca(['plan', f]);

// Publish an activity through the CLI and a plan change through the MCP stdio tool.
publish(['note', '--now', '--phase', 'building', '--plan', 'uiproj', 'building the ui']);
const mcpCall = (name, args) => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  ].join('\n') + '\n';
  const r = spawnSync(process.execPath, [CA, 'mcp'], { input: lines, env, encoding: 'utf8', timeout: 30000 });
  const line = (r.stdout || '').split(/\r?\n/).reverse().find((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } });
  try { return JSON.parse(line); } catch { return null; }
};
const mcpRes = mcpCall('ca_plan_update', { id: 'uiproj', patch: { goal: 'Revised goal', next: ['ship it'] } });

const dp = await free(), cp = await free();
const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { stdio: 'ignore', env });
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('leadui')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
let sock = null;
const finish = (code) => settle({ socket: sock, children: [chrome, dash], code });
guard({ children: [chrome, dash] });
const timer = setTimeout(() => { console.log('FAIL timeout'); finish(1); }, 150000);
try {
  check('MCP ca_plan_update published the goal before render', !mcpRes?.result?.isError, JSON.stringify(mcpRes && mcpRes.result && mcpRes.result.content).slice(0, 160));
  let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
  sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
  let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const until = async (expr, ms = 10000) => { let v; for (let i = 0; i < ms / 250; i++) { v = await ev(expr); if (v) return v; await wait(250); } return v; };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const nav = async (url) => { await send('Page.navigate', { url }); await wait(400); };

  // ---- Lanes plan view (dash) ----
  await nav(`http://127.0.0.1:${dp}/#/plan/uiproj`);
  let ok = await until(`/building/.test((document.getElementById('leadPhase')||{}).textContent||'')`);
  check('dash shows the lead phase', !!ok, await ev(`(document.getElementById('leadPhase')||{}).textContent||''`));
  ok = await until(`/building the ui/.test((document.getElementById('leadActivity')||{}).textContent||'')`);
  check('dash shows the recent lead activity', !!ok, await ev(`(document.getElementById('leadActivity')||{}).textContent||''`));
  check('dash shows the activity age', /ago/.test(await ev(`(document.getElementById('leadAge')||{}).textContent||''`)), await ev(`(document.getElementById('leadAge')||{}).textContent||''`));
  ok = await until(`/Revised goal/.test(document.body.textContent)`);
  check('dash shows the revised goal', !!ok, await ev(`(document.querySelector('.goal')||{}).textContent||''`));
  check('dash shows the revised next task', /ship it/.test(await ev('document.body.textContent')));

  // ---- Office view ----
  await nav(`http://127.0.0.1:${dp}/office`);
  const pick = async (re) => { for (let i = 0; i < 40; i++) { const done = await ev(`(() => { const s = document.getElementById('planSel'); if (!s) return false; const o = [...s.options].find((x) => ${re}.test(x.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`); if (done) return true; await wait(250); } return false; };
  ok = await pick('/UI plan/'); await wait(600);
  check('office picker selects the live plan', !!ok, await ev(`(document.getElementById('planTitle')||{}).textContent||''`));
  check('office shows the lead phase and activity', await ev(`(window.__office.state().lead||{}).phase === 'building' && (window.__office.state().lead.activity||[]).join(' ').includes('building the ui')`), JSON.stringify(await ev('window.__office.state().lead')));
  check('office now line shows the activity', /building the ui/.test(await ev(`(document.getElementById('nowLine')||{}).textContent||''`)), await ev(`(document.getElementById('nowLine')||{}).textContent||''`));
  check('office now line shows the activity age', /ago/.test(await ev(`(document.getElementById('nowLine')||{}).textContent||''`)));

  // ---- stale: the age is labelled, never read as "the lead stopped" ----
  await nav(`http://127.0.0.1:${dp}/#/plan/staleproj`);
  ok = await until(`/ago/.test((document.getElementById('leadAge')||{}).textContent||'')`);
  check('dash labels a stale lead age', !!ok, await ev(`(document.getElementById('leadAge')||{}).textContent||''`));
  check('dash marks the stale age (age, not proof the lead stopped)', await ev(`(document.getElementById('leadAge')||{}).dataset.stale === '1'`));
  await nav(`http://127.0.0.1:${dp}/office`); await pick('/Stale plan/'); await wait(600);
  check('office marks the stale lead age', await ev(`(window.__office.state().lead||{}).stale === true && typeof (window.__office.state().lead||{}).age === 'number'`), JSON.stringify(await ev('window.__office.state().lead')));

  // ---- legacy plan: no timestamp, so no age is reported ----
  await nav(`http://127.0.0.1:${dp}/#/plan/noproj`);
  await until(`/No time plan/.test(document.body.textContent)`);
  check('dash reports no age for a plan with no timestamp', ((await ev(`(document.getElementById('leadAge')||{}).textContent||''`)) || '').trim() === '', JSON.stringify(await ev(`(document.getElementById('leadAge')||{}).textContent||''`)));
  await nav(`http://127.0.0.1:${dp}/office`); await pick('/No time plan/'); await wait(600);
  check('office reports no age for a plan with no timestamp', await ev(`(window.__office.state().lead||{}).age === null`), JSON.stringify(await ev('window.__office.state().lead')));

  // ---- escaped user text: never injected as HTML ----
  publish(['note', '--now', '--plan', 'uiproj', '<img src=x onerror="window.__esc=1">hey']);
  await nav(`http://127.0.0.1:${dp}/#/plan/uiproj`);
  await until(`/hey/.test(document.body.textContent)`);
  check('dash escapes user text (no injected element)', await ev(`document.querySelectorAll('#view img').length === 0 && window.__esc === undefined`), await ev(`(document.getElementById('leadActivity')||{}).textContent||''`));
  check('dash shows the user text literally', /<img/.test(await ev('document.body.textContent || document.body.innerText')));
  await nav(`http://127.0.0.1:${dp}/office`); await pick('/UI plan/'); await wait(600);
  check('office escapes the now line (no injected element)', await ev(`document.querySelectorAll('#nowLine img').length === 0 && window.__esc === undefined`), await ev(`(document.getElementById('nowLine')||{}).textContent||''`));

  sock.close();
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(timer);
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
await finish(fails ? 1 : 0);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
