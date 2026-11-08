// Contract check for the lane status model: one status per lane, shown the same way in the CLI, the
// MCP tools and both views. Unit-tests classifyCheck and laneOutcome, drives `ca status --json` and
// `ca wait` on fake lanes, then checks the dashboard API and the demo badges in headless Chrome.
// Usage: node checks/status.check.mjs [--unit] [outDir]   (--unit runs the pure and CLI parts only)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome, chromeProfileDir, chromeFlags } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const unitOnly = process.argv.includes('--unit');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(outArg || path.join(ROOT, 'checks', 'out'));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const report = () => { console.log(results.join('\n')); const bad = results.filter((r) => r.startsWith('FAIL')).length; console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`); return bad; };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- (a) pure module: classifyCheck + laneOutcome ----------
let C = null;
try { C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href); } catch (e) { check('runner/controls.mjs loads', false, e.message); }
if (C) {
  const cc = C.classifyCheck, lo = C.laneOutcome;
  check('classifyCheck: exit 0 passes', cc({ code: 0, out: 'ok' }) === 'pass');
  check('classifyCheck: exit 1 fails', cc({ code: 1, out: 'FAIL one case' }) === 'fail');
  check('classifyCheck: exit 127 is infra', cc({ code: 127, out: '' }) === 'infra');
  check('classifyCheck: missing tool is infra', cc({ code: 1, out: 'node: command not found' }) === 'infra');
  check('classifyCheck: ENOENT is infra', cc({ code: 1, out: 'spawn ENOENT' }) === 'infra');
  check('classifyCheck: sandbox network error is infra', cc({ code: 1, out: 'Sandbox Network Error' }) === 'infra');
  check('classifyCheck: a real assertion failure stays fail', cc({ code: 1, out: 'FAIL expected 1 got 2' }) === 'fail');

  const J = (name, o, key, label, tone) => check(`laneOutcome: ${name}`, o.key === key && o.label === label && (tone === undefined || o.tone === tone), JSON.stringify(o));
  J('running lane keeps Running', lo({ s: { phase: 'build' }, health: 'running tool' }), 'running', 'Running', 'run');
  J('stalled lane reads Stalled', lo({ s: { phase: 'build' }, health: 'STALLED' }), 'running', 'Stalled', 'bad');
  J('a dead supervisor reads Failed', lo({ s: { phase: 'build' }, health: 'DEAD (ca stop cleans up)' }), 'failed', 'Supervisor died', 'bad');
  J('done with a green check round reads Verified', lo({ s: { result: 'done', gates: [{ gate: 'git clean', ok: true }, { gate: 'node --check runner/ca.mjs', ok: true }, { gate: 'node checks/assets.check.mjs', ok: true }] } }), 'verified', 'Verified', 'done');
  J('done with no checks reads Done', lo({ s: { result: 'done', gates: [] } }), 'done', 'Done', 'done');
  J('unverified reads Unverified', lo({ s: { result: 'unverified', reason: "checks couldn't run: node --check runner/ca.mjs (exit 127)" } }), 'unverified', 'Unverified', 'warn');
  J('checks failing reads Checks failing', lo({ s: { result: 'checks failing', reason: 'checks failing: node checks/assets.check.mjs (exit 1)' } }), 'checks failing', 'Checks failing', 'bad');
  J('legacy failed (infra gate) reads Unverified', lo({ s: { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'git clean', ok: true }, { gate: 'node --check runner/ca.mjs', ok: false, code: 127 }] } }), 'unverified', 'Unverified', 'warn');
  J('legacy failed (real gate) reads Checks failing', lo({ s: { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'git clean', ok: true }, { gate: 'node checks/assets.check.mjs', ok: false, code: 1 }] } }), 'checks failing', 'Checks failing', 'bad');
  J('needs review reads Needs review', lo({ s: { result: 'needs review' } }), 'needs review', 'Needs review', 'warn');
  J('an auth failure reads Failed', lo({ s: { result: 'failed', exitCode: 3, reason: 'auth' } }), 'failed', 'Failed', 'bad');
  J('a worker breakdown reads Failed', lo({ s: { result: 'failed', reason: 'the worker crashed' } }), 'failed', 'Failed', 'bad');
  J('paused reads Paused', lo({ s: { result: 'paused' } }), 'paused', 'Paused', 'warn');
  J('stopped reads Stopped', lo({ s: { result: 'stopped' } }), 'stopped', 'Stopped', 'idle');
  J('handled overrides a done lane', lo({ s: { result: 'done' }, handled: true, note: 'took it over by hand' }), 'handled', 'Handled by lead', 'idle');
  J('handled with a merge note reads Merged', lo({ s: { result: 'done' }, handled: true, note: 'merged by the lead' }), 'handled', 'Merged', 'done');
  J('handled overrides a failed lane', lo({ s: { result: 'failed' }, handled: true, note: 'merged into main' }), 'handled', 'Merged', 'done');
}

// ---------- (b) fake lanes: ca status --json and ca wait ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-status-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const repo = path.join(tmp, 'status-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const fake = (task, st) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  const t = Date.now() - 600000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: `status-repo--${task}`, task, repo, dir, pid: 999999, startedAt: t, finishedAt: t + 300000, lastEventAt: t + 300000, phase: 'finished', busy: false, exitCode: 1,
    commits: 2, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: '', models: {}, ...st }));
  fs.writeFileSync(path.join(reg, `status-repo--${task}.json`), JSON.stringify({ id: `status-repo--${task}`, dir, repo, task }));
};
fake('unver', { result: 'unverified', reason: "checks couldn't run: node --check runner/ca.mjs (exit 127)" });
fake('failing', { result: 'checks failing', reason: 'checks failing: node checks/assets.check.mjs (exit 1)', verdict: 'needs fixes' });
fake('verified', { result: 'done', verdict: 'ready', exitCode: 0, gates: [{ gate: 'git clean', ok: true }, { gate: 'node --check runner/ca.mjs', ok: true }, { gate: 'node checks/assets.check.mjs', ok: true }] });
fake('plained', { result: 'done', verdict: 'ready', exitCode: 0 });
fake('legacyinfra', { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'git clean', ok: true }, { gate: 'node --check runner/ca.mjs', ok: false, code: 127 }] });
fake('legacyfail', { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'git clean', ok: true }, { gate: 'node checks/assets.check.mjs', ok: false, code: 1 }] });

let rows = []; try { rows = JSON.parse(ca(['status', '--json']).out); } catch (e) { check('status --json parses', false, e.message); }
const row = (t) => rows.find((x) => x.task === t) || {};
check('status --json carries status for every lane', rows.length >= 6 && rows.every((x) => x.status && typeof x.status.key === 'string' && typeof x.status.label === 'string'), String(rows.length));
check('status row: unverified', row('unver').status?.key === 'unverified' && row('unver').status?.label === 'Unverified', JSON.stringify(row('unver').status));
check('status row: checks failing', row('failing').status?.key === 'checks failing' && row('failing').status?.label === 'Checks failing', JSON.stringify(row('failing').status));
check('status row: verified', row('verified').status?.key === 'verified' && row('verified').status?.label === 'Verified', JSON.stringify(row('verified').status));
check('status row: plain done', row('plained').status?.key === 'done' && row('plained').status?.label === 'Done', JSON.stringify(row('plained').status));
check('status row: legacy infra failure reads Unverified', row('legacyinfra').status?.key === 'unverified', JSON.stringify(row('legacyinfra').status));
check('status row: legacy real failure reads Checks failing', row('legacyfail').status?.key === 'checks failing', JSON.stringify(row('legacyfail').status));

check('ca wait: unverified exits 4', ca(['wait', 'status-repo--unver', '--quiet']).code === 4);
check('ca wait: checks failing exits 1', ca(['wait', 'status-repo--failing', '--quiet']).code === 1);
check('ca wait: verified exits 0', ca(['wait', 'status-repo--verified', '--quiet']).code === 0);

if (unitOnly) {
  const bad = report();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

// ---------- (c) dashboard API, then (d) demo badges in Chrome ----------
let chrome = null;
const dashPort = await freePort();
const dash = spawn(process.execPath, [CA, 'dash', String(dashPort)], { stdio: 'ignore', env });
const base = `http://127.0.0.1:${dashPort}`;
const cleanup = () => { try { if (chrome) chrome.kill(); } catch {} try { dash.kill(); } catch {} };
process.on('exit', cleanup);
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await wait(250); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  let lanes = []; try { lanes = await (await fetch(base + '/api/lanes')).json(); } catch {}
  const L = (t) => lanes.find((x) => x.task === t) || {};
  check('/api/lanes carries status for every lane', lanes.length >= 6 && lanes.every((x) => x.status && typeof x.status.key === 'string'), String(lanes.length));
  check('/api/lanes: unverified', L('unver').status?.key === 'unverified' && L('unver').status?.label === 'Unverified', JSON.stringify(L('unver').status));
  check('/api/lanes: checks failing', L('failing').status?.key === 'checks failing' && L('failing').status?.label === 'Checks failing', JSON.stringify(L('failing').status));
  check('/api/lanes: verified', L('verified').status?.key === 'verified' && L('verified').status?.label === 'Verified', JSON.stringify(L('verified').status));

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP status browser part: no Chrome found (set CHROME_PATH)');
  } else {
    fs.mkdirSync(out, { recursive: true });
    const cdpPort = await freePort();
    const profile = chromeProfileDir('status');
    chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', ...chromeFlags, 'about:blank'], { stdio: 'ignore' });
    let ws; for (let i = 0; i < 80 && !ws; i++) { await wait(250); try { const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
    const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
    let id = 0; const pending = new Map(); const errors = [];
    sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
    const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
    await send('Runtime.enable');
    await size(1280, 800);

    // The Lanes demo carries one lane per new finish state; its detail badge is the lane status.
    const laneBadge = async (lid) => { await send('Page.navigate', { url: base + '/?demo=1#/lane/' + lid }); await wait(1400); return ev('(function(){var r=document.querySelector(".idrow .ca-badge");return r?r.textContent:null;})()'); };
    const du = await laneBadge('demo-repo--unverified');
    const df = await laneBadge('demo-repo--checks-failing');
    const dm = await laneBadge('demo-repo--merged');
    check('Lanes demo: unverified badge reads Unverified', du === 'Unverified', String(du));
    check('Lanes demo: checks failing badge reads Checks failing', df === 'Checks failing', String(df));
    check('Lanes demo: merged badge reads Merged', dm === 'Merged', String(dm));
    check('Lanes demo: none of the three reads Failed', ![du, df, dm].includes('Failed'), JSON.stringify([du, df, dm]));
    await shot('status-lanes');

    // The Office demo=status fixture carries the same three finish states; open each window badge.
    await send('Page.navigate', { url: base + '/office?demo=status&still=1' }); await wait(1800);
    const winBadge = async (lid) => { await ev(`window.__office.press(${JSON.stringify(lid)})`); await wait(400); return ev('(function(){var b=document.getElementById("winBadge");return b?b.textContent:null;})()'); };
    const ou = await winBadge('office-unverified');
    const of = await winBadge('office-failing');
    const om = await winBadge('office-merged');
    check('Office demo: unverified badge reads Unverified', ou === 'Unverified', String(ou));
    check('Office demo: checks failing badge reads Checks failing', of === 'Checks failing', String(of));
    check('Office demo: merged badge reads Merged', om === 'Merged', String(om));
    check('Office demo: none of the three reads Failed', ![ou, of, om].includes('Failed'), JSON.stringify([ou, of, om]));
    await shot('status-office');
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    sock.close();
  }
} catch (e) { check('status check script ran', false, String((e && e.stack) || e)); }
cleanup();
const bad = report();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
