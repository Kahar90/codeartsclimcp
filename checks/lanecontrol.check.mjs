// Contract check: lane control commands never guess their lane, and a lane never controls itself.
// (A worker smoke-testing `ca stop` with no argument once stopped its own lane: findLane picked
// "the only running lane".) stop, rm, kick, resume, ack and steer need an explicit lane; with
// CA_IN_LANE set (the supervisor sets it for its server and worker) they refuse that same lane.
// Read-only commands (tail, summary) keep the single-running-lane shortcut.
// Fake lanes in a private registry: no CodeArts server, no paid model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lanecontrol-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1' };
delete env.CA_IN_LANE;

// One "running" lane: its supervisor pid is this check's own process, so it reads as alive.
const repo = path.join(tmp, 'app'); const dir = path.join(repo, 'tasks', 'work.lane'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), '1. Do it. Commit.\n');
const id = 'app--work';
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, task: 'work', repo, pid: process.pid, phase: 'build', busy: true, startedAt: Date.now(), lastEventAt: Date.now(), steps: 1, commits: 0 }));
fs.writeFileSync(path.join(dir, 'live.log'), '10:00:00 lane started\n');
fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo, task: 'work' }));
const run = (args, extra = {}) => spawnSync(process.execPath, [CA, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000, cwd: repo });
const stopFile = path.join(dir, 'STOP');
const inbox = path.join(dir, 'inbox');
const inboxCount = () => { try { return fs.readdirSync(inbox).length; } catch { return 0; } };

let r = run(['stop']);
check('ca stop with no lane is a usage error (exit 2) and stops nothing', r.status === 2 && /usage: ca stop <lane>/.test(r.stderr) && !fs.existsSync(stopFile), `${r.status} ${r.stderr.slice(0, 120)}`);
r = run(['rm']);
check('ca rm with no lane is a usage error and removes nothing', r.status === 2 && fs.existsSync(path.join(reg, `${id}.json`)), `${r.status} ${r.stderr.slice(0, 120)}`);
for (const [verb, args] of [['stop', ['stop', id]], ['steer', ['steer', id, 'hello']], ['kick', ['kick', id]], ['rm', ['rm', id]], ['ack', ['ack', id]], ['resume', ['resume', id]]]) {
  r = run(args, { CA_IN_LANE: id });
  check(`inside the lane, ca ${verb} on that same lane is refused (exit 2)`, r.status === 2 && /cannot .* itself/.test(r.stderr), `${r.status} ${r.stderr.slice(0, 160)}`);
}
check('the refused commands changed nothing (no STOP file, no inbox message, still registered)', !fs.existsSync(stopFile) && inboxCount() === 0 && fs.existsSync(path.join(reg, `${id}.json`)));
r = run(['tail', '-n', '1']);
check('read-only ca tail still picks the only running lane', r.status === 0 && /lane started/.test(r.stdout), `${r.status} ${(r.stdout + r.stderr).slice(0, 160)}`);
r = run(['steer', id, 'hello'], { CA_IN_LANE: 'other--lane' });
check('a lane may still steer a different lane (CA_IN_LANE only guards itself)', r.status === 0 && inboxCount() === 1, `${r.status} ${r.stderr.slice(0, 160)}`);
r = run(['stop', id]);
check('the lead stops the lane by name (exit 0, STOP file written)', r.status === 0 && fs.existsSync(stopFile), `${r.status} ${r.stderr.slice(0, 160)}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
