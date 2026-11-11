// End-to-end check of the lane supervisor against a fake CodeArts server (checks/lib/fake-codearts.cjs):
// rate limits (CodeArts retries a 429, then aborts the turn) are waited out on their own budget
// instead of using up MAX_RETRIES; past RATE_WAIT_S they count as normal interruptions; a sign-in
// error in the server log ends the lane with exit 3. Private registry and settings, no real CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-rate-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', RATE_BACKOFF_S: '1', LANE_TIMEOUT: '240' };
async function lane(name, script, extra = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-turns.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'probe.md'), 'Reply done.\n');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const t0 = Date.now();
  const r = await run(process.execPath, [CA, 'lane', repo, 'probe'], { cwd: repo, env: { ...base, ...extra }, timeout: 200000 });
  let st = null; try { st = JSON.parse(fs.readFileSync(path.join(repo, 'tasks', 'probe.lane', 'state.json'), 'utf8')); } catch {}
  const turns = (() => { try { return fs.readFileSync(path.join(repo, 'fake-turns.log'), 'utf8').trim().split(/\r?\n/); } catch { return []; } })();
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, turns, ms: Date.now() - t0 };
}

// Every scenario is independent (own repo, shared registry), so start them all first and await the pool.
const [rateThenOk, rateForever, netThenOk, badKeys] = await pool(4, [
  () => lane('rate-then-ok', ['rate', 'rate', 'rate', 'rate', 'ok'], { MAX_RETRIES: '3' }),
  () => lane('rate-forever', ['rate'], { MAX_RETRIES: '0', RATE_WAIT_S: '3' }),
  () => lane('net-then-ok', ['net', 'ok'], { MAX_RETRIES: '0' }),
  () => lane('bad-keys', ['auth']),
]);

let r = rateThenOk;
check('4 rate limits then an answer: lane DONE although MAX_RETRIES is 3', r.code === 0 && r.st?.result === 'done', `${r.code} ${r.out.split('\n').filter((l) => /===|rate|gave up/.test(l)).slice(-4).join(' | ')}`);
check('the abort after rate-limit retries is classed as rate, not other', r.st && r.st.interruptions.filter((i) => i.kind === 'rate').length === 4 && !r.st.interruptions.some((i) => i.kind === 'other'), JSON.stringify(r.st?.interruptions?.map((i) => i.kind)));
check('each rate limit was retried in the same lane (5 turns played)', r.turns.length === 5, r.turns.join(','));
check('the waits are logged as rate limited', /rate limited/.test(r.out));

r = rateForever;
check('past RATE_WAIT_S the rate limit counts as an interruption and the lane fails', r.code === 1 && r.st?.result === 'failed' && /gave up|interruptions/.test(r.st?.reason || r.out), `${r.code} ${r.st?.result} ${r.st?.reason}`);
check('it did not loop forever (under 60 s)', r.ms < 60000, `${r.ms} ms`);

r = netThenOk;
check('a network error waits for the network and resumes without using a retry (MAX_RETRIES 0, lane DONE)', r.code === 0 && r.st?.result === 'done' && r.turns.length === 2, `${r.code} ${r.st?.result} ${r.turns.join(',')} ${r.out.split(/\r?\n/).filter((l) => /network|===/.test(l)).slice(-3).join(' | ')}`);

// --detach returns only when the lane is running (an immediate wait finds it), and reports a lane that cannot start
{
  const repo = path.join(tmp, 'detach'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), '["ok"]'); fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-turns.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'probe.md'), 'Reply done.\n'); fs.writeFileSync(path.join(repo, 'tasks', 'bad.md'), '1. x. Commit.\nCHECK: <exact command>\n');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const caRun = (args) => run(process.execPath, [CA, ...args], { cwd: repo, env: base, timeout: 120000 });
  let d = await caRun(['lane', repo, 'probe', '--detach']);
  const w = await caRun(['wait', 'detach--probe', '--timeout', '90', '--quiet']);
  check('lane --detach then an immediate wait finds the lane and gets its result', d.status === 0 && w.status === 0 && /"result":"done"/.test(w.stdout), `${d.status} ${w.status} ${(w.stdout + w.stderr).slice(-200)}`);
  d = await caRun(['lane', repo, 'bad', '--detach']);
  check('lane --detach reports a lane that cannot start, with its exit code', d.status === 2 && /did not start/.test(d.stderr) && /placeholder/.test(d.stderr), `${d.status} ${d.stderr.slice(0, 200)}`);
  check('the lane log stays out of git status', !/lane\.log/.test(g('status', '--short').stdout), g('status', '--short').stdout);
}

r = badKeys;
check('a sign-in error in the server log ends the lane with exit 3 and names the AK/SK', r.code === 3 && /AK\/SK/.test(r.out), `${r.code} ${r.out.split('\n').filter((l) => /===|keys|AK/.test(l)).slice(-3).join(' | ')}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
