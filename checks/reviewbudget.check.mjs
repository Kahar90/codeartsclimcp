// Contract check for the foreground model budget: the pure predicate (runner/reviewbudget.mjs) and
// its wiring in runner/lane.mjs maybeStepReview. Unit part first, then an end-to-end lane run against
// the fake CodeArts server (checks/lib/fake-codearts.cjs) with a fake same-model peer.
//
// Proves: an OPTIONAL early step review is NOT started while another alive, unfinished, non-queued
// builder/fix holds the same shared model (and it publishes a bounded deferred reason); once the peer
// stops, the next eligible early review coalesces every unreviewed step (nothing was dropped); the
// mandatory independent final review still runs and reports ready; a lone lane keeps its step review.
// The fake peer is a registry registration plus a live sleeper pid, injected only in this test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldDeferStepReview, stepReviewBlockers } from '../runner/reviewbudget.mjs';
import { guard, settle } from './lib/exit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);

// ---------- unit: the pure predicate ----------
assert.equal(shouldDeferStepReview({model:'maas/flash',selfId:'self',lanes:[{id:'peer',alive:true,s:{phase:'build',models:{build:'maas/flash'}}}]}),true,'foreground builder on same model takes priority');
assert.equal(shouldDeferStepReview({model:'maas/flash',selfId:'self',lanes:[{id:'peer',alive:true,s:{phase:'review',models:{build:'maas/flash',review:'maas/glm'}}}]}),false,'finished builder no longer consumes build quota');
assert.equal(shouldDeferStepReview({model:'maas/flash',selfId:'self',lanes:[{id:'self',alive:true,s:{phase:'build',models:{build:'maas/flash'}}}]}),false,'single lane retains immediate step review');
assert.equal(shouldDeferStepReview({model:'maas/flash',selfId:'self',lanes:[{id:'peer',alive:true,s:{result:'done',phase:'build',models:{build:'maas/flash'}}}]}),false);
assert.equal(shouldDeferStepReview({model:'maas/flash',selfId:'self',lanes:[{id:'peer',alive:false,s:{phase:'build',models:{build:'maas/flash'}}}]}),false);
assert.equal(shouldDeferStepReview({model:'maas/glm',selfId:'self',lanes:[{id:'peer',alive:true,s:{phase:'build',models:{build:'maas/flash'}}}]}),false,'different models do not contend here');
for (const [model, build] of [['maas/deepseek-v4.1-flash', 'maas/deepseek-v4.1-flash-fast'], ['maas/deepseek-v4.1-flash-fast', 'maas/deepseek-v4.1-flash']]) {
  assert.equal(shouldDeferStepReview({ model, selfId:'self', lanes:[{ id:'peer', alive:true, s:{ phase:'build', models:{ build } } }] }), true, 'flash aliases share the same provider model quota');
}
assert.equal(shouldDeferStepReview({ model:'other/deepseek-v4.1-flash', selfId:'self', lanes:[{ id:'peer', alive:true, s:{ phase:'build', models:{ build:'maas/deepseek-v4.1-flash-fast' } } }] }), false, 'same model name on a different provider does not imply shared quota');

// realistic extra peers: queued lanes reserve nothing, fix phases do, and bad input fails closed.
check('a queued same-model peer holds no builder slot', shouldDeferStepReview({ model:'maas/flash', selfId:'self', lanes:[{ id:'peer', alive:true, s:{ phase:'build', activity:'queued: 3 builders on maas/flash', models:{ build:'maas/flash' } } }] }) === false);
check('a same-model peer in a fix phase reserves the model', shouldDeferStepReview({ model:'maas/flash', selfId:'self', lanes:[{ id:'peer', alive:true, s:{ phase:'fix', models:{ build:'maas/flash' } } }] }) === true);
check('a malformed or unreadable peer reserves nothing (fail closed)', shouldDeferStepReview({ model:'maas/flash', selfId:'self', lanes:[{ id:'peer', alive:true }, null, { id:'x', alive:true, s:null }] }) === false);
check('stepReviewBlockers names the blocking peer, model and phase', JSON.stringify(stepReviewBlockers({ model:'maas/flash', selfId:'self', lanes:[{ id:'peer', alive:true, s:{ phase:'build', models:{ build:'maas/flash' } } }] })) === JSON.stringify([{ id:'peer', model:'maas/flash', phase:'build' }]));

// ---------- end to end: a fake same-model peer defers the optional step review ----------
const STEP_MODEL = 'huaweicloud-maas/flash-budget';
const REVIEW_MODEL = 'huaweicloud-maas/glm-review';
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-reviewbudget-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const children = [];
guard({ children });
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CODEARTS_EXE: process.execPath,
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '60', THINK_S: '0', RATE_BACKOFF_S: '1', LANE_TIMEOUT: '240', NO_COMMIT_S: '0',
  BUILD_MODEL: STEP_MODEL, STEP_REVIEW_MODEL: STEP_MODEL, REVIEW_MODEL, FAKE_STEP_GAP_MS: '5000', FAKE_REVIEW_MS: '1000', STEP_REVIEW_GRACE_S: '10' };
delete env.NO_REVIEW; delete env.STEP_REVIEW;

const repo = path.join(tmp, 'main-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(['steps:1,2,3,4', 'ok']));
fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify([['STEP VERDICT', 'no bugs\nSTEP VERDICT: ok'], ['VERDICT', '1. DONE\n2. DONE\n3. DONE\n4. DONE\nVERDICT: ready']]));
fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), 'Goal: four pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\n3. Write page3.html. Commit.\n4. Write page4.html. Commit.\nCHECK: node -e 0\n');
const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');

// The fake peer: a registry entry plus a builder-phase state whose pid is a real live process, so the
// lane's lanes()/alive() see an alive, unfinished, non-queued same-model builder. No real lane runs.
const peerDir = path.join(tmp, 'peer-lane'); fs.mkdirSync(peerDir);
const peerRepo = path.join(tmp, 'peer-repo'); fs.mkdirSync(peerRepo);
const peerId = 'peer-repo--build';
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
children.push(sleeper); guard({ children: [sleeper] });
const peerState = { v: 1, id: peerId, task: 'build', repo: peerRepo, dir: peerDir, pid: sleeper.pid, startedAt: Date.now(), phase: 'build', activity: 'writing page1', busy: true, models: { build: STEP_MODEL, review: REVIEW_MODEL }, result: null };
fs.writeFileSync(path.join(peerDir, 'state.json'), JSON.stringify(peerState, null, 2));
fs.writeFileSync(path.join(reg, `${peerId}.json`), JSON.stringify({ id: peerId, dir: peerDir, repo: peerRepo, task: 'build' }, null, 2));

const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(repo, 'tasks', 'work.lane', 'state.json'), 'utf8')); } catch { return null; } };
const readJsonl = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const lane = spawn(process.execPath, [CA, 'lane', repo, 'work'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(lane); guard({ children: [lane] });
const laneDone = new Promise((res) => lane.on('close', (c) => res(c)));

// Poll the live state until the deferred marker appears (the peer still holds the quota), then let the
// peer finish and let the lane run to completion. The marker persists while deferred, so a 300ms poll
// always catches it; nothing is asserted on intermediate timing except the deferred window itself.
let deferredSeen = null, peerDoneAt = null; const t0 = Date.now();
while (lane.exitCode === null && Date.now() - t0 < 90000) {
  const st = readState();
  if (!deferredSeen && st && st.stepReviewDeferred) deferredSeen = st.stepReviewDeferred;
  if (deferredSeen && !peerDoneAt) {
    peerDoneAt = Date.now();
    fs.writeFileSync(path.join(peerDir, 'state.json'), JSON.stringify({ ...peerState, phase: 'finished', activity: 'done', result: 'done', verdict: 'ready' }, null, 2));
  }
  await sleepMs(300);
}
const code = await laneDone;
const final = readState();
const prompts = readJsonl('fake-prompts.log');
const stepPrompts = prompts.filter((p) => p.agent === 'plan' && /STEP VERDICT/.test(p.text));
const finalPrompts = prompts.filter((p) => p.agent === 'plan' && !/STEP VERDICT/.test(p.text));
const sr = (final && final.stepReviews) || [];

check('a same-model foreground builder defers the optional step review (bounded state published)', !!deferredSeen, JSON.stringify(deferredSeen));
check('the deferred state names the shared model, the holder lane and a bounded reason',
  !!deferredSeen && deferredSeen.model === STEP_MODEL && Array.isArray(deferredSeen.peers) && deferredSeen.peers.includes(peerId)
  && Array.isArray(deferredSeen.steps) && deferredSeen.steps.includes(1) && typeof deferredSeen.reason === 'string'
  && deferredSeen.reason.length > 0 && deferredSeen.reason.length <= 200, JSON.stringify(deferredSeen));
check('no optional same-model step review ran while the builder held the quota',
  peerDoneAt !== null && stepPrompts.filter((p) => p.t < peerDoneAt).length === 0, `peerDoneAt ${peerDoneAt}; ${JSON.stringify(stepPrompts.map((p) => p.t))}`);
check('after the peer stops, the next eligible early review coalesces the unreviewed step(s)',
  peerDoneAt !== null && sr.length > 0 && (sr[0].steps || []).includes(1), JSON.stringify(sr.map((x) => ({ steps: x.steps, verdict: x.verdict }))));
check('the deferred marker is cleared once the review runs', !!(final && !final.stepReviewDeferred), JSON.stringify(final && final.stepReviewDeferred));
check('the mandatory independent final review still runs and reports ready',
  code === 0 && !!final && final.result === 'done' && final.verdict === 'ready' && finalPrompts.length >= 1, `${code} ${final && final.result} ${final && final.verdict} finals ${finalPrompts.length}`);
check('single-lane behaviour is unchanged: a lone lane keeps its immediate step review',
  shouldDeferStepReview({ model: STEP_MODEL, selfId: 'main-repo--work', lanes: [{ id: 'main-repo--work', alive: true, s: { phase: 'build', models: { build: STEP_MODEL } } }] }) === false);

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { sleeper.kill(); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
await settle({ children, code: fails ? 1 : 0 });
