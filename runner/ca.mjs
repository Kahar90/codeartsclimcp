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
// (or TOOL_STALL_S on one tool call), permission prompts are answered by policy so nothing
// waits forever, retries continue the SAME session (context kept), the runner itself runs
// the brief's CHECK: lines and the git-clean gate, and feeds failures back to the builder.
//
// usage: ca lane <repo> <task> [--detach]  run a lane (foreground; --detach: background with a log)
//        ca status [--json] [--all]        table of lanes (--json adds id, task, repo, result, progress)
//        ca wait <lane...> [--timeout S] [--json] [--quiet]  block until lanes end; exit = worst lane
//        ca summary <lane> [--json]        final report of a lane (live status row while it runs)
//        ca init <repo> <task> [--goal "<text>"] [--force]  scaffold <repo>/tasks/<task>.md
//        ca doctor [--json] [<repo>]       preflight: node, codearts, credentials, git, trust, shell
//        ca setup <harness> [repo]   write MCP + rules config for claude|kiro|cursor|codex|vscode
//        ca mcp                            run the MCP server (runner/mcp.mjs), if installed
//        ca tail <lane> [-f] [-n N]        readable transcript
//        ca steer <lane> <message>         queue a message into the running session
//        ca attach <lane>                  open the CodeArts TUI on the live session (watch + type)
//        ca stop <lane>                    abort the session and end the lane
//        ca dash [port]                    local web dashboard of all lanes (default 4777)
//        ca gc                             forget lanes finished more than 3 days ago
//        ca plan [<plan.json>]             show the lead's plan on the dashboard (goal, waves, next)
//        ca note [--now] <text>            log a lead decision (--now: set the "lead is doing" line)
//        ca help | -h | --help             this usage
//        Exit codes: 0 done (review ready or skipped), 1 failed/stopped/killed, 2 usage or unknown
//        lane, 3 missing credentials, 4 needs review, 124 wait timeout.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const CA_HOME = path.join(os.homedir(), '.codeartsdoer');
const EXE = process.env.CODEARTS_EXE || path.join(CA_HOME, 'installers', 'bin', 'codearts.exe');
const REG = process.env.CA_REGISTRY || path.join(CA_HOME, 'lanes');
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const HAS_MAAS = () => !!userEnv('MAAS_API_KEY');
const CFG = {
  // Default: MaaS (flash builds, GLM 5.3 reviews). Without MAAS_API_KEY: CodeArts quota models.
  get build() { return process.env.BUILD_MODEL || (HAS_MAAS() ? 'maas/deepseek-v4.1-flash' : 'huaweicloud-maas/GLM-5.2'); },
  get review() { return process.env.REVIEW_MODEL || (HAS_MAAS() ? 'maas/glm-5.3' : 'huaweicloud-maas/GLM-5.1'); },
  stall: num('STALL_S', 240),          // model silent this long while busy -> abort + resume
  toolStall: num('TOOL_STALL_S', 900), // one tool call running this long -> abort + resume
  retries: num('MAX_RETRIES', 3),      // interruptions (stall, transport, crash) per phase
  fixes: num('MAX_FIXES', 3),          // gate failures fed back to the builder
  laneTimeout: num('LANE_TIMEOUT', 5400),
  checkTimeout: num('CHECK_TIMEOUT', 900),
  noReview: process.env.NO_REVIEW === '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const hhmmss = (t = now()) => new Date(t).toTimeString().slice(0, 8);
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const readJSON = (f, d = null) => { for (let i = 0; i < 3; i++) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; } } return d; };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killTree = (pid) => { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } } };
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return (r.stdout || '').trim(); };

// ---------- CodeArts environment (same as installers/codearts.cmd) ----------
const envCache = {};
function userEnv(name) {
  if (process.env[name]) return process.env[name];
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
    SCENARIO: 'codeartsdoer', KERNEL_DATA_DIR: path.join(CA_HOME, 'cli-data'), KERNEL_STATE_DIR: path.join(CA_HOME, 'state'),
    KERNEL_CONFIG_DIR: CA_HOME, OPENCODE_CONFIG: path.join(CA_HOME, 'codearts_cli.json'),
    OPENCODE_CONFIG_FILE: 'codearts_cli.json,codearts_cli.jsonc', OPENCODE_CHANNEL: 'latest', PLUGIN_ENV: 'hc',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: 'true', CODEARTS_DISABLE_AUTO_UPDATE: 'true',
    OMO_SEND_ANONYMOUS_TELEMETRY: '0', CODEAGENT_USE_MESSAGE_FEEDBACK: 'false', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    CODEARTS_CLI_AK: userEnv('CODEARTS_CLI_AK'), CODEARTS_CLI_SK: userEnv('CODEARTS_CLI_SK'),
    ...maasEnv(), ...extra,
  };
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
    if (process.env.CA_DUMP_ENV) fs.writeFileSync(process.env.CA_DUMP_ENV, JSON.stringify({ env: caEnv({ CODEARTS_SERVER_PASSWORD: 'pw' }), cwd: this.cwd }, null, 1));
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
async function runLane(repoArg, task) {
  if (!repoArg || !task) die('usage: ca lane <repo> <task> [--detach]', 2);
  const repo = path.resolve(repoArg);
  const briefFile = path.join(repo, 'tasks', `${task}.md`);
  if (!task || !fs.existsSync(briefFile)) die(`usage: ca lane <repo> <task>   (needs ${briefFile})`, 2);
  if (!fs.existsSync(EXE)) die(`codearts not found at ${EXE}`, 2);
  if (!git(repo, 'rev-parse', '--git-dir')) die(`${repo} is not a git repo`, 2);
  const id = `${path.basename(repo)}--${task}`.replace(/[^\w.-]+/g, '_');
  const dir = path.join(repo, 'tasks', `${task}.lane`);
  const prev = readJSON(path.join(dir, 'state.json'));
  if (prev && alive(prev.pid) && prev.pid !== process.pid && !prev.result) die(`lane ${id} is already running (pid ${prev.pid})`, 2);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.mkdirSync(REG, { recursive: true });
  fs.writeFileSync(path.join(REG, `${id}.json`), JSON.stringify({ id, dir, repo, task }, null, 2));

  // Keep CodeArts' folder and lane files out of commits.
  const gi = path.join(repo, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const want = ['.codeartsdoer/', 'tasks/*.lane/', 'tasks/*.out'].filter((p) => !giText.split(/\r?\n/).includes(p));
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
  const REVIEW = (brief.match(/^\s*REVIEW_MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.review;
  const START = git(repo, 'rev-parse', 'HEAD');
  const dirtyAll = () => git(repo, 'status', '--porcelain').split(/\r?\n/).filter((l) => l && !/^.. "?(tasks\/|\.codeartsdoer)/.test(l));
  const PRE_DIRTY = new Set(dirtyAll());
  const T0 = now();

  const S = {
    v: 1, id, task, repo, dir, pid: process.pid, startedAt: T0, updatedAt: T0, phase: 'starting', attempt: 0, fixes: 0,
    server: null, buildSession: null, reviewSession: null, activeSession: null, busy: false, sse: false,
    lastEventAt: T0, activity: 'starting server', models: { build: BUILD, review: REVIEW }, stepList, commitLog: [], todos: [], files: [], phases: [{ phase: 'starting', at: T0 }], start: START,
    config: { stall: CFG.stall, toolStall: CFG.toolStall, retries: CFG.retries, fixes: CFG.fixes },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 }, commits: 0, steps: stepCount, checks,
    interruptions: [], steers: [], permissions: [], gates: [], errors: [], outside: [], verdict: null, result: null, exitCode: null,
  };
  const insideRepo = (f) => { const a = path.resolve(repo, String(f).replace(/[\\/]\*+$/, '')).toLowerCase(); return [repo, os.tmpdir()].some((r) => a === r.toLowerCase() || a.startsWith(r.toLowerCase() + path.sep)); };
  let lastWrite = 0;
  const save = (force) => { if (!force && now() - lastWrite < 1000) return; lastWrite = now(); S.updatedAt = now(); try { fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(S, null, 2)); } catch {} };
  const phase = (p, activity) => { if (S.phase !== p) S.phases.push({ phase: p, at: now() }); S.phase = p; if (activity) S.activity = activity; save(true); };
  const syncCommits = () => {
    const out = git(repo, 'log', '--reverse', '--format=%h%x09%s', `${START}..HEAD`);
    S.commitLog = out ? out.split(/\r?\n/).map((l) => { const [hash, ...r] = l.split('\t'); return { hash, subject: oneLine(r.join(' '), 160) }; }) : [];
    S.commits = S.commitLog.length;
  };

  const server = new Server(repo, path.join(dir, 'server.log'));
  let finished = false;
  const cleanup = () => { if (!finished) { finished = true; server.stop(); } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { S.result = S.result || 'killed'; S.activity = `killed by ${sig}`; save(true); cleanup(); process.exit(130); });

  // ---- event tracking ----
  const sess = {}; // sid -> { busy, sawBusy, lastAct, tools: Map, error, aborting }
  const sx = (sid) => (sess[sid] ||= { busy: false, sawBusy: false, lastAct: now(), tools: new Map(), error: null, aborting: false });
  const roles = new Map();       // messageID -> role
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
        if (st === 'retry') { const msg = `model service retry ${pr.status.attempt ?? ''}: ${oneLine(pr.status.message, 160)}`; L(`  ! ${msg}`); S.activity = msg; }
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
        if (info.role === 'assistant' && info.error && sid && !(sx(sid).aborting && /Abort/i.test(info.error.name || ''))) sx(sid).error = info.error;
        break;
      }
      case 'message.part.delta': {
        const p = parts.get(pr.partID) || { type: 'text', text: '' }; if (pr.field === 'text') p.text = (p.text || '') + (pr.delta || '');
        parts.set(pr.partID, p); if (sid === S.activeSession && !sx(sid).tools.size) S.activity = p.type === 'reasoning' ? 'thinking' : 'writing reply';
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
          } else if ((st.status === 'completed' || st.status === 'error') && s) {
            const t = s.tools.get(key); s.tools.delete(key);
            const took = t ? ` (${dur(now() - t.since)})` : '';
            if (st.status === 'error') L(`  ! ${part.tool} failed${took}: ${oneLine(st.error, 300)}`);
            else L(`  < ${part.tool} ok${took}${st.output ? ': ' + oneLine(st.output, 200) : ''}`);
          }
          if (sid === S.activeSession && s) { const t = [...s.tools.values()][0]; S.activity = t ? `tool ${t.tool}: ${oneLine(t.input, 80)}` : 'thinking'; S.tools = [...s.tools.values()].map((x) => ({ tool: x.tool, input: oneLine(x.input, 120), since: x.since })); }
        } else if (part.type === 'step-finish') {
          for (const k of parts.keys()) flushPart(k);
          const tk = part.tokens || {}; S.tokens.input += tk.input || 0; S.tokens.output += tk.output || 0; S.tokens.reasoning += tk.reasoning || 0; S.tokens.cacheRead += tk.cache?.read || 0; S.tokens.steps++;
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
    sent.add(text.trim()); const s = sx(sid); s.error = null; s.sawBusy = false; s.lastAct = now(); s.sentAt = now();
    S.activeSession = sid; S.busy = true;
    await server.api('POST', `/session/${sid}/prompt_async`, { model: splitModel(model), ...(agent ? { agent } : {}), parts: [{ type: 'text', text }] });
  };
  const abort = async (sid) => {
    const s = sx(sid); s.aborting = true;
    try { await server.api('POST', `/session/${sid}/abort`, {}); } catch (err) { L(`  ! abort failed: ${err.message}`); }
    for (let i = 0; i < 30 && s.busy; i++) await sleep(1000);
    s.tools.clear(); s.busy = false; s.aborting = false;
  };
  const stopFile = path.join(dir, 'STOP');
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
    const s = sx(sid); let lastPoll = 0, lastCommitCheck = 0;
    for (;;) {
      await sleep(2000);
      if (fs.existsSync(stopFile)) { L('== stop requested'); await abort(sid); return { kind: 'stopped' }; }
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
    }
  }
  const classify = (err) => {
    const m = JSON.stringify(err || {});
    if (/Authentication failed|MISSING_CREDENTIAL|\b401\b|\b403\b|AK\/SK|invalid.*credential/i.test(m)) return 'auth';
    if (/\b429\b|rate.?limit|too many requests|quota|Queuing/i.test(m)) return 'rate';
    if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|\b50[0234]\b|Cannot connect|network/i.test(m)) return 'transport';
    return 'other';
  };
  const waitInterruptible = async (sec, label) => {
    const until = now() + sec * 1000;
    while (now() < until) { if (fs.existsSync(stopFile)) return false; S.activity = `${label}: ${dur(until - now())} left`; save(); await sleep(1000); }
    return true;
  };

  // Drive a phase until its turn ends cleanly; resume interrupted turns in the same session.
  async function drive(sid, model, agent, label, resumeText, freshSession) {
    curModel = model; curAgent = agent;
    let interruptions = 0, sameSessionFails = 0;
    for (;;) {
      const o = await waitTurn(sid);
      if (o.kind === 'idle') return { ok: true, sid };
      if (o.kind === 'stopped' || o.kind === 'timeout') return { ok: false, sid, reason: o.kind };
      const cls = o.kind === 'error' ? classify(o.error) : o.kind;
      const what = o.kind === 'error' ? `${o.error.name || 'error'}: ${oneLine(o.error.data?.message || o.error.message || '', 200)}` : (o.what || o.kind);
      S.interruptions.push({ at: now(), phase: label, kind: cls, what }); save(true);
      if (cls === 'auth') return { ok: false, sid, reason: 'auth', exit: 3, what };
      if (cls === 'other' && o.kind === 'error' && /Abort/i.test(o.error.name || '')) { /* user aborted in TUI: resume */ }
      if (++interruptions > CFG.retries) return { ok: false, sid, reason: `gave up after ${CFG.retries} interruptions (last: ${cls}: ${what})` };
      say(`interrupted (${cls}: ${what}); resume ${interruptions}/${CFG.retries}`);
      if (o.kind === 'server-died') {
        L('== codearts server died: restarting'); phase('restart', 'restarting codearts server');
        try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
      }
      const backoff = cls === 'rate' || cls === 'transport' ? 120 * interruptions : 15;
      phase('backoff');
      if (!(await waitInterruptible(backoff, `backoff after ${cls}`))) return { ok: false, sid, reason: 'stopped' };
      phase(label, 'resuming');
      if (++sameSessionFails >= 2 && freshSession) {
        sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
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

    // BUILD
    let sid = await newSession(`${task} build`); S.buildSession = sid; S.attempt = 1;
    phase('build', 'sending brief'); L(`== build (${BUILD}) session ${sid}; ${checks.length} CHECK lines, ${stepCount} steps`);
    await send(sid, brief, BUILD);
    for (;;) {
      const r = await drive(sid, BUILD, undefined, S.fixes ? 'fix' : 'build', resumeMsg, contBrief);
      sid = r.sid; S.buildSession = sid;
      if (!r.ok) { reason = r.reason; exitCode = r.exit || 1; break; }
      if (await pumpInbox(sid)) continue; // a steer arrived right at the end: let the builder handle it
      phase('gate', 'running gates');
      const g = await gates();
      if (g.ok) { reason = ''; exitCode = 0; break; }
      if (++S.fixes > CFG.fixes) { reason = `gates still failing after ${CFG.fixes} fix rounds: ${g.what}`; exitCode = 1; break; }
      say(`gate failed (${g.what}); fix round ${S.fixes}/${CFG.fixes}`);
      phase('fix', `fix round ${S.fixes}`); await send(sid, g.message, BUILD);
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
    reason = `runner error: ${err.message}`; exitCode = 1; L(`! ${reason}`);
  }

  // ---- summary ----
  syncCommits();
  S.result = exitCode === 0 ? (S.verdict && S.verdict !== 'ready' && !CFG.noReview ? 'needs review' : 'done') : (reason === 'stopped' ? 'stopped' : 'failed');
  const finalExit = S.result === 'needs review' ? 4 : exitCode;
  S.reason = reason; S.exitCode = finalExit; S.phase = 'finished'; S.activity = S.result; S.busy = false; S.finishedAt = now();
  const log = git(repo, 'log', '--oneline', `${START}..HEAD`);
  const left = dirty();
  const reviewBody = review ? (() => { const ls = review.split(/\r?\n/); const i = ls.findIndex((l) => /^\s*1\.\s/.test(l)); return ls.slice(i >= 0 ? i : Math.max(0, ls.length - 16)).filter((l) => l.trim() && !/^\s*VERDICT:/i.test(l)).slice(0, 24).join('\n'); })() : '';
  const md = [
    `=== lane ${id}: ${S.result.toUpperCase()}${reason ? ' (' + reason + ')' : ''} in ${dur(now() - T0)} ===`,
    `models: build ${BUILD}, review ${REVIEW} | tokens in ${S.tokens.input} out ${S.tokens.output} (cache read ${S.tokens.cacheRead}) over ${S.tokens.steps} steps`,
    `commits ${S.commits} (brief has ${stepCount} numbered lines):`, log || '(none)',
    left.length ? `UNCOMMITTED: ${left.slice(0, 8).join(', ')}` : 'work tree: clean',
    ...(PRE_DIRTY.size ? [`already dirty before the lane (ignored): ${[...PRE_DIRTY].slice(0, 8).join(', ')}`] : []),
    `gates: ${S.gates.length ? S.gates.map((g) => `${g.gate} ${g.ok ? 'ok' : 'FAIL'}`).join(' | ') : '(none ran)'} | fix rounds ${S.fixes}`,
    `interruptions: ${S.interruptions.length ? S.interruptions.map((x) => `${x.phase}/${x.kind}: ${x.what}`).join('; ') : 'none'}`,
    `steering: ${S.steers.length ? S.steers.map((x) => `[${x.by}] ${oneLine(x.text, 160)}`).join(' / ') : 'none'}`,
    `outside-repo file access: ${S.outside.length ? S.outside.slice(0, 5).map((x) => `${x.tool} ${x.path}`).join(', ') : 'none'}`,
    `permissions: ${S.permissions.length ? S.permissions.map((x) => `${x.kind}->${x.reply}`).join(', ') : 'none asked'}`,
    ...(S.errors.length ? [`errors: ${S.errors.slice(-3).map((x) => x.msg).join(' / ')}`] : []),
    '--- review ---', reviewBody || '(no review)', `VERDICT: ${S.verdict || 'none'}`,
    `files: ${dir} (live.log, review.md, events.jsonl)`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n');
  L(`== finished: ${S.result}${reason ? ' (' + reason + ')' : ''}`);
  save(true);
  process.stdout.write('\n' + md + '\n');
  process.stdout.write(`CA_RESULT ${JSON.stringify({ lane: id, result: S.result, verdict: S.verdict || '', exit: finalExit, summaryPath: path.join(dir, 'summary.md') })}\n`);
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'lane', repoArg, task], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  console.log(`lane ${id} started (pid ${child.pid}). Log: ${logFile}. Wait: ca wait ${id}. Watch: ${dashUrl()}`);
  process.exit(0);
}

// ---------- control commands ----------
function lanes() {
  let files = []; try { files = fs.readdirSync(REG).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => { const r = readJSON(path.join(REG, f)); if (!r) return null; const s = readJSON(path.join(r.dir, 'state.json')); return s ? { ...r, s } : null; }).filter(Boolean)
    .sort((a, b) => (b.s.startedAt || 0) - (a.s.startedAt || 0));
}
function health(s) {
  if (s.result) return s.result;
  if (!alive(s.pid)) return 'DEAD (ca stop cleans up)';
  const idle = now() - (s.lastEventAt || s.startedAt);
  if (['gate', 'backoff', 'restart', 'starting'].includes(s.phase)) return 'running';
  if (!s.busy) return 'running';
  if (s.tools?.length) return 'running tool';
  if (idle > (s.config?.stall || 240) * 1000) return 'STALLED';
  if (idle > 60000) return 'quiet';
  return 'running';
}
function findLane(q) {
  const all = lanes();
  if (!q) { const runningLanes = all.filter((l) => !l.s.result); if (runningLanes.length === 1) return runningLanes[0]; die('which lane? ' + all.map((l) => l.id).join(', '), 2); }
  const hit = all.find((l) => l.id === q) || all.find((l) => l.task === q) || all.find((l) => l.id.includes(q));
  if (!hit) die(`no lane matches "${q}". Lanes: ${all.map((l) => l.id).join(', ') || '(none)'}`, 2);
  return hit;
}
function laneRow(l) {
  const s = l.s; const end = s.finishedAt || now();
  return { lane: l.id, health: health(s), phase: s.phase, elapsed: dur(end - s.startedAt), idle: s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt)),
    commits: `${s.commits}/${s.steps}`, steers: s.steers?.length || 0, interrupts: s.interruptions?.length || 0, verdict: s.verdict || '', now: oneLine(s.activity, 70) };
}
const dashUrl = () => `http://127.0.0.1:${Number(process.env.CA_DASH_PORT || 4777)}`;
// A status row for scripts: every laneRow field plus identity, result, progress and file paths.
function statusRow(l) {
  const s = l.s; const pg = stepProgress(s); const sm = path.join(l.dir, 'summary.md');
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, result: s.result || '', reason: s.reason || '',
    progress: { done: pg.done, total: pg.total, current: pg.current }, tokens: s.tokens || {},
    summaryPath: fs.existsSync(sm) ? sm : null, dashUrl: dashUrl() };
}
function printRows(rows) {
  const cols = ['lane', 'health', 'phase', 'elapsed', 'idle', 'commits', 'steers', 'interrupts', 'verdict', 'now'];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
}
function cmdStatus(args) {
  const ls = lanes().filter((l) => args.includes('--all') || !l.s.result || now() - (l.s.finishedAt || 0) < 24 * 3600e3);
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
      elapsedMs: (s.finishedAt || now()) - s.startedAt, tokens: s.tokens || {}, commits: s.commitLog || [], steps: pg.list,
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
function steer(l, text) {
  if (l.s.result) die(`lane ${l.id} already ${l.s.result}`, 2);
  if (!alive(l.s.pid)) die(`lane ${l.id} supervisor is not running`, 2);
  fs.mkdirSync(path.join(l.dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(l.dir, 'inbox', `${now()}-${crypto.randomBytes(3).toString('hex')}.txt`), text);
}
function cmdSteer(args) {
  const [q, ...rest] = args; if (!q || !rest.length) die('usage: ca steer <lane> <message>', 2);
  const l = findLane(q); steer(l, rest.join(' '));
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
function cmdStop(args) {
  const l = findLane(args[0]);
  fs.writeFileSync(path.join(l.dir, 'STOP'), String(now()));
  if (!alive(l.s.pid)) { killTree(l.s.server?.pid); const s = l.s; s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)'; fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); console.log(`supervisor was gone; killed its server and marked ${l.id} stopped`); return; }
  console.log(`stop requested for ${l.id}; the supervisor aborts the session and writes the summary within a few seconds`);
}
function cmdGc() {
  for (const l of lanes()) if (l.s.result && now() - (l.s.finishedAt || 0) > 3 * 24 * 3600e3) { fs.rmSync(path.join(REG, `${l.id}.json`), { force: true }); console.log(`forgot ${l.id}`); }
}

// ---------- engineer workflow: setup, wait, summary, init, doctor ----------
async function cmdSetup(args) {
  const f = path.join(HERE, 'setup.mjs');
  if (!fs.existsSync(f)) die('setup not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('setup.mjs has no default export', 2);
  await mod.default(args);
}
// Exit code of a finished lane, from the usage table: 0 done (review ready or skipped),
// 1 failed/stopped/killed, 3 missing credentials, 4 needs review.
function laneExit(s) {
  if (s.result === 'done') return !s.verdict || s.verdict === 'ready' ? 0 : 4;
  if (s.result === 'needs review') return 4;
  if (s.result === 'failed' && s.exitCode === 3) return 3;
  return 1;
}
const exitRank = (c) => ({ 1: 3, 3: 2, 4: 1 }[c] ?? 0);
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
async function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const repo = path.resolve(args.filter((a) => !a.startsWith('--'))[0] || process.cwd());
  const rows = [];
  const add = (name, status, detail, fix = '') => rows.push({ name, status, detail, fix });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? '' : 'install Node 20 or newer');

  if (!fs.existsSync(EXE)) add('codearts', 'fail', `not found at ${EXE}`, 'install the CodeArts CLI');
  else {
    const r = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000, env: caEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const v = oneLine(((r.stdout || '') + ' ' + (r.stderr || '')).trim(), 120);
    if (r.status === 0) add('codearts', 'ok', v || 'installed (no --version output)');
    else add('codearts', 'warn', r.error ? `could not run: ${oneLine(r.error.message, 100)}` : `--version exited ${r.status ?? '?'}${v ? ': ' + v : ''}`, 'run the codearts exe manually to check the install');
  }

  const missCred = [!userEnv('CODEARTS_CLI_AK') && 'CODEARTS_CLI_AK', !userEnv('CODEARTS_CLI_SK') && 'CODEARTS_CLI_SK'].filter(Boolean);
  add('credentials', missCred.length ? 'fail' : 'ok', missCred.length ? `missing ${missCred.join(', ')}` : 'set',
    missCred.length ? 'set CODEARTS_CLI_AK and CODEARTS_CLI_SK in the (Windows user) environment; values are never printed' : '');

  add('maas key', userEnv('MAAS_API_KEY') ? 'ok' : 'warn', userEnv('MAAS_API_KEY') ? 'set' : 'not set, falls back to CodeArts quota models',
    userEnv('MAAS_API_KEY') ? '' : 'set MAAS_API_KEY to use the MaaS models');

  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', g.status === 0 ? 'ok' : 'fail', oneLine(((g.stdout || '') + (g.stderr || '')).trim(), 120) || 'git not found', g.status === 0 ? '' : 'install git');

  const settings = readJSON(path.join(CA_HOME, 'cli-data', 'settings.json')) || {};
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

  const fails = rows.filter((r) => r.status === 'fail').length;
  if (asJson) console.log(JSON.stringify({ checks: rows }, null, 2));
  else {
    const cols = ['name', 'status', 'detail', 'fix'];
    const w = cols.map((c, i) => Math.max(['NAME', 'STATUS', 'DETAIL', 'FIX'][i].length, ...rows.map((r) => String(r[c]).length)));
    console.log(['NAME', 'STATUS', 'DETAIL', 'FIX'].map((h, i) => h.padEnd(w[i])).join('  '));
    for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
    console.log(`doctor: ${fails ? `not ready (${fails} fail)` : 'ready'}`);
  }
  if (fails) process.exit(1);
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
function plans() {
  let files = []; try { files = fs.readdirSync(PLANS).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => readJSON(path.join(PLANS, f))).filter((r) => r && fs.existsSync(r.file))
    .map((r) => ({ ...r, mtime: fs.statSync(r.file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
}
async function cmdPlan(args) {
  const f = path.resolve(args[0] || path.join('tasks', 'plan.json'));
  const p = readJSON(f); if (!p) die(`cannot read plan JSON at ${f}`, 2);
  fs.mkdirSync(PLANS, { recursive: true }); const id = planId(f);
  fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ id, file: f }, null, 2));
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
function laneView(l) {
  const s = l.s; const pg = stepProgress(s);
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, tokens: s.tokens, tools: s.tools || [], models: s.models, session: s.activeSession,
    reason: s.reason || '', running: !s.result && alive(s.pid), result: s.result || '', progress: { done: pg.done, total: pg.total, current: pg.current },
    startedAt: s.startedAt, finishedAt: s.finishedAt || null, fixes: s.fixes || 0 };
}
function planView(r) {
  const p = readJSON(r.file) || {}; const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
  const reg = new Map(lanes().map((l) => [l.id, l]));
  const planned = (p.lanes || []).map((pl) => {
    const repo = path.resolve(base, pl.repo || '.'); const id = laneId(repo, pl.task); const l = reg.get(id);
    const bf = path.join(repo, 'tasks', `${pl.task}.md`);
    const v = l ? laneView(l) : { id, task: pl.task, repo, health: 'planned', phase: 'planned', running: false, result: '',
      progress: { done: 0, total: briefSteps(bf).length, current: null } };
    return { ...v, plan: { model: pl.model || '', why: pl.why || '', files: pl.files || [], briefExists: fs.existsSync(bf) } };
  });
  const byTask = new Map(planned.map((x) => [x.task, x]));
  const waves = (p.waves && p.waves.length ? p.waves : [{ name: 'Lanes', lanes: planned.map((x) => x.task) }]).map((w) => {
    const ls = (w.lanes || []).map((t) => byTask.get(t)).filter(Boolean);
    const st = !ls.length ? 'planned' : ls.every((x) => ['done', 'needs review'].includes(x.result)) ? 'done' : ls.some((x) => x.running) ? 'running'
      : ls.some((x) => ['failed', 'stopped', 'killed'].includes(x.result)) ? 'attention' : ls.some((x) => x.result) ? 'partial' : 'planned';
    return { name: w.name, note: w.note || w.after || '', status: st, lanes: ls };
  });
  return { id: r.id, file: r.file, updatedAt: r.mtime, title: p.title || r.id, goal: p.goal || '', lead: p.lead || 'Claude', status: p.status || '', now: p.now || '',
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
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      if (u.pathname === '/') { let html = page; try { html = fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8'); } catch {} res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); }
      if (u.pathname === '/office') { let html = ''; try { html = fs.readFileSync(path.join(HERE, 'office.html'), 'utf8'); } catch {} if (html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); } }
      if (u.pathname === '/office-sprites.js') { try { const js = fs.readFileSync(path.join(HERE, 'office-sprites.js'), 'utf8'); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(js); } catch { return json({ error: 'office-sprites.js not found' }, 404); } }
      if (u.pathname === '/api/lanes') return json(lanes().map(laneView));
      if (u.pathname === '/api/plans') return json(plans().map(planView));
      const m = u.pathname.match(/^\/api\/lane\/([^/]+)\/(log|summary|detail|steer|stop|attach)$/);
      if (m) {
        const l = findLane(decodeURIComponent(m[1]));
        if (m[2] === 'detail') return json(laneDetail(l));
        if (m[2] === 'log') {
          const f = path.join(l.dir, 'live.log'); const from = Number(u.searchParams.get('from') || 0);
          const size = fs.existsSync(f) ? fs.statSync(f).size : 0; const start = from > size ? 0 : Math.max(from, size - 400000);
          let text = ''; if (size > start) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(size - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); text = b.toString('utf8'); }
          return json({ size, text, reset: from > size });
        }
        if (m[2] === 'summary') { const f = path.join(l.dir, 'summary.md'); return json({ text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }); }
        if (req.method === 'POST' && m[2] === 'steer') { let b = ''; for await (const c of req) b += c; const text = JSON.parse(b || '{}').text?.trim(); if (!text) return json({ error: 'empty' }, 400); steer(l, text); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'stop') { fs.writeFileSync(path.join(l.dir, 'STOP'), String(now())); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'attach') {
          // Open a new console window with the CodeArts TUI on the live session.
          const s = l.s; if (s.result || !s.server) return json({ error: 'lane not running' }, 400);
          const sid = s.activeSession || s.buildSession;
          spawn('cmd.exe', ['/c', 'start', `"codearts ${l.id}"`, EXE, 'attach', s.server.url, '-s', sid, '-p', s.server.pw], { env: caEnv(), detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          return json({ ok: true });
        }
      }
      json({ error: 'not found' }, 404);
    } catch (err) { json({ error: String(err.message || err) }, 500); }
  });
  srv.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.log(`ca dash is already running: http://127.0.0.1:${port}`); process.exit(0); } throw e; });
  srv.listen(port, '127.0.0.1', () => console.log(`ca dash: http://127.0.0.1:${port}  (ctrl+c to stop)`));
}

function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }

const [cmd, ...args] = process.argv.slice(2);
const usageText = () => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  .filter((l) => l.startsWith('// usage') || l.startsWith('//        ')).map((l) => l.slice(3)).join('\n');
const table = { lane: () => (args.includes('--detach') ? cmdDetach(...args.filter((a) => !a.startsWith('--'))) : runLane(args[0], args[1])), status: () => cmdStatus(args), summary: () => cmdSummary(args), wait: () => cmdWait(args), init: () => cmdInit(args), doctor: () => cmdDoctor(args), mcp: () => cmdMcp(), tail: () => cmdTail(args), steer: () => cmdSteer(args), attach: () => cmdAttach(args), stop: () => cmdStop(args), dash: () => cmdDash(args), gc: () => cmdGc(), plan: () => cmdPlan(args), note: () => cmdNote(args), setup: () => cmdSetup(args) };
if (cmd === 'help' || cmd === '-h' || cmd === '--help' || !cmd) { process.stdout.write(usageText() + '\n'); process.exit(0); }
if (!table[cmd]) { process.stderr.write(usageText() + '\n'); process.exit(2); }
await table[cmd]();
