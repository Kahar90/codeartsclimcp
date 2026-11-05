// Contract check for the engineer-facing CLI in runner/ca.mjs (doctor, init, status/summary --json, wait, help).
// Uses a private CA registry (CA_REGISTRY) with a fake finished lane, so it never starts CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args, opts = {}) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: opts.timeout || 60000, cwd: opts.cwd || ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);

// A fake repo with one finished lane (done, ready) and one failed lane.
const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const fake = (task, result, verdict, exitCode) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  const t = Date.now() - 600000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t, finishedAt: t + 300000, lastEventAt: t + 300000, phase: 'finished', result, verdict, exitCode, reason: result === 'failed' ? 'gates still failing' : '',
    commits: 2, steps: 3, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }], commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }, { hash: 'def5678', subject: 'step 2: b' }],
    tokens: { input: 1000, output: 200, cacheRead: 0, steps: 4 }, gates: [{ gate: 'git clean', ok: true }], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: result, models: { build: 'maas/glm-5.3', review: 'maas/glm-5.3' }, fixes: 0 }));
  fs.writeFileSync(path.join(dir, 'summary.md'), `=== lane demo-repo--${task}: ${result.toUpperCase()} in 5m0s ===\nVERDICT: ${verdict}\n`);
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
fake('good', 'done', 'ready', 0); fake('bad', 'failed', 'none', 1);

// help
let r = ca(['help']);
check('ca help exits 0', r.code === 0, r.err);
for (const c of ['doctor', 'init', 'wait', 'summary', 'lane', 'status', 'mcp']) check(`help lists "${c}"`, new RegExp(`\\bca ${c}\\b`).test(r.out));
check('help documents exit codes', /exit codes?/i.test(r.out) && /124/.test(r.out));

// status --json uses the private registry and carries the new fields
r = ca(['status', '--json']); let st = json(r.out);
check('status --json parses', Array.isArray(st), r.out.slice(0, 120));
const g = st && st.find((x) => x.task === 'good');
check('status --json finds the fake lanes only', st && st.length === 2 && !!g, st && st.map((x) => x.lane).join(','));
check('status --json fields', g && ['lane', 'id', 'task', 'repo', 'health', 'result', 'verdict', 'progress', 'summaryPath'].every((k) => k in g), g && Object.keys(g).join(','));
check('status --json progress', g && g.progress && g.progress.done === 2 && g.progress.total === 3, g && JSON.stringify(g.progress));

// summary
r = ca(['summary', 'good']); check('summary prints summary.md', r.code === 0 && /VERDICT: ready/.test(r.out), r.err);
r = ca(['summary', 'good', '--json']); const sm = json(r.out);
check('summary --json shape', sm && sm.id === 'demo-repo--good' && sm.result === 'done' && sm.verdict === 'ready' && Array.isArray(sm.commits) && sm.commits.length === 2 && Array.isArray(sm.steps) && sm.tokens && typeof sm.summary === 'string', r.out.slice(0, 160));
r = ca(['summary', 'nope']); check('summary of unknown lane exits 2', r.code === 2, `${r.code}`);

// wait: finished lanes return at once with result-based exit codes
const t0 = Date.now(); r = ca(['wait', 'good']);
check('wait on a done+ready lane exits 0 fast', r.code === 0 && Date.now() - t0 < 10000, `${r.code} ${r.err}`);
check('wait prints a CA_RESULT line', /^CA_RESULT \{.*"result":"done".*\}$/m.test(r.out), r.out.slice(-200));
r = ca(['wait', 'bad']); check('wait on a failed lane exits 1', r.code === 1, `${r.code}`);
r = ca(['wait', 'good', 'bad', '--json']); const wj = json(r.out.trim().split('\n').pop());
check('wait on several lanes: worst exit code, --json last line', r.code === 1 && wj && Array.isArray(wj.lanes) && wj.lanes.length === 2, r.out.slice(-200));
r = ca(['wait', 'nope', '--timeout', '1']); check('wait on unknown lane exits 2', r.code === 2, `${r.code}`);

// a "running" fake lane: wait --timeout gives 124
const runDir = path.join(repo, 'tasks', 'slow.lane'); fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), lastEventAt: Date.now(), phase: 'build', busy: true, commits: 0, steps: 2, tokens: {}, activity: 'thinking', steers: [], interruptions: [] }));
fs.writeFileSync(path.join(reg, 'demo-repo--slow.json'), JSON.stringify({ id: 'demo-repo--slow', dir: runDir, repo, task: 'slow' }));
const t1 = Date.now(); r = ca(['wait', 'slow', '--timeout', '3'], { timeout: 30000 });
check('wait --timeout on a running lane exits 124 after about the timeout', r.code === 124 && Date.now() - t1 >= 2500 && Date.now() - t1 < 15000, `${r.code} ${Date.now() - t1}ms`);

// init
r = ca(['init', repo, 'feature-x', '--goal', 'Add a feature x']);
const bf = path.join(repo, 'tasks', 'feature-x.md');
check('init writes tasks/<task>.md', r.code === 0 && fs.existsSync(bf), r.err);
const brief = fs.existsSync(bf) ? fs.readFileSync(bf, 'utf8') : '';
check('init brief has goal, CHECK line and safety rules', /Add a feature x/.test(brief) && /^CHECK:/m.test(brief) && /Safety rules/.test(brief));
r = ca(['init', repo, 'feature-x']); check('init refuses to overwrite without --force', r.code === 2 && fs.readFileSync(bf, 'utf8') === brief, `${r.code}`);
r = ca(['init', repo, 'feature-x', '--force', '--goal', 'Other']); check('init --force overwrites', r.code === 0 && /Other/.test(fs.readFileSync(bf, 'utf8')));
const nogit = path.join(tmp, 'plain'); fs.mkdirSync(nogit);
r = ca(['init', nogit, 't']); check('init in a non-git folder warns (git init hint)', /git init/.test(r.out + r.err));

// doctor
r = ca(['doctor', '--json'], { timeout: 90000 }); const dj = json(r.out);
check('doctor --json parses', dj && Array.isArray(dj.checks), r.out.slice(0, 160) + r.err.slice(0, 160));
if (dj) {
  const names = dj.checks.map((c) => c.name).join(',');
  for (const n of ['node', 'codearts', 'credentials', 'git', 'trusted folder', 'shell']) check(`doctor checks ${n}`, dj.checks.some((c) => c.name === n), names);
  check('doctor rows have status ok|warn|fail and detail', dj.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.status) && typeof c.detail === 'string'));
  check('doctor exit code matches fails', (r.code === 0) === !dj.checks.some((c) => c.status === 'fail'), `${r.code}`);
  const raw = JSON.stringify(dj);
  check('doctor never prints secret values', !['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK', 'MAAS_API_KEY'].some((k) => process.env[k] && raw.includes(process.env[k])));
}
r = ca(['doctor'], { timeout: 90000 }); check('doctor plain output is a table with a verdict line', /\b(ok|warn|fail)\b/i.test(r.out) && /ready|not ready/i.test(r.out), r.out.slice(-160));

// unknown command
r = ca(['bogus']); check('unknown command exits 2 and shows usage', r.code === 2 && /usage/i.test(r.out + r.err));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
