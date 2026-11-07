// tools/run-checks.mjs: run every checks/*.check.mjs in name order and print a summary.
// usage: node tools/run-checks.mjs [nameSubstring]   (npm run check -- scope runs the scope checks)
// Under GitHub Actions every FAIL line, and any check that exits non-zero without a FAIL line,
// is turned into an ::error annotation so the failure shows inline on the pull request.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const files = fs.readdirSync(path.join(ROOT, 'checks'))
  .filter((f) => f.endsWith('.check.mjs')).sort().filter((f) => f.includes(filter));
const onCI = process.env.GITHUB_ACTIONS === 'true';
const failed = [];

for (const file of files) {
  console.log(`== ${file}`);
  const r = spawnSync(process.execPath, [path.join('checks', file)], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  const failLines = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
  if (onCI) for (const l of failLines) console.log(`::error title=${file}::${l.replace(/^FAIL\s*/, '')}`);
  if (r.status !== 0) {
    if (onCI && failLines.length === 0) console.log(`::error title=${file}::check exited ${r.status} with no FAIL line`);
    failed.push(file);
  }
}

const passed = files.length - failed.length;
console.log(`checks: ${passed} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
if (failed.length) process.exit(1);
