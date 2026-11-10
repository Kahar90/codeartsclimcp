// Contract check for the per-lane core tool profile selection. It proves that `ca init` writes the
// opt-in TOOL_PROFILE header, that a core brief produces the real prompt denies, that an explicit
// environment value (including an empty one) overrides the brief, that legacy briefs keep the old
// full behaviour, and that the choice never leaks across lanes or into the environment or global
// config. The pure parts drive the selector and Server directly against a mocked fetch; the last part
// runs a real lane against the shared fake CodeArts server, whose /experimental/tool/ids route backs
// the documented private-server API.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../runner/toolprofile.mjs';
import { Server } from '../runner/server.mjs';
import { runnerSource } from './lib/runner-src.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ---- 1. the pure selector: brief header, environment override, legacy default, rejects unknown ----
check('selectToolProfile exists', typeof T.selectToolProfile === 'function');
check('a core header selects core', T.selectToolProfile('Goal\nTOOL_PROFILE: core\n1. Work', undefined) === 'core');
check('a full header selects full', T.selectToolProfile('TOOL_PROFILE: full', undefined) === 'full' && T.selectToolProfile('TOOL_PROFILE: FULL', undefined) === 'full');
check('a legacy brief with no header keeps full', T.selectToolProfile('Goal without header', undefined) === 'full');
check('an explicit environment value overrides the brief', T.selectToolProfile('TOOL_PROFILE: core', 'full') === 'full' && T.selectToolProfile('TOOL_PROFILE: full', 'core') === 'core');
check('an explicit empty environment retains full compatibility', T.selectToolProfile('TOOL_PROFILE: core', '') === 'full');
check('an unknown brief header is rejected visibly', throws(() => T.selectToolProfile('TOOL_PROFILE: bogus', undefined)));
check('an unknown environment value is rejected visibly', throws(() => T.selectToolProfile('Goal', 'bogus')));

// ---- 2. ca_init writes the opt-in header to newly scaffolded coding briefs ----
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-briefprofile-')));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const init = spawnSync(process.execPath, [CA, 'init', repo, 'work', '--goal', 'select the core profile'], { cwd: repo, encoding: 'utf8' });
const genFile = path.join(repo, 'tasks', 'work.md');
const generated = fs.existsSync(genFile) ? fs.readFileSync(genFile, 'utf8') : '';
check('ca init succeeds and writes the brief', init.status === 0 && !!generated, (init.stdout || '') + (init.stderr || ''));
check('the generated brief carries the opt-in TOOL_PROFILE header', /^\s*TOOL_PROFILE:\s*core\b/m.test(generated));
check('a freshly scaffolded coding brief selects core', T.selectToolProfile(generated, undefined) === 'core');
check('CA_TOOL_PROFILE=full overrides the generated brief', T.selectToolProfile(generated, 'full') === 'full');

// ---- 3. a core brief produces the real prompt denies (mocked fetch, Server a lane builds) ----
const ORIGINAL_FETCH = globalThis.fetch;
const DEFAULT_IDS = ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'question', 'task', 'skill', 'webfetch'];
const mock = () => {
  const calls = { ids: 0, requests: [] };
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (u.endsWith('/experimental/tool/ids')) { calls.ids++; return new Response(JSON.stringify(DEFAULT_IDS)); }
    calls.requests.push({ url: u, method: o.method, body: o.body ? JSON.parse(o.body) : undefined });
    return new Response('{}');
  };
  return calls;
};
const probe = (mode) => { const s = new Server('.', 'unused', mode); s.url = 'http://local-probe'; s.pw = 'test'; return s; };

try {
  const envBefore = process.env.CA_TOOL_PROFILE;
  const coreMode = T.selectToolProfile(generated, undefined);
  const s = probe(coreMode); const calls = mock();
  const body = { agent: 'plan', parts: [{ type: 'text', text: 'review' }] };
  const snapshot = JSON.stringify(body);
  try { await s.api('POST', '/session/abc/prompt_async', body); } finally { globalThis.fetch = ORIGINAL_FETCH; }
  const sent = (calls.requests[0] || {}).body || {};
  const tools = sent.tools || {};
  check('a core brief denies every unrelated tool id', ['task', 'skill', 'webfetch'].every((id) => tools[id] === false), JSON.stringify(tools));
  check('a core brief never adds or alters an inherited core id', T.CORE_TOOLS.every((id) => !Object.hasOwn(tools, id)), JSON.stringify(tools));
  check('a core brief fetches the tool ids once', calls.ids === 1, `ids ${calls.ids}`);
  check('the outgoing prompt keeps agent and parts and does not mutate the caller', sent.agent === 'plan' && JSON.stringify(body) === snapshot && !Object.hasOwn(body, 'tools'));
  check('selecting a profile does not change process.env.CA_TOOL_PROFILE', process.env.CA_TOOL_PROFILE === envBefore);
} catch (e) { globalThis.fetch = ORIGINAL_FETCH; check('core brief prompt denies', false, String((e && e.stack) || e)); }

// ---- 4. no cross-lane leakage: a full lane and a core lane are independent servers ----
try {
  const full = probe(T.selectToolProfile('Goal with no header', undefined));
  const core = probe(T.selectToolProfile('TOOL_PROFILE: core', undefined));
  const calls = mock();
  const fbody = { agent: 'plan', parts: [{ type: 'text', text: 'r' }] };
  const cbody = { agent: 'build', parts: [{ type: 'text', text: 'g' }] };
  try {
    await full.api('POST', '/session/f/prompt_async', fbody);
    await core.api('POST', '/session/c/prompt_async', cbody);
  } finally { globalThis.fetch = ORIGINAL_FETCH; }
  const f = (calls.requests[0] || {}).body || {}; const c = (calls.requests[1] || {}).body || {};
  check('the full lane still sends an unprofiled prompt (no tools field)', !Object.hasOwn(f, 'tools'));
  check('the core lane denies while the full lane does not', (c.tools || {}).task === false && !Object.hasOwn(f.tools || {}, 'task'));
  check('only the core lane fetched the tool ids (no cross-lane state)', calls.ids === 1, `ids ${calls.ids}`);
} catch (e) { globalThis.fetch = ORIGINAL_FETCH; check('no cross-lane leakage', false, String((e && e.stack) || e)); }

// ---- 5. nothing writes CA_TOOL_PROFILE into the environment, so a lane cannot leak it globally ----
check('no runner code assigns process.env.CA_TOOL_PROFILE', !/process\.env\.CA_TOOL_PROFILE\s*=/.test(runnerSource()));

// ---- 6. end to end: a real core-brief lane runs against the fake server's tool-ids route ----
try {
  const erepo = path.join(tmp, 'e2e'); fs.mkdirSync(path.join(erepo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(erepo, 'serve'));
  fs.writeFileSync(path.join(erepo, 'fake-script.json'), JSON.stringify(['commit:1']));
  fs.writeFileSync(path.join(erepo, '.gitignore'), 'fake-*.log\n');
  spawnSync('git', ['init', '-q'], { cwd: erepo });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: erepo });
  // Keep the real ca_init header (the opt-in) with a lane-ready body: the template's placeholder steps
  // and CHECK lines would be refused or would run literally.
  const header = (generated.match(/^\s*TOOL_PROFILE:.*$/m) || [])[0] || 'TOOL_PROFILE: core';
  fs.writeFileSync(path.join(erepo, 'tasks', 'work.md'), `You are working in a git repo (current directory).\n${header}\n1. Write out.txt. Commit.\nCHECK: node -e 0\n`);
  const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
  const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
  const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1', CODEARTS_CLI_AK: 'x', CODEARTS_CLI_SK: 'y', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240' };
  delete env.CA_TOOL_PROFILE; // the brief header alone must decide, so the run is deterministic
  const lane = spawnSync(process.execPath, [CA, 'lane', erepo, 'work'], { cwd: erepo, env, encoding: 'utf8', timeout: 180000 });
  let state = null; try { state = JSON.parse(fs.readFileSync(path.join(erepo, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch {}
  check('a core-brief lane finishes done against the private-server tool-ids route', lane.status === 0 && !!state && state.result === 'done', `exit ${lane.status} ${((lane.stdout || '') + (lane.stderr || '')).slice(-200)}`);
  check('the lane records the selected core mode in its state', !!state && state.toolProfile === 'core', state && String(state.toolProfile));
} catch (e) { check('end-to-end core lane', false, String((e && e.stack) || e)); }

try {
  const target = path.resolve(tmp), base = path.resolve(os.tmpdir()) + path.sep;
  if (target.startsWith(base)) fs.rmSync(target, { recursive: true, force: true });
} catch {}

console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
