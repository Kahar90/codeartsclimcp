// Contract check for `ca auth`: stdin save, the one-shot local form (token, save, exit), --wait,
// --status never printing values. Uses a temp CA_CREDENTIALS file; never touches real keys.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-auth-'));
const cred = path.join(tmp, 'sub', 'credentials.json');
// A fake ModelArts MaaS endpoint so the MaaS key in this check verifies locally (never a real key).
const fakeMaas = http.createServer((req, res) => {
  const ok = req.url.endsWith('/models') && req.headers.authorization === 'Bearer mk-333';
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(ok ? '{"data":[{"id":"glm-5.3"}]}' : '{"error":"unauthorized"}');
});
await new Promise((r) => fakeMaas.listen(0, '127.0.0.1', r));
const env = { ...process.env, CA_CREDENTIALS: cred, CA_DASH: '0', MAAS_BASE_URL: `http://127.0.0.1:${fakeMaas.address().port}/openai/v1` };
const ca = (args, input = '') => { const r = spawnSync(process.execPath, [CA, 'auth', ...args], { env, encoding: 'utf8', input, timeout: 30000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);
const rd = () => { try { return JSON.parse(fs.readFileSync(cred, 'utf8')); } catch { return null; } };

let r = ca(['--stdin'], 'export CODEARTS_CLI_AK=ak-111\nCODEARTS_CLI_SK="sk-222"\nOTHER=x\n');
check('--stdin saves KEY=VALUE lines, ignores unknown keys', r.code === 0 && rd()?.CODEARTS_CLI_AK === 'ak-111' && rd()?.CODEARTS_CLI_SK === 'sk-222' && !('OTHER' in rd()), r.out);
check('--stdin never echoes values', !/ak-111|sk-222/.test(r.out));
if (process.platform !== 'win32') check('credentials file is user-only (0600)', (fs.statSync(cred).mode & 0o077) === 0);
r = ca(['--stdin'], JSON.stringify({ MAAS_API_KEY: 'mk-333' }));
check('--stdin JSON merges, keeps earlier keys', rd()?.MAAS_API_KEY === 'mk-333' && rd()?.CODEARTS_CLI_AK === 'ak-111');
r = ca(['--status', '--json']); const st = JSON.parse(r.out);
check('--status reports set keys without values', st.ready === true && st.keys.CODEARTS_CLI_AK === true && !/ak-111|sk-222|mk-333/.test(r.out), r.out);
r = ca([]);
check('ca auth with keys present does not open a form', r.code === 0 && /ready/.test(r.out), r.out);

// one-shot form
r = ca(['--force', '--no-open', '--json']); const f = JSON.parse(r.out);
check('form starts on 127.0.0.1 with a long token and returns at once', /^http:\/\/127\.0\.0\.1:\d+\/t\/[\w-]{20,}$/.test(f.url) && f.opened === false, r.out);
const page = await (await fetch(f.url)).text();
check('form page asks for AK, SK and optional MaaS key, never shows values', /name="CODEARTS_CLI_AK"/.test(page) && /name="CODEARTS_CLI_SK"/.test(page) && /name="MAAS_API_KEY"/.test(page) && !/ak-111|sk-222|mk-333/.test(page));
check('wrong token is 404', (await fetch(f.url.replace(/\/t\/.*/, '/t/wrong'))).status === 404);
const bad = await fetch(f.url + '/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
check('bad body is rejected', bad.status === 400);
const ok = await fetch(f.url + '/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ CODEARTS_CLI_AK: 'ak-new', CODEARTS_CLI_SK: '', MAAS_API_KEY: '' }) });
check('save with a blank field keeps the stored value', ok.status === 200 && rd()?.CODEARTS_CLI_AK === 'ak-new' && rd()?.CODEARTS_CLI_SK === 'sk-222' && rd()?.MAAS_API_KEY === 'mk-333', JSON.stringify(Object.keys(rd() || {})));
r = ca(['--wait', '--timeout', '5']);
check('--wait returns 0 once the keys are saved', r.code === 0 && /ready/.test(r.out), r.out);
await new Promise((x) => setTimeout(x, 800));
let gone = false; try { await fetch(f.url, { signal: AbortSignal.timeout(1500) }); } catch { gone = true; }
check('form server exits after a successful save', gone);

fakeMaas.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
