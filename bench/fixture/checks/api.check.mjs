// Contract check for the notes API: starts the server on a free loopback port and drives it over HTTP.
import { createServer } from '../server.mjs';
const srv = createServer();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, j }; };
try {
  let r = await call('GET', '/notes'); check('GET /notes starts empty', r.code === 200 && Array.isArray(r.j) && r.j.length === 0);
  r = await call('POST', '/notes', { title: 'Buy milk', body: 'two litres' });
  check('POST /notes creates a note with id, title, body, createdAt (201)', r.code === 201 && r.j?.id === 1 && r.j.title === 'Buy milk' && r.j.body === 'two litres' && !Number.isNaN(Date.parse(r.j.createdAt)), JSON.stringify(r));
  r = await call('POST', '/notes', { title: '   ' }); check('POST rejects a blank title with 400 and an error message', r.code === 400 && typeof r.j?.error === 'string', JSON.stringify(r));
  r = await call('POST', '/notes', { title: 'x'.repeat(121) }); check('POST rejects a title over 120 chars with 400', r.code === 400, JSON.stringify(r));
  await call('POST', '/notes', { title: 'Call mum', body: 'about the trip' });
  await call('POST', '/notes', { title: 'Milk the budget', body: '' });
  r = await call('GET', '/notes?q=milk'); check('GET /notes?q= searches title and body, case-insensitive', r.code === 200 && r.j?.length === 2 && r.j.every((n) => /milk/i.test(n.title + n.body)), JSON.stringify(r.j));
  r = await call('GET', '/notes?q=TRIP'); check('search matches the body too', r.j?.length === 1 && r.j[0].title === 'Call mum');
  r = await call('GET', '/notes/2'); check('GET /notes/:id returns one note', r.code === 200 && r.j?.id === 2);
  r = await call('PATCH', '/notes/2', { title: 'Call dad' }); check('PATCH /notes/:id updates the title and keeps the body', r.code === 200 && r.j?.title === 'Call dad' && r.j.body === 'about the trip', JSON.stringify(r));
  r = await call('PATCH', '/notes/2', { title: '' }); check('PATCH validates like POST (400)', r.code === 400);
  r = await call('DELETE', '/notes/2'); check('DELETE /notes/:id answers 204', r.code === 204);
  r = await call('GET', '/notes/2'); check('a deleted note is gone (404)', r.code === 404);
  r = await call('DELETE', '/notes/99'); check('DELETE of a missing note is 404', r.code === 404);
  r = await call('POST', '/notes', { title: 'After delete' }); check('ids keep counting after a delete (4)', r.j?.id === 4, JSON.stringify(r.j));
  r = await call('GET', '/notes'); check('list is newest first', r.j?.[0]?.title === 'After delete' && r.j.length === 3, JSON.stringify(r.j?.map((n) => n.id)));
} finally { srv.close(); }
for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
