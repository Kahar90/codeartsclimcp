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
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-reviewreuse-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, STEP_REVIEW: '0',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '240', FAKE_REVIEW_MS: '800' };
delete base.NO_REVIEW; delete base.REVIEW_FIXES;
const FINDING = '1. DONE\nBugs:\n- page1.html:1 says thing 1, the spec wants thing one\nVERDICT: needs fixes';
function lane(name, { script, review, env = {}, briefExtra = '', reviewFile = '' }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  if (reviewFile) fs.writeFileSync(path.join(repo, 'tasks', 'work.review.md'), reviewFile);
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), `${briefExtra}Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n`);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const r = spawnSync(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env: { ...base, ...env }, encoding: 'utf8', timeout: 200000 });
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const prompts = read('fake-prompts.log').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let st = null; try { st = JSON.parse(read('tasks/work.lane/state.json')); } catch {}
  return { code: r.status, st, prompts, summary: read('tasks/work.lane/summary.md'), log: g('log', '--format=%s').stdout, status: g('status', '--short').stdout };
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

check('healthy final reviewer session reused for fix round', reviews.length === 2 && reviews[0].sid === reviews[1].sid, reviews.map(p=>p.sid).join(','));

// Step 2: the fix round must use a dedicated concise fix-only prompt, not the full-review text plus a
// replay of the whole review context (which only competes with the fix instructions).
const fixPrompt = reviews[1]?.text || '';
check('fix round uses the dedicated fix-only review prompt', /focused re-review of a fix/i.test(fixPrompt), fixPrompt.slice(0, 160));
check('fix prompt keeps every prior finding and names the fix range', /Previous review findings:/.test(fixPrompt) && /page1\.html:1/.test(fixPrompt) && /[0-9a-f]{7,}\.\.HEAD/.test(fixPrompt), fixPrompt.slice(0, 240));
check('fix prompt asks for a regression assessment and keeps the read-only rule and VERDICT line', /regression/i.test(fixPrompt) && /read-only/i.test(fixPrompt) && /"VERDICT: ready" or "VERDICT: needs fixes"/.test(fixPrompt), fixPrompt.slice(0, 240));
check('fix prompt drops the full-review context block (no conflicting instructions)', fixPrompt.length > 0 && !/Prepared context from the runner/.test(fixPrompt) && fixPrompt.length < (reviews[0]?.text || '').length, `${fixPrompt.length} vs ${reviews[0]?.text?.length}`);

// G: a custom tasks/<task>.review.md is still honored on the fix round.
const CUSTOM_REVIEW = 'CUSTOM-REVIEW-MARK: be extra strict about page titles.\nEnd with VERDICT: ready or VERDICT: needs fixes.\n';
const gLane = lane('customreview', { script: ['steps:1', 'fix', 'ok'], review: REV, reviewFile: CUSTOM_REVIEW });
const gRev = gLane.prompts.filter((p) => p.agent === 'plan');
check('custom tasks/<task>.review.md is preserved on the fix round', gLane.code === 0 && gRev.length === 2 && /CUSTOM-REVIEW-MARK/.test(gRev[1]?.text || ''), gRev[1]?.text?.slice(0, 200));

// B: a reused reviewer session that answers with its OLD cached verdict (the same message id as the
// recorded round) must never be accepted. The runner has to fall back to a fresh session whose verdict
// is a genuinely new turn. The fake answers the fix-round prompt with the session's existing id.
const REV_STALE = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready', { stale: true }], ['VERDICT', FINDING]];
const b = lane('stale', { script: ['steps:1', 'fix', 'ok'], review: REV_STALE, env: { FAKE_REVIEW_MS: '5000' } });
const bRev = b.prompts.filter((p) => p.agent === 'plan');
check('stale cached verdict: it is never applied and the lane still ends ready', b.code === 0 && b.st?.result === 'done' && b.st?.verdict === 'ready', `${b.code} ${b.st?.result} ${b.st?.verdict}`);
check('stale cached verdict: the fix round reused the healthy session, then fell back to a fresh one', bRev.length === 3 && bRev[1].sid === bRev[0].sid && bRev[2].sid !== bRev[1].sid, bRev.map((p) => p.sid).join(','));

// C: a reused session whose reply carries NO message id can never prove a new turn, so it is rejected
// and the runner falls back to a fresh session (a fresh session needs no id to be accepted).
const REV_NOID = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready', { noId: true }], ['VERDICT', FINDING]];
const c = lane('noid', { script: ['steps:1', 'fix', 'ok'], review: REV_NOID, env: { FAKE_REVIEW_MS: '5000' } });
const cRev = c.prompts.filter((p) => p.agent === 'plan');
check('missing id on a reused reply: rejected, lane still ends ready via a fresh session', c.code === 0 && c.st?.result === 'done' && c.st?.verdict === 'ready', `${c.code} ${c.st?.result} ${c.st?.verdict}`);
check('missing id on a reused reply: the fix round reused the session, then fell back to a fresh one', cRev.length === 3 && cRev[1].sid === cRev[0].sid && cRev[2].sid !== cRev[1].sid, cRev.map((p) => p.sid).join(','));

// F: when the recorded round has no usable assistant id at all, it can never be reused. The fix review
// must be a fresh session from the start (no reuse attempt with a missing baseline).
const REV_NOREUSE = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready'], ['VERDICT', FINDING, { noId: true }]];
const f = lane('noreuse', { script: ['steps:1', 'fix', 'ok'], review: REV_NOREUSE });
const fRev = f.prompts.filter((p) => p.agent === 'plan');
check('no recorded id: the round is not reused, so the fix review is a fresh session', f.code === 0 && f.st?.result === 'done' && fRev.length === 2 && fRev[1].sid !== fRev[0].sid, `${f.code} ${f.st?.result} ${fRev.map((p) => p.sid).join(',')}`);

// D: the reviewer leaves an uncommitted change in the work tree while the review turn runs. The verdict
// describes content that no longer exists, so acceptance must end "needs review" with an actionable
// reason, and the runner must never commit the stray change itself.
const REV_WRITE = [['VERDICT', '1. DONE\nVERDICT: ready', { write: ['stray.txt=stray'] }]];
const d = lane('mutwrite', { script: ['steps:1', 'ok'], review: REV_WRITE, env: { FAKE_REVIEW_MS: '6000' } });
check('reviewer-time write: the lane ends needs review, never ready', d.code === 4 && d.st?.result === 'needs review' && d.st?.verdict !== 'ready', `${d.code} ${d.st?.result} ${d.st?.verdict}`);
check('reviewer-time write: the stray change is left uncommitted (the runner never commits it)', /stray\.txt/.test(d.status) && !/reviewer: stray change/.test(d.log), d.status.replace(/\r?\n/g, ' | '));
check('reviewer-time write: the reason names the reviewer mutation', /reviewer changed the reviewed content/.test(d.st?.reason || ''), d.st?.reason);

// E: the reviewer moves HEAD (commits) while the review turn runs. Same acceptance rule: needs review.
const REV_COMMIT = [['VERDICT', '1. DONE\nVERDICT: ready', { commit: ['stray.txt=stray'] }]];
const e = lane('mutcommit', { script: ['steps:1', 'ok'], review: REV_COMMIT, env: { FAKE_REVIEW_MS: '6000' } });
check('reviewer-time commit: the lane ends needs review, never ready', e.code === 4 && e.st?.result === 'needs review' && e.st?.verdict !== 'ready', `${e.code} ${e.st?.result} ${e.st?.verdict}`);
check('reviewer-time commit: the reason names the reviewer mutation', /reviewer changed the reviewed content/.test(e.st?.reason || ''), e.st?.reason);

// H: a previous reviewer session that is BUSY when the fix round starts must not be reused (the reuse gate
// requires the session to be idle). The full review's session is flipped busy a few seconds after it
// answers; the long fix turn keeps that state in place until the fix round re-reviews, so the fix review
// must run on a fresh session and the lane still ends ready.
const REV_BUSY = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready'], ['VERDICT', FINDING, { busyAfter: 6000 }]];
const h = lane('busy', { script: ['steps:1', 'wait:14000', 'ok'], review: REV_BUSY, env: { FAKE_REVIEW_MS: '800' } });
const hRev = h.prompts.filter((p) => p.agent === 'plan');
check('busy reviewer session is not reused; the fix review is a fresh session and the lane still ends ready',
  h.code === 0 && h.st?.result === 'done' && h.st?.verdict === 'ready' && hRev.length >= 2 && hRev.slice(1).every((p) => p.sid !== hRev[0].sid),
  `${h.code} ${h.st?.result} ${h.st?.verdict} ${hRev.map((p) => p.sid).join(',')}`);

// I: a previous reviewer session that recorded a session error must not be reused either (the reuse gate
// fails closed on sess[sid].error). Same shape as H; falls back to a fresh session.
const REV_ERR = [['Previous review findings', '1. DONE: the finding is fixed\nVERDICT: ready'], ['VERDICT', FINDING, { errorAfter: 6000 }]];
const i = lane('reuserr', { script: ['steps:1', 'wait:14000', 'ok'], review: REV_ERR, env: { FAKE_REVIEW_MS: '800' } });
const iRev = i.prompts.filter((p) => p.agent === 'plan');
check('errored reviewer session is not reused; the fix review is a fresh session and the lane still ends ready',
  i.code === 0 && i.st?.result === 'done' && i.st?.verdict === 'ready' && iRev.length >= 2 && iRev.slice(1).every((p) => p.sid !== iRev[0].sid),
  `${i.code} ${i.st?.result} ${i.st?.verdict} ${iRev.map((p) => p.sid).join(',')}`);

// J: a speculative fix round that REUSED the previous reviewer session is discarded when HEAD moves again
// before it is used. The follow-up normal review must NOT re-select that same idle session and send the
// fix prompt a second time (a duplicate in the reviewer's context): it must use a fresh session.
const j = lane('dupprompt', { script: ['steps:1', 'noise:1+wait:9000+noise:2', 'ok'], review: REV });
const jRev = j.prompts.filter((p) => p.agent === 'plan');
const jSid0 = jRev[0]?.sid;
const jResends = jRev.filter((p) => p.sid === jSid0 && /Previous review findings/.test(p.text));
const jrr = j.st?.reviewRounds || [];
check('a discarded reused speculative review does not resend the fix prompt to the same reviewer session',
  j.code === 0 && jResends.length === 1 && jrr.length === 2 && jrr[1].sid !== jrr[0].sid,
  `resends to ${jSid0}: ${jResends.length}; rounds ${jrr.map((x) => x.sid).join(',')}; sids ${jRev.map((p) => p.sid).join(',')}`);

for (const l of results) console.log(l);
const fails=results.filter(l=>l.startsWith('FAIL')).length;
try {fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fails?1:0);
