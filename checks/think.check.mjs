// Contract check for the "thinking without doing" watchdog (no browser, never starts CodeArts):
// 1. runner/watchdog.mjs exports a pure decision function thinkStall(...).
// 2. `ca status --json` reports health "thinking (<age>, no tool call)" for a busy lane with no
//    tool call or answer text for THINK_S, using fake lanes in a private CA_REGISTRY.
// 3. runner/ca.mjs wires it in (abort + resume with a nudge) and documents THINK_S.
// 4. The dashboards colour "thinking" as a warning.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);

// ---- 1. pure decision function ----
let W = null; try { W = await import(pathToFileURL(path.join(ROOT, 'runner', 'watchdog.mjs')).href); } catch (e) { check('runner/watchdog.mjs loads', false, e.message); }
if (W) {
  check('watchdog.mjs exports thinkStall', typeof W.thinkStall === 'function');
  const T = 10_000_000, min = 60_000;
  const base = { busy: true, toolsRunning: 0, turnStartAt: T - 60 * min, lastToolAt: T - 20 * min, lastTextAt: 0, now: T, thinkS: 480 };
  const call = (o) => { try { return W.thinkStall({ ...base, ...o }); } catch (e) { return { error: String(e) }; } };
  let r = call({});
  check('busy, 20 min since the last tool call -> stall', r && r.stall === true, JSON.stringify(r));
  check('stall reports the age in ms', r && Math.abs(r.ageMs - 20 * min) < 1000, JSON.stringify(r));
  check('stall carries a nudge text for the resume', r && typeof r.nudge === 'string' && /tool|edit|check/i.test(r.nudge) && r.nudge.length < 600, r && r.nudge);
  check('nudge has no em dash', r && typeof r.nudge === 'string' && !r.nudge.includes('—'));
  check('recent tool call -> no stall', call({ lastToolAt: T - 2 * min }).stall === false);
  check('recent answer text counts as progress', call({ lastTextAt: T - 1 * min }).stall === false);
  check('a running tool is never a think stall', call({ toolsRunning: 1 }).stall === false);
  check('not busy -> no stall', call({ busy: false }).stall === false);
  check('turn just started (no tool yet) -> no stall', call({ turnStartAt: T - 3 * min, lastToolAt: 0 }).stall === false);
  check('turn started 9 min ago with no tool at all -> stall', call({ turnStartAt: T - 9 * min, lastToolAt: 0 }).stall === true);
  check('threshold respected (thinkS 1800, 20 min) -> no stall', call({ thinkS: 1800 }).stall === false);
  check('thinkS 0 disables the watchdog', call({ thinkS: 0 }).stall === false);
  check('progress age exported for status', typeof W.progressAge === 'function' && Math.abs(W.progressAge({ turnStartAt: T - 60 * min, lastToolAt: T - 5 * min, lastTextAt: T - 7 * min, now: T }) - 5 * min) < 1000);
}

// ---- 2. ca status health for fake running lanes ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-think-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
const now = Date.now();
const fake = (task, st) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: process.pid, startedAt: now - 3600e3, lastEventAt: now - 1000, phase: 'build', busy: true, tools: [], result: null,
    commits: 0, steps: 3, stepList: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }], commitLog: [], tokens: {}, steers: [], interruptions: [], activity: 'thinking',
    config: { stall: 240, toolStall: 900, think: 480 }, ...st }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
fake('ponder', { turnStartAt: now - 40 * 60e3, lastToolAt: now - 25 * 60e3, lastTextAt: 0 });
fake('busyok', { turnStartAt: now - 40 * 60e3, lastToolAt: now - 30e3, lastTextAt: 0 });
fake('tooling', { turnStartAt: now - 40 * 60e3, lastToolAt: now - 25 * 60e3, tools: [{ tool: 'bash', since: now - 60e3 }] });
fake('oldstate', {}); // a lane written by an older runner: no progress fields at all
const r = spawnSync(process.execPath, [CA, 'status', '--json'], { env, encoding: 'utf8', timeout: 60000 });
let rows = null; try { rows = JSON.parse(r.stdout); } catch {}
check('status --json parses', Array.isArray(rows), (r.stdout || r.stderr || '').slice(0, 160));
const row = (t) => (rows || []).find((x) => x.task === t) || {};
check('pondering lane shows "thinking (25m..., no tool call)"', /^thinking \(25m\S*, no tool call\)$/.test(row('ponder').health || ''), row('ponder').health);
check('lane with a recent tool call is running', row('busyok').health === 'running', row('busyok').health);
check('lane with a tool running is running tool', row('tooling').health === 'running tool', row('tooling').health);
check('old state without progress fields still works', ['running', 'quiet', 'STALLED'].includes(row('oldstate').health), row('oldstate').health);
const txt = spawnSync(process.execPath, [CA, 'status'], { env, encoding: 'utf8', timeout: 60000 }).stdout || '';
check('plain ca status shows the thinking health', /demo-repo--ponder\s+attention\s+thinking \(25m/.test(txt), txt.split('\n').find((l) => l.includes('ponder')));

// ---- 3. wiring in the runner ----
const src = runnerSource();
check('ca.mjs imports watchdog.mjs', /from ['"]\.\/watchdog\.mjs['"]/.test(src));
check('ca.mjs reads THINK_S with default 480', /THINK_S['"]\s*,\s*480/.test(src));
check('ca.mjs records the think stall as an interruption kind "think"', /kind:\s*['"]think['"]|['"]think['"]/.test(src) && /thinkStall\(/.test(src));
check('ca.mjs saves turnStartAt, lastToolAt and lastTextAt in state', ['turnStartAt', 'lastToolAt', 'lastTextAt'].every((k) => src.includes('S.' + k)));
const help = spawnSync(process.execPath, [CA, 'help'], { env, encoding: 'utf8', timeout: 30000 }).stdout || '';
check('ca help documents THINK_S', /THINK_S/.test(help));
check('watchdog.mjs is shipped by package.json', (() => { try { const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); return !p.files || p.files.some((f) => f === 'runner' || f.startsWith('runner/')); } catch { return false; } })());

// ---- 4. dashboards ----
const office = fs.readFileSync(path.join(ROOT, 'runner', 'office.html'), 'utf8');
check('office.html loads /assets/workshop.js', /<script src="\/assets\/workshop\.js">/.test(office));
const sandbox = {
  window: {},
  document: { hidden: true, addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  Image: function () {}, fetch: () => Promise.reject(new Error('offline')),
  performance: { now: () => 0 }, requestAnimationFrame: () => 0,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'runner', 'assets', 'workshop.js'), 'utf8'), sandbox, { filename: 'workshop.js' });
const thinking = sandbox.window.CAUI && sandbox.window.CAUI.status('thinking');
check('CAUI.status("thinking").key === "warn"', !!thinking && thinking.key === 'warn', thinking && thinking.key);
const dash = fs.readFileSync(path.join(ROOT, 'runner', 'dash.html'), 'utf8');
check('dash.html styles "thinking" as a warning', /thinking/.test(dash));
// Two real lanes (GLM 5.3 on big existing UI files) failed with 4 thinking stalls and 0 edits; flash finished both.
// Proven on a real lane 2026-11-07: THINK_S=60, 2 stalls, switched to flash, done.
check('repeated thinking stalls switch the builder to the fallback model', /thinkStalls >= 2/.test(src) && /FALLBACK_MODEL/.test(src) && /THINK_FALLBACK_MODEL/.test(src) && /buildModel = model/.test(src));
check('fix rounds and the summary use the switched model', /send\(sid, g\.message, buildModel\)/.test(src) && /model switch: /.test(src));

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
