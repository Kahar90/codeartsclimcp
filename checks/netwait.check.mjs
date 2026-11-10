// Contract check for network and sleep resilience: runner/netwait.mjs classifies network errors,
// waits for the network to come back (injectable probe), detects a sleep gap between watchdog ticks
// and caps concurrent lanes per model; runner/ca.mjs uses all four. Pure functions plus static wiring.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
let m = null; try { m = await import(pathToFileURL(path.join(ROOT, 'runner', 'netwait.mjs')).href); } catch (e) { check('runner/netwait.mjs imports', false, e.message); }
const fn = (n) => typeof m?.[n] === 'function';
check('exports isNetworkError, waitOnline, detectSleep, laneSlots, parseLimits', ['isNetworkError', 'waitOnline', 'detectSleep', 'laneSlots', 'parseLimits'].every(fn));

if (fn('isNetworkError')) {
  const yes = ['getaddrinfo ENOTFOUND api-ap-southeast-1.modelarts-maas.com', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'getaddrinfo EAI_AGAIN host', 'TypeError: fetch failed', 'socket hang up', 'connect ENETUNREACH', 'Cannot connect to the model service', 'Client network socket disconnected before secure TLS connection was established'];
  const no = ['APIError: Invalid authorization header.', 'rate limit 1000000 tokens per minute', 'Infer timeout: no data received over 600000ms', 'Backend service unavailable (HTTP 503)', 'MessageAbortedError: Aborted', ''];
  check('isNetworkError: true for DNS, reset, timeout, unreachable and fetch failures', yes.every((s) => m.isNetworkError(s) === true), yes.filter((s) => !m.isNetworkError(s)).join(' | '));
  check('isNetworkError: false for auth, rate limit, infer timeout, 503 and aborts', no.every((s) => m.isNetworkError(s) === false), no.filter((s) => m.isNetworkError(s)).join(' | '));
}
if (fn('waitOnline')) {
  let n = 0;
  let r = await m.waitOnline({ probe: async () => (++n >= 3), intervalMs: 10, timeoutMs: 2000 });
  check('waitOnline: resolves online after the probe succeeds, reports tries and waited ms', r && r.online === true && r.tries === 3 && typeof r.waitedMs === 'number', JSON.stringify(r));
  const t0 = Date.now(); r = await m.waitOnline({ probe: async () => false, intervalMs: 20, timeoutMs: 150 });
  check('waitOnline: gives up after timeoutMs with online false', r && r.online === false && Date.now() - t0 < 1500, JSON.stringify(r));
  r = await m.waitOnline({ probe: async () => { throw new Error('boom'); }, intervalMs: 10, timeoutMs: 60 });
  check('waitOnline: a throwing probe counts as offline, never rejects', r && r.online === false);
  const ticks = []; r = await m.waitOnline({ probe: async () => ticks.length >= 2, intervalMs: 10, timeoutMs: 1000, onWait: (info) => ticks.push(info) });
  check('waitOnline: calls onWait while offline (for live.log and status)', ticks.length >= 2 && r.online === true);
  const t1 = Date.now(); let stop = false; setTimeout(() => { stop = true; }, 300);
  r = await m.waitOnline({ probe: async () => false, intervalMs: 60000, timeoutMs: 60000, shouldStop: () => stop });
  check('waitOnline: shouldStop ends a long wait within about a second (ca stop during an outage)', r && r.stopped === true && r.online === false && Date.now() - t1 < 3000, JSON.stringify(r));
  check('waitOnline has a default probe (DNS or HTTPS to the model host) when none is given', /lookup|resolve|https?\.request|fetch\(/.test(fs.readFileSync(path.join(ROOT, 'runner', 'netwait.mjs'), 'utf8')));
}
if (fn('defaultProbe')) {
  const savedBase = process.env.MAAS_BASE_URL;
  const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const closedPort = await free();
  let server = null; let mode = 'ok'; const seen = [];
  try {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host });
      if (mode === 'error') { res.writeHead(503); res.end('nope'); return; }
      res.writeHead(200); res.end('ok');
    });
    const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
    process.env.MAAS_BASE_URL = `http://127.0.0.1:${port}/openai/v1`;
    let online = await m.defaultProbe();
    check('defaultProbe probes MAAS_BASE_URL over its own scheme and port (custom http + port honored)', online === true && seen.length > 0 && seen[0].host === `127.0.0.1:${port}`, `online=${online} ${JSON.stringify(seen)}`);

    seen.length = 0; mode = 'error';
    online = await m.defaultProbe();
    check('defaultProbe counts any HTTP answer as online (a 503 is still a live network)', online === true && seen.some((s) => s.method === 'HEAD'), `online=${online} ${JSON.stringify(seen)}`);

    process.env.MAAS_BASE_URL = `http://127.0.0.1:${closedPort}/openai/v1`;
    online = await m.defaultProbe();
    check('defaultProbe returns false for an unreachable endpoint', online === false, `port ${closedPort} online=${online}`);
  } finally {
    if (server) await new Promise((res) => server.close(res));
    if (savedBase === undefined) delete process.env.MAAS_BASE_URL; else process.env.MAAS_BASE_URL = savedBase;
  }
}
if (fn('detectSleep')) {
  check('detectSleep: normal 2 s tick is not sleep', m.detectSleep(1000, 3000, 2000) === false);
  check('detectSleep: a 10 min gap is sleep', m.detectSleep(0, 600000, 2000) === true);
  check('detectSleep: 90 s gap with 2 s ticks is not sleep (threshold at least 120 s)', m.detectSleep(0, 90000, 2000) === false);
  check('detectSleep: threshold scales with long ticks (4 x interval)', m.detectSleep(0, 150000, 60000) === false && m.detectSleep(0, 250000, 60000) === true);
}
if (fn('parseLimits') && fn('laneSlots')) {
  const L = m.parseLimits('');
  check('parseLimits default: glm models 3, other models 4', L.limitFor('maas/glm-5.3') === 3 && L.limitFor('maas/glm-5.2') === 3 && L.limitFor('maas/deepseek-v4.1-flash') === 4 && L.limitFor('huaweicloud-maas/GLM-5.2') === 3, JSON.stringify([L.limitFor('maas/glm-5.3'), L.limitFor('maas/deepseek-v4.1-flash')]));
  const L2 = m.parseLimits('maas/glm-5.3=1,default=2');
  check('parseLimits env override: per model and default', L2.limitFor('maas/glm-5.3') === 1 && L2.limitFor('maas/deepseek-v4.1-flash') === 2);
  check('parseLimits: 0 or "off" disables the cap', m.parseLimits('default=0').limitFor('x/y') === Infinity && m.parseLimits('off').limitFor('maas/glm-5.3') === Infinity);
  let s = m.laneSlots({ model: 'maas/glm-5.3', running: ['maas/glm-5.3', 'maas/glm-5.3', 'maas/deepseek-v4.1-flash'], limits: L });
  check('laneSlots: 2 glm lanes running, limit 3: a slot is free', s.ok === true, JSON.stringify(s));
  s = m.laneSlots({ model: 'maas/glm-5.3', running: ['maas/glm-5.3', 'maas/glm-5.3', 'maas/glm-5.3'], limits: L });
  check('laneSlots: 3 glm lanes running: wait, with a readable reason', s.ok === false && /3/.test(s.reason) && /glm-5\.3/.test(s.reason), JSON.stringify(s));
}

// wiring in the runner
const src = runnerSource();
check('ca.mjs imports netwait.mjs', /from '\.\/netwait\.mjs'/.test(src));
check('network errors wait for the network instead of using up retries (waitOnline in the interruption path)', /isNetworkError\(/.test(src) && /waitOnline\(/.test(src));
check('the watchdog tick calls detectSleep and resets stall timers after a sleep', /detectSleep\(/.test(src));
check('a lane waits for a model slot before its build session starts (laneSlots, CA_MAX_LANES_PER_MODEL)', /laneSlots\(/.test(src) && /CA_MAX_LANES_PER_MODEL/.test(src));
check('waiting shows in the lane activity (offline / queued)', /activity[^\n]{0,80}(offline|waiting for the network)/i.test(src) && /activity[^\n]{0,80}queued/i.test(src));
check('NET_WAIT_S knob documented in help', /NET_WAIT_S/.test(src));

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
