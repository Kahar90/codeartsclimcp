// A tiny notes API (no deps). Start: node server.mjs [port]
import http from 'node:http';

export function createServer() {
  const notes = [];
  let nextId = 1;
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/notes') return send(200, notes);
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
    send(404, { error: 'not found' });
    void nextId;
  });
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const port = Number(process.argv[2] || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`notes api on ${port}`));
}
