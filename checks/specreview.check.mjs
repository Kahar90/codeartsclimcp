// Contract check for the speculative final review (runner/ca.mjs). Measured: the builder spends 30 s to 2.6 min
// after its last step commit (final checks, wrap-up reply) before the gates, and only then did the final review
// start. Now, as soon as every numbered brief step has a "step N:" commit and the work tree is clean, the runner
// starts the final review while the builder wraps up (same template, model, plan agent and step-review appendix;
// it must not use drive()/send()/waitTurn(), which belong to the builder). When the builder goes idle and the git
// clean gate passes: if HEAD is still the commit the speculative review saw, its result is the final review (no
// second review); otherwise it is aborted and discarded and the normal final review runs. State:
// S.specReview = {head, at, used: true|false}; S.reviewStartedAt is when the review that counted was sent.
// In-flight step reviews are cancelled when the speculative review starts (it covers them).
// End to end against the fake CodeArts server (checks/lib/fake-codearts.cjs); no real CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-specreview-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, STEP_REVIEW: '0',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240', FAKE_REVIEW_MS: '3000' };
delete base.NO_REVIEW; delete base.REVIEW_FIXES;
async function lane(name, { script, review = [['VERDICT', '1. DONE\n2. DONE\nVERDICT: ready']], env = {} }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), 'Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: node -e 0\n');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const t0 = Date.now();
  const r = await run(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, timeout: 200000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const jsonl = (f) => read(f).trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { code: r.status, st, ms: Date.now() - t0, prompts: jsonl('fake-prompts.log'), aborts: jsonl('fake-aborts.log'), review: read('tasks/work.lane/review.md') };
}
const finals = (r) => r.prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
const gateAt = (r) => (r.st?.phases || []).find((p) => p.phase === 'gate')?.at;

// Each scenario builds its own repo folder (they may share the registry), so pool(4, ...) starts them all
// first; the check() lines below keep their original order and read from the finished results.
const [used, stale, noreview, partial] = await pool(4, [
  () => lane('used', { script: ['commit:1+commit:2+wait:10000+ok'] }),
  () => lane('stale', { script: ['commit:1+commit:2+wait:7000+commit:3+wait:1000+ok'] }),
  () => lane('noreview', { script: ['commit:1+commit:2+wait:3000+ok'], env: { NO_REVIEW: '1' } }),
  () => lane('partial', { script: ['commit:1+wait:6000+ok', 'commit:2+ok'] }),
]);

// A: both steps committed, then 10 s of wrap-up: the review starts during the wrap-up and is used
let f = finals(used);
check('lane DONE with VERDICT ready', used.code === 0 && used.st?.result === 'done' && used.st?.verdict === 'ready', `${used.code} ${used.st?.result} ${used.st?.verdict}`);
check('exactly one final review ran', f.length === 1, `${f.length}`);
check('it started while the builder was still wrapping up (before the gate phase)', f.length === 1 && gateAt(used) && f[0].t < gateAt(used) - 3000, `prompt ${f[0]?.t} gate ${gateAt(used)}`);
check('state.specReview records head, at and used: true', used.st?.specReview?.used === true && used.st.specReview.head && Number.isFinite(used.st.specReview.at), JSON.stringify(used.st?.specReview));
check('the speculative review used the plan agent and the normal review template', f.length === 1 && f[0].agent === 'plan' && /VERDICT: ready/.test(f[0].text) && /tasks\/work\.md/.test(f[0].text), f[0]?.text?.slice(0, 200));
check('review.md holds the review text', /VERDICT: ready/.test(used.review), used.review.slice(0, 120));
check('the lane finished soon after the gates (no second review wait)', used.ms < 40000, `${used.ms} ms`);

// B: the builder commits again after the speculative review started: it is aborted and the review runs again
f = finals(stale);
check('stale speculative review: lane DONE, ready', stale.code === 0 && stale.st?.result === 'done' && stale.st?.verdict === 'ready', `${stale.code} ${stale.st?.result}`);
check('the stale review was aborted and a second final review ran on the new HEAD', f.length === 2 && stale.aborts.some((a) => a.agent === 'plan') && stale.st?.specReview?.used === false, `${f.length} aborts ${JSON.stringify(stale.aborts)} ${JSON.stringify(stale.st?.specReview)}`);

// C: NO_REVIEW: no review of any kind
check('NO_REVIEW=1: no speculative review', noreview.code === 0 && !noreview.prompts.some((p) => p.agent === 'plan'), `${noreview.code}`);

// D: steps not all committed yet: no speculative review before the builder goes idle
f = finals(partial);
check('only step 1 of 2 committed: the review starts only after the builder is idle', f.length === 1 && gateAt(partial) && f[0].t >= gateAt(partial) - 500, `prompt ${f[0]?.t} gate ${gateAt(partial)}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
