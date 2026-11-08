// Contract check for the write guard: a repo that cannot be written is caught before a lane starts,
// ends the build loop at once, and `ca wait --any` returns for the first lane to finish.
// Fake lanes only: no CodeArts server is ever started (the lane probe fails before the server).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-writeguard-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const baseEnv = {
  ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1',
  CODEARTS_EXE: process.execPath,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b',
};
const ca = (args, extra = {}, timeout = 60000) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CA, ...args], { env: { ...baseEnv, ...extra }, encoding: 'utf8', timeout, cwd: ROOT });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
};
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const lastJson = (s) => { const lines = String(s || '').split(/\r?\n/); for (let i = lines.length - 1; i >= 0; i--) { const t = lines[i].trim(); if (t[0] !== '{' || t[t.length - 1] !== '}') continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* not JSON */ } } return null; };

const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

// 1. doctor: a repo writable row, ok normally and fail with the test hook.
const docRow = (extra) => { const r = ca(['doctor', repo, '--json'], extra); let j = null; try { j = JSON.parse(r.out.trim()); } catch { j = lastJson(r.out); } return j && (j.checks || []).find((x) => x.name === 'repo writable'); };
const okRow = docRow({});
check('doctor: repo writable is ok on a normal repo', okRow && okRow.status === 'ok', JSON.stringify(okRow));
const badRow = docRow({ CA_WRITE_PROBE_FAIL: '1' });
check('doctor: repo writable fails with CA_WRITE_PROBE_FAIL=1', badRow && badRow.status === 'fail', JSON.stringify(badRow));
check('doctor: the repo writable fail row names a fix', badRow && /Controlled Folder Access|folder permissions/.test(badRow.fix || ''), badRow && badRow.fix);

// 2. ca lane: the probe ends the lane at once, before any server or model call.
fs.writeFileSync(path.join(repo, 'tasks', 'blocked.md'), '1. Add a file. Commit.\nCHECK: node -e "process.exit(0)"\n');
const lane = ca(['lane', repo, 'blocked'], { CA_WRITE_PROBE_FAIL: '1' }, 30000);
const laneDir = path.join(repo, 'tasks', 'blocked.lane');
let st = null; try { st = JSON.parse(fs.readFileSync(path.join(laneDir, 'state.json'), 'utf8')); } catch { /* not written */ }
check('ca lane on a blocked repo ends failed (exit 1) within 30 s', lane.code === 1 && !lane.timedOut && lane.ms < 30000, `exit ${lane.code} ${lane.ms} ms`);
check('ca lane reason starts with "repo not writable"', /^repo not writable/.test((st && st.reason) || ''), st && st.reason);
check('ca lane never starts a server', !(st && st.server) && !fs.existsSync(path.join(laneDir, 'server.log')), st && JSON.stringify(st.server));
let live = ''; try { live = fs.readFileSync(path.join(laneDir, 'live.log'), 'utf8'); } catch { /* none */ }
check('ca lane never reaches starting the server', !/starting codearts server/.test(live), live.slice(-160));

// 3. ca wait --any: return for the first lane to end, the rest listed as still running.
const fake = (task, s) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ steps: 1, commits: 1, stepList: [{ n: 1, text: 'a' }], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], models: {}, startedAt: Date.now() - 300000, lastEventAt: Date.now(), phase: 'build', busy: true, ...s }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
fake('donefirst', { pid: 999999, finishedAt: Date.now() - 1000, result: 'done', activity: 'done' });
fake('still', { pid: process.pid, result: null, activity: 'building' });
const w = ca(['wait', 'demo-repo--donefirst', 'demo-repo--still', '--any', '--json', '--quiet', '--timeout', '10']);
check('ca wait --any returns as soon as one lane ends (exit 0)', w.code === 0, `exit ${w.code}`);
const wj = lastJson(w.out);
check('ca wait --any reports the finished lane and the running one', !!wj && wj.any === true && (wj.lanes || []).some((x) => x.lane === 'demo-repo--donefirst') && (wj.running || []).some((x) => x.id === 'demo-repo--still'), JSON.stringify(wj).slice(0, 200));

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
