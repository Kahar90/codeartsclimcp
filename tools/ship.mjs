#!/usr/bin/env node
// tools/ship.mjs: the release tail in one command, so the lead can start it in the background and move on.
//   node tools/ship.mjs [--push] [--skip-full] [--dry-run]
// Before: `node tools/release.mjs <version>` and fill the new CHANGELOG.md section.
// Steps (stops at the first failure, prints the time of each):
//   1. CHANGELOG.md has a dated, non-empty section for the package.json version
//   2. only package.json, CHANGELOG.md and tasks/ may be uncommitted; package.json + CHANGELOG.md are
//      committed as "release <version>: <first changelog line>"
//   3. npm run check:full (skip with --skip-full when it already ran on this commit)
//   4. node scripts/install-local.mjs (refuses while a lane runs)
//   5. --push: git push origin HEAD
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const t0 = Date.now();
const secs = (ms) => `${Math.round(ms / 1000)}s`;
const die = (m) => { console.error(`ship: ${m}`); process.exit(1); };
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', windowsHide: true });
const step = (name, file, argv) => {
  const s = Date.now();
  console.log(`ship: ${name}${dry ? ' (dry run, skipped)' : ''}`);
  if (dry) return;
  const r = spawnSync(file, argv, { cwd: ROOT, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && file === npm });
  if (r.status !== 0) die(`${name} failed (exit ${r.status}) after ${secs(Date.now() - s)}`);
  console.log(`ship: ${name} ok (${secs(Date.now() - s)})`);
};

// 1. changelog section
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const m = cl.match(new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\s+\\(\\d{4}-\\d{2}-\\d{2}\\)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
if (!m) die(`CHANGELOG.md has no "## ${version} (YYYY-MM-DD)" section: run node tools/release.mjs <version> first`);
const body = m[1].trim();
if (!body) die(`the CHANGELOG.md section for ${version} is empty: write what changed first`);
// The subject is the first bullet (a section may start with a heading such as "Updates").
const lines = body.split(/\r?\n/);
const first = (lines.find((l) => /^\s*[-*]\s+/.test(l)) || lines.find((l) => l.trim()) || '').replace(/^\s*[-*]\s*/, '').trim();

// 2. tree state + release commit
const dirty = git('status', '--porcelain').stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
const other = dirty.filter((f) => !/^(package\.json|CHANGELOG\.md|tasks\/)/.test(f));
if (other.length) die(`uncommitted changes besides the release files:\n  ${other.join('\n  ')}\ncommit them first`);
const rel = dirty.filter((f) => /^(package\.json|CHANGELOG\.md)$/.test(f));
if (rel.length) {
  const subject = `release ${version}: ${first.replace(/\.$/, '')}`.slice(0, 120);
  console.log(`ship: commit "${subject}"${dry ? ' (dry run, skipped)' : ''}`);
  if (!dry) {
    const a = git('add', '--', ...rel); const c = git('commit', '-qm', subject);
    if (a.status || c.status) die(`release commit failed: ${(a.stderr + c.stderr).trim()}`);
  }
} else console.log(`ship: release files already committed (${version})`);

// 3-5
if (!args.has('--skip-full')) step('full check suite', npm, ['run', 'check:full']);
step('install into the global codearts-lanes', process.execPath, [path.join(ROOT, 'scripts', 'install-local.mjs')]);
if (args.has('--push')) step('push', 'git', ['-C', ROOT, 'push', 'origin', 'HEAD']);
console.log(`ship: ${version} shipped in ${secs(Date.now() - t0)}${args.has('--push') ? '' : ' (not pushed: add --push)'}; reconnect the MCP server (/mcp) to load it`);
