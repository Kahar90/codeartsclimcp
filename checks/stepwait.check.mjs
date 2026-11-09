// Contract check for `ca wait --steps` and MCP ca_wait {steps, after}: the lead is woken when a lane commits
// a new step (to look at it, screenshot UI files and steer early) instead of only when the lane ends.
// End to end against the fake CodeArts server (checks/lib/fake-codearts.cjs); private registry, no real CodeArts.
//  - exit 10 + one `CA_STEP {...}` line per lane with new commits: lane, commits (the new count, the next
//    --after), new [{hash, subject, step}], files (changed by the new commits), ui (any html/css/js/ts(x)/
//    jsx/vue/svelte/svg/png file)
//  - --after N (or lane=N) sets the baseline; without it the baseline is the count when the wait starts
//  - a lane result wins over a step event; plain `ca wait` (no --steps) is unchanged
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stepwait-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240', FAKE_STEP_GAP_MS: '8000', CA_MCP_WAIT_CAP_S: '20' };
const repo = path.join(tmp, 'site'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(['steps:1,2', 'ok']));
fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
fs.writeFileSync(path.join(repo, 'tasks', 'pages.md'), 'Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: node -e 0\n');
const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
const run = (args, ms = 120000) => spawnSync(process.execPath, [CA, ...args], { cwd: repo, env, encoding: 'utf8', timeout: ms });
const steps = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('CA_STEP ')).map((l) => { try { return JSON.parse(l.slice(8)); } catch { return null; } }).filter(Boolean);
const id = 'site--pages';

const d = run(['lane', repo, 'pages', '--detach']);
check('lane starts detached', d.status === 0, `${d.status} ${d.stderr.slice(0, 200)}`);
let w = run(['wait', id, '--steps', '--after', '0', '--timeout', '60', '--quiet']);
let s = steps(w.stdout);
check('wait --steps --after 0 returns exit 10 with a CA_STEP line for step 1', w.status === 10 && s.length === 1 && s[0].lane === id && s[0].commits >= 1, `${w.status} ${w.stdout.slice(0, 300)} ${w.stderr.slice(0, 200)}`);
check('CA_STEP lists the new commit with hash, subject and step number', s[0]?.new?.[0]?.hash && /^step 1:/.test(s[0].new[0].subject) && s[0].new[0].step === 1, JSON.stringify(s[0]));
check('CA_STEP lists the changed files and marks html as ui', Array.isArray(s[0]?.files) && s[0].files.includes('page1.html') && s[0].ui === true, JSON.stringify(s[0]));
w = run(['wait', id, '--steps', '--after', `${id}=1`, '--timeout', '60', '--quiet']);
s = steps(w.stdout);
check('wait --steps --after lane=1 returns the next step only', w.status === 10 && s[0]?.commits === 2 && s[0].new.length === 1 && s[0].new[0].step === 2 && s[0].files.includes('page2.html') && !s[0].files.includes('page1.html'), `${w.status} ${JSON.stringify(s[0])}`);
w = run(['wait', id, '--steps', '--after', '2', '--timeout', '60', '--quiet', '--json']);
let j = null; try { j = JSON.parse(w.stdout.split(/\r?\n/).filter((l) => l.startsWith('{')).pop()); } catch {}
check('with no newer step the lane result wins: exit 0, CA_RESULT, no CA_STEP', w.status === 0 && /CA_RESULT/.test(w.stdout) && !/CA_STEP/.test(w.stdout) && j && Array.isArray(j.lanes), `${w.status} ${w.stdout.slice(0, 300)}`);
w = run(['wait', id, '--steps', '--after', '0', '--timeout', '10', '--quiet']);
check('a finished lane still reports its result, not old steps, even with --after 0', w.status === 0 && /CA_RESULT/.test(w.stdout) && !/CA_STEP/.test(w.stdout), `${w.status} ${w.stdout.slice(0, 200)}`);
w = run(['wait', id, '--after', 'x'], 10000);
check('a bad --after value is a usage error (exit 2)', w.status === 2, `${w.status}`);
w = run(['help'], 10000);
check('ca help mentions wait --steps', /--steps/.test(w.stdout + w.stderr));

// MCP: ca_wait {steps, after} on a second lane
const repo2 = path.join(tmp, 'site2'); fs.mkdirSync(path.join(repo2, 'tasks'), { recursive: true });
for (const f of ['serve', 'fake-script.json', '.gitignore']) fs.copyFileSync(path.join(repo, f), path.join(repo2, f));
fs.copyFileSync(path.join(repo, 'tasks', 'pages.md'), path.join(repo2, 'tasks', 'pages.md'));
const g2 = (...a) => spawnSync('git', a, { cwd: repo2, encoding: 'utf8' });
g2('init', '-q'); g2('add', '-A'); g2('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
const d2 = spawnSync(process.execPath, [CA, 'lane', repo2, 'pages', '--detach'], { cwd: repo2, env, encoding: 'utf8', timeout: 60000 });
check('second lane starts detached', d2.status === 0, d2.stderr.slice(0, 200));
const srv = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map();
srv.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
let nid = 0;
const rpc = (method, params, ms = 60000) => new Promise((res) => { const i = ++nid; const to = setTimeout(() => { waiters.delete(i); res({ timeout: true }); }, ms); waiters.set(i, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const text = (m) => (m.result?.content || []).map((c) => c.text || '').join('\n');
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rpc('tools/list', {});
  const cw = (tl.result?.tools || []).find((t) => t.name === 'ca_wait');
  check('MCP ca_wait schema has steps (boolean) and after', cw?.inputSchema?.properties?.steps?.type === 'boolean' && !!cw?.inputSchema?.properties?.after, JSON.stringify(cw?.inputSchema?.properties || {}).slice(0, 300));
  let m = await rpc('tools/call', { name: 'ca_wait', arguments: { lanes: ['site2--pages'], steps: true, after: 0 } });
  let t = text(m);
  if (/still running/.test(t)) { m = await rpc('tools/call', { name: 'ca_wait', arguments: { lanes: ['site2--pages'], steps: true, after: 0 } }); t = text(m); }
  check('MCP ca_wait steps:true returns the step event (not an error) with a next hint to look and call again with after', !m.result?.isError && /step 1:/.test(t) && /page1\.html/.test(t) && /after/i.test(t), t.slice(0, 400));
} finally { srv.kill(); }
run(['wait', id, 'site2--pages', '--timeout', '90', '--quiet']);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
