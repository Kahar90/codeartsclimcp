#!/usr/bin/env node
// MCP server (stdio transport) for the ca lane runner: exposes runner/ca.mjs as tools so any
// agent harness (Claude Code, Kiro, Cursor, Codex, VS Code) can plan, start, watch, steer and
// judge CodeArts lanes. One JSON-RPC 2.0 message per line on stdin/stdout, logs go to stderr.
// Started in process by `ca mcp` (the mcp entry in the command table of runner/ca.mjs) and
// runnable directly with node. Requests run concurrently: a long ca_wait never blocks ping.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.join(HERE, 'ca.mjs');
const WORKFLOW = path.resolve(HERE, '..', 'docs', 'workflow.md');
let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'; } catch { VERSION = '0.0.0'; }

// ---------- stdio: only JSON-RPC lines on stdout, all logging on stderr ----------
let closing = false;
const log = (...a) => { try { process.stderr.write(a.map((x) => (x instanceof Error ? x.stack || x.message : String(x))).join(' ') + '\n'); } catch {} };
function send(msg) {
  if (closing) return;
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { log('stdout write failed:', e && e.message); }
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
process.stdout.on('error', (e) => log('stdout error:', e && e.message));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e));

// ---------- dispatch: requests run concurrently, notifications are ignored ----------
class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const methods = {};

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return replyError(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 request object');
  const { id, method } = msg;
  if (id === undefined || id === null) return; // notification: no reply
  if (typeof method !== 'string') return replyError(id, -32600, 'Invalid Request: method must be a string');
  const handler = methods[method];
  if (!handler) return replyError(id, -32601, `Method not found: ${method}`);
  try {
    reply(id, await handler(typeof msg.params === 'object' && msg.params !== null ? msg.params : {}));
  } catch (e) {
    if (e instanceof RpcError) return replyError(id, e.code, e.message);
    log(`error while handling ${method}:`, e);
    replyError(id, -32603, `Internal error in ${method}: ${(e && e.message) || e}`);
  }
}

// ---------- initialize, ping ----------
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'You are the lead over CodeArts build lanes: the lanes are the workers.',
  'Run ca_doctor first and fix every fail row, write one brief per lane with ca_init, then start it with ca_lane_start.',
  'Block on ca_wait instead of polling ca_status; exit 124 means still running, call it again.',
  'When a lane ends, read ca_summary, judge the reviewer findings against the brief and verify the work yourself by running the repo checks on the branch.',
  'Steer a running lane with ca_steer, kick a stuck turn with ca_kick, stop it with ca_stop, and continue a paused, failed, stopped or DEAD lane with ca_resume.',
  'The human watches the dashboard at http://127.0.0.1:4777 (Office view at /office).',
].join(' ');

methods.initialize = (params) => ({
  protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
  capabilities: { tools: {}, prompts: {} },
  serverInfo: { name: 'codearts-lanes', version: VERSION },
  instructions: INSTRUCTIONS,
});
methods.ping = () => ({});

// ---------- tool runner: node ca.mjs <args>, always async spawn, never spawnSync ----------
// Children are tracked so none is left running after stdin ends; only processes this server
// started are ever killed. Args go through an argv array (no shell), so paths with spaces work.
const children = new Set();
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}
function runCli(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CA, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: 125, stdout: '', stderr: `could not start ${CA}: ${e && e.message}` });
      return;
    }
    children.add(child);
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (code) => { if (settled) return; settled = true; children.delete(child); clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); };
    timer = setTimeout(() => {
      err += `\n[mcp] ca ${args[0]} still running after ${Math.round(timeoutMs / 1000)}s, killed it`;
      killChild(child);
      finish(125);
    }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    child.on('error', (e) => { err += `\n[mcp] could not run ca ${args[0]}: ${e && e.message}`; finish(125); });
    child.on('close', (code) => finish(code === null || code === undefined ? 125 : code));
  });
}

// ---------- tools ----------
class ArgError extends Error {
  constructor(name) { super(name); this.argName = name; }
}
const needStr = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new ArgError(name);
  return v.trim();
};
const needCount = (v, name, def, max) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new ArgError(name);
  return Math.min(Math.round(n), max);
};
const needNum = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ArgError(name);
  return String(Math.round(n));
};
const optStr = (a, name) => (a[name] === undefined || a[name] === null ? [] : [needStr(a[name], name)]);
const needLanes = (v) => {
  if (!Array.isArray(v) || v.length < 1 || !v.every((x) => typeof x === 'string' && x.trim())) throw new ArgError('lanes');
  return v.map((x) => x.trim());
};

const TOOLS = [
  {
    name: 'ca_doctor',
    description: 'Preflight for lanes: runs ca doctor and returns one JSON row per check (node, codearts, credentials, git, folder trust, shell) with status ok, warn or fail. Use it before the first lane in a repo and fix every fail row; warn rows are optional. A doctor that reports failures is data, not a tool error.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'repo path to check (default: the server working directory)' } }, required: [] },
    ok: [0, 1],
    timeout: 120000,
    build: (a) => ['doctor', '--json', ...optStr(a, 'repo')],
  },
  {
    name: 'ca_init',
    description: 'Scaffold a lane brief at <repo>/tasks/<task>.md from the template, with the goal filled in. Use it once per lane, then edit the brief (numbered steps, one CHECK line per check, safety rules) before ca_lane_start. Refuses to overwrite an existing brief unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'path of the repo the lane works in' },
        task: { type: 'string', description: 'task name; becomes tasks/<task>.md and the lane id <repo>--<task>' },
        goal: { type: 'string', description: 'one sentence goal written into the brief' },
        force: { type: 'boolean', description: 'overwrite an existing brief' },
      },
      required: ['repo', 'task'],
    },
    ok: [0],
    timeout: 60000,
    build: (a) => ['init', needStr(a.repo, 'repo'), needStr(a.task, 'task'),
      ...(a.goal !== undefined && a.goal !== null ? ['--goal', needStr(a.goal, 'goal')] : []),
      ...(a.force ? ['--force'] : [])],
  },
  {
    name: 'ca_lane_start',
    description: 'Start a lane in the background (ca lane <repo> <task> --detach): a CodeArts worker reads the brief, builds, commits each step and runs the CHECK lines itself. Returns at once; follow it with ca_wait. Use it only after ca_doctor is clean and the brief at tasks/<task>.md exists.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'path of the repo the lane works in' },
        task: { type: 'string', description: 'task name; the brief tasks/<task>.md must exist' },
      },
      required: ['repo', 'task'],
    },
    ok: [0],
    timeout: 30000,
    build: (a) => ['lane', needStr(a.repo, 'repo'), needStr(a.task, 'task'), '--detach'],
  },
  {
    name: 'ca_status',
    description: 'Snapshot of all lanes as JSON: health, phase, elapsed, step progress, tokens, result, verdict. Use it to see what exists and what finished; to wait for a lane, block on ca_wait instead of polling this.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'include lanes that finished more than 24 h ago' } }, required: [] },
    ok: [0],
    timeout: 60000,
    build: (a) => ['status', '--json', ...(a.all ? ['--all'] : [])],
  },
  {
    name: 'ca_wait',
    description: 'Block until every given lane has a result or timeout_s passes (default 45, max 55: MCP clients such as Codex and opencode cancel a tool call after about 60 s, so it always answers in time; a lane takes minutes, so expect to call it several times). Returns the per-lane results plus exit (worst lane: 0 done, 1 failed or stopped, 3 keys missing or rejected (run ca auth), 4 needs review, 5 paused (ca_resume continues it), 124 still running) and a next field that says what to do. timedOut true (exit 124) means still running: the lanes field carries current status rows, decide and call it again. Use this instead of polling ca_status.',
    inputSchema: {
      type: 'object',
      properties: {
        lanes: { type: 'array', items: { type: 'string' }, description: 'lane ids or task names to wait for (as in ca_status)' },
        timeout_s: { type: 'number', description: 'how long to block at most, seconds (default 45, max 55)' },
      },
      required: ['lanes'],
    },
    run: waitResult,
  },
  {
    name: 'ca_summary',
    description: 'Final report of one lane as JSON: result, verdict, commits, gates, fix rounds, interruptions, steering, outside-repo access and the summary text. Read it when a lane ends, judge the reviewer findings against the brief and verify the work yourself; open ca_tail only when the summary points at a problem.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string', description: 'lane id or task name (as in ca_status)' } }, required: ['lane'] },
    ok: [0],
    timeout: 60000,
    build: (a) => ['summary', needStr(a.lane, 'lane'), '--json'],
  },
  {
    name: 'ca_tail',
    description: 'Last lines of a lane transcript: worker replies, thinking, every tool call. Use it only when ca_summary or ca_status points at a problem; it is for debugging a lane, not for waiting (use ca_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'lane id or task name' },
        lines: { type: 'number', description: 'how many lines to return (default 60)' },
      },
      required: ['lane'],
    },
    ok: [0],
    timeout: 60000,
    build: (a) => ['tail', needStr(a.lane, 'lane'), '-n', String(needCount(a.lines, 'lines', 60, 10000))],
  },
  {
    name: 'ca_steer',
    description: 'Queue a steering message into a running lane (clarification, scope cut, "also do X"); it enters the session within about 2 s. Use it for course corrections while the lane runs; for a real change of direction use ca_stop, edit the brief and start a new lane.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'lane id or task name; the lane must still be running' },
        message: { type: 'string', description: 'the message for the worker, applied on top of the brief' },
      },
      required: ['lane', 'message'],
    },
    ok: [0],
    timeout: 60000,
    build: (a) => ['steer', needStr(a.lane, 'lane'), needStr(a.message, 'message')],
  },
  {
    name: 'ca_stop',
    description: 'Stop a lane: the supervisor aborts the session and writes the summary within a few seconds; on a DEAD lane it cleans up. Use it when the direction changed or the lane is beyond steering, then edit the brief and start again.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string', description: 'lane id or task name' } }, required: ['lane'] },
    ok: [0],
    timeout: 60000,
    build: (a) => ['stop', needStr(a.lane, 'lane')],
  },
  {
    name: 'ca_ack',
    description: 'Acknowledge a finished lane after you dealt with it (merged it yourself, took it over, or decided to drop it): a failed, paused or needs-review lane moves from "needs you" to ended with your note, so the human\'s Control room only lists what still needs them. A later run of the lane makes it count again. Pass stale:true to clean up drift in one call: every finished Needs-you lane older than older_than_h (default 48) is marked handled; running, stalled and DEAD lanes are never touched.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string', description: 'lane id or task name; the lane must be finished' }, note: { type: 'string', description: 'short reason, for example "merged by the lead"' }, stale: { type: 'boolean', description: 'mark every finished Needs-you lane older than older_than_h handled, without naming one' }, older_than_h: { type: 'number', description: 'age in hours for the stale form (default 48)' } } },
    ok: [0],
    timeout: 60000,
    build: (a) => {
      if (a.stale) {
        const h = (a.older_than_h === undefined || a.older_than_h === null || a.older_than_h === '') ? 48 : Number(a.older_than_h);
        if (!Number.isFinite(h) || h <= 0) throw new ArgError('older_than_h');
        // In minutes: a fractional hour such as 0.3 must never round down to 0 and sweep every lane.
        return ['ack', '--stale', '--older-than', `${Math.max(1, Math.round(h * 60))}m`, ...(a.note ? ['--note', String(a.note)] : [])];
      }
      if (a.lane !== undefined && a.lane !== null && a.lane !== '') return ['ack', needStr(a.lane, 'lane'), ...(a.note ? ['--note', String(a.note)] : [])];
      throw new ArgError('lane');
    },
  },
  {
    name: 'ca_kick',
    description: 'Kick a stuck lane turn (ca kick): turn (default) aborts and resumes the current turn, fresh starts a clean session, server restarts the codearts server, now retries at once and skips a backoff wait. The supervisor applies it within 2 s. Refused while checks run (gate phase) or after the lane ended: use ca_resume there.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'lane id or task name; the lane must still be running' },
        mode: { type: 'string', enum: ['turn', 'fresh', 'server', 'now'], description: 'turn: retry the current turn (default); fresh: clean session; server: restart the codearts server; now: retry now, skipping a backoff' },
        message: { type: 'string', description: 'why the kick was given; the worker sees it with the resume' },
      },
      required: ['lane'],
    },
    ok: [0],
    timeout: 60000,
    build: (a) => {
      const mode = a.mode === undefined || a.mode === null || a.mode === '' ? 'turn' : String(a.mode);
      if (!['turn', 'fresh', 'server', 'now'].includes(mode)) throw new ArgError('mode');
      return ['kick', needStr(a.lane, 'lane'), ...({ fresh: ['--fresh'], server: ['--server'], now: ['--now'] }[mode] || []),
        ...(a.message !== undefined && a.message !== null ? [needStr(a.message, 'message')] : [])];
    },
  },
  {
    name: 'ca_resume',
    description: 'Continue a paused, failed, stopped or DEAD lane in place (ca resume): it keeps the commits and state and runs with --resume, applying the optional note first. Refused on a done lane or one still running (steer or stop those instead).',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'lane id or task name' },
        note: { type: 'string', description: 'lead note for the resumed run; the worker applies it before continuing' },
      },
      required: ['lane'],
    },
    ok: [0],
    timeout: 60000,
    build: (a) => ['resume', needStr(a.lane, 'lane'), ...(a.note !== undefined && a.note !== null ? ['--note', needStr(a.note, 'note')] : [])],
  },
  {
    name: 'ca_plan',
    description: 'Register the lead plan JSON (tasks/plan.json: title, goal, waves, lanes, next, decisions, risks) so the dashboard shows goal, waves and lane progress. Use it after writing or updating the plan file.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'path of the plan JSON, usually tasks/plan.json' } }, required: ['file'] },
    ok: [0],
    timeout: 30000,
    build: (a) => ['plan', needStr(a.file, 'file')],
  },
  {
    name: 'ca_plan_list',
    description: 'List the registered plans with their state and a per-wave lane summary (ca plan list). Use it to see which plan is active and what it still contains before closing it.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    ok: [0],
    timeout: 30000,
    build: () => ['plan', 'list'],
  },
  {
    name: 'ca_plan_close',
    description: 'Close a registered plan (ca plan close [id] --reason <reason>) when the work is finished or a wave will not run: the plan is marked done, the reason is recorded, and never-started lanes become Dropped. Defaults to the newest registered plan when id is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'plan id to close (default: the newest registered plan)' },
        reason: { type: 'string', description: 'why the plan is closed; recorded on the plan' },
      },
      required: [],
    },
    ok: [0],
    timeout: 30000,
    build: (a) => ['plan', 'close', ...optStr(a, 'id'), ...(a.reason === undefined || a.reason === null ? [] : ['--reason', needStr(a.reason, 'reason')])],
  },
  {
    name: 'ca_gc',
    description: 'Forget lanes that finished more than 3 days ago (ca gc) so ca_status and the dashboard stay short. Use it once old lanes no longer matter.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    ok: [0],
    timeout: 60000,
    build: () => ['gc'],
  },
  {
    name: 'ca_note',
    description: 'Log a lead decision on the registered plan, or set the "lead is doing" line with now: true. Use it to keep the dashboard current while lanes run.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the decision, or the current activity with now true' },
        now: { type: 'boolean', description: 'true: set the "lead is doing" line instead of appending a decision' },
      },
      required: ['text'],
    },
    ok: [0],
    timeout: 30000,
    build: (a) => ['note', ...(a.now ? ['--now'] : []), needStr(a.text, 'text')],
  },
  {
    name: 'ca_lead_tokens',
    description: 'Report the lead harness own token usage on the registered plan so the dashboard counts the lead, not only the CodeArts workers (ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--plan id]). Use add: true to accumulate onto an existing entry. Unknown usage is never shown as zero: report only what the harness knows.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'model id the lead ran on, for example maas/glm-5.3' },
        input: { type: 'number', description: 'input tokens the lead used (default 0)' },
        output: { type: 'number', description: 'output tokens the lead used (default 0)' },
        cache_read: { type: 'number', description: 'cache read tokens, optional' },
        cache_write: { type: 'number', description: 'cache write tokens, optional' },
        plan: { type: 'string', description: 'plan id to attach to (default: the newest registered plan)' },
        add: { type: 'boolean', description: 'true: add to an existing entry for this model instead of replacing it' },
      },
      required: ['model'],
    },
    ok: [0],
    timeout: 30000,
    build: (a) => ['lead-tokens', ...(a.plan === undefined || a.plan === null ? [] : ['--plan', needStr(a.plan, 'plan')]), '--set', needStr(a.model, 'model'),
      '--input', needNum(a.input === undefined || a.input === null ? 0 : a.input, 'input'),
      '--output', needNum(a.output === undefined || a.output === null ? 0 : a.output, 'output'),
      ...(a.cache_read === undefined || a.cache_read === null ? [] : ['--cache-read', needNum(a.cache_read, 'cache_read')]),
      ...(a.cache_write === undefined || a.cache_write === null ? [] : ['--cache-write', needNum(a.cache_write, 'cache_write')]),
      ...(a.add ? ['--add'] : [])],
  },
];

// The last {...} JSON object on stdout: ca wait prints CA_RESULT lines plus one JSON object
// ({"lanes":[...]} when done, {"timeout":true,"lanes":[status rows]} on exit 124).
function lastJsonObject(s) {
  const lines = String(s || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.charCodeAt(0) !== 123 || t.charCodeAt(t.length - 1) !== 125) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* a CA_RESULT or partial line, keep looking */ }
  }
  return null;
}

// ca_wait: exit codes 0, 1, 3, 4, 5 and 124 are results (each carries a next step); 2 (unknown lane) and anything else are tool errors.
const WAIT_NEXT = {
  0: 'read ca_summary for each lane and verify the work',
  1: 'read ca_summary; ca_resume continues a failed or stopped lane with a note',
  3: 'keys missing or rejected: ask the human to run ca auth (a local form opens; never ask for keys in chat), then ca_resume the lane',
  4: 'read ca_summary: the reviewer asked for changes',
  5: 'paused at LANE_TIMEOUT: ca_resume the lane to continue where it stopped',
  124: 'still running: call ca_wait again',
};
async function waitResult(a) {
  const lanes = needLanes(a.lanes);
  // Capped below the ~60 s tool timeout of common MCP clients: a longer block comes back as a client error.
  const timeoutS = needCount(a.timeout_s, 'timeout_s', 45, 55);
  const r = await runCli(['wait', ...lanes, '--json', '--quiet', '--timeout', String(timeoutS)], timeoutS * 1000 + 25000);
  const final = lastJsonObject(r.stdout);
  if (![0, 1, 3, 4, 5, 124].includes(r.code) || !final) {
    const raw = ((r.stderr ? r.stderr.trim() + '\n' : '') + r.stdout).trim();
    return { content: [{ type: 'text', text: `ca_wait exited ${r.code}${raw ? ':\n' + raw : ' with no output'}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ...final, exit: r.code, timedOut: r.code === 124, next: WAIT_NEXT[r.code] }, null, 2) }], isError: false };
}

async function cliResult(tool, cliArgs) {
  const r = await runCli(cliArgs, tool.timeout || 120000);
  const ok = tool.ok.includes(r.code);
  const text = ok
    ? (r.stdout.trim() || r.stderr.trim() || `ca ${cliArgs[0]} exited ${r.code} with no output`)
    : (((r.stderr ? r.stderr.trim() + '\n' : '') + r.stdout).trim() || `ca ${cliArgs[0]} exited ${r.code} with no output`);
  return { content: [{ type: 'text', text }], isError: !ok };
}

// MCP annotations per tool: read-only tools are safe to auto-approve; the two that end work
// (ca_stop, ca_plan_close) are destructive; every other tool changes state without destroying it.
const READ_ONLY_TOOLS = new Set(['ca_doctor', 'ca_status', 'ca_wait', 'ca_summary', 'ca_tail', 'ca_plan_list']);
const DESTRUCTIVE_TOOLS = new Set(['ca_stop', 'ca_plan_close']);
const annotationsFor = (name) => (READ_ONLY_TOOLS.has(name)
  ? { readOnlyHint: true }
  : { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(name) });
methods['tools/list'] = () => ({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: annotationsFor(t.name) })) });
methods['tools/call'] = async (params) => {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  try {
    if (tool.run) return await tool.run(args);
    return await cliResult(tool, tool.build(args));
  } catch (e) {
    if (e instanceof ArgError) return { content: [{ type: 'text', text: `${tool.name}: missing or invalid required argument "${e.argName}"` }], isError: true };
    throw e;
  }
};

// ---------- prompt: the lead workflow ----------
methods['prompts/list'] = () => ({
  prompts: [{
    name: 'codearts_build',
    description: 'The lead workflow over CodeArts lanes: doctor, plan, briefs, start, wait, judge, verify, report. Returns docs/workflow.md with the goal as the first line.',
    arguments: [{ name: 'goal', description: 'one sentence goal of the whole build', required: false }],
  }],
});
methods['prompts/get'] = (params) => {
  if (params.name !== 'codearts_build') throw new RpcError(-32602, `Unknown prompt: ${params.name}`);
  let text;
  try { text = fs.readFileSync(WORKFLOW, 'utf8'); } catch (e) { throw new RpcError(-32603, `cannot read docs/workflow.md: ${e && e.message}`); }
  const goal = params.arguments && typeof params.arguments.goal === 'string' ? params.arguments.goal.trim() : '';
  return { messages: [{ role: 'user', content: { type: 'text', text: goal ? `Goal: ${goal}\n\n${text}` : text } }] };
};

// ---------- stdin loop: one JSON-RPC message per line, exit when stdin ends ----------
let exited = false;
const inflight = new Set();
function shutdown() {
  if (exited) return;
  exited = true;
  closing = true;
  for (const c of [...children]) killChild(c); // only children this server started
  children.clear();
  const done = () => { try { process.exit(0); } catch {} };
  const timer = setTimeout(done, 300);
  try { process.stdout.write('', () => { clearTimeout(timer); done(); }); } catch { clearTimeout(timer); done(); }
}
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: line is not valid JSON' } }); }
  const p = handleMessage(msg).catch((e) => log('unhandled message error:', e));
  inflight.add(p); p.finally(() => inflight.delete(p));
});
// stdin ended: answer what is already in flight (scripts pipe a few requests and close), then exit.
// Capped at 30 s so a long ca_wait cannot keep an orphaned server alive.
rl.on('close', () => { const cap = new Promise((r) => setTimeout(r, 30000).unref()); Promise.race([Promise.allSettled([...inflight]), cap]).then(shutdown); });
process.stdin.on('error', () => shutdown());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown());
