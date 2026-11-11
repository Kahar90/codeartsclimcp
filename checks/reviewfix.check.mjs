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
import { run, pool } from './lib/pool.mjs';
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
async function lane(name, { script, review, env = {}, briefExtra = '' }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `${briefExtra}Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n`);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = await run(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, timeout: 200000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const prompts = read('fake-prompts.log').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { code: r.status, st, prompts, summary: read('tasks/work.lane/summary.md'), log: g('log', '--format=%s').stdout };
}

// The scenarios each build their own repo folder (and may share the registry), so pool(4, ...) starts them
// all first; the check() lines below read from the finished results.

// B: the re-review still says needs fixes: with the default of 1 round the lane ends needs review (exit 4)
// C: switches
const [stillbad, envoff, brief2, ready] = await pool(4, [
  () => lane('stillbad', { script: ['steps:1', 'fix', 'ok'], review: [['VERDICT', FINDING]] }),
  () => lane('envoff', { script: ['steps:1', 'ok'], review: [['VERDICT', FINDING]], env: { REVIEW_FIXES: '0' } }),
  () => lane('brief2', { script: ['steps:1', 'fix', 'ok'], review: [['VERDICT', FINDING]], briefExtra: 'REVIEW_FIXES: 2\n' }),
  () => lane('ready', { script: ['steps:1', 'ok'], review: [['VERDICT', '1. DONE\nVERDICT: ready']] }),
]);

check('still needs fixes after the allowed round: needs review, exit 4, 2 reviews', stillbad.code === 4 && stillbad.st?.result === 'needs review' && stillbad.prompts.filter((p) => p.agent === 'plan').length === 2, `${stillbad.code} ${stillbad.st?.result}`);
check('REVIEW_FIXES=0: old behaviour, needs review after one review, no builder fix prompt', envoff.code === 4 && envoff.prompts.filter((p) => p.agent === 'plan').length === 1 && envoff.prompts.filter((p) => p.agent !== 'plan').length === 1, `${envoff.code}`);
check('"REVIEW_FIXES: 2" brief line allows two rounds (3 reviews)', brief2.code === 4 && brief2.prompts.filter((p) => p.agent === 'plan').length === 3, `${brief2.code} ${brief2.prompts.filter((p) => p.agent === 'plan').length}`);
check('a first ready verdict: one review, no fix round', ready.code === 0 && ready.prompts.filter((p) => p.agent === 'plan').length === 1 && (ready.st?.reviewRounds || []).length === 1, `${ready.code}`);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
