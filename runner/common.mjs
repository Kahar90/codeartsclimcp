import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { progressAge } from './watchdog.mjs';
import { readCreds } from './auth.mjs';
import { gitDirInsideRepo } from './controls.mjs';
import { lintBrief } from './brieflint.mjs';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.resolve(HERE, '..');
export const CA_HOME = path.join(os.homedir(), '.codeartsdoer');
// CodeArts settings.json (security.trustedFolders). CA_SETTINGS overrides the location for tests.
export const SETTINGS = process.env.CA_SETTINGS || path.join(CA_HOME, 'cli-data', 'settings.json');
export const EXE = process.env.CODEARTS_EXE || path.join(CA_HOME, 'installers', 'bin', process.platform === 'win32' ? 'codearts.exe' : 'codearts');
// Official CodeArts Agent CLI installer (also used by `ca onboard` to install it).
export const INSTALL_BASE = 'https://apsoutheast1-cloudide-marketplace.obs.ap-southeast-1.myhuaweicloud.com/codearts/cli_tui/install_script';
export const INSTALL_HINT = process.platform === 'win32'
  ? `PowerShell: irm ${INSTALL_BASE}/install.ps1 | iex   (or: ca onboard --yes)`
  : `curl -fsSL ${INSTALL_BASE}/install.sh | bash   (or: ca onboard --yes)`;
export const REG = process.env.CA_REGISTRY || path.join(CA_HOME, 'lanes');
export const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
export const HAS_MAAS = () => !!userEnv('MAAS_API_KEY');
export const CFG = {
  // Default: MaaS (flash builds, GLM 5.3 reviews). Without MAAS_API_KEY: CodeArts quota models.
  get build() { return process.env.BUILD_MODEL || (HAS_MAAS() ? 'maas/deepseek-v4.1-flash' : 'huaweicloud-maas/GLM-5.2'); },
  get review() { return process.env.REVIEW_MODEL || (HAS_MAAS() ? 'maas/glm-5.3' : 'huaweicloud-maas/GLM-5.1'); },
  // Step reviews are an early warning (the final review is the gate): on MaaS they use fast flash so they do not
  // compete with the final review for GLM. Measured under load: 7.2 to 9.8 min lanes vs 4.1 to 13.1 with GLM step reviews.
  get stepReview() { return process.env.STEP_REVIEW_MODEL || (HAS_MAAS() ? 'maas/deepseek-v4.1-flash' : ''); },
  stall: num('STALL_S', 240),          // model silent this long while busy -> abort + resume
  toolStall: num('TOOL_STALL_S', 900), // one tool call running this long -> abort + resume
  think: num('THINK_S', 480),
  // After 2 thinking stalls in a build or fix phase, switch the builder to this model (same session, context kept).
  // GLM 5.3 got stuck re-planning big existing UI files twice; flash finished both lanes. '' or 'none' disables.
  get thinkFallback() { return process.env.THINK_FALLBACK_MODEL ?? (HAS_MAAS() ? 'maas/deepseek-v4.1-flash' : ''); },          // busy this long with no tool call or answer text -> abort + nudge
  retries: num('MAX_RETRIES', 3),      // interruptions (stall, transport, crash) per phase
  rateWait: num('RATE_WAIT_S', 1800),  // total time a phase may wait out model rate limits (not counted as retries)
  rateBackoff: num('RATE_BACKOFF_S', 45), // first rate-limit wait, doubles per hit, capped at 300 s
  fixes: num('MAX_FIXES', 3),          // gate failures fed back to the builder
  noCommitS: num('NO_COMMIT_S', 900),  // a running builder with no new commit this long raises a blocker (0 disables)
  laneTimeout: num('LANE_TIMEOUT', 5400),
  checkTimeout: num('CHECK_TIMEOUT', 900),
  netWait: num('NET_WAIT_S', 1800),    // a network error waits up to this long for the network (no retry spent)
  stepReviewTimeout: num('STEP_REVIEW_TIMEOUT', 600), // a step review session that never settles is aborted after this long
  stepReviewGrace: num('STEP_REVIEW_GRACE_S', 20), // builder idle: wait this long for a step review in flight, then cancel it (the final review covers those commits)
  noReview: process.env.NO_REVIEW === '1',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const hhmmss = (t = now()) => new Date(t).toTimeString().slice(0, 8);
export const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
// Human duration shared by the CLI (ca plan list) and the pages (CAUI.fmtDur): 45s / 12m / 2h 0m / 3d 4h.
export const fmtDur = (ms) => {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
export const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const compact = (n) => { n = Number(n) || 0; if (n < 1000) return String(n); if (n < 1e6) { const v = n / 1000; return `${v < 10 ? v.toFixed(1) : Math.round(v)}k`.replace('.0k', 'k'); } return `${(n / 1e6).toFixed(n < 1e7 ? 2 : n < 1e8 ? 1 : 0)}M`; };
export const readJSON = (f, d = null) => { for (let i = 0; i < 3; i++) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; } } return d; };
// The dashboard polls the same small registry, state and plan files every 2 s: parse each once and reuse it
// while statSync mtimeMs and size are unchanged. Returns a fresh structuredClone so no caller can mutate the
// cached value (lanes() and planView hand their objects to CLI writers that do mutate state). Missing file or a
// path that is not a regular file: null, and the entry is dropped. Parse failures are not cached (retried next call).
export const jsonCache = new Map();
export function readJSONCached(file) {
  let st; try { st = fs.statSync(file); } catch { jsonCache.delete(file); return null; }
  if (!st.isFile()) { jsonCache.delete(file); return null; }
  const c = jsonCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return structuredClone(c.value);
  let ok = false; let value = null;
  for (let i = 0; i < 3; i++) { try { value = JSON.parse(fs.readFileSync(file, 'utf8')); ok = true; break; } catch (e) { if (e.code === 'ENOENT') { jsonCache.delete(file); return null; } } }
  if (ok) jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return structuredClone(value);
}
// state.json is read every 2 s by status, wait and the dashboard: a plain overwrite let readers see a half-written
// file and the lane vanished from the list for one poll. Write a temp file and rename it over the old one; on
// Windows a reader holding the file open makes rename fail with EPERM, so retry briefly, then fall back.
export const writeAtomic = (f, text) => {
  const tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); } catch { return; }
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, f); return; } catch { const t = Date.now() + 15; while (Date.now() < t); } }
  try { fs.writeFileSync(f, text); } catch {} try { fs.rmSync(tmp, { force: true }); } catch {}
};
export const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const killTree = (pid) => { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } } };
export const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
// ---------- CodeArts environment (same as installers/codearts.cmd) ----------
export const envCache = {};
export function userEnv(name) {
  if (process.env[name]) return process.env[name];
  const saved = readCreds()[name]; // `ca auth` keys (user-only file)
  if (saved) return saved;
  if (name in envCache) return envCache[name];
  if (process.platform !== 'win32') return '';
  return (envCache[name] = userRegistryEnv()[name.toUpperCase()] || '');
}
// Every user-level variable in one `reg query HKCU\Environment` (about 30 ms), instead of one PowerShell
// start per name (about 750 ms each, which made doctor, auth and lane start slow). Names are matched
// case-insensitively like Windows does. REG_EXPAND_SZ values are returned unexpanded, as before.
export let regEnv = null;
export function userRegistryEnv() {
  if (regEnv) return regEnv;
  regEnv = {};
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) { const m = line.match(/^\s{4}(\S.*?)\s{4}REG_(?:SZ|EXPAND_SZ)\s{4}(.*)$/); if (m) regEnv[m[1].toUpperCase()] = m[2].trim(); }
  } catch {}
  return regEnv;
}
// The worker's bash tool runs $SHELL. When ca is started from Git Bash, SHELL is the raw MSYS
// binary (Git\usr\bin\bash.exe), which hangs forever at startup under a console-less native
// parent: every bash tool call stays "running". The Git\bin\bash.exe launcher works.
export function workerShell() {
  if (process.platform !== 'win32') return process.env.SHELL;
  const cands = [process.env.CA_SHELL, (process.env.SHELL || '').replace(/\\usr\\bin\\bash\.exe$/i, '\\bin\\bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  return cands.find((c) => c && /\\bin\\bash\.exe$/i.test(c) && !/\\usr\\bin\\/i.test(c) && fs.existsSync(c)) || process.env.SHELL;
}
// A repo a lane cannot write to (Windows Controlled Folder Access, a sandbox ACL, a read-only disk)
// fails every commit, so a fix round can never help: probe the repo root, the git dir and a lock file
// in the git dir through the worker shell (Git Bash) before a lane starts. The git dir comes from
// `git rev-parse --absolute-git-dir`, so a worktree probes its own .git/worktrees/<name> dir. Returns
// { ok, where, error } with error the first line of the failing output. CA_WRITE_PROBE_FAIL=1 forces a
// failure for tests.
export function writeProbe(repo) {
  // A worktree keeps its git dir outside the lane folder (in the main repo's .git/worktrees/<name>),
  // where the CodeArts sandbox refuses to write: flag it so doctor can warn instead of a false ok.
  const gd = git(repo, 'rev-parse', '--absolute-git-dir');
  // Compare real paths: on Windows a short 8.3 segment (N00958~1 in TEMP) never matches git's long form.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const worktree = !!gd && !gitDirInsideRepo(real(repo), real(gd));
  if (String(process.env.CA_WRITE_PROBE_FAIL || '') === '1') return { ok: false, where: 'write probe (test hook)', error: 'CA_WRITE_PROBE_FAIL=1 forces a write failure', worktree };
  const sh = workerShell();
  const shell = sh && fs.existsSync(sh) ? sh : (process.platform === 'win32' ? 'bash' : (process.env.SHELL || 'sh'));
  // A folder that is not a git repo yet is fine (onboard or git init makes it one): probe only its root.
  const gitdir = gd;
  const spots = [
    { where: `repo root (${repo})`, file: path.join(repo, '.ca-write-probe') },
    ...(gitdir ? [{ where: `git dir (${gitdir})`, file: path.join(gitdir, '.ca-write-probe') },
      { where: `git dir lock (${gitdir})`, file: path.join(gitdir, 'ca-probe.lock') }] : []),
  ];
  for (const s of spots) {
    const f = String(s.file).replace(/\\/g, '/');
    const r = spawnSync(shell, ['-c', `: > "${f}" && rm -f "${f}"`], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.status !== 0) {
      const out = String((r.stderr || '') + (r.stdout || '')).trim();
      const first = out.split(/\r?\n/).find((l) => l.trim()) || (r.error ? String(r.error.message) : `exit ${r.status}`);
      return { ok: false, where: s.where, error: first, worktree };
    }
  }
  return { ok: true, where: '', error: '', worktree };
}
// Huawei Cloud ModelArts MaaS as a CodeArts custom provider ("maas/<model>"). CodeArts only
// enables providers named in CUSTOM_PROVIDER_KEYS; the config goes in OPENCODE_CONFIG_CONTENT
// (merged over codearts_cli.json), so the key lives only in the process env, never in a file.
export const MAAS_URL = process.env.MAAS_BASE_URL || 'https://api-ap-southeast-1.modelarts-maas.com/openai/v1';
export const MAAS_MODELS = {
  'glm-5.3': { name: 'GLM 5.3 (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
  'glm-5.2': { name: 'GLM 5.2 (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
  // The same flash model with thinking turned off: about half the latency per model call.
  'deepseek-v4.1-flash-fast': { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash, no thinking (MaaS)', reasoning: false, options: { thinking: { type: 'disabled' } }, limit: { context: 200000, output: 65536 } },
};
// A `maas/<id>` model named in BUILD_MODEL, REVIEW_MODEL, STEP_REVIEW_MODEL or THINK_FALLBACK_MODEL that
// is not built in is declared on the fly, so MAAS_BASE_URL + MAAS_API_KEY can point a lane at any
// OpenAI-compatible endpoint (another region, or another vendor's API) without a code change.
export function maasModels() {
  const models = { ...MAAS_MODELS };
  for (const v of ['BUILD_MODEL', 'REVIEW_MODEL', 'STEP_REVIEW_MODEL', 'THINK_FALLBACK_MODEL']) {
    const m = String(process.env[v] || '').match(/^maas\/(.+)$/);
    if (m && !models[m[1]]) models[m[1]] = { name: `${m[1]} (${v.toLowerCase()})`, reasoning: true, limit: { context: 128000, output: 32768 } };
  }
  return models;
}
export let maasKey;
export const maasEnv = () => {
  maasKey ??= userEnv('MAAS_API_KEY');
  if (!maasKey) return {};
  return {
    CUSTOM_PROVIDER_KEYS: 'maas',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { maas: { npm: '@ai-sdk/openai-compatible', name: 'Huawei Cloud MaaS', options: { baseURL: MAAS_URL, apiKey: maasKey }, models: maasModels() } } }),
  };
};
export function caEnv(extra = {}) {
  return {
    ...process.env, SHELL: workerShell(),
    SCENARIO: 'codeartsdoer', KERNEL_DATA_DIR: path.dirname(SETTINGS), KERNEL_STATE_DIR: path.join(CA_HOME, 'state'),
    KERNEL_CONFIG_DIR: CA_HOME, OPENCODE_CONFIG: path.join(CA_HOME, 'codearts_cli.json'),
    OPENCODE_CONFIG_FILE: 'codearts_cli.json,codearts_cli.jsonc', OPENCODE_CHANNEL: 'latest', PLUGIN_ENV: 'hc',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: 'true', CODEARTS_DISABLE_AUTO_UPDATE: 'true',
    OMO_SEND_ANONYMOUS_TELEMETRY: '0', CODEAGENT_USE_MESSAGE_FEEDBACK: 'false',
    CODEARTS_CLI_AK: userEnv('CODEARTS_CLI_AK'), CODEARTS_CLI_SK: userEnv('CODEARTS_CLI_SK'),
    ...maasEnv(), ...extra,
  };
}
// The CA_DUMP_ENV debug dump must never carry a secret. Blank out every variable whose name looks
// like a credential, then scrub the remaining values of those secret values wherever they appear
// (this also covers the MaaS apiKey embedded in OPENCODE_CONFIG_CONTENT).
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|(^|_)AK$|(^|_)SK$/i;
export function redactEnv(env) {
  const out = {}; const secrets = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (SECRET_NAME.test(k)) { if (typeof v === 'string' && v.length >= 6) secrets.push(v); out[k] = '<redacted>'; }
    else out[k] = v;
  }
  for (const k of Object.keys(out)) {
    if (SECRET_NAME.test(k) || typeof out[k] !== 'string') continue;
    let s = out[k];
    for (const sec of secrets) s = s.split(sec).join('<redacted>');
    out[k] = s;
  }
  return out;
}
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
export const splitModel = (m) => { const i = m.indexOf('/'); return { providerID: m.slice(0, i), modelID: m.slice(i + 1) }; };

export const PLANS = path.join(REG, 'plans');
// A plan with status done or closed is closed (never appended to, only archived and replaced).
export const planClosed = (p) => !!(p && /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || ''));
// The dashboard answers /api/plans, /api/lanes and /api/overview every 2 s and maps a view over every plan and
// lane, so lanes() and plans() must run once per poll, not once per plan or per lane. The request handler sets
// reqSnap at the start of a request and the snapshot goes stale on the next one; outside the dashboard it stays
// null and every call reads live, so CLI commands behave exactly as before.
let reqSnap = null;
export function getReqSnap() { return reqSnap; }
export function setReqSnap(v) { reqSnap = v; }
export function lanesSnapshot() { if (!reqSnap) return lanes(); if (!reqSnap.lanes) reqSnap.lanes = lanes(); return reqSnap.lanes; }
export function plansSnapshot() { if (!reqSnap) return plans(); if (!reqSnap.plans) reqSnap.plans = plans(); return reqSnap.plans; }
// planView needs one id -> lane lookup; build it once per request instead of once per plan.
export function laneIndex() { if (!reqSnap) return new Map(lanes().map((l) => [l.id, l])); const ls = lanesSnapshot(); if (!reqSnap.laneIndex) reqSnap.laneIndex = new Map(ls.map((l) => [l.id, l])); return reqSnap.laneIndex; }
export function lanes() {
  let files = []; try { files = fs.readdirSync(REG).filter((f) => f.endsWith('.json')); } catch {}
  // Skip non-lane json in the registry (acks.json): a registration always carries a string dir.
  return files.map((f) => { const r = readJSONCached(path.join(REG, f)); if (!r || typeof r.dir !== 'string') return null; const s = readJSONCached(path.join(r.dir, 'state.json')) || readJSONCached(path.join(REG, 'final', f)); return s ? { ...r, s } : null; }).filter(Boolean)
    .sort((a, b) => (b.s.startedAt || 0) - (a.s.startedAt || 0));
}
// Lanes written before 'paused' existed recorded a timeout as failed (timeout).
export function resultOf(s) { return s && s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s && s.result; }
export function health(s) {
  if (s.result) return resultOf(s);
  if (!alive(s.pid)) return 'DEAD (ca stop cleans up)';
  const idle = now() - (s.lastEventAt || s.startedAt);
  if (['gate', 'backoff', 'restart', 'starting'].includes(s.phase)) return 'running';
  if (!s.busy) return 'running';
  if (s.tools?.length) return 'running tool';
  if (idle > (s.config?.stall || 240) * 1000) return 'STALLED';
  if (s.turnStartAt || s.lastToolAt || s.lastTextAt) {
    const thinkS = s.config?.think ?? 480;
    const age = progressAge({ turnStartAt: s.turnStartAt, lastToolAt: s.lastToolAt, lastTextAt: s.lastTextAt, now: now() });
    if (thinkS > 0 && age > thinkS * 1000) return `thinking (${dur(age)}, no tool call)`;
  }
  if (idle > 60000) return 'quiet';
  return 'running';
}
// One lookup for lanes and plans: exact id, then exact task (lanes only), then a substring match.
// Zero substring matches means "not found"; more than one is ambiguous and must be refused, never
// guessed, so a short prefix can never steer, stop or close the wrong thing.
export function pickOne(items, q, idOf, taskOf) {
  if (!q) return { hit: null };
  const exact = items.find((x) => idOf(x) === q) || (taskOf ? items.find((x) => taskOf(x) === q) : null);
  if (exact) return { hit: exact };
  const subs = items.filter((x) => idOf(x).includes(q));
  if (subs.length === 1) return { hit: subs[0] };
  if (subs.length > 1) return { hit: null, matches: subs.map(idOf) };
  return { hit: null };
}
export function findLane(q) {
  const all = lanes();
  if (!q) { const runningLanes = all.filter((l) => !l.s.result); if (runningLanes.length === 1) return runningLanes[0]; die('which lane? ' + all.map((l) => l.id).join(', '), 2); }
  const r = pickOne(all, q, (l) => l.id, (l) => l.task);
  if (r.matches) die(`ambiguous lane "${q}": matches ${r.matches.join(', ')}; use the full id`, 2);
  if (!r.hit) die(`no lane matches "${q}". Lanes: ${all.map((l) => l.id).join(', ') || '(none)'}`, 2);
  return r.hit;
}
// Server side acknowledgement of finished lanes (Control room). acks.json maps a lane id to the
// finishedAt that was acknowledged, so a lane resumed and finished again reads as unseen.
export const ACKS = path.join(REG, 'acks.json');
export let acksCache = {}, acksMtime = -1;
export function readAcks() {
  try { const m = fs.statSync(ACKS).mtimeMs; if (m !== acksMtime) { acksCache = readJSON(ACKS, {}) || {}; acksMtime = m; } }
  catch { acksCache = {}; acksMtime = -1; }
  return acksCache;
}
export function writeAcks(a) { try { fs.mkdirSync(REG, { recursive: true }); fs.writeFileSync(ACKS, JSON.stringify(a, null, 2) + '\n'); } catch {} acksMtime = -1; }
// An ack is the finishedAt it was given for (a number), or { at, note } when the user marked a needs-you lane handled.
export const ackAt = (v) => (v && typeof v === 'object' ? v.at : v);
export function laneSeen(id, finishedAt) { return !!(finishedAt && ackAt(readAcks()[id]) === finishedAt); }
export function ackNote(id) { const v = readAcks()[id]; return v && typeof v === 'object' ? v.note || '' : ''; }
export function setAck(id, seen, finishedAt, note = '') { const a = { ...readAcks() }; if (seen && finishedAt) a[id] = note ? { at: finishedAt, note } : finishedAt; else delete a[id]; writeAcks(a); }
// The bucket a person sees: any finished lane the lead acknowledged is handled, and a DEAD or running
// lane can never be marked away (it needs resume or stop). The ended lanes of a closed plan are never
// attention either: the lead closed the plan, so nothing is left for the human.
// While a poll builds a view over every lane, one lane object is reused by laneRow, laneStatusOf, laneView and
// bucketFor, and each of them wants the same liveness, health and bucket. Compute them once per lane object (a
// WeakMap, so nothing is attached to the lane and nothing leaks from one poll to the next).
export const laneMemo = new WeakMap();
export function laneMemoFor(l) { let m = laneMemo.get(l); if (!m) { m = {}; laneMemo.set(l, m); } return m; }
export function laneAlive(l) { const m = laneMemoFor(l); if (m.alive === undefined) m.alive = alive(l.s.pid); return m.alive; }
export function plans() {
  let files = []; try { files = fs.readdirSync(PLANS).filter((f) => f.endsWith('.json')); } catch {}
  const out = [];
  for (const f of files) {
    const r = readJSONCached(path.join(PLANS, f)); if (!r || typeof r.file !== 'string') continue;
    let st; try { st = fs.statSync(r.file); } catch { continue; }
    if (!st.isFile()) continue;
    // A plan whose file is marked removed: true was deleted: never list it again.
    const p = readJSONCached(r.file); if (p && p.removed === true) continue;
    const o = { ...r, mtime: st.mtimeMs };
    // planView and closedPlanLanes need this plan's JSON: hand it the parsed object so one poll never reads
    // the same file twice. Non-enumerable, so it never leaks into JSON output or list rendering; both read it.
    Object.defineProperty(o, 'plan', { value: p, enumerable: false, configurable: true });
    out.push(o);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
export const laneId = (repo, task) => `${path.basename(path.resolve(repo))}--${task}`.replace(/[^\w.-]+/g, '_');
export function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }

export const CA_ENTRY = path.join(HERE, 'ca.mjs');

export const dashUrl = () => `http://127.0.0.1:${Number(process.env.CA_DASH_PORT || 4777)}`;

// Lint a brief the way `ca brief-check` and the start of `ca lane` do (tracked files from git ls-files).
export function briefWarningsFor(repo, task) {
  const file = path.join(repo, 'tasks', `${task}.md`);
  let briefText = null; try { briefText = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const tracked = git(repo, 'ls-files').split(/\r?\n/).filter(Boolean);
  return lintBrief({ repo, briefText, listFiles: () => tracked, readFile: (rel) => { try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return ''; } } });
}

export function briefWarningText(w) {
  if (w.kind === 'protected-dependent') return `${w.file} is protected by a rule ("${w.rule}") but the brief changes ${(w.references || []).join(', ')}, which that file names`;
  if (w.kind === 'missing-check-file') return `a CHECK line runs ${w.file}, which is not a file in the repo`;
  return `${w.kind}: ${w.file}`;
}

// Readable warning lines: more than 3 protected files under the same rule naming the same changed files
// become one line (a check suite names the runner in every file), so the real warning is not buried.
export function briefWarningLines(warnings) {
  const groups = new Map(); const order = [];
  for (const w of warnings || []) {
    const key = w.kind === 'protected-dependent' ? `${w.rule}\u0000${(w.references || []).join(',')}` : `\u0001${order.length}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(w);
  }
  return order.map((k) => {
    const g = groups.get(k);
    if (g.length <= 3) return g.map(briefWarningText);
    const w = g[0];
    return [`${g.length} protected files are named by a rule ("${w.rule}") but the brief changes ${(w.references || []).join(', ')}, which they name (e.g. ${g.slice(0, 3).map((x) => x.file).join(', ')}): say in the brief how they may change`];
  }).flat();
}

// Step state from commits: "step N" in a subject wins, otherwise commits map to steps in order.
export function stepProgress(s, steps = s.stepList || []) {
  const commits = s.commitLog || []; const done = new Map();
  for (const c of commits) { const m = c.subject.match(/\bstep\s*(\d+)/i); if (m) done.set(Number(m[1]), c.hash); }
  if (!done.size) commits.forEach((c, i) => { if (i < steps.length) done.set(steps[i].n, c.hash); });
  const building = !s.result && ['build', 'fix', 'starting', 'backoff', 'restart', 'gate'].includes(s.phase);
  const cur = building ? steps.find((st) => !done.has(st.n))?.n : null;
  const list = steps.map((st) => ({ ...st, state: done.has(st.n) ? 'done' : st.n === cur ? 'current' : s.result ? 'open' : 'pending', commit: done.get(st.n) || '' }));
  return { list, done: list.filter((x) => x.state === 'done').length, total: list.length, current: list.find((x) => x.state === 'current') || null };
}

// The project a lane belongs to: a worktree reports the main repo (its .git common dir's parent).
export const projectCache = new Map();

export function projectOf(repo) {
  if (projectCache.has(repo)) return projectCache.get(repo);
  let main = repo;
  const out = git(repo, 'rev-parse', '--git-common-dir');
  if (out && path.basename(path.resolve(repo, out)).toLowerCase() === '.git') main = path.dirname(path.resolve(repo, out));
  const v = { key: main, name: path.basename(main) };
  projectCache.set(repo, v);
  return v;
}

// Lanes start the dashboard on demand (detached, survives the lane). CA_DASH=0 turns it off.
export async function ensureDash() {
  if (process.env.CA_DASH === '0') return null;
  const port = Number(process.env.CA_DASH_PORT || 4777); const url = `http://127.0.0.1:${port}`;
  try { if ((await fetch(url + '/api/lanes', { signal: AbortSignal.timeout(1500) })).ok) return url; } catch {}
  try { spawn(process.execPath, [CA_ENTRY, 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return url; } catch { return null; }
}
