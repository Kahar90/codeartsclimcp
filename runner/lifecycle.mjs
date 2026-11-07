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
    if (h === 'claude' && process.env.CA_CLAUDE_CLI !== 'none') {
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
