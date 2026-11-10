// Contract check for the ordering between the git clean gate and the strict numbered-step proof.
// The runner's own recovery paths (write probe, refused-commit fallback and ordinary uncommitted
// handling) must run before the strict completion proof decides a numbered step lacks a commit, so a
// completed step the sandbox refused to commit is recovered instead of reported as missing. A genuinely
// missing step is still refused before the checks or the final review can accept the lane.
// Temp repos and the fake worker only: no CodeArts server is ever started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Signals from '../runner/signals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-guardorder-')));
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, '{"security":{"trustedFolders":[]}}');
const fakeSrc = fs.readFileSync(path.join(root, 'checks/lib/fake-codearts.cjs'), 'utf8');
const refused = 'fatal: Unable to create .git/index.lock: Permission denied';
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
};
// A lane repo with its fake worker: `turns` is fake-script.json; `refused` makes the worker's final reply
// the sandbox commit refusal. The runner adds the lane-ignore .gitignore on its own.
const makeRepo = (name, { turns = ['ok'], refusedCommit = false } = {}) => {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  const fake = refusedCommit ? fakeSrc.replace("answer(sid, 'done'); setTimeout", `answer(sid, ${JSON.stringify(refused)}); setTimeout`) : fakeSrc;
  fs.writeFileSync(path.join(repo, 'serve'), fake);
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(turns));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks/work.md'), 'Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n');
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  return repo;
};
const runLane = (repo, env = {}) => spawnSync(process.execPath, [path.join(root, 'runner/ca.mjs'), 'lane', repo, 'work'], {
  cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 45000,
  env: { ...process.env, CA_REGISTRY: path.join(tmp, 'registry'), CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath, NO_REVIEW: '1', STEP_REVIEW: '0', STEP_CONTINUES: '0', CODEARTS_CLI_AK: 'fake', CODEARTS_CLI_SK: 'fake', ...env },
});
const state = (repo) => { try { return JSON.parse(fs.readFileSync(path.join(repo, 'tasks/work.lane/state.json'), 'utf8')); } catch { return null; } };
const subjects = (repo) => String(spawnSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout || '').trim().split(/\r?\n/).filter(Boolean);
try {
  // ---------- recovery: a refused commit with dirty completed work is committed by the runner ----------
  {
    const repo = makeRepo('recover', { refusedCommit: true, turns: ['write:page1.html=<p>thing 1</p>+wait:1'] });
    const r = runLane(repo); const s = state(repo);
    check('recovery: lane exits 0 (recovery runs before the missing-step proof)', r.status === 0, `exit ${r.status} ${(r.stdout || '').slice(-200)} ${(r.stderr || '').slice(-200)}`);
    check('recovery: result done', s?.result === 'done', JSON.stringify(s && { result: s.result, reason: s.reason }));
    check('recovery: the runner committed the refused work as step 1', !!s && s.commitLog.some((c) => /^step 1:/.test(c.subject)), JSON.stringify(s && s.commitLog.map((c) => c.subject)));
    check('recovery: commit-fallback interruption recorded', !!s && s.interruptions.some((i) => i.kind === 'commit-fallback'), JSON.stringify(s && s.interruptions));
  }
  // ---------- ordinary dirty work: the continuation commit path, never a fallback or a refusal ----------
  {
    const repo = makeRepo('ordinary', { turns: ['write:page1.html=<p>thing 1</p>+wait:1', 'commit:1'] });
    const r = runLane(repo); const s = state(repo);
    check('ordinary dirty: the worker commits and the lane is done', r.status === 0 && s?.result === 'done', `exit ${r.status} ${JSON.stringify(s && { result: s.result, reason: s.reason })}`);
    check('ordinary dirty: the runner did not fallback-commit it', !!s && !s.interruptions.some((i) => i.kind === 'commit-fallback'), JSON.stringify(s && s.interruptions));
    check('ordinary dirty: the ordinary uncommitted handling ran first (a failed git clean gate)', !!s && s.gates.some((g) => g.gate === 'git clean' && g.ok === false), JSON.stringify(s && s.gates));
    check('ordinary dirty: the work ends committed as step 1', subjects(repo).some((x) => /^step 1:/.test(x)), JSON.stringify(subjects(repo)));
  }
  // ---------- clean zero-commit incomplete lane: still needs review, no faked commit ----------
  {
    const repo = makeRepo('cleanblank', { turns: ['ok'] });
    const r = runLane(repo); const s = state(repo);
    check('clean blank: exits 4 needs review', r.status === 4 && s?.result === 'needs review', `exit ${r.status} ${JSON.stringify(s && { result: s.result, reason: s.reason })}`);
    check('clean blank: the reason names the missing step', !!s && /step 1/.test(s.reason || ''), s && s.reason);
    check('clean blank: no step commit was manufactured', !subjects(repo).some((x) => /^step 1:/.test(x)), JSON.stringify(subjects(repo)));
  }
  // ---------- strict guard: positional fallback is never read as completing a step ----------
  check('strict guard: an unrelated wip commit does not complete a step', JSON.stringify(Signals.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'wip: scratch work' }])) === '[1,2]');
  check('strict guard: a wip subject mentioning "step N" does not complete the step', JSON.stringify(Signals.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'wip: step 2 draft' }])) === '[1,2]');
  check('strict guard: an explicit step commit completes exactly that step', JSON.stringify(Signals.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'step 1: thing 1' }])) === '[2]');
} finally {
  const target = path.resolve(tmp), base = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(base)) throw Error('unsafe cleanup path');
  fs.rmSync(target, { recursive: true, force: true });
}

for (const l of results) console.log(l);
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
process.exit(bad ? 1 : 0);
