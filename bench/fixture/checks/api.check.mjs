// Contract check for the notes API: starts the server on a free loopback port and drives it over HTTP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
const file = path.join(dataDir, 'notes.json');
async function start(opts) { const srv = createServer(opts); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return { srv, base: `http://127.0.0.1:${srv.address().port}` }; }
let base = '';
const call = async (method, p, body, raw) => {
  let r; try { r = await fetch(base + p, { method, signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }); } catch (e) { return { code: -1, j: null, h: new Headers(), error: String(e.cause?.code || e.message) }; }
  let j = null; try { j = await r.json(); } catch {}
  return { code: r.status, j, h: r.headers };
};
let s = await start({ file });
base = s.base;
try {
  // step 1: CRUD and validation
  let r = await call('GET', '/notes'); check('GET /notes starts empty', r.code === 200 && Array.isArray(r.j) && r.j.length === 0);
  r = await call('POST', '/notes', { title: '  Buy milk ', body: 'two litres', tags: ['Home', 'shop'] });
  check('POST creates {id, title (trimmed), body, tags (lower-case), createdAt} with 201', r.code === 201 && r.j?.id === 1 && r.j.title === 'Buy milk' && r.j.body === 'two litres' && JSON.stringify(r.j.tags) === '["home","shop"]' && !Number.isNaN(Date.parse(r.j.createdAt)), JSON.stringify(r.j));
  r = await call('POST', '/notes', { title: '   ' }); check('blank title is 400 {error}', r.code === 400 && typeof r.j?.error === 'string');
  r = await call('POST', '/notes', { title: 'x'.repeat(121) }); check('title over 120 chars is 400', r.code === 400);
  r = await call('POST', '/notes', { title: 'ok', body: 5 }); check('non-string body is 400', r.code === 400);
  r = await call('POST', '/notes', { title: 'ok', tags: 'home' }); check('tags must be an array of strings (400)', r.code === 400);
  r = await call('GET', '/notes/1'); check('GET /notes/:id', r.code === 200 && r.j?.id === 1);
  r = await call('GET', '/notes/01'); check('a non-canonical id (01) is 404', r.code === 404);
  r = await call('PATCH', '/notes/1', { title: 'Buy oat milk' }); check('PATCH updates title, keeps body and tags', r.code === 200 && r.j?.title === 'Buy oat milk' && r.j.body === 'two litres' && r.j.tags.length === 2);
  r = await call('PATCH', '/notes/1', { title: 'New', body: 7 }); check('PATCH validates everything before changing anything (400, no partial write)', r.code === 400);
  r = await call('GET', '/notes/1'); check('the note is unchanged after a rejected PATCH', r.j?.title === 'Buy oat milk', JSON.stringify(r.j));
  r = await call('DELETE', '/notes/1'); check('DELETE answers 204', r.code === 204);
  r = await call('DELETE', '/notes/1'); check('DELETE again is 404', r.code === 404);
  // step 2: search, tags, pagination
  for (let i = 1; i <= 12; i++) await call('POST', '/notes', { title: `Note ${i}`, body: i % 3 ? 'plain' : 'about MILK', tags: i % 2 ? ['odd'] : ['even'] });
  r = await call('GET', '/notes'); check('list is newest first, default limit 10, X-Total-Count header', r.j?.length === 10 && r.j[0].title === 'Note 12' && r.h.get('x-total-count') === '12', `${r.j?.length} ${r.j?.[0]?.title} ${r.h.get('x-total-count')}`);
  r = await call('GET', '/notes?limit=5&offset=10'); check('limit and offset page through the list', r.j?.length === 2 && r.j[0].title === 'Note 2', JSON.stringify(r.j?.map((n) => n.title)));
  r = await call('GET', '/notes?limit=0'); check('limit must be 1 to 100 (400)', r.code === 400);
  r = await call('GET', '/notes?q=milk'); check('q matches title or body case-insensitively', r.j?.length === 4 && r.h.get('x-total-count') === '4', `${r.j?.length}`);
  const ab = await call('POST', '/notes', { title: 'ab', body: 'cd' });
  r = await call('GET', '/notes?q=bc'); check('q does not match across the title/body boundary', r.j?.length === 0, JSON.stringify(r.j?.map((n) => n.title)));
  await call('DELETE', `/notes/${ab.j?.id}`);
  r = await call('GET', '/notes?tag=even&q=milk'); check('tag filter combines with q', r.j?.length === 2 && r.j.every((n) => n.tags.includes('even')), JSON.stringify(r.j?.map((n) => n.title)));
  // step 4: hardening
  r = await call('POST', '/notes', undefined, '{"title": oops'); check('malformed JSON is 400 on POST', r.code === 400);
  r = await call('PATCH', '/notes/2', undefined, 'not json'); check('malformed JSON is 400 on PATCH', r.code === 400);
  r = await call('POST', '/notes', { title: 'big', body: 'x'.repeat(70 * 1024) }); check('a body over 64 KB is 413', r.code === 413);
  r = await call('PUT', '/notes/2', { title: 'x' }); check('an unsupported method on a known route is 405', r.code === 405);
  r = await call('GET', '/nope'); check('an unknown route is 404 {error}', r.code === 404 && typeof r.j?.error === 'string');
} finally { s.srv.close(); }
// step 3: persistence
try {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('the data file holds the notes and the next id', Array.isArray(saved.notes) && saved.notes.length === 12 && saved.nextId === 15, JSON.stringify({ n: saved.notes?.length, nextId: saved.nextId }));
} catch (e) { check('the data file holds the notes and the next id', false, e.message); }
check('no temp files left next to the data file (atomic write via rename)', fs.readdirSync(dataDir).every((f) => f === 'notes.json'), fs.readdirSync(dataDir).join(','));
s = await start({ file }); base = s.base;
try {
  let r = await call('GET', '/notes?limit=100'); check('a new server loads the saved notes', r.j?.length === 12, `${r.j?.length}`);
  r = await call('POST', '/notes', { title: 'after restart' }); check('ids continue after a restart (15)', r.j?.id === 15, JSON.stringify(r.j));
} finally { s.srv.close(); }
const s2 = createServer(); await new Promise((r) => s2.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${s2.address().port}`;
try { const r = await call('POST', '/notes', { title: 'memory only' }); check('without a file option the server still works in memory', r.code === 201); } finally { s2.close(); }
fs.rmSync(dataDir, { recursive: true, force: true });
for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
