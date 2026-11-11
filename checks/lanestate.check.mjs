// Contract check for the explicit lane state machine (runner/lanestate.mjs), stage 1:
// declared phases and transitions, a structured end { result, cause, detail } instead of regexes on
// free text, one decision for the final result and exit code, one atomic terminal writer, and the
// status contract rule that `attention` is true for exactly the lanes in the Needs you bucket.
// Pure module calls plus one fake DEAD lane through `ca stop`; never starts CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lanestate-'));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const imp = async (f) => { try { return await import(pathToFileURL(path.join(ROOT, 'runner', f)).href); } catch (e) { check(`runner/${f} loads`, false, e.message); return null; } };
const J = (v) => JSON.stringify(v);

const LS = await imp('lanestate.mjs');
const C = await imp('controls.mjs');

// ---------- declared machine ----------
if (LS) {
  check('exports PHASES, RESULTS, CAUSES', Array.isArray(LS.PHASES) && Array.isArray(LS.RESULTS) && Array.isArray(LS.CAUSES));
  for (const p of ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart', 'finished']) check(`phase ${p} is declared`, (LS.PHASES || []).includes(p));
  for (const r of ['done', 'needs review', 'unverified', 'checks failing', 'paused', 'stopped', 'failed', 'killed']) check(`result ${r} is declared`, (LS.RESULTS || []).includes(r));
  for (const c of ['ok', 'review', 'checks', 'infra', 'timeout', 'lead-stop', 'supervisor-died', 'repo-gone', 'auth', 'not-writable', 'runner-error']) check(`cause ${c} is declared`, (LS.CAUSES || []).includes(c));
  const T = LS.canTransition || (() => null);
  check('starting -> build is legal', T('starting', 'build') === true);
  check('build -> gate -> fix -> gate is legal', T('build', 'gate') === true && T('gate', 'fix') === true && T('fix', 'gate') === true);
  check('gate -> review -> finished is legal', T('gate', 'review') === true && T('review', 'finished') === true);
  check('build -> backoff -> build is legal', T('build', 'backoff') === true && T('backoff', 'build') === true);
  check('every live phase may finish', ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart'].every((p) => T(p, 'finished') === true));
  check('finished is terminal', ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart'].every((p) => T('finished', p) === false));
  check('an unknown phase is illegal', T('build', 'dancing') === false);

  // ---------- one decision for the final result ----------
  const D = LS.decideEnd || (() => ({}));
  const de = (o, result, exitCode, cause) => { const r = D(o) || {}; check(`decideEnd ${J(o)} -> ${result}/${exitCode}/${cause}`, r.result === result && r.exitCode === exitCode && r.cause === cause, J(r)); };
  de({ exitCode: 0 }, 'done', 0, 'ok');
  de({ exitCode: 0, verdict: 'ready' }, 'done', 0, 'ok');
  de({ exitCode: 0, verdict: 'needs fixes' }, 'needs review', 4, 'review');
  de({ exitCode: 0, verdict: 'needs fixes', noReview: true }, 'done', 0, 'ok');
  de({ exitCode: 4, forcedResult: 'unverified', reason: 'npm not found' }, 'unverified', 4, 'infra');
  de({ exitCode: 4, forcedResult: 'unverified', verdict: 'needs fixes' }, 'needs review', 4, 'review');
  de({ exitCode: 1, reason: 'stopped' }, 'stopped', 1, 'lead-stop');
  de({ exitCode: 1, reason: 'timeout' }, 'paused', 5, 'timeout');
  de({ exitCode: 3, reason: 'auth' }, 'failed', 3, 'auth');
  de({ exitCode: 1, reason: 'runner error: Cannot find module ./authsignal.mjs' }, 'failed', 1, 'runner-error');
  de({ exitCode: 1, forcedResult: 'checks failing', reason: 'a check still fails' }, 'checks failing', 1, 'checks');
  de({ exitCode: 1, reason: 'repo not writable: tasks: EPERM' }, 'failed', 1, 'not-writable');
  de({ exitCode: 4, forcedResult: 'needs review', reason: 'the reviewed commit is no longer HEAD' }, 'needs review', 4, 'review');

  // ---------- endOf: structured end first, legacy rules in one place ----------
  const E = LS.endOf || (() => undefined);
  const eo = (name, s, result, cause) => { const r = E(s) || {}; check(`endOf ${name} -> ${result}/${cause}`, r.result === result && r.cause === cause, J(r)); };
  check('endOf a running lane is null', E({ phase: 'build', result: null }) === null);
  eo('explicit end wins', { result: 'failed', reason: 'auth', end: { result: 'failed', cause: 'runner-error', detail: 'x' } }, 'failed', 'runner-error');
  eo('legacy timeout', { result: 'failed', reason: 'timeout', exitCode: 1 }, 'paused', 'timeout');
  eo('legacy auth', { result: 'failed', reason: 'auth', exitCode: 3 }, 'failed', 'auth');
  eo('legacy runner error mentioning auth', { result: 'failed', reason: 'runner error: Cannot find module ./authsignal.mjs', exitCode: 1 }, 'failed', 'runner-error');
  eo('legacy failure mentioning an author', { result: 'failed', reason: 'gave up after 3 interruptions (author field)', exitCode: 1 }, 'failed', 'unknown');
  eo('legacy lead stop', { result: 'stopped', reason: 'stopped', exitCode: 1 }, 'stopped', 'lead-stop');
  eo('legacy dead supervisor stop', { result: 'stopped', activity: 'stopped (supervisor had died)' }, 'stopped', 'supervisor-died');
  eo('legacy repo deleted', { result: 'stopped', activity: 'repo deleted: stopping', exitCode: 1 }, 'stopped', 'repo-gone');
  eo('legacy gates still failing, real failure', { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'git clean', ok: true }, { gate: 'npm test', ok: false, code: 1 }] }, 'checks failing', 'checks');
  eo('legacy gates still failing, missing tool', { result: 'failed', reason: 'gates still failing', gates: [{ gate: 'npm test', ok: false, code: 127 }] }, 'unverified', 'infra');
  eo('done', { result: 'done', exitCode: 0 }, 'done', 'ok');
  eo('needs review', { result: 'needs review', exitCode: 4 }, 'needs review', 'review');

  // ---------- one atomic terminal writer ----------
  const dir = path.join(tmp, 'lane'); fs.mkdirSync(dir, { recursive: true });
  const F = LS.finishLaneFile || (() => false);
  const live = { id: 'x', pid: 999999, phase: 'build', busy: true, result: null, activity: 'tool bash', phases: [{ phase: 'build', at: 1 }] };
  fs.writeFileSync(path.join(dir, 'state.json'), J(live));
  const wrote = F(dir, live, { result: 'stopped', cause: 'supervisor-died', detail: 'the supervisor died' });
  let st = null; try { st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch {}
  check('finishLaneFile writes a parseable state.json', !!st && wrote !== false);
  check('finishLaneFile records the structured end', st && st.result === 'stopped' && st.end && st.end.cause === 'supervisor-died' && st.end.result === 'stopped', J(st && st.end));
  check('finishLaneFile closes the run', st && st.phase === 'finished' && st.busy === false && typeof st.finishedAt === 'number');
  check('finishLaneFile leaves no temp file', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), fs.readdirSync(dir).join(','));
  const doneS = { id: 'y', result: 'done', exitCode: 0, phase: 'finished', finishedAt: 123, activity: 'done', end: { result: 'done', cause: 'ok', detail: '' } };
  fs.writeFileSync(path.join(dir, 'state.json'), J(doneS));
  F(dir, doneS, { result: 'stopped', cause: 'supervisor-died', detail: 'late stop' });
  let st2 = null; try { st2 = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch {}
  check('finishLaneFile never rewrites a finished lane', st2 && st2.result === 'done' && st2.end.cause === 'ok' && st2.finishedAt === 123 && st2.activity === 'done', J(st2));
}

// ---------- labels come from the cause, never from a regex on free text ----------
if (C) {
  const O = (s, health = s.result || 'running') => C.laneOutcome({ s, health });
  const authLike = { result: 'failed', exitCode: 1, reason: 'runner error: Cannot find module ./authsignal.mjs', phase: 'finished' };
  check('a runner error mentioning auth is not "missing credentials"', !/credential|ca auth/i.test(O(authLike).reason), O(authLike).reason);
  check('laneActions does not send a runner error to ca auth', !/ca auth/i.test(C.laneActions({ s: authLike, alive: false, health: 'failed', canResume: true }).why || ''));
  check('laneBucket does not call a runner error missing credentials', !/credential|ca auth/i.test(C.laneBucket({ s: authLike, alive: false, health: 'failed' }).reason));
  check('a real auth end says ca auth', /ca auth/i.test(O({ result: 'failed', exitCode: 3, reason: 'x', end: { result: 'failed', cause: 'auth', detail: '' } }).reason));
  check('a dead supervisor stop is not "Stopped by lead"', O({ result: 'stopped', activity: 'stopped (supervisor had died)', end: { result: 'stopped', cause: 'supervisor-died', detail: '' } }).label !== 'Stopped by lead');
  check('a lead stop reads "Stopped by lead"', O({ result: 'stopped', reason: 'stopped', end: { result: 'stopped', cause: 'lead-stop', detail: '' } }).label === 'Stopped by lead');
  check('a legacy lead stop still reads "Stopped by lead"', O({ result: 'stopped', reason: 'stopped' }).label === 'Stopped by lead');

  // ---------- status contract: attention <=> Needs you bucket ----------
  const now = Date.now();
  const fx = [
    ['running', { phase: 'build', busy: true, activity: 'tool bash' }, true, 'running'],
    ['running tool', { phase: 'build', busy: true, tools: [1] }, true, 'running tool'],
    ['quiet', { phase: 'review', busy: true, lastEventAt: now - 120000 }, true, 'quiet'],
    ['stalled', { phase: 'build', busy: true, lastEventAt: now - 600000 }, true, 'STALLED'],
    ['no tool call', { phase: 'build', busy: true }, true, 'thinking (12m, no tool call)'],
    ['worker question', { phase: 'build', busy: true, blocker: { kind: 'question', text: 'which file?', at: now } }, true, 'running'],
    ['no progress', { phase: 'fix', busy: true, blocker: { kind: 'no-progress', text: 'no commit for 15m', at: now } }, true, 'running'],
    ['backoff', { phase: 'backoff' }, true, 'running'],
    ['DEAD', { phase: 'build', busy: true }, false, 'DEAD (ca stop cleans up)'],
    ['done', { result: 'done', phase: 'finished', exitCode: 0 }, false, 'done'],
    ['paused', { result: 'paused', phase: 'finished', exitCode: 5 }, false, 'paused'],
    ['needs review', { result: 'needs review', phase: 'finished', exitCode: 4 }, false, 'needs review'],
    ['unverified', { result: 'unverified', phase: 'finished', exitCode: 4 }, false, 'unverified'],
    ['checks failing', { result: 'checks failing', phase: 'finished', exitCode: 1 }, false, 'checks failing'],
    ['failed', { result: 'failed', reason: 'gave up', phase: 'finished', exitCode: 1 }, false, 'failed'],
    ['stopped', { result: 'stopped', reason: 'stopped', phase: 'finished', exitCode: 1 }, false, 'stopped'],
    ['killed', { result: 'killed', phase: 'finished' }, false, 'killed'],
  ];
  for (const [name, s, alive, health] of fx) {
    const o = C.laneOutcome({ s, health });
    const b = C.laneBucket({ s, alive, health });
    check(`attention matches the Needs you bucket: ${name}`, o.attention === (b.bucket === 'attention'), `attention ${o.attention}, bucket ${b.bucket}`);
    if (o.attention) check(`an attention lane shows ! or x: ${name}`, o.glyph === '!' || o.glyph === '✕', o.glyph);
  }
  const q = C.laneOutcome({ s: fx[5][1], health: 'running' });
  check('a worker question is not labelled plain Running', q.label !== 'Running', q.label);
}

// ---------- the writers use the machine ----------
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, 'runner', f), 'utf8'); } catch { return ''; } };
const lane = src('lane.mjs'), cmds = src('commands.mjs'), ctl = src('controls.mjs');
check('lane.mjs imports lanestate.mjs', /from '\.\/lanestate\.mjs'/.test(lane));
check('lane.mjs decides the end with decideEnd', /decideEnd\(/.test(lane));
check('lane.mjs records the structured end', /S\.end\s*=/.test(lane) || /finishState\(S/.test(lane));
check('lane.mjs checks phase transitions', /canTransition\(/.test(lane));
check('commands.mjs never writes state.json with a plain writeFileSync', !/writeFileSync\(path\.join\(l\.dir, 'state\.json'\)/.test(cmds));
check('commands.mjs finishes DEAD lanes through finishLaneFile', (cmds.match(/finishLaneFile\(/g) || []).length >= 2);
check('controls.mjs reads no credentials from a reason regex', !/\/auth\/i\.test\(/.test(ctl));
check('controls.mjs reads no lead stop from a reason regex', !/\/stopped\/i\.test\(/.test(ctl));

// ---------- integration: ca stop on a DEAD lane ----------
{
  const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
  const repo = path.join(tmp, 'repo'); const ldir = path.join(repo, 'tasks', 'dead.lane'); fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', 'dead.md'), '1. a. Commit.\n');
  const id = 'repo--dead';
  fs.writeFileSync(path.join(ldir, 'state.json'), J({ id, task: 'dead', repo, dir: ldir, pid: 999999, startedAt: Date.now() - 60000, phase: 'build', busy: true, result: null, activity: 'tool bash', commitLog: [], gates: [], phases: [] }));
  fs.writeFileSync(path.join(reg, `${id}.json`), J({ id, dir: ldir, repo, task: 'dead' }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'stop', id], { encoding: 'utf8', env: { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' }, windowsHide: true });
  let s = null; try { s = JSON.parse(fs.readFileSync(path.join(ldir, 'state.json'), 'utf8')); } catch {}
  check('ca stop on a DEAD lane exits 0', r.status === 0, (r.stderr || r.stdout || '').slice(0, 200));
  check('ca stop on a DEAD lane records cause supervisor-died', s && s.result === 'stopped' && s.end && s.end.cause === 'supervisor-died', J(s && s.end));
  if (C && s) check('ca stop on a DEAD lane is not labelled "Stopped by lead"', C.laneOutcome({ s, health: 'stopped' }).label !== 'Stopped by lead');
}

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exitCode = bad ? 1 : 0;
