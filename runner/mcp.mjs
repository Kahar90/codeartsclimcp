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
const VERSION = '1.0.0';

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
  'Steer a running lane with ca_steer, stop it with ca_stop.',
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

// ---------- stdin loop: one JSON-RPC message per line, exit when stdin ends ----------
let exited = false;
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
  handleMessage(msg).catch((e) => log('unhandled message error:', e));
});
rl.on('close', shutdown);
process.stdin.on('error', () => shutdown());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown());
