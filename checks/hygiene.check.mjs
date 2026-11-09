// Contract check for lane workspace hygiene: lane workspaces are local clones (never worktrees), the
// runner commits a worker commit the sandbox refused, sleep-polling is caught, a crashed check is a
// real failure, and `ca wait --json --compact` returns only the small decision rows.
// Temp repos and fake lanes only: no CodeArts server is ever started.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-hygiene-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const baseEnv = {
  ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1',
  CODEARTS_EXE: process.execPath,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b',
};
const ca = (args, extra = {}, timeout = 60000) => {
  const r = spawnSync(process.execPath, [CA, ...args], { env: { ...baseEnv, ...extra }, encoding: 'utf8', timeout, cwd: ROOT });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
};
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const lastJson = (s) => { const lines = String(s || '').split(/\r?\n/); for (let i = lines.length - 1; i >= 0; i--) { const t = lines[i].trim(); if (t[0] !== '{' || t[t.length - 1] !== '}') continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* not JSON */ } } return null; };
const gitOut = (cwd, ...args) => String(spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const gitDo = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', windowsHide: true });

// ---------- (a) pure helpers from runner/controls.mjs ----------
let C = null;
try { C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href); } catch (e) { check('runner/controls.mjs loads', false, e.message); }
if (C) {
  check('exposes the hygiene helpers', typeof C.gitDirInsideRepo === 'function' && typeof C.commitRefused === 'function' && typeof C.commitFallbackDecision === 'function' && typeof C.sleepPoll === 'function' && typeof C.classifyCheck === 'function');

  check('sleepPoll: sleep 5 is allowed', C.sleepPoll('sleep 5; cat out.txt') === 0);
  check('sleepPoll: sleep 200; cat x is caught', C.sleepPoll('sleep 200; cat x') === 200);
  check('sleepPoll: sleep 30 && tail is caught', C.sleepPoll('sleep 30 && tail -f log') === 30);

  const refused = "fatal: Unable to create '.git/index.lock': Permission denied";
  check('commitRefused: names the refused commit line', C.commitRefused(`ok so far\n${refused}`) === refused, C.commitRefused(refused));
  check('commitRefused: a clean reply is not a refusal', C.commitRefused('committed as abc1234, all good') === '');
  check('commitRefused: an index.lock line is a refusal', C.commitRefused('error: could not write index.lock') !== '');
  const dcommit = C.commitFallbackDecision({ dirty: true, refused, writable: true });
  const dfail = C.commitFallbackDecision({ dirty: true, refused, writable: false });
  const dnone = C.commitFallbackDecision({ dirty: true, refused: '', writable: true });
  check('commitFallbackDecision: refused + writable commits', dcommit.action === 'commit', JSON.stringify(dcommit));
  check('commitFallbackDecision: refused + not writable fails with the line', dfail.action === 'fail' && /^commit failed: /.test(dfail.reason || ''), JSON.stringify(dfail));
  check('commitFallbackDecision: not refused is the ordinary path', dnone.action === 'none', JSON.stringify(dnone));

  check('gitDirInsideRepo: a clone git dir is inside', C.gitDirInsideRepo('/repo/wt', '/repo/wt/.git') === true);
  check('gitDirInsideRepo: a worktree git dir is outside', C.gitDirInsideRepo('/repo/wt', '/repo/.git/worktrees/wt') === false);

  check('classifyCheck: 127 + command not found is infra', C.classifyCheck({ code: 127, out: 'bash: xyz: command not found' }) === 'infra');
  const crash = 'PASS one case\nPASS two cases\nnode:internal/assert: Assertion failed: (x), function f\n';
  check('classifyCheck: 127 after PASS lines and an assertion abort is fail', C.classifyCheck({ code: 127, out: crash }) === 'fail');
  check('classifyCheck: 127 with empty output is infra', C.classifyCheck({ code: 127, out: '' }) === 'infra');
}

// ---------- (b) ca workspace: a local clone, on lane/<task>, land merges back and removes it ----------
const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
gitDo(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
fs.writeFileSync(path.join(repo, 'tasks', 'feat.md'), '1. Do a thing. Commit.\n');

const clone = path.join(tmp, 'demo-repo-wt-feat');
const w = ca(['workspace', repo, 'feat']);
check('ca workspace creates the clone folder', w.code === 0 && fs.existsSync(clone), `exit ${w.code} ${w.out.slice(0, 100)}`);
const gitDir = path.resolve(gitOut(clone, 'rev-parse', '--absolute-git-dir')).replace(/\\/g, '/').toLowerCase();
const cloneAbs = path.resolve(clone).replace(/\\/g, '/').toLowerCase();
check('the clone git dir lives inside the clone', gitDir === cloneAbs + '/.git' || gitDir.startsWith(cloneAbs + '/'), gitDir);
check('the clone is on branch lane/feat', gitOut(clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'lane/feat');
check('the untracked brief was copied into the clone', fs.existsSync(path.join(clone, 'tasks', 'feat.md')));

// Commit the brief so the main tree is clean (land refuses a dirty tree), then make the clone's commit.
gitDo(repo, 'add', '-A'); gitDo(repo, 'commit', '-q', '-m', 'brief: feat');
fs.writeFileSync(path.join(clone, 'work.txt'), 'done\n');
gitDo(clone, 'add', '-A'); gitDo(clone, 'commit', '-q', '-m', 'step 1: work');
const land = ca(['workspace', '--land', repo, 'feat']);
check('ca workspace --land merges the clone commit into main', land.code === 0, (land.out + land.err).slice(0, 160));
check('--land removed the clone folder', !fs.existsSync(clone));
check('the merge brought the work into main', /step 1: work/.test(gitOut(repo, 'log', '--oneline', '-6')));

// --land refuses a dirty main tree, then lands once it is clean.
fs.writeFileSync(path.join(repo, 'tasks', 'feat2.md'), '1. Another. Commit.\n');
const clone2 = path.join(tmp, 'demo-repo-wt-feat2');
ca(['workspace', repo, 'feat2']);
gitDo(repo, 'add', '-A'); gitDo(repo, 'commit', '-q', '-m', 'brief: feat2');
fs.writeFileSync(path.join(clone2, 'work2.txt'), 'done\n');
gitDo(clone2, 'add', '-A'); gitDo(clone2, 'commit', '-q', '-m', 'step 1: more work');
fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
const dirtyLand = ca(['workspace', '--land', repo, 'feat2']);
check('--land refuses a dirty main tree (exit 1)', dirtyLand.code === 1 && /dirty/i.test(dirtyLand.err + dirtyLand.out), `exit ${dirtyLand.code} ${(dirtyLand.err + dirtyLand.out).slice(0, 120)}`);
fs.rmSync(path.join(repo, 'dirty.txt'), { force: true });
const cleanLand = ca(['workspace', '--land', repo, 'feat2']);
check('--land succeeds once the main tree is clean', cleanLand.code === 0 && !fs.existsSync(clone2), `exit ${cleanLand.code}`);

// ---------- (c) doctor warns on a worktree (git dir outside the lane folder) ----------
const wt = path.join(tmp, 'wt');
gitDo(repo, 'worktree', 'add', wt, '-b', 'wt-branch');
const doc = ca(['doctor', wt, '--json']);
let docJson = null; try { docJson = JSON.parse(doc.out.trim()); } catch { docJson = lastJson(doc.out); }
const row = docJson && (docJson.checks || []).find((x) => x.name === 'repo writable');
check('doctor warns on a worktree', !!row && row.status === 'warn', JSON.stringify(row));
check('the worktree warn row points at ca workspace', row && /ca workspace/.test(row.fix || ''), row && row.fix);

// ---------- (d) ca wait --json --compact: only the small decision fields ----------
const fake = (task, s) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ steps: 2, commits: 1, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], tokens: { input: 10, output: 5, steps: 1 }, steers: [], interruptions: [], gates: [{ gate: 'git clean', ok: true }], permissions: [], outside: [], errors: [], models: {}, startedAt: Date.now() - 300000, lastEventAt: Date.now() - 1000, phase: 'finished', ...s }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
fake('donec', { pid: 999999, finishedAt: Date.now() - 1000, result: 'done', verdict: 'ready', activity: 'done' });
const cw = ca(['wait', 'demo-repo--donec', '--json', '--compact', '--quiet', '--timeout', '10']);
const cj = lastJson(cw.out);
const row0 = cj && (cj.lanes || [])[0];
const keys = row0 ? Object.keys(row0).sort() : [];
const sKeys = row0 && row0.status ? Object.keys(row0.status).sort() : [];
check('compact wait row has only the listed fields', JSON.stringify(keys) === JSON.stringify(['commits', 'lane', 'next', 'progress', 'status', 'tokens']), JSON.stringify(keys));
check('compact wait status has key, label and attention only', JSON.stringify(sKeys) === JSON.stringify(['attention', 'key', 'label']), JSON.stringify(sKeys));
check('compact wait row carries lane, progress, commits, tokens and next', !!row0 && row0.lane === 'demo-repo--donec' && /^\d+\/\d+$/.test(row0.progress || '') && typeof row0.commits === 'number' && typeof row0.tokens === 'number' && typeof row0.next === 'string', JSON.stringify(row0));
check('ca wait without --compact still returns the full result rows', (() => { const fw = ca(['wait', 'demo-repo--donec', '--json', '--quiet', '--timeout', '10']); const fj = lastJson(fw.out); const r = fj && (fj.lanes || [])[0]; return !!r && r.lane === 'demo-repo--donec' && r.result === 'done' && r.progress === undefined; })());

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
