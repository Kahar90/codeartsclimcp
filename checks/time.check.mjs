// Contract check for plan time taken (fake lanes, never starts CodeArts): every plan carries a `time` object
// (total from plan start to close or now, split into lead planning / lanes running / lead between lanes /
// lead verifying, plus worker time per phase and per lane); lanes carry `time` too; `ca plan` stamps
// startedAt, `ca plan close` stamps closedAt; `ca plan list` prints the total.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-time-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const M = 60e3;

// A finished lane: state.json with phases and runs, registered in the private registry.
function fakeLane(repo, task, s) {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: 999999, phase: 'finished', result: 'done', exitCode: 0, commits: 1, steps: 1, stepList: [{ n: 1, text: 'a' }],
    commitLog: [{ hash: 'abc1234', subject: 'step 1: a' }], tokens: {}, gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'done', models: {}, ...s }));
  const id = `${path.basename(repo)}--${task}`;
  fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo, task }));
}

// Closed plan: start T, lane a +10..+40 (wait 1, build 19, checks 2, review 8), lane c +20..+35 (build 15, parallel
// with a), lane b +50..+60 paused then resumed +90..+100. Closed at +120.
const T = Date.now() - 6 * 3600e3;
const repo = path.join(tmp, 'tsbx'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
fakeLane(repo, 'a', { startedAt: T + 10 * M, runStartedAt: T + 10 * M, finishedAt: T + 40 * M, lastEventAt: T + 40 * M,
  phases: [{ phase: 'starting', at: T + 10 * M }, { phase: 'build', at: T + 11 * M }, { phase: 'gate', at: T + 30 * M }, { phase: 'review', at: T + 32 * M }] });
fakeLane(repo, 'c', { startedAt: T + 20 * M, runStartedAt: T + 20 * M, finishedAt: T + 35 * M, lastEventAt: T + 35 * M, phases: [{ phase: 'build', at: T + 20 * M }] });
fakeLane(repo, 'b', { startedAt: T + 50 * M, runStartedAt: T + 90 * M, finishedAt: T + 100 * M, lastEventAt: T + 100 * M,
  runs: [{ startedAt: T + 50 * M, finishedAt: T + 60 * M, result: 'paused', reason: 'LANE_TIMEOUT' }],
  phases: [{ phase: 'starting', at: T + 50 * M }, { phase: 'build', at: T + 51 * M }, { phase: 'starting', at: T + 90 * M }, { phase: 'build', at: T + 91 * M }, { phase: 'fix', at: T + 95 * M }, { phase: 'review', at: T + 98 * M }] });
const planFile = path.join(repo, 'tasks', 'plan.json');
const iso = (ms) => new Date(ms).toISOString();
fs.writeFileSync(planFile, JSON.stringify({ title: 'Time plan', status: 'running', startedAt: iso(T), waves: [{ name: 'W1', lanes: ['a', 'c'] }, { name: 'W2', lanes: ['b'] }],
  lanes: [{ task: 'a' }, { task: 'c' }, { task: 'b' }] }));
check('ca plan registers the closed-plan fixture', ca(['plan', planFile]).code === 0);
check('ca plan keeps a startedAt the lead wrote', JSON.parse(fs.readFileSync(planFile, 'utf8')).startedAt === iso(T));
fs.writeFileSync(planFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(planFile, 'utf8')), status: 'done', closedAt: iso(T + 120 * M) }));

// Open plan with a running lane (pid of this process is alive) and no startedAt: start falls back to the
// earliest decision, and `ca plan` writes it into the file.
const repo2 = path.join(tmp, 'tlive'); fs.mkdirSync(path.join(repo2, 'tasks'), { recursive: true });
const T2 = Date.now() - 30 * M;
fakeLane(repo2, 'run', { pid: process.pid, result: null, phase: 'build', exitCode: null, startedAt: T2 + 5 * M, runStartedAt: T2 + 5 * M, lastEventAt: Date.now(),
  phases: [{ phase: 'starting', at: T2 + 5 * M }, { phase: 'build', at: T2 + 6 * M }] });
const planFile2 = path.join(repo2, 'tasks', 'plan.json');
fs.writeFileSync(planFile2, JSON.stringify({ title: 'Live plan', status: 'running', decisions: [{ at: iso(T2 + 2 * M), text: 'later' }, { at: iso(T2), text: 'first' }], lanes: [{ task: 'run' }] }));
check('ca plan registers the live-plan fixture', ca(['plan', planFile2]).code === 0);
check('ca plan stamps a missing startedAt from the earliest decision', JSON.parse(fs.readFileSync(planFile2, 'utf8')).startedAt === iso(T2), JSON.parse(fs.readFileSync(planFile2, 'utf8')).startedAt);

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env });
const get = async (p) => { for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (r.ok) return await r.json(); } catch {} await new Promise((r) => setTimeout(r, 250)); } return null; };
try {
  const plans = await get('/api/plans') || [];
  const p1 = plans.find((p) => p.title === 'Time plan'); const t1 = p1 && p1.time;
  check('closed plan has a time object', !!t1, JSON.stringify(p1 && Object.keys(p1)));
  if (t1) {
    const near = (a, b) => Math.abs(a - b) < 1000;
    check('closed plan: startedAt, endedAt, not live', t1.startedAt === T && t1.endedAt === T + 120 * M && t1.live === false, JSON.stringify({ s: t1.startedAt - T, e: t1.endedAt - T, live: t1.live }));
    check('closed plan: total 120 min', near(t1.totalMs, 120 * M), t1.totalMs / M);
    const seg = Object.fromEntries((t1.segments || []).map((s) => [s.key, s.ms]));
    check('segments in order planning, lanes, between, verify', (t1.segments || []).map((s) => s.key).join(',') === 'planning,lanes,between,verify' && t1.segments.every((s) => typeof s.label === 'string' && s.label), JSON.stringify(t1.segments));
    check('planning 10, lanes 50 (union, paused gap excluded), between 40, verify 20', near(seg.planning, 10 * M) && near(seg.lanes, 50 * M) && near(seg.between, 40 * M) && near(seg.verify, 20 * M), JSON.stringify(Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, v / M]))));
    const bp = (t1.work && t1.work.byPhase) || {};
    check('worker time by phase: wait 3, build 47, checks 2, fix 3, review 10', near(bp.wait, 3 * M) && near(bp.build, 47 * M) && near(bp.checks, 2 * M) && near(bp.fix, 3 * M) && near(bp.review, 10 * M), JSON.stringify(Object.fromEntries(Object.entries(bp).map(([k, v]) => [k, v / M]))));
    check('worker total 65 min (parallel lanes add up)', near(t1.work.totalMs, 65 * M), t1.work && t1.work.totalMs / M);
    const lt = Object.fromEntries((t1.lanes || []).map((l) => [l.task, l.ms]));
    check('per lane: a 30, c 15, b 20 (two runs)', near(lt.a, 30 * M) && near(lt.c, 15 * M) && near(lt.b, 20 * M), JSON.stringify(t1.lanes));
    const la = p1.waves.flatMap((w) => w.lanes).find((l) => l.task === 'b');
    check('lane view carries time {ms, byPhase}', la && la.time && near(la.time.ms, 20 * M) && near(la.time.byPhase.build, 13 * M), JSON.stringify(la && la.time));
  }
  const p2 = plans.find((p) => p.title === 'Live plan'); const t2 = p2 && p2.time;
  check('live plan: live, no endedAt, total = now - start', t2 && t2.live === true && t2.endedAt == null && Math.abs(t2.totalMs - (Date.now() - T2)) < 20000, JSON.stringify(t2 && { live: t2.live, endedAt: t2.endedAt, tot: t2.totalMs / M }));
  check('live plan: planning 5 min, a running lane counts up to now', t2 && Math.abs(t2.segments[0].ms - 5 * M) < 1000 && Math.abs(t2.segments[1].ms - (Date.now() - T2 - 5 * M)) < 20000 && t2.segments[3].ms < 20000, JSON.stringify(t2 && t2.segments));
  const lanes = await get('/api/lanes');
  const arr = Array.isArray(lanes) ? lanes : (lanes && lanes.lanes) || [];
  const lb = arr.find((l) => l.task === 'b');
  check('/api/lanes rows carry time', lb && lb.time && Math.abs(lb.time.ms - 20 * M) < 1000, JSON.stringify(lb && lb.time));
} finally { try { dash.kill(); } catch {} }

// Finish the live lane, then close its plan: close must stamp closedAt.
const st = path.join(repo2, 'tasks', 'run.lane', 'state.json');
fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, 'utf8')), pid: 999999, result: 'done', phase: 'finished', finishedAt: Date.now() }));
const o = ca(['plan', 'close', 'tlive', '--reason', 'done for the check']);
const closedAt = JSON.parse(fs.readFileSync(planFile2, 'utf8')).closedAt;
check('ca plan close stamps closedAt', o.code === 0 && typeof closedAt === 'string' && Math.abs(new Date(closedAt).getTime() - Date.now()) < 60000, o.out + o.err + ' closedAt=' + closedAt);
const list = ca(['plan', 'list']).out;
check('ca plan list prints the time taken', /Time plan[\s\S]*?\b2h 0m\b/.test(list), list.trim());

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
