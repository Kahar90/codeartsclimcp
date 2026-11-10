// The runner's source text for checks that look for a code pattern: every runner/*.mjs file joined,
// ca.mjs first, so a check keeps passing when code moves between runner modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runner');

export function runnerSource() {
  const files = fs.readdirSync(RUNNER).filter((f) => f.endsWith('.mjs')).sort((a, b) => (a === 'ca.mjs' ? -1 : b === 'ca.mjs' ? 1 : a.localeCompare(b)));
  return files.map((f) => fs.readFileSync(path.join(RUNNER, f), 'utf8')).join('\n');
}
