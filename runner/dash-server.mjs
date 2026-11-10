import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { kickLane, removeLane, removePlan, resumeLane, steer } from './commands.mjs';
import { CA_ENTRY, EXE, HERE, caEnv, laneSeen, lanesSnapshot, now, oneLine, pickOne, plansSnapshot, setAck, setReqSnap } from './common.mjs';
import { doctorData } from './engineer.mjs';
import { laneDetail, laneView, planView } from './plan.mjs';

// ---------- dashboard ----------
export function cmdDash(args) {
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
    setReqSnap({}); // one lanes()/plans() snapshot per request; rebuilt on the next poll
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
      if (u.pathname === '/api/lanes') return json(lanesSnapshot().map(laneView));
      if (u.pathname === '/api/overview') {
        // The office view in one call: attention buckets and lanes not finished over 3 days ago.
        const ls = lanesSnapshot().filter((l) => !l.s.result || now() - (l.s.finishedAt || 0) < 3 * 24 * 3600e3).map(laneView);
        const counts = { attention: 0, running: 0, done: 0, ended: 0 };
        for (const v of ls) counts[v.bucket] = (counts[v.bucket] || 0) + 1;
        return json({ counts, lanes: ls });
      }
      if (u.pathname === '/api/plans') return json(plansSnapshot().map(planView).sort((a, b) => (a.closed - b.closed) || (b.lastActivity - a.lastActivity)));
      const pm = u.pathname.match(/^\/api\/plans\/(.+)\/remove$/);
      if (pm) {
        // Exact registered-plan id only (ids may carry ~ and .): decode the segment, never die().
        if (req.method !== 'POST') return json({ error: 'use POST /api/plans/<id>/remove' }, 405);
        const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
        const pid = decodeURIComponent(pm[1]);
        const pr = plansSnapshot().find((x) => x.id === pid);
        if (!pr) return json({ error: `no registered plan has id "${pid}"` }, 404);
        const res = await removePlan(pr, { by: 'dashboard' });
        if (res.error) return json({ error: res.error }, res.code || 500);
        return json(res);
      }
      if (u.pathname === '/api/doctor') return json({ checks: (await doctorData()).checks });
      if (u.pathname === '/api/update') {
        // The update pill: the cached check plus the running dash pid. A stale cache refreshes in
        // the background; ?refresh=1 waits for a fresh check. POST runs `ca update` and then
        // restarts this same dashboard on the same port (after the response is sent).
        const { readUpdateCache, checkUpdate, installCommand, currentVersion, UPDATE_TTL_MS } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
        const view = (c) => ({ current: (c && c.current) || currentVersion(), latest: (c && c.latest) || null, available: !!(c && c.available), notes: (c && Array.isArray(c.notes)) ? c.notes : [], cmd: (c && c.cmd) || installCommand(), checkedAt: (c && c.checkedAt) || 0, error: (c && c.error) || undefined, pid: process.pid });
        if (req.method === 'POST') {
          const child = spawn(process.execPath, [CA_ENTRY, 'update', '--json'], { encoding: 'utf8', env: caEnv(), windowsHide: true });
          let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
          const code = await new Promise((res) => { const to = setTimeout(() => { try { child.kill(); } catch {} res(-1); }, 600000); child.on('close', (c) => { clearTimeout(to); res(c); }); child.on('error', () => { clearTimeout(to); res(-1); }); });
          if (code !== 0) {
            const tail = out.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 300);
            return json({ ok: false, error: `${tail} (exit ${code})` }, 500);
          }
          json({ ok: true, restarting: true, output: out.trim().slice(0, 2000) });
          res.on('finish', () => {
            try { srv.close(); } catch {}
            try { spawn(process.execPath, [CA_ENTRY, 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CA_DASH_RECLAIM: '1' } }).unref(); } catch {}
            setTimeout(() => process.exit(0), 50);
          });
          return;
        }
        let cache = readUpdateCache();
        const stale = !cache || typeof cache.checkedAt !== 'number' || Date.now() - cache.checkedAt >= UPDATE_TTL_MS;
        if (u.searchParams.get('refresh') === '1') { try { cache = await checkUpdate({ force: true, timeoutMs: 5000 }); } catch {} }
        else if (stale) { try { spawn(process.execPath, [CA_ENTRY, 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {} }
        return json(view(cache));
      }
      if (u.pathname === '/api/auth') {
        // Start the local key form (runner/auth.mjs) for the Connect keys button and hand back its
        // URL. The child prints JSON only; key values never reach this process, the page or the logs.
        // A route handler must never die(): a stale tab must not kill the dashboard.
        if (req.method !== 'POST') return json({ error: 'use POST /api/auth' }, 405);
        const r = spawnSync(process.execPath, [CA_ENTRY, 'auth', '--no-open', '--json'], { encoding: 'utf8', timeout: 20000, env: caEnv(), windowsHide: true });
        let v = null; try { v = JSON.parse(String(r.stdout || '').trim()); } catch {}
        if (!v) return json({ error: 'auth did not return JSON' }, 500);
        return json({ ready: !!v.ready, url: v.url || '' });
      }
      const m = u.pathname.match(/^\/api\/lane\/([^/]+)\/(log|summary|detail|steer|stop|attach|kick|resume|ack|remove)$/);
      if (m) {
        const q = decodeURIComponent(m[1]); const all = lanesSnapshot();
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
        if (req.method === 'POST' && m[2] === 'remove') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const res = await removeLane(l, { purge: rb.body.keepLogs !== true, by: 'dashboard' });
          if (res.error) return json({ error: res.error }, res.code || 500);
          return json(res);
        }
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
