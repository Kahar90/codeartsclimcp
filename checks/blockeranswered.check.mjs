// Contract check: ca wait never wakes the lead with a blocker the lead already answered. A ca steer
// queued after the blocker, or a ca ack (BLOCKER_ACK), is consumed by the supervisor on its next tick;
// until then state.json still carries the blocker, and a wait called right after the answer used to
// return exit 11 with that same blocker. Fake lane with a live pid; never starts CodeArts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-blockans-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
const repo = path.join(tmp, 'repo'); const dir = path.join(repo, 'tasks', 'b.lane'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, 'tasks', 'b.md'), '1. a. Commit.\n');
const id = 'repo--b'; const at = Date.now() - 5000;
const state = { id, task: 'b', repo, dir, pid: sleeper.pid, startedAt: at - 60000, lastEventAt: Date.now(), phase: 'build', busy: true, result: null, activity: 'x',
  blocker: { kind: 'question', text: 'which file?', at }, commitLog: [], stepList: [{ n: 1, text: 'a' }], gates: [], phases: [] };
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
fs.writeFileSync(path.join(reg, `${id}.json`), JSON.stringify({ id, dir, repo, task: 'b' }));
const wait = () => spawnSync(process.execPath, [CA, 'wait', id, '--json', '--timeout', '3'], { env, encoding: 'utf8', timeout: 30000 });

let r = wait();
check('an open blocker wakes the lead (exit 11)', r.status === 11 && /CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 160)}`);
fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
fs.writeFileSync(path.join(dir, 'inbox', `${at - 1000}-aaaaaa.txt`), 'an older steer');
r = wait();
check('a steer queued before the blocker does not answer it', r.status === 11, String(r.status));
fs.writeFileSync(path.join(dir, 'inbox', `${at + 1000}-stepreview.txt`), 'a step review finding');
r = wait();
check('a step-review notice does not answer it', r.status === 11, String(r.status));
fs.writeFileSync(path.join(dir, 'inbox', `${at + 2000}-bbbbbb.txt`), 'use src/db.mjs');
r = wait();
check('a lead steer queued after the blocker answers it: no exit 11', r.status === 124 && !/CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 160)}`);
fs.rmSync(path.join(dir, 'inbox'), { recursive: true, force: true });
r = wait();
check('the blocker is back once the steer is gone and it is still open', r.status === 11, String(r.status));
fs.writeFileSync(path.join(dir, 'BLOCKER_ACK'), String(Date.now()));
r = wait();
check('a pending ca ack answers it: no exit 11', r.status === 124 && !/CA_BLOCKED/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 160)}`);

try { sleeper.kill(); } catch {}
console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exitCode = bad ? 1 : 0;
