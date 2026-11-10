// Contract check for token counters (per agent, per lane, per plan) and lane controls from the dashboard
// (kick: retry turn / fresh session / restart server / retry now; resume: continue a paused, failed or DEAD lane).
// Fake lanes in a private registry; never starts CodeArts (CA_RESUME_DRY=1, CODEARTS_EXE points nowhere).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-controls-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_RESUME_DRY: '1', CODEARTS_EXE: path.join(tmp, process.platform === 'win32' ? 'no-codearts.exe' : 'no-codearts') };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const has = (arr, ...xs) => Array.isArray(arr) && xs.every((x) => arr.includes(x));

// ---------- pure modules ----------
let T = null, C = null;
try { T = await import(pathToFileURL(path.join(ROOT, 'runner', 'tokens.mjs')).href); } catch (e) { check('runner/tokens.mjs loads', false, e.message); }
try { C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href); } catch (e) { check('runner/controls.mjs loads', false, e.message); }
if (T) {
  const acc = T.emptyTokens();
  check('emptyTokens has every field at 0', ['input', 'output', 'reasoning', 'cacheRead', 'steps'].every((k) => acc[k] === 0), JSON.stringify(acc));
  T.addStepTokens(acc, { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } });
  T.addStepTokens(acc, { input: 50, output: 10 });
  check('addStepTokens adds a step-finish record', acc.input === 150 && acc.output === 30 && acc.reasoning === 5 && acc.cacheRead === 1000 && acc.steps === 2, JSON.stringify(acc));
  check('tokenTotal = input + output + reasoning + cacheRead', T.tokenTotal(acc) === 1185 && T.tokenTotal({}) === 0 && T.tokenTotal(null) === 0);
  const w = T.withTotal({ input: 1, output: 2 }); check('withTotal adds total', w.total === 3 && w.input === 1);
  const s = T.sumTokens([{ input: 1, output: 2, reasoning: 3, cacheRead: 4, steps: 1 }, { input: 10, output: 20 }, null, {}]);
  check('sumTokens adds every field and the total', s.input === 11 && s.output === 22 && s.reasoning === 3 && s.cacheRead === 4 && s.steps === 1 && s.total === 40, JSON.stringify(s));
}
if (C) {
  const A = (o) => C.laneActions(o);
  const run = A({ s: { phase: 'build', busy: true }, alive: true, health: 'running', canResume: true });
  check('running build lane: steer, stop, attach, kick, fresh, restart-server', has(run.actions, 'steer', 'stop', 'attach', 'kick', 'fresh', 'restart-server') && !run.actions.includes('resume') && run.suggest === '', JSON.stringify(run));
  const stall = A({ s: { phase: 'build', busy: true }, alive: true, health: 'STALLED', canResume: true });
  check('STALLED lane suggests kick with a reason', stall.suggest === 'kick' && stall.why.length > 5, JSON.stringify(stall));
  const think = A({ s: { phase: 'build', busy: true }, alive: true, health: 'thinking (12m, no tool call)', canResume: true });
  check('thinking lane suggests kick', think.suggest === 'kick', JSON.stringify(think));
  const quiet = A({ s: { phase: 'review', busy: true }, alive: true, health: 'quiet', canResume: true });
  check('quiet review lane can be kicked', has(quiet.actions, 'kick') && quiet.suggest === 'kick', JSON.stringify(quiet));
  const back = A({ s: { phase: 'backoff' }, alive: true, health: 'running', canResume: true });
  check('backoff lane offers and suggests skip-wait', has(back.actions, 'skip-wait', 'stop') && back.suggest === 'skip-wait' && !back.actions.includes('kick'), JSON.stringify(back));
  const gate = A({ s: { phase: 'gate' }, alive: true, health: 'running', canResume: true });
  check('gate phase offers no kick (checks run)', !gate.actions.includes('kick') && has(gate.actions, 'stop', 'steer'), JSON.stringify(gate));
  const dead = A({ s: { phase: 'build' }, alive: false, health: 'DEAD (ca stop cleans up)', canResume: true });
  check('DEAD lane offers and suggests resume', has(dead.actions, 'resume', 'stop') && dead.suggest === 'resume' && !dead.actions.includes('steer'), JSON.stringify(dead));
  const paused = A({ s: { result: 'paused', phase: 'finished' }, alive: false, health: 'paused', canResume: true });
  check('paused lane suggests resume', has(paused.actions, 'resume') && paused.suggest === 'resume', JSON.stringify(paused));
  const failed = A({ s: { result: 'failed', reason: 'gave up after 3 interruptions (last: transport: fetch failed)', phase: 'finished' }, alive: false, health: 'failed', canResume: true });
  check('failed lane offers resume but does not suggest it', has(failed.actions, 'resume') && failed.suggest === '' && failed.why === '', JSON.stringify(failed));
  const cred = A({ s: { result: 'failed', exitCode: 3, reason: 'auth', phase: 'finished' }, alive: false, health: 'failed', canResume: true });
  check('credential failure does not suggest resume and says why', cred.suggest !== 'resume' && /auth|credential/i.test(cred.why), JSON.stringify(cred));
  const nr = A({ s: { result: 'needs review', phase: 'finished' }, alive: false, health: 'needs review', canResume: true });
  check('needs-review lane can resume (with a note)', has(nr.actions, 'resume'), JSON.stringify(nr));
  const done = A({ s: { result: 'done', phase: 'finished' }, alive: false, health: 'done', canResume: true });
  check('done lane offers nothing', done.actions.length === 0 && done.suggest === '', JSON.stringify(done));
  const gone = A({ s: { result: 'paused', phase: 'finished' }, alive: false, health: 'paused', canResume: false });
  check('no resume when the repo or brief is gone', !gone.actions.includes('resume'), JSON.stringify(gone));
}

if (C && C.laneKind) {
  const K = (task, brief = '', files = [], override = '') => C.laneKind({ task, brief, files, override });
  check('laneKind: UI work is art', K('office-crowd', 'Office view hot desks, sprites', ['runner/office.html']) === 'art' && K('lanes-ctl', 'Lanes dashboard page', ['runner/dash.html']) === 'art');
  check('laneKind: runner work is code', K('controls', 'token counters, kick and resume in the supervisor', ['runner/ca.mjs']) === 'code');
  check('laneKind: tests and reviews are review', K('auth-tests', 'add regression tests', ['checks/auth.check.mjs']) === 'review');
  check('laneKind: README work is docs', K('readme-polish', 'update the README guide', ['README.md']) === 'docs');
  check('laneKind: unclear lanes are code', K('x', '1. do the thing') === 'code');
  check('laneKind: KIND line and plan override win', K('office-crowd', 'KIND: docs\n1. sprites') === 'docs' && K('controls', '', [], 'art') === 'art');
} else check('controls.mjs exports laneKind', false);

// ---------- fake lanes ----------
const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' }); // a live "supervisor" pid
const tk = (i, o, r = 0, c = 0, st = 1) => ({ input: i, output: o, reasoning: r, cacheRead: c, steps: st });
const fake = (task, st) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  const t = Date.now() - 600000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: `demo-repo--${task}`, task, repo, dir, pid: 999999, startedAt: t, lastEventAt: Date.now(), phase: 'build', busy: true, result: null,
    commits: 1, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }], gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'x', models: {}, config: {}, ...st }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
  return dir;
};
const fin = { phase: 'finished', finishedAt: Date.now() - 60000, busy: false };
const liveDir = fake('live', { pid: sleeper.pid, tokens: tk(1000, 200, 50, 5000, 4), tokensBy: { build: tk(900, 150, 40, 4000, 3), review: tk(0, 0), other: tk(100, 50, 10, 1000, 1) } });
const pausedDir = fake('paused', { ...fin, result: 'paused', reason: 'timeout', exitCode: 5, tokens: tk(3000, 400, 0, 0, 6), tokensBy: { build: tk(2500, 300, 0, 0, 5), review: tk(500, 100, 0, 0, 1), other: tk(0, 0) } });
const deadDir = fake('dead', { pid: 999999, tokens: tk(10, 5) });
const doneDir = fake('donelane', { ...fin, result: 'done', verdict: 'ready', exitCode: 0, tokens: tk(1, 1) });
fake('legacy', { ...fin, result: 'done', verdict: 'ready', exitCode: 0, tokens: { input: 7, output: 3, reasoning: 0, cacheRead: 0, steps: 1 } }); // no tokensBy (old lane)

// ---------- CLI ----------
let r = ca(['status', '--json']); let st = []; try { st = JSON.parse(r.out); } catch {}
const row = (t) => st.find((x) => x.task === t) || {};
check('status --json tokens carry a total', row('live').tokens?.total === 6250, JSON.stringify(row('live').tokens));
check('status --json has tokensBy per agent', row('live').tokensBy?.build?.total === 5090 && row('live').tokensBy?.other?.total === 1160, JSON.stringify(row('live').tokensBy));
check('old lane without tokensBy still has a total', row('legacy').tokens?.total === 10, JSON.stringify(row('legacy').tokens));
r = ca(['status']); check('status table has a TOKENS column', /TOKENS/.test(r.out) && /6\.3k|6250|6,250/.test(r.out), r.out.split('\n')[0]);
r = ca(['help']); check('help documents ca kick and ca resume', /ca kick/.test(r.out) && /ca resume/.test(r.out));

r = ca(['kick', 'demo-repo--donelane']); check('ca kick refuses a finished lane (exit 2)', r.code === 2, `exit ${r.code} ${r.err}`);
r = ca(['kick', 'demo-repo--live', '--server', 'connection looked dead']);
const kf = path.join(liveDir, 'KICK'); let kick = null; try { kick = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch {}
check('ca kick --server writes KICK {mode, text, by}', r.code === 0 && kick && kick.mode === 'server' && kick.text === 'connection looked dead' && kick.by && kick.at, `exit ${r.code} ${r.err} ${JSON.stringify(kick)}`);
fs.rmSync(kf, { force: true });
r = ca(['kick', 'demo-repo--live']); try { kick = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch { kick = null; }
check('ca kick default mode is turn', r.code === 0 && kick?.mode === 'turn', JSON.stringify(kick)); fs.rmSync(kf, { force: true });

r = ca(['resume', 'demo-repo--donelane']); check('ca resume refuses a done lane (exit 2)', r.code === 2, `exit ${r.code}`);
r = ca(['resume', 'demo-repo--live']); check('ca resume refuses a running lane (exit 2)', r.code === 2, `exit ${r.code}`);
r = ca(['resume', 'demo-repo--paused', '--note', 'use the smaller fixture']);
const rm = (r.out.match(/CA_RESUME (\{.*\})/) || [])[1]; let ro = null; try { ro = JSON.parse(rm); } catch {}
check('ca resume (dry) prints CA_RESUME with lane --resume argv', r.code === 0 && ro && ro.argv.includes('lane') && ro.argv.includes('--resume') && ro.argv.includes('paused'), r.out.slice(0, 200) + r.err);
const note = fs.existsSync(path.join(pausedDir, 'resume-note.txt')) ? fs.readFileSync(path.join(pausedDir, 'resume-note.txt'), 'utf8') : '';
check('resume note lands in the lane folder (not the repo)', /use the smaller fixture/.test(note) && !fs.existsSync(path.join(repo, 'tasks', 'paused.resume.md')), note.slice(0, 120));
r = ca(['resume', 'demo-repo--dead']);
const deadState = JSON.parse(fs.readFileSync(path.join(deadDir, 'state.json'), 'utf8'));
check('resume on a DEAD lane marks it stopped first, then resumes', r.code === 0 && deadState.result === 'stopped' && /CA_RESUME/.test(r.out), `exit ${r.code} result ${deadState.result} ${r.err}`);
fake('dead', { pid: 999999, tokens: tk(10, 5) }); // reset for the API part

// ---------- plan + dashboard API ----------
const plan = path.join(repo, 'tasks', 'plan.json');
fs.writeFileSync(plan, JSON.stringify({ title: 'tok', lanes: [{ task: 'live' }, { task: 'paused' }, { task: 'dead' }], waves: [{ name: 'W1', lanes: ['live', 'paused', 'dead'] }] }));
ca(['plan', plan]);
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env });
guard({ children: [dash, sleeper] });
const base = `http://127.0.0.1:${port}`;
const post = async (id, what, body, json = true) => { const res = await fetch(`${base}/api/lane/${encodeURIComponent(id)}/${what}`, { method: 'POST', headers: json ? { 'content-type': 'application/json' } : { 'content-type': 'text/plain' }, body: JSON.stringify(body || {}) }); let j = {}; try { j = await res.json(); } catch {} return { status: res.status, j }; };
try {
  let lanes = null; for (let i = 0; i < 40 && !lanes; i++) { await new Promise((x) => setTimeout(x, 250)); try { lanes = await (await fetch(base + '/api/lanes')).json(); } catch {} }
  const L = (t) => (lanes || []).find((x) => x.task === t) || {};
  check('/api/lanes: tokens.total and tokensBy per lane', L('live').tokens?.total === 6250 && L('live').tokensBy?.build?.total === 5090 && L('live').tokensBy?.review?.total === 0, JSON.stringify({ t: L('live').tokens, b: L('live').tokensBy }));
  check('/api/lanes: actions and suggest per lane', has(L('live').actions, 'kick', 'steer') && has(L('paused').actions, 'resume') && L('paused').suggest === 'resume' && has(L('dead').actions, 'resume') && Array.isArray(L('donelane').actions) && L('donelane').actions.length === 0,
    JSON.stringify(['live', 'paused', 'dead', 'donelane'].map((t) => [t, L(t).actions, L(t).suggest])));
  const plans = await (await fetch(base + '/api/plans')).json(); const p = plans.find((x) => x.title === 'tok') || {};
  check('/api/plans: plan tokens = sum of its lanes', p.tokens?.total === 6250 + 3400 + 15, JSON.stringify(p.tokens));
  check('/api/plans: plan tokensBy per agent', p.tokensBy?.build?.total === 5090 + 2800 && p.tokensBy?.review?.total === 600, JSON.stringify(p.tokensBy));

  let x = await post('demo-repo--live', 'kick', { mode: 'turn' }, false); check('POST without JSON content-type is refused (415)', x.status === 415, `status ${x.status}`);
  x = await post('demo-repo--live', 'steer', { text: 'hi' }, false); check('steer also needs JSON (415)', x.status === 415, `status ${x.status}`);
  x = await post('demo-repo--live', 'kick', { mode: 'bogus' }); check('kick with a bad mode is 400', x.status === 400, `status ${x.status}`);
  x = await post('demo-repo--live', 'kick', { mode: 'fresh', text: 'start clean' }); try { kick = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch { kick = null; }
  check('POST kick writes KICK with mode, text, by dashboard', x.status === 200 && x.j.ok && kick?.mode === 'fresh' && kick?.text === 'start clean' && /dash/i.test(kick?.by || ''), `${x.status} ${JSON.stringify(x.j)} ${JSON.stringify(kick)}`);
  fs.rmSync(kf, { force: true });
  x = await post('demo-repo--live', 'kick', { mode: 'now' }); check('kick mode now accepted', x.status === 200, `status ${x.status}`); fs.rmSync(kf, { force: true });
  x = await post('demo-repo--donelane', 'kick', { mode: 'turn' }); check('kick a finished lane is 409', x.status === 409, `status ${x.status}`);
  x = await post('demo-repo--dead', 'kick', { mode: 'turn' }); check('kick a DEAD lane is 409 (resume instead)', x.status === 409 && /resume/i.test(x.j.error || ''), `${x.status} ${x.j.error}`);
  x = await post('demo-repo--donelane', 'resume', {}); check('resume a done lane is 409', x.status === 409, `status ${x.status}`);
  x = await post('demo-repo--live', 'resume', {}); check('resume a running lane is 409', x.status === 409, `status ${x.status}`);
  x = await post('demo-repo--paused', 'resume', { note: 'second note' });
  check('POST resume (dry) answers ok with the argv', x.status === 200 && x.j.ok && Array.isArray(x.j.argv) && x.j.argv.includes('--resume'), `${x.status} ${JSON.stringify(x.j)}`);
  let note2 = ''; try { note2 = fs.readFileSync(path.join(pausedDir, 'resume-note.txt'), 'utf8'); } catch {}
  check('a second note is appended, not overwritten', /use the smaller fixture/.test(note2) && /second note/.test(note2));
  x = await post('demo-repo--dead', 'resume', {});
  let ds = {}; try { ds = JSON.parse(fs.readFileSync(path.join(deadDir, 'state.json'), 'utf8')); } catch {}
  check('POST resume on a DEAD lane marks it stopped and resumes', x.status === 200 && ds.result === 'stopped', `${x.status} ${ds.result}`);
  let pj = {}; try { pj = JSON.parse(fs.readFileSync(plan, 'utf8')); } catch {}
  check('dashboard resume is logged as a plan decision', (pj.decisions || []).some((d) => /resum/i.test(d.text) && /paused/.test(d.text)), JSON.stringify(pj.decisions));
} finally { await settle({ children: [dash, sleeper], code: 0 }); }

// ---------- runner wiring (source level; a real lane proves the rest) ----------
const src = runnerSource();
check('runner imports tokens.mjs and controls.mjs', /from '\.\/tokens\.mjs'/.test(src) && /from '\.\/controls\.mjs'/.test(src));
check('runner consumes the KICK file in the supervisor', /'KICK'/.test(src) && /kick/i.test(src));
// Found on a real lane: resume after a stop ended at once because the old STOP file was still there.
check('a new run clears the STOP file of the previous run', /rmSync\(path\.join\(dir, 'STOP'\)/.test(src));
check('runner reads resume-note.txt on resume', /resume-note\.txt/.test(src));
check('step-finish tokens are counted once per part', /step-finish/.test(src) && /counted|seenStep|stepSeen/.test(src));
check('summary keeps "tokens in X out Y" for laneFromLog', /tokens in \$\{/.test(src));
const mcp = fs.readFileSync(path.join(ROOT, 'runner', 'mcp.mjs'), 'utf8');
check('MCP has ca_kick and ca_resume tools', /name: 'ca_kick'/.test(mcp) && /name: 'ca_resume'/.test(mcp));

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
process.exitCode = bad ? 1 : 0;
