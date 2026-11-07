// Contract check for the Control room server side: lane acknowledgement (POST /api/lane/:id/ack
// storing the lane id and finishedAt in <registry>/acks.json), laneView.seen (reset when a lane
// finishes again), the ca status bucket order (attention, running, done, ended) and /api/overview.
// Fake lanes in a private CA_REGISTRY; never starts CodeArts (CA_DASH=0, no browser).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-overview-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0', CA_RESUME_DRY: '1', CODEARTS_EXE: path.join(tmp, 'no-codearts.exe') };
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

const repo = path.join(tmp, 'demo-repo'); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' }); // a live "supervisor" pid
const base = { commits: 0, steps: 1, stepList: [{ n: 1, text: 'a' }], commitLog: [], gates: [], steers: [], interruptions: [], permissions: [], outside: [], errors: [], activity: 'x', models: {}, config: {}, phase: 'finished', busy: false };
const stateFile = (task) => path.join(repo, 'tasks', `${task}.lane`, 'state.json');
const fake = (task, st) => {
  const dir = path.join(repo, 'tasks', `${task}.lane`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tasks', `${task}.md`), '1. a. Commit.\n');
  fs.writeFileSync(stateFile(task), JSON.stringify({ ...base, ...st }));
  fs.writeFileSync(path.join(reg, `demo-repo--${task}.json`), JSON.stringify({ id: `demo-repo--${task}`, dir, repo, task }));
};
const f1 = Date.now() - 300000, f2 = Date.now() - 600000, f3 = Date.now() - 120000;
fake('stuck', { pid: sleeper.pid, startedAt: Date.now() - 900000, lastEventAt: Date.now() - 400000, phase: 'build', busy: true, result: null });
// zero-usage worker: steps ran but the provider reported no usage (all counts 0) -> source none, never 0
fake('failed', { pid: 999999, startedAt: Date.now() - 800000, result: 'failed', reason: 'gates still failing', finishedAt: f3, tokensByModel: { 'maas/glm-5.3': { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 3 } } });
fake('run', { pid: sleeper.pid, startedAt: Date.now() - 700000, lastEventAt: Date.now() - 1000, phase: 'build', busy: true, result: null });
fake('fin1', { pid: 999999, startedAt: Date.now() - 600000, result: 'done', verdict: 'ready', finishedAt: f1 });
fake('fin2', { pid: 999999, startedAt: Date.now() - 500000, result: 'done', verdict: 'ready', finishedAt: f2 });
fake('stop1', { pid: 999999, startedAt: Date.now() - 400000, result: 'stopped', finishedAt: f3 });

// ---------- lead tokens: a registered plan, a Claude transcript, harness-reported numbers ----------
const planFile = path.join(repo, 'tasks', 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({ title: 'demo plan', lead: 'Claude', lanes: [{ task: 'failed' }] }));
const noresRepo = path.join(tmp, 'nores-repo'); fs.mkdirSync(path.join(noresRepo, 'tasks'), { recursive: true });
fs.writeFileSync(path.join(noresRepo, 'tasks', 'plan.json'), JSON.stringify({ title: 'no lead data', lead: 'Kiro', lanes: [{ task: 'gone' }] }));
const sess = path.join(tmp, 'lead.jsonl');
const at = new Date().toISOString();
const tline = (o) => JSON.stringify({ ...o, timestamp: at });
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
fs.writeFileSync(sess, [
  tline({ message: { id: 'm1', role: 'assistant', model: 'claude-x', usage: usage(100, 15, 4000, 2) } }),
  tline({ message: { id: 'm1', role: 'assistant', model: 'claude-x', usage: usage(100, 15, 4000, 2) } }), // same message id: counted once
  tline({ message: { id: 'm2', role: 'user', content: 'hi' } }), // not an assistant turn: ignored
  tline({ message: { id: 'm3', role: 'assistant', model: 'claude-y', usage: usage(200, 20, 0, 0) } }),
].join('\n') + '\n');
let pr = ca(['plan', planFile]);
check('ca plan registers the demo plan', pr.code === 0 && /registered/.test(pr.out), pr.out.trim().slice(0, 120));
pr = ca(['plan', path.join(noresRepo, 'tasks', 'plan.json')]);
check('ca plan registers the plan with no lead data', pr.code === 0 && /registered/.test(pr.out), pr.out.trim().slice(0, 120));

// ---------- ca status: BUCKET column and the attention-first order ----------
let r = ca(['status', '--json']); let st = []; try { st = JSON.parse(r.out); } catch {}
const rank = { attention: 0, running: 1, done: 2, ended: 3 };
const order = st.map((x) => x.bucket);
check('status --json rows carry a bucket', st.length === 6 && order.every((b) => b in rank), JSON.stringify(order));
check('status sorts attention, running, done, ended', order.every((b, i) => i === 0 || rank[order[i - 1]] <= rank[b]), JSON.stringify(order));
check('status puts the stuck and failed lanes first', order.slice(0, 2).every((b) => b === 'attention'), JSON.stringify(order));
r = ca(['status']); check('status table has a BUCKET column right after LANE', /LANE\s+BUCKET/.test(r.out), r.out.split('\n')[0]);

// ---------- ca lead-tokens: transcript totals, then harness-reported numbers ----------
let lt = {}; try { lt = JSON.parse(ca(['lead-tokens', '--plan', 'demo-repo', '--session', sess, '--json']).out); } catch {}
const bx = lt.tokensByModel?.['claude-x'], by = lt.tokensByModel?.['claude-y'];
check('lead-tokens counts a duplicate message id once', !!bx && bx.steps === 1 && bx.input === 100 && bx.output === 15, JSON.stringify(bx));
check('lead-tokens sums input/output/cache per model', !!bx && bx.total === 4117 && !!by && by.total === 220, JSON.stringify(lt.tokensByModel));
check('lead-tokens ignores non-assistant transcript lines', Object.keys(lt.tokensByModel || {}).length === 2, JSON.stringify(Object.keys(lt.tokensByModel || {})));
let set1 = {}; try { set1 = JSON.parse(ca(['lead-tokens', '--plan', 'demo-repo', '--set', 'claude-z', '--input', '50', '--output', '5', '--cache-read', '2', '--json']).out); } catch {}
check('lead-tokens --set writes reported numbers (total includes cacheWrite)', set1.input === 50 && set1.output === 5 && set1.cacheRead === 2 && set1.total === 57, JSON.stringify(set1));
let set2 = {}; try { set2 = JSON.parse(ca(['lead-tokens', '--plan', 'demo-repo', '--set', 'claude-z', '--input', '10', '--output', '5', '--cache-write', '3', '--add', '--json']).out); } catch {}
check('lead-tokens --add accumulates onto the existing entry', set2.input === 60 && set2.output === 10 && set2.cacheRead === 2 && set2.cacheWrite === 3 && set2.total === 75, JSON.stringify(set2));
let set3 = {}; try { set3 = JSON.parse(ca(['lead-tokens', '--plan', 'demo-repo', '--set', 'claude-z', '--input', '1', '--output', '1', '--json']).out); } catch {}
check('lead-tokens --set without --add replaces the entry', set3.input === 1 && set3.output === 1 && set3.total === 2, JSON.stringify(set3));

// ---------- dashboard: ack round trip, seen reset, /api/overview ----------
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dash = spawn(process.execPath, [CA, 'dash', String(port)], { stdio: 'ignore', env });
const url = `http://127.0.0.1:${port}`;
const post = async (id, what, body, json = true) => { const res = await fetch(`${url}/api/lane/${encodeURIComponent(id)}/${what}`, { method: 'POST', headers: { 'content-type': json ? 'application/json' : 'text/plain' }, body: JSON.stringify(body || {}) }); let j = {}; try { j = await res.json(); } catch {} return { status: res.status, j }; };
const lane = async (t) => { const ls = await (await fetch(url + '/api/lanes')).json(); return (ls || []).find((x) => x.task === t) || {}; };
try {
  let up = false; for (let i = 0; i < 40 && !up; i++) { await new Promise((x) => setTimeout(x, 250)); try { up = (await fetch(url + '/api/lanes')).ok; } catch {} }
  check('ca dash starts', up);

  const ov = await (await fetch(url + '/api/overview')).json();
  check('/api/overview counts the buckets', ov && ov.counts && ov.counts.attention === 2 && ov.counts.running === 1 && ov.counts.done === 2 && ov.counts.ended === 1, JSON.stringify(ov && ov.counts));
  check('/api/overview lanes carry bucketWhy and project', Array.isArray(ov?.lanes) && ov.lanes.length === 6 && ov.lanes.every((x) => x.bucket && typeof x.bucketWhy === 'string' && x.project && x.project.key), JSON.stringify((ov?.lanes || []).map((x) => [x.task, x.bucket])));

  const wl = await lane('failed');
  check('a worker lane with provider-zero usage is source:none, not 0', wl.tokensByModel?.['maas/glm-5.3']?.source === 'none' && wl.tokensByModel['maas/glm-5.3'].total === 0, JSON.stringify(wl.tokensByModel));
  const pls = await (await fetch(url + '/api/plans')).json();
  const nl = (pls || []).find((p) => p.id === 'nores-repo');
  const leadRow = nl && Object.values(nl.tokensByModel || {}).find((e) => e.who === 'lead');
  check('/api/plans lists a source:none lead row when the plan has no lead data', !!leadRow && leadRow.source === 'none' && leadRow.total === null, JSON.stringify(nl && nl.tokensByModel));
  check('a plan with no lead data has tokens.complete false', !!nl && nl.tokens && nl.tokens.complete === false, JSON.stringify(nl && nl.tokens));

  const seen0 = (await lane('fin1')).seen;
  check('a finished lane starts unseen', seen0 === false, String(seen0));

  let x = await post('demo-repo--fin1', 'ack', { seen: true });
  check('POST ack needs JSON content-type (415)', (await post('demo-repo--fin1', 'ack', { seen: true }, false)).status === 415, 'no json -> 415');
  check('ack answers ok with seen true', x.status === 200 && x.j.ok && x.j.seen === true, JSON.stringify(x.j));
  check('acks.json stores the lane id and its finishedAt', (() => { try { const a = JSON.parse(fs.readFileSync(path.join(reg, 'acks.json'), 'utf8')); return a['demo-repo--fin1'] === f1; } catch { return false; } })(), '');
  check('the acked lane reads as seen', (await lane('fin1')).seen === true, String((await lane('fin1')).seen));
  check('an unacked finished lane stays unseen', (await lane('fin2')).seen === false, String((await lane('fin2')).seen));

  // the lane finishes again: a new finishedAt makes it unseen even though acks.json still holds the old one
  const st1 = JSON.parse(fs.readFileSync(stateFile('fin1'), 'utf8'));
  st1.finishedAt = f1 + 50000; fs.writeFileSync(stateFile('fin1'), JSON.stringify(st1));
  check('a new finishedAt resets seen to false', (await lane('fin1')).seen === false, String((await lane('fin1')).seen));

  x = await post('demo-repo--fin1', 'ack', { seen: false });
  check('ack seen false clears the entry', x.status === 200 && x.j.seen === false && (await lane('fin1')).seen === false, JSON.stringify(x.j));
  x = await post('demo-repo--nope', 'ack', { seen: true });
  check('ack on an unknown lane is 404', x.status === 404, String(x.status));
} catch (e) { check('the dashboard section ran to the end', false, String((e && e.message) || e)); } finally { dash.kill(); sleeper.kill(); }

console.log(results.join('\n'));
const bad = results.filter((x) => x.startsWith('FAIL')).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
