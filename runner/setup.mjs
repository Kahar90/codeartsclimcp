#!/usr/bin/env node
// runner/setup.mjs: one-command setup of the CodeArts lanes MCP server and workflow rules
// for other agent harnesses. Called by `ca setup <harness> [repo] [--dry-run] [--write]`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_MJS = path.resolve(HERE, 'ca.mjs').replace(/\\/g, '/');
const WORKFLOW = fs.readFileSync(path.resolve(HERE, '..', 'docs', 'workflow.md'), 'utf8');
const SERVER = { command: 'node', args: [CA_MJS, 'mcp'] };
const HARNESSES = ['claude', 'kiro', 'cursor', 'codex', 'vscode', 'opencode'];

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

// Put the workflow between the codearts-lanes markers, replacing an existing block or
// appending one, and keeping the rest of the file untouched.
function upsertBlock(text, body) {
  const start = '<!-- codearts-lanes:start -->';
  const end = '<!-- codearts-lanes:end -->';
  const block = `${start}\n${body.replace(/\s+$/, '')}\n${end}\n`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + end.length).replace(/^\r?\n/, '');
  const head = text.replace(/\s+$/, '');
  return (head ? head + '\n\n' : '') + block;
}

// A TOML table header line, if the line is one, returns the (trimmed) header name.
const tomlHeader = (line) => { const m = line.match(/^\s*\[([^\]]+)\]/); return m ? m[1].trim() : null; };
const isCodeartsTable = (name) => name === 'mcp_servers.codearts' || name.startsWith('mcp_servers.codearts.');

// Replace (or append) the [mcp_servers.codearts] table and every [mcp_servers.codearts.*]
// sub-table, keeping all other content byte for byte. Each table runs until the next header
// that is not one of them.
function upsertCodexToml(text, block) {
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
  const body = kept.join('\n').replace(/\s+$/, '');
  return (body ? body + '\n\n' : '') + block;
}

// Read-only lanes tools that are safe to auto-approve: they never start or change a lane.
const AUTO_APPROVE = ['ca_doctor', 'ca_status', 'ca_summary', 'ca_tail', 'ca_wait'];

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
const SKILL_MARKER = 'generated by `ca setup claude`';
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

// A plan entry is { path, content, action }. Built first, then either printed (--dry-run)
// or written, so a failed build never half-writes a repo.
function buildPlan(harness, repo, flags) {
  const plan = [];
  const errors = [];
  const notes = [];

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
    addJSON(plan, errors, path.join(repo, '.mcp.json'), 'mcpServers', 'codearts', SERVER);
    // Pre-approve the project server and the read-only tools in the personal (gitignored)
    // settings, so Claude Code neither asks to enable .mcp.json nor prompts on ca_status.
    addClaudeSettings(plan, errors, path.join(repo, '.claude', 'settings.local.json'));
    // The /codearts-build skill: repo scope always, user scope too with --user.
    addSkill(plan, notes, path.join(repo, '.claude', 'skills', 'codearts-build', 'SKILL.md'));
    if (flags.user) {
      const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      addSkill(plan, notes, path.join(claudeHome, 'skills', 'codearts-build', 'SKILL.md'));
      notes.push(`claude: for the MCP server in every project too, run:\n  claude mcp add -s user codearts -- node ${CA_MJS} mcp`);
    }
    notes.push('claude: restart Claude Code in this repo (or run /mcp), then type: /codearts-build <goal>');
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

  return { plan, errors, notes };
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
  const { plan, errors, notes } = buildPlan(harness, repo, { dryRun: flags.has('--dry-run'), write: flags.has('--write'), user: flags.has('--user') });

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
  for (const n of notes) process.stdout.write(`${n}\n`);
}
