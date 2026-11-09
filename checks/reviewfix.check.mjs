// Contract check for in-lane review fix rounds (runner/ca.mjs). Before: a final "VERDICT: needs fixes" ended
// the lane (exit 4) and the lead started a whole new fix lane (startup, rebuild, full review again). Now the
// runner sends the reviewer's findings to the same builder session (context kept), runs the gates again and
// asks for a focused re-review of only the fix, up to REVIEW_FIXES rounds (default 1; env REVIEW_FIXES or a
// brief line `REVIEW_FIXES: N`; 0 restores the old behaviour). The re-review prompt says "Previous review
// findings:" with the old findings and names the commit range of the fix; its VERDICT is the lane's verdict.
// state.reviewRounds lists every final review: {round, verdict, at, ms, from, to}. The summary has a line
// "review rounds: N (<verdict> -> <verdict>)". End to end against the fake CodeArts server, no real CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-reviewfix-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, STEP_REVIEW: '0',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240', FAKE_REVIEW_MS: '800' };
delete base.NO_REVIEW; delete base.REVIEW_FIXES;
const FINDING = '1. DONE\nBugs:\n- page1.html:1 says thing 1, the spec wants thing one\nVERDICT: needs fixes';
function lane(name, { script, review, env = {}, briefExtra = '' }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `${briefExtra}Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n`);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = spawnSync(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, encoding: 'utf8', timeout: 200000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const prompts = read('fake-prompts.log').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { code: r.status, st, prompts, summary: read('tasks/work.lane/summary.md'), log: g('log', '--format=%s').stdout };
}
const REV = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready'], ['VERDICT', FINDING]];

// A: one review fix round turns needs fixes into ready inside the lane
let r = lane('round', { script: ['steps:1', 'fix', 'ok'], review: REV });
const reviews = r.prompts.filter((p) => p.agent === 'plan');
const builds = r.prompts.filter((p) => p.agent !== 'plan');
check('lane ends DONE (exit 0) with VERDICT ready after one review fix round', r.code === 0 && r.st?.result === 'done' && r.st?.verdict === 'ready', `${r.code} ${r.st?.result} ${r.st?.verdict}`);
check('the findings went to the builder session (same session as the build)', builds.length >= 2 && builds.slice(1).some((p) => /page1\.html:1/.test(p.text) && p.sid === builds[0].sid), builds.map((p) => `${p.sid}:${p.text.slice(0, 60)}`).join(' || '));
check('the builder fixed and committed (fix commit present)', /fix: make the check pass/.test(r.log), r.log);
check('two final reviews ran; the second says "Previous review findings:" with the old finding', reviews.length === 2 && /Previous review findings:/.test(reviews[1].text) && /page1\.html:1/.test(reviews[1].text), `${reviews.length}`);
check('the re-review names the fix range (a git range from the first review head)', reviews.length === 2 && /[0-9a-f]{7,}\.\.(HEAD|[0-9a-f]{7,})/.test(reviews[1].text), reviews[1]?.text?.slice(0, 300));
const rr = r.st?.reviewRounds || [];
check('state.reviewRounds lists both reviews in order with verdicts', rr.length === 2 && rr[0].verdict === 'needs fixes' && rr[1].verdict === 'ready' && rr.every((x) => Number.isFinite(x.ms) && x.from && x.to), JSON.stringify(rr));
check('the gates ran again after the fix (git clean + check twice)', (r.st?.gates || []).filter((x) => x.gate === 'node -e 0').length >= 2, JSON.stringify((r.st?.gates || []).map((x) => x.gate)));
check('summary has "review rounds: 2 (needs fixes -> ready)"', /review rounds: 2 \(needs fixes -> ready\)/.test(r.summary), r.summary.split(/\r?\n/).filter((l) => /review/.test(l)).join(' | '));
check('review fix rounds are not counted as gate fix rounds', r.st?.fixes === 0, `${r.st?.fixes}`);

// B: the re-review still says needs fixes: with the default of 1 round the lane ends needs review (exit 4)
r = lane('stillbad', { script: ['steps:1', 'fix', 'ok'], review: [['VERDICT', FINDING]] });
check('still needs fixes after the allowed round: needs review, exit 4, 2 reviews', r.code === 4 && r.st?.result === 'needs review' && r.prompts.filter((p) => p.agent === 'plan').length === 2, `${r.code} ${r.st?.result}`);

// C: switches
r = lane('envoff', { script: ['steps:1', 'ok'], review: [['VERDICT', FINDING]], env: { REVIEW_FIXES: '0' } });
check('REVIEW_FIXES=0: old behaviour, needs review after one review, no builder fix prompt', r.code === 4 && r.prompts.filter((p) => p.agent === 'plan').length === 1 && r.prompts.filter((p) => p.agent !== 'plan').length === 1, `${r.code}`);
r = lane('brief2', { script: ['steps:1', 'fix', 'ok'], review: [['VERDICT', FINDING]], briefExtra: 'REVIEW_FIXES: 2\n' });
check('"REVIEW_FIXES: 2" brief line allows two rounds (3 reviews)', r.code === 4 && r.prompts.filter((p) => p.agent === 'plan').length === 3, `${r.code} ${r.prompts.filter((p) => p.agent === 'plan').length}`);
r = lane('ready', { script: ['steps:1', 'ok'], review: [['VERDICT', '1. DONE\nVERDICT: ready']] });
check('a first ready verdict: one review, no fix round', r.code === 0 && r.prompts.filter((p) => p.agent === 'plan').length === 1 && (r.st?.reviewRounds || []).length === 1, `${r.code}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
