// Contract check for stale "Needs you" items (drift): rows show their age, finished lanes that need you for
// longer than 2 days sit in a collapsed "Older than 2 days" group with one "Mark all handled" button, and the
// same is available as `ca ack --stale [--older-than 48h] [--dry-run] --note t` and MCP ca_ack {stale:true}.
// Private registry with fake lanes; headless Chrome drives the real dashboard (skips without Chrome).
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
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const H = 3600e3, t = Date.now();
let sock = null;

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-drift-'));
  const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
  const repo = path.join(tmp, 'drift-repo');
  const lane = (task, st) => { const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ steps: 2, commits: 1, stepList: [], commitLog: [], tokens: {}, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: {}, ...st }));
    fs.writeFileSync(path.join(dir, 'live.log'), 'x\n'); fs.writeFileSync(path.join(dir, 'summary.md'), 'x\n');
    fs.writeFileSync(path.join(reg, `drift-repo--${task}.json`), JSON.stringify({ id: `drift-repo--${task}`, dir, repo, task })); };
  lane('oldfail', { pid: 999999, startedAt: t - 73 * H, finishedAt: t - 72 * H, lastEventAt: t - 72 * H, phase: 'finished', result: 'failed', reason: 'gates still failing', exitCode: 1, activity: 'failed' });
  lane('oldpause', { pid: 999999, startedAt: t - 97 * H, finishedAt: t - 96 * H, lastEventAt: t - 96 * H, phase: 'finished', result: 'paused', exitCode: 5, activity: 'paused' });
  lane('freshfail', { pid: 999999, startedAt: t - 2 * H, finishedAt: t - 1 * H, lastEventAt: t - 1 * H, phase: 'finished', result: 'failed', reason: 'check failed', exitCode: 1, activity: 'failed' });
  lane('running', { pid: process.pid, startedAt: t - 5 * 60e3, lastEventAt: t, phase: 'build', busy: true, activity: 'running' });
  return { tmp, reg, env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' } };
}
const bucketOf = (env) => { const r = spawnSync(process.execPath, [CA, 'status', '--json', '--all'], { env, encoding: 'utf8' }); let a = []; try { a = JSON.parse(r.stdout); } catch {} return Object.fromEntries(a.map((l) => [l.id.replace('drift-repo--', ''), l.bucket])); };

// ---- CLI ----
{
  const { tmp, env } = setup();
  const ca = (args) => spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000 });
  check('start: three lanes need you', Object.values(bucketOf(env)).filter((b) => b === 'attention').length === 3, JSON.stringify(bucketOf(env)));
  let r = ca(['ack', '--stale', '--dry-run']);
  check('ack --stale --dry-run lists the two lanes older than 2 days and changes nothing', r.status === 0 && /oldfail/.test(r.stdout) && /oldpause/.test(r.stdout) && !/freshfail/.test(r.stdout) && bucketOf(env).oldfail === 'attention', (r.stdout + r.stderr).slice(0, 200));
  r = ca(['ack', '--stale', '--note', 'old test lanes']);
  let b = bucketOf(env);
  check('ack --stale marks only the lanes older than 2 days handled', r.status === 0 && b.oldfail === 'ended' && b.oldpause === 'ended' && b.freshfail === 'attention' && b.running === 'running', JSON.stringify(b));
  r = ca(['ack', '--stale']);
  check('ack --stale with nothing old: exit 0 and says so', r.status === 0 && /nothing|no lane/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 160));
  r = ca(['ack', '--stale', '--older-than', '30m', '--note', 'fresh too']);
  b = bucketOf(env);
  check('--older-than 30m also takes the fresh failure; running lanes are never touched', r.status === 0 && b.freshfail === 'ended' && b.running === 'running', JSON.stringify(b));
  r = ca(['ack', '--stale', '--older-than', 'soon']);
  check('a bad --older-than is a usage error (exit 2)', r.status === 2, `${r.status} ${r.stderr.slice(0, 120)}`);
  r = ca(['help']);
  check('help lists ack --stale', /ack .*--stale/.test(r.stdout));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- MCP ----
{
  const { tmp, env } = setup();
  const srv = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let nid = 0;
  srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {} } });
  const rpc = (method, params) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => res({ timeout: true }), 30000); waiters.set(id, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drift', version: '1' } });
  const tools = (await rpc('tools/list', {})).result?.tools || [];
  const ack = tools.find((x) => x.name === 'ca_ack');
  check('MCP ca_ack takes stale and older_than_h, lane no longer required', ack && ack.inputSchema.properties.stale && ack.inputSchema.properties.older_than_h && !(ack.inputSchema.required || []).includes('lane'), JSON.stringify(ack && ack.inputSchema).slice(0, 200));
  const m = await rpc('tools/call', { name: 'ca_ack', arguments: { stale: true, note: 'cleanup from the lead' } });
  const b = bucketOf(env);
  check('MCP ca_ack {stale:true} handles the old lanes only', m.result && !m.result.isError && b.oldfail === 'ended' && b.oldpause === 'ended' && b.freshfail === 'attention', JSON.stringify(b));
  const m2 = await rpc('tools/call', { name: 'ca_ack', arguments: {} });
  check('MCP ca_ack with neither lane nor stale is a tool error', m2.result?.isError === true || !!m2.error);
  srv.stdin.end(); try { srv.kill(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- dashboard ----
const chromePath = findChrome();
if (!chromePath) results.push('PASS SKIP dashboard part: no Chrome found (set CHROME_PATH)');
else {
  const { tmp, env } = setup();
  const dp = await free(), cp = await free();
  const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { stdio: 'ignore', env });
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cp}`, `--user-data-dir=${chromeProfileDir('drift')}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
  guard({ children: [dash, chrome] });
  try {
    let ws = null; for (let i = 0; i < 60 && !ws; i++) { await wait(250); try { ws = (await (await fetch(`http://127.0.0.1:${cp}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
    sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r)); guard({ socket: sock });
    let n = 0; const pend = new Map(); sock.addEventListener('message', (e) => { const mm = JSON.parse(e.data); if (mm.id && pend.has(mm.id)) { pend.get(mm.id)(mm.result); pend.delete(mm.id); } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${dp}/` }); await wait(3500);
    const sec = `document.querySelector('.cr-sec[data-bucket="attention"]')`;
    const info = await ev(`(() => { const s = ${sec}; if (!s) return null; const old = s.querySelector('.cr-old'); return {
      count: (s.querySelector('.cr-sec-h .cnt') || {}).textContent,
      oldHead: old ? (old.querySelector('.cr-old-h') || old).textContent : '',
      oldBtn: !!(old && old.querySelector('[data-ack-stale]')),
      text: s.textContent } })()`);
    check('Needs you still counts all three (old ones still need a decision)', info && String(info.count).trim() === '3', JSON.stringify(info && info.count));
    check('rows show their age (for example 3d ago, 4d ago, 1h ago)', info && /3d ago/.test(info.text) && /4d ago/.test(info.text) && /1h ago/.test(info.text), info && info.text.slice(0, 200));
    check('an "Older than 2 days" group holds the two old lanes', info && /Older than 2 days/i.test(info.oldHead) && /\b2\b/.test(info.oldHead), info && info.oldHead);
    const grouped = await ev(`(() => { const old = ${sec}.querySelector('.cr-old'); return old ? old.textContent : ''; })()`);
    check('the fresh failure is not in the old group', !/freshfail/.test(grouped || ''), (grouped || '').slice(0, 160));
    check('the group has a Mark all handled button', info && info.oldBtn);
    await ev(`window.prompt = () => 'bulk cleanup'; true`);
    await ev(`(${sec}.querySelector('[data-ack-stale]')).click()`);
    let b = {}; for (let i = 0; i < 20; i++) { await wait(300); b = bucketOf(env); if (b.oldfail === 'ended' && b.oldpause === 'ended') break; }
    check('Mark all handled moves the old lanes to Ended, the fresh one stays', b.oldfail === 'ended' && b.oldpause === 'ended' && b.freshfail === 'attention' && b.running === 'running', JSON.stringify(b));
    await wait(3000);
    const after = await ev(`(() => { const s = ${sec}; return { count: (s.querySelector('.cr-sec-h .cnt') || {}).textContent, old: !!s.querySelector('.cr-old') }; })()`);
    check('after the bulk action Needs you shows 1 and no old group', after && String(after.count).trim() === '1' && after.old === false, JSON.stringify(after));
    sock.close();
  } catch (e) { check('dashboard part ran', false, String(e && e.stack || e)); }
  await settle({ socket: sock, children: [dash, chrome], code: 0 });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
}

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exitCode = fails ? 1 : 0;
