#!/usr/bin/env node
// tools/release.mjs: keep package.json and CHANGELOG.md in step.
//   node tools/release.mjs --check     exit 1 unless CHANGELOG.md has a dated
//                                      "## <package.json version> (YYYY-MM-DD)" section
//   node tools/release.mjs <version>   set package.json version and, when the section is missing,
//                                      insert an empty dated one at the top of CHANGELOG.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const CL = path.join(ROOT, 'CHANGELOG.md');
const args = process.argv.slice(2);

const sectionRe = (v) => new RegExp(`^##\\s+${String(v).replace(/\./g, '\\.')}\\s+\\(\\d{4}-\\d{2}-\\d{2}\\)`, 'm');
const readCl = () => { try { return fs.readFileSync(CL, 'utf8'); } catch { return ''; } };
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

if (args.includes('--check')) {
  if (sectionRe(pkg.version).test(readCl())) { console.log(`ok: CHANGELOG.md has a ${pkg.version} section`); process.exit(0); }
  console.error(`release check failed: CHANGELOG.md has no "## ${pkg.version} (YYYY-MM-DD)" section`);
  process.exit(1);
}

const version = args.find((a) => !a.startsWith('-'));
if (!version) { console.error('usage: node tools/release.mjs --check | <version>'); process.exit(2); }
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error(`not an x.y.z version: ${version}`); process.exit(2); }

pkg.version = version;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

const cur = readCl();
if (!sectionRe(version).test(cur)) {
  const head = `## ${version} (${today()})\n\n`;
  const next = /^#\s+Changelog\b/.test(cur) ? cur.replace(/^(#\s+Changelog[^\n]*\n)/, `$1\n${head}`) : `# Changelog\n\n${head}${cur}`;
  fs.writeFileSync(CL, next);
  console.log(`added CHANGELOG.md section for ${version}`);
}
console.log(`released ${version}`);
