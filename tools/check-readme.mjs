// Lightweight README contract check: Node only, no browser, no network, no dependencies.
// Verifies that every local image/link target in README.md exists, that the one-prompt
// INSTALL.md URL is still present, and that Office leads the page and Quick install precedes the Lanes screenshots.
// Usage: node tools/check-readme.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const INSTALL_URL = 'https://raw.githubusercontent.com/Kahar90/codeartsclimcp/main/INSTALL.md';
// Office leads the page; Quick install comes before the Lanes tour.
const DASHBOARD_SHOTS = [
  'docs/images/lanes-control-room.png',
  'docs/images/lanes.png',
  'docs/images/lane-detail.png',
  'docs/images/office.png',
];

const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);

let md = '';
try {
  md = fs.readFileSync(README, 'utf8');
} catch (e) {
  console.log(`FAIL read README.md  ${e.message}`);
  process.exit(1);
}

// 1. The one-prompt install URL must survive README edits.
check('README keeps the one-prompt INSTALL.md URL', md.includes(INSTALL_URL));

// Collect every markdown image, HTML img and markdown link, with its position.
const targets = [];
for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push({ kind: 'image', target: m[1], at: m.index });
for (const m of md.matchAll(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) targets.push({ kind: 'image', target: m[1], at: m.index });
for (const m of md.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push({ kind: 'link', target: m[1], at: m.index });

const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//') || t.startsWith('#');
const toPath = (t) => decodeURIComponent(t.split('#')[0].split('?')[0]);

const missing = [];
let localCount = 0;
for (const t of targets) {
  if (isExternal(t.target)) continue;
  const rel = toPath(t.target);
  if (!rel) continue;
  localCount++;
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) { missing.push(`${t.kind} ${t.target} (outside repo)`); continue; }
  if (!fs.existsSync(abs)) missing.push(`${t.kind} ${t.target} (missing)`);
}
check('every local image/link target in README exists', missing.length === 0, missing.join('; '));
check('README references at least one local image and one local link', localCount >= 2, String(localCount));

// 2. Office comes first, followed by Quick install and the Lanes tour.
const qi = md.search(/^##\s+Quick install\s*$/m);
check('README has a "## Quick install" section', qi >= 0);

const dashPos = DASHBOARD_SHOTS.map((shot) => ({ shot, i: md.indexOf(shot) })).filter((d) => d.i >= 0);
check('README references every dashboard screenshot', dashPos.length === DASHBOARD_SHOTS.length,
  DASHBOARD_SHOTS.filter((s) => !dashPos.some((d) => d.shot === s)).join(', ') || 'all present');

const officePos = md.indexOf('docs/images/office.png');
const firstImage = targets.filter((t) => t.kind === 'image').sort((a, b) => a.at - b.at)[0];
check('Office is the first image and precedes the introduction',
  firstImage?.target === 'docs/images/office.png' && officePos < md.indexOf('**Hand coding work'));
const lanesPos = dashPos.filter((d) => d.shot !== 'docs/images/office.png');
check('Quick install follows Office and precedes the Lanes screenshots',
  officePos >= 0 && officePos < qi && lanesPos.every((d) => qi < d.i));

// 3. The tour must label its screenshots as built-in demo data.
check('README labels the tour screenshots as built-in demo data', /built-in demo data|demo=1/i.test(md));

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
