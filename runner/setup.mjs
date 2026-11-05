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

// A plan entry is { path, content, action }. Built first, then either printed (--dry-run)
// or written, so a failed build never half-writes a repo.
function buildPlan(harness, repo, flags) {
  return [];
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
  const plan = buildPlan(harness, repo, { dryRun: flags.has('--dry-run'), write: flags.has('--write') });

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
