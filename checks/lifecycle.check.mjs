// Contract check for install lifecycle: `ca setup --user` records what it wrote in a manifest,
// `ca uninstall` removes exactly that (keeping everything else), `ca update` reinstalls and refreshes
// every recorded harness, and `ca doctor` flags stale config paths and an untested CodeArts version.
// Every home dir is a temp dir; CODEARTS_EXE is node itself (its --version stands in for CodeArts).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs'); const caFwd = CA.replace(/\\/g, '/');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-life-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
fs.mkdirSync(path.join(tmp, 'localappdata'), { recursive: true });
const codexHome = path.join(home, '.codex'); const claudeDir = path.join(home, '.claude');
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(tmp, 'appdata'), LOCALAPPDATA: path.join(tmp, 'localappdata'),
  CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir, CA_CLAUDE_CLI: 'none', CA_SETTINGS: settings, CA_REGISTRY: reg, CA_DASH: '0',
  CODEARTS_EXE: process.execPath, CA_CREDENTIALS: path.join(tmp, 'creds.json') };
delete env.XDG_CONFIG_HOME;
const ca = (args, extra = {}) => { const r = spawnSync(process.execPath, [CA, ...args], { cwd: tmp, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, input: '' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const js = (p) => { try { return JSON.parse(rd(p)); } catch { return null; } };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const manifestP = path.join(home, '.config', 'codearts-lanes', 'installed.json');
const kiroMcp = path.join(home, '.kiro', 'settings', 'mcp.json');

// ---- manifest ----
fs.mkdirSync(path.dirname(kiroMcp), { recursive: true });
fs.writeFileSync(kiroMcp, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } }, keep: 1 }, null, 2));
fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# My rules\n\nBe nice.\n');
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }));
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'] } }));
for (const h of ['kiro', 'codex', 'claude', 'cursor', 'opencode', 'vscode']) ca(['setup', h, tmp, '--user']);
const man = js(manifestP);
check('setup --user records a manifest at ~/.config/codearts-lanes/installed.json', man && man.harnesses && ['kiro', 'codex', 'claude', 'cursor', 'opencode', 'vscode'].every((h) => man.harnesses[h]), rd(manifestP)?.slice(0, 200));
check('manifest entries carry scope, the ca.mjs path and the files touched', man && Object.values(man.harnesses || {}).every((e) => e.scope === 'user' && String(e.caMjs || '').replace(/\\/g, '/') === caFwd && Array.isArray(e.files) && e.files.length > 0));

// ---- doctor: harness config row ----
let r = ca(['doctor', '--json']); let d = null; try { d = JSON.parse(r.out); } catch {}
const hrow = (dd) => dd && dd.checks.find((c) => c.name === 'harness config');
check('doctor has a "harness config" row, ok while every recorded config points at this ca.mjs', hrow(d)?.status === 'ok', JSON.stringify(hrow(d)));
const km = js(kiroMcp); km.mcpServers.codearts.args[0] = 'C:/gone/old/ca.mjs'; fs.writeFileSync(kiroMcp, JSON.stringify(km, null, 2));
r = ca(['doctor', '--json']); try { d = JSON.parse(r.out); } catch { d = null; }
check('doctor warns when a recorded config points at a missing ca.mjs, fix says ca update', ['warn', 'fail'].includes(hrow(d)?.status) && /kiro/.test(hrow(d)?.detail || '') && /ca update/.test(hrow(d)?.fix || ''), JSON.stringify(hrow(d)));

// ---- update: reinstall command, then refresh every recorded harness ----
r = ca(['update', '--dry-run']);
check('update --dry-run names the install command and the harnesses to refresh', r.code === 0 && /npm install -g github:Kahar90\/codeartsclimcp|git -C .* pull/.test(r.out) && /kiro/.test(r.out) && /codex/.test(r.out), r.out.slice(0, 300));
check('update --dry-run changes nothing', js(kiroMcp).mcpServers.codearts.args[0] === 'C:/gone/old/ca.mjs');
r = ca(['update'], { CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(0)"` });
check('update runs the install command and refreshes stale configs', r.code === 0 && String(js(kiroMcp).mcpServers.codearts.args[0]).replace(/\\/g, '/') === caFwd, `${r.code} ${r.out.slice(0, 300)}`);
r = ca(['update'], { CA_UPDATE_CMD: `"${process.execPath}" -e "process.exit(7)"` });
check('a failing install command makes update exit 1 and leaves configs alone', r.code === 1 && /exit(ed)? 7|failed/i.test(r.out), `${r.code} ${r.out.slice(0, 200)}`);

// ---- doctor: CodeArts version vs the last smoke-tested one ----
const smokeP = path.join(home, '.config', 'codearts-lanes', 'smoke.json'); fs.mkdirSync(path.dirname(smokeP), { recursive: true });
fs.writeFileSync(smokeP, JSON.stringify({ version: process.version, at: new Date().toISOString() }));
r = ca(['doctor', '--json']); try { d = JSON.parse(r.out); } catch { d = null; }
const vrow = (dd) => dd && dd.checks.find((c) => c.name === 'codearts version');
check('doctor "codearts version" ok when it matches the last smoke-tested version', vrow(d)?.status === 'ok', JSON.stringify(vrow(d)));
fs.writeFileSync(smokeP, JSON.stringify({ version: 'v0.0.1', at: '2026-01-01T00:00:00Z' }));
r = ca(['doctor', '--json']); try { d = JSON.parse(r.out); } catch { d = null; }
check('doctor warns on an untested CodeArts version, fix runs the smoke test', vrow(d)?.status === 'warn' && /v0\.0\.1/.test(vrow(d)?.detail || '') && /ca onboard .*--smoke/.test(vrow(d)?.fix || ''), JSON.stringify(vrow(d)));
fs.rmSync(smokeP);
r = ca(['doctor', '--json']); try { d = JSON.parse(r.out); } catch { d = null; }
check('no smoke record yet: version row is a warn that suggests the smoke test', vrow(d)?.status === 'warn' && /--smoke/.test(vrow(d)?.fix || ''), JSON.stringify(vrow(d)));
check('onboard records the CodeArts version after a passing smoke test', /smoke\.json/.test(fs.readFileSync(path.join(ROOT, 'runner', 'onboard.mjs'), 'utf8')));

// ---- uninstall ----
r = ca(['uninstall', '--harness', 'kiro', '--dry-run']);
check('uninstall --dry-run lists what it would remove and changes nothing', r.code === 0 && /mcp\.json/.test(r.out) && /codearts-lanes\.md/.test(r.out) && js(kiroMcp)?.mcpServers?.codearts, r.out.slice(0, 300));
r = ca(['uninstall', '--harness', 'kiro']);
const k2 = js(kiroMcp);
check('uninstall kiro: codearts server gone, other servers and keys kept', r.code === 0 && k2 && !k2.mcpServers.codearts && k2.mcpServers.other?.command === 'x' && k2.keep === 1, JSON.stringify(k2));
check('uninstall kiro: steering file removed', !fs.existsSync(path.join(home, '.kiro', 'steering', 'codearts-lanes.md')));
check('uninstall kiro: manifest entry removed, others kept', !js(manifestP)?.harnesses?.kiro && js(manifestP)?.harnesses?.codex);
r = ca(['uninstall', '--harness', 'codex']);
const toml = rd(path.join(codexHome, 'config.toml')) || '';
check('uninstall codex: every [mcp_servers.codearts*] table gone, other config kept', !/mcp_servers\.codearts/.test(toml) && /^model = "x"/m.test(toml) && /\[mcp_servers\.other\]/.test(toml), toml);
const ag = rd(path.join(codexHome, 'AGENTS.md')) || '';
check('uninstall codex: AGENTS.md block removed, own text kept', !/codearts-lanes:start/.test(ag) && /Be nice\./.test(ag), ag);
r = ca(['uninstall']);
const cj = js(path.join(claudeDir, '.claude.json')); const cs = js(path.join(claudeDir, 'settings.json'));
check('uninstall (all): claude user server removed, other servers and keys kept', r.code === 0 && cj && !cj.mcpServers?.codearts && cj.mcpServers?.other && cj.numStartups === 3, JSON.stringify(cj));
check('uninstall (all): mcp__codearts__ permissions removed, others kept', cs && !cs.permissions.allow.some((a) => a.startsWith('mcp__codearts__')) && cs.permissions.allow.includes('Bash(ls:*)') && cs.theme === 'dark', JSON.stringify(cs));
check('uninstall (all): generated claude skill removed', !fs.existsSync(path.join(claudeDir, 'skills', 'codearts-build')));
check('uninstall (all): cursor, opencode and vscode servers removed', !js(path.join(home, '.cursor', 'mcp.json'))?.mcpServers?.codearts && !js(path.join(home, '.config', 'opencode', 'opencode.json'))?.mcp?.codearts);
check('uninstall (all): manifest emptied', Object.keys(js(manifestP)?.harnesses || {}).length === 0);
// a user-edited skill is never removed
fs.mkdirSync(path.join(claudeDir, 'skills', 'codearts-build'), { recursive: true }); fs.writeFileSync(path.join(claudeDir, 'skills', 'codearts-build', 'SKILL.md'), '---\nname: codearts-build\n---\nmy own\n');
ca(['setup', 'claude', tmp, '--user']); ca(['uninstall', '--harness', 'claude']);
check('uninstall never deletes a user-edited skill', /my own/.test(rd(path.join(claudeDir, 'skills', 'codearts-build', 'SKILL.md')) || ''));
// keys only with --keys
fs.writeFileSync(env.CA_CREDENTIALS, '{"CODEARTS_CLI_AK":"x"}');
ca(['uninstall']); check('uninstall keeps the keys file by default', fs.existsSync(env.CA_CREDENTIALS));
r = ca(['uninstall', '--keys']); check('uninstall --keys also deletes the keys file', !fs.existsSync(env.CA_CREDENTIALS), r.out.slice(0, 160));
r = ca(['help']); check('help lists ca update and ca uninstall', /ca update/.test(r.out) && /ca uninstall/.test(r.out));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
