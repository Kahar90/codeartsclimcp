// Contract check: a blocked worker reaches the lead in seconds, not after the lane ends.
//  - question: the worker asks (question.asked). The runner still rejects it (headless) but also tells the
//    worker to continue with its best option, records the question on the lane (state.blocker, status
//    --json `blocked`), puts the lane in the attention bucket ("asked the lead: ..."), and `ca wait`
//    returns exit 11 with a `CA_BLOCKED {...}` line while the lane keeps running. A steer clears it.
//  - no progress: no new commit for NO_COMMIT_S seconds while the worker runs -> blocker kind
//    "no-progress" ("no commit in ..."), same wait/status/bucket path. `ca ack` on a running lane clears it.
//  - MCP ca_wait answers exit 11 as a result (not an error) with a next hint that names ca_steer.
// End to end against the fake CodeArts server; private registry, no real CodeArts, no paid model.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-blocked-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '240', CA_MCP_WAIT_CAP_S: '20' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeChk = () => { const list = []; const chk = (name, ok, info = '') => list.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`); return { list, chk }; };

function makeRepo(name, script) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), 'Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}
const ca = (cwd, args, ms = 120000, extra = {}) => run(process.execPath, [CA, ...args], { cwd, env: { ...env, ...extra }, timeout: ms });
const lines = (out, tag) => String(out || '').split(/\r?\n/).filter((l) => l.startsWith(tag + ' ')).map((l) => { try { return JSON.parse(l.slice(tag.length + 1)); } catch { return null; } }).filter(Boolean);
const row = async (cwd, id) => { const r = await ca(cwd, ['status', '--json', '--all'], 30000); try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.lanes || []).find((x) => x.id === id) || null; } catch { return null; } };
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await sleep(500); } };

// ---------- pure: laneBucket and laneActions read the blocker ----------
const C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href);
const live = { phase: 'build', busy: true, startedAt: Date.now() - 60000, lastEventAt: Date.now() };
let b = C.laneBucket({ s: { ...live, blocker: { kind: 'question', text: 'Which database?', at: Date.now() } }, alive: true, health: 'running' });
check('laneBucket: an open question puts a running lane in attention, reason "asked the lead: <question>"', b.bucket === 'attention' && /^asked the lead: Which database\?/.test(b.reason), JSON.stringify(b));
b = C.laneBucket({ s: { ...live, blocker: { kind: 'no-progress', text: 'no commit in 15m', at: Date.now() } }, alive: true, health: 'running' });
check('laneBucket: no progress puts a running lane in attention, reason "no commit in ..."', b.bucket === 'attention' && /no commit in/.test(b.reason), JSON.stringify(b));
b = C.laneBucket({ s: { ...live }, alive: true, health: 'running' });
check('laneBucket: a lane without a blocker is still running', b.bucket === 'running', JSON.stringify(b));
const a = C.laneActions({ s: { ...live, blocker: { kind: 'question', text: 'Which database?', at: Date.now() } }, alive: true, health: 'running', canResume: false, handled: false });
check('laneActions: a blocked lane suggests steer', a && a.suggest === 'steer' && /question|lead/i.test(a.why || ''), JSON.stringify(a));

// ---------- question ----------
async function scenQuestion() {
  const { list, chk } = makeChk();
  const qRepo = makeRepo('qa', ['commit:1+ask:Which database should I use, SQLite or Postgres?+wait:45000', 'ok']);
  const qId = 'qa--work';
  let r = await ca(qRepo, ['lane', qRepo, 'work', '--detach']);
  chk('question lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  const t0 = Date.now();
  r = await ca(qRepo, ['wait', qId, '--timeout', '40', '--quiet']);
  const waitedS = (Date.now() - t0) / 1000;
  let bl = lines(r.stdout, 'CA_BLOCKED');
  chk('ca wait returns exit 11 with a CA_BLOCKED line for the question, long before the lane ends', r.status === 11 && bl.length === 1 && bl[0].lane === qId && bl[0].kind === 'question' && /SQLite or Postgres/.test(bl[0].text || '') && waitedS < 20, `exit ${r.status} after ${waitedS.toFixed(1)}s: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 200)}`);
  let q = await row(qRepo, qId);
  chk('status --json shows the open question as blocked {kind, text, at} on a lane that is still running', q && !q.result && q.blocked && q.blocked.kind === 'question' && /SQLite/.test(q.blocked.text || '') && Number.isFinite(q.blocked.at), JSON.stringify(q && q.blocked));
  const prompts = () => { try { return fs.readFileSync(path.join(qRepo, 'fake-prompts.log'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
  const told = await until(() => prompts().slice(1).find((p) => /lead/i.test(p.text) && /continue/i.test(p.text) && p.agent !== 'plan'), 8000);
  chk('the worker is told its question went to the lead and to continue with its best option', !!told, JSON.stringify(prompts().map((p) => p.text.slice(0, 80))));
  chk('the question itself is still rejected (headless: nothing waits on a human)', fs.existsSync(path.join(qRepo, 'fake-questions.log')));
  r = await ca(qRepo, ['wait', qId, '--timeout', '5', '--quiet', '--json']);
  chk('an open blocker keeps answering exit 11 until the lead handles it', r.status === 11 && /CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);

  // MCP: ca_wait answers the blocker as a result with a next hint naming ca_steer
  const srv = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let nid = 0;
  srv.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  const rpc = (method, params, ms = 40000) => new Promise((res) => { const i = ++nid; const to = setTimeout(() => { waiters.delete(i); res({ timeout: true }); }, ms); waiters.set(i, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const m = await rpc('tools/call', { name: 'ca_wait', arguments: { lanes: [qId] } });
    const t = (m.result?.content || []).map((c) => c.text || '').join('\n');
    chk('MCP ca_wait returns the blocker (not an error) with the question and a next hint naming ca_steer', m.result && !m.result.isError && /SQLite or Postgres/.test(t) && /ca_steer/.test(t), t.slice(0, 400));
  } finally { srv.kill(); }

  r = await ca(qRepo, ['steer', qId, 'Use SQLite.']);
  chk('ca steer is accepted on the blocked lane', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  q = await until(async () => { const x = await row(qRepo, qId); return x && !x.blocked ? x : null; }, 10000);
  chk('a delivered steer clears the blocker while the lane keeps running', !!q && !q.result, JSON.stringify((await row(qRepo, qId))?.blocked));
  r = await ca(qRepo, ['wait', qId, '--timeout', '90', '--quiet']);
  chk('after the steer, ca wait runs to the lane result (exit 0, no CA_BLOCKED)', r.status === 0 && /CA_RESULT/.test(r.stdout) && !/CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);
  const sum = (() => { try { return fs.readFileSync(path.join(qRepo, 'tasks', 'work.lane', 'summary.md'), 'utf8'); } catch { return ''; } })();
  chk('the summary lists the question the worker asked', /SQLite or Postgres/.test(sum), sum.slice(0, 300));
  return list;
}

// ---------- no progress ----------
async function scenNoProgress() {
  const { list, chk } = makeChk();
  const nRepo = makeRepo('np', ['wait:30000', 'commit:1', 'ok']);
  const nId = 'np--work';
  let r = await ca(nRepo, ['lane', nRepo, 'work', '--detach'], 60000, { NO_COMMIT_S: '6' });
  chk('no-progress lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  r = await ca(nRepo, ['wait', nId, '--timeout', '40', '--quiet']);
  const bl = lines(r.stdout, 'CA_BLOCKED');
  chk('ca wait returns exit 11 with CA_BLOCKED kind no-progress when no commit lands for NO_COMMIT_S', r.status === 11 && bl[0]?.kind === 'no-progress' && /no commit in/.test(bl[0]?.text || ''), `${r.status} ${r.stdout.slice(0, 300)}`);
  let n = await row(nRepo, nId);
  chk('status --json shows blocked kind no-progress', n && n.blocked && n.blocked.kind === 'no-progress', JSON.stringify(n && n.blocked));
  r = await ca(nRepo, ['ack', nId]);
  chk('ca ack on a running blocked lane is accepted (clears the blocker, does not finish the lane)', r.status === 0 && !/handled|was done/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  n = await until(async () => { const x = await row(nRepo, nId); return x && !x.blocked ? x : null; }, 10000);
  chk('the acked blocker is cleared while the lane keeps running', !!n && !n.result, JSON.stringify(await row(nRepo, nId)));
  r = await ca(nRepo, ['wait', nId, '--timeout', '90', '--quiet']);
  chk('the no-progress lane still finishes normally', r.status === 0 && /CA_RESULT/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);
  return list;
}

// The two end-to-end scenarios are independent (own repo, shared registry), so overlap them.
const [qL, npL] = await pool(4, [scenQuestion, scenNoProgress]);

// ---------- help and docs ----------
const helpPure = [];
{
  const chk = (name, ok, info = '') => helpPure.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
  const r = await ca(tmp, ['help'], 10000);
  chk('ca help documents exit 11 and NO_COMMIT_S', /\b11\b/.test(r.stdout) && /NO_COMMIT_S/.test(r.stdout), '');
  const docs = ['docs/workflow.md', 'docs/reference.md', 'templates/claude-skill.md'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  chk('workflow, reference and the skill template document exit 11 / CA_BLOCKED', /CA_BLOCKED|exit 11|\b11\b.*block/i.test(docs) && /NO_COMMIT_S/.test(docs));
}

results.push(...qL, ...npL, ...helpPure);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
