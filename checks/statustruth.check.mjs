// Contract check for the shared status truth (docs/contracts/status.txt): every lane status carries
// attention/steps/glyph, an acked stopped lane reads "Handled by lead", a closed plan's lanes are not
// attention and its badge is the glance word, the close-reason prefixes are stripped, and the plan
// patch can come from a file or stdin. Unit-tests laneOutcome, then drives the real CLI against fake
// lane and plan files in a temp CA registry, like checks/planstate.check.mjs does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-statustruth-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args, opts = {}) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT, ...opts }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

// The glance glyphs (status contract part 1).
const W = '\u25CF', BANG = '!', X = '\u2715', CK = '\u2713', DASH = '\u2013';

// ---------- (a) pure module: every laneOutcome carries attention/steps/glyph ----------
let C = null;
try { C = await import(pathToFileURL(path.join(ROOT, 'runner', 'controls.mjs')).href); } catch (e) { check('runner/controls.mjs loads', false, e.message); }
if (C) {
  const lo = C.laneOutcome;
  const g = (gate, ok) => ({ gate, ok });
  const doneGates = [g('git clean', true), g('node --check runner/ca.mjs', true)];
  const cases = [
    ['running', { s: { phase: 'build' }, health: 'running tool' }, 'running', false, 'live', W],
    ['stalled', { s: { phase: 'build' }, health: 'STALLED' }, 'running', true, 'live', BANG],
    ['supervisor died', { s: { phase: 'build' }, health: 'DEAD (ca stop cleans up)' }, 'failed', true, 'hide', X],
    ['done', { s: { result: 'done', gates: [] }, progress: { done: 2, total: 2 } }, 'done', false, 'complete', CK],
    ['verified', { s: { result: 'done', gates: doneGates }, progress: { done: 2, total: 2 } }, 'verified', false, 'complete', CK],
    ['unverified', { s: { result: 'unverified', reason: 'x' } }, 'unverified', true, 'hide', BANG],
    ['checks failing', { s: { result: 'checks failing', reason: 'x' } }, 'checks failing', true, 'hide', X],
    ['needs review', { s: { result: 'needs review' } }, 'needs review', true, 'hide', BANG],
    ['paused', { s: { result: 'paused' } }, 'paused', true, 'hide', BANG],
    ['stopped', { s: { result: 'stopped' } }, 'stopped', false, 'hide', DASH],
    ['killed', { s: { result: 'killed' } }, 'killed', false, 'hide', X],
    ['continued', { s: { result: 'continued' } }, 'continued', false, 'hide', DASH],
    ['dropped', { s: { result: 'dropped' } }, 'dropped', false, 'hide', DASH],
    ['auth failed', { s: { result: 'failed', exitCode: 3, reason: 'auth' } }, 'failed', true, 'hide', X],
    ['handled done', { s: { result: 'done' }, handled: true, note: 'took it over' }, 'handled', false, 'hide', CK],
    ['merged', { s: { result: 'done' }, handled: true, note: 'merged by the lead', progress: { done: 2, total: 2 } }, 'handled', false, 'complete', CK],
    ['merged with open steps', { s: { result: 'done' }, handled: true, note: 'merged by the lead', progress: { done: 1, total: 3 } }, 'handled', false, 'partial', CK],
    ['stopped then handled', { s: { result: 'stopped' }, handled: true }, 'handled', false, 'hide', DASH],
    ['closed-plan checks failing', { s: { result: 'checks failing', reason: 'x' }, closed: true }, 'checks failing', false, 'hide', X],
  ];
  for (const [name, input, key, attention, steps, glyph] of cases) {
    const o = lo(input);
    const ok = o.key === key && o.attention === attention && o.steps === steps && o.glyph === glyph
      && typeof o.attention === 'boolean' && ['live', 'complete', 'partial', 'hide'].includes(o.steps);
    check(`laneOutcome ${name}: ${key} attention=${attention} steps=${steps} glyph=${glyph}`, ok, JSON.stringify(o));
  }
  check('acked lane reads "Handled by lead"', lo({ s: { result: 'done' }, handled: true, note: 'took it over' }).label === 'Handled by lead');
  check('acked lane with a merge note reads "Merged"', lo({ s: { result: 'done' }, handled: true, note: 'merged' }).label === 'Merged');
  check('a lead-stopped lane reads "Stopped by lead"', lo({ s: { result: 'stopped', reason: 'stopped', activity: 'stopped by the lead' } }).label === 'Stopped by lead');
}

// ---------- (b) fake lanes and plans through the real CLI ----------
const t = Date.now();
const lane = (repoName, task, st) => {
  const repo = path.join(tmp, repoName); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n2. b. Commit.\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, startedAt: t - 600000, finishedAt: t - 300000, lastEventAt: t - 300000, phase: 'finished',
    busy: false, exitCode: 0, commits: 1, steps: 2, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }], commitLog: [], tokens: {}, gates: [], steers: [], interruptions: [],
    permissions: [], outside: [], errors: [], activity: '', models: {}, ...st }));
  fs.writeFileSync(path.join(reg, `${repoName}--${task}.json`), JSON.stringify({ id: `${repoName}--${task}`, dir, repo, task }));
  return repo;
};
const plan = (repoName, body) => {
  const repo = path.join(tmp, repoName); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  const pf = path.join(repo, 'tasks', 'plan.json'); fs.writeFileSync(pf, JSON.stringify(body));
  const r = ca(['plan', pf]);
  if (r.code !== 0) check(`plan ${repoName} registers`, false, r.out + r.err);
  return pf;
};
const rowsOf = (out) => { try { return JSON.parse(out); } catch { return []; } };
const rowOf = (rows, id) => rows.find((x) => x.lane === id) || {};

// 1. ack of a stopped lane: before Stopped by lead, after Handled by lead with steps hide.
lane('sbx', 'stop1', { result: 'stopped', reason: 'stopped', activity: 'stopped by the lead' });
let rows = rowsOf(ca(['status', '--json', '--all']).out);
const before = rowOf(rows, 'sbx--stop1').status || {};
check('unacked stopped lane reads "Stopped by lead"', before.key === 'stopped' && before.label === 'Stopped by lead' && before.attention === false, JSON.stringify(before));
const ack = ca(['ack', 'sbx--stop1']);
check('ca ack on a stopped lane exits 0', ack.code === 0, ack.out + ack.err);
rows = rowsOf(ca(['status', '--json', '--all']).out);
const after = rowOf(rows, 'sbx--stop1').status || {};
check('acked stopped lane reads "Handled by lead" with steps partial', after.key === 'handled' && after.label === 'Handled by lead' && after.steps === 'partial' && after.attention === false, JSON.stringify(after));

// 1b. a done lane whose steps are open reports partial, never a forced complete.
lane('dp', 'open', { result: 'done', verdict: 'ready', steps: 3, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }], commitLog: [{ hash: 'h1', subject: 'step 1: a' }], commits: 1 });
const drow = rowOf(rowsOf(ca(['status', '--json', '--all']).out), 'dp--open').status || {};
check('a done lane with open steps reports steps partial, not complete', drow.key === 'done' && drow.steps === 'partial', JSON.stringify(drow));

// 2. a closed plan's lanes are never attention, and its badge is the glance word.
lane('cp', 'bad', { result: 'checks failing', reason: 'checks failing: x (exit 1)' });
lane('cp', 'ok', { result: 'done', gates: [{ gate: 'git clean', ok: true }, { gate: 'node --check a.mjs', ok: true }] });
plan('cp', { title: 'closed', status: 'done', now: '', waves: [{ name: 'W', lanes: ['bad', 'ok'] }], lanes: [{ task: 'bad' }, { task: 'ok' }] });
const plist = rowsOf(ca(['plan', 'list', '--json']).out);
const cp = plist.find((p) => p.id === 'cp') || {};
const cpLanes = (cp.waves || []).flatMap((w) => w.lanes || []);
check('closed plan: every ended lane has attention false', cpLanes.length > 0 && cpLanes.every((l) => l.status && l.status.attention === false), JSON.stringify(cpLanes.map((l) => l.status)));
check('closed plan: no lane sits in the attention bucket', cpLanes.every((l) => l.bucket !== 'attention'), JSON.stringify(cpLanes.map((l) => l.bucket)));
check('plan.badge.word equals the glance word', !!(cp.badge && cp.glance && cp.badge.word === cp.glance.word), `${JSON.stringify(cp.badge)} vs ${JSON.stringify(cp.glance)}`);
check('plan.badge tone and glyph match the glance state', !!(cp.badge && cp.badge.tone === 'bad' && cp.badge.glyph === X), JSON.stringify(cp.badge));
const srows = rowsOf(ca(['status', '--json', '--all']).out);
check('closed-plan lane bucket is not attention in ca status', rowOf(srows, 'cp--bad').bucket !== 'attention', String(rowOf(srows, 'cp--bad').bucket));

// 3. a closed plan's glance detail drops a leading "Closed:" or "Done:".
plan('cr', { title: 'cr', status: 'done', now: 'Closed: demo placeholder', waves: [{ name: 'W', lanes: ['a'] }], lanes: [{ task: 'a' }] });
plan('cd', { title: 'cd', status: 'done', now: 'Done: shipped', waves: [{ name: 'W', lanes: ['a'] }], lanes: [{ task: 'a' }] });
const byId = Object.fromEntries(rowsOf(ca(['plan', 'list', '--json']).out).map((p) => [p.id, p]));
check('closed plan strips a leading "Closed:"', byId.cr && byId.cr.glance && byId.cr.glance.detail === 'demo placeholder', JSON.stringify(byId.cr && byId.cr.glance));
check('closed plan strips a leading "Done:"', byId.cd && byId.cd.glance && byId.cd.glance.detail === 'shipped', JSON.stringify(byId.cd && byId.cd.glance));

// 4. ca plan update takes the patch from a file or stdin (PowerShell splits a JSON argument on spaces).
const ptFile = plan('pt', { title: 'pt', status: 'running', waves: [], lanes: [] });
const patchFile = path.join(tmp, 'patch1.json'); fs.writeFileSync(patchFile, JSON.stringify({ title: 'from file' }));
let r = ca(['plan', 'update', 'pt', '--patch-file', patchFile]);
check('ca plan update --patch-file exits 0', r.code === 0, r.out + r.err);
check('--patch-file applied to the plan', JSON.parse(fs.readFileSync(ptFile, 'utf8')).title === 'from file', fs.readFileSync(ptFile, 'utf8').slice(0, 120));
r = ca(['plan', 'update', 'pt', '--patch', '-'], { input: JSON.stringify({ goal: 'via stdin' }) });
check('ca plan update --patch - exits 0', r.code === 0, r.out + r.err);
check('--patch - applied to the plan', JSON.parse(fs.readFileSync(ptFile, 'utf8')).goal === 'via stdin', fs.readFileSync(ptFile, 'utf8').slice(0, 120));

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} failed` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
