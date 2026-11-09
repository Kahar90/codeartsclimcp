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
function lane(name, { script, brief, review = REVIEWS, env = {} }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, encoding: 'utf8', timeout: 220000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const jsonl = (f) => read(f).trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { repo, code: r.status, out: (r.stdout || '') + (r.stderr || ''), st, prompts: jsonl('fake-prompts.log'), aborts: jsonl('fake-aborts.log'), summary: read('tasks/work.lane/summary.md'), ms: Date.now() - t0 };
}
const brief2 = `Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: ${SLOW}\n`;

// A: two steps, step 1 gets a fix finding, final review overlaps the slow check
let r = lane('steps', { script: ['steps:1,2', 'ok'], brief: brief2 });
const stepPrompts = r.prompts.filter((p) => p.agent === 'plan' && /STEP VERDICT/.test(p.text));
const finalPrompts = r.prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
const buildPrompts = r.prompts.filter((p) => p.agent !== 'plan');
check('lane ends DONE with VERDICT ready', r.code === 0 && r.st?.result === 'done' && r.st?.verdict === 'ready', `${r.code} ${r.st?.result} ${r.st?.verdict} ${r.out.split(/\r?\n/).filter((l) => /===|review|!/.test(l)).slice(-6).join(' | ')}`);
check('step reviews ran on the plan agent while the builder was still working (first one before the last build answer)',
  stepPrompts.length >= 1 && stepPrompts[0].t < (r.st?.phases || []).find((p) => p.phase === 'gate')?.at, `${stepPrompts.length} step prompts; first ${stepPrompts[0]?.t}; gate at ${(r.st?.phases || []).find((p) => p.phase === 'gate')?.at}`);
check('a step review prompt names the commit range and the brief step it covers', stepPrompts.some((p) => /step 1:/.test(p.text) && /git (show|diff|log)/.test(p.text) && /tasks\/work\.md/.test(p.text)), stepPrompts[0]?.text?.slice(0, 300));
const sr = r.st?.stepReviews || [];
const covered = new Set(sr.flatMap((x) => x.steps || []));
check('state.stepReviews covers steps 1 and 2 (coalescing allowed)', covered.has(1) && covered.has(2), JSON.stringify(sr.map((x) => ({ steps: x.steps, verdict: x.verdict }))));
check('each step review records hash, verdict, ms and a short text', sr.length && sr.every((x) => x.hash && ['ok', 'fix', 'missing', 'timeout', 'error'].includes(x.verdict) && Number.isFinite(x.ms) && typeof x.text === 'string' && x.text.length <= 1500), JSON.stringify(sr).slice(0, 300));
check('the step 1 review verdict is fix', sr.some((x) => (x.steps || []).includes(1) && x.verdict === 'fix'), JSON.stringify(sr.map((x) => [x.steps, x.verdict])));
const steerPrompt = buildPrompts.find((p) => /page1\.html:1/.test(p.text));
check('the fix finding reached the builder session as a steer naming step 1', !!steerPrompt && /step 1/i.test(steerPrompt.text), buildPrompts.map((p) => p.text.slice(0, 80)).join(' || '));
check('the steer is listed in state.steers as by "step review"', (r.st?.steers || []).some((s) => s.by === 'step review' && /page1\.html:1/.test(s.text)), JSON.stringify((r.st?.steers || []).map((s) => s.by)));
check('step review tokens bill as review (role map knows step review sessions)', r.st && r.st.tokensBy && 'review' in r.st.tokensBy);
check('exactly one final review ran and it started before the slow CHECK finished',
  finalPrompts.length === 1 && Number.isFinite(r.st?.reviewStartedAt) && r.st.reviewStartedAt < Math.max(...(r.st?.gates || []).filter((x) => x.gate === SLOW).map((x) => x.at)),
  `${finalPrompts.length} final; reviewStartedAt ${r.st?.reviewStartedAt}; check done ${(r.st?.gates || []).filter((x) => x.gate === SLOW).map((x) => x.at)}`);
check('the final review prompt lists the step review results', finalPrompts.length === 1 && /step review/i.test(finalPrompts[0].text), finalPrompts[0]?.text?.slice(-400));
check('summary has a "step reviews:" line with counts', /^step reviews: \d+ \(ok \d+, fix \d+/m.test(r.summary), r.summary.split(/\r?\n/).filter((l) => /step review/.test(l)).join(' | ') || r.summary.slice(0, 300));
check('no review session was left busy: no plan-agent abort in the clean run', !r.aborts.some((a) => a.agent === 'plan'), JSON.stringify(r.aborts));

// B: the gate fails once: the overlapped final review is aborted and runs again after the fix
r = lane('gatefail', { script: ['steps:1', 'fix', 'ok'], brief: `Goal: one page.\n1. Write page1.html. Commit.\nCHECK: ${FIXED}\n`, review: [['STEP VERDICT', 'STEP VERDICT: ok'], ['VERDICT', '1. DONE\nVERDICT: ready']], env: { FAKE_REVIEW_MS: '4000' } });
const fin = r.prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
check('gate fail then fix: lane DONE with verdict ready after one fix round', r.code === 0 && r.st?.result === 'done' && r.st?.verdict === 'ready' && r.st?.fixes === 1, `${r.code} ${r.st?.result} ${r.st?.verdict} fixes ${r.st?.fixes}`);
check('the stale final review was aborted when the check failed', r.aborts.some((a) => a.agent === 'plan'), JSON.stringify(r.aborts));
check('the final review ran again on the fixed commit (2 final prompts)', fin.length === 2, `${fin.length}`);

// C: switches
r = lane('envoff', { script: ['steps:1,2', 'ok'], brief: brief2.replace(SLOW, 'node -e 0'), env: { STEP_REVIEW: '0', FAKE_STEP_GAP_MS: '1500' } });
check('STEP_REVIEW=0: no step review, final review still runs', r.code === 0 && !r.prompts.some((p) => /STEP VERDICT/.test(p.text)) && r.prompts.some((p) => p.agent === 'plan'), `${r.code} ${r.prompts.length}`);
r = lane('briefoff', { script: ['steps:1,2', 'ok'], brief: 'STEP_REVIEW: off\n' + brief2.replace(SLOW, 'node -e 0'), env: { FAKE_STEP_GAP_MS: '1500' } });
check('"STEP_REVIEW: off" brief line: no step review', r.code === 0 && !r.prompts.some((p) => /STEP VERDICT/.test(p.text)), `${r.code}`);
r = lane('noreview', { script: ['steps:1,2', 'ok'], brief: brief2.replace(SLOW, 'node -e 0'), env: { NO_REVIEW: '1', FAKE_STEP_GAP_MS: '1500' } });
check('NO_REVIEW=1: no review of any kind', r.code === 0 && !r.prompts.some((p) => p.agent === 'plan'), `${r.code}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
