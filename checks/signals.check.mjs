// Contract check: worker decisions and actionable environment failures reach the lead in seconds,
// and an unanswered decision is not silently cleared by an unrelated commit (steer or ack clears it).
// Pure tests for runner/signals.mjs plus an end-to-end run against the fake CodeArts server.
//  - decision: the worker asks for a lead input or permission with a finished reply text part; the
//    runner records S.blocker kind "decision", ca wait returns exit 11 within 5 s and status --json
//    shows blocked {kind, text}. A later unrelated step commit keeps the blocker; a steer clears it.
//  - env: a failed tool part carries an actionable environment error (a refused commit, a missing
//    tool): S.blocker kind "env", same wait/status path; `ca ack` clears it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-signals-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath,
  NO_REVIEW: '1', STEP_REVIEW: '0', CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '240' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo(name, script, steps = 1) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  const brief = `Goal: ${steps === 1 ? 'one page' : steps + ' pages'}.\n` + Array.from({ length: steps }, (_, i) => `${i + 1}. Write page${i + 1}.html. Commit.`).join('\n') + '\nCHECK: node -e 0\n';
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}
const run = (cwd, args, ms = 120000, extra = {}) => spawnSync(process.execPath, [CA, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: ms });
const lines = (out, tag) => String(out || '').split(/\r?\n/).filter((l) => l.startsWith(tag + ' ')).map((l) => { try { return JSON.parse(l.slice(tag.length + 1)); } catch { return null; } }).filter(Boolean);
const row = (cwd, id) => { const r = run(cwd, ['status', '--json', '--all'], 30000); try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.lanes || []).find((x) => x.id === id) || null; } catch { return null; } };
const state = (cwd) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v || Date.now() > end) return v; await sleep(500); } };
const prompts = (cwd) => { try { return fs.readFileSync(path.join(cwd, 'fake-prompts.log'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
const subjects = (cwd) => (spawnSync('git', ['log', '--format=%s'], { cwd, encoding: 'utf8' }).stdout || '').split(/\r?\n/).filter(Boolean);
// Wait for the lane's live log to show the signal was recorded, so the e2e timing starts at the event.
const waitBlocker = async (cwd, kind, ms) => until(() => { const s = state(cwd); return s && s.blocker && s.blocker.kind === kind ? s : null; }, ms);

// ---------- pure ----------
const S = await import(pathToFileURL(path.join(ROOT, 'runner', 'signals.mjs')).href);
const sig = (t, extra) => S.classifySignal({ text: t, ...extra });
check('pure decision: "Should I ..."', sig('Should I use SQLite or Postgres for storage?')?.kind === 'decision', JSON.stringify(sig('Should I use SQLite or Postgres for storage?')));
check('pure decision: "Can I commit ...?"', sig('Can I commit this now?')?.kind === 'decision');
check('pure decision: "Please confirm ..."', sig('Please confirm the target branch before I push.')?.kind === 'decision');
check('pure decision: "Do you want me to ...?"', sig('Do you want me to remove the old file?')?.kind === 'decision');
check('pure decision: "which ... should I" question', sig('Which database should I use here?')?.kind === 'decision');
check('pure decision: "need your input"', sig('I need your decision on the API shape.')?.kind === 'decision');
check('pure env: refused commit (index.lock / Permission denied)', sig('fatal: Unable to create /repo/.git/index.lock: Permission denied')?.kind === 'env');
check('pure env: missing tool (command not found)', sig('bash: node: command not found')?.kind === 'env');
check('pure env: missing module', sig("Error: Cannot find module 'left-pad'")?.kind === 'env');
check('pure env: fatal git line', sig("fatal: not a git repository (or any of the parent directories): .git")?.kind === 'env');
check('pure ignore: transient network error (fetch failed / ECONNRESET)', sig('TypeError: fetch failed\n  cause: ECONNRESET') === null);
check('pure ignore: rate limit already retried', sig('Too many requests, the rate limit is 1000000 tokens per minute.') === null);
check('pure ignore: a 5xx transport error', sig('Error: 503 Service Unavailable\nCannot connect to host') === null);
check('pure ignore: git transient network fatal (unable to access / Failed to connect)', sig("fatal: unable to access 'https://example.com/x.git/': Failed to connect to example.com port 443") === null);
check('pure ignore: git transient network fatal (Could not resolve host)', sig('fatal: unable to access ...: Could not resolve host: github.com') === null);
check('pure env: git authentication failure needs the lead', sig("fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 403")?.kind === 'env');
check('pure env: git certificate failure needs the lead', sig("fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: unable to get local issuer certificate")?.kind === 'env');
check('pure env still: a non-network git fatal is actionable', sig("fatal: not a git repository (or any of the parent directories): .git")?.kind === 'env');
check('pure ignore: inline-backtick quoted error in prose', sig('I hit `Permission denied` while running it, then chmodded the file and fixed it.') === null);
check('pure ignore: inline-code error in prose is stripped, real unquoted env still fires', sig('Note `leftover` then fatal: Unable to create .git/index.lock: Permission denied')?.kind === 'env');
check('pure ignore: a review session never blocks the lead', sig('Should I use SQLite?', { agentRole: 'review' }) === null);
check('pure ignore: quoted code in a fenced block', sig('Here is the guard:\n```\nif (should I) { handle(); }\n```\ndone') === null);
check('pure ignore: a quoted line', sig('> Should I use SQLite?') === null);
check('pure ignore: a rhetorical question', sig('Why should I add a database for a static page? It is flat HTML.') === null);
check('pure ignore: plain progress text', sig('done') === null && sig('') === null && sig('step 1 committed, moving on') === null);

// ---------- decision end to end ----------
const dRepo = makeRepo('decide', ['decide:Should I use SQLite or Postgres for storage?+commit:1+wait:20000', 'ok']);
const dId = 'decide--work';
let r = run(dRepo, ['lane', dRepo, 'work', '--detach']);
check('decision lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
// Watch the state file for the event, then time ca wait from that moment: the alert latency.
const dsig = await waitBlocker(dRepo, 'decision', 20000);
const eventAt = dsig ? dsig.blocker.at : 0;
r = run(dRepo, ['wait', dId, '--timeout', '40', '--quiet']);
const seenAt = Date.now();
let bl = lines(r.stdout, 'CA_BLOCKED');
check('ca wait returns exit 11 with one CA_BLOCKED kind decision naming the worker question', r.status === 11 && bl.length === 1 && bl[0].lane === dId && bl[0].kind === 'decision' && /SQLite or Postgres/.test(bl[0].text || ''), `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
check('the lead sees the decision within 5 s of the worker asking', eventAt > 0 && seenAt - eventAt < 5000, `${eventAt ? seenAt - eventAt : 'no-event'} ms`);
let d = row(dRepo, dId);
check('status --json shows the decision as blocked {kind, text, at} on a lane that is still running', d && !d.result && d.blocked && d.blocked.kind === 'decision' && /SQLite/.test(d.blocked.text || '') && Number.isFinite(d.blocked.at), JSON.stringify(d && d.blocked));
const turns = (() => { try { return fs.readFileSync(path.join(dRepo, 'fake-turns.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { return []; } })();
check('an unrelated step commit landed while the decision stayed open', turns.length >= 1, JSON.stringify(turns));
r = run(dRepo, ['wait', dId, '--timeout', '5', '--quiet', '--json']);
check('the unrelated commit did not silently clear the decision (still exit 11)', r.status === 11 && /CA_BLOCKED/.test(r.stdout) && /decision/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);
r = run(dRepo, ['steer', dId, 'Use SQLite.']);
check('ca steer is accepted on the decision lane', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
d = await until(() => { const x = row(dRepo, dId); return x && !x.blocked ? x : null; }, 10000);
check('a delivered steer clears the decision blocker while the lane keeps running', !!d && !d.result, JSON.stringify(row(dRepo, dId) && row(dRepo, dId).blocked));
r = run(dRepo, ['wait', dId, '--timeout', '90', '--quiet']);
check('after the steer the decision lane finishes (exit 0, no CA_BLOCKED)', r.status === 0 && /CA_RESULT/.test(r.stdout) && !/CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);

// ---------- env end to end ----------
const eRepo = makeRepo('env', ['toolerr:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:20000', 'ok']);
const eId = 'env--work';
r = run(eRepo, ['lane', eRepo, 'work', '--detach']);
check('env lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
const esig = await waitBlocker(eRepo, 'env', 20000);
check('the runner recorded an env blocker from the failed tool output', !!esig && /Permission denied|index\.lock/.test(esig.blocker.text || ''), JSON.stringify(esig && esig.blocker));
r = run(eRepo, ['wait', eId, '--timeout', '40', '--quiet']);
bl = lines(r.stdout, 'CA_BLOCKED');
check('ca wait returns exit 11 with CA_BLOCKED kind env', r.status === 11 && bl.length === 1 && bl[0].kind === 'env' && /Permission denied|index\.lock/.test(bl[0].text || ''), `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
let e = row(eRepo, eId);
check('status --json shows blocked kind env', e && e.blocked && e.blocked.kind === 'env', JSON.stringify(e && e.blocked));
r = run(eRepo, ['ack', eId]);
check('ca ack on the running env lane is accepted (clears the blocker, does not finish the lane)', r.status === 0 && !/handled|was done/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);
e = await until(() => { const x = row(eRepo, eId); return x && !x.blocked ? x : null; }, 10000);
check('the acked env blocker is cleared while the lane keeps running', !!e && !e.result, JSON.stringify(row(eRepo, eId)));
r = run(eRepo, ['wait', eId, '--timeout', '90', '--quiet']);
check('the env lane still finishes normally', r.status === 0 && /CA_RESULT/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);

// ---------- pure: direct check invocation and repeated failures ----------
const dc = (cmd, o) => S.directCheckInvocation(cmd, o);
check('pure direct-check: a CHECK line run directly is caught', dc('node checks/blocked.check.mjs', { checks: ['node checks/blocked.check.mjs'] }) === 'node checks/blocked.check.mjs');
check('pure direct-check: a checks/*.check.* file run with node is caught', dc('cd repo && node checks/fastgates.check.mjs', { checks: [] }) === 'checks/fastgates.check.mjs');
check('pure direct-check: the lane helper is not flagged (forward slashes)', dc('node tasks/work.lane/check.mjs 2', { checks: ['node checks/blocked.check.mjs'], helper: 'tasks/work.lane/check.mjs' }) === '');
check('pure direct-check: the lane helper is not flagged (backslashes)', dc('node tasks\\work.lane\\check.mjs all', { checks: ['node checks/blocked.check.mjs'] }) === '');
check('pure direct-check: a plain command is not flagged', dc('git commit -m "step 1"', { checks: ['node checks/blocked.check.mjs'] }) === '');
const nf1 = S.noteFailure(null, { commits: 0 });
const nf2 = S.noteFailure(nf1.state, { commits: 0 });
const nf3 = S.noteFailure(nf2.state, { commits: 0 });
check('pure repeat-fail: the same command failing 3 times with no progress is a repeat', !nf1.repeat && !nf2.repeat && nf3.repeat, JSON.stringify([nf1, nf2, nf3]));
const nr = S.noteFailure({ n: 2, commits: 0 }, { commits: 1 });
check('pure repeat-fail: a new commit resets the counter (progress)', !nr.repeat && nr.state.n === 1, JSON.stringify(nr));
check('pure tool key: the same tool and command collapse', S.toolKey('bash', { command: 'git commit -m  x' }) === S.toolKey('bash', { command: 'git commit -m x' }));

// ---------- direct check invocation end to end ----------
const cRepo = makeRepo('direct', ['bash:node checks/blocked.check.mjs+commit:1+wait:15000', 'ok']);
const cId = 'direct--work';
r = run(cRepo, ['lane', cRepo, 'work', '--detach']);
check('direct-check lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
const csig = await waitBlocker(cRepo, 'sandbox-check', 20000);
check('a CHECK line run directly in the sandbox raises a sandbox-check blocker', !!csig && /blocked\.check\.mjs/.test(csig.blocker.text || ''), JSON.stringify(csig && csig.blocker));
r = run(cRepo, ['wait', cId, '--timeout', '24', '--quiet']);
bl = lines(r.stdout, 'CA_BLOCKED');
check('ca wait returns exit 11 with CA_BLOCKED kind sandbox-check', r.status === 11 && bl.length === 1 && bl[0].kind === 'sandbox-check' && /checks/.test(bl[0].text || ''), `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
const guided = await until(() => prompts(cRepo).find((p) => /Do not run a CHECK line directly/i.test(p.text) && /tasks[\\/]work\.lane[\\/]check\.mjs/.test(p.text)) || null, 12000);
check('the worker is steered to the lane check helper', !!guided, JSON.stringify(prompts(cRepo).map((p) => p.text.slice(0, 80))));
r = run(cRepo, ['ack', cId]);
check('ca ack on the running direct-check lane is accepted', r.status === 0 && !/handled|was done/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);
let c = await until(() => { const x = row(cRepo, cId); return x && !x.blocked ? x : null; }, 10000);
check('the acked sandbox-check blocker is cleared while the lane keeps running', !!c && !c.result, JSON.stringify(row(cRepo, cId)));
r = run(cRepo, ['wait', cId, '--timeout', '90', '--quiet']);
check('the direct-check lane still finishes normally', r.status === 0 && /CA_RESULT/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);

// ---------- repeated tool failure end to end ----------
const fRepo = makeRepo('repfail', ['toolerr:AssertionError: expected 1 got 2+toolerr:AssertionError: expected 1 got 2+toolerr:AssertionError: expected 1 got 2+commit:1+wait:15000', 'ok']);
const fId = 'repfail--work';
r = run(fRepo, ['lane', fRepo, 'work', '--detach']);
check('repeat-fail lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
const fsig = await waitBlocker(fRepo, 'repeat-fail', 20000);
check('the same tool failing repeatedly with no progress raises a repeat-fail blocker', !!fsig && /bash/.test(fsig.blocker.text || ''), JSON.stringify(fsig && fsig.blocker));
// The lead answers from the blocker alone: it carries the tool's own error, not just the tool name.
check('the repeat-fail blocker says what the tool error was', !!fsig && String(fsig.blocker.text || '').split(': ').length >= 3, JSON.stringify(fsig && fsig.blocker));
r = run(fRepo, ['wait', fId, '--timeout', '24', '--quiet']);
bl = lines(r.stdout, 'CA_BLOCKED');
check('ca wait returns exit 11 with CA_BLOCKED kind repeat-fail', r.status === 11 && bl.length === 1 && bl[0].kind === 'repeat-fail', `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
r = run(fRepo, ['ack', fId]);
check('ca ack on the running repeat-fail lane is accepted', r.status === 0 && !/handled|was done/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 200)}`);
const fclear = await until(() => { const x = row(fRepo, fId); return x && !x.blocked ? x : null; }, 10000);
check('the acked repeat-fail blocker is cleared while the lane keeps running', !!fclear && !fclear.result, JSON.stringify(row(fRepo, fId)));
r = run(fRepo, ['wait', fId, '--timeout', '90', '--quiet']);
check('the repeat-fail lane still finishes normally', r.status === 0 && /CA_RESULT/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);

// ---------- pure: completed tools and nonzero exit (real CodeArts tool shape) ----------
check('pure toolFailureText: status error returns the error text', S.toolFailureText({ status: 'error', error: 'boom' }) === 'boom');
check('pure toolFailureText: a completed exit 0 is not a failure (green output is not classified)', S.toolFailureText({ status: 'completed', metadata: { exit: 0 }, output: 'fatal: Permission denied (quoted by a passing test)' }) === '');
check('pure toolFailureText: a completed nonzero exit returns the output', /index\.lock/.test(S.toolFailureText({ status: 'completed', metadata: { exit: 1 }, output: 'fatal: Unable to create .git/index.lock' })));
check('pure toolFailureText: a completed part without any exit code is not a failure', S.toolFailureText({ status: 'completed', output: 'fatal: Permission denied' }) === '');
check('pure toolFailureText: exitCode at the top level is honored', S.toolFailureText({ status: 'completed', exitCode: 2, output: 'Cannot find module x' }).includes('Cannot find module'));

// ---------- completed tool with a nonzero exit end to end ----------
const xRepo = makeRepo('exitfail', ['shfail:fatal: Unable to create .git/index.lock: Permission denied+commit:1+wait:15000', 'ok']);
const xId = 'exitfail--work';
r = run(xRepo, ['lane', xRepo, 'work', '--detach']);
check('exit-fail lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
const xsig = await waitBlocker(xRepo, 'env', 20000);
check('a completed tool with a nonzero exit and error output raises an env blocker', !!xsig && /index\.lock|Permission denied/.test(xsig.blocker.text || ''), JSON.stringify(xsig && xsig.blocker));
r = run(xRepo, ['wait', xId, '--timeout', '24', '--quiet']);
bl = lines(r.stdout, 'CA_BLOCKED');
check('ca wait returns exit 11 with CA_BLOCKED kind env for the nonzero-exit tool', r.status === 11 && bl.length === 1 && bl[0].kind === 'env', `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
r = run(xRepo, ['ack', xId]);
check('ca ack clears the nonzero-exit env blocker', r.status === 0, `${r.status} ${r.stdout.slice(0, 200)}`);
await until(() => { const x = row(xRepo, xId); return x && !x.blocked ? x : null; }, 10000);
r = run(xRepo, ['wait', xId, '--timeout', '90', '--quiet']);
check('the exit-fail lane still finishes normally', r.status === 0 && /CA_RESULT/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 300)}`);

// ---------- passing tool that quotes an error is NOT a false positive ----------
const oRepo = makeRepo('exitok', ['shok:fatal: Permission denied was hit earlier but every test passes now+commit:1+wait:1000', 'ok']);
const oId = 'exitok--work';
r = run(oRepo, ['lane', oRepo, 'work', '--detach']);
check('exit-ok lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
r = run(oRepo, ['wait', oId, '--timeout', '90', '--quiet']);
const ostate = state(oRepo);
check('a passing (exit 0) tool whose output quotes an error does NOT raise a blocker', r.status === 0 && !/CA_BLOCKED/.test(r.stdout) && (!ostate || !ostate.blocker), `${r.status} ${r.stdout.slice(0, 200)}`);

// ---------- a question in a text part with no time.end is caught at idle ----------
const pRepo = makeRepo('openreply', ['decideopen:Should I use SQLite or Postgres for storage?+commit:1', 'ok']);
const pId = 'openreply--work';
r = run(pRepo, ['lane', pRepo, 'work', '--detach']);
check('open-reply lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
r = run(pRepo, ['wait', pId, '--timeout', '60', '--quiet']);
if (r.status === 11) r = run(pRepo, ['wait', pId, '--timeout', '60', '--quiet']);
const pstate = state(pRepo);
check('a builder question in a text part with no time.end is detected by the idle flush', !!pstate && pstate.blocker && pstate.blocker.kind === 'decision' && /SQLite/.test(pstate.blocker.text || ''), JSON.stringify(pstate && pstate.blocker));

// ---------- pure: numbered steps without an explicit "step N:" commit ----------
check('pure steps: an explicit step commit marks that step done', JSON.stringify(S.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'step 1: thing 1' }])) === '[2]');
check('pure steps: an unrelated wip commit does not complete a step', JSON.stringify(S.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'wip: scratch work' }])) === '[1,2]');
check('pure steps: every explicit step commit leaves nothing missing', S.uncommittedSteps([{ n: 1 }, { n: 2 }], [{ subject: 'step 1: a' }, { subject: 'step 2: b' }]).length === 0);
check('pure steps: a wip subject that mentions "step N" does not complete the step', JSON.stringify(S.uncommittedSteps([{ n: 1 }, { n: 2 }, { n: 3 }], [{ subject: 'wip: step 2 draft' }])) === '[1,2,3]');
check('pure steps: a revert subject that mentions "step N" does not complete the step', JSON.stringify(S.uncommittedSteps([{ n: 1 }, { n: 2 }, { n: 3 }], [{ subject: 'revert step 3' }])) === '[1,2,3]');

// ---------- early idle then completion end to end ----------
const sRepo = makeRepo('stepsdone', ['commit:1', 'commit:2'], 2);
const sId = 'stepsdone--work';
r = run(sRepo, ['lane', sRepo, 'work', '--detach']);
check('two-step lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
r = run(sRepo, ['wait', sId, '--timeout', '120', '--quiet']);
const sSubjects = subjects(sRepo);
check('an early idle after step 1 is continued and the lane finishes only after step 2', r.status === 0 && /CA_RESULT/.test(r.stdout) && sSubjects.some((x) => /^step 1\b/.test(x)) && sSubjects.some((x) => /^step 2\b/.test(x)), `${r.status} ${JSON.stringify(sSubjects)}`);
check('the continuation named the missing step 2', prompts(sRepo).some((p) => /Missing: step 2/.test(p.text)), JSON.stringify(prompts(sRepo).map((p) => p.text.slice(0, 90))));

// ---------- one step per idle turn, more steps than the continuation cap ----------
const fourRepo = makeRepo('steps4', ['commit:1', 'commit:2', 'commit:3', 'commit:4'], 4);
const fourId = 'steps4--work';
r = run(fourRepo, ['lane', fourRepo, 'work', '--detach']);
check('four-step lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
r = run(fourRepo, ['wait', fourId, '--timeout', '120', '--quiet']);
const fourSubjects = subjects(fourRepo);
check('a lane committing one step per idle turn finishes done, not needs review', r.status === 0 && /"result":"done"/.test(r.stdout) && [1, 2, 3, 4].every((n) => fourSubjects.some((x) => new RegExp(`^step ${n}\\b`).test(x))), `${r.status} ${r.stdout.slice(0, 300)} ${JSON.stringify(fourSubjects)}`);

// ---------- exhausted continuation end to end ----------
const tRepo = makeRepo('stepsstuck', ['commit:1', 'ok', 'ok'], 2);
const tId = 'stepsstuck--work';
r = run(tRepo, ['lane', tRepo, 'work', '--detach'], 120000, { STEP_CONTINUES: '1' });
check('stuck two-step lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
r = run(tRepo, ['wait', tId, '--timeout', '120', '--quiet'], 120000, { STEP_CONTINUES: '1' });
const tSubjects = subjects(tRepo);
check('an exhausted continuation ends as needs review (exit 4), not done', r.status === 4 && /"result":"needs review"/.test(r.stdout) && tSubjects.some((x) => /^step 1\b/.test(x)) && !tSubjects.some((x) => /^step 2\b/.test(x)), `${r.status} ${r.stdout.slice(0, 300)} ${JSON.stringify(tSubjects)}`);
const trow = row(tRepo, tId);
check('the incomplete lane lands in the attention bucket with the missing-step reason', !!trow && trow.status?.attention === true && trow.bucket === 'attention' && /step 2/.test(trow.reason || ''), JSON.stringify(trow && { attention: trow.status && trow.status.attention, bucket: trow.bucket, reason: trow.reason }));
check('the runner did not manufacture a step 2 commit', !tSubjects.some((x) => /^step 2\b/.test(x)), JSON.stringify(tSubjects));

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
