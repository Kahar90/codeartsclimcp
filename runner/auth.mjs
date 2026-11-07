#!/usr/bin/env node
// runner/auth.mjs: get the Huawei Cloud keys from the human without them ever passing
// through the agent's chat. Called by `ca auth ...`.
//
//   ca auth [--no-open] [--json]   start a one-shot local form (127.0.0.1, random port, random
//                                  token in the URL), open it in the browser, print the URL, return
//   ca auth --wait [--timeout S]   block until the required keys are saved (exit 0) or the
//                                  timeout passes (exit 124; run `ca auth` again)
//   ca auth --status [--json]      which keys are set (never their values)
//   ca auth --stdin                read KEY=VALUE lines (or a JSON object) from stdin and save them
//
// Keys are stored in a user-only file (CA_CREDENTIALS, default
// ~/.config/codearts-lanes/credentials.json, mode 0600) that the runner reads after the process
// environment, so a new terminal is never needed. Values are never printed or logged.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CRED_FILE = process.env.CA_CREDENTIALS || path.join(os.homedir(), '.config', 'codearts-lanes', 'credentials.json');
export const KEYS = ['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK', 'MAAS_API_KEY'];
const REQUIRED = ['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK'];
const PORTAL = 'https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth';

// ---- keys at rest ----------------------------------------------------------
// On Windows the credentials file holds DPAPI-encrypted values (CurrentUser scope, through
// PowerShell), so the plain keys never sit on disk. Values travel through the environment, never
// the command line. On other platforms the file stays plain JSON with mode 0600.
const PROTECT_PS = [
  "$ErrorActionPreference = 'Stop'",
  '$names = ConvertFrom-Json $env:CA_VAULT_NAMES',
  '$n = @($names).Count',
  '$o = [ordered]@{}',
  'for ($i = 0; $i -lt $n; $i++) {',
  '  $val = [Environment]::GetEnvironmentVariable("CA_VAULT_$i")',
  '  $sec = ConvertTo-SecureString $val -AsPlainText -Force',
  '  $o[[string]$i] = ConvertFrom-SecureString $sec',
  '}',
  'ConvertTo-Json $o -Compress',
].join('\n');
const UNPROTECT_PS = [
  "$ErrorActionPreference = 'Stop'",
  '$names = ConvertFrom-Json $env:CA_VAULT_NAMES',
  '$n = @($names).Count',
  '$o = [ordered]@{}',
  'for ($i = 0; $i -lt $n; $i++) {',
  '  $blob = [Environment]::GetEnvironmentVariable("CA_VAULT_$i")',
  '  $sec = ConvertTo-SecureString $blob',
  '  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
  '  $o[[string]$i] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)',
  '  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)',
  '}',
  'ConvertTo-Json $o -Compress',
].join('\n');

function psResult(names, r) {
  if (!r || r.status !== 0) return null;
  let j; try { j = JSON.parse(r.stdout); } catch { return null; }
  const out = {};
  for (let i = 0; i < names.length; i++) {
    if (typeof j[String(i)] !== 'string') return null;
    out[names[i]] = j[String(i)];
  }
  return out;
}

// One PowerShell call for the whole map: values go in CA_VAULT_0, CA_VAULT_1, ... (never the
// command line), and the encrypted map comes back as JSON on stdout. null on any failure.
function protect(map) {
  const names = Object.keys(map);
  const env = { ...process.env, CA_VAULT_NAMES: JSON.stringify(names) };
  names.forEach((n, i) => { env[`CA_VAULT_${i}`] = map[n]; });
  const r = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PROTECT_PS], { encoding: 'utf8', windowsHide: true, env });
  return psResult(names, r);
}
function unprotect(map) {
  const names = Object.keys(map);
  const env = { ...process.env, CA_VAULT_NAMES: JSON.stringify(names) };
  names.forEach((n, i) => { env[`CA_VAULT_${i}`] = map[n]; });
  const r = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT_PS], { encoding: 'utf8', windowsHide: true, env });
  return psResult(names, r);
}

let cacheKey = '';
let cacheCreds = {};
let problem = '';

export function credsProblem() { return problem; }
function cacheStore(key, creds, why) { cacheKey = key; cacheCreds = creds; problem = why; return creds; }

// Rewrite a plain v1 file as the encrypted v2 form, once, on Windows.
function migrate(plain) {
  try {
    const enc = protect(plain);
    if (!enc) return;
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    fs.writeFileSync(CRED_FILE, JSON.stringify({ v: 2, protection: 'dpapi', keys: enc }, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(CRED_FILE, 0o600); } catch {}
    try { const st = fs.statSync(CRED_FILE); cacheKey = `${st.mtimeMs}:${st.size}`; cacheCreds = plain; } catch {}
  } catch {}
}

export function readCreds() {
  let st;
  try { st = fs.statSync(CRED_FILE); } catch { return cacheStore('', {}, ''); }
  const key = `${st.mtimeMs}:${st.size}`;
  if (key === cacheKey) return cacheCreds;
  let v;
  try {
    v = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^﻿/, ''));
  } catch { return cacheStore(key, {}, 'the file is not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return cacheStore(key, {}, 'the file is not a key file');
  if (v.v === 2 && v.protection === 'dpapi' && v.keys && typeof v.keys === 'object') {
    const dec = unprotect(v.keys);
    if (!dec) return cacheStore(key, {}, 'the file could not be decrypted (another user or machine, or a damaged blob)');
    return cacheStore(key, dec, '');
  }
  cacheStore(key, v, '');
  if (process.platform === 'win32') migrate(v);
  return v;
}

// Read the keys from one file, with no cache and no migration, for checks and tools that hold an
// explicit path. v2 (dpapi) is decrypted, anything else is returned as is, unreadable gives {}.
export function readCredsAt(file) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  if (v.v === 2 && v.protection === 'dpapi' && v.keys && typeof v.keys === 'object') return unprotect(v.keys) || {};
  return v;
}

function saveCreds(values) {
  const cur = readCreds();
  const saved = [];
  for (const k of KEYS) {
    const v = typeof values[k] === 'string' ? values[k].trim() : '';
    if (v) { cur[k] = v; saved.push(k); }
  }
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  const body = process.platform === 'win32'
    ? JSON.stringify({ v: 2, protection: 'dpapi', keys: protect(cur) || {} }, null, 2)
    : JSON.stringify(cur, null, 2);
  fs.writeFileSync(CRED_FILE, body + '\n', { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch {}
  try { const st = fs.statSync(CRED_FILE); cacheStore(`${st.mtimeMs}:${st.size}`, cur, ''); } catch { cacheStore('', {}, ''); }
  return saved;
}

const MAAS_BASE = () => (process.env.MAAS_BASE_URL || 'https://api-ap-southeast-1.modelarts-maas.com/openai/v1').replace(/\/+$/, '');

// Verify a MaaS key against ModelArts MaaS before saving it. Never logs the key.
//   { ok: true }               accepted (HTTP 200)
//   { ok: false, status }      rejected (HTTP 401/403): do not save this key
//   { ok: true, warn }         could not verify (network error or other status): save anyway
async function verifyMaas(key) {
  try {
    const r = await fetch(`${MAAS_BASE()}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (r.status === 200) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status };
    return { ok: true, warn: `HTTP ${r.status}` };
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? 'timed out' : (e && (e.code || e.message)) || 'network error';
    return { ok: true, warn: String(reason) };
  }
}

// Set = in the process env, the credentials file, or (Windows) the user environment.
// CA_CREDENTIALS_ONLY=1 looks at the credentials file alone (checks, screenshots).
function isSet(k) {
  if (process.env.CA_CREDENTIALS_ONLY === '1') return !!readCreds()[k];
  if (process.env[k] || readCreds()[k]) return true;
  if (process.platform !== 'win32') return false;
  const r = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-Command', `[bool][Environment]::GetEnvironmentVariable('${k}','User')`], { encoding: 'utf8', windowsHide: true });
  return /true/i.test(r.stdout || '');
}
const status = () => Object.fromEntries(KEYS.map((k) => [k, isSet(k)]));
const ready = (s) => REQUIRED.every((k) => s[k]);

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

const PAGE = (have) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeArts lanes keys</title><style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5d6678;--line:#dfe3ea;--accent:#c7000b;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e8ebf0;--muted:#9aa3b2;--line:#2e3440;--accent:#ff4d57;--ok:#4ac26b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:460px;width:100%}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px}label{display:block;font-weight:600;margin:14px 0 6px}
small{color:var(--muted);font-weight:400}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--accent);border-color:transparent}a{color:var(--accent)}
button{margin-top:22px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 15px system-ui;cursor:pointer}
.done{color:var(--ok);font-weight:600}.err{color:var(--accent)}
</style></head><body><main class="card" id="c">
<h1>Connect CodeArts lanes</h1>
<p>Your coding agent is setting up CodeArts lanes and needs your Huawei Cloud keys. They are saved on this computer only and never shown to the agent.</p>
<form id="f">
<label>Access key (AK) ${have.CODEARTS_CLI_AK ? '<small>already set, leave blank to keep</small>' : ''}</label><input name="CODEARTS_CLI_AK" type="password" autocomplete="off" ${have.CODEARTS_CLI_AK ? '' : 'required'}>
<label>Secret key (SK) ${have.CODEARTS_CLI_SK ? '<small>already set, leave blank to keep</small>' : ''}</label><input name="CODEARTS_CLI_SK" type="password" autocomplete="off" ${have.CODEARTS_CLI_SK ? '' : 'required'}>
<p style="margin:8px 0 0"><small>Create them at <a href="${PORTAL}" target="_blank" rel="noopener">CodeArts CLI auth settings</a>.</small></p>
<label>MaaS API key <small>optional, enables the faster builder models${have.MAAS_API_KEY ? '; already set' : ''}</small></label><input name="MAAS_API_KEY" type="password" autocomplete="off">
<p style="margin:8px 0 0"><small>Create one in the ModelArts Studio (MaaS) console under API Key Management (Singapore region). <a href="https://support.huaweicloud.com/intl/en-us/usermanual-maas-modelarts/maas-modelarts-0073.html" target="_blank" rel="noopener">Open the guide</a>.</small></p>
<button>Save keys</button><p id="m" style="margin:12px 0 0"></p></form></main>
<script>
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const m=document.getElementById('m');m.className='';m.textContent='';
const body=Object.fromEntries(new FormData(e.target));
try{const r=await fetch(location.pathname+'/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const j=await r.json().catch(()=>({}));
if(!r.ok||j.ok===false)throw new Error(j.error||'save failed');
if(j.warning){m.textContent=j.warning;return;}
document.getElementById('c').innerHTML='<h1 class="done">Keys saved</h1><p>You can close this tab and go back to your coding agent. It continues on its own.</p>';}
catch(err){m.className='err';m.textContent='Could not save: '+err.message;}};
</script></body></html>`;

// The detached one-shot server. Token from the env (not argv); exits after a successful save
// or after 15 minutes.
function serve(portFile) {
  const token = process.env.CA_AUTH_TOKEN;
  if (!token) process.exit(2);
  const base = `/t/${token}`;
  const srv = http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(body); };
    if (req.method === 'GET' && req.url === base) return send(200, PAGE(status()), 'text/html');
    if (req.method === 'POST' && req.url === `${base}/save`) {
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
      req.on('end', async () => {
        const j = (code, obj) => send(code, JSON.stringify(obj), 'application/json');
        let v; try { v = JSON.parse(raw); } catch { return j(400, { ok: false, error: 'bad request' }); }
        const merged = { ...status() };
        for (const k of REQUIRED) if (typeof v[k] === 'string' && v[k].trim()) merged[k] = true;
        if (!ready(merged)) return j(400, { ok: false, error: 'AK and SK are both required' });
        let warning = '';
        let rejected = '';
        if (typeof v.MAAS_API_KEY === 'string' && v.MAAS_API_KEY.trim()) {
          const vr = await verifyMaas(v.MAAS_API_KEY.trim());
          if (!vr.ok) { delete v.MAAS_API_KEY; rejected = `MaaS API key rejected by ModelArts MaaS (HTTP ${vr.status})`; }
          else if (vr.warn) warning = `could not verify the MaaS API key (${vr.warn}); saved anyway`;
        }
        saveCreds(v); // AK/SK (and a MaaS key that was not rejected) are saved; the form stays on a rejection
        if (rejected) return j(200, { ok: false, error: rejected });
        j(200, { ok: true, warning });
        setTimeout(() => process.exit(0), 300);
      });
      return;
    }
    send(404, 'not found');
  });
  srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
  setTimeout(() => process.exit(0), 15 * 60e3).unref();
}

export default async function auth(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const asJson = flags.has('--json');
  const out = (obj, line) => console.log(asJson ? JSON.stringify(obj) : line);

  if (flags.has('--serve')) return serve(args[args.indexOf('--serve') + 1]);

  if (flags.has('--status')) {
    const s = status();
    const p = credsProblem();
    const note = p ? `the keys file could not be read (${p}); run ca auth --force to enter the keys again` : '';
    const lines = KEYS.map((k) => `${k}: ${s[k] ? 'set' : 'not set'}`);
    if (note) lines.push(note);
    lines.push(ready(s) ? 'auth: ready' : 'auth: missing keys, run: ca auth');
    return out({ ready: ready(s), keys: s, file: CRED_FILE, problem: note || undefined }, lines.join('\n'));
  }

  if (flags.has('--stdin')) {
    const text = fs.readFileSync(0, 'utf8');
    let v = {};
    try { v = JSON.parse(text); } catch {
      for (const ln of text.split(/\r?\n/)) { const m = ln.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/); if (m) v[m[1]] = m[2]; }
    }
    const msgs = [];
    let maasRejected = false;
    if (typeof v.MAAS_API_KEY === 'string' && v.MAAS_API_KEY.trim()) {
      const vr = await verifyMaas(v.MAAS_API_KEY.trim());
      if (!vr.ok) { delete v.MAAS_API_KEY; maasRejected = true; msgs.push(`MaaS API key rejected by ModelArts MaaS (HTTP ${vr.status}); not saved`); }
      else if (vr.warn) msgs.push(`could not verify the MaaS API key (${vr.warn}); saved anyway`);
      else msgs.push('MAAS_API_KEY verified');
    }
    const saved = saveCreds(v);
    const s = status();
    out({ saved, ready: ready(s), maasRejected }, [`saved: ${saved.join(', ') || 'nothing'}`, ...msgs, ready(s) ? 'auth: ready' : 'auth: AK and SK still missing'].join('\n'));
    process.exitCode = maasRejected ? 1 : (ready(s) ? 0 : 3);
    return;
  }

  if (flags.has('--wait')) {
    const ti = args.indexOf('--timeout');
    const timeout = Number(ti >= 0 ? args[ti + 1] : 540) || 540;
    const t0 = Date.now();
    while (!ready(status())) {
      if (Date.now() - t0 > timeout * 1000) {
        out({ ready: false, timeout: true }, 'auth: still waiting for the keys (timeout). Run `ca auth --wait` again, or `ca auth` for a new form link.');
        process.exitCode = 124;
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    out({ ready: true }, 'auth: ready (keys saved)');
    return;
  }

  // Default: start the form unless the keys are already there.
  const s = status();
  if (ready(s) && !flags.has('--force')) {
    out({ ready: true, keys: s }, 'auth: ready (keys already set; --force opens the form anyway)');
    return;
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const portFile = path.join(os.tmpdir(), `ca-auth-${process.pid}-${Date.now()}.port`);
  const child = spawn(process.execPath, [path.join(HERE, 'ca.mjs'), 'auth', '--serve', portFile],
    { env: { ...process.env, CA_AUTH_TOKEN: token }, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let port = '';
  for (let i = 0; i < 50 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch {} }
  try { fs.rmSync(portFile, { force: true }); } catch {}
  if (!port) { out({ ready: false, error: 'could not start the local form' }, 'auth: could not start the local form; use `ca auth --stdin` instead'); process.exitCode = 1; return; }
  const url = `http://127.0.0.1:${port}/t/${token}`;
  const opened = !flags.has('--no-open') && openBrowser(url);
  out({ ready: false, url, opened, next: 'ca auth --wait' },
    `auth form: ${url}\n${opened ? 'opened in the browser. ' : ''}Ask the human to paste their keys there, then run: ca auth --wait`);
}
