// Contract check: a finished CHECK whose wrapper (the worker's bash tool that invokes this lane's
// helper, e.g. `node tasks/<task>.lane/check.mjs 1 | tail -30`) stays active must reach the lead as a
// `check-wrapper` blocker within ~25 s, instead of hiding behind "Running" until the lane ends or the
// tool watchdog fires. The same suite proves the alert stays quiet for a live (long) CHECK and for a
// wrapper that exits on its own, that an ack mutes the same incident until new activity, and that a
// `ca wait` timeout renders the freshly read build/tool state rather than the starting snapshot.
// End to end against the fake CodeArts server: a private registry, no real CodeArts, no paid model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-helperlag-')));
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const makeChk = () => { const list = []; const chk = (name, ok, info = '') => list.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`); return { list, chk }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(tmp, 'registry'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'settings.json'), '{"security":{"trustedFolders":[]}}');
const env = { ...process.env, CA_REGISTRY: path.join(tmp, 'registry'), CA_SETTINGS: path.join(tmp, 'settings.json'), CA_DASH: '0', CA_NO_UPDATE_CHECK: '1',
  CODEARTS_EXE: process.execPath, CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', NO_REVIEW: '1', STEP_REVIEW: '0',
  STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '600', NO_COMMIT_S: '600' };

// The shared fake is injected, never edited: a wrapper tool is emitted when the `run` verb invokes the
// lane helper. `stuck` keeps it active forever (the observed stall); `exits` completes it after 5 s.
const BASE = fs.readFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), 'utf8');
const WRAP_CMD = 'x'.repeat(260) + ' node tasks/work.lane/check.mjs 1 | tail -30';
const inject = (after) => BASE.replace("else if (verb === 'run') {", `else if (verb === 'run') { ${after}`);
const fakeStuck = () => inject(`emit('message.part.updated',{part:{id:'helperpart',sessionID:sid,messageID:'helpermsg',type:'tool',callID:'helperstuck',tool:'bash',state:{status:'running',input:{command:'${WRAP_CMD}'}}}});`);
const fakeExits = () => inject(`const wc='node tasks/work.lane/check.mjs 1'; emit('message.part.updated',{part:{id:'wrapok',sessionID:sid,messageID:'wrapm',type:'tool',callID:'wrap-ok',tool:'bash',state:{status:'running',input:{command:wc}}}}); later(sid,5000,()=>emit('message.part.updated',{part:{id:'wrapok',sessionID:sid,messageID:'wrapm',type:'tool',callID:'wrap-ok',tool:'bash',state:{status:'completed',input:{command:wc},output:'ok'}}}));`);

function makeRepo(name, fake, script, brief, files = {}) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'serve'), fake);
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), c);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-qm', 'fixture');
  return repo;
}
const ca = (cwd, args, ms = 45000) => run(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), ...args], { cwd, env, timeout: ms });
const stateOf = (repo) => { try { return JSON.parse(fs.readFileSync(path.join(repo, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const row = async (repo, id) => { const r = await ca(repo, ['status', '--json', '--all'], 30000); try { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j : j.lanes || []).find((x) => x.id === id) || null; } catch { return null; } };
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await sleep(500); } };
const stop = async (repo, id) => { await ca(repo, ['stop', id], 25000); await sleep(2500); };
const START_BRIEF = '1. Do work and commit.\nCHECK: node -e 0\n';

// ---- 1: a finished CHECK with a live wrapper surfaces within 25 s; an ack mutes that incident ----
async function scenStuck() {
  const { list, chk } = makeChk();
  const repo1 = makeRepo('stuck', fakeStuck(), ['run:1+wait:90000'], START_BRIEF);
  const id1 = 'stuck--work';
  let r = await ca(repo1, ['lane', repo1, 'work', '--detach']);
  chk('lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  chk('helper finishes before measuring alert latency', !!await until(() => stateOf(repo1)?.workerChecks?.some(c => c.code === 0), 30000));
  const t0 = Date.now();
  r = await ca(repo1, ['wait', id1, '--timeout', '25', '--quiet'], 40000);
  const waited = (Date.now() - t0) / 1000;
  const s1 = stateOf(repo1);
  chk('fixture really completed its helper check green', !!(s1 && (s1.workerChecks || []).some((c) => c.code === 0)), JSON.stringify(s1 && s1.workerChecks));
  chk('long-command wrapper stayed active after the check finished', !!s1?.tools?.some(t => String(t.input).startsWith('xxx')), JSON.stringify(s1?.tools));
  chk('finished CHECK with a live wrapper surfaces exit 11 with kind check-wrapper within 25 s', r.status === 11 && /"kind":"check-wrapper"/.test(r.stdout) && waited < 25, `exit ${r.status} after ${waited.toFixed(1)}s: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 200)}`);
  chk('ca wait prints a CA_BLOCKED line naming check-wrapper', /CA_BLOCKED/.test(r.stdout) && /check-wrapper/.test(r.stdout), r.stdout.slice(0, 200));
  const q = await row(repo1, id1);
  chk('status --json shows the check-wrapper blocker on the still-running lane', !!(q && !q.result && q.blocked && q.blocked.kind === 'check-wrapper' && /still running/.test(q.blocked.text || '')), JSON.stringify(q && q.blocked));
  r = await ca(repo1, ['ack', id1], 25000);
  chk('ca ack on the running blocked lane is accepted', r.status === 0, `${r.status} ${r.stdout.slice(0, 150)}`);
  const cleared = await until(async () => { const x = await row(repo1, id1); return x && !x.blocked ? x : null; }, 10000);
  chk('the acked check-wrapper blocker is cleared while the lane keeps running', !!cleared && !cleared.result, JSON.stringify((await row(repo1, id1))?.blocked));
  r = await ca(repo1, ['wait', id1, '--timeout', '8', '--quiet'], 20000);
  chk('after the ack the same incident is muted: wait times out (124) instead of re-raising', r.status === 124 && !/check-wrapper/.test(r.stdout), `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  await stop(repo1, id1);
  return list;
}

// ---- 2: a live long CHECK raises nothing early (the helper is genuinely running) ----
async function scenSlow() {
  const { list, chk } = makeChk();
  const repo2 = makeRepo('slow', fakeStuck(), ['run:1+wait:90000'], '1. Do work and commit.\nCHECK: node slow.js\n', { 'slow.js': 'const t=Date.now();while(Date.now()-t<20000);\n' });
  const id2 = 'slow--work';
  let r = await ca(repo2, ['lane', repo2, 'work', '--detach']);
  chk('long-CHECK lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  r = await ca(repo2, ['wait', id2, '--timeout', '8', '--quiet'], 20000);
  chk('no check-wrapper alert while a long CHECK is still running', r.status === 124 && !/check-wrapper/.test(r.stdout), `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  await stop(repo2, id2);
  return list;
}

// ---- 3: a wrapper that exits on its own raises nothing ----
async function scenNormal() {
  const { list, chk } = makeChk();
  const repo3 = makeRepo('normal', fakeExits(), ['run:1+wait:60000'], START_BRIEF);
  const id3 = 'normal--work';
  let r = await ca(repo3, ['lane', repo3, 'work', '--detach']);
  chk('normal-wrapper lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  r = await ca(repo3, ['wait', id3, '--timeout', '22', '--quiet'], 40000);
  const s3 = stateOf(repo3);
  chk('the normal-wrapper fixture ran the helper green', !!(s3 && (s3.workerChecks || []).some((c) => c.code === 0)), JSON.stringify(s3 && s3.workerChecks));
  chk('a wrapper that exits on its own raises no check-wrapper alert', r.status === 124 && !/check-wrapper/.test(r.stdout) && !(s3 && s3.blocker), `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  await stop(repo3, id3);
  return list;
}

// ---- 4: a wait timeout prints the freshest build/tool state, not the starting snapshot ----
async function scenLatest() {
  const { list, chk } = makeChk();
  const repo4 = makeRepo('latest', fakeStuck(), ['run:1+wait:90000'], START_BRIEF);
  const id4 = 'latest--work';
  let r = await ca(repo4, ['lane', repo4, 'work', '--detach']);
  chk('latest-state lane starts detached', r.status === 0, `${r.status} ${r.stderr.slice(0, 200)}`);
  r = await ca(repo4, ['wait', id4, '--timeout', '12'], 35000);
  const out = String(r.stdout || '');
  chk('a wait timeout renders the latest build/tool state, not "starting"', r.status === 124 && /build/i.test(out) && /running tool/.test(out), `exit ${r.status} out=${out.slice(0, 400)}`);
  await stop(repo4, id4);
  return list;
}

try {
  // The four end-to-end scenarios are independent (own repo, shared registry), so overlap them.
  const [s1L, s2L, s3L, s4L] = await pool(4, [scenStuck, scenSlow, scenNormal, scenLatest]);
  results.push(...s1L, ...s2L, ...s3L, ...s4L);
} finally {
  await sleep(1500);
  if (path.relative(os.tmpdir(), tmp).startsWith('ca-helperlag-')) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
