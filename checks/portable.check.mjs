// Contract check for portability: no Windows-only assumptions outside win32 branches, Chrome found
// through one helper, a CI workflow on Linux, macOS and Windows, and a check runner that reports
// failures as GitHub annotations. Static checks plus a run of the helper; never starts CodeArts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerSource } from './lib/runner-src.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`);
const rd = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };
const code = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.(mjs|js)$/.test(f)).map((f) => `${dir}/${f}`);
const srcFiles = [...code('runner'), ...code('scripts')];

// 1. home directory: os.homedir(), never USERPROFILE or HOME directly
const userprof = srcFiles.filter((f) => /process\.env\.USERPROFILE|process\.env\.HOME\b/.test(rd(f)));
check('runner/ and scripts/ use os.homedir(), never process.env.USERPROFILE or HOME', userprof.length === 0, userprof.join(', '));

// 2. Windows-only names only inside win32 branches (same line mentions win32)
const winOnly = [];
for (const f of srcFiles) rd(f).split(/\r?\n/).forEach((l, i) => {
  if (/^\s*\/\//.test(l)) return;
  if (/'codearts\.exe'|"codearts\.exe"|spawnSync\('powershell'|spawn\('powershell'|run\('powershell'|'cmd\.exe'/.test(l) && !/win32/.test(l)) winOnly.push(`${f}:${i + 1}`);
});
check('codearts.exe, powershell and cmd.exe only appear on lines guarded by a win32 test', winOnly.length === 0, winOnly.join(', '));
check('Git bash fallback is only used on win32 (workerShell)', /function workerShell\(\)\s*\{\s*if \(process\.platform !== 'win32'\)/.test(runnerSource()));

// 3. Chrome: one helper, no hardcoded path in the checks
let lib = null; try { lib = await import(pathToFileURL(path.join(ROOT, 'checks', 'lib', 'chrome.mjs')).href); } catch (e) { check('checks/lib/chrome.mjs imports', false, e.message); }
check('checks/lib/chrome.mjs exports findChrome()', typeof lib?.findChrome === 'function');
if (typeof lib?.findChrome === 'function') {
  const prev = process.env.CHROME_PATH; process.env.CHROME_PATH = process.execPath;
  check('findChrome() honours CHROME_PATH', lib.findChrome() === process.execPath);
  process.env.CHROME_PATH = path.join(ROOT, 'no-such-chrome'); const r = lib.findChrome();
  check('findChrome() ignores a CHROME_PATH that does not exist', r !== path.join(ROOT, 'no-such-chrome'));
  if (prev === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = prev;
  const libSrc = rd('checks/lib/chrome.mjs');
  check('findChrome() knows Linux and macOS locations', /google-chrome/.test(libSrc) && /chromium/.test(libSrc) && /Applications\/Google Chrome\.app/.test(libSrc));
}
const hard = fs.readdirSync(path.join(ROOT, 'checks')).filter((f) => f.endsWith('.check.mjs') && f !== 'portable.check.mjs').filter((f) => /Program Files|chrome\.exe/.test(rd(`checks/${f}`)));
check('no check hardcodes a Chrome path', hard.length === 0, hard.join(', '));
const usesChrome = fs.readdirSync(path.join(ROOT, 'checks')).filter((f) => f.endsWith('.check.mjs') && f !== 'portable.check.mjs' && /remote-debugging-port/.test(rd(`checks/${f}`)));
check('browser checks skip cleanly without Chrome (print SKIP and exit 0)', usesChrome.length > 0 && usesChrome.every((f) => /findChrome/.test(rd(`checks/${f}`)) && /SKIP/.test(rd(`checks/${f}`))), usesChrome.join(', '));
const shortTmp = fs.readdirSync(path.join(ROOT, 'checks')).filter((f) => f.endsWith('.check.mjs') && f !== 'portable.check.mjs' && /user-data-dir/.test(rd(`checks/${f}`)) && !/longTmp|realpathSync\.native|chromeProfileDir/.test(rd(`checks/${f}`)));
check('Chrome profiles use a long-form temp path (helper), never the 8.3 short path', shortTmp.length === 0, shortTmp.join(', '));

// 4. CI workflow
const wf = rd('.github/workflows/check.yml');
check('.github/workflows/check.yml exists', wf.length > 0);
check('CI matrix: ubuntu-latest, macos-latest, windows-latest', /ubuntu-latest/.test(wf) && /macos-latest/.test(wf) && /windows-latest/.test(wf));
check('CI uses Node 22 and runs npm run check on push and pull_request', (/node-version:\s*['"]?22/.test(wf) || (/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/.test(wf) && /node:\s*\[[^\]]*\b22\b/.test(wf))) && (/npm run check/.test(wf) || (/npm run \$\{\{\s*matrix\.suite\s*\}\}/.test(wf) && /suite:\s*\[?\s*check:full/.test(wf))) && /push/.test(wf) && /pull_request/.test(wf));
check('CI keeps going on other OSes when one fails (fail-fast false)', /fail-fast:\s*false/.test(wf));

// 5. check runner with GitHub annotations
const pkg = JSON.parse(rd('package.json') || '{}');
check('package.json check script runs tools/run-checks.mjs', pkg.scripts?.check === 'node tools/run-checks.mjs', pkg.scripts?.check);
const rc = rd('tools/run-checks.mjs');
check('run-checks prints ::error annotations for FAIL lines under GITHUB_ACTIONS', /GITHUB_ACTIONS/.test(rc) && /::error/.test(rc));
check('run-checks prints a final summary and exits 1 when any check fails', /process\.exit(Code)?\s*\(?\s*\w*\s*\?\s*1|process\.exitCode\s*=\s*1|exit\(1\)/.test(rc));

// 6. docs say which platforms are covered
check('README names the supported platforms', /Windows/.test(rd('README.md')) && /macOS/.test(rd('README.md')) && /Linux/.test(rd('README.md')));

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
