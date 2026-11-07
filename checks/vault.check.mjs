// Contract check for keys at rest: on Windows the credentials file holds DPAPI-encrypted values
// (CurrentUser scope, through PowerShell, values passed in the env, never argv), never the plain keys;
// old plaintext files are migrated on first read; an unreadable file is reported, never a crash.
// On other platforms the file stays plain JSON with mode 0600. Temp CA_CREDENTIALS only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-vault-'));
const cred = path.join(tmp, 'credentials.json');
const env = { ...process.env, CA_CREDENTIALS: cred, CA_CREDENTIALS_ONLY: '1', CA_DASH: '0', MAAS_BASE_URL: 'http://127.0.0.1:9/openai/v1' };
delete env.CODEARTS_CLI_AK; delete env.CODEARTS_CLI_SK; delete env.MAAS_API_KEY;
const ca = (args, input = '') => { const t0 = Date.now(); const r = spawnSync(process.execPath, [CA, ...args], { cwd: tmp, env, encoding: 'utf8', input, timeout: 60000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t0 }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const raw = () => { try { return fs.readFileSync(cred, 'utf8'); } catch { return ''; } };
const AK = 'AKVAULT12345678', SK = 'SKVAULT87654321';
const win = process.platform === 'win32';

let r = ca(['auth', '--stdin'], `CODEARTS_CLI_AK=${AK}\nCODEARTS_CLI_SK=${SK}\n`);
check('ca auth --stdin saves the keys', r.code === 0, r.out.slice(0, 160));
// Where DPAPI itself is unavailable (some CI runners, locked-down machines) the keys must still be
// saved, user-only, with a warning that says why: check that instead of the encrypted format.
const noDpapi = win && /DPAPI is not available here \(([^)]*)\)/.exec(r.out);
if (noDpapi) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=vault.check.mjs::DPAPI unavailable on this machine: ${noDpapi[1]}`);
  check(`DPAPI unavailable (${noDpapi[1]}): keys saved anyway with a warning, readable, nothing lost`, /saved: CODEARTS_CLI_AK, CODEARTS_CLI_SK/.test(r.out) && raw().includes(AK));
} else if (win) {
  check('Windows: the file never holds a plain key value', raw() && !raw().includes(AK) && !raw().includes(SK), raw().slice(0, 160));
  let j = null; try { j = JSON.parse(raw()); } catch {}
  check('Windows: file format is versioned and marked dpapi', j && j.v === 2 && j.protection === 'dpapi' && typeof j.keys === 'object', raw().slice(0, 160));
} else {
  check('non-Windows: file is mode 0600', (fs.statSync(cred).mode & 0o077) === 0);
}
r = ca(['auth', '--status', '--json']); let st = null; try { st = JSON.parse(r.out); } catch {}
check('ca auth --status reads them back as set', st && st.keys?.CODEARTS_CLI_AK === true && st.keys?.CODEARTS_CLI_SK === true && st.ready === true, r.out.slice(0, 160));
check('ca auth --status stays fast (under 5 s)', r.ms < 5000, `${r.ms} ms`);
// the runner gets the real values back (module import, same env)
r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readCreds } from ${JSON.stringify('file:///' + path.join(ROOT, 'runner', 'auth.mjs').replace(/\\/g, '/'))}; const c = readCreds(); console.log(c.CODEARTS_CLI_AK === ${JSON.stringify(AK)} && c.CODEARTS_CLI_SK === ${JSON.stringify(SK)} ? 'MATCH' : 'NOMATCH')`], { cwd: tmp, env, encoding: 'utf8', timeout: 60000 });
check('readCreds() returns the decrypted values to the runner', /MATCH/.test(r.stdout) && !/NOMATCH/.test(r.stdout), (r.stdout + r.stderr).slice(0, 200));
check('no key value is ever printed', ![AK, SK].some((v) => (r.stdout + r.stderr).includes(v)));
// migration of an old plaintext file
fs.writeFileSync(cred, JSON.stringify({ CODEARTS_CLI_AK: AK, CODEARTS_CLI_SK: SK }));
r = ca(['auth', '--status', '--json']); try { st = JSON.parse(r.out); } catch { st = null; }
check('an old plaintext file still reads as set', st && st.ready === true, r.out.slice(0, 160));
if (win && !noDpapi) check('Windows: an old plaintext file is migrated to the encrypted format on first read', !raw().includes(AK) && /dpapi/.test(raw()), raw().slice(0, 120));
// unreadable / corrupt file
fs.writeFileSync(cred, JSON.stringify({ v: 2, protection: 'dpapi', keys: { CODEARTS_CLI_AK: 'not-a-dpapi-blob', CODEARTS_CLI_SK: '00ff' } }));
r = ca(['auth', '--status', '--json']); try { st = JSON.parse(r.out); } catch { st = null; }
check('an undecryptable file reads as not set, no crash', st && st.ready === false && r.code !== null, r.out.slice(0, 200));
check('it says why and how to fix it (ca auth --force)', /could not (be )?(read|decrypt)|unreadable/i.test(r.out) && /ca auth --force/.test(r.out), r.out.slice(0, 200));
fs.writeFileSync(cred, '{not json');
r = ca(['auth', '--status', '--json']);
check('a broken JSON file does not crash ca auth --status', r.code !== null && !/SyntaxError|at JSON\.parse/.test(r.out), r.out.slice(0, 200));
// static: secrets go to PowerShell through the env, never argv
const src = fs.readFileSync(path.join(ROOT, 'runner', 'auth.mjs'), 'utf8');
check('auth.mjs uses DPAPI through ConvertTo-SecureString / ConvertFrom-SecureString', /ConvertFrom-SecureString/.test(src) && /ConvertTo-SecureString/.test(src));
check('auth.mjs passes values to PowerShell in the env, not in the command line', /\$env:CA_VAULT_/.test(src));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
