// Contract check for runner/mcp.mjs: an MCP stdio server (newline-delimited JSON-RPC 2.0) started with `ca mcp`.
// Uses a private CA registry with fake lanes, so it never starts CodeArts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-mcp-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const lane = (task, st) => { const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ steps: 2, commits: 1, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }], tokens: { input: 10, output: 5, cacheRead: 0, steps: 1 }, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: {}, ...st }));
  fs.writeFileSync(path.join(dir, 'live.log'), 'line one\nline two\n');
  if (st.result) fs.writeFileSync(path.join(dir, 'summary.md'), `=== lane demo-repo--${task}: DONE ===\nVERDICT: ready\n`);
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task })); };
const t = Date.now();
lane('good', { pid: 999999, startedAt: t - 9e5, finishedAt: t - 6e5, lastEventAt: t - 6e5, phase: 'finished', result: 'done', verdict: 'ready', exitCode: 0, activity: 'done' });
lane('slow', { pid: process.pid, startedAt: t, lastEventAt: t, phase: 'build', busy: true, activity: 'thinking' });

const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const srv = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'mcp'], { env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const msgs = []; const bad = []; const waiters = new Map();
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { bad.push(line); continue; } msgs.push(m); if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
let errText = ''; srv.stderr.on('data', (d) => { errText += d; });
let nid = 0;
const rpc = (method, params, ms = 30000) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => { waiters.delete(id); res({ timeout: true }); }, ms); waiters.set(id, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = (name, args = {}, ms) => rpc('tools/call', { name, arguments: args }, ms);
const text = (m) => (m.result?.content || []).map((c) => c.text || '').join('\n');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const kill = setTimeout(() => { console.log('FAIL timeout after 120 s'); srv.kill(); process.exit(1); }, 120000);
try {
  let m = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  check('initialize answers', m.result && m.result.protocolVersion && m.result.serverInfo?.name && m.result.capabilities?.tools, JSON.stringify(m).slice(0, 200));
  check('initialize has instructions', typeof m.result?.instructions === 'string' && m.result.instructions.length > 40);
  const ins = m.result?.instructions || '';
  check('instructions ask the lead to register and keep the plan current', /ca_plan\b/.test(ins) && /ca_plan_update/.test(ins) && /ca_note/.test(ins) && /phase/.test(ins), ins.slice(0, 200));
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  m = await rpc('ping', {}); check('ping', m.result && !m.error);
  m = await rpc('tools/list', {}); const tools = m.result?.tools || [];
  const want = ['ca_doctor', 'ca_init', 'ca_lane_start', 'ca_status', 'ca_wait', 'ca_summary', 'ca_tail', 'ca_steer', 'ca_stop', 'ca_kick', 'ca_resume', 'ca_ack', 'ca_lead_tokens', 'ca_plan', 'ca_plan_list', 'ca_plan_update', 'ca_plan_close', 'ca_plan_rm', 'ca_gc', 'ca_note', 'ca_update_check', 'ca_update'];
  check('tools/list has every tool', want.every((w) => tools.some((x) => x.name === w)), tools.map((x) => x.name).join(','));
  check('tools have descriptions and object schemas', tools.length && tools.every((x) => x.description && x.description.length > 15 && x.inputSchema?.type === 'object'));
  check('required args declared', tools.find((x) => x.name === 'ca_steer')?.inputSchema?.required?.includes('lane'));
  m = await call('ca_status', {}); let j = parse(text(m));
  check('ca_status returns the lanes as JSON', !m.result?.isError && Array.isArray(j) && j.length === 2, text(m).slice(0, 160));
  m = await call('ca_summary', { lane: 'good' }); j = parse(text(m));
  check('ca_summary returns summary JSON', !m.result?.isError && j && j.result === 'done' && j.verdict === 'ready', text(m).slice(0, 160));
  m = await call('ca_tail', { lane: 'good', lines: 5 }); check('ca_tail returns the transcript tail', !m.result?.isError && /line two/.test(text(m)), text(m).slice(0, 120));
  m = await call('ca_wait', { lanes: ['good'] }); j = parse(text(m));
  check('ca_wait on a done lane: compact row with exit 0', !m.result?.isError && j && j.exit === 0 && Array.isArray(j.lanes) && j.lanes[0].status?.key === 'done' && typeof j.lanes[0].progress === 'string', text(m).slice(0, 200));
  const t0 = Date.now(); m = await call('ca_wait', { lanes: ['slow'], timeout_s: 2 }, 30000); j = parse(text(m));
  check('ca_wait timeout says still running, not an error', !m.result?.isError && j && j.exit === 124 && j.timedOut === true && Date.now() - t0 < 20000, text(m).slice(0, 200));
  // MCP clients (Codex, opencode) cancel a tool call after about 60 s: a huge timeout_s must still answer in time.
  const t1 = Date.now(); m = await call('ca_wait', { lanes: ['slow'], timeout_s: 3000 }, 90000); j = parse(text(m));
  check('ca_wait with timeout_s 3000 still answers within 60 s (still running, exit 124)', !m.result?.isError && j?.exit === 124 && Date.now() - t1 < 60000, `${Date.now() - t1} ms ${text(m).slice(0, 120)}`);
  m = await call('ca_steer', { lane: 'good', message: 'x' }); check('ca_steer on a finished lane is a tool error', m.result?.isError === true, text(m).slice(0, 120));
  m = await call('ca_summary', { lane: 'nope' }); check('unknown lane is a tool error with the CLI message', m.result?.isError === true && /no lane matches/.test(text(m)), text(m).slice(0, 120));
  m = await call('ca_kick', { lane: 'slow', mode: 'fresh', message: 'start clean' });
  const kf = path.join(repo, 'tasks', 'slow.lane', 'KICK'); let kick = null; try { kick = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch {}
  check('ca_kick queues a kick on a running lane', !m.result?.isError && kick?.mode === 'fresh' && kick?.text === 'start clean', text(m).slice(0, 120) + ' ' + JSON.stringify(kick));
  fs.rmSync(kf, { force: true });
  m = await call('ca_kick', { lane: 'good' }); check('ca_kick on a finished lane is a tool error', m.result?.isError === true, text(m).slice(0, 120));
  m = await call('ca_resume', { lane: 'good' }); check('ca_resume on a done lane is a tool error', m.result?.isError === true, text(m).slice(0, 120));
  m = await call('ca_init', { repo, task: 'feat', goal: 'Do the feature' });
  check('ca_init writes the brief', !m.result?.isError && fs.existsSync(path.join(repo, 'tasks', 'feat.md')), text(m).slice(0, 120));
  m = await call('ca_nope', {}); check('unknown tool gives a JSON-RPC error or tool error', !!m.error || m.result?.isError === true);
  m = await call('ca_steer', {}); check('missing required arg is an error', !!m.error || m.result?.isError === true);
  srv.stdin.write('this is not json\n'); await new Promise((r) => setTimeout(r, 500));
  check('invalid JSON gets a -32700 parse error', msgs.some((x) => x.error?.code === -32700));
  m = await rpc('ping', {}); check('server survives bad input', m.result && !m.error);
  m = await rpc('prompts/list', {}); check('prompts/list has codearts_build', (m.result?.prompts || []).some((p) => p.name === 'codearts_build'), JSON.stringify(m).slice(0, 160));
  m = await rpc('prompts/get', { name: 'codearts_build', arguments: { goal: 'Add login' } });
  check('prompts/get returns the workflow with the goal', (m.result?.messages || []).some((x) => /Add login/.test(x.content?.text || '') && /ca_wait/.test(x.content?.text || '')), JSON.stringify(m).slice(0, 160));
  m = await rpc('no/such/method', {}); check('unknown method gives -32601', m.error?.code === -32601);
  check('stdout carries only JSON-RPC', bad.length === 0, bad.slice(0, 2).join(' | '));
} catch (e) { check('check script ran', false, String(e && e.stack || e)); }
clearTimeout(kill); srv.stdin.end(); await new Promise((r) => setTimeout(r, 800));
check('server exits when stdin closes', srv.exitCode !== null || srv.signalCode !== null, `exit ${srv.exitCode}`); try { srv.kill(); } catch {}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
