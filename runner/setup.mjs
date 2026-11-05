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

// A plan entry is { path, content, action }. Built first, then either printed (--dry-run)
// or written, so a failed build never half-writes a repo.
function buildPlan(harness, repo, flags) {
  return { plan: [], errors: [] };
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
  const { plan, errors } = buildPlan(harness, repo, { dryRun: flags.has('--dry-run'), write: flags.has('--write') });

  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`${e.message}\nAdd this by hand instead:\n${e.snippet}`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.has('--dry-run')) {
    for (const p of plan) process.stdout.write(`${p.path}\n${p.content}\n`);
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
}
