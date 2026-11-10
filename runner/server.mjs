import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EXE, caEnv, redactEnv, freePort, now, sleep, killTree } from './common.mjs';

// ---------- one private codearts server ----------
export class Server {
  constructor(cwd, logFile) { this.cwd = cwd; this.logFile = logFile; this.ac = null; }
  get auth() { return 'Basic ' + Buffer.from('codearts:' + this.pw).toString('base64'); }
  async start() {
    this.port = await freePort();
    this.pw = this.pw || crypto.randomBytes(16).toString('hex');
    this.url = `http://127.0.0.1:${this.port}`;
    const out = fs.openSync(this.logFile, 'a');
    if (process.env.CA_DUMP_ENV) fs.writeFileSync(process.env.CA_DUMP_ENV, JSON.stringify({ env: redactEnv(caEnv({ CODEARTS_SERVER_PASSWORD: this.pw })), cwd: this.cwd }, null, 1));
    this.child = spawn(EXE, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'WARN'],
      { cwd: this.cwd, env: caEnv({ CODEARTS_SERVER_PASSWORD: this.pw }), stdio: ['ignore', out, out], windowsHide: true });
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
