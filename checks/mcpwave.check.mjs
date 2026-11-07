// Contract check for the MCP fixes: ca_wait treats exit 3 (keys) and 5 (paused) as results with a next step,
// ca_plan_close / ca_plan_list / ca_gc tools, serverInfo.version from package.json, readOnlyHint annotations,
// and a brief template whose prose never starts a line with "CHECK:". Private registry, fake lanes, no CodeArts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-mcpwave-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const repo = path.join(tmp, 'wave-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const t = Date.now();
const lane = (task, st) => { const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t - 9e5, finishedAt: t - 6e5, lastEventAt: t - 6e5, phase: 'finished', steps: 2, commits: 1, stepList: [], commitLog: [], tokens: {}, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: {}, ...st }));
  fs.writeFileSync(path.join(dir, 'live.log'), 'x\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), `=== lane wave-repo--${task}: ${String(st.result).toUpperCase()} ===\n`);
  fs.writeFileSync(path.join(reg, `wave-repo--${task}.json`), JSON.stringify({ id: `wave-repo--${task}`, dir, repo, task })); };
lane('paused', { result: 'paused', exitCode: 5, activity: 'paused' });
lane('nokeys', { result: 'failed', reason: 'auth', exitCode: 3, activity: 'failed' });
const planFile = path.join(repo, 'tasks', 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({ title: 'Wave plan', status: 'running', waves: [{ name: 'W1', lanes: ['paused'] }, { name: 'W2', lanes: ['later'] }], lanes: [{ task: 'paused' }, { task: 'later' }] }));
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
spawnSync(process.execPath, [CA, 'plan', planFile], { env, encoding: 'utf8', timeout: 30000 });

const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const srv = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map();
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
let nid = 0;
const rpc = (method, params, ms = 30000) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => { waiters.delete(id); res({ timeout: true }); }, ms); waiters.set(id, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const text = (m) => (m.result?.content || []).map((c) => c.text || '').join('\n');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const kill = setTimeout(() => { console.log('FAIL timeout after 120 s'); srv.kill(); process.exit(1); }, 120000);
try {
  let m = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('serverInfo.version comes from package.json', m.result?.serverInfo?.version === pkg.version, `${m.result?.serverInfo?.version} vs ${pkg.version}`);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  m = await rpc('tools/list', {}); const tools = m.result?.tools || [];
  const ro = (n) => tools.find((x) => x.name === n)?.annotations?.readOnlyHint === true;
  check('readOnlyHint on ca_status, ca_summary, ca_tail, ca_doctor, ca_wait, ca_plan_list', ['ca_status', 'ca_summary', 'ca_tail', 'ca_doctor', 'ca_wait', 'ca_plan_list'].every(ro), tools.map((x) => `${x.name}:${JSON.stringify(x.annotations || {})}`).join(' '));
  check('no readOnlyHint on lane-changing tools', ['ca_lane_start', 'ca_steer', 'ca_stop', 'ca_kick', 'ca_resume', 'ca_plan_close', 'ca_gc'].every((n) => tools.some((x) => x.name === n) && !ro(n)));
  check('ca_stop and ca_plan_close are marked destructive', ['ca_stop', 'ca_plan_close'].every((n) => tools.find((x) => x.name === n)?.annotations?.destructiveHint === true));
  check('ca_wait description mentions 5 paused and ca_resume', /\b5\b[^.]*paused/i.test(tools.find((x) => x.name === 'ca_wait')?.description || '') && /ca_resume/.test(tools.find((x) => x.name === 'ca_wait')?.description || ''));

  m = await call('ca_wait', { lanes: ['paused'], timeout_s: 5 }); let j = parse(text(m));
  check('ca_wait on a paused lane: result, not a tool error, exit 5', m.result?.isError === false && j?.exit === 5, text(m).slice(0, 200));
  check('paused result tells the lead to ca_resume', j && /ca_resume/.test(String(j.next || '')), j && j.next);
  m = await call('ca_wait', { lanes: ['nokeys'], timeout_s: 5 }); j = parse(text(m));
  check('ca_wait on a lane with rejected keys: result, exit 3', m.result?.isError === false && j?.exit === 3, text(m).slice(0, 200));
  check('keys result tells the lead to run ca auth', j && /ca auth/.test(String(j.next || '')), j && j.next);
  m = await call('ca_wait', { lanes: ['nosuchlane'], timeout_s: 5 });
  check('unknown lane in ca_wait is still a tool error', m.result?.isError === true, text(m).slice(0, 120));

  m = await call('ca_plan_list', {});
  check('ca_plan_list lists the registered plan', m.result?.isError === false && /Wave plan/.test(text(m)), text(m).slice(0, 200));
  m = await call('ca_plan_close', { id: 'wave-repo', reason: 'done for now' });
  const p = parse(fs.readFileSync(planFile, 'utf8'));
  check('ca_plan_close closes the plan with the reason and drops unstarted lanes', m.result?.isError === false && p?.status === 'done' && /done for now/.test(p.now || '') && p.lanes.find((l) => l.task === 'later')?.dropped === true, text(m).slice(0, 200));
  m = await call('ca_plan_close', { id: 'no-such-plan' });
  check('ca_plan_close on an unknown plan is a tool error', m.result?.isError === true);
  m = await call('ca_gc', {});
  check('ca_gc runs and is not an error', m.result?.isError === false, text(m).slice(0, 120));
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(kill); srv.stdin.end(); try { srv.kill(); } catch {}

// brief template: prose must never put CHECK: at the start of a line (a rewrapped line becomes a check)
const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'brief.md'), 'utf8');
const checkLines = tpl.split(/\r?\n/).filter((l) => /^\s*CHECK:/.test(l));
check('template: every CHECK: line is a placeholder command line', checkLines.length >= 1 && checkLines.every((l) => /^CHECK: <[^>]+>\s*$/.test(l)), checkLines.join(' | '));
check('template: prose says "check line", never "CHECK: line"', !/CHECK:\s*line/i.test(tpl.replace(/^CHECK: <[^>]+>\s*$/gm, '')));
check('template: no prose line could start with CHECK: after a rewrap', !/\S[ \t]+CHECK:/.test(tpl.replace(/^CHECK: <[^>]+>\s*$/gm, '')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
