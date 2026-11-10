import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EXE, caEnv, redactEnv, freePort, now, sleep, killTree } from './common.mjs';
import { profileMode, parseToolIds, applyCoreProfile } from './toolprofile.mjs';
import { reviewRoleEnv } from './reviewrole.mjs';

// Opt-in per-lane tool profile: with the core profile every prompt_async request denies the tools a
// coding lane does not need (see runner/toolprofile.mjs). The tool ids come from the same private
// server, fetched once and cached until the server restarts. No profile (full) keeps the exact
// previous request and fetches nothing. A lane selects the profile once (from its brief and the
// environment) and hands it to the Server; a direct caller that passes none still reads the
// CA_TOOL_PROFILE environment dynamically, exactly as before.
const TOOL_IDS_PATH = '/experimental/tool/ids';
const TOOL_IDS_TIMEOUT = 5000;
const isPromptAsync = (method, p) => method === 'POST' && /\/prompt_async$/.test(p);

// ---------- one private codearts server ----------
export class Server {
  // toolProfile is the optional mode already selected for this lane ('core' or 'full'); when it is
  // not given the caller reads the environment dynamically, so existing direct callers are unchanged.
  constructor(cwd, logFile, toolProfile) { this.cwd = cwd; this.logFile = logFile; this.ac = null; this.toolIdsP = null; this.toolProfile = toolProfile; }
  get auth() { return 'Basic ' + Buffer.from('codearts:' + this.pw).toString('base64'); }
  // Clear cached tool metadata: called on every (re)start, so a restarted private server refetches.
  resetToolProfile() { this.toolIdsP = null; }
  // The tool ids endpoint, fetched once per private server (bounded by TOOL_IDS_TIMEOUT). A
  // malformed or unavailable answer rejects, and the rejection is not cached, so the next request
  // retries instead of silently bypassing an explicit profile.
  toolIdsOnce() {
    if (!this.toolIdsP) {
      this.toolIdsP = (async () => {
        try { return parseToolIds(await this.api('GET', TOOL_IDS_PATH, null, TOOL_IDS_TIMEOUT)); }
        catch (err) { this.toolIdsP = null; throw err; }
      })();
    }
    return this.toolIdsP;
  }
  // The outgoing body for a prompt_async request. No profile: returned untouched, nothing fetched.
  // Unknown profile: fails visibly. Core: denies every non-core id (a new body; never mutates the
  // caller's object, never inserts true and never touches an inherited core/plan permission). A lane
  // passes its selected mode; a direct caller without one falls back to the CA_TOOL_PROFILE env.
  async profileBody(body) {
    const mode = this.toolProfile !== undefined ? this.toolProfile : profileMode(process.env.CA_TOOL_PROFILE);
    if (mode === 'full') return body;
    if (mode === 'unknown') throw new Error(`tool profile: unknown CA_TOOL_PROFILE "${process.env.CA_TOOL_PROFILE}" (expected "core", "full" or unset)`);
    return applyCoreProfile(body, await this.toolIdsOnce());
  }
  async start() {
    this.resetToolProfile();
    this.port = await freePort();
    this.pw = this.pw || crypto.randomBytes(16).toString('hex');
    this.url = `http://127.0.0.1:${this.port}`;
    // One child env for this private server, scoped by the reviewer role (agent.plan only), used for
    // both the actual spawn and the redacted CA_DUMP_ENV, so what is debugged is what is spawned and
    // no secret is written. The role is wired here and only here: global caEnv and user config stay
    // untouched.
    const childEnv = reviewRoleEnv(caEnv({ CODEARTS_SERVER_PASSWORD: this.pw }));
    if (process.env.CA_DUMP_ENV) fs.writeFileSync(process.env.CA_DUMP_ENV, JSON.stringify({ env: redactEnv(childEnv), cwd: this.cwd }, null, 1));
    const out = fs.openSync(this.logFile, 'a');
    try {
      this.child = spawn(EXE, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'WARN'],
        { cwd: this.cwd, env: childEnv, stdio: ['ignore', out, out], windowsHide: true });
    } finally { fs.closeSync(out); }
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
    if (isPromptAsync(method, p) && body && typeof body === 'object') body = await this.profileBody(body);
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
