#!/usr/bin/env node
// Dogfood install: put this checkout's committed code into the global codearts-lanes install that the
// MCP server, the `ca` CLI and every lane run, so the next feature is built with the newest runner.
//   node scripts/install-local.mjs [--force] [--dry-run]
// Refuses while a lane is running (the supervisor would switch code mid-run) or when runner files have
// uncommitted changes (only committed work is released). Steps: npm pack -> `ca update` with
// CA_UPDATE_CMD pointing at the tarball (installs, then reruns `ca setup` for every recorded harness)
// -> restart the dashboard on its port. Restart the agent (or /mcp) afterwards for the MCP server.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const force = args.has('--force'); const dry = args.has('--dry-run');
const die = (m) => { console.error(`install-local: ${m}`); process.exit(1); };
const run = (file, argv, opts = {}) => spawnSync(file, argv, { encoding: 'utf8', windowsHide: true, ...opts });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 1. Only committed work, and never under a running lane.
const dirty = run('git', ['-C', ROOT, 'status', '--porcelain', '--', 'runner', 'templates', 'bin', 'scripts', 'docs', 'package.json', 'CHANGELOG.md']).stdout.trim();
if (dirty && !force) die(`uncommitted changes would not match the release:\n${dirty}\ncommit them first (or --force)`);
const st = run(process.execPath, [path.join(ROOT, 'runner', 'ca.mjs'), 'status', '--json']);
let running = [];
try { running = JSON.parse(st.stdout || '[]').filter((l) => l.bucket === 'running').map((l) => l.lane || l.id); } catch {}
if (running.length && !force) die(`lanes still running: ${running.join(', ')}; wait for them (or --force)`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const head = run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).stdout.trim();
const globalRoot = run(npm, ['root', '-g'], { shell: process.platform === 'win32' }).stdout.trim();
const installedCa = path.join(globalRoot, 'codearts-lanes', 'runner', 'ca.mjs');
if (!fs.existsSync(installedCa)) die(`no global install at ${installedCa}; run: npm install -g github:Kahar90/codeartsclimcp`);

// 2. Pack the committed tree into a temp dir (a real copy, never a link to this checkout).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-install-'));
const p = run(npm, ['pack', '--json', '--pack-destination', tmp], { cwd: ROOT, shell: process.platform === 'win32' });
if (p.status !== 0) die(`npm pack failed: ${p.stderr || p.stdout}`);
const tgz = path.join(tmp, JSON.parse(p.stdout)[0].filename);
console.log(`packed ${pkg.name} ${pkg.version} (${head}) -> ${tgz}`);
if (dry) { console.log(`would install it with: ca update (CA_UPDATE_CMD=npm install -g "${tgz}")`); process.exit(0); }

// 3. Install and refresh every recorded harness through the installed `ca update`.
const u = run(process.execPath, [installedCa, 'update'], { stdio: 'inherit', env: { ...process.env, CA_UPDATE_CMD: `npm install -g "${tgz}"` } });
if (u.status !== 0) die(`ca update exited ${u.status}`);
const now = JSON.parse(fs.readFileSync(path.join(globalRoot, 'codearts-lanes', 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(globalRoot, 'codearts-lanes', '.installed-from'), `${ROOT}\n${head}\n${new Date().toISOString()}\n`);

// 4. Restart the dashboard on its port so it serves the new code.
const port = Number(process.env.CA_DASH_PORT || 4777);
let pid = null;
try { const r = await fetch(`http://127.0.0.1:${port}/api/update`, { signal: AbortSignal.timeout(3000) }); pid = (await r.json()).pid || null; } catch {}
if (pid) {
  try { process.kill(pid); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  spawn(process.execPath, [installedCa, 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CA_DASH_RECLAIM: '1' } }).unref();
  console.log(`dashboard restarted on http://127.0.0.1:${port}`);
} else console.log('no dashboard running; start one with: ca dash');
console.log(`installed codearts-lanes ${now} from ${head}. Restart your agent (or /mcp) so the MCP server loads it.`);
