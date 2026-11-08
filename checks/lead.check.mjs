// Contract check for the lead plan surface (fake lanes, never starts CodeArts): ca_note phases and
// bounded activity, ca plan update validation and preservation, the ca_plan_update MCP tool over real
// stdio, ambiguous/missing/closed/removed plans, legacy plans with no timestamps, and concurrent writes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lead-'));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg, { recursive: true });
const env = { ...process.env, CA_REGISTRY: reg, CA_DASH: '0' };
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const ca = (args) => { const r = spawnSync(process.execPath, [CA, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: ROOT }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };

const repos = {};
const mkPlan = (name, plan) => {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  const file = path.join(repo, 'tasks', 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  repos[name] = { repo, file };
  return file;
};
const readPlan = (name) => JSON.parse(fs.readFileSync(repos[name].file, 'utf8'));

// sbx: the main plan for note/update behavior.
mkPlan('sbx', { title: 'Sbx plan', goal: 'G0', status: 'running', waves: [{ name: 'W', lanes: ['lib'] }], lanes: [{ task: 'lib' }] });
check('ca plan registers', ca(['plan', repos.sbx.file]).code === 0);

// ca_note: old forms still work, --phase/--now record phase, timestamp and bounded activity.
let r = ca(['note', '--now', '--phase', 'building', 'building wave 1']);
check('ca note --now --phase exits 0', r.code === 0, r.out + r.err);
let p = readPlan('sbx');
check('now line and phase recorded', p.now === 'building wave 1' && p.phase === 'building', JSON.stringify({ now: p.now, phase: p.phase }));
check('now is timestamped', typeof p.nowAt === 'string' && Number.isFinite(Date.parse(p.nowAt)), String(p.nowAt));
check('activity history has the entry', Array.isArray(p.leadActivity) && p.leadActivity.at(-1).text === 'building wave 1' && p.leadActivity.at(-1).phase === 'building', JSON.stringify(p.leadActivity));
r = ca(['note', 'a decision']);
p = readPlan('sbx');
check('plain ca note still appends a decision', r.code === 0 && (p.decisions || []).at(-1).text === 'a decision', JSON.stringify((p.decisions || []).slice(-1)));
check('plain ca note leaves the now line alone', p.now === 'building wave 1');
r = ca(['note', '--now', 'legacy now line']);
p = readPlan('sbx');
check('ca note --now (old form) sets the now line', r.code === 0 && p.now === 'legacy now line');
r = ca(['note', '--phase', 'nope', 'x']); check('unknown phase is refused', r.code !== 0 && /phase/.test(r.err), r.out + r.err);

// ca plan update: validated partial updates with revision and timestamp.
r = ca(['plan', 'update', 'sbx', '--patch', '{"goal":"G1","next":["a","b"]}']);
check('ca plan update exits 0', r.code === 0, r.out + r.err);
p = readPlan('sbx');
check('patch applies goal and next', p.goal === 'G1' && Array.isArray(p.next) && p.next.join() === 'a,b', JSON.stringify({ goal: p.goal, next: p.next }));
check('revision and updatedAt are set', p.revision === 1 && typeof p.updatedAt === 'string' && Number.isFinite(Date.parse(p.updatedAt)), JSON.stringify({ revision: p.revision, updatedAt: p.updatedAt }));
check('unrelated fields survive the patch', (p.decisions || []).some((d) => d.text === 'a decision') && Array.isArray(p.leadActivity) && p.waves.length === 1 && p.lanes.length === 1, JSON.stringify({ decisions: p.decisions.length, waves: p.waves.length }));

r = ca(['plan', 'update', 'sbx', '--patch', '{"bogus":1}']);
check('unknown patch field is refused with a hint', r.code !== 0 && /bogus/.test(r.err), r.out + r.err);
r = ca(['plan', 'update', 'sbx', '--patch', '{"title":123}']);
check('wrong patch type is refused', r.code !== 0 && /title/.test(r.err), r.out + r.err);
r = ca(['plan', 'update', 'sbx', '--patch', 'not json']);
check('non-JSON patch is refused', r.code !== 0, r.out + r.err);
r = ca(['plan', 'update', '--patch', '{"title":"x"}']);
check('missing plan id is a usage error', r.code === 2, r.out + r.err);
r = ca(['plan', 'update', 'nope', '--patch', '{"title":"x"}']);
check('unknown plan id is refused (never another project)', r.code === 2 && /no registered plan/.test(r.err), r.out + r.err);

// waves/lanes entries are shape-checked: a malformed entry must be refused (it would crash the views).
r = ca(['plan', 'update', 'sbx', '--patch', '{"waves":[{"lanes":["x"]}]}']);
check('wave entry without a name is refused', r.code !== 0 && /waves/.test(r.err), r.out + r.err);
r = ca(['plan', 'update', 'sbx', '--patch', '{"waves":["w"]}']);
check('non-object wave entry is refused', r.code !== 0 && /waves/.test(r.err), r.out + r.err);
r = ca(['plan', 'update', 'sbx', '--patch', '{"lanes":[{"repo":"."}]}']);
check('lane entry without a task is refused', r.code !== 0 && /lanes/.test(r.err), r.out + r.err);
mkPlan('wp', { title: 'Waves plan', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.wp.file]);
r = ca(['plan', 'update', 'wp', '--patch', '{"waves":[{"name":"W2","lanes":["a"]}]}']);
check('a well-formed waves patch is accepted', r.code === 0, r.out + r.err);

// ambiguous id: two plans with a shared prefix.
mkPlan('alpha', { title: 'Alpha', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
mkPlan('alpine', { title: 'Alpine', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.alpha.file]); ca(['plan', repos.alpine.file]);
r = ca(['plan', 'update', 'alp', '--patch', '{"title":"x"}']);
check('ambiguous plan id is refused, not guessed', r.code === 2 && /ambiguous/.test(r.err), r.out + r.err);

// closed and removed plans are never targeted.
mkPlan('closedp', { title: 'Closed', status: 'running', waves: [{ name: 'W', lanes: ['lib'] }], lanes: [{ task: 'lib' }] });
ca(['plan', repos.closedp.file]);
ca(['plan', 'close', 'closedp', '--reason', 'done']);
r = ca(['plan', 'update', 'closedp', '--patch', '{"title":"x"}']);
check('closed plan is refused', r.code !== 0 && /closed/.test(r.err), r.out + r.err);
mkPlan('removedp', { title: 'Removed', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.removedp.file]);
ca(['plan', 'rm', 'removedp', '--keep-lanes']);
r = ca(['plan', 'update', 'removedp', '--patch', '{"title":"x"}']);
check('removed plan is refused', r.code === 2, r.out + r.err);

// ca_note resolves ids safely: ambiguous ids are refused, closed plans are refused, a bare --plan is usage.
r = ca(['note', '--plan', 'alp', 'x']);
check('ambiguous note plan id is refused', r.code === 2 && /ambiguous/.test(r.err), r.out + r.err);
r = ca(['note', '--plan', 'closedp', 'x']);
check('note on a closed plan is refused', r.code !== 0 && /closed/.test(r.err), r.out + r.err);
r = ca(['note', '--plan']);
check('note with a missing --plan value is a usage error', r.code === 2, r.out + r.err);
r = ca(['note', '--plan', 'sbx', '--now', 'legacy via plan']);
check('note with an explicit --plan still works', r.code === 0, r.out + r.err);

r = ca(['note', '--plan', 'sbx', '--phase', 'building', 'phase transition']);
p = readPlan('sbx');
check('phase-only transition refreshes activity and timestamp', r.code === 0 && p.leadActivity.at(-1).text === 'phase transition' && p.nowAt === p.leadActivity.at(-1).at, JSON.stringify(p.leadActivity.at(-1)));
r = ca(['plan', 'update', 'sbx', '--patch', '{"toString":1}']);
check('inherited object names are refused as unknown patch fields', r.code !== 0 && /unknown patch field/.test(r.err), r.out + r.err);

// legacy plan with no timestamps: planView reports nothing rather than a false age.
mkPlan('legacy', { title: 'Legacy', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.legacy.file]);
let list = []; try { list = JSON.parse(ca(['plan', 'list', '--json']).out || '[]'); } catch { list = []; }
const leg = list.find((x) => x.id === 'legacy');
check('legacy plan reports no lead timestamp and no age', leg && leg.lead && leg.lead.updatedAt === null && leg.lead.age === null, JSON.stringify(leg && leg.lead));
const sbxV = list.find((x) => x.id === 'sbx');
check('planView exposes lead phase, revision, activity and freshness', sbxV && sbxV.lead && sbxV.lead.phase === 'building' && sbxV.lead.revision === 1 && Array.isArray(sbxV.lead.activity) && sbxV.lead.activity.length >= 1 && typeof sbxV.lead.age === 'number', JSON.stringify(sbxV && sbxV.lead));

// bounded activity: many notes cannot grow the history without end (target sbx explicitly, since a
// bare ca note defaults to the newest registered plan).
for (let i = 0; i < 25; i++) ca(['note', '--now', '--plan', 'sbx', `tick ${i}`]);
p = readPlan('sbx');
check('activity history is bounded', Array.isArray(p.leadActivity) && p.leadActivity.length <= 20 && p.leadActivity.at(-1).text === 'tick 24', `len ${p.leadActivity && p.leadActivity.length}`);

// concurrent writes to different fields: the lock keeps both and counts both revisions.
mkPlan('conc', { title: 'Conc', status: 'running', waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.conc.file]);
const run = (args) => new Promise((res) => { const c = spawn(process.execPath, [CA, ...args], { env, cwd: ROOT, stdio: 'ignore' }); c.on('close', (code) => res(code)); });
await Promise.all([
  run(['plan', 'update', 'conc', '--patch', '{"title":"T-conc"}']),
  run(['plan', 'update', 'conc', '--patch', '{"risks":["r-conc"]}']),
]);
p = readPlan('conc');
check('concurrent updates keep both fields', p.title === 'T-conc' && Array.isArray(p.risks) && p.risks[0] === 'r-conc', JSON.stringify({ title: p.title, risks: p.risks }));
check('concurrent updates both count (revision 2)', p.revision === 2, String(p.revision));

// a --now note refreshes lead freshness even when updatedAt (an update) is old: age comes from the newer of
// updatedAt and nowAt, so a long-idle plan that just moved reads fresh, not stale.
mkPlan('freshp', { title: 'Fresh plan', status: 'running', updatedAt: new Date(Date.now() - 864e5).toISOString(), waves: [{ name: 'W', lanes: [] }], lanes: [] });
ca(['plan', repos.freshp.file]);
ca(['note', '--now', '--plan', 'freshp', 'just moved']);
list = JSON.parse(ca(['plan', 'list', '--json']).out || '[]');
const freshV = list.find((x) => x.id === 'freshp');
check('a --now note refreshes lead freshness past an old updatedAt', !!freshV && freshV.lead.age !== null && freshV.lead.age < 60000, JSON.stringify(freshV && freshV.lead));

// ---------- MCP stdio: the ca_plan_update tool and ca_note phases ----------
const srv = spawn(process.execPath, [CA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map();
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
let errText = ''; srv.stderr.on('data', (d) => { errText += d; });
let nid = 0;
const rpc = (method, params, ms = 30000) => new Promise((res) => { const id = ++nid; const to = setTimeout(() => { waiters.delete(id); res({ timeout: true }); }, ms); waiters.set(id, (m) => { clearTimeout(to); res(m); }); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = (name, args = {}, ms) => rpc('tools/call', { name, arguments: args }, ms);
const text = (m) => (m.result?.content || []).map((c) => c.text || '').join('\n');
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  let m = await rpc('tools/list', {});
  check('MCP exposes ca_plan_update', (m.result?.tools || []).some((t) => t.name === 'ca_plan_update'), (m.result?.tools || []).map((t) => t.name).join(','));
  m = await call('ca_note', { text: 'via mcp', now: true, plan: 'sbx', phase: 'verifying' });
  p = readPlan('sbx');
  check('MCP ca_note sets now, phase and plan', !m.result?.isError && p.now === 'via mcp' && p.phase === 'verifying', text(m).slice(0, 120) + ' ' + JSON.stringify({ now: p.now, phase: p.phase }));
  m = await call('ca_plan_update', { id: 'sbx', patch: { next: ['x'] } });
  p = readPlan('sbx');
  check('MCP ca_plan_update applies a valid patch', !m.result?.isError && (p.next || []).join() === 'x' && p.revision === 2, text(m).slice(0, 160));
  m = await call('ca_plan_update', { id: 'sbx', patch: { bogus: 1 } });
  check('MCP ca_plan_update refuses an unknown field', m.result?.isError === true && /bogus/.test(text(m)), text(m).slice(0, 160));
  m = await call('ca_plan_update', { id: 'alp', patch: { title: 'x' } });
  check('MCP ca_plan_update refuses an ambiguous id', m.result?.isError === true && /ambiguous/.test(text(m)), text(m).slice(0, 160));
  m = await call('ca_plan_update', { id: 'closedp', patch: { title: 'x' } });
  check('MCP ca_plan_update refuses a closed plan', m.result?.isError === true && /closed/.test(text(m)), text(m).slice(0, 160));
  m = await call('ca_plan_update', { patch: { title: 'x' } });
  check('MCP ca_plan_update needs an id', m.result?.isError === true, text(m).slice(0, 120));
} catch (e) { check('MCP block ran', false, String(e && e.stack || e)); }
srv.stdin.end(); await new Promise((r) => setTimeout(r, 600)); try { srv.kill(); } catch {}
check('MCP server produced no crash log', !/unhandled|Error:/.test(errText), errText.slice(0, 160));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
