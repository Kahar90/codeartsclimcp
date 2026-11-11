// Contract check for step reviews and the overlapped final review (runner/ca.mjs), end to end against
// the fake CodeArts server (checks/lib/fake-codearts.cjs). Private registry and settings, no real CodeArts.
//  - each new "step N:" commit gets a short read-only review (plan agent, review model) while the builder
//    keeps working; a "STEP VERDICT: fix" reply reaches the builder as a steer that names the step
//  - the final review starts right after the git clean gate and runs while the CHECK lines run
//  - a failed CHECK aborts that (stale) final review; the review runs again after the fix round
//  - STEP_REVIEW=0, a "STEP_REVIEW: off" brief line and NO_REVIEW=1 turn step reviews off
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stepreview-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath,
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', RATE_BACKOFF_S: '1', LANE_TIMEOUT: '240',
  FAKE_STEP_GAP_MS: '7000', FAKE_REVIEW_MS: '2000' };
delete base.NO_REVIEW; delete base.STEP_REVIEW;
const SLOW = 'node -e "setTimeout(()=>{},5000)"';
const FIXED = 'node -e "process.exit(require(\'fs\').existsSync(\'fixed\')?0:1)"';
const REVIEWS = [
  ['STEP VERDICT[\\s\\S]*step 1:', '1. bug: page1.html:1 says thing 1, the brief wants thing one\nSTEP VERDICT: fix'],
  ['STEP VERDICT', 'no real bugs\nSTEP VERDICT: ok'],
  ['VERDICT', '1. DONE\n2. DONE\nVERDICT: ready'],
];
async function lane(name, { script, brief, review = REVIEWS, env = {} }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const t0 = Date.now();
  const r = await run(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, timeout: 220000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const jsonl = (f) => read(f).trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, prompts: jsonl('fake-prompts.log'), aborts: jsonl('fake-aborts.log'), summary: read('tasks/work.lane/summary.md'), ms: Date.now() - t0 };
}
const brief2 = `Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: ${SLOW}\n`;

// Each scenario builds its own repo folder (they may share the registry). The two step-review scenarios
// (steps, slowstep) need the builder to stay busy so the runner's commit watcher can start (and cancel) a
// step review; a 4-way overlap starves that watcher and no step review runs at all, so those two run alone
// after the pool. The remaining scenarios do not depend on step reviews and overlap safely.
const [coveredFinal, gatefail, envoff, briefoff, noreview] = await pool(4, [
  () => lane('coveredfinal', { script: ['steps:1', 'ok'], brief: '1. Write page1.html. Commit.\nCHECK: node -e 0\n', env: { FAKE_STEP_REVIEW_MS: '90000' } }),
  () => lane('gatefail', { script: ['steps:1', 'fix', 'ok'], brief: `Goal: one page.\n1. Write page1.html. Commit.\nCHECK: ${FIXED}\n`, review: [['STEP VERDICT', 'STEP VERDICT: ok'], ['VERDICT', '1. DONE\nVERDICT: ready']], env: { FAKE_REVIEW_MS: '4000' } }),
  () => lane('envoff', { script: ['steps:1,2', 'ok'], brief: brief2.replace(SLOW, 'node -e 0'), env: { STEP_REVIEW: '0', FAKE_STEP_GAP_MS: '1500' } }),
  () => lane('briefoff', { script: ['steps:1,2', 'ok'], brief: 'STEP_REVIEW: off\n' + brief2.replace(SLOW, 'node -e 0'), env: { FAKE_STEP_GAP_MS: '1500' } }),
  () => lane('noreview', { script: ['steps:1,2', 'ok'], brief: brief2.replace(SLOW, 'node -e 0'), env: { NO_REVIEW: '1', FAKE_STEP_GAP_MS: '1500' } }),
]);
const A = await lane('steps', { script: ['steps:1,2', 'ok'], brief: brief2 });
const slowstep = await lane('slowstep', { script: ['steps:1,2', 'ok'], brief: brief2.replace(SLOW, 'node -e 0'), env: { FAKE_STEP_GAP_MS: '6000', FAKE_STEP_REVIEW_MS: '90000', STEP_REVIEW_GRACE_S: '3' } });

// A: two steps, step 1 gets a fix finding, final review overlaps the slow check
const stepPrompts = A.prompts.filter((p) => p.agent === 'plan' && /STEP VERDICT/.test(p.text));
const finalPrompts = A.prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
const buildPrompts = A.prompts.filter((p) => p.agent !== 'plan');
check('lane ends DONE with VERDICT ready', A.code === 0 && A.st?.result === 'done' && A.st?.verdict === 'ready', `${A.code} ${A.st?.result} ${A.st?.verdict} ${A.out.split(/\r?\n/).filter((l) => /===|review|!/.test(l)).slice(-6).join(' | ')}`);
check('step reviews ran on the plan agent while the builder was still working (first one before the last build answer)',
  stepPrompts.length >= 1 && stepPrompts[0].t < (A.st?.phases || []).find((p) => p.phase === 'gate')?.at, `${stepPrompts.length} step prompts; first ${stepPrompts[0]?.t}; gate at ${(A.st?.phases || []).find((p) => p.phase === 'gate')?.at}`);
check('a step review prompt names the commit range and the brief step it covers', stepPrompts.some((p) => /step 1:/.test(p.text) && /git (show|diff|log)/.test(p.text) && /tasks\/work\.md/.test(p.text)), stepPrompts[0]?.text?.slice(0, 300));
const sr = A.st?.stepReviews || [];
const covered = new Set(sr.flatMap((x) => x.steps || []));
check('early review covers step 1 and the mandatory final review covers the full range', covered.has(1) && A.st.reviewRounds?.some(x => x.from === A.st.start && x.verdict === 'ready'), JSON.stringify(sr.map((x) => ({ steps: x.steps, verdict: x.verdict }))));
check('each step review records hash, verdict, ms and a short text', sr.length && sr.every((x) => x.hash && ['ok', 'fix', 'missing', 'timeout', 'error', 'cancelled'].includes(x.verdict) && Number.isFinite(x.ms) && typeof x.text === 'string' && x.text.length <= 1500), JSON.stringify(sr).slice(0, 300));
check('the step 1 review verdict is fix', sr.some((x) => (x.steps || []).includes(1) && x.verdict === 'fix'), JSON.stringify(sr.map((x) => [x.steps, x.verdict])));
const steerPrompt = buildPrompts.find((p) => /page1\.html:1/.test(p.text));
check('the fix finding reached the builder session as a steer naming step 1', !!steerPrompt && /step 1/i.test(steerPrompt.text), buildPrompts.map((p) => p.text.slice(0, 80)).join(' || '));
check('the steer is listed in state.steers as by "step review"', (A.st?.steers || []).some((s) => s.by === 'step review' && /page1\.html:1/.test(s.text)), JSON.stringify((A.st?.steers || []).map((s) => s.by)));
check('step review tokens bill as review (role map knows step review sessions)', A.st && A.st.tokensBy && 'review' in A.st.tokensBy);
check('exactly one final review ran and it started before the slow CHECK finished',
  finalPrompts.length === 1 && Number.isFinite(A.st?.reviewStartedAt) && A.st.reviewStartedAt < Math.max(...(A.st?.gates || []).filter((x) => x.gate === SLOW).map((x) => x.at)),
  `${finalPrompts.length} final; reviewStartedAt ${A.st?.reviewStartedAt}; check done ${(A.st?.gates || []).filter((x) => x.gate === SLOW).map((x) => x.at)}`);
check('the final review prompt lists the step review results', finalPrompts.length === 1 && /step review/i.test(finalPrompts[0].text), finalPrompts[0]?.text?.slice(-400));
check('summary has a "step reviews:" line with counts', /^step reviews: \d+ \(ok \d+, fix \d+/m.test(A.summary), A.summary.split(/\r?\n/).filter((l) => /step review/.test(l)).join(' | ') || A.summary.slice(0, 300));
check('no review session was left busy: no plan-agent abort in the clean run', !A.aborts.some((a) => a.agent === 'plan'), JSON.stringify(A.aborts));
check('step review prompts are not listed as TUI steers', !(A.st?.steers || []).some((s) => s.by === 'tui'), JSON.stringify((A.st?.steers || []).map((s) => s.by)));

// A2: a slow step review is cancelled after the grace when the builder goes idle; the lane does not wait for it
check('slow step review: cancelled after the grace, lane DONE well before the review would answer', slowstep.code === 0 && slowstep.st?.result === 'done' && (slowstep.st?.stepReviews || []).some((x) => x.verdict === 'cancelled') && slowstep.ms < 60000 && slowstep.aborts.some((a) => a.agent === 'plan'), `${slowstep.code} ${slowstep.st?.result} ${slowstep.ms} ms ${JSON.stringify((slowstep.st?.stepReviews || []).map((x) => x.verdict))}`);

check('no optional review starts after the final reviewer already covers the completed work', coveredFinal.code === 0 && coveredFinal.st?.verdict === 'ready' && !coveredFinal.prompts.some(p => /STEP VERDICT/.test(p.text)) && coveredFinal.prompts.filter(p => p.agent === 'plan').length === 1);

// B: the gate fails once: the overlapped final review is aborted and runs again after the fix
const fin = gatefail.prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
check('gate fail then fix: lane DONE with verdict ready after one fix round', gatefail.code === 0 && gatefail.st?.result === 'done' && gatefail.st?.verdict === 'ready' && gatefail.st?.fixes === 1, `${gatefail.code} ${gatefail.st?.result} ${gatefail.st?.verdict} fixes ${gatefail.st?.fixes}`);
check('the stale final review was aborted when the check failed', gatefail.aborts.some((a) => a.agent === 'plan'), JSON.stringify(gatefail.aborts));
check('the final review ran again on the fixed commit (2 final prompts)', fin.length === 2, `${fin.length}`);

// C: switches
check('STEP_REVIEW=0: no step review, final review still runs', envoff.code === 0 && !envoff.prompts.some((p) => /STEP VERDICT/.test(p.text)) && envoff.prompts.some((p) => p.agent === 'plan'), `${envoff.code} ${envoff.prompts.length}`);
check('"STEP_REVIEW: off" brief line: no step review', briefoff.code === 0 && !briefoff.prompts.some((p) => /STEP VERDICT/.test(p.text)), `${briefoff.code}`);
check('NO_REVIEW=1: no review of any kind', noreview.code === 0 && !noreview.prompts.some((p) => p.agent === 'plan'), `${noreview.code}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
