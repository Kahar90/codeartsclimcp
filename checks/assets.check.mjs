// Contract check for the Pixel Workshop asset route and kit files (no browser).
// Usage: node checks/assets.check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = path.join(ROOT, 'runner', 'assets');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const m = JSON.parse(fs.readFileSync(path.join(A, 'sprites.json'), 'utf8'));
for (const role of ['lead', 'builder', 'artist', 'reviewer']) {
  const r = m.roles[role];
  check(`sprites.json has ${role}`, !!r);
  if (!r) continue;
  check(`${role} atlas exists`, fs.existsSync(path.join(A, r.atlas)), r.atlas);
  for (const c of ['idle', 'work', 'receive', 'complete', 'blocked']) check(`${role} clip ${c}`, !!r.clips[c]?.frames?.length);
}
check('scene.json has four stations', Object.keys(JSON.parse(fs.readFileSync(path.join(A, 'scene.json'), 'utf8')).stations).length === 4);
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dash = spawn(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'dash', String(port)], { stdio: 'ignore', env: { ...process.env, CA_DASH: '0' } });
const base = `http://127.0.0.1:${port}`;
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); try { up = (await fetch(base + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);
  for (const [p, type] of [['/assets/workshop.png', 'image/png'], ['/assets/atlases/builder.png', 'image/png'], ['/assets/sprites.json', 'application/json'], ['/assets/workshop.js', 'text/javascript'], ['/assets/workshop.css', 'text/css']]) {
    const r = await fetch(base + p); check(`GET ${p}`, r.ok && (r.headers.get('content-type') || '').startsWith(type), `${r.status} ${r.headers.get('content-type')}`);
  }
  for (const p of ['/assets/../ca.mjs', '/assets/%2e%2e/ca.mjs', '/assets/build_sprites.py', '/assets/nope.png']) { const r = await fetch(base + p); check(`GET ${p} refused`, r.status === 404, String(r.status)); }
} finally { dash.kill(); }
console.log(results.join('\n'));
const bad = results.filter((r) => r.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
process.exit(bad ? 1 : 0);
