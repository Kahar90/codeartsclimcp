// Contract check for the write-first nudge: a builder that keeps reading without changing a file is
// steered by the runner itself to make its first change, instead of exploring for 15 to 40 minutes
// until the lead notices (seen live on deep-reasoning builders). Pure tests for signals.mjs
// writeFirstNudge plus end-to-end runs against the fake CodeArts server.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-writefirst-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath,
  NO_REVIEW: '1', STEP_REVIEW: '0', CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '240', NO_COMMIT_S: '0' };

// ---------- pure ----------
const S = await import(pathToFileURL(path.join(ROOT, 'runner', 'signals.mjs')).href);
const N = (o) => S.writeFirstNudge({ firstWriteS: 300, readStreak: 25, ...o });
check('a fresh builder is not nudged', N({ now: 60e3, since: 0, reads: 5, nudges: 0 }) === null);
check('five quiet minutes nudge', N({ now: 301e3, since: 0, reads: 2, nudges: 0 })?.why === 'time');
check('a long read streak nudges before the time limit', N({ now: 60e3, since: 0, reads: 25, nudges: 0 })?.why === 'reads');
check('at most three nudges per quiet stretch', N({ now: 900e3, since: 0, reads: 99, nudges: 3 }) === null);
check('both limits at 0 turn it off', S.writeFirstNudge({ now: 9e6, since: 0, reads: 999, nudges: 0, firstWriteS: 0, readStreak: 0 }) === null);
check('edit and write are writes, read and grep are reads', S.WRITE_TOOLS.has('edit') && S.WRITE_TOOLS.has('write') && S.READ_TOOLS.has('read') && S.READ_TOOLS.has('grep') && !S.READ_TOOLS.has('bash'));
check('the notice says to make the first change now', /make the first change now/.test(S.writeFirstText({ quietMs: 400e3, reads: 30, nudges: 0 })));
check('a repeated notice asks for the change in the very next call', /very next tool call/.test(S.writeFirstText({ quietMs: 400e3, reads: 30, nudges: 1 })));

// ---------- end to end ----------
function makeRepo(name, script, brief = 'Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n') {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}
const lane = (repo, extra) => spawnSync(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 150000 });
const prompts = (cwd) => { try { return fs.readFileSync(path.join(cwd, 'fake-prompts.log'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
const state = (cwd) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const reads = (k) => Array.from({ length: k }, (_, i) => `read:src/f${i}.mjs`).join('+');

// A builder that reads 8 files, then idles 5 s before committing: with READ_STREAK=5 it is nudged once.
let repo = makeRepo('reader', [`${reads(8)}+wait:5000+commit:1`, 'ok']);
let r = lane(repo, { READ_STREAK: '5', FIRST_WRITE_S: '0' });
let ps = prompts(repo); let s = state(repo);
check('the reading lane still finishes', r.status === 0 && s && s.result === 'done', `${r.status} ${(r.stderr || '').slice(-200)}`);
check('a read streak sends the builder the write-first notice', ps.some((p) => /make the first change now/.test(p.text)), JSON.stringify(ps.map((p) => p.text.slice(0, 60))));
check('the nudge is recorded as an interruption', !!s && (s.interruptions || []).some((x) => x.kind === 'write-nudge'), JSON.stringify(s && s.interruptions));
check('the nudge is a runner notice, not a lead steer', !!s && !(s.steers || []).some((x) => /make the first change/.test(x.text) && x.by === 'ca steer'), JSON.stringify(s && s.steers));

// A builder that edits between reads is never nudged.
repo = makeRepo('writer', [`${reads(4)}+edit:src/a.mjs+${reads(4)}+edit:src/b.mjs+wait:5000+commit:1`, 'ok']);
r = lane(repo, { READ_STREAK: '5', FIRST_WRITE_S: '0' });
ps = prompts(repo); s = state(repo);
check('a builder that writes between reads is not nudged', r.status === 0 && !ps.some((p) => /make the first change now/.test(p.text)) && !(s?.interruptions || []).some((x) => x.kind === 'write-nudge'), JSON.stringify(ps.map((p) => p.text.slice(0, 60))));

// WRITE_FIRST: off in the brief turns it off.
repo = makeRepo('off', [`${reads(8)}+wait:5000+commit:1`, 'ok'], 'Goal: one page.\nWRITE_FIRST: off\n1. Write page1.html. Commit.\nCHECK: node -e 0\n');
r = lane(repo, { READ_STREAK: '5', FIRST_WRITE_S: '0' });
ps = prompts(repo);
check('WRITE_FIRST: off in the brief turns the nudge off', r.status === 0 && !ps.some((p) => /make the first change now/.test(p.text)), JSON.stringify(ps.map((p) => p.text.slice(0, 60))));

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exitCode = bad ? 1 : 0;
