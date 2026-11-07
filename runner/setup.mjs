#!/usr/bin/env node
// runner/setup.mjs: one-command setup of the CodeArts lanes MCP server and workflow rules
// for other agent harnesses. Called by `ca setup <harness> [repo] [--dry-run] [--write]`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_MJS = path.resolve(HERE, 'ca.mjs').replace(/\\/g, '/');
const WORKFLOW = fs.readFileSync(path.resolve(HERE, '..', 'docs', 'workflow.md'), 'utf8');
const SERVER = { command: 'node', args: [CA_MJS, 'mcp'] };
const HARNESSES = ['claude', 'kiro', 'cursor', 'codex', 'vscode', 'opencode'];
// Machine-wide install bookkeeping: the manifest lists which harness was set up, at which scope,
// which ca.mjs it points at and every file setup wrote or merged. `ca uninstall` replays it.
const STATE_DIR = path.join(os.homedir(), '.config', 'codearts-lanes');
const MANIFEST = path.join(STATE_DIR, 'installed.json');
// Markers around the codearts-lanes workflow block in AGENTS.md and similar files.
export const BLOCK_START = '<!-- codearts-lanes:start -->';
export const BLOCK_END = '<!-- codearts-lanes:end -->';

// Everything `ca setup <harness> --user` may write for one harness, with the JSON map key each
// file uses. `ca uninstall` replays this so a harness that is not in the manifest is still cleaned
// at its known user paths. Paths honour the same CLAUDE_CONFIG_DIR / CODEX_HOME overrides setup
// writes with.
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(home(), '.codex');
export function userPaths(harness) {
  if (harness === 'kiro') return {
    json: [{ file: path.join(home(), '.kiro', 'settings', 'mcp.json'), mapKey: 'mcpServers', serverKey: 'codearts' }],
    steering: [path.join(home(), '.kiro', 'steering', 'codearts-lanes.md')],
  };
  if (harness === 'cursor') return {
    json: [{ file: path.join(home(), '.cursor', 'mcp.json'), mapKey: 'mcpServers', serverKey: 'codearts' }],
  };
  if (harness === 'vscode') return {
    json: [{ file: path.join(vscodeUserDir(), 'mcp.json'), mapKey: 'servers', serverKey: 'codearts' }],
  };
  if (harness === 'codex') return {
    codexToml: path.join(codexHome(), 'config.toml'),
    blocks: [path.join(codexHome(), 'AGENTS.md')],
  };
  if (harness === 'opencode') return {
    json: [{ file: path.join(home(), '.config', 'opencode', 'opencode.json'), mapKey: 'mcp', serverKey: 'codearts' }],
    blocks: [path.join(home(), '.config', 'opencode', 'AGENTS.md')],
  };
  if (harness === 'claude') return {
    // Claude Code keeps user MCP servers in <CLAUDE_CONFIG_DIR>/.claude.json, or ~/.claude.json (home, not ~/.claude).
    json: [{ file: process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home(), '.claude.json'), mapKey: 'mcpServers', serverKey: 'codearts' }],
    allow: [path.join(claudeDir(), 'settings.json')],
    skillDir: path.join(claudeDir(), 'skills', 'codearts-build'),
  };
  return null;
}

// Merge this harness's user-scope record into installed.json: which ca.mjs it points at and every
// file setup wrote or merged. Keeps the other harnesses' records.
function recordManifest(harness, files) {
  let man = {};
  try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch {}
  if (!man || typeof man !== 'object' || Array.isArray(man)) man = {};
  if (!man.harnesses || typeof man.harnesses !== 'object' || Array.isArray(man.harnesses)) man.harnesses = {};
  man.harnesses[harness] = { scope: 'user', caMjs: CA_MJS, files: [...new Set(files.map((p) => path.resolve(p)))], at: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2) + '\n');
}

function usage() {
  process.stderr.write(
    `usage: ca setup <harness> [repo] [--dry-run] [--write] [--user]\n` +
    `harnesses: ${HARNESSES.join(', ')}\n`
  );
}

// Read a JSON config, missing file = {}. A file we cannot parse is left untouched.
function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  let v; try { v = JSON.parse(text); } catch { v = undefined; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { const e = new Error(`cannot parse ${file} as a JSON object`); e.parseFile = file; throw e; }
  return v;
}

// Merge one server entry into <mapKey>.<serverKey> of a JSON config, keeping every other
// key and every other server. Always 2-space indent and a trailing newline.
function mergeJSON(file, mapKey, serverKey, value) {
  const obj = loadJSON(file);
  if (!obj[mapKey] || typeof obj[mapKey] !== 'object' || Array.isArray(obj[mapKey])) obj[mapKey] = {};
  obj[mapKey][serverKey] = value;
  return JSON.stringify(obj, null, 2) + '\n';
}

// The JSON a user must paste by hand when their config does not parse.
function snippet(mapKey, serverKey, value) {
  return JSON.stringify({ [mapKey]: { [serverKey]: value } }, null, 2) + '\n';
}

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// A TOML basic string: escape backslashes (Windows paths) and double quotes.
const tomlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Remove the codearts-lanes block (markers included) from a text file, keeping every other
// line. Returns '' when the block was the whole file, so the caller can delete the file.
export function stripBlock(text) {
  const i = text.indexOf(BLOCK_START);
  const j = text.indexOf(BLOCK_END);
  if (i < 0 || j < i) return text;
  const before = text.slice(0, i).replace(/\s+$/, '');
  const after = text.slice(j + BLOCK_END.length).replace(/^\r?\n/, '').replace(/\s+$/, '');
  return [before, after].filter(Boolean).join('\n\n');
}

// Put the workflow between the codearts-lanes markers, replacing an existing block or
// appending one, and keeping the rest of the file untouched.
function upsertBlock(text, body) {
  const block = `${BLOCK_START}\n${body.replace(/\s+$/, '')}\n${BLOCK_END}\n`;
  const i = text.indexOf(BLOCK_START);
  const j = text.indexOf(BLOCK_END);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + BLOCK_END.length).replace(/^\r?\n/, '');
  const head = text.replace(/\s+$/, '');
  return (head ? head + '\n\n' : '') + block;
}

// A TOML table header line, if the line is one, returns the (trimmed) header name.
const tomlHeader = (line) => { const m = line.match(/^\s*\[([^\]]+)\]/); return m ? m[1].trim() : null; };
const isCodeartsTable = (name) => name === 'mcp_servers.codearts' || name.startsWith('mcp_servers.codearts.');

// Drop every [mcp_servers.codearts] and [mcp_servers.codearts.*] table, keeping all other
// content byte for byte. Each table runs until the next header that is not one of them.
export function stripCodexToml(text) {
  const lines = text.split('\n');
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const name = tomlHeader(lines[i]);
    if (name && isCodeartsTable(name)) {
      i++;
      while (i < lines.length) {
        const sub = tomlHeader(lines[i]);
        if (sub) { if (isCodeartsTable(sub)) { i++; continue; } break; }
        i++;
      }
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n').replace(/\s+$/, '');
}

// Replace (or append) the [mcp_servers.codearts] table and every [mcp_servers.codearts.*]
// sub-table, keeping all other content byte for byte.
function upsertCodexToml(text, block) {
  const body = stripCodexToml(text);
  return (body ? body + '\n\n' : '') + block;
}

// Read-only lanes tools that are safe to auto-approve: they never start or change a lane.
export const AUTO_APPROVE = ['ca_doctor', 'ca_status', 'ca_summary', 'ca_tail', 'ca_wait'];

// The user-level config dir for a harness: home-based with --user, repo-based otherwise.
const home = () => os.homedir();

// VS Code stores its user profile in a different place per OS.
function vscodeUserDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'), 'Code', 'User');
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support', 'Code', 'User');
  return path.join(home(), '.config', 'Code', 'User');
}

function addJSON(plan, errors, file, mapKey, serverKey, value) {
  try { plan.push({ path: file, content: mergeJSON(file, mapKey, serverKey, value) }); }
  catch (e) {
    if (e.parseFile) errors.push({ message: `${e.message}: expected JSON, got something else (comments?)`, snippet: snippet(mapKey, serverKey, value) });
    else throw e;
  }
}

// Claude Code skill: our header (front matter + tool names) followed by the lead workflow.
// A SKILL.md without our marker line is the user's own: never overwritten, only noted.
export const SKILL_MARKER = 'generated by `ca setup claude`';
const SKILL = fs.readFileSync(path.resolve(HERE, '..', 'templates', 'claude-skill.md'), 'utf8').replace(/\s+$/, '')
  + '\n\n' + WORKFLOW.replace(/^# .*\r?\n+/, '');
function addSkill(plan, notes, file) {
  const prev = readText(file);
  if (prev && !prev.includes(SKILL_MARKER)) {
    notes.push(`claude: kept your own skill at ${file} (no "${SKILL_MARKER}" line); delete it to get the generated one`);
    return;
  }
  plan.push({ path: file, content: SKILL });
}

// .claude/settings.local.json: enable the codearts server from .mcp.json and allow the
// read-only tools. Merges into existing arrays, keeps every other key.
function addClaudeSettings(plan, errors, file) {
  const allow = AUTO_APPROVE.map((t) => `mcp__codearts__${t}`);
  try {
    const obj = loadJSON(file);
    const merge = (arr, items) => [...new Set([...(Array.isArray(arr) ? arr : []), ...items])];
    obj.enabledMcpjsonServers = merge(obj.enabledMcpjsonServers, ['codearts']);
    if (!obj.permissions || typeof obj.permissions !== 'object' || Array.isArray(obj.permissions)) obj.permissions = {};
    obj.permissions.allow = merge(obj.permissions.allow, allow);
    plan.push({ path: file, content: JSON.stringify(obj, null, 2) + '\n' });
  } catch (e) {
    if (!e.parseFile) throw e;
    errors.push({ message: `${e.message}: expected JSON`, snippet: JSON.stringify({ enabledMcpjsonServers: ['codearts'], permissions: { allow } }, null, 2) + '\n' });
  }
}

// Structural equality for the plain JSON values we merge (order of keys does not matter).
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// <claude dir>/settings.json: allow the read-only tools, keeping every other key.
function addClaudeUserSettings(plan, errors, file) {
  const allow = AUTO_APPROVE.map((t) => `mcp__codearts__${t}`);
  try {
    const obj = loadJSON(file);
    if (!obj.permissions || typeof obj.permissions !== 'object' || Array.isArray(obj.permissions)) obj.permissions = {};
    obj.permissions.allow = [...new Set([...(Array.isArray(obj.permissions.allow) ? obj.permissions.allow : []), ...allow])];
    plan.push({ path: file, content: JSON.stringify(obj, null, 2) + '\n' });
  } catch (e) {
    if (!e.parseFile) throw e;
    errors.push({ message: `${e.message}: expected JSON`, snippet: JSON.stringify({ permissions: { allow } }, null, 2) + '\n' });
  }
}

// Try the claude CLI to register the user-scope MCP server. stdin is ignored and each call
// has a hard 30 s timeout, so a missing or hanging CLI just returns false.
function claudeCliAdd() {
  const opts = { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true, encoding: 'utf8' };
  spawnSync('claude', ['mcp', 'remove', '-s', 'user', 'codearts'], opts);
  const r = spawnSync('claude', ['mcp', 'add', '-s', 'user', 'codearts', '--', 'node', CA_MJS, 'mcp'], opts);
  return r.status === 0;
}

// A plan entry is { path, content, action }. Built first, then either printed (--dry-run)
// or written, so a failed build never half-writes a repo.
function buildPlan(harness, repo, flags) {
  const plan = [];
  const errors = [];
  const notes = [];
  const extra = []; // user files written outside the plan (the claude CLI adds the server itself)

  if (harness === 'kiro') {
    const dir = flags.user ? path.join(home(), '.kiro') : path.join(repo, '.kiro');
    addJSON(plan, errors, path.join(dir, 'settings', 'mcp.json'), 'mcpServers', 'codearts',
      { ...SERVER, disabled: false, autoApprove: AUTO_APPROVE });
    plan.push({ path: path.join(dir, 'steering', 'codearts-lanes.md'), content: `---\ninclusion: manual\n---\n${WORKFLOW}` });
    notes.push('kiro: the steering file is manual. Reference it in chat with #codearts-lanes.');
  }

  if (harness === 'cursor') {
    const dir = flags.user ? path.join(home(), '.cursor') : path.join(repo, '.cursor');
    addJSON(plan, errors, path.join(dir, 'mcp.json'), 'mcpServers', 'codearts', { type: 'stdio', ...SERVER }); // Cursor docs list type as required
    // User scope has no repo to hold a rule file; the MCP server instructions carry the workflow.
    if (!flags.user) {
      plan.push({
        path: path.join(dir, 'rules', 'codearts-lanes.mdc'),
        content: `---\ndescription: Delegate coding work to CodeArts lanes (plan, brief, start, wait, verify)\nalwaysApply: false\n---\n${WORKFLOW}`,
      });
    }
  }

  if (harness === 'vscode') {
    const dir = flags.user ? vscodeUserDir() : path.join(repo, '.vscode');
    addJSON(plan, errors, path.join(dir, 'mcp.json'), 'servers', 'codearts', { type: 'stdio', ...SERVER });
  }

  if (harness === 'claude') {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
    if (flags.user) {
      // User scope: the skill, the read-only tool permissions and the MCP server all live in
      // the user config; nothing is written in the repo.
      addSkill(plan, notes, path.join(claudeDir, 'skills', 'codearts-build', 'SKILL.md'));
      addClaudeUserSettings(plan, errors, path.join(claudeDir, 'settings.json'));
      const userJson = process.env.CLAUDE_CONFIG_DIR
        ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
        : path.join(home(), '.claude.json');
      const entry = { type: 'stdio', ...SERVER, env: {} };
      let current = null;
      try { current = loadJSON(userJson).mcpServers?.codearts; } catch { current = null; }
      if (current && current.command === entry.command && JSON.stringify(current.args) === JSON.stringify(entry.args)) {
        notes.push(`claude: MCP server already in ${userJson}`);
      } else if (!flags.dryRun && process.env.CA_CLAUDE_CLI !== 'none' && claudeCliAdd()) {
        notes.push('claude: MCP server added with the claude CLI');
        extra.push(userJson);
      } else {
        addJSON(plan, errors, userJson, 'mcpServers', 'codearts', entry);
      }
      notes.push('claude: restart Claude Code (or run /mcp), then in any repo type: /codearts-build <goal>');
    } else {
      addJSON(plan, errors, path.join(repo, '.mcp.json'), 'mcpServers', 'codearts', SERVER);
      // Pre-approve the project server and the read-only tools in the personal (gitignored)
      // settings, so Claude Code neither asks to enable .mcp.json nor prompts on ca_status.
      addClaudeSettings(plan, errors, path.join(repo, '.claude', 'settings.local.json'));
      addSkill(plan, notes, path.join(repo, '.claude', 'skills', 'codearts-build', 'SKILL.md'));
      notes.push('claude: restart Claude Code in this repo (or run /mcp), then type: /codearts-build <goal>');
    }
  }

  if (harness === 'codex') {
    // Codex asks before every MCP tool call: pre-approve the read-only tools (same set as Kiro).
    const block = `[mcp_servers.codearts]\ncommand = "node"\nargs = [${tomlStr(CA_MJS)}, "mcp"]\n`
      + AUTO_APPROVE.map((t) => `\n[mcp_servers.codearts.tools.${t}]\napproval_mode = "approve"\n`).join('');
    // The MCP server is machine-wide: always written to config.toml, with or without --write.
    const codexHome = process.env.CODEX_HOME || path.join(home(), '.codex');
    const config = path.join(codexHome, 'config.toml');
    plan.push({ path: config, content: upsertCodexToml(readText(config), block) });
    notes.push(`codex: MCP server in ${config}`);
    const agents = flags.user ? path.join(codexHome, 'AGENTS.md') : path.join(repo, 'AGENTS.md');
    plan.push({ path: agents, content: upsertBlock(readText(agents), WORKFLOW) });
  }

  if (harness === 'opencode') {
    // opencode: "mcp" map (command is one array), rules from AGENTS.md (project) or ~/.config/opencode.
    const dir = flags.user ? path.join(home(), '.config', 'opencode') : repo;
    addJSON(plan, errors, path.join(dir, 'opencode.json'), 'mcp', 'codearts', { type: 'local', command: [SERVER.command, ...SERVER.args], enabled: true });
    const agents = path.join(dir, 'AGENTS.md');
    plan.push({ path: agents, content: upsertBlock(readText(agents), WORKFLOW) });
    notes.push(flags.user
      ? 'opencode: the codearts tools load in every project; ~/.config/opencode/AGENTS.md carries the workflow.'
      : 'opencode: the codearts tools load in this repo; AGENTS.md carries the workflow.');
  }

  return { plan, errors, notes, extra };
}

export default async function setup(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const pos = args.filter((a) => !a.startsWith('--'));
  const harness = pos[0];
  const repo = path.resolve(pos[1] || process.cwd());
  if (!harness || !HARNESSES.includes(harness)) {
    usage();
    process.exitCode = 2;
    return;
  }
  const { plan, errors, notes, extra = [] } = buildPlan(harness, repo, { dryRun: flags.has('--dry-run'), write: flags.has('--write'), user: flags.has('--user') });

  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`${e.message}\nAdd this by hand instead:\n${e.snippet}`);
    }
    process.exitCode = 1;
    return;
  }

  // Give every entry its action: wrote (new), updated (changed) or unchanged (identical).
  for (const p of plan) {
    const prev = fs.existsSync(p.path) ? fs.readFileSync(p.path, 'utf8') : null;
    p.action = prev === null ? 'wrote' : prev === p.content ? 'unchanged' : 'updated';
  }

  if (flags.has('--dry-run')) {
    for (const p of plan) process.stdout.write(`${p.path}\n${p.content}\n`);
    for (const n of notes) process.stdout.write(`${n}\n`);
    return;
  }
  for (const p of plan) {
    if (p.action !== 'unchanged') {
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, p.content);
    }
    process.stdout.write(`${p.action} ${p.path}\n`);
  }
  if (flags.has('--user')) recordManifest(harness, [...plan.map((p) => p.path), ...extra]);
  for (const n of notes) process.stdout.write(`${n}\n`);
}
