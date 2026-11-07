#!/usr/bin/env node
// tools/sync-skill.mjs: copy the dev repo into the installed Claude Code skill
// (default ~/.claude/skills/codearts-build, or CA_SKILL_DIR / --to <dir>).
// Copies git-tracked files only, skips dev-only paths, never touches the skill's own SKILL.md,
// never deletes: files that exist only in the skill are listed. `npm run sync [-- --dry-run]`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const ti = args.indexOf('--to');
const target = path.resolve(ti >= 0 ? args[ti + 1] : process.env.CA_SKILL_DIR || path.join(os.homedir(), '.claude', 'skills', 'codearts-build'));
const SKIP = [/^design\//, /^tasks\//, /^tools\//, /^checks\/out\//, /^CLAUDE\.md$/, /^\.git/, /^SKILL\.md$/];

const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
if (ls.status !== 0) { console.error(`git ls-files failed: ${ls.stderr}`); process.exit(1); }
const files = ls.stdout.split('\0').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
const dirty = spawnSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (dirty) console.log(`warning: uncommitted changes are copied as they are on disk:\n${dirty}`);
if (!fs.existsSync(path.join(target, 'SKILL.md'))) { console.error(`${target} has no SKILL.md: not a codearts-build skill dir (use --to <dir>)`); process.exit(2); }

let wrote = 0, same = 0;
for (const f of files) {
  const src = path.join(ROOT, f), dst = path.join(target, f);
  if (!fs.existsSync(src)) continue; // deleted in the work tree
  const a = fs.readFileSync(src);
  if (fs.existsSync(dst) && a.equals(fs.readFileSync(dst))) { same++; continue; }
  console.log(`${dry ? 'would copy' : 'copied'} ${f}`);
  if (!dry) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, a); }
  wrote++;
}
const known = new Set(files);
const extra = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const rel = path.relative(target, p).replace(/\\/g, '/'); if (e.isDirectory()) { if (!/^(\.git|checks\/out|node_modules)$/.test(rel)) walk(p); } else if (rel !== 'SKILL.md' && !known.has(rel)) extra.push(rel); } };
walk(target);
console.log(`${dry ? 'dry run: ' : ''}${wrote} ${dry ? 'to copy' : 'copied'}, ${same} unchanged -> ${target}`);
if (extra.length) console.log(`only in the skill (not deleted): ${extra.join(', ')}`);
