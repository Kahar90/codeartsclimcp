// Contract check for the check runner: tools/run-checks.mjs must not report a false green when a
// filter matches nothing. It copies the real runner into an isolated temp tree (a fake tools/ plus
// a fake checks/) so it exercises the actual implementation without recursing into the real suite.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSrc = path.join(ROOT, 'tools', 'run-checks.mjs');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 260) : ''}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-checkrunner-'));
try {
  fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  fs.copyFileSync(runnerSrc, path.join(tmp, 'tools', 'run-checks.mjs'));
  const checksDir = path.join(tmp, 'checks');
  fs.mkdirSync(checksDir);
  fs.writeFileSync(path.join(checksDir, 'alpha.check.mjs'), "console.log('PASS alpha');\n");
  fs.writeFileSync(path.join(checksDir, 'beta.check.mjs'), "console.log('PASS beta');\n");
  fs.writeFileSync(path.join(checksDir, 'not-a-check.txt'), 'ignored\n');
  const run = (args) => { const r = spawnSync(process.execPath, [path.join('tools', 'run-checks.mjs'), ...args], { cwd: tmp, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

  let r = run(['alpha']);
  check('matching filter runs the matching check and exits 0', r.code === 0 && /ok\s+alpha\.check\.mjs/.test(r.out) && !/beta\.check\.mjs/.test(r.out) && /checks: 1 passed, 0 failed/.test(r.out), `code ${r.code} ${r.out}`);

  // A browser check (it imports lib/chrome.mjs) is skipped by the fast default run and included by --full.
  fs.writeFileSync(path.join(checksDir, 'web.check.mjs'), "// import './lib/chrome.mjs'\nconsole.log('PASS web');\n");
  r = run([]);
  check('the default run skips browser checks and says so', r.code === 0 && /ok\s+alpha/.test(r.out) && /ok\s+beta/.test(r.out) && !/web\.check/.test(r.out) && /1 browser checks skipped/.test(r.out), r.out);
  r = run(['--full']);
  check('--full runs browser checks too', r.code === 0 && /ok\s+web\.check\.mjs/.test(r.out) && /checks: 3 passed, 0 failed/.test(r.out), r.out);
  check('each check line shows its time', /alpha\.check\.mjs\s+\d+\.\d s/.test(r.out), r.out);
  fs.writeFileSync(path.join(checksDir, 'zeta.check.mjs'), "console.log('FAIL zeta broke'); process.exit(1);\n");
  r = run([]);
  check('a failing check fails the run and its FAIL line is shown', r.code !== 0 && /FAIL zeta\.check\.mjs/.test(r.out) && /FAIL zeta broke/.test(r.out) && /1 failed \(zeta\.check\.mjs\)/.test(r.out), r.out);
  fs.rmSync(path.join(checksDir, 'zeta.check.mjs'));

  r = run(['no-such-check-xyz']);
  check('unmatched filter exits nonzero instead of a false green', r.code !== 0, `code ${r.code} ${r.out}`);
  check('unmatched filter names the filter in a diagnostic', /no-such-check-xyz/.test(r.out) && /match|no check/i.test(r.out), r.out);

  fs.rmSync(checksDir, { recursive: true, force: true }); fs.mkdirSync(checksDir);
  r = run([]);
  check('empty discovered suite exits nonzero', r.code !== 0, `code ${r.code} ${r.out}`);
  check('empty discovered suite says no checks were found', /no .*check|match|discover/i.test(r.out), r.out);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
