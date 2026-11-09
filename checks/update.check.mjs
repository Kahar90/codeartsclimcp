// Contract check for update checks: users of an installed copy learn that a newer version exists,
// what is new in it, and can install it from the CLI, the dashboards (GET/POST /api/update) and MCP.
// The "remote" is a local HTTP server that serves package.json and CHANGELOG.md like
// raw.githubusercontent.com does (CA_UPDATE_URL points at it). Every home dir is a temp dir.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const [a, b] = CUR.split('.').map(Number);
const NEXT = `${a}.${b + 1}.0`, NEXT2 = `${a}.${b + 2}.0`;
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 260) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-update-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
fs.mkdirSync(path.join(tmp, 'localappdata'), { recursive: true });
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const cacheP = path.join(home, '.config', 'codearts-lanes', 'update.json');

// ---- the fake remote ----
let remote = { version: NEXT2, down: false, hits: 0 };
const changelog = () => `# Changelog\n\nOlder entries below.\n\n## ${NEXT2} (2026-11-20)\n\n- Office: agent windows never leave the screen\n- New: ca update --check\n\n## ${NEXT} (2026-11-10)\n\n- Lanes: animated Control room\n\n## ${CUR} (2026-11-07)\n\n- Already installed item\n`;
const srv = http.createServer((req, res) => {
  remote.hits++;
  if (remote.down) { res.writeHead(503); res.end('down'); return; }
  if (req.url.endsWith('/package.json')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'codearts-lanes', version: remote.version })); return; }
  if (req.url.endsWith('/CHANGELOG.md')) { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(changelog()); return; }
  res.writeHead(404); res.end();
});
const rp = await free(); await new Promise((r) => srv.listen(rp, '127.0.0.1', r));
const URL_BASE = `http://127.0.0.1:${rp}/raw/main/`;

const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(tmp, 'appdata'), LOCALAPPDATA: path.join(tmp, 'localappdata'),
  CA_REGISTRY: reg, CA_DASH: '0', CA_UPDATE_URL: URL_BASE, CODEARTS_EXE: process.execPath, CA_CLAUDE_CLI: 'none',
  CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(0)"` }; // never a real git pull or npm install from a check
delete env.CA_NO_UPDATE_CHECK; delete env.CA_UPDATE_NOTICE; delete env.XDG_CONFIG_HOME;
// async so the fake remote (same process) can answer while the child runs
const ca = (args, extra = {}) => new Promise((res) => { const t0 = Date.now(); const p = spawn(process.execPath, [CA, ...args], { cwd: tmp, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); const to = setTimeout(() => p.kill(), 90000); p.on('close', (code) => { clearTimeout(to); res({ code, out, err, ms: Date.now() - t0 }); }); });
const js = (s) => { try { return JSON.parse(s); } catch { return null; } };
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeCache = (o) => { fs.mkdirSync(path.dirname(cacheP), { recursive: true }); fs.writeFileSync(cacheP, JSON.stringify(o)); };

const timer = setTimeout(async () => { console.log('FAIL timeout'); await settle({ children: kids, code: 1 }); srv.close(); process.exit(1); }, 300000);
const kids = [];
try {
  // ---- version compare ----
  const life = await import(pathToFileURL(path.join(ROOT, 'runner', 'lifecycle.mjs')).href);
  check('lifecycle.mjs exports compareVersions', typeof life.compareVersions === 'function');
  if (typeof life.compareVersions === 'function') {
    const c = life.compareVersions;
    check('compareVersions orders numerically (0.10.0 > 0.9.0, 1.0.0 > 0.99.9, equal is 0, v prefix ok)', c('0.10.0', '0.9.0') > 0 && c('1.0.0', '0.99.9') > 0 && c('0.2.0', 'v0.2.0') === 0 && c('0.2.0', '0.2.1') < 0);
  }

  // ---- ca update --check ----
  let r = await ca(['update', '--check']);
  check('update --check names the installed and the latest version and says how to update', r.code === 0 && r.out.includes(CUR) && r.out.includes(NEXT2) && /ca update/.test(r.out), r.out + r.err);
  check('update --check lists what is new in every newer version, not the installed one', /agent windows never leave the screen/.test(r.out) && /animated Control room/.test(r.out) && !/Already installed item/.test(r.out), r.out);
  r = await ca(['update', '--check', '--json']); let j = js(r.out);
  check('update --check --json: current, latest, available, notes, cmd, checkedAt', r.code === 0 && j && j.current === CUR && j.latest === NEXT2 && j.available === true && typeof j.cmd === 'string' && j.checkedAt > 0, r.out.slice(0, 300));
  check('--json notes: newest first, each with version, date and items', j && Array.isArray(j.notes) && j.notes.length === 2 && j.notes[0].version === NEXT2 && j.notes[0].date === '2026-11-20' && j.notes[0].items.length === 2 && j.notes[1].version === NEXT, JSON.stringify(j && j.notes));
  const cache = rd(cacheP);
  check('the result is cached in ~/.config/codearts-lanes/update.json', cache && cache.latest === NEXT2 && cache.available === true && cache.checkedAt > 0, JSON.stringify(cache));

  remote.version = CUR;
  r = await ca(['update', '--check']);
  check('same version remote: update --check says up to date', r.code === 0 && /up to date/i.test(r.out) && r.out.includes(CUR), r.out);
  r = await ca(['update', '--check', '--json']); j = js(r.out);
  check('same version remote: available false, notes empty', j && j.available === false && j.notes.length === 0, r.out.slice(0, 200));

  remote.down = true;
  r = await ca(['update', '--check']);
  check('unreachable remote: exit 1 with "could not check" and the reason', r.code === 1 && /could not check/i.test(r.out + r.err), r.out + r.err);
  r = await ca(['update', '--check', '--json']); j = js(r.out);
  check('unreachable remote --json: available false and an error string', j && j.available === false && typeof j.error === 'string' && j.error.length > 0, r.out.slice(0, 200));
  remote.down = false; remote.version = NEXT2;

  // ---- passive notice from the cache ----
  writeCache({ current: CUR, latest: NEXT2, available: true, notes: [], checkedAt: Date.now() });
  r = await ca(['status'], { CA_UPDATE_NOTICE: '1' });
  check('ca status prints a one-line update notice on stderr (from a fresh cache)', /update available/i.test(r.err) && r.err.includes(NEXT2) && /ca update/.test(r.err) && !/update available/i.test(r.out), JSON.stringify(r.err));
  r = await ca(['status'], { CA_UPDATE_NOTICE: '1', CA_NO_UPDATE_CHECK: '1' });
  check('CA_NO_UPDATE_CHECK=1 turns the notice off', !/update available/i.test(r.err + r.out), r.err);
  r = await ca(['status', '--json'], { CA_UPDATE_NOTICE: '1' });
  check('--json output never carries the notice', js(r.out) !== null && !/update available/i.test(r.out), r.out.slice(0, 120));
  r = await ca(['status']);
  check('no notice when stderr is not a terminal and CA_UPDATE_NOTICE is unset', !/update available/i.test(r.err), r.err);

  // stale cache: the command stays fast and a background refresh updates the cache
  writeCache({ current: CUR, latest: CUR, available: false, notes: [], checkedAt: Date.now() - 3 * 86400000 });
  const hits0 = remote.hits;
  r = await ca(['status'], { CA_UPDATE_NOTICE: '1' });
  let refreshed = null; for (let i = 0; i < 40; i++) { await wait(250); const c = rd(cacheP); if (c && c.latest === NEXT2) { refreshed = c; break; } }
  check('a stale cache is refreshed in the background (remote hit, cache now has the latest version)', remote.hits > hits0 && refreshed && refreshed.available === true, `hits ${remote.hits - hits0} ${JSON.stringify(rd(cacheP))}`);
  check('the stale-cache command did not wait for the network (< 4 s)', r.ms < 4000, `${r.ms} ms`);
  remote.down = true; const hits1 = remote.hits;
  writeCache({ current: CUR, latest: CUR, available: false, notes: [], checkedAt: Date.now() });
  r = await ca(['status'], { CA_UPDATE_NOTICE: '1' }); await wait(1500);
  check('a fresh cache (< 24 h) is not refreshed', remote.hits === hits1, `hits ${remote.hits - hits1}`);
  remote.down = false;

  // ---- doctor row ----
  writeCache({ current: CUR, latest: NEXT2, available: true, notes: [], checkedAt: Date.now() });
  r = await ca(['doctor', '--json']); j = js(r.out);
  let row = j && j.checks.find((c) => c.name === 'ca version');
  check('doctor "ca version" row warns when a newer version is out, fix is ca update', row && row.status === 'warn' && row.detail.includes(CUR) && row.detail.includes(NEXT2) && /ca update/.test(row.fix), JSON.stringify(row));
  writeCache({ current: CUR, latest: CUR, available: false, notes: [], checkedAt: Date.now() });
  r = await ca(['doctor', '--json']); j = js(r.out); row = j && j.checks.find((c) => c.name === 'ca version');
  check('doctor "ca version" row is ok when up to date', row && row.status === 'ok' && row.detail.includes(CUR), JSON.stringify(row));

  // ---- ca update clears the notice and says to restart ----
  writeCache({ current: CUR, latest: NEXT2, available: true, notes: [], checkedAt: Date.now() });
  r = await ca(['update'], { CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(0)"` });
  const after = rd(cacheP);
  check('a successful ca update drops the cached "available" (no stale notice afterwards)', r.code === 0 && (!after || after.available !== true), JSON.stringify(after));
  check('a successful ca update tells the user to restart their agent so MCP loads the new version', /restart/i.test(r.out), r.out);

  // ---- MCP ----
  writeCache({ current: CUR, latest: NEXT2, available: true, notes: [{ version: NEXT2, date: '2026-11-20', items: ['x'] }], checkedAt: Date.now() });
  const mcp = spawn(process.execPath, [CA, 'mcp'], { cwd: tmp, env: { ...env, CA_NO_UPDATE_CHECK: '' }, stdio: ['pipe', 'pipe', 'pipe'] }); kids.push(mcp); guard({ children: [mcp] });
  let buf = ''; const waiters = new Map(); let nid = 0;
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const m = js(line); if (m && m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  const rpc = (method, params, ms = 30000) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => { waiters.delete(id); res({ timeout: true }); }, ms); waiters.set(id, (m) => { clearTimeout(to); res(m); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  let m = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  check('MCP initialize instructions mention the available update so the agent can tell the user', /update/i.test(m.result?.instructions || '') && (m.result?.instructions || '').includes(NEXT2), (m.result?.instructions || '').slice(-300));
  m = await rpc('tools/list', {}); const tools = m.result?.tools || [];
  const uc = tools.find((t) => t.name === 'ca_update_check'), uu = tools.find((t) => t.name === 'ca_update');
  check('MCP has ca_update_check (read-only) and ca_update (not read-only)', uc && uc.annotations?.readOnlyHint === true && uu && uu.annotations?.readOnlyHint !== true, JSON.stringify([uc?.annotations, uu?.annotations]));
  m = await rpc('tools/call', { name: 'ca_update_check', arguments: {} });
  j = js((m.result?.content || []).map((c) => c.text).join(''));
  check('ca_update_check returns the --json result', j && j.available === true && j.latest === NEXT2 && Array.isArray(j.notes), JSON.stringify(m).slice(0, 300));
  mcp.kill();

  // ---- dashboard API ----
  writeCache({ current: CUR, latest: NEXT2, available: true, notes: [{ version: NEXT2, date: '2026-11-20', items: ['x', 'y'] }], checkedAt: Date.now() });
  const dp = await free();
  const dash = spawn(process.execPath, [CA, 'dash', String(dp)], { cwd: tmp, env: { ...env, CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(0)"` }, stdio: 'ignore' }); kids.push(dash); guard({ children: [dash] });
  const base = `http://127.0.0.1:${dp}`;
  let g = null; for (let i = 0; i < 40 && !g; i++) { await wait(250); try { g = await (await fetch(base + '/api/update')).json(); } catch {} }
  check('GET /api/update returns current, latest, available, notes, cmd and the dash pid', g && g.current === CUR && g.latest === NEXT2 && g.available === true && Array.isArray(g.notes) && g.notes[0].items.length === 2 && typeof g.cmd === 'string' && g.pid === dash.pid, JSON.stringify(g));
  let p = await fetch(base + '/api/update', { method: 'POST', body: '{}' });
  check('POST /api/update without a JSON content type is refused (415)', p.status === 415, p.status);
  p = await fetch(base + '/api/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const pj = await p.json().catch(() => null);
  check('POST /api/update runs the update and says the dashboard restarts', p.ok && pj && pj.ok === true && pj.restarting === true, JSON.stringify(pj));
  // the old dash exits and a new one serves the same port
  let back = null; for (let i = 0; i < 60; i++) { await wait(250); try { const x = await (await fetch(base + '/api/update')).json(); if (x && x.pid && x.pid !== dash.pid) { back = x; break; } } catch {} }
  check('the dashboard comes back on the same port with a new process after the update', back && back.pid !== dash.pid, JSON.stringify(back));
  check('after the update the dashboard no longer reports the old "available"', back && back.available !== true, JSON.stringify(back));
  if (back && back.pid) { try { process.kill(back.pid); } catch {} }
  // failing install: the dash stays up and reports the error
  const dp2 = await free();
  const dash2 = spawn(process.execPath, [CA, 'dash', String(dp2)], { cwd: tmp, env: { ...env, CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(7)"` }, stdio: 'ignore' }); kids.push(dash2); guard({ children: [dash2] });
  for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(`http://127.0.0.1:${dp2}/api/ui`)).ok) break; } catch {} }
  p = await fetch(`http://127.0.0.1:${dp2}/api/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const pf = await p.json().catch(() => null);
  check('a failing install: POST answers ok false with the error and the dashboard stays up', pf && pf.ok === false && /7|fail/i.test(pf.error || '') && (await fetch(`http://127.0.0.1:${dp2}/api/ui`)).ok, JSON.stringify(pf));

  // ---- release notes in the repo ----
  const cl = fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) ? fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
  check('CHANGELOG.md has a "## <version> (YYYY-MM-DD)" section for the package.json version', new RegExp(`^## ${CUR.replace(/\./g, '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)`, 'm').test(cl));
  check('package.json ships CHANGELOG.md', (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files || []).includes('CHANGELOG.md'));
  const rel = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'release.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  check('tools/release.mjs --check passes (version and changelog agree)', rel.status === 0, (rel.stdout || '') + (rel.stderr || ''));
} catch (e) { check('no exception', false, e.stack || e.message); }
clearTimeout(timer);
await settle({ children: kids, code: 0 });
srv.close();
for (const r of results) console.log(r);
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`${results.length - fails}/${results.length} passed`);
process.exitCode = fails ? 1 : 0;
