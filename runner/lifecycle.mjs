#!/usr/bin/env node
// runner/lifecycle.mjs: the install lifecycle for the CodeArts lanes CLI.
// `ca setup --user` records what it wrote in ~/.config/codearts-lanes/installed.json; `ca uninstall`
// removes exactly that (configs are edited, never deleted whole), `ca update` reinstalls the package
// and refreshes every recorded harness config, and `lifecycleRows()` feeds `ca doctor`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_START, stripBlock, stripCodexToml, SKILL_MARKER, userPaths } from './setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_MJS = path.resolve(HERE, 'ca.mjs').replace(/\\/g, '/');
const STATE_DIR = path.join(os.homedir(), '.config', 'codearts-lanes');
const MANIFEST = path.join(STATE_DIR, 'installed.json');
const SMOKE = path.join(STATE_DIR, 'smoke.json');
const EXE = process.env.CODEARTS_EXE || path.join(os.homedir(), '.codeartsdoer', 'installers', 'bin', process.platform === 'win32' ? 'codearts.exe' : 'codearts');

function readManifest() {
  let man = {};
  try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch {}
  if (!man || typeof man !== 'object' || Array.isArray(man)) man = {};
  if (!man.harnesses || typeof man.harnesses !== 'object' || Array.isArray(man.harnesses)) man.harnesses = {};
  return man;
}
function writeManifest(man) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2) + '\n');
}

// JSON config: drop only the codearts server key, keep every other key and server untouched.
function dropJsonKey(file, mapKey, serverKey, dry, changes) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  let obj; try { obj = JSON.parse(text); } catch { return; }
  if (!obj || typeof obj !== 'object' || !obj[mapKey] || typeof obj[mapKey] !== 'object' || !(serverKey in obj[mapKey])) return;
  delete obj[mapKey][serverKey];
  if (dry) { changes.push(`would remove ${mapKey}.${serverKey} from ${file}`); return; }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  changes.push(`removed ${mapKey}.${serverKey} from ${file}`);
}
// claude settings.json: drop only the mcp__codearts__* allow entries, keep every other rule.
function dropAllow(file, dry, changes) {
  let obj; try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const allow = obj && obj.permissions && obj.permissions.allow;
  if (!Array.isArray(allow)) return;
  const kept = allow.filter((a) => !String(a).startsWith('mcp__codearts__'));
  if (kept.length === allow.length) return;
  obj.permissions.allow = kept;
  if (dry) { changes.push(`would remove mcp__codearts__* entries from ${file}`); return; }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  changes.push(`removed mcp__codearts__* entries from ${file}`);
}
// Codex config.toml: drop every [mcp_servers.codearts] and sub-table, keep the rest byte for byte.
function dropCodex(file, dry, changes) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  if (!/mcp_servers\.codearts/.test(text)) return;
  const next = stripCodexToml(text);
  if (dry) { changes.push(`would remove the codearts tables from ${file}`); return; }
  fs.writeFileSync(file, next ? next + '\n' : '');
  changes.push(`removed the codearts tables from ${file}`);
}
// AGENTS.md-style file: drop only the codearts-lanes block, keep the user's own text; delete the
// file only when nothing else is left.
function dropBlock(file, dry, changes) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  if (!text.includes(BLOCK_START)) return;
  const next = stripBlock(text);
  if (dry) { changes.push(`would remove the codearts-lanes block from ${file}`); return; }
  if (next.trim()) fs.writeFileSync(file, next.replace(/\s+$/, '') + '\n');
  else fs.rmSync(file, { force: true });
  changes.push(`removed the codearts-lanes block from ${file}`);
}
// A file setup created whole (the Kiro steering file, the credentials file): delete it.
function dropFile(file, dry, changes) {
  if (!fs.existsSync(file)) return;
  if (dry) { changes.push(`would remove ${file}`); return; }
  fs.rmSync(file, { force: true });
  changes.push(`removed ${file}`);
}
// The generated claude skill: remove the dir only when its SKILL.md carries our marker, so a
// skill the user edited is never deleted.
function dropSkill(dir, dry, changes) {
  const sk = path.join(dir, 'SKILL.md');
  let text; try { text = fs.readFileSync(sk, 'utf8'); } catch { return; }
  if (!text.includes(SKILL_MARKER)) return;
  if (dry) { changes.push(`would remove ${dir}`); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  changes.push(`removed ${dir}`);
}

// `ca uninstall [--harness h] [--keys] [--dry-run]`: remove exactly what setup added, keep
// everything else, and never touch the keys file unless --keys is given.
export async function uninstall(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const hi = args.indexOf('--harness');
  const only = hi >= 0 ? args[hi + 1] : null;
  const dry = flags.has('--dry-run');
  const man = readManifest();
  const targets = only ? [only] : Object.keys(man.harnesses);
  const changes = [];

  for (const h of targets) {
    const d = userPaths(h);
    if (!d) { process.stdout.write(`unknown harness: ${h}\n`); continue; }
    // Claude: let the CLI drop its own registration first, then make sure the key is gone.
    if (h === 'claude' && !dry && process.env.CA_CLAUDE_CLI !== 'none') {
      try { spawnSync('claude', ['mcp', 'remove', '-s', 'user', 'codearts'], { shell: process.platform === 'win32', stdio: 'ignore', timeout: 30000, windowsHide: true }); } catch {}
    }
    for (const j of d.json || []) dropJsonKey(j.file, j.mapKey, j.serverKey, dry, changes);
    for (const f of d.allow || []) dropAllow(f, dry, changes);
    if (d.codexToml) dropCodex(d.codexToml, dry, changes);
    for (const b of d.blocks || []) dropBlock(b, dry, changes);
    for (const s of d.steering || []) dropFile(s, dry, changes);
    if (d.skillDir) dropSkill(d.skillDir, dry, changes);
  }

  if (!dry) {
    if (only) { if (man.harnesses[only]) { delete man.harnesses[only]; writeManifest(man); } }
    else if (targets.length) { for (const h of targets) delete man.harnesses[h]; writeManifest(man); }
  }

  if (flags.has('--keys')) dropFile(process.env.CA_CREDENTIALS || path.join(STATE_DIR, 'credentials.json'), dry, changes);

  if (!changes.length) process.stdout.write('nothing to remove\n');
  else for (const c of changes) process.stdout.write(`${c}\n`);
  return 0;
}

// The install command: CA_UPDATE_CMD when set (a shell command line, used by the checks); else a
// git pull when the package root is a checkout, else a fresh global install from GitHub.
function installCommand() {
  if (process.env.CA_UPDATE_CMD) return process.env.CA_UPDATE_CMD;
  const root = path.resolve(HERE, '..');
  if (fs.existsSync(path.join(root, '.git'))) return `git -C ${root} pull --ff-only`;
  return 'npm install -g github:Kahar90/codeartsclimcp';
}

// Compare two x.y.z versions (optional leading "v", missing parts are 0): -1, 0 or 1.
export function compareVersions(a, b) {
  const parts = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '').split('.')
    .map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; });
  const pa = parts(a); const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Parse a CHANGELOG.md into sections "## 1.2.3 (YYYY-MM-DD)", newest first. Items are the "- "
// bullets; a wrapped bullet continues on following indented lines (joined with one space); plain
// sub-heading lines inside a section are skipped.
export function parseChangelog(text) {
  const sections = [];
  let cur = null; let item = -1;
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const head = raw.match(/^##\s+(\S+)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/);
    if (head) { cur = { version: head[1], date: head[2], items: [] }; sections.push(cur); item = -1; continue; }
    if (!cur) continue;
    if (!raw.trim()) { item = -1; continue; }
    const bullet = raw.match(/^\s*-\s+(.*)$/);
    if (bullet) { cur.items.push(bullet[1].trim()); item = cur.items.length - 1; continue; }
    if (/^\s+\S/.test(raw)) { if (item >= 0) cur.items[item] = `${cur.items[item]} ${raw.trim()}`.trim(); continue; }
    item = -1; // a plain sub-heading line: skip it
  }
  return sections.sort((a, b) => compareVersions(b.version, a.version));
}

// The update check: is a newer release published? Reads package.json and CHANGELOG.md from the
// release base URL (CA_UPDATE_URL overrides it, used by the checks), caches the result and never throws.
const PKG_FILE = path.resolve(HERE, '..', 'package.json');
const UPDATE_FILE = path.join(STATE_DIR, 'update.json');
// How long a cached result is trusted before a refresh: 24 h, CA_UPDATE_TTL_H hours overrides it.
export const UPDATE_TTL_MS = (() => { const h = Number(process.env.CA_UPDATE_TTL_H); return (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000; })();

function currentVersion() { try { return String(JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; } }
function updateBaseUrl() { const u = process.env.CA_UPDATE_URL || 'https://raw.githubusercontent.com/Kahar90/codeartsclimcp/main/'; return u.endsWith('/') ? u : `${u}/`; }

// null when the cache is missing or unreadable.
export function readUpdateCache() {
  try { const v = JSON.parse(fs.readFileSync(UPDATE_FILE, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
// Atomic: write a temp file, then rename it over the cache (retry briefly: a Windows reader can hold it).
function writeUpdateCache(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${UPDATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    for (let i = 0; i < 5; i++) { try { fs.renameSync(tmp, UPDATE_FILE); return; } catch { const t = Date.now() + 15; while (Date.now() < t); } }
    try { fs.rmSync(tmp, { force: true }); } catch {}
  } catch {}
}

// Is a newer release published? Result { current, latest, available, notes, cmd, checkedAt, error? }.
// Every successful result is cached in STATE_DIR/update.json; a failure never overwrites a good cache.
export async function checkUpdate({ force = false, timeoutMs = 5000 } = {}) {
  const cmd = installCommand();
  const current = currentVersion();
  if (!force) {
    const c = readUpdateCache();
    if (c && typeof c.checkedAt === 'number' && Date.now() - c.checkedAt < UPDATE_TTL_MS) return c;
  }
  const base = updateBaseUrl();
  try {
    const res = await fetch(`${base}package.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`package.json HTTP ${res.status}`);
    const pkg = await res.json();
    const latest = String((pkg && pkg.version) || '').trim();
    if (!latest) throw new Error('remote package.json has no version');
    const available = compareVersions(latest, current) > 0;
    let notes = [];
    if (available) {
      const cr = await fetch(`${base}CHANGELOG.md`, { signal: AbortSignal.timeout(timeoutMs) });
      if (cr.ok) notes = parseChangelog(await cr.text()).filter((s) => compareVersions(s.version, current) > 0 && compareVersions(s.version, latest) <= 0);
    }
    const result = { current, latest, available, notes, cmd, checkedAt: Date.now() };
    writeUpdateCache(result);
    return result;
  } catch (e) {
    return { current, latest: null, available: false, notes: [], cmd, checkedAt: Date.now(), error: String((e && e.message) || e) };
  }
}

// `ca update [--check] [--json] [--dry-run]`: with --check just report whether a newer release
// exists (and what is new); otherwise reinstall the latest version, then rerun `ca setup <h> --user`
// for every recorded harness so each config is refreshed. A failing install command changes nothing.
export async function update(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const dry = flags.has('--dry-run');
  const asJson = flags.has('--json');
  const cmd = installCommand();
  const harnesses = Object.keys(readManifest().harnesses);

  if (flags.has('--check')) {
    const r = await checkUpdate({ force: true });
    if (asJson) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
    if (r.error) { process.stdout.write(`could not check for updates: ${r.error}\n`); process.exitCode = 1; return 1; }
    if (!r.available) { process.stdout.write(`codearts-lanes ${r.current} is up to date\n`); return 0; }
    process.stdout.write(`Update available: ${r.current} -> ${r.latest}\n`);
    for (const n of r.notes) {
      process.stdout.write(`\n${n.version} (${n.date})\n`);
      for (const item of n.items) process.stdout.write(`  - ${item}\n`);
    }
    process.stdout.write('\nRun: ca update\n');
    return 0;
  }

  if (dry) {
    process.stdout.write(`would run: ${cmd}\n`);
    process.stdout.write(`would refresh: ${harnesses.join(', ') || 'nothing (no machine-wide setup recorded)'}\n`);
    return 0;
  }

  const r = spawnSync(cmd, { shell: true, stdio: asJson ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.status !== 0) {
    process.stdout.write(`update failed: ${cmd} exited ${r.status ?? '?'}\n`);
    process.exitCode = 1;
    return 1;
  }

  const refreshed = [];
  for (const h of harnesses) {
    const s = spawnSync(process.execPath, [CA_MJS, 'setup', h, STATE_DIR, '--user'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const acted = (s.stdout || '').split(/\r?\n/).filter((l) => /^(wrote|updated) /.test(l));
    refreshed.push(`${h}: ${acted.length ? acted.join(', ') : 'unchanged'}`);
  }
  // No update is pending after a successful install: cache the version now installed so the passive
  // notice turns off at once instead of after the old cache expires.
  const installed = currentVersion();
  writeUpdateCache({ current: installed, latest: installed, available: false, notes: [], cmd, checkedAt: Date.now() });
  if (asJson) process.stdout.write(JSON.stringify({ cmd, refreshed, restart: true }, null, 2) + '\n');
  else {
    process.stdout.write(`updated via: ${cmd}\n`);
    for (const line of refreshed) process.stdout.write(line + '\n');
    process.stdout.write('Restart your agent (or its MCP server) and any open dashboard so they load the new version.\n');
  }
  return 0;
}

// The ca.mjs path a recorded harness config points at (args[0]), read from its real config file.
function serverArg0(harness) {
  const d = userPaths(harness);
  if (!d) return null;
  if (d.codexToml) {
    let text; try { text = fs.readFileSync(d.codexToml, 'utf8'); } catch { return null; }
    const block = text.match(/\[mcp_servers\.codearts\]\s*\r?\n([\s\S]*?)(?=\r?\n\[|$)/);
    const a = block && block[1].match(/args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/);
    return a ? a[1].replace(/\\\\/g, '\\') : null;
  }
  for (const j of d.json || []) {
    let obj = null; try { obj = JSON.parse(fs.readFileSync(j.file, 'utf8')); } catch {}
    const s = obj && obj[j.mapKey] && obj[j.mapKey][j.serverKey];
    if (!s) continue;
    if (Array.isArray(s.args) && s.args.length) return s.args[0];      // node <ca.mjs> mcp
    if (Array.isArray(s.command) && s.command.length > 1) return s.command[1]; // opencode: [node, <ca.mjs>, mcp]
  }
  return null;
}

// Doctor rows for the install lifecycle: every recorded harness config still points at this ca.mjs,
// and the installed CodeArts version matches the one that last passed the smoke test.
export function lifecycleRows({ version = null } = {}) {
  const rows = [];
  const recorded = Object.keys(readManifest().harnesses);
  if (!recorded.length) rows.push({ name: 'harness config', status: 'ok', detail: 'no machine-wide setup recorded', fix: '' });
  else {
    const missing = recorded.filter((h) => { const a = serverArg0(h); return !a || !fs.existsSync(a); });
    if (!missing.length) rows.push({ name: 'harness config', status: 'ok', detail: `${recorded.length} recorded harness config(s) point at ${CA_MJS}`, fix: '' });
    else rows.push({
      name: 'harness config', status: 'warn',
      detail: missing.map((h) => `${h} points at a missing ca.mjs`).join('; '),
      fix: `ca update (or ca onboard --yes --harness ${missing[0]})`,
    });
  }

  if (fs.existsSync(EXE)) {
    const first = (s) => (String(s || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
    let installed = version; // passed in by ca doctor, which already ran --version
    if (installed == null) { const r = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); installed = first(r.stdout) || first(r.stderr); }
    let smoke = null; try { smoke = JSON.parse(fs.readFileSync(SMOKE, 'utf8')); } catch {}
    if (!smoke || !smoke.version) rows.push({ name: 'codearts version', status: 'warn', detail: 'no smoke test recorded yet', fix: 'ca onboard --yes --smoke' });
    else if (String(smoke.version) === installed) rows.push({ name: 'codearts version', status: 'ok', detail: `${installed} matches the last smoke test`, fix: '' });
    else rows.push({ name: 'codearts version', status: 'warn', detail: `${installed} was never smoke-tested (last passed: ${smoke.version})`, fix: 'ca onboard --yes --smoke' });
  }
  return rows;
}
