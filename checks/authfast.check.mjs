// Contract check for rejected keys: runner/authsignal.mjs classifies sign-in failures (AK/SK vs
// MaaS key) from a session error and the codearts server log; `ca auth` verifies a MaaS key against
// MAAS_BASE_URL/models before saving it; `ca doctor` prints readable rows. A fake local MaaS
// endpoint answers /models; real keys and real CodeArts are never used.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCredsAt } from '../runner/auth.mjs';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-authfast-'));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);

// ---- 1. classifier ----
let mod = null;
try { mod = await import(pathToFileURL(path.join(ROOT, 'runner', 'authsignal.mjs')).href); } catch (e) { check('runner/authsignal.mjs imports', false, e.message); }
const ap = mod?.authProblem;
check('authsignal exports authProblem()', typeof ap === 'function');
if (typeof ap === 'function') {
  const badSrv = 'INFO  ... service=server listening\nERROR  2026-11-07T19:53:08.839 +1340ms service=auth "调用错误：503{}"\nERROR  2026-11-07T19:53:08.840 +1ms service=auth "getUserInfo 返回空值，无法更新用户信息"\n';
  const okSrv = 'INFO  2026-11-07T19:53:08.839 service=server listening\nINFO service=session created\n';
  const a = ap({ model: 'huaweicloud-maas/GLM-5.2', error: 'Backend service unavailable (HTTP 503, url: snap-access.ap-southeast-1.myhuaweicloud.com). Please try again later.', serverLog: badSrv });
  check('AK/SK: sign-in error in the server log + 503 -> aksk', a && a.key === 'aksk', JSON.stringify(a));
  check('AK/SK message names the keys and ca auth --force', a && /AK\/SK/.test(a.message) && /ca auth --force/.test(a.message), a && a.message);
  const b = ap({ model: 'maas/deepseek-v4.1-flash', error: 'APIError: Invalid authorization header.', serverLog: okSrv });
  check('MaaS: invalid authorization header on a maas/ model -> maas', b && b.key === 'maas' && /MaaS API key/.test(b.message) && /ca auth --force/.test(b.message), JSON.stringify(b));
  const c = ap({ model: 'huaweicloud-maas/GLM-5.2', error: 'Backend service unavailable (HTTP 503)', serverLog: okSrv });
  check('plain 503 with a clean server log -> null (real outage, keep retrying)', c === null, JSON.stringify(c));
  const d = ap({ model: 'huaweicloud-maas/GLM-5.2', error: '', serverLog: badSrv });
  check('sign-in error in the server log alone (no session error yet) -> aksk', d && d.key === 'aksk', JSON.stringify(d));
  const e = ap({ model: 'maas/glm-5.3', error: 'Infer timeout: no data received over 600000ms', serverLog: okSrv });
  check('timeouts are not auth problems', e === null);
}

// ---- 2. runner wiring (static): the lane uses the classifier and ends with exit 3 at once ----
const src = runnerSource();
check('ca.mjs imports authsignal.mjs', /from '\.\/authsignal\.mjs'/.test(src));
check('ca.mjs reads the lane server log for the classifier', /authProblem\([^)]*server/i.test(src) || /serverLog/.test(src));

// ---- 3. ca auth verifies a MaaS key before saving ----
const fake = http.createServer((req, res) => {
  const ok = req.url.endsWith('/models') && req.headers.authorization === 'Bearer good-key';
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(ok ? '{"data":[{"id":"glm-5.3"}]}' : '{"error":"unauthorized"}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}/openai/v1`;
const cred = path.join(tmp, 'credentials.json');
const env = { ...process.env, CA_CREDENTIALS: cred, CA_CREDENTIALS_ONLY: '1', CA_DASH: '0', MAAS_BASE_URL: base };
delete env.MAAS_API_KEY; delete env.CODEARTS_CLI_AK; delete env.CODEARTS_CLI_SK;
const run = (args, input = '') => new Promise((res) => {
  const p = spawn(process.execPath, [CA, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => res({ code, out })); p.stdin.end(input);
  setTimeout(() => p.kill(), 30000);
});
fs.writeFileSync(cred, JSON.stringify({ CODEARTS_CLI_AK: 'seed-ak', CODEARTS_CLI_SK: 'seed-sk' }));
const rd = () => readCredsAt(cred);
let r = await run(['auth', '--stdin'], 'MAAS_API_KEY=bad-key\n');
check('--stdin with a rejected MaaS key: not saved, exit 1', r.code === 1 && !rd().MAAS_API_KEY, `${r.code} ${r.out}`);
check('rejected MaaS key: message says rejected, never prints the value', /rejected/i.test(r.out) && !/bad-key/.test(r.out), r.out);
r = await run(['auth', '--stdin'], 'MAAS_API_KEY=good-key\n');
check('--stdin with a valid MaaS key: saved, exit 0', r.code === 0 && rd().MAAS_API_KEY === 'good-key', `${r.code} ${r.out}`);
check('valid MaaS key: says verified', /verified/i.test(r.out), r.out);
// form path: start the form, post a bad key, expect ok:false with an error, nothing saved
fs.rmSync(cred, { force: true });
r = await run(['auth', '--force', '--no-open', '--json']);
let url = null; try { url = JSON.parse(r.out).url; } catch {}
if (url) {
  const resp = await fetch(url + '/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ CODEARTS_CLI_AK: 'ak1', CODEARTS_CLI_SK: 'sk1', MAAS_API_KEY: 'bad-key' }) });
  const body = await resp.text();
  check('form: bad MaaS key is refused with a readable error, AK/SK still saved', /rejected/i.test(body) && rd().CODEARTS_CLI_AK === 'ak1' && !rd().MAAS_API_KEY, body.slice(0, 200));
  const page = await (await fetch(url)).text();
  check('form: MaaS field explains where the key comes from', /ModelArts|MaaS console/i.test(page) && /href="[^"]*(modelarts|maas)/i.test(page));
} else check('form starts', false, r.out);
// network error while verifying: saved, with a "could not verify" warning
env.MAAS_BASE_URL = 'http://127.0.0.1:9/openai/v1';
r = await run(['auth', '--stdin'], 'MAAS_API_KEY=offline-key\n');
check('unreachable MaaS endpoint: key saved with a could-not-verify warning', r.code === 0 && rd().MAAS_API_KEY === 'offline-key' && /could not verify/i.test(r.out), `${r.code} ${r.out}`);
fake.close();

// ---- 4. ca doctor: readable rows, fix under the row ----
r = await run(['doctor', tmp]);
const lines = r.out.split(/\r?\n/);
check('doctor text: no padded table header', !/NAME\s+STATUS\s+DETAIL\s+FIX/.test(r.out), lines[0]);
check('doctor text: no line has long space padding', !lines.some((l) => / {12,}\S/.test(l.trim())), lines.find((l) => / {12,}\S/.test(l.trim())));
check('doctor text: a non-ok row has its fix on the next line', /trusted folder[^\n]*\n\s+(fix|→|->)[: ]/i.test(r.out), r.out.slice(0, 600));
check('doctor text: final ready/not ready line kept', /doctor: (ready|not ready)/.test(r.out));
r = await run(['doctor', '--json', tmp]);
let dj = null; try { dj = JSON.parse(r.out); } catch {}
check('doctor --json unchanged shape', dj && Array.isArray(dj.checks) && dj.checks.every((c) => 'name' in c && 'status' in c && 'detail' in c && 'fix' in c));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
