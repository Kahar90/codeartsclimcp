// Contract check for deleting lanes and plans (fake lanes, never starts CodeArts): `ca rm` kills a
// lane's supervisor and codearts server, unregisters it and drops its lane logs while keeping the
// brief; `ca plan rm` deletes the plan's lanes and marks the plan removed; `--keep-lanes` leaves the
// lanes; the dashboard POST routes and the MCP tools expose the same. Private registry, temp dirs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-remove-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// Every process this check starts is tracked so the finally block can never leave one behind.
const spawned = [];
const spawnSleeper = () => { const p = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { detached: true, stdio: 'ignore' }); p.unref(); spawned.push(p); return p; };
const isDead = (pid) => { if (!pid) return true; try { process.kill(pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } };

const repo = path.join(tmp, 'sbx'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
const t = Date.now() - 3600e3;
const state = (extra) => ({ pid: 999999, startedAt: t, finishedAt: t + 60000, lastEventAt: t + 60000, phase: 'finished', result: 'done', exitCode: 0,
  commits: 2, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'done', models: {}, ...extra });
function fakeLane(base, task, extra) {
  const dir = path.join(base, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state(extra)));
  const id = `${path.basename(base)}--${task}`;
  fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo: base, task }));
  return { id, dir, task };
}

try {
  // ---- 1. a finished lane: ca rm drops its registry, final copy, dir and log; keeps the brief ----
  const fin = fakeLane(repo, 'done1', {});
  fs.mkdirSync(path.join(reg, 'final'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'final', `${fin.id}.json`), JSON.stringify({ id: fin.id, dir: fin.dir, repo, task: 'done1', s: {} }));
  fs.writeFileSync(path.join(repo, 'tasks', 'done1.lane.log'), 'log\n');
  let r = ca(['rm', fin.id]);
  check('ca rm exits 0 and prints the removed id, pids and paths', r.code === 0 && new RegExp(fin.id).test(r.out) && /killed/.test(r.out) && /removed/.test(r.out), r.out.trim());
  check('ca rm removes the registry json', !fs.existsSync(path.join(reg, `${fin.id}.json`)));
  check('ca rm removes the final json', !fs.existsSync(path.join(reg, 'final', `${fin.id}.json`)));
  check('ca rm removes the lane dir', !fs.existsSync(fin.dir));
  check('ca rm removes the lane log', !fs.existsSync(path.join(repo, 'tasks', 'done1.lane.log')));
  check('ca rm keeps the brief', fs.existsSync(path.join(repo, 'tasks', 'done1.md')));
  check('ca status no longer lists the removed lane', !new RegExp(fin.id).test(ca(['status', '--all']).out));
  check('ca rm on an unknown lane exits 2', ca(['rm', 'no-such-lane']).code === 2);

  // ---- 2. a running lane: ca rm kills the supervisor and the codearts server it recorded ----
  const runDir = path.join(repo, 'tasks', 'run.lane'); fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', 'run.md'), '1. a. Commit.\n');
  const sup = spawnSleeper(); const srv = spawnSleeper();
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ pid: sup.pid, server: { pid: srv.pid, url: 'http://127.0.0.1:1' },
    startedAt: Date.now(), lastEventAt: Date.now(), phase: 'build', busy: true, steps: 2, commits: 0, stepList: [], commitLog: [], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], models: {}, activity: 'running' }));
  fs.writeFileSync(path.join(reg, 'sbx--run.json'), JSON.stringify({ id: 'sbx--run', dir: runDir, repo, task: 'run' }));
  r = ca(['rm', 'sbx--run']);
  check('ca rm reports the killed pids', r.code === 0 && r.out.includes(String(sup.pid)) && r.out.includes(String(srv.pid)), r.out.trim());
  check('ca rm kills the supervisor process', isDead(sup.pid), `pid ${sup.pid}`);
  check('ca rm kills the codearts server process', isDead(srv.pid), `pid ${srv.pid}`);
  check('ca rm removes the running lane', !fs.existsSync(path.join(reg, 'sbx--run.json')) && !fs.existsSync(runDir));

  // ---- 3. a plan listing two lanes: ca plan rm deletes the lanes and marks the plan removed ----
  const prepo = path.join(tmp, 'planrepo'); fs.mkdirSync(path.join(prepo, 'tasks'), { recursive: true });
  fakeLane(prepo, 'p1', {}); fakeLane(prepo, 'p2', {});
  const planFile = path.join(prepo, 'tasks', 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ title: 'Removable plan', status: 'running', waves: [{ name: 'W1', lanes: ['p1', 'p2'] }], lanes: [{ task: 'p1' }, { task: 'p2' }] }));
  ca(['plan', planFile]);
  r = ca(['plan', 'rm', 'planrepo']);
  check('ca plan rm removes both lanes', !fs.existsSync(path.join(reg, 'planrepo--p1.json')) && !fs.existsSync(path.join(reg, 'planrepo--p2.json')), r.out.trim());
  check('ca plan rm unregisters the plan', !fs.existsSync(path.join(reg, 'plans', 'planrepo.json')));
  check('ca plan rm keeps the plan.json but marks it removed', fs.existsSync(planFile) && JSON.parse(fs.readFileSync(planFile, 'utf8')).removed === true);
  check('ca plan list no longer shows the removed plan', !/Removable plan/.test(ca(['plan', 'list']).out));

  // ---- 4. ca plan rm --keep-lanes only unregisters, the lanes stay ----
  fakeLane(prepo, 'k1', {}); fakeLane(prepo, 'k2', {});
  fs.writeFileSync(planFile, JSON.stringify({ title: 'Keep plan', status: 'running', waves: [{ name: 'W1', lanes: ['k1', 'k2'] }], lanes: [{ task: 'k1' }, { task: 'k2' }] }));
  ca(['plan', planFile]);
  r = ca(['plan', 'rm', 'planrepo', '--keep-lanes']);
  check('ca plan rm --keep-lanes leaves the lanes registered', fs.existsSync(path.join(reg, 'planrepo--k1.json')) && fs.existsSync(path.join(reg, 'planrepo--k2.json')), r.out.trim());
  check('ca plan rm --keep-lanes unregisters only the plan', !fs.existsSync(path.join(reg, 'plans', 'planrepo.json')));

  // ---- 5. the dashboard POST API: same behaviour over HTTP, JSON content-type required ----
  const port = await freePort();
  const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env }); spawned.push(dash);
  let up = false; for (let i = 0; i < 60 && !up; i++) { await wait(250); try { up = (await fetch(`http://127.0.0.1:${port}/api/lanes`)).ok; } catch {} }
  const web = fakeLane(repo, 'web1', {});
  const post = (url, body, headers = { 'content-type': 'application/json' }) => fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers, body });
  const r1 = await post(`/api/lane/${web.id}/remove`, '{}');
  check('HTTP lane remove returns 200', r1.status === 200, `status ${r1.status}`);
  check('HTTP lane remove removed the lane (registry + dir)', !fs.existsSync(path.join(reg, `${web.id}.json`)) && !fs.existsSync(web.dir));
  const r404 = await post('/api/lane/sbx--nope/remove', '{}');
  check('HTTP lane remove 404 on an unknown id', r404.status === 404, `status ${r404.status}`);
  const r415 = await post('/api/lane/sbx--whatever/remove', '{}', { 'content-type': 'text/plain' });
  check('HTTP remove needs content-type application/json (415)', r415.status === 415, `status ${r415.status}`);
  const wprepo = path.join(tmp, 'webplan'); fs.mkdirSync(path.join(wprepo, 'tasks'), { recursive: true });
  fakeLane(wprepo, 'w1', {}); fakeLane(wprepo, 'w2', {});
  const wpf = path.join(wprepo, 'tasks', 'plan.json');
  fs.writeFileSync(wpf, JSON.stringify({ title: 'Web plan', status: 'running', waves: [{ name: 'W1', lanes: ['w1', 'w2'] }], lanes: [{ task: 'w1' }, { task: 'w2' }] }));
  ca(['plan', wpf]);
  const r2 = await post('/api/plans/webplan/remove', '{}');
  let j2 = null; try { j2 = await r2.json(); } catch {}
  check('HTTP plan remove returns 200 with ok', r2.status === 200 && j2 && j2.ok === true, `status ${r2.status} ${JSON.stringify(j2).slice(0, 140)}`);
  check('HTTP plan remove removes its lanes and marks the plan removed', !fs.existsSync(path.join(reg, 'webplan--w1.json')) && !fs.existsSync(path.join(reg, 'plans', 'webplan.json')) && JSON.parse(fs.readFileSync(wpf, 'utf8')).removed === true);
  const rp404 = await post('/api/plans/nope/remove', '{}');
  check('HTTP plan remove 404 on an unknown id', rp404.status === 404, `status ${rp404.status}`);

  // ---- 6. MCP tools/list exposes ca_rm and ca_plan_rm as destructive ----
  const mcp = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); spawned.push(mcp);
  let buf = ''; const waiters = new Map();
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  let nid = 0;
  const rpc = (method, params, ms = 30000) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => { waiters.delete(id); res({ timeout: true }); }, ms); waiters.set(id, (m) => { clearTimeout(to); res(m); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rpc('tools/list', {});
  const tools = tl.result?.tools || [];
  const rmTool = tools.find((x) => x.name === 'ca_rm'); const planTool = tools.find((x) => x.name === 'ca_plan_rm');
  check('MCP tools/list includes ca_rm and ca_plan_rm', !!rmTool && !!planTool, tools.map((x) => x.name).join(','));
  check('MCP ca_rm is destructive and takes a lane', rmTool?.annotations?.destructiveHint === true && rmTool?.inputSchema?.required?.includes('lane'), JSON.stringify(rmTool?.annotations));
  check('MCP ca_plan_rm is destructive and takes an id', planTool?.annotations?.destructiveHint === true && planTool?.inputSchema?.required?.includes('id'), JSON.stringify(planTool?.annotations));
  mcp.stdin.end();
} catch (e) {
  check('check script ran', false, String((e && e.stack) || e));
} finally {
  for (const p of spawned) { try { p.kill(); } catch {} }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : `all ${results.length} passed`);
process.exit(fails ? 1 : 0);
