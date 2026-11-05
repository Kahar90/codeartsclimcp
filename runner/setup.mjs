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
const HARNESSES = ['claude', 'kiro', 'cursor', 'codex', 'vscode'];

function usage() {
  process.stderr.write(
    `usage: ca setup <harness> [repo] [--dry-run] [--write]\n` +
    `harnesses: ${HARNESSES.join(', ')}\n`
  );
}

// Read a JSON config, missing file = {}. A file we cannot parse is left untouched.
function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch { const e = new Error(`cannot parse ${file}`); e.parseFile = file; throw e; }
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

// Read-only lanes tools that are safe to auto-approve: they never start or change a lane.
const AUTO_APPROVE = ['ca_doctor', 'ca_status', 'ca_summary', 'ca_tail', 'ca_wait'];

function addJSON(plan, errors, file, mapKey, serverKey, value) {
  try { plan.push({ path: file, content: mergeJSON(file, mapKey, serverKey, value) }); }
  catch (e) {
    if (e.parseFile) errors.push({ message: `${e.message}: expected JSON, got something else (comments?)`, snippet: snippet(mapKey, serverKey, value) });
    else throw e;
  }
}

// A plan entry is { path, content, action }. Built first, then either printed (--dry-run)
// or written, so a failed build never half-writes a repo.
function buildPlan(harness, repo, flags) {
  const plan = [];
  const errors = [];
  const notes = [];

  if (harness === 'kiro') {
    addJSON(plan, errors, path.join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', 'codearts',
      { ...SERVER, disabled: false, autoApprove: AUTO_APPROVE });
    plan.push({ path: path.join(repo, '.kiro', 'steering', 'codearts-lanes.md'), content: `---\ninclusion: manual\n---\n${WORKFLOW}` });
    notes.push('kiro: the steering file is manual. Reference it in chat with #codearts-lanes.');
  }

  if (harness === 'cursor') {
    addJSON(plan, errors, path.join(repo, '.cursor', 'mcp.json'), 'mcpServers', 'codearts', SERVER);
    plan.push({
      path: path.join(repo, '.cursor', 'rules', 'codearts-lanes.mdc'),
      content: `---\ndescription: Delegate coding work to CodeArts lanes (plan, brief, start, wait, verify)\nalwaysApply: false\n---\n${WORKFLOW}`,
    });
  }

  if (harness === 'vscode') {
    addJSON(plan, errors, path.join(repo, '.vscode', 'mcp.json'), 'servers', 'codearts', { type: 'stdio', ...SERVER });
  }

  if (harness === 'claude') {
    addJSON(plan, errors, path.join(repo, '.mcp.json'), 'mcpServers', 'codearts', SERVER);
    notes.push(`claude: repo scope written to .mcp.json. For every project instead, run:\n  claude mcp add -s user codearts -- node ${CA_MJS} mcp`);
    notes.push('claude: the CodeArts Claude Code skill "codearts-build" covers the workflow.');
  }

  if (harness === 'codex') {
    const toml = `[mcp_servers.codearts]\ncommand = "node"\nargs = [${tomlStr(CA_MJS)}, "mcp"]\n`;
    const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    if (flags.write && !flags.dryRun) {
      const existing = readText(config);
      const content = existing.includes('[mcp_servers.codearts]')
        ? existing
        : existing + (existing && !existing.endsWith('\n') ? '\n' : '') + toml;
      plan.push({ path: config, content });
      notes.push(`codex: MCP server written to ${config}`);
    } else {
      notes.push(`codex: MCP server for ${config}. Add this block:\n${toml}`);
    }
    plan.push({ path: path.join(repo, 'AGENTS.md'), content: upsertBlock(readText(path.join(repo, 'AGENTS.md')), WORKFLOW) });
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
  const { plan, errors, notes } = buildPlan(harness, repo, { dryRun: flags.has('--dry-run'), write: flags.has('--write') });

  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`${e.message}\nAdd this by hand instead:\n${e.snippet}`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.has('--dry-run')) {
    for (const p of plan) process.stdout.write(`${p.path}\n${p.content}\n`);
    for (const n of notes) process.stdout.write(`${n}\n`);
    return;
  }
  for (const p of plan) {
    const exists = fs.existsSync(p.path);
    const prev = exists ? fs.readFileSync(p.path, 'utf8') : null;
    if (!exists || prev !== p.content) {
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, p.content);
    }
    process.stdout.write(`${!exists ? 'wrote' : prev === p.content ? 'unchanged' : 'updated'} ${p.path}\n`);
  }
  for (const n of notes) process.stdout.write(`${n}\n`);
}
