// Contract check for runner/setup.mjs via `ca setup <harness> [repo]`. Temp repos only; CODEX_HOME points to a temp dir.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-setup-'));
const codexHome = path.join(tmp, 'codex-home'); fs.mkdirSync(codexHome);
const env = { ...process.env, CA_DASH: '0', CODEX_HOME: codexHome };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 30000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const js = (p) => { try { return JSON.parse(rd(p)); } catch { return null; } };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 200) : ''}`);
const repo = path.join(tmp, 'app'); fs.mkdirSync(repo);
const caFwd = CA.replace(/\\/g, '/');
const isServer = (s) => s && s.command === 'node' && Array.isArray(s.args) && s.args.length === 2 && s.args[0].replace(/\\/g, '/') === caFwd && s.args[1] === 'mcp';

// kiro
let r = ca(['setup', 'kiro', repo]);
let k = js(path.join(repo, '.kiro', 'settings', 'mcp.json'));
check('kiro: exit 0', r.code === 0, r.out);
check('kiro: .kiro/settings/mcp.json has the codearts server', k && isServer(k.mcpServers?.codearts), JSON.stringify(k));
check('kiro: read-only tools auto-approved, start/steer/stop not', k && ['ca_status', 'ca_summary', 'ca_wait'].every((t) => k.mcpServers.codearts.autoApprove?.includes(t)) && !['ca_lane_start', 'ca_steer', 'ca_stop'].some((t) => k.mcpServers.codearts.autoApprove.includes(t)));
const steer = rd(path.join(repo, '.kiro', 'steering', 'codearts-lanes.md'));
check('kiro: steering file with front matter and the workflow', steer && /^---\r?\n[\s\S]*inclusion:\s*\w+[\s\S]*?\r?\n---/.test(steer) && /ca_wait/.test(steer));
// merge keeps other servers and is idempotent
const kp = path.join(repo, '.kiro', 'settings', 'mcp.json'); const kj = js(kp); kj.mcpServers.other = { command: 'x', args: [] }; kj.extra = 1; fs.writeFileSync(kp, JSON.stringify(kj, null, 2));
r = ca(['setup', 'kiro', repo]); k = js(kp);
check('kiro: rerun keeps other servers and keys', r.code === 0 && k.mcpServers.other?.command === 'x' && k.extra === 1 && isServer(k.mcpServers.codearts));
check('kiro: rerun does not duplicate the steering file', fs.readdirSync(path.join(repo, '.kiro', 'steering')).length === 1);

// cursor
r = ca(['setup', 'cursor', repo]); const c = js(path.join(repo, '.cursor', 'mcp.json'));
check('cursor: .cursor/mcp.json with type stdio', r.code === 0 && isServer(c?.mcpServers?.codearts) && c.mcpServers.codearts.type === 'stdio', r.out);
const rule = rd(path.join(repo, '.cursor', 'rules', 'codearts-lanes.mdc'));
check('cursor: rule file with description front matter', rule && /^---[\s\S]*description:[\s\S]*---/.test(rule) && /ca_lane_start/.test(rule));

// vscode
r = ca(['setup', 'vscode', repo]); const v = js(path.join(repo, '.vscode', 'mcp.json'));
check('vscode: .vscode/mcp.json uses servers + type stdio', r.code === 0 && v?.servers?.codearts?.type === 'stdio' && isServer(v.servers.codearts), JSON.stringify(v));
fs.writeFileSync(path.join(repo, '.vscode', 'mcp.json'), '{ // comment\n "servers": {} }');
r = ca(['setup', 'vscode', repo]);
check('vscode: unparsable existing file is not overwritten, exit 1 with the snippet', r.code === 1 && rd(path.join(repo, '.vscode', 'mcp.json')).includes('// comment') && /codearts/.test(r.out), r.out);

// claude
r = ca(['setup', 'claude', repo]); const m = js(path.join(repo, '.mcp.json'));
check('claude: project .mcp.json', r.code === 0 && isServer(m?.mcpServers?.codearts), r.out);
check('claude: says to restart and type /codearts-build', /\/codearts-build/.test(r.out) && /restart/i.test(r.out), r.out);
const skillP = path.join(repo, '.claude', 'skills', 'codearts-build', 'SKILL.md'); const skill = rd(skillP) || '';
check('claude: installs the /codearts-build skill in the repo', /^---\r?\nname: codearts-build\r?\ndescription: .+\r?\n---/.test(skill) && /mcp__codearts__ca_doctor/.test(skill) && /ca_lane_start/.test(skill) && /ca_wait/.test(skill), skill.slice(0, 200));
check('claude: skill is portable (no machine-specific paths)', !/[A-Z]:[\\/]/.test(skill) && !/ca-office|codeartsclimcp/.test(skill));
const sl = js(path.join(repo, '.claude', 'settings.local.json'));
check('claude: settings.local.json enables the server and allows read-only tools only', sl?.enabledMcpjsonServers?.includes('codearts') && ['ca_status', 'ca_wait', 'ca_summary'].every((t) => sl.permissions.allow.includes(`mcp__codearts__${t}`)) && !sl.permissions.allow.some((t) => /ca_(lane_start|steer|stop)/.test(t)), JSON.stringify(sl));
fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['other'], permissions: { allow: ['Bash(ls)'] }, model: 'x' }));
r = ca(['setup', 'claude', repo]); ca(['setup', 'claude', repo]); const sl2 = js(path.join(repo, '.claude', 'settings.local.json'));
check('claude: rerun merges settings, keeps other entries, no duplicates', sl2.model === 'x' && sl2.enabledMcpjsonServers.join() === 'other,codearts' && sl2.permissions.allow[0] === 'Bash(ls)' && sl2.permissions.allow.filter((t) => t === 'mcp__codearts__ca_status').length === 1, JSON.stringify(sl2));
fs.writeFileSync(skillP, '---\nname: codearts-build\n---\nmy own\n');
r = ca(['setup', 'claude', repo]);
check('claude: a user-edited skill (no marker) is never overwritten', rd(skillP).includes('my own') && /kept your own skill/.test(r.out), r.out);
const claudeHome = path.join(tmp, 'claude-home');
r = spawnSync(process.execPath, [CA, 'setup', 'claude', repo, '--user'], { env: { ...env, CLAUDE_CONFIG_DIR: claudeHome }, encoding: 'utf8' });
check('claude --user: also installs the skill in the user skills dir and prints claude mcp add', /name: codearts-build/.test(rd(path.join(claudeHome, 'skills', 'codearts-build', 'SKILL.md')) || '') && /claude mcp add/.test(r.stdout), r.stdout + r.stderr);

// codex: print by default, --write appends once
r = ca(['setup', 'codex', repo]);
check('codex: prints a TOML snippet without writing', r.code === 0 && /\[mcp_servers\.codearts\]/.test(r.out) && !fs.existsSync(path.join(codexHome, 'config.toml')), r.out);
check('codex: read-only tools pre-approved, start/steer/stop not', ['ca_status', 'ca_summary', 'ca_wait'].every((t) => new RegExp(`\\[mcp_servers\\.codearts\\.tools\\.${t}\\]\\s*\\napproval_mode = "approve"`).test(r.out)) && !/tools\.ca_(lane_start|steer|stop)\]/.test(r.out), r.out.slice(0, 300));
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
r = ca(['setup', 'codex', repo, '--write']); ca(['setup', 'codex', repo, '--write']);
const toml = rd(path.join(codexHome, 'config.toml')) || '';
check('codex --write: appended once, existing config kept', r.code === 0 && toml.startsWith('model = "x"') && (toml.match(/\[mcp_servers\.codearts\]/g) || []).length === 1, toml);
const agents = rd(path.join(repo, 'AGENTS.md')) || '';
check('codex: AGENTS.md block between markers, once', (agents.match(/codearts-lanes:start/g) || []).length === 1 && /codearts-lanes:end/.test(agents) && /ca_wait/.test(agents));

// opencode
r = ca(['setup', 'opencode', repo]); const oc = js(path.join(repo, 'opencode.json'));
const ocs = oc && oc.mcp && oc.mcp.codearts;
check('opencode: opencode.json mcp.codearts local command array', r.code === 0 && ocs && ocs.type === 'local' && ocs.enabled === true && Array.isArray(ocs.command) && ocs.command[0] === 'node' && ocs.command[1].replace(/\\/g, '/') === caFwd && ocs.command[2] === 'mcp', JSON.stringify(oc));
check('opencode: AGENTS.md block still once', ((rd(path.join(repo, 'AGENTS.md')) || '').match(/codearts-lanes:start/g) || []).length === 1);

// dry run and errors
const fresh = path.join(tmp, 'fresh'); fs.mkdirSync(fresh);
r = ca(['setup', 'kiro', fresh, '--dry-run']);
check('--dry-run prints and writes nothing', r.code === 0 && /\.kiro/.test(r.out) && fs.readdirSync(fresh).length === 0, r.out);
r = ca(['setup', 'nope', repo]); check('unknown harness exits 2 and lists harnesses', r.code === 2 && /kiro/.test(r.out) && /cursor/.test(r.out));
r = ca(['setup']); check('no harness exits 2 with usage', r.code === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
