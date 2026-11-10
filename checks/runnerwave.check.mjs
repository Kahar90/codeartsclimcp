// Contract check for runner hardening: CA_DUMP_ENV never writes a secret, `ca lane` refuses template
// placeholder CHECK lines, the dashboard rejects foreign Host headers (DNS rebinding) and bad JSON bodies,
// and lane / plan lookups refuse ambiguous partial names. Private registry and settings; CODEARTS_EXE is node
// itself, so no CodeArts server or model is ever started.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-runnerwave-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const SECRETS = { CODEARTS_CLI_AK: 'AKSECRET1111', CODEARTS_CLI_SK: 'SKSECRET2222', MAAS_API_KEY: 'MAASSECRET3333', DEEPSEEK_API_KEY: 'DSSECRET4444', SLACK_BOT_TOKEN: 'TOKSECRET5555', MY_PASSWORD: 'PWSECRET6666' };
const env = { ...process.env, ...SECRETS, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, NO_REVIEW: '1', CA_CREDENTIALS: path.join(tmp, 'creds.json') };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const ca = (args, extra = {}, ms = 90000) => { const r = spawnSync(process.execPath, [CA, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: ms, input: '' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const mkrepo = (name) => { const d = path.join(tmp, name); fs.mkdirSync(path.join(d, 'tasks'), { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: d }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d }); return d; };

// ---- 1. CA_DUMP_ENV redacts every secret, by name and by value ----
const repo = mkrepo('dump-repo');
fs.writeFileSync(path.join(repo, 'tasks', 'probe.md'), 'Reply ok.\nCHECK: node --version\n');
const dump = path.join(tmp, 'env-dump.json');
ca(['lane', repo, 'probe'], { CA_DUMP_ENV: dump, STALL_S: '5', MAX_RETRIES: '0' }, 120000);
const dumpText = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
check('CA_DUMP_ENV still writes the dump', dumpText.length > 100, `size ${dumpText.length}`);
const leaked = Object.entries(SECRETS).filter(([, v]) => dumpText.includes(v)).map(([k]) => k);
check('dump contains no secret value anywhere (also not inside OPENCODE_CONFIG_CONTENT)', dumpText && leaked.length === 0, leaked.join(','));
let dj = null; try { dj = JSON.parse(dumpText); } catch {}
check('dump keeps non-secret settings and lists secret names', dj && dj.env && dj.env.SCENARIO === 'codeartsdoer' && 'CODEARTS_CLI_AK' in dj.env && 'SLACK_BOT_TOKEN' in dj.env, dj && Object.keys(dj.env || {}).length);
check('dump has no server password', dj && !/[0-9a-f]{32}/.test(String(dj.env?.CODEARTS_SERVER_PASSWORD || '')) && String(dj.env?.CODEARTS_SERVER_PASSWORD || '') !== 'pw');

// ---- 2. placeholder CHECK lines are refused before anything starts ----
const repo2 = mkrepo('tpl-repo');
fs.writeFileSync(path.join(repo2, 'tasks', 'raw.md'), '1. Do it. Commit.\nCHECK: <exact command, e.g. npm run typecheck>\nCHECK: npm test\n');
let r = ca(['lane', repo2, 'raw']);
check('ca lane refuses a brief with a <...> placeholder CHECK line (exit 2)', r.code === 2 && /placeholder/i.test(r.out) && /CHECK/.test(r.out), `${r.code} ${r.out.slice(0, 200)}`);
check('refused lane did not register or create a lane folder', !fs.existsSync(path.join(reg, 'tpl-repo--raw.json')) && !fs.existsSync(path.join(repo2, 'tasks', 'raw.lane')));

// ---- fake lanes for lookup and dashboard tests ----
const repo3 = mkrepo('look-repo'); const t = Date.now();
const lane = (task) => { const dir = path.join(repo3, 'tasks', `${task}.lane`); fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pid: process.pid, startedAt: t, lastEventAt: t, phase: 'build', busy: true, activity: 'thinking', steps: 1, commits: 0, stepList: [], commitLog: [], tokens: {}, steers: [], interruptions: [], gates: [], permissions: [], outside: [], errors: [], models: {} }));
  fs.writeFileSync(path.join(dir, 'live.log'), 'x\n');
  fs.writeFileSync(path.join(reg, `look-repo--${task}.json`), JSON.stringify({ id: `look-repo--${task}`, dir, repo: repo3, task })); };
lane('api'); lane('api-tests'); lane('ui');
const inbox = (task) => { try { return fs.readdirSync(path.join(repo3, 'tasks', `${task}.lane`, 'inbox')).length; } catch { return 0; } };

// ---- 3. CLI lookups: exact first, ambiguous refused ----
r = ca(['steer', 'api', 'exact one']);
check('exact task name wins over a longer match', r.code === 0 && inbox('api') === 1 && inbox('api-tests') === 0, `${r.code} ${r.out.slice(0, 160)} api=${inbox('api')} tests=${inbox('api-tests')}`);
r = ca(['steer', 'look-repo--a', 'ambiguous']);
check('ambiguous partial name is refused with exit 2 and the candidates', r.code === 2 && /ambiguous|more than one/i.test(r.out) && /api-tests/.test(r.out), `${r.code} ${r.out.slice(0, 200)}`);
r = ca(['steer', 'ui', 'unique']);
check('unique name still works', r.code === 0 && inbox('ui') === 1, `${r.code} ${r.out.slice(0, 120)}`);
// plans: two registered plans whose ids share a prefix
for (const name of ['shop', 'shop-admin']) { const d = mkrepo(name); fs.writeFileSync(path.join(d, 'tasks', 'plan.json'), JSON.stringify({ title: `Plan ${name}`, status: 'running', waves: [], lanes: [] })); ca(['plan', path.join(d, 'tasks', 'plan.json')]); }
r = ca(['plan', 'close', 'sho', '--reason', 'x']);
check('ambiguous plan id is refused', r.code === 2 && /ambiguous|more than one/i.test(r.out), `${r.code} ${r.out.slice(0, 200)}`);
r = ca(['plan', 'close', 'shop', '--reason', 'exact']);
const shopPlan = JSON.parse(fs.readFileSync(path.join(tmp, 'shop', 'tasks', 'plan.json'), 'utf8'));
const adminPlan = JSON.parse(fs.readFileSync(path.join(tmp, 'shop-admin', 'tasks', 'plan.json'), 'utf8'));
check('exact plan id closes only that plan', r.code === 0 && shopPlan.status === 'done' && adminPlan.status === 'running', `${r.code} ${r.out.slice(0, 120)}`);

// ---- 4. dashboard: Host header, bad JSON, ambiguous lane ----
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { env, stdio: 'ignore' });
guard({ children: [dash] });
const req = (method, p, { host, body, type = 'application/json' } = {}) => new Promise((res) => {
  const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: host || `127.0.0.1:${port}`, ...(body !== undefined ? { 'content-type': type } : {}) } }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => res({ code: rs.statusCode, body: d })); });
  rq.on('error', (e) => res({ code: 0, body: String(e) })); if (body !== undefined) rq.write(body); rq.end(); });
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await new Promise((x) => setTimeout(x, 250)); up = (await req('GET', '/api/lanes')).code === 200; }
  check('dashboard up with Host 127.0.0.1:<port>', up);
  check('Host localhost:<port> is accepted', (await req('GET', '/api/lanes', { host: `localhost:${port}` })).code === 200);
  let x = await req('GET', '/api/lanes', { host: `evil.example:${port}` });
  check('foreign Host on GET /api/lanes is rejected (403)', x.code === 403, `${x.code} ${x.body.slice(0, 80)}`);
  x = await req('GET', '/', { host: 'evil.example' });
  check('foreign Host on the page is rejected too', x.code === 403, `${x.code}`);
  x = await req('POST', '/api/lane/look-repo--ui/stop', { host: `rebind.attacker.test:${port}`, body: '{}' });
  check('foreign Host cannot stop a lane', x.code === 403 && !fs.existsSync(path.join(repo3, 'tasks', 'ui.lane', 'STOP')), `${x.code}`);
  x = await req('GET', '/api/lanes', { host: `127.0.0.1:${port + 1}` });
  check('right host, wrong port is rejected', x.code === 403, `${x.code}`);
  x = await req('POST', '/api/lane/look-repo--ui/steer', { body: '{not json' });
  check('bad JSON body gives 400, not 500', x.code === 400, `${x.code} ${x.body.slice(0, 80)}`);
  x = await req('POST', '/api/lane/look-repo--ui/kick', { body: '[' });
  check('bad JSON on kick gives 400', x.code === 400, `${x.code}`);
  x = await req('POST', '/api/lane/look-repo--ui/steer', { body: 'null' });
  check('a JSON null body gives 400, not 500', x.code === 400, `${x.code}`);
  // a multibyte character split across two TCP writes must survive
  const before = inbox('ui');
  const raw = Buffer.from(JSON.stringify({ text: 'café 日本' }), 'utf8'); const cut = raw.indexOf(0xc3) + 1;
  x = await new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/lane/look-repo--ui/steer', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': raw.length } }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => res({ code: rs.statusCode, body: d })); });
    rq.on('error', (e) => res({ code: 0, body: String(e) })); rq.write(raw.subarray(0, cut)); setTimeout(() => { rq.write(raw.subarray(cut)); rq.end(); }, 150); });
  const steered = (() => { try { const d = path.join(repo3, 'tasks', 'ui.lane', 'inbox'); return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch { return ''; } })();
  check('a multibyte steer split across TCP chunks arrives intact', x.code === 200 && inbox('ui') === before + 1 && steered.includes('café 日本'), `${x.code} ${x.body.slice(0, 80)}`);
  x = await req('POST', '/api/lane/look-repo--a/steer', { body: JSON.stringify({ text: 'hi' }) });
  check('ambiguous lane in the dashboard is refused (409), nothing steered', x.code === 409 && inbox('api') === 1 && inbox('api-tests') === 0, `${x.code} ${x.body.slice(0, 120)}`);
  x = await req('GET', '/api/lane/api/detail');
  check('exact task name works in the dashboard', x.code === 200, `${x.code}`);
} finally { await settle({ children: [dash], code: 0 }); }

// ---- 5. Open TUI: the attach spawn survives an exe path with spaces (static) ----
const src = runnerSource();
const att = src.slice(src.indexOf("m[2] === 'attach'"), src.indexOf("m[2] === 'attach'") + 900);
check('attach spawn quotes the exe path or drops windowsVerbatimArguments', !/windowsVerbatimArguments:\s*true/.test(att) || /`"\$\{EXE\}"`|'"' \+ EXE \+ '"'|quote\(EXE\)/.test(att), att.slice(0, 200));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exitCode = fails ? 1 : 0;
