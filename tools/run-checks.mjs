// tools/run-checks.mjs: run checks/*.check.mjs in parallel and print a summary with timings.
// usage: node tools/run-checks.mjs [--full] [--jobs N] [nameSubstring]
//   default   the fast set: every check that does not drive a browser (seconds, run it after each change)
//   --full    every check, browser checks included (run once before a release, and in CI)
//   name      only checks whose file name contains it (browser checks included when they match)
// A check drives a browser when it imports checks/lib/chrome.mjs; at most 3 of those run at once.
// A check whose source says "run-checks: solo" (timing budgets) runs alone after the parallel batch.
// Timings go to checks/out/timings.json so slow checks stay visible.
// Under GitHub Actions every FAIL line, and any check that exits non-zero without a FAIL line,
// is turned into an ::error annotation so the failure shows inline on the pull request.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const full = args.includes('--full');
const ji = args.indexOf('--jobs');
const jobs = Math.max(1, Number(ji >= 0 ? args[ji + 1] : 0) || Math.min(8, Math.max(2, os.cpus().length - 2)));
const filter = args.filter((a, i) => !a.startsWith('--') && !(ji >= 0 && i === ji + 1))[0] || '';
const onCI = process.env.GITHUB_ACTIONS === 'true';
const dir = path.join(ROOT, 'checks');
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.check.mjs')).sort();
const isBrowser = (f) => /lib\/chrome\.mjs/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
const files = all.filter((f) => f.includes(filter)).filter((f) => full || filter || !isBrowser(f));

if (!files.length) {
  const msg = filter ? `checks: no check files match "${filter}"` : 'checks: no checks/*.check.mjs files discovered';
  console.log(msg);
  if (onCI) console.log(`::error title=run-checks::${msg}`);
  process.exit(1);
}

// Previous timings put the slowest checks first, so a parallel run is not held up by a late long one.
const timingsFile = path.join(dir, 'out', 'timings.json');
let prev = {}; try { prev = JSON.parse(fs.readFileSync(timingsFile, 'utf8')); } catch {}
const isSolo = (f) => /run-checks: solo/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
const solo = files.filter(isSolo);
const queue = files.filter((f) => !solo.includes(f)).sort((a, b) => (prev[b] || 0) - (prev[a] || 0));
const browser = new Set(files.filter(isBrowser));
const MAX_BROWSER = 3;
const t0 = Date.now(); const results = []; let running = 0, runningBrowser = 0, jobsNow = jobs;

function runOne(file) {
  return new Promise((resolve) => {
    const start = Date.now(); let out = '';
    const ch = spawn(process.execPath, [path.join('checks', file)], { cwd: ROOT, env: process.env });
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => resolve({ file, code: code ?? 1, out, ms: Date.now() - start }));
    ch.on('error', (e) => resolve({ file, code: 1, out: String(e), ms: Date.now() - start }));
  });
}
await new Promise((done) => {
  const pump = () => {
    if (!queue.length && !running) { if (!solo.length) return done(); queue.push(solo.shift()); jobsNow = 1; }
    while (running < jobsNow && queue.length) {
      const i = queue.findIndex((f) => !browser.has(f) || runningBrowser < MAX_BROWSER);
      if (i < 0) break;
      const [file] = queue.splice(i, 1); const b = browser.has(file);
      running++; if (b) runningBrowser++;
      runOne(file).then((r) => {
        running--; if (b) runningBrowser--;
        results.push(r);
        const failLines = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
        const ok = r.code === 0;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(28)} ${(r.ms / 1000).toFixed(1).padStart(6)} s`);
        if (!ok) { for (const l of failLines) console.log(`     ${l}`); if (!failLines.length) console.log(r.out.split(/\r?\n/).slice(-15).map((l) => `     ${l}`).join('\n')); }
        if (onCI) { for (const l of failLines) console.log(`::error title=${file}::${l.replace(/^FAIL\s*/, '')}`); if (!ok && !failLines.length) console.log(`::error title=${file}::check exited ${r.code} with no FAIL line`); }
        pump();
      });
    }
  };
  pump();
});

try { fs.mkdirSync(path.dirname(timingsFile), { recursive: true }); fs.writeFileSync(timingsFile, JSON.stringify({ ...prev, ...Object.fromEntries(results.map((r) => [r.file, r.ms])) }, null, 2)); } catch {}
const failed = results.filter((r) => r.code !== 0).map((r) => r.file).sort();
const skipped = full || filter ? 0 : all.length - files.length;
console.log(`checks: ${files.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s` +
  `${skipped ? `; ${skipped} browser checks skipped (npm run check:full runs them)` : ''}`);
if (failed.length) process.exit(1);
