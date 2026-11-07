// Contract check for machine-wide setup: `ca setup <harness> --user` writes only user-level config
// (nothing in the repo), `ca onboard` uses it by default (`--repo-only` keeps repo files), Codex
// config is always written and stale paths are replaced, multi-line notes survive.
// Every home dir is a temp dir (HOME, USERPROFILE, APPDATA, CODEX_HOME, CLAUDE_CONFIG_DIR).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const caFwd = CA.replace(/\\/g, '/');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-scope-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const appdata = path.join(tmp, 'appdata'); fs.mkdirSync(appdata);
const codexHome = path.join(home, '.codex');
const claudeDir = path.join(home, '.claude');
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const env = {
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: appdata, XDG_CONFIG_HOME: '',
  CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir, CA_CLAUDE_CLI: 'none',
  CA_SETTINGS: settings, CA_REGISTRY: reg, CA_DASH: '0',
};
delete env.XDG_CONFIG_HOME;
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 90000, input: '' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }; };
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const js = (p) => { try { return JSON.parse(rd(p)); } catch { return null; } };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const isServer = (s) => s && s.command === 'node' && Array.isArray(s.args) && s.args[0].replace(/\\/g, '/') === caFwd && s.args[1] === 'mcp';
const mkrepo = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d); spawnSync('git', ['init', '-q'], { cwd: d }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d }); return d; };
const repoClean = (d) => fs.readdirSync(d).filter((f) => f !== '.git').length === 0;
const vscodeUser = process.platform === 'win32' ? path.join(appdata, 'Code', 'User')
  : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User') : path.join(home, '.config', 'Code', 'User');

// ---- ca setup <h> --user: user files only ----
const repo = mkrepo('app');
let r = ca(['setup', 'kiro', repo, '--user']);
const km = js(path.join(home, '.kiro', 'settings', 'mcp.json'));
check('kiro --user: ~/.kiro/settings/mcp.json has the server with autoApprove', r.code === 0 && isServer(km?.mcpServers?.codearts) && km.mcpServers.codearts.autoApprove?.includes('ca_status'), r.out);
check('kiro --user: ~/.kiro/steering/codearts-lanes.md (manual inclusion)', /inclusion:\s*manual/.test(rd(path.join(home, '.kiro', 'steering', 'codearts-lanes.md')) || ''));
check('kiro --user: nothing written in the repo', repoClean(repo), fs.readdirSync(repo).join(','));

r = ca(['setup', 'cursor', repo, '--user']);
const cm = js(path.join(home, '.cursor', 'mcp.json'));
check('cursor --user: ~/.cursor/mcp.json with type stdio', r.code === 0 && isServer(cm?.mcpServers?.codearts) && cm.mcpServers.codearts.type === 'stdio', r.out);
check('cursor --user: nothing written in the repo', repoClean(repo));

r = ca(['setup', 'vscode', repo, '--user']);
const vm = js(path.join(vscodeUser, 'mcp.json'));
check('vscode --user: user-profile mcp.json, servers map, type stdio', r.code === 0 && isServer(vm?.servers?.codearts) && vm.servers.codearts.type === 'stdio', r.out + ' ' + vscodeUser);
check('vscode --user: nothing written in the repo', repoClean(repo));

r = ca(['setup', 'opencode', repo, '--user']);
const om = js(path.join(home, '.config', 'opencode', 'opencode.json'));
check('opencode --user: ~/.config/opencode/opencode.json mcp.codearts local + enabled', r.code === 0 && om?.mcp?.codearts?.type === 'local' && om.mcp.codearts.enabled === true && om.mcp.codearts.command?.[0] === 'node', r.out);
check('opencode --user: ~/.config/opencode/AGENTS.md has the workflow block', /codearts-lanes:start[\s\S]*ca_wait[\s\S]*codearts-lanes:end/.test(rd(path.join(home, '.config', 'opencode', 'AGENTS.md')) || ''));
check('opencode --user: nothing written in the repo', repoClean(repo));

r = ca(['setup', 'codex', repo, '--user']);
const toml = rd(path.join(codexHome, 'config.toml')) || '';
check('codex --user: config.toml written without --write', r.code === 0 && /\[mcp_servers\.codearts\]/.test(toml) && toml.includes(caFwd), r.out);
check('codex --user: read-only tools pre-approved', /\[mcp_servers\.codearts\.tools\.ca_status\]\s*\napproval_mode = "approve"/.test(toml));
check('codex --user: ~/.codex/AGENTS.md has the workflow block', /codearts-lanes:start[\s\S]*codearts-lanes:end/.test(rd(path.join(codexHome, 'AGENTS.md')) || ''));
check('codex --user: nothing written in the repo', repoClean(repo));
// stale path in an existing block is replaced, other config kept, no duplicate tables
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n\n[mcp_servers.codearts]\ncommand = "node"\nargs = ["C:/old/place/ca.mjs", "mcp"]\n\n[mcp_servers.codearts.tools.ca_status]\napproval_mode = "approve"\n\n[mcp_servers.other]\ncommand = "y"\n');
r = ca(['setup', 'codex', repo, '--user']);
const t2 = rd(path.join(codexHome, 'config.toml')) || '';
check('codex: stale args path replaced with the current one', !t2.includes('C:/old/place') && t2.includes(caFwd), t2);
check('codex: other settings and servers kept', /^model = "x"/m.test(t2) && /\[mcp_servers\.other\]\ncommand = "y"/.test(t2));
check('codex: no duplicate tables', (t2.match(/^\[mcp_servers\.codearts\]$/gm) || []).length === 1 && (t2.match(/^\[mcp_servers\.codearts\.tools\.ca_status\]$/gm) || []).length === 1, t2);
r = ca(['setup', 'codex', repo, '--user']);
check('codex: rerun leaves the file unchanged', rd(path.join(codexHome, 'config.toml')) === t2 && /unchanged/.test(r.out), r.out);

// claude: user skill, user settings permissions, user MCP server (JSON merge when the claude CLI is not used)
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ numStartups: 5, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }, null, 2));
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
r = ca(['setup', 'claude', repo, '--user']);
const cj = js(path.join(claudeDir, '.claude.json'));
check('claude --user: user MCP server merged into .claude.json, other keys kept', r.code === 0 && isServer(cj?.mcpServers?.codearts) && cj.mcpServers.codearts.type === 'stdio' && cj.mcpServers.other?.command === 'x' && cj.numStartups === 5, r.out);
const cs = js(path.join(claudeDir, 'settings.json'));
check('claude --user: settings.json allows the read-only tools, keeps the rest', cs?.theme === 'dark' && cs.permissions.allow.includes('Bash(ls:*)') && cs.permissions.allow.includes('mcp__codearts__ca_status') && !cs.permissions.allow.includes('mcp__codearts__ca_lane_start'), JSON.stringify(cs));
check('claude --user: generated skill in the user skills dir', /generated by `ca setup claude`/.test(rd(path.join(claudeDir, 'skills', 'codearts-build', 'SKILL.md')) || ''));
check('claude --user: nothing written in the repo', repoClean(repo), fs.readdirSync(repo).join(','));
check('claude skill no longer says to run ca setup in this repo', !/ca setup claude` in this repo/.test(rd(path.join(claudeDir, 'skills', 'codearts-build', 'SKILL.md')) || ''));

// repo scope (no --user) still works as before
const repo2 = mkrepo('app2');
r = ca(['setup', 'cursor', repo2]);
check('repo scope: cursor still writes .cursor/mcp.json in the repo', r.code === 0 && isServer(js(path.join(repo2, '.cursor', 'mcp.json'))?.mcpServers?.codearts));

// ---- ca onboard: machine-wide by default ----
fs.rmSync(path.join(home, '.kiro'), { recursive: true, force: true });
const repo3 = mkrepo('app3');
r = ca(['onboard', '--repo', repo3, '--harness', 'kiro', '--yes', '--json']);
let j = null; try { j = JSON.parse(r.stdout); } catch {}
check('onboard --yes: json parses', !!j, r.out.slice(0, 200));
check('onboard default: user-level kiro config written', isServer(js(path.join(home, '.kiro', 'settings', 'mcp.json'))?.mcpServers?.codearts));
check('onboard default: no harness files in the repo', !fs.existsSync(path.join(repo3, '.kiro')), fs.readdirSync(repo3).join(','));
check('onboard json reports scope "user"', j && j.scope === 'user', j && j.scope);
check('onboard next says it works in any repo', j && /any repo/i.test(j.next.join(' ')), j && j.next.join(' | '));
const repo4 = mkrepo('app4');
r = ca(['onboard', '--repo', repo4, '--harness', 'kiro', '--repo-only', '--yes', '--json']);
try { j = JSON.parse(r.stdout); } catch { j = null; }
check('onboard --repo-only: repo files written, scope "repo"', fs.existsSync(path.join(repo4, '.kiro', 'settings', 'mcp.json')) && j?.scope === 'repo', j && j.scope);

// multi-line setup notes are not squashed into a one-line detail
fs.rmSync(codexHome, { recursive: true, force: true });
r = ca(['onboard', '--repo', repo3, '--harness', 'codex', '--yes', '--json']);
try { j = JSON.parse(r.stdout); } catch { j = null; }
check('onboard codex: MCP server written to config.toml (not just printed)', /\[mcp_servers\.codearts\]/.test(rd(path.join(codexHome, 'config.toml')) || ''));
const hs = j && j.steps.find((s) => s.name === 'harness setup');
check('onboard codex: harness setup row is fixed and short', hs && hs.status === 'fixed' && !/Add this block/.test(hs.detail) && hs.detail.length < 300, hs && JSON.stringify(hs));
r = ca(['onboard', '--repo', repo3, '--harness', 'codex', '--yes']);
check('onboard text: no truncated "…" detail lines', !/…/.test(r.out), r.out.split('\n').filter((l) => /…/.test(l)).join(' | '));

// smoke: never inside the repo (dry check of the chosen base through --dry-run --smoke --json)
r = ca(['onboard', '--repo', repo3, '--harness', 'codex', '--smoke', '--dry-run', '--json']);
try { j = JSON.parse(r.stdout); } catch { j = null; }
const sm = j && j.steps.find((s) => s.name === 'smoke test');
check('smoke dry run names a base dir outside the repo', sm && /ca-smoke/.test(sm.detail) && !sm.detail.toLowerCase().includes(repo3.toLowerCase()), sm && sm.detail);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
