// A fake `codearts serve` for runner checks: node runs this file as `<node> serve --port N ...`
// (copy it into the lane repo as `serve` and set CODEARTS_EXE to node). It speaks the small part of
// the opencode server API the runner uses and plays one scenario per prompt from fake-script.json
// in its cwd: ["rate", "net", "ok", ...]; the last entry repeats.
//   ok    busy, an answer text, idle
//   rate  busy, 3 rate-limit retries, MessageAbortedError (what CodeArts does on a 429), idle
//   net   busy, session error "TypeError: fetch failed", idle
//   auth  writes a service=auth sign-in error to stdout (the server log) first, then like net
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let script = ['ok']; try { script = JSON.parse(fs.readFileSync('fake-script.json', 'utf8')); } catch {}
let turn = 0; const status = {}; const clients = new Set(); let n = 0;
const emit = (type, properties) => { const d = `data: ${JSON.stringify({ type, properties })}\n\n`; for (const c of clients) c.write(d); };
const later = (ms, f) => setTimeout(f, ms);
function play(sid) {
  const kind = script[Math.min(turn, script.length - 1)]; turn++;
  fs.appendFileSync('fake-turns.log', `${kind}\n`);
  status[sid] = { type: 'busy' }; emit('session.status', { sessionID: sid, status: status[sid] });
  if (kind === 'ok') {
    later(300, () => emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'text', text: 'done' } }));
    later(600, () => { status[sid] = { type: 'idle' }; emit('session.status', { sessionID: sid, status: status[sid] }); emit('session.idle', { sessionID: sid }); });
    return;
  }
  if (kind === 'auth') process.stdout.write('ERROR  2026-11-07T19:53:08.839 +1340ms service=auth "fake sign-in failure 503{}"\n');
  if (kind === 'rate') for (let a = 1; a <= 3; a++) later(100 * a, () => { status[sid] = { type: 'retry', attempt: a, message: 'Too many requests, the rate limit is 1000000 tokens per minute.' }; emit('session.status', { sessionID: sid, status: status[sid] }); });
  const err = kind === 'rate' ? { name: 'MessageAbortedError', data: { message: 'Aborted' } } : { name: 'UnknownError', data: { message: 'TypeError: fetch failed' } };
  later(500, () => emit('session.error', { sessionID: sid, error: err }));
  later(700, () => { status[sid] = { type: 'idle' }; emit('session.status', { sessionID: sid, status: status[sid] }); emit('session.idle', { sessionID: sid }); });
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/global/health') return json({ healthy: true, version: 'fake-1' });
    if (u.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); clients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      const hb = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 5000);
      res.on('close', () => { clearInterval(hb); clients.delete(res); }); return;
    }
    if (req.method === 'POST' && u.pathname === '/session') { const id = `ses_fake${++n}`; status[id] = { type: 'idle' }; return json({ id }); }
    if (u.pathname === '/session/status') return json(status);
    let m = u.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (m) { json({}); setTimeout(() => play(m[1]), 400); return; }
    m = u.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (m) { status[m[1]] = { type: 'idle' }; return json(true); }
    if (/\/message$/.test(u.pathname)) return json([]);
    return json({});
  });
}).listen(port, '127.0.0.1');
