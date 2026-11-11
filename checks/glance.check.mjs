// Contract check for the per-plan glance (runner/ca.mjs glanceOf): every rule of docs/contracts/glance.txt,
// plus ca note --phase asking accepted and an unknown phase refused. ca.mjs exposes nothing importable,
// so this drives the real CLI against temp plan.json and lane files in a temp CA registry, like
// checks/planstate.check.mjs does, and reads the glance off `ca plan list --json`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-glance-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

const t = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SL7 = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, text: `s${i + 1}` }));
const CL4 = Array.from({ length: 4 }, (_, i) => ({ hash: 'h' + (i + 1), subject: `step ${i + 1}: s${i + 1}` }));
const baseState = { steps: 1, commits: 0, stepList: [{ n: 1, text: 'x' }], commitLog: [], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], models: {} };
// One scenario repo: a plan file, the named lanes (each with a state.json and a registry entry),
// registered through the CLI. A task listed in plan.lanes with no lane folder reads as "planned".
function plan(name, body, lanes = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  for (const [task, st] of Object.entries(lanes)) {
    const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...baseState, ...st }));
    fs.writeFileSync(path.join(reg, `${name}--${task}.json`), JSON.stringify({ id: `${name}--${task}`, dir, repo, task }));
  }
  const pf = path.join(repo, 'tasks', 'plan.json'); fs.writeFileSync(pf, JSON.stringify(body));
  const r = ca(['plan', pf]);
  if (r.code !== 0) check(`plan ${name} registers`, false, r.out + r.err);
  return name;
}

// a. closed plan: done, failed, and the close reason.
plan('closed_done', { title: 't', status: 'done', waves: [{ name: 'W', lanes: ['a'] }], lanes: [{ task: 'a' }] },
  { a: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'done', exitCode: 0, activity: 'done' } });
plan('closed_failed', { title: 't', status: 'done', waves: [{ name: 'W', lanes: ['a'] }], lanes: [{ task: 'a' }] },
  { a: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'checks failing', exitCode: 1, activity: 'done' } });
plan('close_reason', { title: 't', status: 'done', now: 'Closed: demo placeholder', waves: [{ name: 'W', lanes: ['a'] }], lanes: [{ task: 'a' }] },
  { a: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'done', exitCode: 0, activity: 'done' } });
// b. lead phase asking.
plan('asking_plan', { title: 't', status: 'running', phase: 'asking', now: 'merge now or wait?', nowAt: iso(t - 30e3),
  leadActivity: [{ at: iso(t - 30e3), text: 'merge now or wait?' }], waves: [{ name: 'W', lanes: ['p'] }], lanes: [{ task: 'p' }] });
// c. lead phase done.
plan('lead_done', { title: 't', status: 'running', phase: 'done', leadActivity: [{ at: iso(t - 30e3), text: 'shipped' }],
  waves: [{ name: 'W', lanes: ['q'] }], lanes: [{ task: 'q' }] });
// d. a running lane, with step progress.
plan('running_plan', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['run', 'done1', 'plan1'] }], lanes: [{ task: 'run' }, { task: 'done1' }, { task: 'plan1' }] },
  { run: { pid: process.pid, startedAt: t - 5 * 60e3, lastEventAt: t, phase: 'build', busy: true, steps: 7, stepList: SL7, commitLog: CL4, commits: 4, activity: 'building' },
    done1: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'done', exitCode: 0, activity: 'done' } });
// e. a fresh lead phase.
plan('fresh_phase', { title: 't', status: 'running', phase: 'building', updatedAt: iso(t - 2 * 60e3), waves: [{ name: 'W', lanes: ['z'] }], lanes: [{ task: 'z' }] });
// f. an attention lane: needs-you, then failed.
plan('attn_you', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['st', 'pl'] }], lanes: [{ task: 'st' }, { task: 'pl' }] },
  { st: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'stopped', exitCode: 0, reason: 'stopped', activity: 'stopped by the lead' } });
plan('attn_failed', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['k', 'pl2'] }], lanes: [{ task: 'k' }, { task: 'pl2' }] },
  { k: { pid: 999999, startedAt: t - 2 * 3600e3, finishedAt: t - 3600e3, lastEventAt: t - 3600e3, phase: 'finished', result: 'killed', exitCode: 1, activity: 'killed' } });
// g. quiet: no timestamp, then a stale one.
plan('quiet_null', { title: 't', status: 'running', waves: [{ name: 'W', lanes: ['n'] }], lanes: [{ task: 'n' }] });
plan('quiet_age', { title: 't', status: 'running', updatedAt: iso(t - 20 * 60e3), waves: [{ name: 'W', lanes: ['m'] }], lanes: [{ task: 'm' }] });
// h. idle: nothing to look at.
plan('idle_plan', { title: 't', status: 'running', waves: [], lanes: [] });

const list = ca(['plan', 'list', '--json']);
let byId = {}; try { for (const p of JSON.parse(list.out)) byId[p.id] = p; } catch {}
const want = {
  closed_done: { state: 'done', word: 'Done', detail: 'All 1 lanes finished', at: true },
  closed_failed: { state: 'failed', word: 'Failed', detail: 'a failed: checks failing' },
  close_reason: { state: 'done', word: 'Done', detail: 'demo placeholder' },
  asking_plan: { state: 'needs-you', word: 'Needs you', detail: 'Claude is asking: merge now or wait?', at: true },
  lead_done: { state: 'done', word: 'Done', detail: 'shipped' },
  running_plan: { state: 'working', word: 'Working', detail: '1 of 3 lanes running, step 4/7' },
  fresh_phase: { state: 'working', word: 'Working', detail: 'Claude is building' },
  attn_you: { state: 'needs-you', word: 'Needs you', detail: 'st: Stopped by lead' },
  attn_failed: { state: 'failed', word: 'Failed', detail: 'k failed: killed' },
  quiet_null: { state: 'quiet', word: 'Check Claude', detail: 'No lead update yet; Claude may be waiting on you' },
  quiet_age: { state: 'quiet', word: 'Check Claude', detail: 'No lead update for 20m; Claude may be waiting on you' },
  idle_plan: { state: 'idle', word: 'Idle', detail: '' },
};
for (const [id, w] of Object.entries(want)) {
  const g = byId[id] && byId[id].glance;
  const ok = !!g && g.state === w.state && g.word === w.word && g.detail === w.detail && (w.at === undefined || (w.at ? typeof g.at === 'string' && !!g.at : g.at === null));
  check(`${id}: ${w.state} / ${w.word} / "${w.detail}"`, ok, JSON.stringify(g));
}
// Every glance carries exactly the four contract keys.
const keysOk = Object.values(byId).every((p) => p.glance && Object.keys(p.glance).sort().join(',') === 'at,detail,state,word');
check('every plan has glance {state, word, detail, at}', keysOk);

// ca note --phase asking is accepted; an unknown phase is refused.
check('ca note --phase asking accepted', ca(['note', '--plan', 'asking_plan', '--now', '--phase', 'asking', 'still asking']).code === 0);
check('ca note stored phase asking', (JSON.parse(fs.readFileSync(path.join(tmp, 'asking_plan', 'tasks', 'plan.json'), 'utf8')).phase === 'asking'));
check('ca note --phase bogus refused (exit 2)', ca(['note', '--plan', 'asking_plan', '--now', '--phase', 'bogus', 'nope']).code === 2);

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} failed` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
