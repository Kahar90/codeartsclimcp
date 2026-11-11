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
import { run as runP, pool } from './lib/pool.mjs';
import { classifySignal } from '../runner/signals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const sig = (text, source) => classifySignal({ text, source, agentRole: 'build' });

// ---------- pure: assistant narration is a report, not an incident ----------
assert.equal(sig('The build was unable to access the header, so I generated it.', 'assistant'), null);
assert.equal(sig('The earlier Permission denied was a stale lock; I removed it.', 'assistant'), null);
assert.equal(sig('I removed the stale lock but git commit still failed: Permission denied', 'assistant')?.kind, 'env');
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
const run = (cwd, args, ms = 120000) => runP(process.execPath, [CA, ...args], { cwd, env, timeout: ms });
const state = (cwd) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const row = async (cwd, id) => { const r = await run(cwd, ['status', '--json', '--all'], 30000); try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.lanes || []).find((x) => x.id === id) || null; } catch { return null; } };
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await sleep(500); } };
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

const results = [];
const chkOf = (local) => (name, ok, info = '') => local.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
try {
  const pooled = await pool(4, [
    // A builder reply that narrates a resolved error must not raise a blocker: the assistant text path
    // in lane.mjs must classify it with source 'assistant'.
    async () => {
      const local = []; const chk = chkOf(local);
      const aRepo = makeRepo('narration', ['decide:Fixed persistence: loading now distinguishes missing optional data (ENOENT) from read errors.+commit:1+wait:1000', 'ok']);
      const aId = 'narration--work';
      let r = await run(aRepo, ['lane', aRepo, 'work', '--detach']);
      chk(`narration lane starts detached: ${r.stderr.slice(0, 200)}`, r.status === 0);
      r = await run(aRepo, ['wait', aId, '--timeout', '120', '--quiet']);
      chk(`narration lane finishes (exit ${r.status}): ${r.stdout.slice(0, 300)}`, r.status === 0);
      chk('resolved-error narration must not raise a blocker', /CA_BLOCKED/.test(r.stdout) === false);
      chk('no blocker is recorded for a resolved-error summary', (state(aRepo)?.blocker ?? null) === null);
      return local;
    },
    // A failed tool whose output is an expected application assertion must not raise an env blocker: the
    // failed tool path in lane.mjs must classify it with source 'tool'.
    async () => {
      const local = []; const chk = chkOf(local);
      const nRepo = makeRepo('assertnoise', ['toolerr:FAIL generated data is saved: ENOENT: no such file or directory, open /tmp/generated.json+commit:1+wait:1000', 'ok']);
      const nId = 'assertnoise--work';
      let r = await run(nRepo, ['lane', nRepo, 'work', '--detach']);
      chk(`assertion-noise lane starts detached: ${r.stderr.slice(0, 200)}`, r.status === 0);
      r = await run(nRepo, ['wait', nId, '--timeout', '120', '--quiet']);
      chk(`assertion-noise lane finishes (exit ${r.status}): ${r.stdout.slice(0, 300)}`, r.status === 0);
      chk('an expected application assertion must not raise an env blocker', /CA_BLOCKED/.test(r.stdout) === false);
      return local;
    },
    // A builder's final reply can carry a raw commit/environment failure even when the failed tool event
    // never reached the runner: the assistant text path must still raise the env blocker.
    async () => {
      const local = []; const chk = chkOf(local);
      const wRepo = makeRepo('rawdiag', ['decide:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:4000', 'ok']);
      const wId = 'rawdiag--work';
      let r = await run(wRepo, ['lane', wRepo, 'work', '--detach']);
      chk(`raw-diagnostic lane starts detached: ${r.stderr.slice(0, 200)}`, r.status === 0);
      const wsig = await until(async () => { const s = state(wRepo); return s && s.blocker ? s : null; }, 20000);
      chk(`a raw commit failure in the builder reply still blocks: ${JSON.stringify(wsig && wsig.blocker)}`, wsig?.blocker?.kind === 'env');
      chk('the blocker names the raw refusal', /index\.lock|Permission denied/.test(wsig.blocker.text || '') === true);
      const wack = await run(wRepo, ['ack', wId]);
      chk(`ca ack clears the raw-diagnostic blocker: ${wack.status} ${wack.stderr.slice(0, 200)}`, wack.status === 0);
      await until(async () => { const x = await row(wRepo, wId); return x && !x.blocked ? x : null; }, 10000);
      r = await run(wRepo, ['wait', wId, '--timeout', '120', '--quiet']);
      chk(`raw-diagnostic lane finishes after ack (exit ${r.status}): ${r.stdout.slice(0, 300)}`, r.status === 0);
      return local;
    },
    // A genuine environment failure in a failed tool still blocks: the wiring must not mute real incidents.
    async () => {
      const local = []; const chk = chkOf(local);
      const gRepo = makeRepo('genuine', ['toolerr:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:4000', 'ok']);
      const gId = 'genuine--work';
      let r = await run(gRepo, ['lane', gRepo, 'work', '--detach']);
      chk(`genuine-env lane starts detached: ${r.stderr.slice(0, 200)}`, r.status === 0);
      const gsig = await until(async () => { const s = state(gRepo); return s && s.blocker ? s : null; }, 20000);
      chk(`a genuine git permission failure still blocks: ${JSON.stringify(gsig && gsig.blocker)}`, gsig?.blocker?.kind === 'env');
      chk('the blocker names the refused commit', /Permission denied|index\.lock/.test(gsig.blocker.text || '') === true);
      const gack = await run(gRepo, ['ack', gId]);
      chk(`ca ack clears the env blocker: ${gack.status} ${gack.stderr.slice(0, 200)}`, gack.status === 0);
      const gclear = await until(async () => { const x = await row(gRepo, gId); return x && !x.blocked ? x : null; }, 10000);
      chk('the acked env blocker is cleared while the lane keeps running', !!gclear === true);
      r = await run(gRepo, ['wait', gId, '--timeout', '120', '--quiet']);
      chk(`genuine-env lane finishes after ack (exit ${r.status}): ${r.stdout.slice(0, 300)}`, r.status === 0);
      return local;
    },
  ]);
  for (const local of pooled) results.push(...local);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

for (const l of results) if (l.startsWith('FAIL')) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'PASS end-to-end source wiring: narration and expected failures stay quiet, genuine failures block');
process.exit(fails ? 1 : 0);
