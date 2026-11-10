// Contract check: the classifier tells a builder's narration from a failed tool's diagnostics with an
// explicit `source`, so a resolved-error summary or an expected application assertion never raises a
// false env blocker, while a genuine environment failure still reaches the lead.
// Pure asserts for runner/signals.mjs plus an end-to-end run against the fake CodeArts server that
// exercises the lane.mjs wiring of `source` (assistant text path and failed tool path).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySignal } from '../runner/signals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const sig = (text, source) => classifySignal({ text, source, agentRole: 'build' });

// ---------- pure: assistant narration is a report, not an incident ----------
assert.equal(sig('Fixed persistence: loading now distinguishes missing optional data (ENOENT) from read errors.', 'assistant'), null, 'resolved-error narration does not require intervention');
assert.equal(sig('I hit `Permission denied` while running it, then chmodded the file and fixed it.', 'assistant'), null, 'a fixed error described in prose is not an incident');
assert.equal(sig('Step 2 committed; note the earlier ENOENT was only a missing optional cache.', 'assistant'), null, 'an incidental status mention is not an incident');
assert.equal(sig('Fixed: the earlier missing optional data (ENOENT) is now distinguished from a read error.', 'assistant'), null, 'a resolved summary that names an already-handled application error stays quiet');
assert.equal(sig('fatal: Unable to create .git/index.lock: Permission denied', 'assistant')?.kind, 'env', 'a raw commit refusal in the reply stays actionable without first-person phrasing');
assert.equal(sig('git commit failed: Permission denied', 'assistant')?.kind, 'env', 'a raw git permission failure in the reply stays actionable');
assert.equal(sig('I cannot proceed: git commit failed with Permission denied', 'assistant')?.kind, 'env');
assert.equal(sig("I'm stuck: the toolchain is not installed", 'assistant')?.kind, 'env');
assert.equal(sig('Should I use a different API?', 'assistant')?.kind, 'decision');
assert.equal(sig('Please confirm the target branch before I push.', 'assistant')?.kind, 'decision');

// ---------- pure: failed tool diagnostics distinguish noise from a broken machine ----------
assert.equal(sig("FAIL generated data is saved: ENOENT: no such file or directory, open '/tmp/generated.json'", 'tool'), null, 'a failed application assertion is not a broken machine');
assert.equal(sig("PASS handles Permission denied correctly\nFAIL expected 2 but got 1", 'tool'), null, 'passing negative-test descriptions do not turn an ordinary failure into an environment incident');
assert.equal(sig('FAIL works without the cache\nok 3 - loads from disk\nnot ok 4 - falls back to the network', 'tool'), null, 'assertion lines with no environment failure are ordinary results');
assert.equal(sig('Error: spawn git ENOENT', 'tool')?.kind, 'env', 'a missing executable remains actionable');
assert.equal(sig("Error: Cannot find module 'left-pad'", 'tool')?.kind, 'env', 'a missing module remains actionable');
assert.equal(sig('fatal: Unable to create .git/index.lock: Permission denied', 'tool')?.kind, 'env', 'a refused commit remains actionable');
assert.equal(sig("fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: unable to get local issuer certificate", 'tool')?.kind, 'env', 'a git certificate failure remains actionable');
assert.equal(sig("fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 403", 'tool')?.kind, 'env', 'a git authentication failure remains actionable');

// ---------- pure: untyped classifier keeps its legacy behaviour ----------
assert.equal(sig('fatal: Unable to create .git/index.lock: Permission denied')?.kind, 'env', 'untyped legacy env detection is preserved');
assert.equal(sig("Error: Cannot find module 'left-pad'")?.kind, 'env', 'untyped legacy missing module is preserved');
assert.equal(sig('Should I use SQLite or Postgres for storage?')?.kind, 'decision', 'untyped legacy decision detection is preserved');
assert.equal(sig('TypeError: fetch failed\n  cause: ECONNRESET'), null, 'untyped legacy transient suppression is preserved');

console.log('PASS expected test failures and resolved narration do not hide genuine incidents');

// ---------- end-to-end: the lane wires `source` to the classifier ----------
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-signalprecision-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath,
  NO_REVIEW: '1', STEP_REVIEW: '0', CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '240' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cwd, args, ms = 120000) => spawnSync(process.execPath, [CA, ...args], { cwd, env, encoding: 'utf8', timeout: ms });
const state = (cwd) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const row = (cwd, id) => { const r = run(cwd, ['status', '--json', '--all'], 30000); try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.lanes || []).find((x) => x.id === id) || null; } catch { return null; } };
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v || Date.now() > end) return v; await sleep(500); } };
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

try {
  // A builder reply that narrates a resolved error must not raise a blocker: the assistant text path
  // in lane.mjs must classify it with source 'assistant'.
  const aRepo = makeRepo('narration', ['decide:Fixed persistence: loading now distinguishes missing optional data (ENOENT) from read errors.+commit:1+wait:1000', 'ok']);
  const aId = 'narration--work';
  let r = run(aRepo, ['lane', aRepo, 'work', '--detach']);
  assert.equal(r.status, 0, `narration lane starts detached: ${r.stderr.slice(0, 200)}`);
  r = run(aRepo, ['wait', aId, '--timeout', '120', '--quiet']);
  assert.equal(r.status, 0, `narration lane finishes (exit ${r.status}): ${r.stdout.slice(0, 300)}`);
  assert.equal(/CA_BLOCKED/.test(r.stdout), false, 'resolved-error narration must not raise a blocker');
  assert.equal(state(aRepo)?.blocker ?? null, null, 'no blocker is recorded for a resolved-error summary');

  // A failed tool whose output is an expected application assertion must not raise an env blocker: the
  // failed tool path in lane.mjs must classify it with source 'tool'.
  const nRepo = makeRepo('assertnoise', ['toolerr:FAIL generated data is saved: ENOENT: no such file or directory, open /tmp/generated.json+commit:1+wait:1000', 'ok']);
  const nId = 'assertnoise--work';
  r = run(nRepo, ['lane', nRepo, 'work', '--detach']);
  assert.equal(r.status, 0, `assertion-noise lane starts detached: ${r.stderr.slice(0, 200)}`);
  r = run(nRepo, ['wait', nId, '--timeout', '120', '--quiet']);
  assert.equal(r.status, 0, `assertion-noise lane finishes (exit ${r.status}): ${r.stdout.slice(0, 300)}`);
  assert.equal(/CA_BLOCKED/.test(r.stdout), false, 'an expected application assertion must not raise an env blocker');

  // A builder's final reply can carry a raw commit/environment failure even when the failed tool event
  // never reached the runner: the assistant text path must still raise the env blocker.
  const wRepo = makeRepo('rawdiag', ['decide:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:4000', 'ok']);
  const wId = 'rawdiag--work';
  r = run(wRepo, ['lane', wRepo, 'work', '--detach']);
  assert.equal(r.status, 0, `raw-diagnostic lane starts detached: ${r.stderr.slice(0, 200)}`);
  const wsig = await until(() => { const s = state(wRepo); return s && s.blocker ? s : null; }, 20000);
  assert.equal(wsig?.blocker?.kind, 'env', `a raw commit failure in the builder reply still blocks: ${JSON.stringify(wsig && wsig.blocker)}`);
  assert.equal(/index\.lock|Permission denied/.test(wsig.blocker.text || ''), true, 'the blocker names the raw refusal');
  const wack = run(wRepo, ['ack', wId]);
  assert.equal(wack.status, 0, `ca ack clears the raw-diagnostic blocker: ${wack.status} ${wack.stderr.slice(0, 200)}`);
  await until(() => { const x = row(wRepo, wId); return x && !x.blocked ? x : null; }, 10000);
  r = run(wRepo, ['wait', wId, '--timeout', '120', '--quiet']);
  assert.equal(r.status, 0, `raw-diagnostic lane finishes after ack (exit ${r.status}): ${r.stdout.slice(0, 300)}`);

  // A genuine environment failure in a failed tool still blocks: the wiring must not mute real incidents.
  const gRepo = makeRepo('genuine', ['toolerr:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:4000', 'ok']);
  const gId = 'genuine--work';
  r = run(gRepo, ['lane', gRepo, 'work', '--detach']);
  assert.equal(r.status, 0, `genuine-env lane starts detached: ${r.stderr.slice(0, 200)}`);
  const gsig = await until(() => { const s = state(gRepo); return s && s.blocker ? s : null; }, 20000);
  assert.equal(gsig?.blocker?.kind, 'env', `a genuine git permission failure still blocks: ${JSON.stringify(gsig && gsig.blocker)}`);
  assert.equal(/Permission denied|index\.lock/.test(gsig.blocker.text || ''), true, 'the blocker names the refused commit');
  const gack = run(gRepo, ['ack', gId]);
  assert.equal(gack.status, 0, `ca ack clears the env blocker: ${gack.status} ${gack.stderr.slice(0, 200)}`);
  const gclear = await until(() => { const x = row(gRepo, gId); return x && !x.blocked ? x : null; }, 10000);
  assert.equal(!!gclear, true, 'the acked env blocker is cleared while the lane keeps running');
  r = run(gRepo, ['wait', gId, '--timeout', '120', '--quiet']);
  assert.equal(r.status, 0, `genuine-env lane finishes after ack (exit ${r.status}): ${r.stdout.slice(0, 300)}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('PASS end-to-end source wiring: narration and expected failures stay quiet, genuine failures block');
