// Contract check for onboarding: `ca onboard`, /api/doctor, the dashboard empty state, npm packaging.
// Temp repos, temp CodeArts settings (CA_SETTINGS) and an empty registry (CA_REGISTRY); never starts CodeArts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard, settle } from './lib/exit.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-onboard-'));
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] }, other: 1 }, null, 2));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
// Every home dir is a temp dir, so onboard never touches the real user config (like scope.check).
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const appdata = path.join(tmp, 'appdata'); fs.mkdirSync(appdata);
fs.mkdirSync(path.join(tmp, 'localappdata'), { recursive: true });
const env = {
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: path.join(tmp, 'localappdata'),
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CA_CLAUDE_CLI: 'none',
  CA_SMOKE_DIR: path.join(tmp, 'smoke'),
  CA_SETTINGS: settings, CA_REGISTRY: reg, CA_DASH: '0',
};
delete env.XDG_CONFIG_HOME;
const ca = (args, opts = {}) => { const t0 = Date.now(); const r = spawnSync(process.execPath, [CA, ...args], { cwd: tmp, env, encoding: 'utf8', timeout: opts.timeout || 90000, input: '' }); return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0 }; };
const js = (s) => { try { return JSON.parse(s); } catch { return null; } };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const mkrepo = (name, marker) => { const d = path.join(tmp, name); fs.mkdirSync(d); spawnSync('git', ['init', '-q'], { cwd: d }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d }); if (marker) fs.mkdirSync(path.join(d, marker), { recursive: true }); return d; };

// help + packaging
let r = ca(['help']); check('help lists ca onboard', /\bca onboard\b/.test(r.out));
check('ca.mjs has a node shebang', fs.readFileSync(CA, 'utf8').startsWith('#!/usr/bin/env node'));
const pkg = js(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('package.json bin ca -> runner/ca.mjs', pkg && pkg.bin && String(pkg.bin.ca || '').replace(/^\.\//, '') === 'runner/ca.mjs', JSON.stringify(pkg && pkg.bin));
check('package.json ships runner, templates, docs and needs node >= 20', pkg && ['runner', 'templates', 'docs'].every((d) => (pkg.files || []).some((f) => f.replace(/\/.*$/, '') === d)) && /20/.test(pkg.engines?.node || ''), JSON.stringify(pkg && { files: pkg.files, engines: pkg.engines }));
check('package.json has no dependencies', pkg && !Object.keys(pkg.dependencies || {}).length);
check('ca.cmd shim for cmd/PowerShell', fs.existsSync(path.join(ROOT, 'bin', 'ca.cmd')) && /ca\.mjs/.test(fs.readFileSync(path.join(ROOT, 'bin', 'ca.cmd'), 'utf8')));

// dry run: detects harness, plans, writes nothing
const kiro = mkrepo('kiro-app', '.kiro');
r = ca(['onboard', '--repo', kiro, '--dry-run', '--json']); let j = js(r.out);
check('onboard --dry-run --json parses', !!j, (r.out + r.err).slice(0, 200));
check('detects kiro from .kiro/', j && j.harness === 'kiro', j && j.harness);
check('dry run writes nothing', !fs.existsSync(path.join(kiro, '.kiro', 'settings')) && js(fs.readFileSync(settings, 'utf8')).security.trustedFolders.length === 0);
check('json has steps, ready and next', j && Array.isArray(j.steps) && j.steps.length >= 3 && typeof j.ready === 'boolean' && Array.isArray(j.next) && j.next.length > 0);
check('steps carry status ok|warn|fail|fixed|skipped and a detail', j && j.steps.every((s) => ['ok', 'warn', 'fail', 'fixed', 'skipped', 'planned'].includes(s.status) && typeof s.detail === 'string'), j && JSON.stringify(j.steps.map((s) => s.status)));

// non-interactive real run with --yes: trusts the folder, sets up kiro, never blocks on stdin
r = ca(['onboard', '--repo', kiro, '--repo-only', '--yes', '--json']); j = js(r.out);
check('onboard --yes finishes without a TTY in under 60 s', j && r.ms < 60000, `${r.ms} ms ${r.err.slice(0, 120)}`);
const s2 = js(fs.readFileSync(settings, 'utf8'));
check('--yes adds the repo to trusted folders, keeps other settings', s2.other === 1 && s2.security.trustedFolders.some((f) => path.resolve(f).toLowerCase() === path.resolve(kiro).toLowerCase()), JSON.stringify(s2.security));
check('--yes ran setup for the detected harness', fs.existsSync(path.join(kiro, '.kiro', 'settings', 'mcp.json')) && fs.existsSync(path.join(kiro, '.kiro', 'steering', 'codearts-lanes.md')));
check('trusted step reports fixed', j && j.steps.some((s) => /trust/i.test(s.name) && s.status === 'fixed'), j && JSON.stringify(j.steps.map((s) => s.name + ':' + s.status)));
check('next steps mention the harness way to start', j && j.next.join(' ').match(/#codearts-lanes|codearts_build/), j && j.next.join(' | '));
r = ca(['onboard', '--repo', kiro, '--repo-only', '--yes', '--json']); const s3 = js(fs.readFileSync(settings, 'utf8'));
check('rerun is idempotent (no duplicate trust entry)', s3.security.trustedFolders.length === 1);

// harness detection and override
const cur = mkrepo('cursor-app', '.cursor'); r = ca(['onboard', '--repo', cur, '--dry-run', '--json']); check('detects cursor', js(r.out)?.harness === 'cursor');
const cl = mkrepo('claude-app', '.claude'); r = ca(['onboard', '--repo', cl, '--dry-run', '--json']); check('detects claude', js(r.out)?.harness === 'claude');
r = ca(['onboard', '--repo', cl, '--harness', 'vscode', '--dry-run', '--json']); check('--harness overrides detection', js(r.out)?.harness === 'vscode');
const plain = mkrepo('plain-app'); r = ca(['onboard', '--repo', plain, '--dry-run', '--json']); j = js(r.out);
check('no marker: harness unknown, lists the choices in next', j && !j.harness && /kiro/.test(j.next.join(' ')) && /cursor/.test(j.next.join(' ')), j && JSON.stringify({ h: j.harness, next: j.next }));

// not a git repo: offers git init, does it only with --yes
const nogit = path.join(tmp, 'nogit'); fs.mkdirSync(nogit); fs.writeFileSync(path.join(nogit, 'a.txt'), 'x');
r = ca(['onboard', '--repo', nogit, '--harness', 'cursor', '--dry-run', '--json']); j = js(r.out);
check('non-git repo: git step planned in dry run', j && j.steps.some((s) => /git/i.test(s.name) && ['planned', 'fail', 'warn'].includes(s.status)) && !fs.existsSync(path.join(nogit, '.git')));
r = ca(['onboard', '--repo', nogit, '--harness', 'cursor', '--yes', '--json']);
check('non-git repo with --yes: git init + first commit', fs.existsSync(path.join(nogit, '.git')) && spawnSync('git', ['log', '--oneline'], { cwd: nogit, encoding: 'utf8' }).stdout.trim().length > 0);

// missing CodeArts CLI: planned in dry run, installer runs with --yes (CA_INSTALL_CMD stub), fixed only when the exe exists
const fakeExe = path.join(tmp, 'fake-cli', process.platform === 'win32' ? 'codearts.exe' : 'codearts');
const cliEnv = { ...env, CODEARTS_EXE: fakeExe, CA_INSTALL_CMD: `node -e "require('fs').mkdirSync(process.argv[1],{recursive:true})" "${path.dirname(fakeExe)}"` };
const onb = (args) => js(spawnSync(process.execPath, [CA, 'onboard', ...args], { cwd: tmp, env: cliEnv, encoding: 'utf8', timeout: 90000, input: '' }).stdout);
const cliRow = (jj) => jj && jj.steps.find((s) => s.name === 'codearts');
j = (() => { const saved = cliEnv.CA_INSTALL_CMD; delete cliEnv.CA_INSTALL_CMD; try { return onb(['--repo', kiro, '--dry-run', '--json']); } finally { cliEnv.CA_INSTALL_CMD = saved; } })();
check('missing CLI: dry run plans the official installer', cliRow(j)?.status === 'planned' && /install\.(ps1|sh)/.test(cliRow(j).fix) && !fs.existsSync(path.dirname(fakeExe)), JSON.stringify(cliRow(j)));
j = onb(['--repo', kiro, '--yes', '--json']);
check('missing CLI: --yes runs the installer, still fails while the exe is missing', fs.existsSync(path.dirname(fakeExe)) && cliRow(j)?.status === 'fail' && /still missing/.test(cliRow(j).detail), JSON.stringify(cliRow(j)));
cliEnv.CA_INSTALL_CMD = `node -e "require('fs').writeFileSync(process.argv[1],'')" "${fakeExe}"`;
j = onb(['--repo', kiro, '--yes', '--json']);
check('missing CLI: fixed once the installer puts the exe in place', ['fixed', 'warn', 'ok'].includes(cliRow(j)?.status) && cliRow(j).status !== 'fail', JSON.stringify(cliRow(j)));
check('trusted folder is reported once (repository section only)', j && j.steps.filter((s) => s.name === 'trusted folder').length === 1);

// human output
r = ca(['onboard', '--repo', kiro, '--dry-run']);
check('plain output: numbered sections and a clear final line', /1\./.test(r.out) && /2\./.test(r.out) && /(ready|not ready)/i.test(r.out), r.out.slice(-200));
check('never prints secret values', !['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK', 'MAAS_API_KEY'].some((k) => process.env[k] && (r.out + r.err).includes(process.env[k])));

// dashboard: /api/doctor and the first-run empty state
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { env, stdio: 'ignore' });
guard({ children: [dash] });
try {
  let ok = false; for (let i = 0; i < 40 && !ok; i++) { await new Promise((x) => setTimeout(x, 250)); try { ok = (await fetch(`http://127.0.0.1:${port}/api/lanes`)).ok; } catch {} }
  const d = await (await fetch(`http://127.0.0.1:${port}/api/doctor`)).json().catch(() => null);
  check('/api/doctor returns doctor JSON', d && Array.isArray(d.checks) && d.checks.every((c) => c.name && c.status), JSON.stringify(d).slice(0, 160));
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  check('dashboard has a first-run onboarding panel', /id="onboard"/.test(html) && /ca onboard/.test(html) && /\/api\/doctor/.test(html));
} finally { await settle({ children: [dash], code: 0 }); }

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) console.log(`warn: could not remove ${tmp} (${e.code})`); else throw e; }
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exitCode = fails ? 1 : 0;
