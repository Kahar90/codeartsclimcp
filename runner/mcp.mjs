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

// ---------- stdin loop: one JSON-RPC message per line, exit when stdin ends ----------
let exited = false;
function shutdown() {
  if (exited) return;
  exited = true;
  closing = true;
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
