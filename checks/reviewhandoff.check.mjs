// Contract check for the final-review handoff (runner/lane.mjs). A speculative final review runs in its
// own dedicated poller while the builder wraps up. Before this change that poller owned the reviewer
// session to the end: a `ca steer` written during the review phase sat in the inbox until the review
// finished (or its budget ran out), because no normal driver pumped it. Now, as soon as the builder and
// the CHECK gates are done and the final review is awaited, the dedicated poller stops WITHOUT aborting
// its live model turn and the normal review driver adopts the SAME session (same model/session, prompts,
// freshness and exact-HEAD acceptance, reachable by steering/stop/kick/watchdogs/auth/retry). An
// already-completed reply is accepted in place; no new session and no replayed prompt.
// End to end against the fake CodeArts server (checks/lib/fake-codearts.cjs); no real CodeArts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const FAKE = path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-reviewhandoff-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const base = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath, STEP_REVIEW: '0', NO_REVIEW: '0',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', LANE_TIMEOUT: '300' };
delete base.REVIEW_FIXES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A lane fixture: a git repo with one numbered brief step and a CHECK, a copy of the fake server and a
// per-fixture build script/review table (never the shared fake). Injected per fixture, by design.
function mkRepo(name, { script, review, env = {} }) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(FAKE, path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  if (review) fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), 'Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return { repo, env: { ...base, ...env }, id: `${name}--work` };
}
const read = (repo, f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
const jsonl = (repo, f) => read(repo, f).trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const stateOf = (repo) => { try { return JSON.parse(read(repo, 'tasks/work.lane/state.json')); } catch { return null; } };
const ca = (f, args) => spawnSync(process.execPath, [CA, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 60000 });
const waitUntil = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
const planPrompts = (repo) => jsonl(repo, 'fake-prompts.log').filter((p) => p.agent === 'plan');
const planAborts = (repo) => jsonl(repo, 'fake-aborts.log').filter((a) => a.agent === 'plan');
// A blocking run: the lane runs to its own end. Used for the acceptance cases.
function blocking(name, opts) {
  const f = mkRepo(name, opts);
  const r = spawnSync(process.execPath, [CA, 'lane', f.repo, 'work'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 200000 });
  const st = stateOf(f.repo);
  return { ...f, code: r.status ?? -1, st, rounds: st?.reviewRounds || [], prompts: planPrompts(f.repo), aborts: planAborts(f.repo), review: read(f.repo, 'tasks/work.lane/review.md') };
}
// A detached run: wait for the final-review phase, run one control action, then wait for the lane to end.
async function detached(name, opts, act) {
  const f = mkRepo(name, opts);
  ca(f, ['lane', f.repo, 'work', '--detach']);
  const inReview = await waitUntil(() => stateOf(f.repo)?.phase === 'review', 90000);
  const specUsedAtReview = stateOf(f.repo)?.specReview?.used === true;
  const t = await act(f);
  const done = await waitUntil(() => !!stateOf(f.repo)?.result, 90000);
  await sleep(400);
  const st = stateOf(f.repo);
  ca(f, ['stop', f.id]); // idempotent: a settled lane just gets the summary it already has
  await sleep(1500);
  return { ...f, inReview, specUsedAtReview, done, t, st, prompts: planPrompts(f.repo), aborts: planAborts(f.repo) };
}
const REV_STALE = [
  ['Previous review findings', '1. DONE: stale cached path\nVERDICT: ready', { stale: true }],
  ['VERDICT', '1. DONE\nBugs:\n- page1.html:1 says thing 1, the spec wants thing one\nVERDICT: needs fixes'],
];
try {
  // A: the review is still running (30 s) when the final review is awaited. A lead note written during the
  // review phase must reach the active reviewer within seconds, not when the review ends.
  const A = mkRepo('steer', { script: ['commit:1+wait:9000+ok'], env: { FAKE_REVIEW_MS: '30000' } });
  ca(A, ['lane', A.repo, 'work', '--detach']);
  const aInReview = await waitUntil(() => stateOf(A.repo)?.phase === 'review', 90000);
  const aUsed = stateOf(A.repo)?.specReview?.used === true;
  const tSteer = Date.now();
  ca(A, ['steer', A.id, 'leadreviewhandoffnote']);
  const aGot = await waitUntil(() => planPrompts(A.repo).some((p) => /leadreviewhandoffnote/.test(p.text)), 6000);
  const aMs = Date.now() - tSteer;
  const aPlans = planPrompts(A.repo);
  ca(A, ['stop', A.id]); await sleep(1500);
  check('overlap: lead note reaches the active review session within 6 s (no wait for the 30 s reply)', aGot && aMs < 6000, `inReview ${aInReview} ms ${aMs}`);
  check('overlap: the final review is the adopted speculative session (S.specReview.used)', aUsed, JSON.stringify(stateOf(A.repo)?.specReview));
  check('overlap: the note went to the SAME session as the final review (no second reviewer, no replay)', aPlans.length === 2 && aPlans[1].sid === aPlans[0].sid, aPlans.map((p) => `${p.sid}:${p.text.slice(0, 40)}`).join(' || '));

  // B: the normal case. Handoff adopts the live session, which then finishes. Exactly one final-review
  // prompt must exist: the adoption must NOT resend the initial prompt or start a second reviewer.
  const B = blocking('samesession', { script: ['commit:1+wait:8000+ok'], env: { FAKE_REVIEW_MS: '3000' } });
  check('same-session: lane ends DONE ready with the adopted speculative review', B.code === 0 && B.st?.result === 'done' && B.st?.verdict === 'ready' && B.st?.specReview?.used === true, `${B.code} ${B.st?.result} ${B.st?.verdict}`);
  check('same-session: exactly one plan prompt (no duplicate initial prompt)', B.prompts.length === 1, `${B.prompts.length}`);
  check('same-session: no review restart (no plan abort) and one review round', B.aborts.length === 0 && B.rounds.length === 1, `aborts ${B.aborts.length} rounds ${B.rounds.length}`);
  check('same-session: the recorded round is that same reviewer session', B.rounds[0]?.sid === B.prompts[0]?.sid, `${B.rounds[0]?.sid} ${B.prompts[0]?.sid}`);

  // E: the speculative reply is already complete when the final review is awaited (short reply, long
  // builder wrap-up). It must be accepted in place: no restart, no second prompt, no abort.
  const E = blocking('completed', { script: ['commit:1+wait:12000+ok'], env: { FAKE_REVIEW_MS: '1500' } });
  check('already-completed: lane ends DONE ready', E.code === 0 && E.st?.result === 'done' && E.st?.verdict === 'ready', `${E.code} ${E.st?.result} ${E.st?.verdict}`);
  check('already-completed: the finished reply is adopted in place (one prompt, no abort, one round)', E.prompts.length === 1 && E.aborts.length === 0 && E.rounds.length === 1, `plans ${E.prompts.length} aborts ${E.aborts.length} rounds ${E.rounds.length}`);

  // G: the review is still running (delayed reply) when the final review is awaited. The driver must adopt
  // the SAME session, keep waiting for the late reply and accept it (never a no-start / second session).
  const G = blocking('delayed', { script: ['commit:1+wait:7000+ok'], env: { FAKE_REVIEW_MS: '9000' } });
  check('delayed: lane ends DONE ready while the review is still running at adoption', G.code === 0 && G.st?.result === 'done' && G.st?.verdict === 'ready' && G.st?.specReview?.used === true, `${G.code} ${G.st?.result} ${G.st?.verdict}`);
  check('delayed: one prompt, no restart, no no-start failure', G.prompts.length === 1 && G.aborts.length === 0 && G.rounds.length === 1, `plans ${G.prompts.length} aborts ${G.aborts.length} rounds ${G.rounds.length}`);

  // C: a stop while the final review is pending must end the lane as stopped promptly (not wait out the
  // 30 s review) and must never record a false "ready".
  const C = await detached('stop', { script: ['commit:1+wait:7000+ok'], env: { FAKE_REVIEW_MS: '30000' } }, async (f) => { const t = Date.now(); ca(f, ['stop', f.id]); return t; });
  const cMs = (stateOf(C.repo)?.finishedAt || 0) - (C.t || 0);
  check('quick stop: the lane ends stopped promptly, without waiting out the 30 s review', C.done && C.inReview && C.st?.result === 'stopped' && C.st?.verdict !== 'ready' && cMs < 20000, `done ${C.done} ${C.st?.result} ${C.st?.verdict} ${cMs}ms`);
  check('quick stop: the adopted reviewer session was aborted (the live turn was stopped)', C.aborts.length >= 1, `${C.aborts.length}`);

  // D: a kick (mode turn) while the final review is pending must reach the SAME reviewer session and the
  // lane must still finish ready.
  const D = await detached('kick', { script: ['commit:1+wait:9000+ok'], env: { FAKE_REVIEW_MS: '8000' } }, async (f) => { const t = Date.now(); ca(f, ['kick', f.id, 'reviewkicknote']); return t; });
  check('quick kick: honored while the final review is pending and the lane still ends ready', D.done && D.inReview && D.st?.result === 'done' && D.st?.verdict === 'ready', `done ${D.done} ${D.st?.result} ${D.st?.verdict}`);
  check('quick kick: the lead message reached the SAME reviewer session, not a new one', D.prompts.length === 2 && D.prompts[1].sid === D.prompts[0].sid && /reviewkicknote/.test(D.prompts[1].text), D.prompts.map((p) => `${p.sid}:${p.text.slice(0, 50)}`).join(' || '));
  check('quick kick: the pending review turn was aborted first', D.aborts.length >= 1, `${D.aborts.length}`);

  // F: a review fix round reuses the healthy reviewer session, whose speculative re-review replies with
  // its OLD cached message id (a stale verdict). The handoff must never accept that stale reply: the lane
  // falls back to a fresh session whose verdict is a genuinely new turn.
  const F = blocking('stale', { script: ['steps:1', 'noise:1+wait:12000', 'ok'], review: REV_STALE, env: { FAKE_REVIEW_MS: '1000' } });
  check('stale: lane ends DONE ready after the review fix round', F.code === 0 && F.st?.result === 'done' && F.st?.verdict === 'ready', `${F.code} ${F.st?.result} ${F.st?.verdict}`);
  check('stale: the fix round reused the healthy session, then fell back to a fresh one', F.prompts.length === 3 && F.prompts[1].sid === F.prompts[0].sid && F.prompts[2].sid !== F.prompts[1].sid, F.prompts.map((p) => p.sid).join(','));
  check('stale: the stale cached verdict was never accepted (the recorded round is the fresh session)', F.rounds.length === 2 && F.rounds[1].sid !== F.rounds[0].sid && F.rounds[1].sid === F.prompts[2]?.sid, JSON.stringify(F.rounds.map((x) => ({ sid: x.sid, v: x.verdict }))));

  for (const l of results) console.log(l);
  const fails = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
