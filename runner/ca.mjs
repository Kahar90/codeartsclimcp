#!/usr/bin/env node
// ca: CodeArts lane supervisor and control CLI (no dependencies, Node 20+).
//
// A lane owns one private `codearts serve` (127.0.0.1, random port and password) in the repo,
// drives it over HTTP + SSE, and writes everything to <repo>/tasks/<task>.lane/:
//   state.json   live state (phase, activity, idle time, tokens, commits)  -> ca status / dash
//   live.log     readable transcript: replies, thinking, every tool call  -> ca tail / dash
//   events.jsonl raw server events (minus deltas and heartbeats), for debugging
//   summary.md   final report (also printed to stdout when the lane ends)
//   inbox/       steering messages queued by `ca steer` / the dashboard
//
// Reliability: a watchdog aborts and resumes a session after STALL_S without model activity
// (or TOOL_STALL_S on one tool call, or THINK_S of reasoning with no tool call), permission
// prompts are answered by policy so nothing waits forever, retries continue the SAME session
// (context kept), the runner itself runs the brief's CHECK: lines and the git-clean gate,
// and feeds failures back to the builder.
//
// usage: ca lane <repo> <task> [--detach] [--resume]  run a lane (foreground; --detach: background with a log;
//                                  --resume: continue a paused/stopped/failed lane in place, same id and step count,
//                                  plus the lead's notes from tasks/<task>.resume.md if present)
//        ca status [--json] [--all]        table of lanes (--json adds id, task, repo, result, progress)
//        ca wait <lane...> [--timeout S] [--json] [--quiet]  block until lanes end; exit = worst lane
//        ca summary <lane> [--json]        final report of a lane (live status row while it runs)
//        ca init <repo> <task> [--goal "<text>"] [--force]  scaffold <repo>/tasks/<task>.md
//        ca doctor [--json] [<repo>]       preflight: node, codearts, credentials, git, trust, shell
//        ca setup <harness> [repo] [--user]   write MCP + rules config for claude|kiro|cursor|codex|vscode|opencode
//        ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json]   guided first-run setup
//        ca update [--check] [--json] [--dry-run]   reinstall the latest version and refresh every
//                                  harness config; --check only reports whether a newer one exists
//        ca uninstall [--harness h] [--keys] [--dry-run]   remove exactly what setup added (and the keys with --keys)
//        ca auth [--wait [--timeout S]] [--status] [--stdin] [--no-open] [--json]   keys via a local browser form, never through chat
//        ca workflow                       print the lead workflow (docs/workflow.md)
//        ca mcp                            run the MCP server (runner/mcp.mjs), if installed
//        ca tail <lane> [-f] [-n N]        readable transcript
//        ca steer <lane> <message>         queue a message into the running session
//        ca attach <lane>                  open the CodeArts TUI on the live session (watch + type)
//        ca stop <lane>                    abort the session and end the lane
//        ca ack <lane> [--note t] [--undo]  mark a finished lane seen; a needs-you lane becomes handled (ended)
//        ca ack --stale [--older-than 48h] [--dry-run] [--note t]   mark every Needs-you lane older than that handled
//        ca kick <lane> [--fresh|--server|--now] [message]  unstick a stuck turn: retry it (default),
//                                  start a fresh session, restart the codearts server or skip a backoff
//        ca resume <lane> [--note "<text>"] [--dry-run]  continue a paused, failed, stopped or DEAD
//                                  lane in place (same id, tokens and history; the note waits in
//                                  the lane folder; --dry-run prints the argv without spawning)
//        ca dash [port]                    local web dashboard of all lanes (default 4777)
//        ca gc                             forget lanes finished more than 3 days ago
//        ca plan [<plan.json>]             show the lead's plan on the dashboard (goal, waves, next)
//        ca plan list | close [id] [--reason t] | rm <id>   plan state; close drops unstarted lanes
//        ca note [--now] <text>            log a lead decision (--now: set the "lead is doing" line)
//        ca lead-tokens [--plan id] [--session file]   point the plan at the lead's Claude transcript and print totals
//        ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]
//                                  report the lead's own token use on the plan (any harness; --add accumulates)
//        ca version | --version            the installed version and where it lives
//        ca help | -h | --help             this usage
//        Env knobs: THINK_FALLBACK_MODEL (builder model after 2 thinking stalls; brief line FALLBACK_MODEL:, none disables)
//        STALL_S=240 TOOL_STALL_S=900 THINK_S=480 (watchdogs: silent model, one tool
//        call, thinking with no tool call; THINK_S 0 disables) MAX_RETRIES=3 MAX_FIXES=3
//        LANE_TIMEOUT=5400 CHECK_TIMEOUT=900 BUILD_MODEL REVIEW_MODEL NO_REVIEW=1
//        NET_WAIT_S=1800 (a network error waits this long for the network instead of using a retry)
//        CA_MAX_LANES_PER_MODEL=maas/glm-5.3=2,default=4 (cap lanes per build model; glm 3,
//        others 4, "off" or 0 disables; a lane waits for a free slot before its build session)
//        Exit codes: 0 done (review ready or skipped), 1 failed/stopped/killed, 2 usage or unknown
//        lane, 3 missing credentials, 4 needs review, 5 paused at LANE_TIMEOUT (resume with --resume),
//        124 wait timeout.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { thinkStall, progressAge } from './watchdog.mjs';
import { emptyTokens, addStepTokens, tokenTotal, withTotal, sumTokens } from './tokens.mjs';
import { laneActions, laneBucket, laneKind } from './controls.mjs';
import authCmd, { readCreds } from './auth.mjs';
import { authProblem } from './authsignal.mjs';
import { isNetworkError, waitOnline, detectSleep, laneSlots, parseLimits } from './netwait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const CA_HOME = path.join(os.homedir(), '.codeartsdoer');
// CodeArts settings.json (security.trustedFolders). CA_SETTINGS overrides the location for tests.
const SETTINGS = process.env.CA_SETTINGS || path.join(CA_HOME, 'cli-data', 'settings.json');
const EXE = process.env.CODEARTS_EXE || path.join(CA_HOME, 'installers', 'bin', process.platform === 'win32' ? 'codearts.exe' : 'codearts');
// Official CodeArts Agent CLI installer (also used by `ca onboard` to install it).
const INSTALL_BASE = 'https://apsoutheast1-cloudide-marketplace.obs.ap-southeast-1.myhuaweicloud.com/codearts/cli_tui/install_script';
const INSTALL_HINT = process.platform === 'win32'
  ? `PowerShell: irm ${INSTALL_BASE}/install.ps1 | iex   (or: ca onboard --yes)`
  : `curl -fsSL ${INSTALL_BASE}/install.sh | bash   (or: ca onboard --yes)`;
const REG = process.env.CA_REGISTRY || path.join(CA_HOME, 'lanes');
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const HAS_MAAS = () => !!userEnv('MAAS_API_KEY');
const CFG = {
  // Default: MaaS (flash builds, GLM 5.3 reviews). Without MAAS_API_KEY: CodeArts quota models.
  get build() { return process.env.BUILD_MODEL || (HAS_MAAS() ? 'maas/deepseek-v4.1-flash' : 'huaweicloud-maas/GLM-5.2'); },
  get review() { return process.env.REVIEW_MODEL || (HAS_MAAS() ? 'maas/glm-5.3' : 'huaweicloud-maas/GLM-5.1'); },
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
  laneTimeout: num('LANE_TIMEOUT', 5400),
  checkTimeout: num('CHECK_TIMEOUT', 900),
  netWait: num('NET_WAIT_S', 1800),    // a network error waits up to this long for the network (no retry spent)
  noReview: process.env.NO_REVIEW === '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const hhmmss = (t = now()) => new Date(t).toTimeString().slice(0, 8);
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
// Human duration shared by the CLI (ca plan list) and the pages (CAUI.fmtDur): 45s / 12m / 2h 0m / 3d 4h.
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const compact = (n) => { n = Number(n) || 0; if (n < 1000) return String(n); if (n < 1e6) { const v = n / 1000; return `${v < 10 ? v.toFixed(1) : Math.round(v)}k`.replace('.0k', 'k'); } return `${(n / 1e6).toFixed(n < 1e7 ? 2 : n < 1e8 ? 1 : 0)}M`; };
const readJSON = (f, d = null) => { for (let i = 0; i < 3; i++) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; } } return d; };
// state.json is read every 2 s by status, wait and the dashboard: a plain overwrite let readers see a half-written
// file and the lane vanished from the list for one poll. Write a temp file and rename it over the old one; on
// Windows a reader holding the file open makes rename fail with EPERM, so retry briefly, then fall back.
const writeAtomic = (f, text) => {
  const tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); } catch { return; }
  for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, f); return; } catch { const t = Date.now() + 15; while (Date.now() < t); } }
  try { fs.writeFileSync(f, text); } catch {} try { fs.rmSync(tmp, { force: true }); } catch {}
};
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killTree = (pid) => { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } } };
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return (r.stdout || '').trim(); };

// ---------- CodeArts environment (same as installers/codearts.cmd) ----------
const envCache = {};
function userEnv(name) {
  if (process.env[name]) return process.env[name];
  const saved = readCreds()[name]; // `ca auth` keys (user-only file)
  if (saved) return saved;
  if (name in envCache) return envCache[name];
  if (process.platform !== 'win32') return '';
  try { return (envCache[name] = execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' }).trim()); } catch { return (envCache[name] = ''); }
}
// The worker's bash tool runs $SHELL. When ca is started from Git Bash, SHELL is the raw MSYS
// binary (Git\usr\bin\bash.exe), which hangs forever at startup under a console-less native
// parent: every bash tool call stays "running". The Git\bin\bash.exe launcher works.
function workerShell() {
  if (process.platform !== 'win32') return process.env.SHELL;
  const cands = [process.env.CA_SHELL, (process.env.SHELL || '').replace(/\\usr\\bin\\bash\.exe$/i, '\\bin\\bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  return cands.find((c) => c && /\\bin\\bash\.exe$/i.test(c) && !/\\usr\\bin\\/i.test(c) && fs.existsSync(c)) || process.env.SHELL;
}
// Huawei Cloud ModelArts MaaS as a CodeArts custom provider ("maas/<model>"). CodeArts only
// enables providers named in CUSTOM_PROVIDER_KEYS; the config goes in OPENCODE_CONFIG_CONTENT
// (merged over codearts_cli.json), so the key lives only in the process env, never in a file.
const MAAS_URL = process.env.MAAS_BASE_URL || 'https://api-ap-southeast-1.modelarts-maas.com/openai/v1';
const MAAS_MODELS = {
  'glm-5.3': { name: 'GLM 5.3 (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
  'glm-5.2': { name: 'GLM 5.2 (MaaS)', reasoning: true, limit: { context: 200000, output: 65536 } },
};
let maasKey;
const maasEnv = () => {
  maasKey ??= userEnv('MAAS_API_KEY');
  if (!maasKey) return {};
  return {
    CUSTOM_PROVIDER_KEYS: 'maas',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { maas: { npm: '@ai-sdk/openai-compatible', name: 'Huawei Cloud MaaS', options: { baseURL: MAAS_URL, apiKey: maasKey }, models: MAAS_MODELS } } }),
  };
};
function caEnv(extra = {}) {
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
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|(^|_)AK$|(^|_)SK$/i;
function redactEnv(env) {
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
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const splitModel = (m) => { const i = m.indexOf('/'); return { providerID: m.slice(0, i), modelID: m.slice(i + 1) }; };

// ---------- one private codearts server ----------
class Server {
  constructor(cwd, logFile) { this.cwd = cwd; this.logFile = logFile; this.ac = null; }
  get auth() { return 'Basic ' + Buffer.from('codearts:' + this.pw).toString('base64'); }
  async start() {
    this.port = await freePort();
    this.pw = this.pw || crypto.randomBytes(16).toString('hex');
    this.url = `http://127.0.0.1:${this.port}`;
    const out = fs.openSync(this.logFile, 'a');
    if (process.env.CA_DUMP_ENV) fs.writeFileSync(process.env.CA_DUMP_ENV, JSON.stringify({ env: redactEnv(caEnv({ CODEARTS_SERVER_PASSWORD: this.pw })), cwd: this.cwd }, null, 1));
    this.child = spawn(EXE, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'WARN'],
      { cwd: this.cwd, env: caEnv({ CODEARTS_SERVER_PASSWORD: this.pw }), stdio: ['ignore', out, out] });
    this.alive = true;
    this.child.on('exit', (code) => { this.alive = false; this.exitCode = code; });
    const t0 = now();
    while (now() - t0 < 90000) {
      if (!this.alive) throw new Error(`codearts serve exited ${this.exitCode} (see ${this.logFile})`);
      try { const h = await this.api('GET', '/global/health', null, 3000); if (h && h.healthy) { this.version = h.version; return h; } } catch {}
      await sleep(500);
    }
    throw new Error('codearts serve did not become healthy in 90 s');
  }
  async api(method, p, body, timeout = 30000) {
    const r = await fetch(this.url + p, {
      method, headers: { authorization: this.auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
    try { return JSON.parse(t); } catch { return t; }
  }
  // SSE with reconnect; onEvent gets parsed JSON. Returns when stop() is called.
  async events(onEvent, onState) {
    while (!this.closed) {
      this.ac = new AbortController();
      try {
        const r = await fetch(this.url + '/event', { headers: { authorization: this.auth }, signal: this.ac.signal });
        onState?.(true);
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { onEvent(JSON.parse(line.slice(6))); } catch (e) { /* bad event */ } }
          }
        }
      } catch {}
      onState?.(false);
      if (!this.closed) await sleep(1000);
    }
  }
  stop() {
    this.closed = true; try { this.ac?.abort(); } catch {}
    if (this.child && this.alive) killTree(this.child.pid);
  }
}

// ---------- lane supervisor ----------
async function runLane(repoArg, task, opts = {}) {
  if (!repoArg || !task) die('usage: ca lane <repo> <task> [--detach]', 2);
  const repo = path.resolve(repoArg);
  const briefFile = path.join(repo, 'tasks', `${task}.md`);
  if (!task || !fs.existsSync(briefFile)) die(`usage: ca lane <repo> <task>   (needs ${briefFile})`, 2);
  // A brief copied from the template must not reach the builder with a placeholder CHECK line: the
  // runner would run the literal <...> text as a command. Refuse before anything is created.
  const briefEarly = fs.readFileSync(briefFile, 'utf8');
  const badCheck = [...briefEarly.matchAll(/^\s*(?:[-*]\s*)?CHECK:\s*`?(.+?)`?\s*$/gm)].map((m) => m[1]).find((c) => /<[^>]*>/.test(c));
  if (badCheck) die(`tasks/${task}.md still has a template placeholder CHECK line: "${badCheck}". Replace it with a real command or delete it.`, 2);
  if (!git(repo, 'rev-parse', '--git-dir')) die(`${repo} is not a git repo`, 2);
  const id = `${path.basename(repo)}--${task}`.replace(/[^\w.-]+/g, '_');
  const dir = path.join(repo, 'tasks', `${task}.lane`);
  const prev = readJSON(path.join(dir, 'state.json'));
  if (prev && alive(prev.pid) && prev.pid !== process.pid && !prev.result) die(`lane ${id} is already running (pid ${prev.pid})`, 2);
  // --resume keeps the lane folder, its base commit, tokens and history; a fresh run starts clean.
  const resumed = opts.resume ? prev : null;
  if (opts.resume && !(prev && prev.result && prev.result !== 'done')) die(`nothing to resume: lane ${id} has no paused, stopped or failed run`, 2);
  // Request errors first (they need no CodeArts), then the install.
  if (!fs.existsSync(EXE)) die(`codearts not found at ${EXE}; ca onboard --yes installs it`, 2);
  if (!resumed) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.rmSync(path.join(dir, 'KICK'), { force: true }); // a stale kick must not fire at once on resume
  fs.rmSync(path.join(dir, 'STOP'), { force: true }); // nor the STOP that ended the previous run (resume after ca stop)
  fs.mkdirSync(REG, { recursive: true });
  fs.writeFileSync(path.join(REG, `${id}.json`), JSON.stringify({ id, dir, repo, task }, null, 2));

  // Keep CodeArts' folder and lane files out of commits.
  const gi = path.join(repo, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const want = ['.codeartsdoer/', 'tasks/*.lane/', 'tasks/*.lane.log', 'tasks/*.out'].filter((p) => !giText.split(/\r?\n/).includes(p));
  if (want.length) {
    fs.writeFileSync(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + want.join('\n') + '\n');
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'chore: ignore codearts state and lane files');
  }
  // Folder trust (prefix match in ~/.codeartsdoer/cli-data/settings.json).
  const tr = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'trust.mjs'), repo], { encoding: 'utf8' });
  if (tr.status !== 0) die(`folder trust failed: ${tr.stderr}`, 4);

  const live = fs.openSync(path.join(dir, 'live.log'), 'a');
  const raw = fs.openSync(path.join(dir, 'events.jsonl'), 'a');
  const L = (s) => fs.writeSync(live, `${hhmmss()} ${s}\n`);
  const say = (s) => { L(s); process.stdout.write(`[${task} ${hhmmss()}] ${s}\n`); };
  const block = (prefix, text) => { for (const ln of String(text).replace(/\s+$/, '').split(/\r?\n/)) fs.writeSync(live, `         ${prefix}${ln}\n`); };

  const brief = fs.readFileSync(briefFile, 'utf8');
  const checks = [...brief.matchAll(/^\s*(?:[-*]\s*)?CHECK:\s*`?(.+?)`?\s*$/gm)].map((m) => m[1]);
  const stepList = [...brief.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) }));
  const stepCount = stepList.length;
  const BUILD = (brief.match(/^\s*MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.build;
  const FALLBACK = (brief.match(/^\s*FALLBACK_MODEL:\s*([\w.-]+\/[\w.-]+|none)/m) || [])[1] ?? CFG.thinkFallback;
  let buildModel = BUILD; // becomes FALLBACK after repeated thinking stalls
  const REVIEW = (brief.match(/^\s*REVIEW_MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.review;
  const START = (resumed && resumed.start) || git(repo, 'rev-parse', 'HEAD');
  const dirtyAll = () => git(repo, 'status', '--porcelain').split(/\r?\n/).filter((l) => l && !/^.. "?(tasks\/|\.codeartsdoer)/.test(l));
  const PRE_DIRTY = new Set(dirtyAll());
  const T0 = now();

  const S = {
    v: 1, id, task, repo, dir, pid: process.pid, startedAt: T0, updatedAt: T0, phase: 'starting', attempt: 0, fixes: 0,
    server: null, buildSession: null, reviewSession: null, activeSession: null, busy: false, sse: false,
    lastEventAt: T0, turnStartAt: 0, lastToolAt: 0, lastTextAt: 0, activity: 'starting server', models: { build: BUILD, review: REVIEW }, stepList, commitLog: [], todos: [], files: [], phases: [{ phase: 'starting', at: T0 }], start: START,
    config: { stall: CFG.stall, toolStall: CFG.toolStall, think: CFG.think, retries: CFG.retries, fixes: CFG.fixes },
    tokens: emptyTokens(), tokensBy: { build: emptyTokens(), review: emptyTokens(), other: emptyTokens() }, tokensByModel: {},
    commits: 0, steps: stepCount, checks,
    interruptions: [], steers: [], permissions: [], gates: [], errors: [], outside: [], verdict: null, result: null, exitCode: null,
  };
  if (resumed) {
    const runs = [...(resumed.runs || []), { startedAt: resumed.runStartedAt || resumed.startedAt, finishedAt: resumed.finishedAt, result: resultOf(resumed), reason: resumed.reason || '' }];
    const by = (r) => ({ ...emptyTokens(), ...(resumed.tokensBy?.[r] || {}) });
    const byModel = {}; for (const [m, t] of Object.entries(resumed.tokensByModel || {})) byModel[m] = { ...emptyTokens(), ...t };
    Object.assign(S, { startedAt: resumed.startedAt || T0, runStartedAt: T0, runs, resumes: runs.length, tokens: { ...S.tokens, ...(resumed.tokens || {}) },
      tokensBy: { build: by('build'), review: by('review'), other: by('other') }, tokensByModel: byModel,
      interruptions: resumed.interruptions || [], steers: resumed.steers || [], permissions: resumed.permissions || [], errors: resumed.errors || [],
      outside: resumed.outside || [], files: resumed.files || [], todos: resumed.todos || [], phases: [...(resumed.phases || []), { phase: 'starting', at: T0 }] });
  }
  const insideRepo = (f) => { const a = path.resolve(repo, String(f).replace(/[\\/]\*+$/, '')).toLowerCase(); return [repo, os.tmpdir()].some((r) => a === r.toLowerCase() || a.startsWith(r.toLowerCase() + path.sep)); };
  let lastWrite = 0;
  const save = (force) => { if (!force && now() - lastWrite < 1000) return; lastWrite = now(); S.updatedAt = now(); writeAtomic(path.join(dir, 'state.json'), JSON.stringify(S, null, 2));
    // finished lanes also keep a copy in the registry, so merged and removed worktrees stay visible
    if (S.result) try { fs.mkdirSync(path.join(REG, 'final'), { recursive: true }); fs.writeFileSync(path.join(REG, 'final', `${id}.json`), JSON.stringify(S, null, 2)); } catch {} };
  // Write the first state, then bind the lane to the repo's plan (create, append or un-archive it): the plan
  // never appears on the dashboard before its lane shows as running. A resume of a lane the plan already
  // lists is left alone; a failure here only warns, it never stops the lane.
  save(true);
  if (!(opts.resume && laneAlreadyPlanned(repo, task))) {
    try { ensurePlan(repo, task, briefEarly); }
    catch (e) { process.stderr.write(`[${task}] plan warning: ${oneLine(String((e && e.message) || e), 200)}\n`); }
  }
  const phase = (p, activity) => { if (S.phase !== p) S.phases.push({ phase: p, at: now() }); S.phase = p; if (activity) S.activity = activity; save(true); };
  const syncCommits = () => {
    const out = git(repo, 'log', '--reverse', '--format=%h%x09%s', `${START}..HEAD`);
    S.commitLog = out ? out.split(/\r?\n/).map((l) => { const [hash, ...r] = l.split('\t'); return { hash, subject: oneLine(r.join(' '), 160) }; }) : [];
    S.commits = S.commitLog.length;
  };

  // The codearts server writes sign-in failures to server.log right at start. Read only its tail:
  // enough for the classifier, never the whole (long) log.
  const serverLogTail = () => {
    try {
      const f = path.join(dir, 'server.log'); const st = fs.statSync(f);
      const start = Math.max(0, st.size - 200 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch { return ''; }
  };
  // Called when a turn ends in an error: null (keep the old behaviour) or a plain-words key problem.
  const keyProblem = (model, error) => authProblem({ model, error, serverLog: serverLogTail() });

  const server = new Server(repo, path.join(dir, 'server.log'));
  let finished = false;
  const cleanup = () => { if (!finished) { finished = true; server.stop(); } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { S.result = S.result || 'killed'; S.activity = `killed by ${sig}`; save(true); cleanup(); process.exit(130); });

  // ---- event tracking ----
  const sess = {}; // sid -> { busy, sawBusy, lastAct, tools: Map, error, aborting }
  const sx = (sid) => (sess[sid] ||= { busy: false, sawBusy: false, lastAct: now(), tools: new Map(), error: null, aborting: false });
  const builderSessions = new Set(); // every session that ran the brief (build or fix): tokens bill as build
  const countedSteps = new Set();    // step-finish part ids already billed (a reconnect replays events)
  const roleOf = (sid) => (sid === S.reviewSession ? 'review' : builderSessions.has(sid) ? 'build' : 'other');
  const roles = new Map();       // messageID -> role
  const msgModel = new Map();    // messageID -> providerID/modelID of assistant messages
  const sessionModel = new Map(); // sid -> the model the runner sent there (fallback when a message carries none)
  const parts = new Map();       // partID -> { type, text, logged }
  const sent = new Set();        // texts we sent (to tell TUI-typed steering apart)
  const seenUser = new Set();    // user partIDs already logged

  const flushPart = (pid) => {
    const p = parts.get(pid); if (!p || p.logged) return; p.logged = true;
    const t = (p.text || '').trim(); if (!t) return;
    if (p.type === 'reasoning') L(`  ~ think: ${oneLine(t, 300)}`); else { L('  assistant:'); block('│ ', t); }
  };
  const toolInput = (tool, inp = {}) => oneLine(inp.command ?? inp.filePath ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? JSON.stringify(inp), 200);

  const onEvent = (e) => {
    const pr = e.properties || {};
    const sid = pr.sessionID || pr.part?.sessionID || pr.info?.sessionID;
    if (e.type !== 'server.heartbeat' && e.type !== 'message.part.delta') { try { fs.writeSync(raw, JSON.stringify({ t: now(), ...e }) + '\n'); } catch {} }
    if (e.type === 'server.heartbeat') return;
    if (sid && sess[sid]) { sx(sid).lastAct = now(); S.lastEventAt = now(); }
    switch (e.type) {
      case 'session.status': {
        if (!sid) break; const s = sx(sid); const st = pr.status?.type;
        if (st === 'busy' || st === 'retry') { s.busy = true; s.sawBusy = true; }
        if (st === 'idle') s.busy = false;
        if (st === 'retry') { const msg = `model service retry ${pr.status.attempt ?? ''}: ${oneLine(pr.status.message, 160)}`; L(`  ! ${msg}`); S.activity = msg; S.lastRetry = { at: now(), message: oneLine(pr.status.message, 200) }; }
        if (sid === S.activeSession) S.busy = s.busy;
        break;
      }
      case 'session.idle': if (sid) { sx(sid).busy = false; if (sid === S.activeSession) S.busy = false; } break;
      case 'session.error': {
        const err = pr.error || {}; const s = sid ? sx(sid) : null;
        const msg = `${err.name || 'error'}: ${oneLine(err.data?.message || err.message || JSON.stringify(err), 300)}`;
        if (s && s.aborting && /Abort/i.test(err.name || '')) break;
        if (s) s.error = err;
        S.errors.push({ at: now(), msg }); L(`  ! session error ${msg}`); break;
      }
      case 'message.updated': {
        const info = pr.info || {}; if (info.id) roles.set(info.id, info.role);
        if (info.id && info.role === 'assistant' && info.providerID && info.modelID) msgModel.set(info.id, `${info.providerID}/${info.modelID}`);
        if (info.role === 'assistant' && info.error && sid && !(sx(sid).aborting && /Abort/i.test(info.error.name || ''))) sx(sid).error = info.error;
        break;
      }
      case 'message.part.delta': {
        const known = parts.has(pr.partID); const p = parts.get(pr.partID) || { type: 'text', text: '' }; if (pr.field === 'text') p.text = (p.text || '') + (pr.delta || '');
        parts.set(pr.partID, p); if (sid === S.activeSession && !sx(sid).tools.size) S.activity = p.type === 'reasoning' ? 'thinking' : 'writing reply';
        // only a part already announced as text counts as progress: an unannounced delta may be reasoning
        if (sid === S.activeSession && known && p.type === 'text') S.lastTextAt = now();
        break;
      }
      case 'message.part.updated': {
        const part = pr.part || {}; const role = roles.get(part.messageID);
        if (part.type === 'text' && (role === 'user' || part.metadata?.isUserInput)) {
          if (!seenUser.has(part.id)) { seenUser.add(part.id); if (!sent.has((part.text || '').trim()) && !part.synthetic) { L('>> user (TUI or external):'); block('» ', part.text); S.steers.push({ at: now(), by: 'tui', text: oneLine(part.text, 500) }); } }
          break;
        }
        if (part.type === 'text' || part.type === 'reasoning') {
          const p = parts.get(part.id) || { type: part.type, text: '' }; p.type = part.type; if (typeof part.text === 'string' && part.text.length >= (p.text || '').length) p.text = part.text;
          parts.set(part.id, p); if (part.time?.end) flushPart(part.id);
          if (sid === S.activeSession && !sx(sid).tools.size) S.activity = part.type === 'reasoning' ? 'thinking' : 'writing reply';
          if (sid === S.activeSession && part.type === 'text') S.lastTextAt = now();
        } else if (part.type === 'tool') {
          const s = sid ? sx(sid) : null; const st = part.state || {}; const key = part.callID || part.id;
          if (st.status === 'running' && s && !s.tools.has(key)) {
            for (const k of parts.keys()) flushPart(k);
            s.tools.set(key, { tool: part.tool, since: now(), input: toolInput(part.tool, st.input) });
            L(`  > ${part.tool}  ${toolInput(part.tool, st.input)}`);
            // Global CodeArts permissions may allow external reads/writes; at least make them visible.
            const fp = st.input?.filePath ?? st.input?.path;
            if (typeof fp === 'string' && path.isAbsolute(fp) && !insideRepo(fp)) {
              S.outside.push({ at: now(), tool: part.tool, path: fp }); L(`  ! outside the repo: ${part.tool} ${fp}`);
            }
            if (sid === S.activeSession) S.lastToolAt = now();
          } else if ((st.status === 'completed' || st.status === 'error') && s) {
            const t = s.tools.get(key); s.tools.delete(key);
            const took = t ? ` (${dur(now() - t.since)})` : '';
            if (st.status === 'error') L(`  ! ${part.tool} failed${took}: ${oneLine(st.error, 300)}`);
            else L(`  < ${part.tool} ok${took}${st.output ? ': ' + oneLine(st.output, 200) : ''}`);
            if (sid === S.activeSession) S.lastToolAt = now();
          }
          if (sid === S.activeSession && s) { const t = [...s.tools.values()][0]; S.activity = t ? `tool ${t.tool}: ${oneLine(t.input, 80)}` : 'thinking'; S.tools = [...s.tools.values()].map((x) => ({ tool: x.tool, input: oneLine(x.input, 120), since: x.since })); }
        } else if (part.type === 'step-finish') {
          for (const k of parts.keys()) flushPart(k);
          if (part.id && !countedSteps.has(part.id)) {
            countedSteps.add(part.id);
            const model = msgModel.get(part.messageID) || sessionModel.get(sid) || 'codearts/hidden';
            addStepTokens(S.tokens, part.tokens);
            addStepTokens(S.tokensBy[roleOf(sid)], part.tokens);
            addStepTokens((S.tokensByModel[model] ||= emptyTokens()), part.tokens);
          }
        }
        break;
      }
      case 'permission.asked': case 'permission.updated': handlePermission(pr); break;
      case 'question.asked': {
        L(`  ? question asked: ${oneLine(pr.questions?.[0]?.question || JSON.stringify(pr), 200)} -> rejected (headless, no questions)`);
        server.api('POST', `/question/${pr.id}/reject`, {}).catch((err) => L(`  ! question reject failed: ${err.message}`)); break;
      }
      case 'todo.updated': if (Array.isArray(pr.todos) && (!sid || sid === S.buildSession || sid === S.activeSession)) S.todos = pr.todos.map((t) => ({ text: oneLine(t.content, 200), status: t.status })); break;
      case 'file.edited': { const f = pr.file && path.relative(repo, path.resolve(repo, pr.file)).replace(/\\/g, '/'); if (f && !f.startsWith('..') && !path.isAbsolute(f) && !/^(tasks\/|\.codeartsdoer)/.test(f) && !S.files.includes(f)) { S.files.push(f); if (S.files.length > 200) S.files.shift(); } break; }
      case 'tui.toast.show': if (pr.variant === 'error' || pr.variant === 'warning') L(`  ! toast ${pr.variant}: ${oneLine(pr.message, 200)}`); break;
    }
    save();
  };

  // Permission policy: never leave a prompt hanging. Inside the repo or temp: allow once.
  // Elsewhere, .env reads and doom loops: reject with a reason the model can act on.
  const handledPerm = new Set();
  function handlePermission(p) {
    if (!p.id || handledPerm.has(p.id)) return; handledPerm.add(p.id);
    const kind = p.permission || p.type || 'unknown';
    const pats = [].concat(p.patterns || p.pattern || []).map(String);
    let reply = 'once', why = '';
    if (kind === 'external_directory' && !(pats.length && pats.every(insideRepo))) { reply = 'reject'; why = `Stay inside the repo ${repo}; do not touch other folders.`; }
    else if (kind === 'doom_loop') { reply = 'reject'; why = 'You repeated the same tool call several times. Stop, think about why it fails, and try a different approach.'; }
    else if (kind === 'read' && pats.some((x) => /\.env/i.test(x))) { reply = 'reject'; why = 'Do not read .env files.'; }
    S.permissions.push({ at: now(), kind, patterns: pats.slice(0, 3), reply });
    L(`  ? permission ${kind} ${oneLine(pats.join(' '), 120)} -> ${reply}${why ? ' (' + why + ')' : ''}`);
    server.api('POST', `/permission/${p.id}/reply`, { reply, ...(why ? { message: why } : {}) })
      .catch(() => server.api('POST', `/session/${p.sessionID}/permissions/${p.id}`, { response: reply }))
      .catch((err) => L(`  ! permission reply failed: ${err.message}`));
  }

  // ---- session helpers ----
  const newSession = async (title) => (await server.api('POST', '/session', { title })).id;
  const send = async (sid, text, model, agent) => {
    if (model) sessionModel.set(sid, model);
    sent.add(text.trim()); const s = sx(sid); s.error = null; s.sawBusy = false; s.lastAct = now(); s.sentAt = now();
    S.activeSession = sid; S.busy = true;
    S.turnStartAt = now(); S.lastToolAt = 0; S.lastTextAt = 0;
    await server.api('POST', `/session/${sid}/prompt_async`, { model: splitModel(model), ...(agent ? { agent } : {}), parts: [{ type: 'text', text }] });
  };
  const abort = async (sid) => {
    const s = sx(sid); s.aborting = true;
    try { await server.api('POST', `/session/${sid}/abort`, {}); } catch (err) { L(`  ! abort failed: ${err.message}`); }
    for (let i = 0; i < 30 && s.busy; i++) await sleep(1000);
    s.tools.clear(); s.busy = false; s.aborting = false;
  };
  const stopFile = path.join(dir, 'STOP');
  // A kick is a human decision delivered by file: {at, mode: turn|fresh|server|now, text, by}.
  // The supervisor consumes it at the next poll (2 s) or during a backoff wait.
  const kickFile = path.join(dir, 'KICK');
  const takeKick = () => {
    if (!fs.existsSync(kickFile)) return null;
    const k = readJSON(kickFile);
    try { fs.rmSync(kickFile, { force: true }); } catch {}
    return k && k.mode ? k : { mode: 'turn', text: '', by: 'unknown', at: now() };
  };
  let curModel = BUILD, curAgent;
  const pumpInbox = async (sid) => {
    let files = []; try { files = fs.readdirSync(path.join(dir, 'inbox')).filter((f) => f.endsWith('.txt')).sort(); } catch {}
    for (const f of files) {
      const fp = path.join(dir, 'inbox', f); let text = ''; try { text = fs.readFileSync(fp, 'utf8').trim(); fs.rmSync(fp); } catch { continue; }
      if (!text) continue;
      L('>> steer:'); block('» ', text); S.steers.push({ at: now(), by: 'ca steer', phase: S.phase, text: oneLine(text, 500) });
      process.stdout.write(`[${task} ${hhmmss()}] steer received: ${oneLine(text, 100)}\n`);
      await send(sid, `Message from the lead (steering, applies on top of the brief): ${text}`, curModel, curAgent);
    }
    return files.length;
  };

  // Wait for one turn: idle, error, stall (watchdog), server death, stop or timeout.
  async function waitTurn(sid) {
    const s = sx(sid); let lastPoll = 0, lastCommitCheck = 0; let prevTick = now();
    for (;;) {
      await sleep(2000);
      const tickMs = now();
      // A gap far longer than the tick is the machine sleeping, not the model stalling: the silence
      // was the sleep. Reset every watchdog timer and reconnect SSE, so nothing aborts on wake.
      if (detectSleep(prevTick, tickMs, 2000)) {
        L(`  ! woke from sleep after ${dur(tickMs - prevTick)}`);
        s.lastAct = tickMs; S.lastEventAt = tickMs;
        S.turnStartAt = tickMs; S.lastToolAt = tickMs; S.lastTextAt = tickMs;
        for (const t of s.tools.values()) t.since = tickMs;
        if (server.alive) { try { await server.api('GET', '/global/health', null, 3000); } catch {} try { server.ac?.abort(); } catch {} }
        save(true);
      }
      prevTick = tickMs;
      if (fs.existsSync(stopFile)) { L('== stop requested'); await abort(sid); return { kind: 'stopped' }; }
      const k = takeKick();
      if (k) {
        L(`== kick (${k.mode}) from ${k.by}${k.text ? ': ' + oneLine(k.text, 160) : ''}`);
        await abort(sid);
        if (k.mode === 'server') {
          killTree(server.child?.pid);
          for (let i = 0; i < 15 && server.alive; i++) await sleep(1000);
          return { kind: 'server-died', kicked: true, mode: 'server', text: k.text || '', by: k.by };
        }
        return { kind: 'kick', mode: k.mode, text: k.text || '', by: k.by };
      }
      if (now() - T0 > CFG.laneTimeout * 1000) { L('== lane timeout'); await abort(sid); return { kind: 'timeout' }; }
      if (!server.alive) return { kind: 'server-died' };
      await pumpInbox(sid);
      if (now() - lastCommitCheck > 5000) { lastCommitCheck = now(); syncCommits(); }
      if (now() - lastPoll > 15000 || !S.sse) { // backup for missed SSE events
        lastPoll = now();
        try {
          const st = (await server.api('GET', '/session/status', null, 10000))[sid]?.type;
          if (st === 'busy' || st === 'retry') { s.busy = true; s.sawBusy = true; } else if (s.sawBusy || now() - s.sentAt > 20000) s.busy = false;
        } catch {}
      }
      S.busy = s.busy; save();
      if (!s.busy && (s.sawBusy || now() - s.sentAt > 60000)) {
        for (const k of parts.keys()) flushPart(k);
        if (!s.sawBusy) return { kind: 'no-start' };
        return s.error ? { kind: 'error', error: s.error } : { kind: 'idle' };
      }
      const tools = [...s.tools.values()];
      const oldest = tools.reduce((m, t) => Math.min(m, t.since), Infinity);
      if (tools.length && now() - oldest > CFG.toolStall * 1000) {
        const t = tools.find((x) => x.since === oldest);
        L(`== watchdog: tool ${t.tool} running ${dur(now() - oldest)} (> ${CFG.toolStall}s): abort and resume`); await abort(sid);
        return { kind: 'stalled', what: `tool ${t.tool} ran over ${CFG.toolStall}s: ${oneLine(t.input, 120)}` };
      }
      if (!tools.length && s.busy && now() - s.lastAct > CFG.stall * 1000) {
        L(`== watchdog: no model activity for ${dur(now() - s.lastAct)} (> ${CFG.stall}s): abort and resume`); await abort(sid);
        return { kind: 'stalled', what: `model silent over ${CFG.stall}s` };
      }
      const ts = thinkStall({ busy: s.busy, toolsRunning: tools.length, turnStartAt: S.turnStartAt, lastToolAt: S.lastToolAt, lastTextAt: S.lastTextAt, now: now(), thinkS: CFG.think });
      if (ts.stall) {
        L(`== watchdog: thinking ${dur(ts.ageMs)} with no tool call (> ${CFG.think}s): abort and nudge`); await abort(sid);
        return { kind: 'think', what: `thinking ${dur(ts.ageMs)} with no tool call`, nudge: ts.nudge };
      }
    }
  }
  // CodeArts retries a rate limit itself and then aborts the turn: the error is a bare
  // MessageAbortedError, the reason is in the retry events just before it.
  const recentRate = () => !!(S.lastRetry && now() - S.lastRetry.at < 120000 && /429|rate.?limit|too many requests|quota|Queuing/i.test(S.lastRetry.message || ''));
  const classify = (err) => {
    const m = JSON.stringify(err || {});
    if (/Abort/i.test(m) && recentRate()) return 'rate';
    if (/Authentication failed|MISSING_CREDENTIAL|\b401\b|\b403\b|AK\/SK|invalid.*credential/i.test(m)) return 'auth';
    if (/\b429\b|rate.?limit|too many requests|quota|Queuing/i.test(m)) return 'rate';
    if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|\b50[0234]\b|Cannot connect|network/i.test(m)) return 'transport';
    return 'other';
  };
  let pendingKick = null; // a kick consumed during backoff: its mode applies to the resume
  const waitInterruptible = async (sec, label) => {
    const until = now() + sec * 1000;
    while (now() < until) {
      if (fs.existsSync(stopFile)) return false;
      const k = takeKick();
      if (k) { L(`== backoff skipped by ${k.by}`); pendingKick = k; return true; }
      S.activity = `${label}: ${dur(until - now())} left`; save(); await sleep(1000);
    }
    return true;
  };

  // Drive a phase until its turn ends cleanly; resume interrupted turns in the same session.
  async function drive(sid, model, agent, label, resumeText, freshSession) {
    curModel = model; curAgent = agent;
    if (label === 'build' || label === 'fix') builderSessions.add(sid);
    let interruptions = 0, sameSessionFails = 0, thinkStalls = 0, rateHits = 0, rateWaited = 0;
    for (;;) {
      const o = await waitTurn(sid);
      if (o.kind === 'idle') return { ok: true, sid };
      if (o.kind === 'stopped' || o.kind === 'timeout') return { ok: false, sid, reason: o.kind };
      if (o.kind === 'kick' || (o.kind === 'server-died' && o.kicked)) {
        // A kick is a human decision, not a failure: no retry count, no backoff.
        const kmode = o.mode || 'server';
        S.interruptions.push({ at: now(), phase: label, kind: 'kick', what: `kick (${kmode}) from ${o.by}${o.text ? ': ' + oneLine(o.text, 160) : ''}` }); save(true);
        if (o.kind === 'server-died') {
          L('== kick: codearts server killed; restarting'); phase('restart', 'restarting codearts server');
          try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
        }
        phase(label, 'resuming after kick');
        const extra = o.text ? `\n\nMessage from the lead: ${o.text}` : '';
        if (kmode === 'fresh' && freshSession) {
          sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
          if (label === 'build' || label === 'fix') builderSessions.add(sid);
          say(`kick: switching to a fresh session ${sid}`);
          await send(sid, freshSession('kick', o.text || 'the lead asked for a clean restart') + extra, model, agent);
        } else {
          await send(sid, resumeText('kick', `${kmode} kick from ${o.by}`) + extra, model, agent);
        }
        if (label === 'build' || label === 'fix') S.buildSession = sid;
        continue;
      }
      const rawCls = o.kind === 'error' ? classify(o.error) : o.kind;
      const what = o.kind === 'error' ? `${o.error.name || 'error'}: ${oneLine(o.error.data?.message || o.error.message || '', 200)}` : (o.what || o.kind);
      // The transport itself is down (DNS, connect, reset, unreachable, fetch failed): wait for the
      // network instead of spending a retry. Auth problems are handled separately below.
      const netErr = o.kind === 'error' && rawCls !== 'auth' && isNetworkError(what);
      const cls = netErr ? 'transport' : rawCls;
      S.interruptions.push({ at: now(), phase: label, kind: cls, what }); save(true);
      // A rejected key can look like a plain 503 (AK/SK) or a maas/ authorization error: the classifier
      // reads the server log, so catch it here even when the error class is not 'auth'. End at once.
      if (o.kind === 'error') {
        const ap = keyProblem(model, what);
        if (ap) { L(`  ! ${ap.message}`); S.keysMessage = ap.message; return { ok: false, sid, reason: 'auth', exit: 3, what: ap.message, keys: ap.message }; }
      }
      if (cls === 'auth') return { ok: false, sid, reason: 'auth', exit: 3, what };
      if (netErr) {
        const netWaitS = CFG.netWait > 0 ? CFG.netWait : 1800;
        let netLoggedAt = 0;
        const onWait = ({ tries, waitedMs }) => {
          S.activity = `offline: waiting for the network (${dur(waitedMs)})`;
          // The silence is the outage, not the model: keep ca status from reading STALLED while we wait.
          S.lastEventAt = now(); S.turnStartAt = now(); S.lastToolAt = now(); S.lastTextAt = now();
          if (now() - netLoggedAt >= 60000) { netLoggedAt = now(); L(`  ! network down, waiting (try ${tries})`); }
          save();
        };
        onWait({ tries: 0, waitedMs: 0 });
        say(`network down (${oneLine(what, 140)}); waiting up to ${netWaitS}s (no retry used)`);
        const net = await waitOnline({ timeoutMs: netWaitS * 1000, onWait, shouldStop: () => fs.existsSync(stopFile) });
        if (net.stopped) return { ok: false, sid, reason: 'stopped' };
        if (net.online) {
          say(`network is back after ${dur(net.waitedMs)}; resuming the same session (no retry used)`);
          phase(label, 'resuming after network returned');
          await send(sid, resumeText('transport', `the network was down (${what})`), model, agent);
          if (label === 'build' || label === 'fix') S.buildSession = sid;
          continue;
        }
        L(`  ! still offline after ${dur(net.waitedMs)}; ending the phase as a transport failure`);
      }
      if (cls === 'other' && o.kind === 'error' && /Abort/i.test(o.error.name || '')) { /* user aborted in TUI: resume */ }
      // Rate limits are not failures: own budget (RATE_WAIT_S, default 1800 s), jittered backoff, no retry count.
      if (cls === 'rate' && rateWaited < CFG.rateWait) {
        rateHits++; const wait = Math.min(300, CFG.rateBackoff * 2 ** (rateHits - 1)) + Math.floor(Math.random() * Math.min(30, CFG.rateBackoff)); rateWaited += wait;
        say(`rate limited (${what}); waiting ${wait}s before resuming (${Math.round(rateWaited / 60)} of ${Math.round(CFG.rateWait / 60)} min rate budget)`);
        S.lastRetry = null; phase('backoff');
        if (!(await waitInterruptible(wait, 'rate limited, waiting'))) return { ok: false, sid, reason: 'stopped' };
        phase(label, 'resuming after rate limit');
        const rk = pendingKick; pendingKick = null; // a kick during the wait only ends the wait early
        await send(sid, resumeText('rate', 'the model service was rate limited; continue where you stopped') + (rk?.text ? `

Message from the lead: ${rk.text}` : ''), model, agent);
        continue;
      }
      if (++interruptions > CFG.retries) return { ok: false, sid, reason: `gave up after ${CFG.retries} interruptions (last: ${cls}: ${what})` };
      say(`interrupted (${cls}: ${what}); resume ${interruptions}/${CFG.retries}`);
      if (o.kind === 'server-died') {
        L('== codearts server died: restarting'); phase('restart', 'restarting codearts server');
        try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
      }
      const backoff = cls === 'think' ? 5 : cls === 'rate' || cls === 'transport' ? 120 * interruptions : 15;
      phase('backoff');
      if (!(await waitInterruptible(backoff, `backoff after ${cls}`))) return { ok: false, sid, reason: 'stopped' };
      phase(label, 'resuming');
      const kick = pendingKick; pendingKick = null;
      if (kick?.mode === 'server') {
        L('== kick: codearts server killed; restarting'); phase('restart', 'restarting codearts server');
        try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
        phase(label, 'resuming after kick');
      }
      const extra = kick?.text ? `\n\nMessage from the lead: ${kick.text}` : '';
      if (kick && kick.mode === 'fresh' && freshSession) {
        sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
        if (label === 'build' || label === 'fix') builderSessions.add(sid);
        say(`kick: switching to a fresh session ${sid}`);
        await send(sid, freshSession('kick', kick.text || 'the lead asked for a clean restart') + extra, model, agent);
      } else if (kick) {
        await send(sid, resumeText('kick', `${kick.mode} kick from ${kick.by}`) + extra, model, agent);
      } else if (o.kind === 'think') {
        let switched = false;
        if (++thinkStalls >= 2 && (label === 'build' || label === 'fix') && FALLBACK && FALLBACK !== 'none' && FALLBACK !== model) {
          say(`thinking stalled ${thinkStalls} times on ${model}: switching the builder to ${FALLBACK} (same session, context kept)`);
          S.modelSwitches = [...(S.modelSwitches || []), { at: now(), from: model, to: FALLBACK, why: `${thinkStalls} thinking stalls` }];
          model = FALLBACK; curModel = model; buildModel = model; S.models.build = model; thinkStalls = 0; interruptions = 0; save(true);
          switched = true;
        }
        if (switched) await waitForSlot(model);
        await send(sid, o.nudge, model, agent);
      } else if (++sameSessionFails >= 2 && freshSession) {
        sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
        if (label === 'build' || label === 'fix') builderSessions.add(sid);
        say(`switching to a fresh session ${sid}`); await send(sid, freshSession(cls, what), model, agent);
      } else {
        await send(sid, resumeText(cls, what), model, agent);
      }
      if (label === 'build' || label === 'fix') S.buildSession = sid;
    }
  }

  // Files already dirty before the lane started are not this lane's fault: leave them out of the gate.
  const dirty = () => dirtyAll().filter((l) => !PRE_DIRTY.has(l));
  const runCheck = (cmd) => new Promise((res) => {
    const t0 = now(); let out = '';
    const ch = spawn('bash', ['-c', cmd], { cwd: repo, env: { ...process.env, CA_LANE: id }, windowsHide: true });
    const timer = setTimeout(() => { out += `\n[runner: timed out after ${CFG.checkTimeout}s]`; killTree(ch.pid); }, CFG.checkTimeout * 1000);
    ch.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    ch.stderr.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    ch.on('close', (code) => { clearTimeout(timer); res({ code: code ?? 1, out, ms: now() - t0 }); });
    ch.on('error', (e) => { clearTimeout(timer); res({ code: 127, out: String(e), ms: now() - t0 }); });
  });
  async function gates() {
    const d = dirty();
    if (d.length) {
      S.gates.push({ at: now(), gate: 'git clean', ok: false, detail: d.slice(0, 5).join(', ') }); L(`== gate git clean: FAIL (${d.length} changed)`);
      return { ok: false, what: 'uncommitted changes', message: `Runner check failed: the turn ended with uncommitted changes:\n${d.slice(0, 20).join('\n')}\nFinish the step these belong to, run its checks, and commit. Do not leave work uncommitted. If a commit fails, put the exact error in your reply.` };
    }
    S.gates.push({ at: now(), gate: 'git clean', ok: true }); L('== gate git clean: ok');
    for (const c of checks) {
      phase('gate', `running check: ${oneLine(c, 80)}`); L(`== gate check: ${c}`);
      const r = await runCheck(c);
      const tail = r.out.trim().split(/\r?\n/).slice(-40).join('\n');
      S.gates.push({ at: now(), gate: c, ok: r.code === 0, code: r.code, ms: r.ms }); save(true);
      if (r.code !== 0) { L(`== gate check FAIL (exit ${r.code}, ${dur(r.ms)})`); block('| ', tail); return { ok: false, what: `check failed: ${c}`, message: `Runner check failed: \`${c}\` exited ${r.code}. Last output:\n\`\`\`\n${tail}\n\`\`\`\nFind the cause, fix it, rerun the check, and commit the fix.` }; }
      L(`== gate check ok (${dur(r.ms)})`);
    }
    return { ok: true };
  }
  const contBrief = (cls, what) => `${brief}\n\n## Continuation (previous session stopped: ${cls}: ${what})\nAlready committed since the start:\n${git(repo, 'log', '--oneline', `${START}..HEAD`) || '(nothing)'}\nUncommitted changes:\n${git(repo, 'status', '--short') || '(none)'}\nCheck what is done, finish only the remaining steps, commit after each.`;
  const resumeMsg = (cls, what) => `Your previous turn was interrupted (${cls}: ${what}). Run \`git log --oneline\` and \`git status\` to see where you are, then continue with the remaining steps of the brief. Commit after each step that works.`;

  // Model slots: before a build session starts (and after a fallback model switch), wait until
  // fewer than the model's cap of the OTHER running lanes use it. A crowded model must not get
  // another session. While queued the lane shows it in its activity and ca stop still works.
  let queuedTotal = 0;
  const waitForSlot = async (model) => {
    const limits = parseLimits(process.env.CA_MAX_LANES_PER_MODEL || '');
    const t0 = now(); let logged = false;
    for (;;) {
      // Only lanes that are alive and working hold a slot: queued lanes (or every lane over the limit
      // would wait forever) and DEAD lanes (supervisor gone) do not.
      const running = lanes().filter((l) => !l.s.result && l.id !== id && alive(l.s.pid) && !/^queued/.test(l.s.activity || '')).map((l) => (l.s.models && l.s.models.build) || '').filter(Boolean);
      const slot = laneSlots({ model, running, limits });
      if (slot.ok) break;
      if (!logged) { logged = true; say(`queued: ${slot.reason}`); L(`  ! queued: ${slot.reason}`); }
      S.activity = `queued: ${slot.reason}`; S.queuedMs = queuedTotal + (now() - t0);
      // Waiting for a slot is not a stall: keep ca status from reading STALLED while we queue.
      S.lastEventAt = now(); S.turnStartAt = now(); S.lastToolAt = now(); S.lastTextAt = now(); save();
      if (fs.existsSync(stopFile)) { const e = new Error('stopped'); e.caStop = true; throw e; }
      await sleep(20000);
    }
    if (logged) { queuedTotal += now() - t0; S.queuedMs = queuedTotal; say(`slot free for ${model} after ${dur(now() - t0)}`); save(true); }
  };

  // ---- run ----
  let exitCode = 1, reason = '', review = null;
  server.events(onEvent, (up) => { S.sse = up; }).catch(() => {});
  try {
    say(`lane ${id}: starting codearts server in ${repo}`);
    await server.start();
    S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; save(true);
    say(`server ${server.url} (codearts ${server.version}); watch: ca tail ${id} -f | ca attach ${id} | ca dash`);
    ensureDash().then((u) => u && L(`dashboard: ${u}`));
    if (PRE_DIRTY.size) { S.preDirty = [...PRE_DIRTY].slice(0, 20); say(`note: ${PRE_DIRTY.size} file(s) were already dirty before the lane (excluded from the git gate): ${S.preDirty.slice(0, 5).join(', ')}`); }

    // A wrong AK/SK is written to server.log at sign-in, before the first model call. Give the log up
    // to 3 s, then end the lane at once instead of retrying for a minute. No retry, no backoff.
    let startKeys = null;
    for (let i = 0; i < 30 && !startKeys; i++) { startKeys = keyProblem(buildModel, ''); if (!startKeys) await sleep(100); }
    if (startKeys) { L(`  ! ${startKeys.message}`); S.keysMessage = startKeys.message; throw Object.assign(new Error('auth'), { caAuth: true }); }

    // BUILD (first wait for a free slot on the build model: a crowded model must not start a session)
    await waitForSlot(buildModel);
    let sid = await newSession(`${task} build`); S.buildSession = sid; builderSessions.add(sid); S.attempt = 1;
    phase('build', 'sending brief'); L(`== build (${BUILD}) session ${sid}; ${checks.length} CHECK lines, ${stepCount} steps`);
    let first = brief;
    if (resumed) {
      const done = git(repo, 'log', '--reverse', '--format=%h %s', `${START}..HEAD`);
      const nf = path.join(repo, 'tasks', `${task}.resume.md`); let notes = fs.existsSync(nf) ? fs.readFileSync(nf, 'utf8').trim() : '';
      const rnf = path.join(dir, 'resume-note.txt'); const rn = fs.existsSync(rnf) ? fs.readFileSync(rnf, 'utf8').trim() : '';
      if (rn) { try { fs.rmSync(rnf, { force: true }); } catch {} notes = `${rn}\n${notes}`.trim(); }
      S.resumedBy = process.env.CA_RESUMED_BY || '';
      first += `\n\n---\nRESUMED RUN ${S.resumes + 1}. The previous run ended ${resultOf(resumed)}${resumed.reason ? ' (' + resumed.reason + ')' : ''}. These commits are already in the repo; do not redo them:\n${done || '(none)'}\n`
        + (notes ? `\nNotes from the lead (apply these first, commit each as "fix: <summary>"):\n${notes}\n` : '')
        + 'Then continue with the first numbered step that has no "step N:" commit, keeping the same commit subjects.';
      say(`resuming run ${S.resumes + 1} from ${START.slice(0, 7)} (${done ? done.split(/\r?\n/).length : 0} commits kept${notes ? ', lead notes' : ''})`);
      if (S.resumedBy) say(`resumed by ${S.resumedBy}`);
    }
    await send(sid, first, BUILD);
    for (;;) {
      const r = await drive(sid, buildModel, undefined, S.fixes ? 'fix' : 'build', resumeMsg, contBrief);
      sid = r.sid; S.buildSession = sid;
      if (!r.ok) { reason = r.reason; exitCode = r.exit || 1; if (r.keys) S.keysMessage = r.keys; break; }
      if (await pumpInbox(sid)) continue; // a steer arrived right at the end: let the builder handle it
      phase('gate', 'running gates');
      const g = await gates();
      if (g.ok) { reason = ''; exitCode = 0; break; }
      if (++S.fixes > CFG.fixes) { reason = `gates still failing after ${CFG.fixes} fix rounds: ${g.what}`; exitCode = 1; break; }
      say(`gate failed (${g.what}); fix round ${S.fixes}/${CFG.fixes}`);
      phase('fix', `fix round ${S.fixes}`); await send(sid, g.message, buildModel);
    }
    syncCommits();

    // REVIEW (read-only plan agent, different model)
    if (exitCode === 0 && !CFG.noReview) {
      const rf = path.join(repo, 'tasks', `${task}.review.md`);
      const rb = fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8')
        : fs.readFileSync(path.join(SKILL, 'templates', 'review.md'), 'utf8').replaceAll('{TASK}', task).replaceAll('{START}', START);
      const head0 = git(repo, 'rev-parse', 'HEAD');
      const rsid = await newSession(`${task} review`); S.reviewSession = rsid;
      phase('review', 'reviewing'); L(`== review (${REVIEW}, read-only plan agent) session ${rsid}`);
      await send(rsid, rb, REVIEW, 'plan');
      const rr = await drive(rsid, REVIEW, 'plan', 'review', () => 'Your previous turn was interrupted. Finish the review: the numbered item list and the final VERDICT line.');
      if (!rr.ok && rr.reason === 'auth') { reason = 'auth'; exitCode = 3; if (rr.keys) S.keysMessage = rr.keys; }
      let text = '';
      try {
        const msgs = await server.api('GET', `/session/${rr.sid}/message`);
        const last = [...msgs].reverse().find((m) => m.info.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text?.trim()));
        text = last ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim() : '';
      } catch (err) { L(`! could not read review: ${err.message}`); }
      fs.writeFileSync(path.join(dir, 'review.md'), text || `(no review text: ${rr.reason || 'empty'})`);
      const vm = text.match(/VERDICT:\s*(ready|needs fixes)/i);
      S.verdict = vm ? vm[1].toLowerCase() : `missing${rr.ok ? '' : ' (' + rr.reason + ')'}`;
      const warn = [];
      if (git(repo, 'rev-parse', 'HEAD') !== head0) warn.push('reviewer committed changes');
      if (dirty().length) warn.push('reviewer left changes in the work tree');
      if (warn.length) { S.errors.push({ at: now(), msg: warn.join('; ') }); L(`! ${warn.join('; ')}`); }
      review = text;
    }
  } catch (err) {
    if (err && err.caAuth) { reason = 'auth'; exitCode = 3; }
    else if (err && err.caStop) { reason = 'stopped'; exitCode = 1; L('== stopped while queued for a model slot'); }
    else { reason = `runner error: ${err.message}`; exitCode = 1; L(`! ${reason}`); }
  }

  // ---- summary ----
  syncCommits();
  // A lane that reaches LANE_TIMEOUT is paused, not failed: the safeguard worked and `--resume` continues it in place.
  S.result = exitCode === 0 ? (S.verdict && S.verdict !== 'ready' && !CFG.noReview ? 'needs review' : 'done') : (reason === 'stopped' ? 'stopped' : reason === 'timeout' ? 'paused' : 'failed');
  const finalExit = S.result === 'needs review' ? 4 : S.result === 'paused' ? 5 : exitCode;
  S.reason = reason; S.exitCode = finalExit; S.phase = 'finished'; S.activity = S.result; S.busy = false; S.finishedAt = now();
  const log = git(repo, 'log', '--oneline', `${START}..HEAD`);
  const left = dirty();
  const reviewBody = review ? (() => { const ls = review.split(/\r?\n/); const i = ls.findIndex((l) => /^\s*1\.\s/.test(l)); return ls.slice(i >= 0 ? i : Math.max(0, ls.length - 16)).filter((l) => l.trim() && !/^\s*VERDICT:/i.test(l)).slice(0, 24).join('\n'); })() : '';
  const modelBits = Object.entries(S.tokensByModel).map(([m, t]) => `${m} ${tokenTotal(t)}`).join(', ');
  const byModel = modelBits ? ` | by model: ${modelBits}` : '';
  const md = [
    `=== lane ${id}: ${S.result.toUpperCase()}${reason ? ' (' + reason + ')' : ''} in ${dur(now() - T0)} ===`,
    `models: build ${buildModel}, review ${REVIEW} | tokens in ${S.tokens.input} out ${S.tokens.output} (cache read ${S.tokens.cacheRead}) over ${S.tokens.steps} steps | total ${tokenTotal(S.tokens)} | by agent: build ${tokenTotal(S.tokensBy.build)}, review ${tokenTotal(S.tokensBy.review)}, other ${tokenTotal(S.tokensBy.other)}${byModel}`,
    `commits ${S.commits} (brief has ${stepCount} numbered lines):`, log || '(none)',
    left.length ? `UNCOMMITTED: ${left.slice(0, 8).join(', ')}` : 'work tree: clean',
    ...(PRE_DIRTY.size ? [`already dirty before the lane (ignored): ${[...PRE_DIRTY].slice(0, 8).join(', ')}`] : []),
    `gates: ${S.gates.length ? S.gates.map((g) => `${g.gate} ${g.ok ? 'ok' : 'FAIL'}`).join(' | ') : '(none ran)'} | fix rounds ${S.fixes}`,
    `interruptions: ${S.interruptions.length ? S.interruptions.map((x) => `${x.phase}/${x.kind}: ${x.what}`).join('; ') : 'none'}${S.queuedMs ? ` (queued ${dur(S.queuedMs)} for a model slot)` : ''}`,
    ...(S.keysMessage ? [`keys: ${S.keysMessage}`] : []),
    ...(S.modelSwitches?.length ? [`model switch: ${S.modelSwitches.map((x) => `${x.from} -> ${x.to} (${x.why})`).join('; ')}`] : []),
    `steering: ${S.steers.length ? S.steers.map((x) => `[${x.by}] ${oneLine(x.text, 160)}`).join(' / ') : 'none'}`,
    `outside-repo file access: ${S.outside.length ? S.outside.slice(0, 5).map((x) => `${x.tool} ${x.path}`).join(', ') : 'none'}`,
    `permissions: ${S.permissions.length ? S.permissions.map((x) => `${x.kind}->${x.reply}`).join(', ') : 'none asked'}`,
    ...(S.errors.length ? [`errors: ${S.errors.slice(-3).map((x) => x.msg).join(' / ')}`] : []),
    '--- review ---', reviewBody || '(no review)', `VERDICT: ${S.verdict || 'none'}`,
    ...(S.result === 'paused' ? [`paused at the time limit (LANE_TIMEOUT ${CFG.laneTimeout}s). Continue in place: ca lane ${repo} ${task} --resume   (optional lead notes: tasks/${task}.resume.md)`] : []),
    `files: ${dir} (live.log, review.md, events.jsonl)`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n');
  L(`== finished: ${S.result}${reason ? ' (' + reason + ')' : ''}`);
  save(true);
  process.stdout.write('\n' + md + '\n');
  process.stdout.write(`CA_RESULT ${JSON.stringify({ lane: id, result: S.result, verdict: S.verdict || '', exit: finalExit, ...(S.keysMessage ? { error: S.keysMessage } : {}), summaryPath: path.join(dir, 'summary.md') })}\n`);
  cleanup();
  process.exit(finalExit);
}

// `ca lane <repo> <task> --detach`: same lane, background, log file, returns at once.
function cmdDetach(repoArg, task) {
  if (!repoArg || !task) die('usage: ca lane <repo> <task> [--detach]', 2);
  const repo = path.resolve(repoArg);
  const briefFile = path.join(repo, 'tasks', `${task}.md`);
  if (!task || !fs.existsSync(briefFile)) die(`usage: ca lane <repo> <task>   (needs ${briefFile})`, 2);
  const id = laneId(repo, task);
  const logFile = path.join(repo, 'tasks', `${task}.lane.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'lane', repoArg, task, ...(process.argv.includes('--resume') ? ['--resume'] : [])], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  // Return only once the lane is really running (its state.json carries this supervisor's pid), so an
  // immediate `ca wait` / ca_wait finds it; if it dies at startup, say why and pass its exit code on.
  const stateFile = path.join(repo, 'tasks', `${task}.lane`, 'state.json');
  let exited = null; child.on('exit', (code) => { exited = code ?? 1; });
  const t0 = now();
  const tick = () => {
    const s = readJSON(stateFile);
    if (s && s.pid === child.pid && fs.existsSync(path.join(REG, `${id}.json`))) {
      child.unref();
      console.log(`lane ${id} started (pid ${child.pid}). Log: ${logFile}. Wait: ca wait ${id}. Watch: ${dashUrl()}`);
      process.exit(0);
    }
    if (exited !== null) {
      let tail = ''; try { tail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n'); } catch {}
      console.error(`lane ${id} did not start (exit ${exited}):\n${tail}`);
      process.exit(exited || 1);
    }
    if (now() - t0 > 30000) { child.unref(); console.log(`lane ${id} is still starting (pid ${child.pid}). Log: ${logFile}. Wait: ca wait ${id}`); process.exit(0); }
    setTimeout(tick, 200);
  };
  tick();
}

// ---------- control commands ----------
function lanes() {
  let files = []; try { files = fs.readdirSync(REG).filter((f) => f.endsWith('.json')); } catch {}
  // Skip non-lane json in the registry (acks.json): a registration always carries a string dir.
  return files.map((f) => { const r = readJSON(path.join(REG, f)); if (!r || typeof r.dir !== 'string') return null; const s = readJSON(path.join(r.dir, 'state.json')) || readJSON(path.join(REG, 'final', f)); return s ? { ...r, s } : null; }).filter(Boolean)
    .sort((a, b) => (b.s.startedAt || 0) - (a.s.startedAt || 0));
}
// Lanes written before 'paused' existed recorded a timeout as failed (timeout).
function resultOf(s) { return s && s.result === 'failed' && s.reason === 'timeout' ? 'paused' : s && s.result; }
function health(s) {
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
function pickOne(items, q, idOf, taskOf) {
  if (!q) return { hit: null };
  const exact = items.find((x) => idOf(x) === q) || (taskOf ? items.find((x) => taskOf(x) === q) : null);
  if (exact) return { hit: exact };
  const subs = items.filter((x) => idOf(x).includes(q));
  if (subs.length === 1) return { hit: subs[0] };
  if (subs.length > 1) return { hit: null, matches: subs.map(idOf) };
  return { hit: null };
}
function findLane(q) {
  const all = lanes();
  if (!q) { const runningLanes = all.filter((l) => !l.s.result); if (runningLanes.length === 1) return runningLanes[0]; die('which lane? ' + all.map((l) => l.id).join(', '), 2); }
  const r = pickOne(all, q, (l) => l.id, (l) => l.task);
  if (r.matches) die(`ambiguous lane "${q}": matches ${r.matches.join(', ')}; use the full id`, 2);
  if (!r.hit) die(`no lane matches "${q}". Lanes: ${all.map((l) => l.id).join(', ') || '(none)'}`, 2);
  return r.hit;
}
// Server side acknowledgement of finished lanes (Control room). acks.json maps a lane id to the
// finishedAt that was acknowledged, so a lane resumed and finished again reads as unseen.
const ACKS = path.join(REG, 'acks.json');
let acksCache = {}, acksMtime = -1;
function readAcks() {
  try { const m = fs.statSync(ACKS).mtimeMs; if (m !== acksMtime) { acksCache = readJSON(ACKS, {}) || {}; acksMtime = m; } }
  catch { acksCache = {}; acksMtime = -1; }
  return acksCache;
}
function writeAcks(a) { try { fs.mkdirSync(REG, { recursive: true }); fs.writeFileSync(ACKS, JSON.stringify(a, null, 2) + '\n'); } catch {} acksMtime = -1; }
// An ack is the finishedAt it was given for (a number), or { at, note } when the user marked a needs-you lane handled.
const ackAt = (v) => (v && typeof v === 'object' ? v.at : v);
function laneSeen(id, finishedAt) { return !!(finishedAt && ackAt(readAcks()[id]) === finishedAt); }
function ackNote(id) { const v = readAcks()[id]; return v && typeof v === 'object' ? v.note || '' : ''; }
function setAck(id, seen, finishedAt, note = '') { const a = { ...readAcks() }; if (seen && finishedAt) a[id] = note ? { at: finishedAt, note } : finishedAt; else delete a[id]; writeAcks(a); }
// The bucket a person sees: a finished needs-you lane (failed, paused, needs review) that was marked handled moves to
// ended until it finishes again. A DEAD or running lane can never be marked away: it needs resume or stop.
function bucketFor(l) {
  const s = l.s; const r = laneBucket({ s, alive: alive(s.pid), health: health(s) });
  if (r.bucket === 'attention' && s.result && laneSeen(l.id, s.finishedAt)) {
    const note = ackNote(l.id); return { bucket: 'ended', reason: `handled${note ? ': ' + note : ''} (was ${r.reason})`, handled: true };
  }
  return r;
}
function bucketOf(l) { return bucketFor(l).bucket; }
// Lane kind for the Office characters; the brief is read once per change (mtime), not on every poll.
const kindCache = new Map();
function kindOf(l) {
  const bf = path.join(l.repo || '', 'tasks', `${l.task}.md`); let mt = 0; try { mt = fs.statSync(bf).mtimeMs; } catch {}
  const key = `${mt}|${(l.s.files || []).length}`; const c = kindCache.get(l.id);
  if (c && c.key === key) return c.kind;
  let brief = ''; try { brief = fs.readFileSync(bf, 'utf8'); } catch {}
  const kind = laneKind({ task: l.task, brief, files: l.s.files || [] }); kindCache.set(l.id, { key, kind }); return kind;
}
function laneRow(l) {
  const s = l.s; const end = s.finishedAt || now();
  return { lane: l.id, bucket: bucketOf(l), health: health(s), phase: s.phase, elapsed: dur(end - s.startedAt), idle: s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt)),
    commits: `${s.commits}/${s.steps}`, tokens: compact(tokenTotal(s.tokens)), steers: s.steers?.length || 0, interrupts: s.interruptions?.length || 0, verdict: s.verdict || '', now: oneLine(s.activity, 70) };
}
const dashUrl = () => `http://127.0.0.1:${Number(process.env.CA_DASH_PORT || 4777)}`;
// A status row for scripts: every laneRow field plus identity, result, progress and file paths.
function statusRow(l) {
  const s = l.s; const pg = stepProgress(s); const sm = path.join(l.dir, 'summary.md');
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, result: s.result || '', reason: s.reason || '',
    progress: { done: pg.done, total: pg.total, current: pg.current }, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s),
    summaryPath: fs.existsSync(sm) ? sm : null, dashUrl: dashUrl() };
}
// cacheWrite bills into the totals but is not modeled by tokens.mjs (kept read-only): carry it here.
const tokTotal = (t) => (!t ? 0 : (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0));
function sumTok(list = []) {
  const r = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0 };
  for (const t of list || []) { if (!t) continue; r.input += t.input || 0; r.output += t.output || 0; r.reasoning += t.reasoning || 0; r.cacheRead += t.cacheRead || 0; r.cacheWrite += t.cacheWrite || 0; r.steps += t.steps || 0; }
  r.total = tokTotal(r); return r;
}
// One by-model row: who spent it and where the numbers come from. A lane whose steps ran but whose
// provider returned no usage is 'none' (unknown), never a false 0.
function modelRow(t, who, source) {
  const e = { input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, steps: t.steps || 0, who };
  e.total = tokTotal(e); e.source = (e.steps > 0 && e.total === 0) ? 'none' : source; return e;
}
function tokensByView(s) {
  return { build: withTotal(s.tokensBy?.build), review: withTotal(s.tokensBy?.review), other: withTotal(s.tokensBy?.other) };
}
function tokensByModelView(s) {
  const out = {}; for (const [m, t] of Object.entries(s.tokensByModel || {})) out[m] = modelRow(t, 'worker', 'runner');
  if (Object.keys(out).length || !tokTotal(s.tokens || {})) return out;
  // Lanes from before per-model counting: attribute by the lane's models (source 'lane', not counted per reply).
  const add = (m, t) => { if (!t || !tokTotal(t)) return; const k = m || 'unknown model'; const c = out[k];
    out[k] = modelRow(c ? { input: c.input + (t.input || 0), output: c.output + (t.output || 0), reasoning: c.reasoning + (t.reasoning || 0), cacheRead: c.cacheRead + (t.cacheRead || 0), steps: c.steps + (t.steps || 0) } : t, 'worker', 'lane'); };
  const by = s.tokensBy || {};
  if (tokTotal(by.build || {}) + tokTotal(by.review || {}) + tokTotal(by.other || {})) { add(s.models?.build, by.build); add(s.models?.review, by.review); add('codearts/hidden', by.other); }
  else add(s.models?.build, s.tokens);
  return out;
}
function printRows(rows) {
  const cols = ['lane', 'bucket', 'health', 'phase', 'elapsed', 'idle', 'commits', 'tokens', 'steers', 'interrupts', 'verdict', 'now'];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
}
// One line on stderr when a newer release is known and the cache is fresh; when the cache is missing
// or stale, start a detached background refresh (ca update --check --json) and never wait for it.
// CA_NO_UPDATE_CHECK=1 turns it off; --json output never carries it; a non-TTY stderr stays quiet
// unless CA_UPDATE_NOTICE=1. Wrapped so the notice can never slow or fail the command.
async function updateNotice(args) {
  try {
    if (process.env.CA_NO_UPDATE_CHECK === '1') return;
    if (args.some((a) => a === '--json')) return;
    if (!(process.stderr.isTTY || process.env.CA_UPDATE_NOTICE === '1')) return;
    const { readUpdateCache, compareVersions, UPDATE_TTL_MS } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
    const cache = readUpdateCache();
    if (cache && cache.available && cache.latest && compareVersions(cache.latest, cache.current || '0.0.0') > 0) {
      process.stderr.write(`Update available: ${cache.current} -> ${cache.latest}. What's new: ca update --check. Install: ca update\n`);
    }
    const fresh = cache && typeof cache.checkedAt === 'number' && (Date.now() - cache.checkedAt) < UPDATE_TTL_MS;
    if (!fresh) {
      try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    }
  } catch {}
}
function cmdStatus(args) {
  // Control room order: what needs a human first (attention), then running, done, ended.
  const rank = { attention: 0, running: 1, done: 2, ended: 3 };
  const all = lanes().filter((l) => args.includes('--all') || !l.s.result || now() - (l.s.finishedAt || 0) < 24 * 3600e3);
  const ls = all.map((l) => ({ l, b: bucketOf(l) })).sort((a, b) => (rank[a.b] ?? 9) - (rank[b.b] ?? 9)).map((x) => x.l);
  if (args.includes('--json')) { console.log(JSON.stringify(ls.map(statusRow), null, 2)); return; }
  const rows = ls.map(laneRow);
  if (!rows.length) { console.log('no lanes (ca status --all for older ones)'); return; }
  printRows(rows);
}
function cmdSummary(args) {
  const l = findLane(args.filter((a) => !a.startsWith('--'))[0]);
  const s = l.s; const sm = path.join(l.dir, 'summary.md');
  const text = fs.existsSync(sm) ? fs.readFileSync(sm, 'utf8') : '';
  if (args.includes('--json')) {
    const pg = stepProgress(s);
    console.log(JSON.stringify({ id: l.id, task: l.task, repo: l.repo, result: s.result || '', reason: s.reason || '', verdict: s.verdict || '',
      elapsedMs: (s.finishedAt || now()) - s.startedAt, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s), commits: s.commitLog || [], steps: pg.list,
      gates: s.gates || [], steers: s.steers || [], interruptions: s.interruptions || [], outside: s.outside || [], summary: text, dir: l.dir }, null, 2));
    return;
  }
  if (text) { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); return; }
  console.log(`lane ${l.id} ${s.result ? s.result + ', no summary.md yet' : 'still running'}`);
  printRows([laneRow(l)]);
}
async function cmdTail(args) {
  const follow = args.includes('-f'); const ni = args.indexOf('-n'); const n = ni >= 0 ? Number(args[ni + 1]) : 40;
  const q = args.filter((a, i) => !a.startsWith('-') && !(ni >= 0 && i === ni + 1))[0];
  const l = findLane(q); const f = path.join(l.dir, 'live.log');
  let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  process.stdout.write(text.split('\n').slice(-n - 1).join('\n'));
  if (!follow) return;
  let pos = Buffer.byteLength(text);
  for (;;) {
    await sleep(1000);
    try { const st = fs.statSync(f); if (st.size > pos) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(st.size - pos); fs.readSync(fd, b, 0, b.length, pos); fs.closeSync(fd); pos = st.size; process.stdout.write(b.toString('utf8')); } } catch {}
    const s = readJSON(path.join(l.dir, 'state.json'));
    if (s?.result) { await sleep(500); process.stdout.write(`\n[lane ${s.result}]\n`); return; }
  }
}
// Queue a steering message. Returns { error, code } instead of dying, so a dashboard route can
// answer 409 without ever exiting the long-lived dashboard process.
function steer(l, text) {
  if (l.s.result) return { error: `lane ${l.id} already ${l.s.result}`, code: 409 };
  if (!alive(l.s.pid)) return { error: `lane ${l.id} supervisor is not running`, code: 409 };
  fs.mkdirSync(path.join(l.dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(l.dir, 'inbox', `${now()}-${crypto.randomBytes(3).toString('hex')}.txt`), text);
  return { ok: true };
}
function cmdSteer(args) {
  const [q, ...rest] = args; if (!q || !rest.length) die('usage: ca steer <lane> <message>', 2);
  const l = findLane(q); const r = steer(l, rest.join(' '));
  if (r.error) die(r.error, 2);
  console.log(`queued for ${l.id}; it goes into the session within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
function cmdAttach(args) {
  const l = findLane(args[0]); const s = l.s;
  if (s.result || !s.server) die(`lane ${l.id} is ${s.result || 'not started'}; nothing to attach to`, 2);
  const sid = s.activeSession || s.buildSession;
  console.log(`attaching to ${l.id} session ${sid} at ${s.server.url}. Typing here steers the builder; leave the TUI with ctrl+c (the lane keeps running).`);
  const r = spawnSync(EXE, ['attach', s.server.url, '-s', sid, '-p', s.server.pw], { stdio: 'inherit', env: caEnv() });
  process.exit(r.status ?? 0);
}
// Parse a CLI duration for --older-than: a number followed by m, h or d (for example 30m, 48h, 2d).
// Anything else is null so the caller can raise a usage error.
function parseAge(v) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3);
}
// ca ack --stale: mark every finished Needs-you lane older than the given age handled in one go.
// Only finished lanes are selected; running, stalled and DEAD lanes are never touched.
function ackStale(args) {
  const oi = args.indexOf('--older-than');
  const durArg = oi >= 0 ? (args[oi + 1] ?? '') : '48h';
  const ms = parseAge(durArg);
  if (ms == null) die(`invalid --older-than "${durArg}": use a number with m, h or d (for example 48h)`, 2);
  const ni = args.indexOf('--note'); const note = ni >= 0 ? args.slice(ni + 1).join(' ').trim() : '';
  const dry = args.includes('--dry-run');
  const cut = now() - ms;
  const old = lanes().filter((l) => bucketFor(l).bucket === 'attention' && l.s.result && ((l.s.finishedAt || l.s.lastEventAt) < cut));
  if (!old.length) { console.log(`nothing in Needs you is older than ${durArg}`); return; }
  for (const l of old) {
    const b = bucketFor(l); const ts = l.s.finishedAt || l.s.lastEventAt;
    if (dry) { console.log(`would mark handled: ${l.id} (${b.reason}, ${dur(now() - ts)} ago)`); continue; }
    setAck(l.id, true, l.s.finishedAt || null, oneLine(note, 200));
    console.log(`${l.id}: handled (${b.reason})`);
  }
}
function cmdAck(args) {
  if (args.includes('--stale')) return ackStale(args);
  const ni = args.indexOf('--note'); const note = ni >= 0 ? args.slice(ni + 1).join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : undefined).find((a) => !a.startsWith('--'));
  if (!q) die('usage: ca ack <lane> [--note "text"] [--undo]', 2);
  const l = findLane(q);
  if (!l.s.result) die(`lane ${l.id} is not finished (${health(l.s)}): resume or stop it instead`, 2);
  const undo = args.includes('--undo'); setAck(l.id, !undo, l.s.finishedAt || null, oneLine(note, 200));
  const b = bucketFor(l);
  console.log(`${l.id}: ${undo ? 'unseen again' : 'acknowledged'}; bucket ${b.bucket} (${b.reason})`);
}
function cmdStop(args) {
  const l = findLane(args[0]);
  fs.writeFileSync(path.join(l.dir, 'STOP'), String(now()));
  if (!alive(l.s.pid)) { killTree(l.s.server?.pid); const s = l.s; s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)'; fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); console.log(`supervisor was gone; killed its server and marked ${l.id} stopped`); return; }
  console.log(`stop requested for ${l.id}; the supervisor aborts the session and writes the summary within a few seconds`);
}
// A resume logged on the plan that owns the lane, so the lead sees who continued what.
function noteResume(l, by, note) {
  for (const r of plans()) {
    const p = readJSON(r.file) || {};
    const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
    if (!(p.lanes || []).some((pl) => laneId(path.resolve(base, pl.repo || '.'), pl.task) === l.id)) continue;
    (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Resumed ${l.id} from the ${by}${note ? ': ' + note : ''}` });
    try { fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n'); } catch {}
    return r.id;
  }
  return null;
}
// Resume a paused, failed, stopped or DEAD lane from anywhere (CLI, dashboard, MCP).
// CA_RESUME_DRY=1 answers with the argv without spawning (checks, cautious leads).
function resumeLane(l, { note = '', by = 'ca resume' } = {}) {
  const s = l.s;
  if (s.result === 'done') return { error: `lane ${l.id} is done; nothing to resume`, code: 409 };
  if (!s.result && alive(s.pid)) return { error: `lane ${l.id} is still running (pid ${s.pid}); steer or stop it instead`, code: 409 };
  if (!fs.existsSync(path.join(l.repo, 'tasks', `${l.task}.md`))) return { error: `brief missing: tasks/${l.task}.md in ${l.repo}`, code: 409 };
  if (!s.result && !alive(s.pid)) {
    // DEAD supervisor: kill its server and close the old run before starting a new one.
    killTree(s.server?.pid);
    s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)';
    try { fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); } catch {}
  }
  if (note) { try { fs.mkdirSync(l.dir, { recursive: true }); fs.appendFileSync(path.join(l.dir, 'resume-note.txt'), `[${new Date().toISOString()} ${by}] ${note}\n`); } catch {} }
  noteResume(l, by, note);
  const argv = [fileURLToPath(import.meta.url), 'lane', l.repo, l.task, '--resume'];
  if (process.env.CA_RESUME_DRY === '1') return { ok: true, dry: true, argv, message: `would resume ${l.id} with: ${argv.join(' ')}` };
  const logFile = path.join(l.repo, 'tasks', `${l.task}.lane.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, CA_RESUMED_BY: by } });
  child.unref(); fs.closeSync(out); // the child keeps its own handle; the long-lived dashboard must not leak one per resume
  return { ok: true, dry: false, argv, message: `resumed ${l.id} (pid ${child.pid}); log: ${logFile}` };
}
function cmdResume(args) {
  const ni = args.indexOf('--note');
  const note = ni >= 0 ? args.slice(ni + 1).filter((a) => a !== '--dry-run').join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : args.length).find((a) => !a.startsWith('--'));
  if (!q) die('usage: ca resume <lane> [--note "<text>"] [--dry-run]', 2);
  if (args.includes('--dry-run')) process.env.CA_RESUME_DRY = '1';
  const l = findLane(q);
  const r = resumeLane(l, { note, by: 'ca resume' });
  if (r.error) die(r.error, 2);
  console.log(`CA_RESUME ${JSON.stringify({ lane: l.id, ok: true, dry: !!r.dry, argv: r.argv, message: r.message })}`);
}
// Queue a kick for a stuck turn. The supervisor consumes the file within 2 s (or at the next
// backoff poll): turn/now retry the turn, fresh starts a clean session, server restarts
// codearts serve, now also skips a backoff wait. Refused when the lane cannot act on it.
function kickLane(l, { mode = 'turn', text = '', by = 'ca kick' } = {}) {
  const s = l.s;
  const need = { turn: ['kick'], now: ['kick', 'skip-wait'], fresh: ['fresh'], server: ['restart-server'] }[mode];
  if (!need) return { error: `unknown kick mode "${mode}" (turn, fresh, server or now)`, code: 400 };
  if (s.result) return { error: `lane ${l.id} already ${resultOf(s)}; use ca resume ${l.id} to continue it`, code: 409 };
  if (!alive(s.pid)) return { error: `lane ${l.id} is DEAD (supervisor not running); use ca resume ${l.id} instead`, code: 409 };
  const { actions } = laneActions({ s, alive: true, health: health(s), canResume: true });
  if (!need.some((n) => actions.includes(n))) return { error: `kick (${mode}) is not allowed while ${l.id} is in phase ${s.phase} (allowed: ${actions.join(', ') || 'nothing; wait or stop'})`, code: 409 };
  fs.mkdirSync(l.dir, { recursive: true });
  const file = path.join(l.dir, 'KICK');
  fs.writeFileSync(file, JSON.stringify({ at: now(), mode, text, by }));
  return { ok: true, file };
}
function cmdKick(args) {
  const flags = { '--fresh': 'fresh', '--server': 'server', '--now': 'now' };
  let mode = 'turn'; const rest = [];
  for (const a of args) { if (flags[a]) mode = flags[a]; else rest.push(a); }
  const [q, ...msg] = rest;
  if (!q) die('usage: ca kick <lane> [--fresh|--server|--now] [message]', 2);
  const l = findLane(q);
  const r = kickLane(l, { mode, text: msg.join(' ').trim(), by: 'ca kick' });
  if (r.error) die(r.error, 2);
  console.log(`CA_KICK ${JSON.stringify({ lane: l.id, ok: true, mode, file: r.file })}`);
  console.log(`kick (${mode}) queued for ${l.id}; the supervisor applies it within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
function cmdGc() {
  for (const l of lanes()) if (l.s.result && now() - (l.s.finishedAt || 0) > 3 * 24 * 3600e3) { fs.rmSync(path.join(REG, `${l.id}.json`), { force: true }); fs.rmSync(path.join(REG, 'final', `${l.id}.json`), { force: true }); console.log(`forgot ${l.id}`); }
}

// ---------- engineer workflow: setup, wait, summary, init, doctor ----------
async function cmdSetup(args) {
  const f = path.join(HERE, 'setup.mjs');
  if (!fs.existsSync(f)) die('setup not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('setup.mjs has no default export', 2);
  await mod.default(args);
}
// `ca auth ...`: get the keys from the human through a local form (runner/auth.mjs).
async function cmdAuth(args) { await authCmd(args); }
// `ca onboard ...`: guided first-run setup, implemented in runner/onboard.mjs.
async function cmdOnboard(args) {
  const f = path.join(HERE, 'onboard.mjs');
  if (!fs.existsSync(f)) die('onboard not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('onboard.mjs has no default export', 2);
  await mod.default(args);
}
// Exit code of a finished lane, from the usage table: 0 done (review ready or skipped),
// 1 failed/stopped/killed, 3 missing credentials, 4 needs review.
function laneExit(s) {
  if (s.result === 'done') return !s.verdict || s.verdict === 'ready' ? 0 : 4;
  if (s.result === 'needs review') return 4;
  if (resultOf(s) === 'paused') return 5;
  if (s.result === 'failed' && s.exitCode === 3) return 3;
  return 1;
}
const exitRank = (c) => ({ 1: 4, 3: 3, 5: 2, 4: 1 }[c] ?? 0);
const worstExit = (codes) => codes.reduce((a, b) => (exitRank(b) > exitRank(a) ? b : a), 0);
async function cmdWait(args) {
  const asJson = args.includes('--json'); const quiet = args.includes('--quiet');
  const ti = args.indexOf('--timeout');
  const timeoutS = ti >= 0 ? Number(args[ti + 1]) : NaN;
  if (ti >= 0 && (!Number.isFinite(timeoutS) || timeoutS < 0)) die('usage: ca wait <lane...> [--timeout S] [--json] [--quiet]', 2);
  const qs = args.filter((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1));
  if (!qs.length) die('usage: ca wait <lane...> [--timeout S] [--json] [--quiet]', 2);
  const targets = qs.map((q) => findLane(q)); // resolve every lane first: unknown -> exit 2
  const deadline = Number.isFinite(timeoutS) && timeoutS > 0 ? now() + timeoutS * 1000 : Infinity;
  const last = new Map(); let lastBeat = 0;
  const readState = (l) => readJSON(path.join(l.dir, 'state.json')) || l.s;
  const note = (l, s) => {
    const pg = stepProgress(s);
    process.stderr.write(`[${hhmmss()}] ${l.id} ${health(s)} phase ${s.phase} step ${pg.done}/${pg.total} idle ${s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt))} now ${oneLine(s.activity, 70)}\n`);
  };
  for (;;) {
    const states = targets.map((l) => {
      const s = readState(l);
      return { l, s: !s.result && !alive(s.pid) ? { ...s, result: 'failed', reason: 'supervisor gone' } : s };
    });
    for (const { l, s } of states) {
      const pg = stepProgress(s);
      const key = `${health(s)}|${s.phase}|${pg.current?.n ?? ''}`;
      if (last.get(l.id) !== key) { last.set(l.id, key); if (!quiet) note(l, s); }
    }
    if (states.every(({ s }) => s.result)) {
      const objs = states.map(({ l, s }) => ({ lane: l.id, result: s.result, verdict: s.verdict || '', exit: laneExit(s),
        summaryPath: fs.existsSync(path.join(l.dir, 'summary.md')) ? path.join(l.dir, 'summary.md') : null }));
      for (const o of objs) process.stdout.write(`CA_RESULT ${JSON.stringify(o)}\n`);
      if (asJson) process.stdout.write(JSON.stringify({ lanes: objs }) + '\n');
      process.exit(worstExit(objs.map((o) => o.exit)));
    }
    if (now() >= deadline) {
      const running = states.filter(({ s }) => !s.result).map(({ l }) => l);
      if (asJson) console.log(JSON.stringify({ timeout: true, waitedS: timeoutS, lanes: running.map(statusRow) }));
      else { console.log(`wait: timeout after ${timeoutS}s; still running:`); printRows(running.map(laneRow)); }
      process.exit(124);
    }
    if (!lastBeat) lastBeat = now();
    else if (now() - lastBeat >= 60000) { lastBeat = now(); if (!quiet) for (const { l, s } of states) if (!s.result) note(l, s); }
    await sleep(Math.min(2000, deadline - now()));
  }
}
function cmdInit(args) {
  const gi = args.indexOf('--goal');
  const goal = gi >= 0 ? args[gi + 1] : '';
  if (gi >= 0 && !goal) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1));
  const [repoArg, task] = pos;
  if (!repoArg || !task) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const repo = path.resolve(repoArg);
  const file = path.join(repo, 'tasks', `${task}.md`);
  if (fs.existsSync(file) && !args.includes('--force')) die(`${file} exists (use --force to overwrite)`, 2);
  const tpl = fs.readFileSync(path.join(SKILL, 'templates', 'brief.md'), 'utf8');
  fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.writeFileSync(file, tpl.replace(/<one sentence goal[^>]*>/, goal || 'TODO: goal'));
  console.log(`brief: ${file}`);
  if (!git(repo, 'rev-parse', '--git-dir')) console.log('not a git repo yet: run git init && git commit --allow-empty -m init');
  console.log(`next: ca lane ${repoArg} ${task} --detach`);
  console.log(`      ca wait ${laneId(repo, task)}`);
}
// Preflight for engineers and agents: every row is ok | warn | fail, secrets are never printed.
// Shared by `ca doctor` and the dashboard's GET /api/doctor (same function, no subprocess).
async function doctorData(repoArg) {
  const repo = path.resolve(repoArg || process.cwd());
  const rows = [];
  const add = (name, status, detail, fix = '') => rows.push({ name, status, detail, fix });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? '' : 'install Node 20 or newer');

  // One --version call per doctor run: the codearts version row reuses it (each call costs about a second).
  let caVersion = null;
  const firstLine = (s) => (String(s || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
  if (!fs.existsSync(EXE)) add('codearts', 'fail', `not found at ${EXE}`, `install the CodeArts CLI: ${INSTALL_HINT}`);
  else {
    const r = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000, env: caEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const v = oneLine(((r.stdout || '') + ' ' + (r.stderr || '')).trim(), 120);
    if (r.status === 0) { caVersion = firstLine(r.stdout) || firstLine(r.stderr); add('codearts', 'ok', v || 'installed (no --version output)'); }
    else add('codearts', 'warn', r.error ? `could not run: ${oneLine(r.error.message, 100)}` : `--version exited ${r.status ?? '?'}${v ? ': ' + v : ''}`, 'run the codearts exe manually to check the install');
  }

  const missCred = [!userEnv('CODEARTS_CLI_AK') && 'CODEARTS_CLI_AK', !userEnv('CODEARTS_CLI_SK') && 'CODEARTS_CLI_SK'].filter(Boolean);
  add('credentials', missCred.length ? 'fail' : 'ok', missCred.length ? `missing ${missCred.join(', ')}` : 'set',
    missCred.length ? 'run: ca auth (local browser form; values are never printed)' : '');

  add('maas key', userEnv('MAAS_API_KEY') ? 'ok' : 'warn', userEnv('MAAS_API_KEY') ? 'set' : 'not set, falls back to CodeArts quota models',
    userEnv('MAAS_API_KEY') ? '' : 'ca auth --force adds MAAS_API_KEY for the MaaS models');

  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', g.status === 0 ? 'ok' : 'fail', oneLine(((g.stdout || '') + (g.stderr || '')).trim(), 120) || 'git not found', g.status === 0 ? '' : 'install git');

  const settings = readJSON(SETTINGS) || {};
  const trusted = [].concat(settings.security?.trustedFolders || []).map(String);
  const underTrusted = (p) => { const a = path.resolve(p).toLowerCase(); return trusted.some((f) => { const b = path.resolve(f).toLowerCase(); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }); };
  add('trusted folder', underTrusted(repo) ? 'ok' : 'warn', underTrusted(repo) ? `${repo} is trusted` : `${repo} is not in security.trustedFolders`,
    underTrusted(repo) ? '' : `node ${path.join(SKILL, 'scripts', 'trust.mjs')} ${repo} (a ca lane run trusts the repo too)`);

  const sh = workerShell();
  const shOk = !!(sh && fs.existsSync(sh));
  add('shell', shOk ? 'ok' : 'fail', sh || 'no SHELL set', shOk ? '' : 'set SHELL or CA_SHELL to Git bash (Git\\bin\\bash.exe)');

  try {
    const r = await fetch(`${dashUrl()}/api/lanes`, { signal: AbortSignal.timeout(1500) });
    add('dashboard', r.ok ? 'ok' : 'warn', r.ok ? `running at ${dashUrl()}` : `HTTP ${r.status}`, r.ok ? '' : 'ca dash (lanes start it on demand)');
  } catch { add('dashboard', 'warn', 'not running, starts on demand', 'ca dash (lanes start it on demand)'); }

  const chromeCands = [process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const chromePath = chromeCands.find((c) => fs.existsSync(c));
  add('chrome', chromePath ? 'ok' : 'warn', chromePath || 'not found (optional, used by browser checks)', chromePath ? '' : 'install Google Chrome for the office and sprite checks');

  // Install lifecycle: recorded harness configs still pointing at this ca.mjs, and the installed
  // CodeArts version vs the last smoke-tested one. A broken lifecycle.mjs must never break doctor.
  try {
    const { lifecycleRows } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
    for (const row of await lifecycleRows({ version: caVersion })) rows.push(row);
  } catch {}

  const fails = rows.filter((r) => r.status === 'fail').length;
  return { checks: rows, fails };
}
async function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const { checks, fails } = await doctorData(args.filter((a) => !a.startsWith('--'))[0]);
  if (asJson) console.log(JSON.stringify({ checks }, null, 2));
  else {
    // One readable line per row; the fix (if any) sits under it. No padded table.
    for (const r of checks) {
      console.log(`  ${String(r.status).padEnd(5)}  ${r.name}: ${r.detail}`);
      if (r.status !== 'ok' && r.fix) console.log(`         fix: ${r.fix}`);
    }
    console.log(`doctor: ${fails ? `not ready (${fails} fail)` : 'ready'}`);
  }
  if (fails) { await updateNotice(args); process.exit(1); }
}
async function cmdMcp() {
  const f = path.join(HERE, 'mcp.mjs');
  if (!fs.existsSync(f)) die('mcp server not installed', 2);
  await import(pathToFileURL(f).href);
}

// ---------- the lead's plan (written by Claude, shown on the dashboard) ----------
// <repo>/tasks/plan.json: { title, goal, lead, status, now, waves:[{name, lanes:[task], note}],
//   lanes:[{task, repo?, model?, why?, files?}], next:[text | {text, done}], decisions:[{at, text}], risks:[text] }
// Lane repo paths are relative to the plan's repo (the folder that holds tasks/).
const PLANS = path.join(REG, 'plans');
const planId = (file) => path.basename(path.dirname(path.dirname(path.resolve(file)))).replace(/[^\w.-]+/g, '_');
// A plan with status done or closed is closed (never appended to, only archived and replaced).
const planClosed = (p) => !!(p && /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || ''));
// A lane is in a plan when a lane entry has the same task and its repo resolves to the lane's repo.
const planListsLane = (plan, main, repo, task) => !!(plan && (plan.lanes || []).some((l) => l && l.task === task && path.resolve(main, l.repo || '.') === path.resolve(repo)));
// Register a plan file under <REG>/plans/<planId>.json (what `ca plan <file>` writes; idempotent).
function registerPlan(file) {
  const f = path.resolve(file); const id = planId(f);
  fs.mkdirSync(PLANS, { recursive: true });
  fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ id, file: f }, null, 2));
  return id;
}
// The title/goal a runner-created plan takes from the brief: after "Goal:" up to the first period,
// else the brief's first sentence, else "Lane <task>".
function planGoal(text, task) {
  const s = String(text || '');
  const gi = s.search(/Goal:/i);
  if (gi >= 0) {
    let rest = s.slice(gi + 'Goal:'.length).replace(/\s+/g, ' ').trim();
    const dot = rest.indexOf('.');
    if (dot >= 0) rest = rest.slice(0, dot).trim();
    if (rest) return rest;
  }
  const first = s.replace(/\s+/g, ' ').trim();
  const dot = first.indexOf('.');
  if (dot > 0) return oneLine(first.slice(0, dot), 120);
  return first ? oneLine(first, 120) : `Lane ${task}`;
}
// The plan file is shared: two lanes starting at once must not lose each other's edit. The lock is a
// `wx` create at <planFile>.lock; a 5 s retry window, removed in finally even when fn throws.
function withPlanLock(planFile, fn) {
  const lock = `${planFile}.lock`; fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd = null; const t0 = now();
  // A plan edit takes milliseconds: wait up to 30 s, take over a lock older than 20 s (a crashed holder),
  // and never edit without the lock, so two lanes starting together cannot lose each other's lane.
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = now() - fs.statSync(lock).mtimeMs; } catch {}
      if (age > 20000) { try { fs.rmSync(lock, { force: true }); } catch {} continue; }
      if (now() - t0 > 30000) throw new Error(`plan file is locked by another lane (${lock})`);
      const t = now() + 50; while (now() < t);
    }
  }
  try { return fn(); }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(lock, { force: true }); } catch {} } }
}
const planStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
// Bind a lane `ca lane` is starting to its repo's plan. CA_NO_PLAN=1 (smoke lanes) is left alone.
// A plan the lead wrote is only ever appended to; a lane already listed is not added twice.
function ensurePlan(repo, task, briefText) {
  if (process.env.CA_NO_PLAN === '1') return null;
  const main = projectOf(repo).key;
  const planFile = path.join(main, 'tasks', 'plan.json');
  const rel = (path.relative(main, repo) || '.').split(path.sep).join('/') || '.';
  const goal = planGoal(briefText, task);
  // A file that exists but cannot be parsed is left untouched (never overwritten): warn, do not stop the lane.
  const raw = fs.existsSync(planFile) ? readJSON(planFile) : undefined;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error(`tasks/plan.json is not a JSON object; fix it (the lane runs, but is not in a plan)`);
  const existing = readJSON(planFile);
  if (existing && !planClosed(existing) && planListsLane(existing, main, repo, task)) { registerPlan(planFile); return planFile; }
  return withPlanLock(planFile, () => {
    const cur = readJSON(planFile);
    if (cur && !planClosed(cur)) {
      if (!planListsLane(cur, main, repo, task)) {
        cur.lanes = Array.isArray(cur.lanes) ? cur.lanes : [];
        cur.lanes.push({ task, repo: rel, why: goal, added: 'runner' });
        let waves = Array.isArray(cur.waves) ? cur.waves : [];
        let wave = waves.find((w) => w && w.name === 'Added while running');
        if (!wave) { wave = { name: 'Added while running', lanes: [] }; waves.push(wave); }
        wave.lanes = Array.isArray(wave.lanes) ? wave.lanes : [];
        if (!wave.lanes.includes(task)) wave.lanes.push(task);
        cur.waves = waves;
        cur.decisions = Array.isArray(cur.decisions) ? cur.decisions : [];
        cur.decisions.push({ at: new Date().toISOString(), text: `Lane ${task} added by the runner (it was not in the plan)` });
        writeAtomic(planFile, JSON.stringify(cur, null, 2) + '\n');
      }
      registerPlan(planFile);
      return planFile;
    }
    // No plan file, or a closed one: archive the closed plan (it stays listed as closed) and create a
    // fresh open plan from the brief, so the new lane always has a plan.
    if (cur && planClosed(cur)) {
      const stamp = planStamp();
      const archiveDir = path.join(main, 'tasks', 'plans'); fs.mkdirSync(archiveDir, { recursive: true });
      const dest = path.join(archiveDir, `${stamp}.json`);
      let moved = false;
      try { fs.renameSync(planFile, dest); moved = true; } catch {}
      if (!moved) { try { fs.copyFileSync(planFile, dest); fs.rmSync(planFile, { force: true }); } catch {} }
      if (fs.existsSync(dest)) {
        const oldId = planId(planFile); const newId = `${oldId}~${stamp}`;
        try { fs.rmSync(path.join(PLANS, `${oldId}.json`), { force: true }); } catch {}
        fs.mkdirSync(PLANS, { recursive: true });
        fs.writeFileSync(path.join(PLANS, `${newId}.json`), JSON.stringify({ id: newId, file: dest }, null, 2));
      }
    }
    const plan = { title: goal, goal, lead: process.env.CA_LEAD || 'lead', status: 'running', now: '',
      waves: [{ name: 'Lanes', lanes: [task] }], lanes: [{ task, repo: rel, why: goal }],
      decisions: [{ at: new Date().toISOString(), text: `Plan created by the runner: lane ${task} started without an open plan.` }],
      next: [], risks: [] };
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    writeAtomic(planFile, JSON.stringify(plan, null, 2) + '\n');
    registerPlan(planFile);
    return planFile;
  });
}
// True when the lane is already listed in its repo's open plan (a resume must not rewrite that plan).
function laneAlreadyPlanned(repo, task) {
  try { const main = projectOf(repo).key; const p = readJSON(path.join(main, 'tasks', 'plan.json')); return !!(p && !planClosed(p) && planListsLane(p, main, repo, task)); }
  catch { return false; }
}
function plans() {
  let files = []; try { files = fs.readdirSync(PLANS).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => readJSON(path.join(PLANS, f))).filter((r) => r && fs.existsSync(r.file))
    .map((r) => ({ ...r, mtime: fs.statSync(r.file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
}
// ca plan [file] registers; ca plan list | close [id] [--reason t] | rm <id> manage registered plans.
const findPlan = (q) => {
  const all = plans();
  if (!q) return all[0];
  const r = pickOne(all, q, (x) => x.id, null);
  if (r.matches) die(`ambiguous plan "${q}": matches ${r.matches.join(', ')}; use the full id`, 2);
  return r.hit;
};
async function cmdPlan(args) {
  const sub = args[0];
  if (sub === 'list' || sub === 'ls') {
    const all = plans().map(planView); if (!all.length) return console.log('no plan registered (ca plan <repo>/tasks/plan.json)');
    for (const p of all) console.log(`${p.id.padEnd(24)} ${p.state.padEnd(10)} ${p.title}  (${p.summary})  time ${fmtDur(p.time && p.time.totalMs)}`);
    return;
  }
  if (sub === 'close' || sub === 'rm') {
    const ri = args.indexOf('--reason'); const reason = ri >= 0 ? args.slice(ri + 1).join(' ').trim() : '';
    const q = args.slice(1, ri >= 0 ? ri : undefined).find((a) => !a.startsWith('--'));
    const r = findPlan(q); if (!r) die(`no registered plan matches ${q || '(latest)'}; ca plan list`, 2);
    if (sub === 'rm') { fs.rmSync(path.join(PLANS, `${r.id}.json`), { force: true }); return console.log(`plan ${r.id} unregistered (its plan.json is kept: ${r.file})`); }
    const v = planView(r); if (v.waves.some((w) => w.lanes.some((l) => l.running))) die(`plan ${r.id} still has a running lane; ca stop it first`, 1);
    const p = readJSON(r.file) || {}; const unstarted = new Set(v.waves.flatMap((w) => w.lanes).filter((l) => l.health === 'planned').map((l) => l.task));
    for (const pl of p.lanes || []) if (unstarted.has(pl.task)) pl.dropped = true;
    p.status = 'done'; p.now = reason ? `Closed: ${reason}` : 'Plan closed by the lead.'; p.closedAt = new Date().toISOString();
    (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Plan closed${reason ? ': ' + reason : ''}${unstarted.size ? `. Dropped, never started: ${[...unstarted].join(', ')}` : ''}.` });
    fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
    return console.log(`plan ${r.id} closed${unstarted.size ? `; dropped ${[...unstarted].join(', ')}` : ''}`);
  }
  const f = path.resolve(args[0] || path.join('tasks', 'plan.json'));
  const p = readJSON(f); if (!p) die(`cannot read plan JSON at ${f}`, 2);
  fs.mkdirSync(PLANS, { recursive: true }); const id = planId(f);
  fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ id, file: f }, null, 2));
  // The lead may not have written startedAt; stamp it once from the plan's first decision or lane so a
  // plan's total time is stable. An existing value is never overwritten.
  if (!p.startedAt) {
    let st = null; try { st = fs.statSync(f); } catch {}
    const v = planView({ id, file: f, mtime: st ? st.mtimeMs : Date.now() });
    p.startedAt = new Date((v.time && v.time.startedAt) || Date.now()).toISOString();
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
    // Stamping is bookkeeping, not lead activity: keep the old mtime so the plan's idle time does not reset.
    if (st) { try { fs.utimesSync(f, st.atime, st.mtime); } catch {} }
  }
  const u = await ensureDash();
  console.log(`plan ${id} registered: ${p.title || p.goal || f}${u ? '. Dashboard: ' + u : ''}`);
}
function cmdNote(args) {
  const nowFlag = args.includes('--now'); const pi = args.indexOf('--plan'); const pq = pi >= 0 ? args[pi + 1] : null;
  const text = args.filter((a, i) => a !== '--now' && !(pi >= 0 && (i === pi || i === pi + 1))).join(' ').trim();
  if (!text) die('usage: ca note [--now] [--plan <id>] <text>', 2);
  const all = plans(); const r = pq ? all.find((x) => x.id === pq || x.id.includes(pq)) : all[0];
  if (!r) die('no plan registered (ca plan <repo>/tasks/plan.json)', 2);
  const p = readJSON(r.file) || {};
  if (nowFlag) p.now = text; else (p.decisions ||= []).push({ at: new Date().toISOString(), text });
  fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
  console.log(`${nowFlag ? 'now' : 'decision'} noted on plan ${r.id}`);
}
// ca lead-tokens [--plan id] [--session file]         point the plan at the lead's transcript, print totals
// ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]  report numbers
// The lead harness reports its own model usage so the plan counts the lead, not only the CodeArts workers.
// Default session: the newest .jsonl under ~/.claude/projects/<cwd, non [A-Za-z0-9-] -> ->/.
function defaultSession() {
  const dir = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9-]/g, '-'));
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  if (!files.length) return null;
  return files.map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
}
function cmdLeadTokens(args) {
  const asJson = args.includes('--json');
  const num = (flag) => { const i = args.indexOf(flag); if (i < 0) return 0; const n = Number(args[i + 1]); return Number.isFinite(n) ? n : 0; };
  const pi = args.indexOf('--plan'); const pq = pi >= 0 ? args[pi + 1] : null;
  const r = findPlan(pq); if (!r) die(`no registered plan matches ${pq || '(latest)'}; ca plan list`, 2);
  const p = readJSON(r.file) || {};
  const si = args.indexOf('--set');
  if (si >= 0) {
    const model = args[si + 1]; if (!model || model.startsWith('--')) die('usage: ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]', 2);
    const add = args.includes('--add'); const prev = (add && p.leadTokens?.[model]) || {};
    const next = { input: (prev.input || 0) + num('--input'), output: (prev.output || 0) + num('--output'), cacheRead: (prev.cacheRead || 0) + num('--cache-read'), cacheWrite: (prev.cacheWrite || 0) + num('--cache-write') };
    (p.leadTokens ||= {})[model] = next; fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
    if (asJson) return console.log(JSON.stringify({ plan: r.id, model, ...next, total: tokTotal(next) }, null, 2));
    return console.log(`plan ${r.id}: leadTokens ${model} total ${tokTotal(next)} (in ${next.input} out ${next.output} cache read ${next.cacheRead} write ${next.cacheWrite})`);
  }
  const sfi = args.indexOf('--session'); const session = sfi >= 0 ? args[sfi + 1] : (p.leadSession || defaultSession());
  if (!session) die('no session given and none under ~/.claude/projects; use --session <file.jsonl>', 2);
  const abs = path.resolve(session); if (!fs.existsSync(abs)) die(`session file not found: ${abs}`, 2);
  p.leadSession = abs; fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
  const t = parseLeadSession(abs, p.leadSince); const keys = Object.keys(t);
  if (asJson) return console.log(JSON.stringify({ plan: r.id, session: abs, tokensByModel: t }, null, 2));
  console.log(`plan ${r.id}: leadSession ${abs}`);
  if (!keys.length) return console.log('  no assistant usage in the transcript');
  for (const m of keys.sort((a, b) => t[b].total - t[a].total)) console.log(`  ${m}  ${t[m].total}  (in ${t[m].input} out ${t[m].output} cache read ${t[m].cacheRead} write ${t[m].cacheWrite})`);
}
const laneId = (repo, task) => `${path.basename(path.resolve(repo))}--${task}`.replace(/[^\w.-]+/g, '_');
const briefSteps = (file) => { try { return [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) })); } catch { return []; } };
// Step state from commits: "step N" in a subject wins, otherwise commits map to steps in order.
function stepProgress(s, steps = s.stepList || []) {
  const commits = s.commitLog || []; const done = new Map();
  for (const c of commits) { const m = c.subject.match(/\bstep\s*(\d+)/i); if (m) done.set(Number(m[1]), c.hash); }
  if (!done.size) commits.forEach((c, i) => { if (i < steps.length) done.set(steps[i].n, c.hash); });
  const building = !s.result && ['build', 'fix', 'starting', 'backoff', 'restart', 'gate'].includes(s.phase);
  const cur = building ? steps.find((st) => !done.has(st.n))?.n : null;
  const list = steps.map((st) => ({ ...st, state: done.has(st.n) ? 'done' : st.n === cur ? 'current' : s.result ? 'open' : 'pending', commit: done.get(st.n) || '' }));
  return { list, done: list.filter((x) => x.state === 'done').length, total: list.length, current: list.find((x) => x.state === 'current') || null };
}
// The project a lane belongs to: a worktree reports the main repo (its .git common dir's parent).
const projectCache = new Map();
function projectOf(repo) {
  if (projectCache.has(repo)) return projectCache.get(repo);
  let main = repo;
  const out = git(repo, 'rev-parse', '--git-common-dir');
  if (out && path.basename(path.resolve(repo, out)).toLowerCase() === '.git') main = path.dirname(path.resolve(repo, out));
  const v = { key: main, name: path.basename(main) };
  projectCache.set(repo, v);
  return v;
}
// How long a lane really worked, ignoring the gaps while it was paused between runs. Windows are one
// [start, end] per run plus the current run; the phase timeline is clipped to those windows so paused
// gaps never count. The window time before the first phase entry is waiting.
function laneTime(s, isAlive) {
  const win = [];
  const push = (a, b) => { if (a == null || b == null) return; if (!Number.isFinite(a) || !Number.isFinite(b)) return; if (b <= a) return; win.push([a, b]); };
  for (const r of s.runs || []) if (r && r.startedAt != null) push(r.startedAt, r.finishedAt != null ? r.finishedAt : (isAlive ? Date.now() : s.lastEventAt));
  const curEnd = s.finishedAt != null ? s.finishedAt : (isAlive ? Date.now() : s.lastEventAt);
  push(s.runStartedAt || s.startedAt, curEnd);
  win.sort((a, b) => a[0] - b[0]);
  const ms = win.reduce((t, [a, b]) => t + (b - a), 0);
  const byPhase = { wait: 0, build: 0, checks: 0, fix: 0, review: 0, other: 0 };
  const map = (p) => p === 'starting' || p === 'restart' || p === 'backoff' ? 'wait' : p === 'build' ? 'build' : p === 'gate' ? 'checks' : p === 'fix' ? 'fix' : p === 'review' ? 'review' : 'other';
  const overlap = (a, b) => { let t = 0; for (const [wa, wb] of win) { const lo = a > wa ? a : wa, hi = b < wb ? b : wb; if (hi > lo) t += hi - lo; } return t; };
  const phases = s.phases || [];
  if (!phases.length) byPhase.other = ms;
  else {
    const end = win.reduce((m, [, b]) => (b > m ? b : m), 0);
    for (let i = 0; i < phases.length; i++) { const at = phases[i].at; const nx = i + 1 < phases.length ? phases[i + 1].at : end; if (at == null || nx == null || nx <= at) continue; byPhase[map(phases[i].phase)] += overlap(at, nx); }
    const first = phases[0].at;
    if (first != null) for (const [wa, wb] of win) { const hi = wb < first ? wb : first; if (hi > wa) byPhase.wait += hi - wa; }
  }
  return { ms, byPhase, windows: win };
}
function laneView(l) {
  const s = l.s; const pg = stepProgress(s);
  const isAlive = alive(s.pid); const h = health(s);
  const { actions, suggest, why } = laneActions({ s, alive: isAlive, health: h, canResume: fs.existsSync(l.repo) && fs.existsSync(path.join(l.repo, 'tasks', `${l.task}.md`)) });
  const { bucket, reason: bucketWhy, handled } = bucketFor(l);
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s), tools: s.tools || [], models: s.models, session: s.activeSession,
    reason: s.reason || '', running: !s.result && isAlive, result: resultOf(s) || '', runs: (s.runs || []).length + 1, progress: { done: pg.done, total: pg.total, current: pg.current },
    startedAt: s.startedAt, finishedAt: s.finishedAt || null, fixes: s.fixes || 0, time: laneTime(s, isAlive),
    actions, suggest, why, bucket, bucketWhy, project: projectOf(l.repo), kind: kindOf(l), seen: laneSeen(l.id, s.finishedAt), handled: !!handled, ...(handled ? { suggest: '', why: '' } : {}) };
}
// A finished lane whose state folder is gone (worktree merged and removed): rebuild its state from the summary
// that `ca lane ... > tasks/<task>.lane.log` left in the main repo. Returns null when the log has no result.
function laneFromLog(file, ref, briefFile) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const head = [...txt.matchAll(/^=== lane \S+: ([A-Z ]+?)(?: \(([^)]*)\))? in (\S+) ===\r?$/gm)].pop(); if (!head) return null;
  const tail = txt.slice(head.index);
  const result = head[1].trim().toLowerCase(); const reason = head[2] || '';
  const commitLog = [...tail.matchAll(/^([0-9a-f]{7,40}) (.+?)\r?$/gm)].map((m) => ({ hash: m[1], subject: m[2] })).reverse();
  let stepList = []; try { stepList = [...fs.readFileSync(briefFile, 'utf8').matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) })); } catch {}
  const tk = tail.match(/tokens in (\d+) out (\d+)(?: \(cache read (\d+)\))? over (\d+) steps/); const mm = tail.match(/^models: build (\S+), review (\S+)/m); const vd = tail.match(/^VERDICT: (.+?)\r?$/m);
  let mt = 0; try { mt = fs.statSync(file).mtimeMs; } catch {}
  const secs = [...head[3].matchAll(/(\d+)([hms])/g)].reduce((a, m) => a + Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]], 0);
  const s = { result, reason, phase: 'finished', activity: result, verdict: vd && vd[1] !== 'none' ? vd[1] : null, commitLog, commits: commitLog.length, stepList, steps: stepList.length,
    tokens: tk ? { input: Number(tk[1]), output: Number(tk[2]), reasoning: 0, cacheRead: Number(tk[3] || 0), steps: Number(tk[4] || 0) } : {}, startedAt: mt - secs * 1000, finishedAt: mt, steers: [], interruptions: [], models: mm ? { build: mm[1], review: mm[2] } : {} };
  return { ...ref, s };
}
// The lead's own usage: a Claude Code transcript (leadSession) or harness-reported numbers
// (leadTokens). Cached by file mtime/size so a poll never re-reads a large jsonl.
const leadCache = new Map();
function parseLeadSession(file, since) {
  let st; try { st = fs.statSync(file); } catch { return {}; }
  const key = path.resolve(file); const stamp = `${st.mtimeMs}:${st.size}:${since || ''}`;
  const hit = leadCache.get(key); if (hit && hit.stamp === stamp) return hit.result;
  const out = {}; const seen = new Set(); const sinceT = since ? new Date(since).getTime() : null;
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    let rec; try { rec = JSON.parse(s); } catch { continue; }
    const msg = rec.message; if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
    if (sinceT != null && rec.timestamp && new Date(rec.timestamp).getTime() < sinceT) continue;
    const id = msg.id || rec.uuid || rec.id; if (id && seen.has(id)) continue; if (id) seen.add(id);
    const m = msg.model || 'lead'; const u = msg.usage; const e = (out[m] ||= { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0 });
    e.input += u.input_tokens || 0; e.output += u.output_tokens || 0;
    e.cacheRead += u.cache_read_input_tokens || 0; e.cacheWrite += u.cache_creation_input_tokens || 0; e.steps += 1;
  }
  for (const v of Object.values(out)) v.total = tokTotal(v);
  leadCache.set(key, { stamp, result: out }); return out;
}
// The lead rows a plan shows: transcript or reported numbers, else one 'none' row so the lead is
// never silently a zero. The fallback model name is plan.lead (the author) or literally "lead".
function leadView(p) {
  const out = {};
  if (p.leadSession) { const t = parseLeadSession(path.resolve(p.leadSession), p.leadSince); for (const [m, v] of Object.entries(t)) out[m] = modelRow(v, 'lead', 'transcript'); }
  else if (p.leadTokens && typeof p.leadTokens === 'object') { for (const [m, v] of Object.entries(p.leadTokens)) out[m] = modelRow(v, 'lead', 'reported'); }
  if (!Object.keys(out).length) { const m = (typeof p.lead === 'string' && p.lead) || 'lead'; out[m] = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0, total: null, who: 'lead', source: 'none' }; }
  return out;
}
// How long a plan took and where the time went. The plan runs from its start (a stamped startedAt, else
// its first decision or lane) to its close (closedAt, else the last sign of work, else now). The span is
// split into lead planning, lanes running (the union of every lane window, so parallel lanes never double
// count), lead between lanes and lead verifying. Worker time per phase and per lane is summed separately.
function planTime(p, r, planned) {
  const tsn = (t) => { if (t == null || t === '') return null; const n = typeof t === 'number' ? t : new Date(t).getTime(); return Number.isFinite(n) ? n : null; };
  const win = [];
  for (const x of planned || []) for (const w of (x.time && x.time.windows) || []) if (Array.isArray(w) && w[0] != null && w[1] != null) win.push([w[0], w[1]]);
  const firstStart = win.length ? Math.min(...win.map((w) => w[0])) : null;
  const lastEnd = win.length ? Math.max(...win.map((w) => w[1])) : null;
  const dts = (p.decisions || []).map((d) => tsn(d && d.at)).filter((n) => n != null);
  let startedAt = tsn(p.startedAt);
  if (startedAt == null) { const c = [...dts, ...(firstStart != null ? [firstStart] : [])]; startedAt = c.length ? Math.min(...c) : (r.mtime || Date.now()); }
  const isClosed = /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || '');
  let endedAt = tsn(p.closedAt);
  if (endedAt == null && isClosed) { const c = []; if (lastEnd != null) c.push(lastEnd); if (dts.length) c.push(Math.max(...dts)); endedAt = c.length ? Math.max(...c) : startedAt; }
  const live = endedAt == null;
  let end = endedAt != null ? endedAt : Date.now();
  if (end < startedAt) end = startedAt;
  const totalMs = end - startedAt;
  const unionLen = (ws, lo, hi) => {
    const iv = ws.map((w) => [Math.max(w[0], lo), Math.min(w[1], hi)]).filter((w) => w[1] > w[0]).sort((a, b) => a[0] - b[0]);
    let t = 0, a = null, b = null;
    for (const [s, e] of iv) { if (a == null) { a = s; b = e; } else if (s <= b) { if (e > b) b = e; } else { t += b - a; a = s; b = e; } }
    return a == null ? 0 : t + (b - a);
  };
  let planning, lanesMs, verify, between;
  if (!win.length) { planning = totalMs; lanesMs = 0; verify = 0; between = 0; }
  else {
    planning = Math.max(0, firstStart - startedAt);
    lanesMs = unionLen(win, startedAt, end);
    verify = (planned || []).some((x) => x.running) ? 0 : Math.max(0, end - lastEnd);
    between = Math.max(0, totalMs - planning - lanesMs - verify);
  }
  const segments = [
    { key: 'planning', label: 'Lead planning', ms: planning },
    { key: 'lanes', label: 'Lanes running', ms: lanesMs },
    { key: 'between', label: 'Lead between lanes', ms: between },
    { key: 'verify', label: 'Lead verifying', ms: verify },
  ];
  const byPhase = { wait: 0, build: 0, checks: 0, fix: 0, review: 0, other: 0 };
  let workTotal = 0; const lanesArr = [];
  for (const x of planned || []) {
    const t = x.time; if (!t || !(t.ms > 0)) continue;
    workTotal += t.ms; for (const k of Object.keys(byPhase)) byPhase[k] += (t.byPhase && t.byPhase[k]) || 0;
    lanesArr.push({ task: x.task, ms: t.ms, byPhase: t.byPhase });
  }
  return { startedAt, endedAt, live, totalMs, segments, work: { totalMs: workTotal, byPhase }, lanes: lanesArr };
}
function planView(r) {
  const p = readJSON(r.file) || {}; const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
  const reg = new Map(lanes().map((l) => [l.id, l]));
  const planned = (p.lanes || []).map((pl) => {
    const repo = path.resolve(base, pl.repo || '.'); const id = laneId(repo, pl.task); const l = reg.get(id);
    let bf = path.join(repo, 'tasks', `${pl.task}.md`);
    if (!fs.existsSync(bf)) bf = path.join(base, 'tasks', `${pl.task}.md`);
    const old = l ? null : laneFromLog(path.join(base, 'tasks', `${pl.task}.lane.log`), { id, task: pl.task, repo, dir: path.join(repo, 'tasks', `${pl.task}.lane`) }, bf);
    const v = l ? laneView(l) : old ? { ...laneView(old), archived: true } : { id, task: pl.task, repo, health: 'planned', phase: 'planned', running: false, result: '',
      progress: { done: 0, total: briefSteps(bf).length, current: null } };
    // "dropped": true marks a planned lane the lead decided not to run; it never counts as open work.
    const d = pl.dropped && v.health === 'planned' ? { health: 'dropped', phase: 'dropped', result: 'dropped', reason: typeof pl.dropped === 'string' ? pl.dropped : 'dropped by the lead, never started' } : {};
    if (pl.kind && ['code', 'art', 'review', 'docs'].includes(String(pl.kind).toLowerCase())) v.kind = String(pl.kind).toLowerCase(); // plan override
    return { ...v, ...d, plan: { model: pl.model || '', why: pl.why || '', files: pl.files || [], briefExists: fs.existsSync(bf) } };
  });
  const byTask = new Map(planned.map((x) => [x.task, x]));
  // "continues": "<task>" in a plan lane: the older lane was picked up by this one, so it reads as continued, not failed.
  for (const pl of p.lanes || []) {
    const old = pl.continues && byTask.get(pl.continues), nu = byTask.get(pl.task);
    if (old && nu && old.result && old.result !== 'done') {
      Object.assign(old, { health: 'continued', result: 'continued', continuedBy: nu.id, reason: `continued in ${pl.task}${old.reason ? ' after ' + old.reason : ''}` });
      // One agent, one station: the successor carries the earlier run(s); views show them as history, not as another lane.
      nu.continues = [...(old.continues || []), { id: old.id, task: old.task, reason: old.reason, commits: old.commits, progress: old.progress, elapsed: old.elapsed }];
      nu.runs = (nu.runs || 1) + (old.runs || 1);
      old.folded = true;
    }
  }
  const waves = (p.waves && p.waves.length ? p.waves : [{ name: 'Lanes', lanes: planned.map((x) => x.task) }]).map((w) => {
    const all = (w.lanes || []).map((t) => byTask.get(t)).filter(Boolean);
    const ls = all.filter((x) => !x.folded); const act = ls.filter((x) => x.result !== 'dropped');
    const st = !ls.length ? 'planned' : !act.length ? 'dropped' : act.every((x) => ['done', 'needs review'].includes(x.result)) ? 'done' : act.some((x) => x.running) ? 'running'
      : act.some((x) => ['failed', 'stopped', 'killed'].includes(x.result)) ? 'attention' : act.some((x) => x.result === 'paused') ? 'paused' : act.some((x) => x.result) ? 'partial' : 'planned';
    return { name: w.name, note: w.note || w.after || '', status: st, lanes: ls, folded: all.length && !ls.length };
  }).filter((w) => !w.folded).map(({ folded, ...w }) => w); // a wave whose lanes all continued elsewhere is history, not a stage
  // The plan badge comes from what the lanes really do, never only from the hand-written status: a plan whose
  // lead said "running" but has no running lane reads as waiting (with how long), so it never looks stuck.
  const allL = waves.flatMap((w) => w.lanes); const live = allL.filter((x) => x.result !== 'dropped');
  const fin = (x) => ['done', 'needs review'].includes(x.result);
  const counts = { total: live.length, done: live.filter(fin).length, running: live.filter((x) => x.running).length,
    notStarted: live.filter((x) => x.health === 'planned').length, dropped: allL.length - live.length };
  const ts = (t) => { const n = typeof t === 'number' ? t : new Date(t || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const lastActivity = Math.max(r.mtime || 0, ...allL.map((x) => Math.max(ts(x.finishedAt), ts(x.startedAt))));
  const closed = /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || '');
  const state = counts.running ? 'running' : closed ? (counts.done === counts.total ? 'done' : 'closed')
    : live.some((x) => ['failed', 'stopped', 'killed'].includes(x.result)) ? 'attention' : live.some((x) => x.result === 'paused') ? 'paused'
    : counts.total && counts.done === counts.total ? (/^verifying$/i.test(p.status || '') ? 'verifying' : 'done') : 'waiting';
  const idle = Date.now() - lastActivity; const dur = (ms) => ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : ms < 86400e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
  const bits = [`${counts.done}/${counts.total} lanes done`];
  if (counts.running) bits.push(`${counts.running} running`);
  if (counts.notStarted && state !== 'running') bits.push(`${counts.notStarted} not started`);
  if (counts.dropped) bits.push(`${counts.dropped} dropped`);
  if (state === 'waiting' || state === 'attention' || state === 'paused') bits.push(`idle ${dur(idle)}`);
  // Plan tokens: every lane counts, folded (continued) ones included; per agent like the lane views.
  const tokensBy = { build: sumTokens(planned.map((x) => x.tokensBy?.build)), review: sumTokens(planned.map((x) => x.tokensBy?.review)), other: sumTokens(planned.map((x) => x.tokensBy?.other)) };
  const modelKeys = [...new Set(planned.flatMap((x) => Object.keys(x.tokensByModel || {})))];
  const tokensByModel = {};
  for (const m of modelKeys) { const e = sumTok(planned.map((x) => x.tokensByModel?.[m])); tokensByModel[m] = { ...e, who: 'worker', source: (e.steps > 0 && e.total === 0) ? 'none' : 'runner' }; }
  // The lead spends tokens too: merge its by-model usage into the same table, tagged who and source.
  const leadModel = leadView(p);
  for (const [m, e] of Object.entries(leadModel)) {
    const cur = tokensByModel[m];
    if (cur && e.source !== 'none') tokensByModel[m] = modelRow({ input: cur.input + e.input, output: cur.output + e.output, reasoning: cur.reasoning + e.reasoning, cacheRead: cur.cacheRead + e.cacheRead, cacheWrite: cur.cacheWrite + e.cacheWrite, steps: cur.steps + e.steps }, 'lead', e.source);
    else if (!cur) tokensByModel[m] = e;
  }
  const missing = Object.entries(tokensByModel).filter(([, e]) => e.source === 'none').map(([m]) => m);
  // Every lane's aggregate counts (the sum the plan shows), plus the lead's known spend. 'none' rows stay
  // unknown rather than a false 0, so a lane that never reported usage is not silently dropped from the total.
  const tokens = sumTok([sumTokens(planned.map((x) => x.tokens)), ...Object.values(leadModel).filter((e) => e.source !== 'none')]);
  tokens.complete = missing.length === 0; tokens.missing = missing; tokens.count = Object.keys(tokensByModel).length;
  const time = planTime(p, r, planned);
  return { id: r.id, file: r.file, updatedAt: r.mtime, time, title: p.title || r.id, goal: p.goal || '', leadName: p.lead || 'Claude', status: p.status || '', now: p.now || '',
    state, counts, summary: bits.join(' · '), lastActivity, closed: state === 'done' || state === 'closed', tokens, tokensBy, tokensByModel, lead: { tokensByModel: leadModel },
    next: (p.next || []).map((x) => (typeof x === 'string' ? { text: x, done: false } : { text: x.text, done: !!x.done })),
    decisions: (p.decisions || []).slice(-30), risks: p.risks || [], waves };
}
function laneDetail(l) {
  const s = l.s; const rd = (f) => { try { return fs.readFileSync(path.join(l.dir, f), 'utf8'); } catch { return ''; } };
  let brief = ''; try { brief = fs.readFileSync(path.join(l.repo, 'tasks', `${l.task}.md`), 'utf8'); } catch {}
  return { ...laneView(l), steps: stepProgress(s).list, commits: s.commitLog || [], todos: s.todos || [], files: s.files || [], gates: s.gates || [],
    interruptions: s.interruptions || [], steers: s.steers || [], permissions: s.permissions || [], outside: s.outside || [], errors: s.errors || [],
    phases: s.phases || [], checks: s.checks || [], verdict: s.verdict || '', brief, review: rd('review.md'), summary: rd('summary.md'), config: s.config || {} };
}

// ---------- dashboard ----------
// Lanes start the dashboard on demand (detached, survives the lane). CA_DASH=0 turns it off.
async function ensureDash() {
  if (process.env.CA_DASH === '0') return null;
  const port = Number(process.env.CA_DASH_PORT || 4777); const url = `http://127.0.0.1:${port}`;
  try { if ((await fetch(url + '/api/lanes', { signal: AbortSignal.timeout(1500) })).ok) return url; } catch {}
  try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return url; } catch { return null; }
}
function cmdDash(args) {
  const port = Number(args[0] || process.env.CA_DASH_PORT || 4777);
  const page = fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8');
  // DNS-rebinding guard: the dashboard drives lanes, so trust only loopback Host headers for this
  // port. CA_DASH_HOSTS adds host or host:port names for a proxy in front of the dashboard.
  const allowHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const h of String(process.env.CA_DASH_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) { allowHosts.add(h); if (!h.includes(':')) allowHosts.add(`${h}:${port}`); }
  // One JSON reader for every POST body: invalid JSON or a body over 64 KB is a client error, not a 500.
  const MAX_BODY = 64 * 1024;
  const readJson = (req) => new Promise((resolve, reject) => {
    const parts = []; let size = 0; let done = false; // Buffers: a multibyte char may span two chunks
    const fail = (code) => { if (done) return; done = true; const e = new Error(code === 413 ? 'body too large' : 'invalid JSON body'); e.statusCode = code; reject(e); };
    req.on('data', (c) => { if (done) return; size += c.length; if (size > MAX_BODY) return fail(413); parts.push(c); });
    req.on('end', () => { if (done) return; done = true; const b = Buffer.concat(parts).toString('utf8'); try { const v = b.trim() ? JSON.parse(b) : {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); resolve(v); } catch { const e = new Error('invalid JSON body'); e.statusCode = 400; reject(e); } });
    req.on('error', () => fail(400));
  });
  const readBody = async (req) => { try { return { body: await readJson(req) }; } catch (e) { return { error: { error: e.statusCode === 413 ? 'request body too large' : 'invalid JSON body' }, code: e.statusCode || 400 }; } };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      // A foreign Host header is a DNS-rebinding attempt: reject it before any route runs.
      const reqHost = String(req.headers.host || '').toLowerCase();
      if (!allowHosts.has(reqHost)) return json({ error: `forbidden host ${req.headers.host || '(none)'}; allow it with CA_DASH_HOSTS` }, 403);
      // Every POST under /api/ must be JSON: a cross-site form post cannot steer, stop, kick or resume.
      if (req.method === 'POST' && u.pathname.startsWith('/api/') && !/application\/json/i.test(String(req.headers['content-type'] || ''))) return json({ error: 'POST /api/ needs content-type application/json' }, 415);
      if (u.pathname === '/') { let html = page; try { html = fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8'); } catch {} res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); }
      if (u.pathname === '/office') { let html = ''; try { html = fs.readFileSync(path.join(HERE, 'office.html'), 'utf8'); } catch {} if (html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); } }
      if (u.pathname.startsWith('/assets/')) {
        // Static Pixel Workshop assets (room art, atlases, manifests, shared css/js). No traversal, known types only.
        const types = { '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
        const rel = decodeURIComponent(u.pathname.slice('/assets/'.length)); const root = path.join(HERE, 'assets'); const f = path.resolve(root, rel);
        const type = types[path.extname(f).toLowerCase()];
        if (!type || !f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return json({ error: 'not found' }, 404);
        res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('image/') ? 'max-age=3600' : 'no-store' }); return res.end(fs.readFileSync(f));
      }
      if (u.pathname === '/api/ui') {
        // UI version: newest mtime of the pages and shared assets. Open tabs poll it and reload when it changes,
        // so a deployed fix never keeps running stale page code.
        const files = ['dash.html', 'office.html', 'assets/workshop.js', 'assets/workshop.css'].map((f) => path.join(HERE, f));
        return json({ version: Math.max(0, ...files.map((f) => { try { return Math.round(fs.statSync(f).mtimeMs); } catch { return 0; } })) });
      }
      if (u.pathname === '/api/lanes') return json(lanes().map(laneView));
      if (u.pathname === '/api/overview') {
        // The office view in one call: attention buckets and lanes not finished over 3 days ago.
        const ls = lanes().filter((l) => !l.s.result || now() - (l.s.finishedAt || 0) < 3 * 24 * 3600e3).map(laneView);
        const counts = { attention: 0, running: 0, done: 0, ended: 0 };
        for (const v of ls) counts[v.bucket] = (counts[v.bucket] || 0) + 1;
        return json({ counts, lanes: ls });
      }
      if (u.pathname === '/api/plans') return json(plans().map(planView).sort((a, b) => (a.closed - b.closed) || (b.lastActivity - a.lastActivity)));
      if (u.pathname === '/api/doctor') return json({ checks: (await doctorData()).checks });
      if (u.pathname === '/api/update') {
        // The update pill: the cached check plus the running dash pid. A stale cache refreshes in
        // the background; ?refresh=1 waits for a fresh check. POST runs `ca update` and then
        // restarts this same dashboard on the same port (after the response is sent).
        const { readUpdateCache, checkUpdate, installCommand, currentVersion, UPDATE_TTL_MS } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
        const view = (c) => ({ current: (c && c.current) || currentVersion(), latest: (c && c.latest) || null, available: !!(c && c.available), notes: (c && Array.isArray(c.notes)) ? c.notes : [], cmd: (c && c.cmd) || installCommand(), checkedAt: (c && c.checkedAt) || 0, error: (c && c.error) || undefined, pid: process.pid });
        if (req.method === 'POST') {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--json'], { encoding: 'utf8', env: caEnv(), windowsHide: true });
          let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
          const code = await new Promise((res) => { const to = setTimeout(() => { try { child.kill(); } catch {} res(-1); }, 600000); child.on('close', (c) => { clearTimeout(to); res(c); }); child.on('error', () => { clearTimeout(to); res(-1); }); });
          if (code !== 0) {
            const tail = out.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 300);
            return json({ ok: false, error: `${tail} (exit ${code})` }, 500);
          }
          json({ ok: true, restarting: true, output: out.trim().slice(0, 2000) });
          res.on('finish', () => {
            try { srv.close(); } catch {}
            try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CA_DASH_RECLAIM: '1' } }).unref(); } catch {}
            setTimeout(() => process.exit(0), 50);
          });
          return;
        }
        let cache = readUpdateCache();
        const stale = !cache || typeof cache.checkedAt !== 'number' || Date.now() - cache.checkedAt >= UPDATE_TTL_MS;
        if (u.searchParams.get('refresh') === '1') { try { cache = await checkUpdate({ force: true, timeoutMs: 5000 }); } catch {} }
        else if (stale) { try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {} }
        return json(view(cache));
      }
      if (u.pathname === '/api/auth') {
        // Start the local key form (runner/auth.mjs) for the Connect keys button and hand back its
        // URL. The child prints JSON only; key values never reach this process, the page or the logs.
        // A route handler must never die(): a stale tab must not kill the dashboard.
        if (req.method !== 'POST') return json({ error: 'use POST /api/auth' }, 405);
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'auth', '--no-open', '--json'], { encoding: 'utf8', timeout: 20000, env: caEnv(), windowsHide: true });
        let v = null; try { v = JSON.parse(String(r.stdout || '').trim()); } catch {}
        if (!v) return json({ error: 'auth did not return JSON' }, 500);
        return json({ ready: !!v.ready, url: v.url || '' });
      }
      const m = u.pathname.match(/^\/api\/lane\/([^/]+)\/(log|summary|detail|steer|stop|attach|kick|resume|ack)$/);
      if (m) {
        const q = decodeURIComponent(m[1]); const all = lanes();
        const pr = pickOne(all, q, (x) => x.id, (x) => x.task);
        if (pr.matches) return json({ error: `ambiguous lane "${q}": matches ${pr.matches.join(', ')}; use the full id` }, 409);
        const l = pr.hit;
        if (!l) return json({ error: `no lane matches "${q}"` }, 404); // never die(): one stale browser tab must not kill the dashboard
        if (m[2] === 'detail') return json(laneDetail(l));
        if (m[2] === 'log') {
          const f = path.join(l.dir, 'live.log'); const from = Number(u.searchParams.get('from') || 0);
          const size = fs.existsSync(f) ? fs.statSync(f).size : 0; const start = from > size ? 0 : Math.max(from, size - 400000);
          let text = ''; if (size > start) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(size - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); text = b.toString('utf8'); }
          return json({ size, text, reset: from > size });
        }
        if (m[2] === 'summary') { const f = path.join(l.dir, 'summary.md'); return json({ text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }); }
        if (req.method === 'POST' && m[2] === 'steer') { const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code); const text = String(rb.body.text ?? '').trim(); if (!text) return json({ error: 'empty' }, 400); const sr = steer(l, text); if (sr.error) return json({ error: sr.error }, sr.code || 409); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'kick') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          const r = kickLane(l, { mode: String(body.mode || 'turn'), text: String(body.text || '').trim(), by: 'dashboard' });
          if (r.error) return json({ error: r.error }, r.code || 409);
          return json({ ok: true, mode: String(body.mode || 'turn'), file: r.file });
        }
        if (req.method === 'POST' && m[2] === 'resume') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          const r = resumeLane(l, { note: String(body.note || '').trim(), by: 'dashboard' });
          if (r.error) return json({ error: r.error }, r.code || 409);
          return json({ ok: true, dry: !!r.dry, argv: r.argv, message: r.message });
        }
        if (req.method === 'POST' && m[2] === 'stop') { fs.writeFileSync(path.join(l.dir, 'STOP'), String(now())); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'ack') {
          // Mark a finished lane seen (or unseen again) for this finishedAt; a later finish is unseen anew.
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          if (body.seen !== false && !l.s.result) return json({ error: 'lane is not finished: resume or stop it instead' }, 409);
          setAck(l.id, body.seen !== false, l.s.finishedAt || null, typeof body.note === 'string' ? oneLine(body.note, 200) : '');
          return json({ ok: true, seen: laneSeen(l.id, l.s.finishedAt || null) });
        }
        if (req.method === 'POST' && m[2] === 'attach') {
          // Open a new console window with the CodeArts TUI on the live session.
          if (process.platform !== 'win32') return json({ error: 'Open TUI needs Windows; run ca attach <lane> in a terminal' }, 501);
          const s = l.s; if (s.result || !s.server) return json({ error: 'lane not running' }, 400);
          const sid = s.activeSession || s.buildSession;
          if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', `"codearts ${l.id}"`, `"${EXE}"`, 'attach', s.server.url, '-s', sid, '-p', s.server.pw], { env: caEnv(), detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          return json({ ok: true });
        }
      }
      json({ error: 'not found' }, 404);
    } catch (err) { json({ error: String(err.message || err) }, 500); }
  });
  // Loopback by default (the dashboard drives lanes); CA_DASH_HOST only moves it within the machine.
  const dashHost = process.env.CA_DASH_HOST || '127.0.0.1';
  const listenStarted = Date.now();
  const listenDash = () => srv.listen(port, dashHost, () => { delete process.env.CA_DASH_RECLAIM; console.log(`ca dash: http://127.0.0.1:${port}  (ctrl+c to stop)`); });
  srv.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // A POST /api/update restart spawns a fresh dash that must reclaim the same port once the old
    // process releases it: retry for up to 10 s (the port is briefly busy), then give up.
    if (process.env.CA_DASH_RECLAIM === '1' && Date.now() - listenStarted < 10000) { setTimeout(listenDash, 250); return; }
    console.log(`ca dash is already running: http://127.0.0.1:${port}`); process.exit(0);
  });
  listenDash();
}

function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }

const [cmd, ...args] = process.argv.slice(2);
const usageText = () => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  .filter((l) => l.startsWith('// usage') || l.startsWith('//        ')).map((l) => l.slice(3)).join('\n');
const table = { lane: () => { const pos = args.filter((a) => !a.startsWith('--')); return args.includes('--detach') ? cmdDetach(...pos) : runLane(pos[0], pos[1], { resume: args.includes('--resume') }); }, status: () => cmdStatus(args), summary: () => cmdSummary(args), wait: () => cmdWait(args), init: () => cmdInit(args), doctor: () => cmdDoctor(args), mcp: () => cmdMcp(), tail: () => cmdTail(args), steer: () => cmdSteer(args), attach: () => cmdAttach(args), stop: () => cmdStop(args), ack: () => cmdAck(args), resume: () => cmdResume(args), kick: () => cmdKick(args), dash: () => cmdDash(args), gc: () => cmdGc(), plan: () => cmdPlan(args), note: () => cmdNote(args), 'lead-tokens': () => cmdLeadTokens(args), setup: () => cmdSetup(args), onboard: () => cmdOnboard(args), auth: () => cmdAuth(args), update: async () => { const m = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href); return m.update(args); }, uninstall: async () => { const m = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href); return m.uninstall(args); }, workflow: () => process.stdout.write(fs.readFileSync(path.join(HERE, '..', 'docs', 'workflow.md'), 'utf8')) };
if (cmd === 'help' || cmd === '-h' || cmd === '--help' || !cmd) { process.stdout.write(usageText() + '\n'); await updateNotice(args); process.exit(0); }
if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  let v = '0.0.0'; try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  process.stdout.write(`codearts-lanes ${v} (${path.join(HERE, 'ca.mjs')})\n`); await updateNotice(args); process.exit(0);
}
if (!table[cmd]) { process.stderr.write(usageText() + '\n'); process.exit(2); }
if (cmd === 'lane') await updateNotice(args);
await table[cmd]();
if (cmd === 'status' || cmd === 'doctor' || cmd === 'plan') await updateNotice(args);
