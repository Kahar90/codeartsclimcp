// Contract check for the brief lint (runner/brieflint.mjs, pure): a "do not touch" rule protects only
// the paths its own clause names, never the allow-list earlier on the same line ("Only touch a, b. Do
// not touch c"). Found leading the 0.9.0 lanes: an allow-list line made brief-check warn about every
// allowed file.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const { lintBrief, protectedClauses } = await import(pathToFileURL(path.join(ROOT, 'runner', 'brieflint.mjs')).href);
const files = {
  'runner/state.mjs': 'export const a = 1;\n',
  'runner/view.mjs': "import { a } from './state.mjs';\n",
  'runner/plan.mjs': "import { a } from './state.mjs';\n",
  'checks/state.check.mjs': "import '../runner/state.mjs';\n",
};
const lint = (brief) => lintBrief({ repo: '.', briefText: brief, listFiles: () => Object.keys(files), readFile: (f) => files[f] });
const prot = (ws) => ws.filter((w) => w.kind === 'protected-dependent').map((w) => w.file).sort();

check('protectedClauses keeps only the clause after the phrase', protectedClauses('Only touch runner/view.mjs. Do not touch runner/plan.mjs or the html.') === 'Do not touch runner/plan.mjs or the html.');
check('protectedClauses keeps dotted paths inside the clause', /runner\/plan\.mjs/.test(protectedClauses('Never edit runner/plan.mjs, checks/state.check.mjs')));

let ws = lint('Only touch runner/state.mjs and runner/view.mjs. Do not touch runner/plan.mjs.\n1. Change `runner/state.mjs`. Commit.\n');
check('an allow-list before "do not touch" is not protected', !prot(ws).includes('runner/view.mjs'), JSON.stringify(prot(ws)));
check('the file after "do not touch" still is', prot(ws).includes('runner/plan.mjs'), JSON.stringify(prot(ws)));

ws = lint('Rules: do not edit `checks/`.\n1. Change `runner/state.mjs`. Commit.\n');
check('a protected folder still warns about its dependent', prot(ws).includes('checks/state.check.mjs'), JSON.stringify(prot(ws)));

ws = lint("Do not touch runner/plan.mjs; only touch runner/view.mjs.\n1. Change `runner/state.mjs`. Commit.\n");
check('a semicolon ends the protected clause', prot(ws).join() === 'runner/plan.mjs', JSON.stringify(prot(ws)));

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
process.exitCode = bad ? 1 : 0;
