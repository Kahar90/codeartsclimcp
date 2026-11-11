import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLANS, REG, die, ensureDash, fmtDur, laneAlive, laneId, laneIndex, laneSeen, lanes, now, oneLine, pickOne, planClosed, plans, projectOf, readJSON, readJSONCached, resultOf, stepProgress, writeAtomic } from './common.mjs';
import { GLYPHS, laneActions } from './controls.mjs';
import { bucketFor, kindOf, laneHealthOf, laneRow, laneStatusOf, modelRow, removePlan, sumTok, tokTotal, tokensByModelView, tokensByView } from './commands.mjs';
import { sumTokens, withTotal } from './tokens.mjs';

// ---------- the lead's plan (written by Claude, shown on the dashboard) ----------
// <repo>/tasks/plan.json: { title, goal, lead, status, now, waves:[{name, lanes:[task], note}],
//   lanes:[{task, repo?, model?, why?, files?}], next:[text | {text, done}], decisions:[{at, text}], risks:[text] }
// Lane repo paths are relative to the plan's repo (the folder that holds tasks/).
export const planId = (file) => path.basename(path.dirname(path.dirname(path.resolve(file)))).replace(/[^\w.-]+/g, '_');

// A lane is in a plan when a lane entry has the same task and its repo resolves to the lane's repo.
export const planListsLane = (plan, main, repo, task) => !!(plan && (plan.lanes || []).some((l) => l && l.task === task && path.resolve(main, l.repo || '.') === path.resolve(repo)));

// Register a plan file under <REG>/plans/<planId>.json (what `ca plan <file>` writes; idempotent).
export function registerPlan(file) {
  const f = path.resolve(file); const id = planId(f);
  fs.mkdirSync(PLANS, { recursive: true });
  fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ id, file: f }, null, 2));
  return id;
}

// The title/goal a runner-created plan takes from the brief: after "Goal:" up to the first period,
// else the brief's first sentence, else "Lane <task>".
export function planGoal(text, task) {
  const s = String(text || '');
  const gi = s.search(/Goal:/i);
  if (gi >= 0) {
    let rest = s.slice(gi + 'Goal:'.length).replace(/\s+/g, ' ').trim();
    const dot = rest.indexOf('.');
    if (dot >= 0) rest = rest.slice(0, dot).trim();
    if (rest) return rest;
  }
  const first = s.replace(/\s+/g, ' ').trim();
  const dot = first.indexOf('.');
  if (dot > 0) return oneLine(first.slice(0, dot), 120);
  return first ? oneLine(first, 120) : `Lane ${task}`;
}

// The plan file is shared: two lanes starting at once must not lose each other's edit. The lock is a
// `wx` create at <planFile>.lock; a 5 s retry window, removed in finally even when fn throws.
export function withPlanLock(planFile, fn) {
  const lock = `${planFile}.lock`; fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd = null; const t0 = now();
  // A plan edit takes milliseconds: wait up to 30 s, take over a lock older than 20 s (a crashed holder),
  // and never edit without the lock, so two lanes starting together cannot lose each other's lane.
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = now() - fs.statSync(lock).mtimeMs; } catch {}
      if (age > 20000) { try { fs.rmSync(lock, { force: true }); } catch {} continue; }
      if (now() - t0 > 30000) throw new Error(`plan file is locked by another lane (${lock})`);
      const t = now() + 50; while (now() < t);
    }
  }
  try { return fn(); }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(lock, { force: true }); } catch {} } }
}

export const planStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

// Bind a lane `ca lane` is starting to its repo's plan. CA_NO_PLAN=1 (smoke lanes) is left alone.
// A plan the lead wrote is only ever appended to; a lane already listed is not added twice.
export function ensurePlan(repo, task, briefText) {
  if (process.env.CA_NO_PLAN === '1') return null;
  // A lane already listed in another registered OPEN plan (a lead plan for the same work, perhaps in
  // a separate clone) must not create or register a second plan: dedup by the same id resolution
  // planView and noteResume use, and leave the local tasks/plan.json untouched.
  const owner = openPlanFor(repo, task);
  if (owner) return owner.file;
  const main = projectOf(repo).key;
  const planFile = path.join(main, 'tasks', 'plan.json');
  const rel = (path.relative(main, repo) || '.').split(path.sep).join('/') || '.';
  const goal = planGoal(briefText, task);
  // A file that exists but cannot be parsed is left untouched (never overwritten): warn, do not stop the lane.
  const raw = fs.existsSync(planFile) ? readJSON(planFile) : undefined;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error(`tasks/plan.json is not a JSON object; fix it (the lane runs, but is not in a plan)`);
  const existing = readJSON(planFile);
  if (existing && !planClosed(existing) && planListsLane(existing, main, repo, task)) { registerPlan(planFile); return planFile; }
  return withPlanLock(planFile, () => {
    const cur = readJSON(planFile);
    if (cur && !planClosed(cur)) {
      if (!planListsLane(cur, main, repo, task)) {
        cur.lanes = Array.isArray(cur.lanes) ? cur.lanes : [];
        cur.lanes.push({ task, repo: rel, why: goal, added: 'runner' });
        let waves = Array.isArray(cur.waves) ? cur.waves : [];
        let wave = waves.find((w) => w && w.name === 'Added while running');
        if (!wave) { wave = { name: 'Added while running', lanes: [] }; waves.push(wave); }
        wave.lanes = Array.isArray(wave.lanes) ? wave.lanes : [];
        if (!wave.lanes.includes(task)) wave.lanes.push(task);
        cur.waves = waves;
        cur.decisions = Array.isArray(cur.decisions) ? cur.decisions : [];
        cur.decisions.push({ at: new Date().toISOString(), text: `Lane ${task} added by the runner (it was not in the plan)` });
        writeAtomic(planFile, JSON.stringify(cur, null, 2) + '\n');
      }
      registerPlan(planFile);
      return planFile;
    }
    // No plan file, or a closed one: archive the closed plan (it stays listed as closed) and create a
    // fresh open plan from the brief, so the new lane always has a plan.
    if (cur && planClosed(cur)) {
      const stamp = planStamp();
      const archiveDir = path.join(main, 'tasks', 'plans'); fs.mkdirSync(archiveDir, { recursive: true });
      const dest = path.join(archiveDir, `${stamp}.json`);
      let moved = false;
      try { fs.renameSync(planFile, dest); moved = true; } catch {}
      if (!moved) { try { fs.copyFileSync(planFile, dest); fs.rmSync(planFile, { force: true }); } catch {} }
      if (fs.existsSync(dest)) {
        const oldId = planId(planFile); const newId = `${oldId}~${stamp}`;
        try { fs.rmSync(path.join(PLANS, `${oldId}.json`), { force: true }); } catch {}
        // A deleted plan (removed: true) is archived for the record but never registered again,
        // so a new lane can never bring a removed plan back to the dashboard.
        if (!cur.removed) {
          fs.mkdirSync(PLANS, { recursive: true });
          fs.writeFileSync(path.join(PLANS, `${newId}.json`), JSON.stringify({ id: newId, file: dest }, null, 2));
        }
      }
    }
    const plan = { title: goal, goal, lead: process.env.CA_LEAD || 'lead', status: 'running', now: '',
      waves: [{ name: 'Lanes', lanes: [task] }], lanes: [{ task, repo: rel, why: goal }],
      decisions: [{ at: new Date().toISOString(), text: `Plan created by the runner: lane ${task} started without an open plan.` }],
      next: [], risks: [] };
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    writeAtomic(planFile, JSON.stringify(plan, null, 2) + '\n');
    registerPlan(planFile);
    return planFile;
  });
}

// True when the lane is already listed in an open plan: its repo's own plan, or another registered
// open plan that lists it (a resume must not rewrite or duplicate a plan).
export function laneAlreadyPlanned(repo, task) {
  try {
    if (openPlanFor(repo, task)) return true;
    const main = projectOf(repo).key; const p = readJSON(path.join(main, 'tasks', 'plan.json')); return !!(p && !planClosed(p) && planListsLane(p, main, repo, task));
  } catch { return false; }
}

// The registered open plan that already lists this lane, resolving each lane entry's repo the same
// way planView and noteResume do (the plan file's folder, then p.repo, then the lane entry repo).
export function openPlanFor(repo, task) {
  const id = laneId(repo, task);
  for (const r of plans()) {
    const p = readJSON(r.file) || {};
    if (planClosed(p) || p.removed) continue;
    const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
    if ((p.lanes || []).some((pl) => pl && !pl.removed && laneId(path.resolve(base, pl.repo || '.'), pl.task) === id)) return r;
  }
  return null;
}
const LEAD_PHASES = ['planning', 'building', 'waiting', 'verifying', 'asking', 'done'];
// Bounded activity: keep only the newest entries so a long lead session cannot grow plan.json forever.
const ACTIVITY_MAX = 20;
function pushActivity(p, entry) {
  const a = Array.isArray(p.leadActivity) ? p.leadActivity : [];
  a.push(entry); p.leadActivity = a.slice(-ACTIVITY_MAX);
}
// ca plan update: only these fields may be patched, each with the type the views expect. An unknown field
// or a wrong type is refused with the field name, never silently dropped, so a typo cannot corrupt a plan.
const PLAN_PATCH = {
  title: (v) => typeof v === 'string', goal: (v) => typeof v === 'string', now: (v) => typeof v === 'string',
  status: (v) => typeof v === 'string', phase: (v) => typeof v === 'string' && LEAD_PHASES.includes(v),
  next: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' || (!!x && typeof x === 'object' && typeof x.text === 'string')),
  // Waves and lanes are rendered by planView, which reads w.name / w.lanes and l.task / l.repo: a non-object
  // entry (or one missing its required string) would make a view throw, so the shape is checked, not just the type.
  waves: (v) => Array.isArray(v) && v.every((w) => !!w && typeof w === 'object' && !Array.isArray(w) && typeof w.name === 'string'
    && (w.lanes === undefined || (Array.isArray(w.lanes) && w.lanes.every((t) => typeof t === 'string')))),
  lanes: (v) => Array.isArray(v) && v.every((l) => !!l && typeof l === 'object' && !Array.isArray(l) && typeof l.task === 'string'
    && (l.repo === undefined || typeof l.repo === 'string')),
  risks: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};
const PLAN_PATCH_HINT = Object.keys(PLAN_PATCH).join(', ');
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) die(`--patch must be a JSON object; fields: ${PLAN_PATCH_HINT}`, 2);
  const keys = Object.keys(patch);
  if (!keys.length) die(`--patch is empty; fields: ${PLAN_PATCH_HINT}`, 2);
  for (const k of keys) {
    if (!Object.hasOwn(PLAN_PATCH, k)) die(`unknown patch field "${k}"; fields: ${PLAN_PATCH_HINT}`, 2);
    if (!PLAN_PATCH[k](patch[k])) die(`patch field "${k}" has the wrong type`, 2);
  }
  return keys;
}
// ca plan [file] registers; ca plan list | close [id] [--reason t] | rm <id> manage registered plans.
const findPlan = (q) => {
  const all = plans();
  if (!q) return all[0];
  const r = pickOne(all, q, (x) => x.id, null);
  if (r.matches) die(`ambiguous plan "${q}": matches ${r.matches.join(', ')}; use the full id`, 2);
  return r.hit;
};
export async function cmdPlan(args) {
  const sub = args[0];
  if (sub === 'list' || sub === 'ls') {
    const all = plans().map(planView);
    if (args.includes('--json')) return console.log(JSON.stringify(all, null, 2));
    if (!all.length) return console.log('no plan registered (ca plan <repo>/tasks/plan.json)');
    for (const p of all) console.log(`${p.id.padEnd(24)} ${p.state.padEnd(10)} ${p.title}  (${p.summary})  time ${fmtDur(p.time && p.time.totalMs)}`);
    return;
  }
  if (sub === 'update') {
    // The patch comes from --patch <json>, --patch-file <file> or --patch - (JSON on stdin). The file
    // and stdin forms exist because Windows PowerShell splits a JSON argument on its spaces.
    const pi = args.indexOf('--patch'); const fi = args.indexOf('--patch-file');
    let raw = pi >= 0 ? args[pi + 1] : undefined; let from = 'arg';
    if (fi >= 0) { const f = args[fi + 1]; if (!f || f.startsWith('--')) die('usage: ca plan update <id> --patch-file <file>', 2); try { raw = fs.readFileSync(f, 'utf8'); } catch { die(`cannot read --patch-file ${f}`, 2); } from = 'file'; }
    else if (raw === '-') { try { raw = fs.readFileSync(0, 'utf8'); } catch { die('cannot read the patch from stdin', 2); } from = 'stdin'; }
    const skip = new Set([0]); if (pi >= 0) { skip.add(pi); skip.add(pi + 1); } if (fi >= 0) { skip.add(fi); skip.add(fi + 1); }
    const q = args.filter((a, i) => !skip.has(i) && !a.startsWith('--'))[0];
    if (!q || raw === undefined) die('usage: ca plan update <id> --patch <json> | --patch-file <file> | --patch -', 2);
    let patch; try { patch = JSON.parse(raw); } catch { die(`--patch (${from}) is not valid JSON: ${oneLine(raw, 80)}`, 2); }
    validatePatch(patch);
    const r = findPlan(q); if (!r) die(`no registered plan matches "${q}"; ca plan list`, 2);
    const res = withPlanLock(r.file, () => {
      const p = readJSON(r.file);
      if (!p || typeof p !== 'object' || Array.isArray(p)) die(`cannot read plan JSON at ${r.file}`, 2);
      if (p.removed === true) die(`plan ${r.id} was removed; ca plan list`, 2);
      if (planClosed(p)) die(`plan ${r.id} is closed; reopen a plan before editing it`, 1);
      Object.assign(p, patch);
      p.revision = (Number(p.revision) || 0) + 1;
      p.updatedAt = new Date().toISOString();
      writeAtomic(r.file, JSON.stringify(p, null, 2) + '\n');
      return p;
    });
    return console.log(`plan ${r.id} updated (revision ${res.revision})`);
  }
  if (sub === 'close' || sub === 'rm') {
    const ri = args.indexOf('--reason'); const reason = ri >= 0 ? args.slice(ri + 1).join(' ').trim() : '';
    const q = args.slice(1, ri >= 0 ? ri : undefined).find((a) => !a.startsWith('--'));
    const r = findPlan(q); if (!r) die(`no registered plan matches ${q || '(latest)'}; ca plan list`, 2);
    if (sub === 'rm') {
      // rm kills and deletes the plan's lanes and marks the plan removed; --keep-lanes only unregisters.
      if (args.includes('--keep-lanes')) { fs.rmSync(path.join(PLANS, `${r.id}.json`), { force: true }); return console.log(`plan ${r.id} unregistered (its plan.json is kept: ${r.file})`); }
      const res = await removePlan(r, { by: 'ca plan rm' });
      if (res.error) die(res.error, res.code || 1);
      return console.log(`plan ${r.id} removed; lanes [${res.lanes.join(', ') || '-'}]; killed [${res.killed.join(', ') || '-'}]`);
    }
    const v = planView(r); if (v.waves.some((w) => w.lanes.some((l) => l.running))) die(`plan ${r.id} still has a running lane; ca stop it first`, 1);
    const p = readJSON(r.file) || {}; const unstarted = new Set(v.waves.flatMap((w) => w.lanes).filter((l) => l.health === 'planned').map((l) => l.task));
    for (const pl of p.lanes || []) if (unstarted.has(pl.task)) pl.dropped = true;
    p.status = 'done'; p.now = reason ? `Closed: ${reason}` : 'Plan closed by the lead.'; p.closedAt = new Date().toISOString();
    (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Plan closed${reason ? ': ' + reason : ''}${unstarted.size ? `. Dropped, never started: ${[...unstarted].join(', ')}` : ''}.` });
    fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
    return console.log(`plan ${r.id} closed${unstarted.size ? `; dropped ${[...unstarted].join(', ')}` : ''}`);
  }
  const f = path.resolve(args[0] || path.join('tasks', 'plan.json'));
  const p = readJSON(f); if (!p) die(`cannot read plan JSON at ${f}`, 2);
  fs.mkdirSync(PLANS, { recursive: true }); const id = planId(f);
  fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ id, file: f }, null, 2));
  // The lead may not have written startedAt; stamp it once from the plan's first decision or lane so a
  // plan's total time is stable. An existing value is never overwritten.
  if (!p.startedAt) {
    let st = null; try { st = fs.statSync(f); } catch {}
    const v = planView({ id, file: f, mtime: st ? st.mtimeMs : Date.now() });
    p.startedAt = new Date((v.time && v.time.startedAt) || Date.now()).toISOString();
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
    // Stamping is bookkeeping, not lead activity: keep the old mtime so the plan's idle time does not reset.
    if (st) { try { fs.utimesSync(f, st.atime, st.mtime); } catch {} }
  }
  const u = await ensureDash();
  console.log(`plan ${id} registered: ${p.title || p.goal || f}${u ? '. Dashboard: ' + u : ''}`);
}
export function cmdNote(args) {
  const hasNow = args.includes('--now');
  const pi = args.indexOf('--plan'); const pq = pi >= 0 ? args[pi + 1] : null;
  if (pi >= 0 && (!pq || pq.startsWith('--'))) die('usage: ca note [--now] [--plan <id>] [--phase <phase>] <text>', 2);
  const hi = args.indexOf('--phase'); const phase = hi >= 0 ? args[hi + 1] : null;
  if (hi >= 0 && (!phase || phase.startsWith('--'))) die(`--phase needs one of: ${LEAD_PHASES.join(', ')}`, 2);
  if (phase !== null && !LEAD_PHASES.includes(phase)) die(`unknown phase "${phase}"; use one of: ${LEAD_PHASES.join(', ')}`, 2);
  const skip = new Set();
  if (hasNow) skip.add(args.indexOf('--now'));
  if (pi >= 0) { skip.add(pi); skip.add(pi + 1); }
  if (hi >= 0) { skip.add(hi); skip.add(hi + 1); }
  const text = args.filter((a, i) => !skip.has(i)).join(' ').trim();
  if (!text) die('usage: ca note [--now] [--plan <id>] [--phase <phase>] <text>', 2);
  // Resolve like every other plan command: an explicit id goes through findPlan (ambiguous ids are refused,
  // never guessed); a bare note defaults to the newest plan. A closed or removed plan is never written to.
  const r = pq ? findPlan(pq) : plans()[0];
  if (!r) die(`no registered plan matches "${pq || '(latest)'}"; ca plan list`, 2);
  const pre = readJSON(r.file);
  if (pre && pre.removed === true) die(`plan ${r.id} was removed; ca plan list`, 2);
  if (pre && planClosed(pre)) die(`plan ${r.id} is closed; reopen a plan before noting on it`, 1);
  const at = new Date().toISOString();
  withPlanLock(r.file, () => {
    const p = readJSON(r.file);
    if (!p || typeof p !== 'object' || Array.isArray(p)) die(`cannot read plan JSON at ${r.file}`, 2);
    if (phase !== null) p.phase = phase;
    if (hasNow || phase !== null) {
      p.now = text; p.nowAt = at;
      pushActivity(p, { at, text, ...(phase !== null ? { phase } : {}) });
    } else {
      (p.decisions ||= []).push({ at, text });
    }
    writeAtomic(r.file, JSON.stringify(p, null, 2) + '\n');
  });
  console.log(`${hasNow ? 'now' : 'decision'} noted on plan ${r.id}`);
}
// ca lead-tokens [--plan id] [--session file]         point the plan at the lead's transcript, print totals
// ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]  report numbers
// The lead harness reports its own model usage so the plan counts the lead, not only the CodeArts workers.
// Default session: the newest .jsonl under ~/.claude/projects/<cwd, non [A-Za-z0-9-] -> ->/.
function defaultSession() {
  const dir = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9-]/g, '-'));
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  if (!files.length) return null;
  return files.map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
}
export function cmdLeadTokens(args) {
  const asJson = args.includes('--json');
  const num = (flag) => { const i = args.indexOf(flag); if (i < 0) return 0; const n = Number(args[i + 1]); return Number.isFinite(n) ? n : 0; };
  const pi = args.indexOf('--plan'); const pq = pi >= 0 ? args[pi + 1] : null;
  const r = findPlan(pq); if (!r) die(`no registered plan matches ${pq || '(latest)'}; ca plan list`, 2);
  const p = readJSON(r.file) || {};
  const si = args.indexOf('--set');
  if (si >= 0) {
    const model = args[si + 1]; if (!model || model.startsWith('--')) die('usage: ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]', 2);
    const add = args.includes('--add'); const prev = (add && p.leadTokens?.[model]) || {};
    const next = { input: (prev.input || 0) + num('--input'), output: (prev.output || 0) + num('--output'), cacheRead: (prev.cacheRead || 0) + num('--cache-read'), cacheWrite: (prev.cacheWrite || 0) + num('--cache-write') };
    (p.leadTokens ||= {})[model] = next; fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
    if (asJson) return console.log(JSON.stringify({ plan: r.id, model, ...next, total: tokTotal(next) }, null, 2));
    return console.log(`plan ${r.id}: leadTokens ${model} total ${tokTotal(next)} (in ${next.input} out ${next.output} cache read ${next.cacheRead} write ${next.cacheWrite})`);
  }
  const sfi = args.indexOf('--session'); const session = sfi >= 0 ? args[sfi + 1] : (p.leadSession || defaultSession());
  if (!session) die('no session given and none under ~/.claude/projects; use --session <file.jsonl>', 2);
  const abs = path.resolve(session); if (!fs.existsSync(abs)) die(`session file not found: ${abs}`, 2);
  p.leadSession = abs; fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n');
  const t = parseLeadSession(abs, p.leadSince); const keys = Object.keys(t);
  if (asJson) return console.log(JSON.stringify({ plan: r.id, session: abs, tokensByModel: t }, null, 2));
  console.log(`plan ${r.id}: leadSession ${abs}`);
  if (!keys.length) return console.log('  no assistant usage in the transcript');
  for (const m of keys.sort((a, b) => t[b].total - t[a].total)) console.log(`  ${m}  ${t[m].total}  (in ${t[m].input} out ${t[m].output} cache read ${t[m].cacheRead} write ${t[m].cacheWrite})`);
}
const briefSteps = (file) => { try { return [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) })); } catch { return []; } };
// How long a lane really worked, ignoring the gaps while it was paused between runs. Windows are one
// [start, end] per run plus the current run; the phase timeline is clipped to those windows so paused
// gaps never count. The window time before the first phase entry is waiting.
function laneTime(s, isAlive) {
  const win = [];
  const push = (a, b) => { if (a == null || b == null) return; if (!Number.isFinite(a) || !Number.isFinite(b)) return; if (b <= a) return; win.push([a, b]); };
  for (const r of s.runs || []) if (r && r.startedAt != null) push(r.startedAt, r.finishedAt != null ? r.finishedAt : (isAlive ? Date.now() : s.lastEventAt));
  const curEnd = s.finishedAt != null ? s.finishedAt : (isAlive ? Date.now() : s.lastEventAt);
  push(s.runStartedAt || s.startedAt, curEnd);
  win.sort((a, b) => a[0] - b[0]);
  const ms = win.reduce((t, [a, b]) => t + (b - a), 0);
  const byPhase = { wait: 0, build: 0, checks: 0, fix: 0, review: 0, other: 0 };
  const map = (p) => p === 'starting' || p === 'restart' || p === 'backoff' ? 'wait' : p === 'build' ? 'build' : p === 'gate' ? 'checks' : p === 'fix' ? 'fix' : p === 'review' ? 'review' : 'other';
  const overlap = (a, b) => { let t = 0; for (const [wa, wb] of win) { const lo = a > wa ? a : wa, hi = b < wb ? b : wb; if (hi > lo) t += hi - lo; } return t; };
  const phases = s.phases || [];
  if (!phases.length) byPhase.other = ms;
  else {
    const end = win.reduce((m, [, b]) => (b > m ? b : m), 0);
    for (let i = 0; i < phases.length; i++) { const at = phases[i].at; const nx = i + 1 < phases.length ? phases[i + 1].at : end; if (at == null || nx == null || nx <= at) continue; byPhase[map(phases[i].phase)] += overlap(at, nx); }
    const first = phases[0].at;
    if (first != null) for (const [wa, wb] of win) { const hi = wb < first ? wb : first; if (hi > wa) byPhase.wait += hi - wa; }
  }
  return { ms, byPhase, windows: win };
}
export function laneView(l) {
  const s = l.s; const pg = stepProgress(s);
  const isAlive = laneAlive(l); const h = laneHealthOf(l);
  const { actions, suggest, why } = laneActions({ s, alive: isAlive, health: h, canResume: fs.existsSync(l.repo) && fs.existsSync(path.join(l.repo, 'tasks', `${l.task}.md`)) });
  const { bucket, reason: bucketWhy, handled } = bucketFor(l);
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s), tools: s.tools || [], models: s.models, session: s.activeSession,
    reason: s.reason || '', running: !s.result && isAlive, result: resultOf(s) || '', runs: (s.runs || []).length + 1, progress: { done: pg.done, total: pg.total, current: pg.current },
    startedAt: s.startedAt, finishedAt: s.finishedAt || null, fixes: s.fixes || 0, time: laneTime(s, isAlive),
    actions, suggest, why, bucket, bucketWhy, status: laneStatusOf(l), project: projectOf(l.repo), kind: kindOf(l), seen: laneSeen(l.id, s.finishedAt), handled: !!handled, blocked: s.blocker || null, ...(handled ? { suggest: '', why: '' } : {}) };
}
// A finished lane whose state folder is gone (worktree merged and removed): rebuild its state from the summary
// that `ca lane ... > tasks/<task>.lane.log` left in the main repo. Returns null when the log has no result.
function laneFromLog(file, ref, briefFile) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const head = [...txt.matchAll(/^=== lane \S+: ([A-Z ]+?)(?: \(([^)]*)\))? in (\S+) ===\r?$/gm)].pop(); if (!head) return null;
  const tail = txt.slice(head.index);
  const result = head[1].trim().toLowerCase(); const reason = head[2] || '';
  const commitLog = [...tail.matchAll(/^([0-9a-f]{7,40}) (.+?)\r?$/gm)].map((m) => ({ hash: m[1], subject: m[2] })).reverse();
  let stepList = []; try { stepList = [...fs.readFileSync(briefFile, 'utf8').matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) })); } catch {}
  const tk = tail.match(/tokens in (\d+) out (\d+)(?: \(cache read (\d+)\))? over (\d+) steps/); const mm = tail.match(/^models: build (\S+), review (\S+)/m); const vd = tail.match(/^VERDICT: (.+?)\r?$/m);
  let mt = 0; try { mt = fs.statSync(file).mtimeMs; } catch {}
  const secs = [...head[3].matchAll(/(\d+)([hms])/g)].reduce((a, m) => a + Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]], 0);
  const s = { result, reason, phase: 'finished', activity: result, verdict: vd && vd[1] !== 'none' ? vd[1] : null, commitLog, commits: commitLog.length, stepList, steps: stepList.length,
    tokens: tk ? { input: Number(tk[1]), output: Number(tk[2]), reasoning: 0, cacheRead: Number(tk[3] || 0), steps: Number(tk[4] || 0) } : {}, startedAt: mt - secs * 1000, finishedAt: mt, steers: [], interruptions: [], models: mm ? { build: mm[1], review: mm[2] } : {} };
  return { ...ref, s };
}
// The lead's own usage: a Claude Code transcript (leadSession) or harness-reported numbers
// (leadTokens). Cached by file mtime/size so a poll never re-reads a large jsonl.
const leadCache = new Map();
function parseLeadSession(file, since) {
  let st; try { st = fs.statSync(file); } catch { return {}; }
  const key = path.resolve(file); const stamp = `${st.mtimeMs}:${st.size}:${since || ''}`;
  const hit = leadCache.get(key); if (hit && hit.stamp === stamp) return hit.result;
  const out = {}; const seen = new Set(); const sinceT = since ? new Date(since).getTime() : null;
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    let rec; try { rec = JSON.parse(s); } catch { continue; }
    const msg = rec.message; if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
    if (sinceT != null && rec.timestamp && new Date(rec.timestamp).getTime() < sinceT) continue;
    const id = msg.id || rec.uuid || rec.id; if (id && seen.has(id)) continue; if (id) seen.add(id);
    const m = msg.model || 'lead'; const u = msg.usage; const e = (out[m] ||= { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0 });
    e.input += u.input_tokens || 0; e.output += u.output_tokens || 0;
    e.cacheRead += u.cache_read_input_tokens || 0; e.cacheWrite += u.cache_creation_input_tokens || 0; e.steps += 1;
  }
  for (const v of Object.values(out)) v.total = tokTotal(v);
  leadCache.set(key, { stamp, result: out }); return out;
}
// The lead rows a plan shows: transcript or reported numbers, else one 'none' row so the lead is
// never silently a zero. The fallback model name is plan.lead (the author) or literally "lead".
function leadView(p) {
  const out = {};
  if (p.leadSession) { const t = parseLeadSession(path.resolve(p.leadSession), p.leadSince); for (const [m, v] of Object.entries(t)) out[m] = modelRow(v, 'lead', 'transcript'); }
  else if (p.leadTokens && typeof p.leadTokens === 'object') { for (const [m, v] of Object.entries(p.leadTokens)) out[m] = modelRow(v, 'lead', 'reported'); }
  if (!Object.keys(out).length) { const m = (typeof p.lead === 'string' && p.lead) || 'lead'; out[m] = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0, total: null, who: 'lead', source: 'none' }; }
  return out;
}
// How long a plan took and where the time went. The plan runs from its start (a stamped startedAt, else
// its first decision or lane) to its close (closedAt, else the last sign of work, else now). The span is
// split into lead planning, lanes running (the union of every lane window, so parallel lanes never double
// count), lead between lanes and lead verifying. Worker time per phase and per lane is summed separately.
function planTime(p, r, planned) {
  const tsn = (t) => { if (t == null || t === '') return null; const n = typeof t === 'number' ? t : new Date(t).getTime(); return Number.isFinite(n) ? n : null; };
  const win = [];
  for (const x of planned || []) for (const w of (x.time && x.time.windows) || []) if (Array.isArray(w) && w[0] != null && w[1] != null) win.push([w[0], w[1]]);
  const firstStart = win.length ? Math.min(...win.map((w) => w[0])) : null;
  const lastEnd = win.length ? Math.max(...win.map((w) => w[1])) : null;
  const dts = (p.decisions || []).map((d) => tsn(d && d.at)).filter((n) => n != null);
  let startedAt = tsn(p.startedAt);
  if (startedAt == null) { const c = [...dts, ...(firstStart != null ? [firstStart] : [])]; startedAt = c.length ? Math.min(...c) : (r.mtime || Date.now()); }
  const isClosed = /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || '');
  let endedAt = tsn(p.closedAt);
  if (endedAt == null && isClosed) { const c = []; if (lastEnd != null) c.push(lastEnd); if (dts.length) c.push(Math.max(...dts)); endedAt = c.length ? Math.max(...c) : startedAt; }
  const live = endedAt == null;
  let end = endedAt != null ? endedAt : Date.now();
  if (end < startedAt) end = startedAt;
  const totalMs = end - startedAt;
  const unionLen = (ws, lo, hi) => {
    const iv = ws.map((w) => [Math.max(w[0], lo), Math.min(w[1], hi)]).filter((w) => w[1] > w[0]).sort((a, b) => a[0] - b[0]);
    let t = 0, a = null, b = null;
    for (const [s, e] of iv) { if (a == null) { a = s; b = e; } else if (s <= b) { if (e > b) b = e; } else { t += b - a; a = s; b = e; } }
    return a == null ? 0 : t + (b - a);
  };
  let planning, lanesMs, verify, between;
  if (!win.length) { planning = totalMs; lanesMs = 0; verify = 0; between = 0; }
  else {
    planning = Math.max(0, firstStart - startedAt);
    lanesMs = unionLen(win, startedAt, end);
    verify = (planned || []).some((x) => x.running) ? 0 : Math.max(0, end - lastEnd);
    between = Math.max(0, totalMs - planning - lanesMs - verify);
  }
  const segments = [
    { key: 'planning', label: 'Lead planning', ms: planning },
    { key: 'lanes', label: 'Lanes running', ms: lanesMs },
    { key: 'between', label: 'Lead between lanes', ms: between },
    { key: 'verify', label: 'Lead verifying', ms: verify },
  ];
  const byPhase = { wait: 0, build: 0, checks: 0, fix: 0, review: 0, other: 0 };
  let workTotal = 0; const lanesArr = [];
  for (const x of planned || []) {
    const t = x.time; if (!t || !(t.ms > 0)) continue;
    workTotal += t.ms; for (const k of Object.keys(byPhase)) byPhase[k] += (t.byPhase && t.byPhase[k]) || 0;
    lanesArr.push({ task: x.task, ms: t.ms, byPhase: t.byPhase });
  }
  return { startedAt, endedAt, live, totalMs, segments, work: { totalMs: workTotal, byPhase }, lanes: lanesArr };
}
// A lane status key (from laneView/laneStatusOf), falling back to the raw result for a lane that
// never got one. Plan and wave badges read these so the new results show up correctly.
const statusKey = (x) => (x && x.status && x.status.key) || (x && x.result) || '';
// Settled: nothing is left for a human (the new Verified, a plain Done, or an acked Handled lane).
const settledKey = (k) => k === 'verified' || k === 'done' || k === 'handled';
// The result words the old rule read as attention, kept only for a lane that never got a status object
// (a legacy lane rebuilt from its log). stopped and killed are gone: the lead ending a lane is not work
// for a human (status contract part 1).
const LEGACY_ATTN = ['checks failing', 'failed', 'unverified'];
// Does this lane need a human? The server already decided (lane.status.attention, status contract part
// 1); the plan, the wave and the glance all read that one flag, so they can never disagree with the
// lane badge itself.
const laneNeedsHuman = (x) => (x && x.status && typeof x.status === 'object') ? x.status.attention === true : LEGACY_ATTN.includes((x && x.result) || '');
// The one pure rule that turns a set of lanes into a state word, shared by the wave status and the
// plan state so they cannot keep two copies. `closed`, `phase` and `status` are the plan context; a
// wave passes none of them, so only a plan reads closed/verifying/waiting. A lane needs the human when
// its own status says so (laneNeedsHuman). 'paused' only when every attention lane is paused.
function laneSetState(lanes, { closed, phase, status } = {}) {
  const all = Array.isArray(lanes) ? lanes : [];
  const planCtx = closed !== undefined || typeof phase === 'string' || typeof status === 'string';
  const live = all.filter((x) => x.result !== 'dropped');
  const settled = (x) => settledKey(statusKey(x));
  // Done for a closed plan counts the results the old summary counted: settled, a plain done, or a
  // lane left for review (never re-read as an open lane).
  const doneLane = (x) => settled(x) || x.result === 'done' || x.result === 'needs review';
  const attn = live.filter(laneNeedsHuman);
  if (live.some((x) => x.running)) return 'running';
  if (closed) return live.length > 0 && live.every(doneLane) ? 'done' : 'closed';
  if (attn.length) return attn.every((x) => statusKey(x) === 'paused') ? 'paused' : 'attention';
  if (live.length > 0 && live.every(settled)) {
    if (/^verifying$/i.test(status || '') || phase === 'verifying') return 'verifying';
    return planCtx ? (LEAD_PHASES.includes(phase) && phase !== 'done' ? 'waiting' : 'done') : 'done';
  }
  if (planCtx) return 'waiting';
  if (!all.length) return 'planned';
  if (!live.length) return 'dropped';
  if (live.some((x) => x.result)) return 'partial';
  return 'planned';
}
// One glance state per plan, so a person across the room can tell at once whether the work is
// running, done, failed or waiting on them. Pure: it reads only the plan view it is handed.
const QUIET_MS = 15 * 60e3;
const GLANCE_WORD = { working: 'Working', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done', quiet: 'Check Claude', idle: 'Idle' };
// The tone and glyph a glance state maps to (status contract part 2): the plan badge is exactly the
// glance word, tone and glyph, so every pill in both views shows the same thing (never a page guess).
const GLANCE_TONE = { working: 'run', 'needs-you': 'warn', failed: 'bad', done: 'done', quiet: 'warn', idle: 'idle' };
const GLANCE_GLYPH = { working: GLYPHS.working, 'needs-you': GLYPHS['needs-you'], failed: GLYPHS.failed, done: GLYPHS.done, quiet: '?', idle: GLYPHS.idle };
const glanceBad = (k) => k === 'failed' || k === 'checks failing' || k === 'killed';
// An attention lane is failed when the lane badge itself says so (the X glyph, U+2715) or its key is a
// failure; the other attention lanes (needs review, paused, stalled) are needs-you.
const attnBad = (x) => (x && x.status && x.status.glyph === GLYPHS.failed) || statusKey(x) === 'failed' || statusKey(x) === 'checks failing';
const glanceDur = (ms) => ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : ms < 86400e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
function glanceOf(view) {
  const lanes = (view.waves || []).flatMap((w) => w.lanes || []).filter((x) => x.result !== 'dropped');
  const lead = view.lead || {};
  const who = view.leadName || 'Claude';
  const phase = lead.phase || null;
  const age = typeof lead.age === 'number' ? lead.age : null;
  const act = Array.isArray(lead.activity) && lead.activity.length ? lead.activity[lead.activity.length - 1] : null;
  const lastText = act && act.text ? act.text : '';
  const leadMs = lead.updatedAt ? Date.parse(lead.updatedAt) : 0;
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Date.parse(v || '')) ? Date.parse(v) : 0));
  const laneMs = Math.max(0, ...lanes.map((x) => Math.max(ms(x.finishedAt), ms(x.startedAt))));
  const atIso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  const out = (state, detail, at = null) => ({ state, word: GLANCE_WORD[state], detail: oneLine(detail || '', 89), at });
  // a. the plan is closed: a bad lane makes it failed, otherwise done. The detail is the close reason
  // without a leading "Closed:" or "Done:" (status contract part 2).
  if (view.closed) {
    const bad = lanes.find((x) => glanceBad(statusKey(x)));
    if (bad) return out('failed', `${bad.task} failed: ${statusKey(bad)}`);
    const nowTxt = String(view.now || '');
    const reason = /^\s*(Closed|Done|Plan closed)\b/i.test(nowTxt) ? nowTxt.replace(/^\s*(Closed|Done|Plan closed)\s*:\s*/i, '').trim() : '';
    return out('done', reason || `All ${(view.counts && view.counts.total) || lanes.length} lanes finished`, atIso(Math.max(leadMs, laneMs)));
  }
  // b. the lead ended its turn on a question for the human.
  if (phase === 'asking') return out('needs-you', `${who} is asking: ${lastText || view.now || ''}`, lead.nowAt || lead.updatedAt || null);
  // c. the lead reports done.
  if (phase === 'done') return out('done', lastText || `${who} is done`, atIso(Math.max(leadMs, laneMs)));
  // d0. a running lane is blocked on the lead (a worker question or no progress): that needs a human now.
  const blk = lanes.find((x) => x.running && x.blocked);
  if (blk) return out('needs-you', `${blk.task}: ${blk.blocked.kind === 'question' ? 'asked the lead' : 'no progress'}: ${blk.blocked.text || ''}`, atIso(ms(blk.blocked.at)));
  // d. a lane is running.
  if (view.counts && view.counts.running > 0) {
    const r = lanes.find((x) => x.running);
    let detail = `${view.counts.running} of ${view.counts.total} lanes running`;
    if (r && r.progress && r.progress.total > 0) detail += `, step ${r.progress.done}/${r.progress.total}`;
    return out('working', detail);
  }
  // e. a fresh lead phase means the lead is still working.
  if (age !== null && age < QUIET_MS && ['planning', 'building', 'waiting', 'verifying'].includes(phase)) return out('working', `${who} is ${phase}`);
  // f. a lane needs a human (the same attention flag every lane badge reads): a bad one is failed,
  // any other attention lane is needs-you.
  const attn = lanes.filter(laneNeedsHuman);
  if (attn.length) {
    const bad = attn.find(attnBad);
    if (bad) return out('failed', `${bad.task} failed: ${statusKey(bad)}`);
    const a = attn[0];
    return out('needs-you', `${a.task}: ${(a.status && a.status.label) || statusKey(a)}`);
  }
  // g. lanes or a lead phase exist but nothing is fresh or needs a human.
  if (lanes.length || phase) {
    return out('quiet', age === null ? `No lead update yet; ${who} may be waiting on you` : `No lead update for ${glanceDur(age)}; ${who} may be waiting on you`);
  }
  // h. nothing to look at.
  return out('idle', '');
}
export function planView(r) {
  const p = r.plan || readJSONCached(r.file) || {}; const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
  const reg = laneIndex();
  // A lane entry marked removed: true was deleted with its lane or plan: it must never come back as "planned".
  const planned = (p.lanes || []).filter((pl) => pl && !pl.removed).map((pl) => {
    const repo = path.resolve(base, pl.repo || '.'); const id = laneId(repo, pl.task); const l = reg.get(id);
    let bf = path.join(repo, 'tasks', `${pl.task}.md`);
    if (!fs.existsSync(bf)) bf = path.join(base, 'tasks', `${pl.task}.md`);
    const old = l ? null : laneFromLog(path.join(base, 'tasks', `${pl.task}.lane.log`), { id, task: pl.task, repo, dir: path.join(repo, 'tasks', `${pl.task}.lane`) }, bf);
    const v = l ? laneView(l) : old ? { ...laneView(old), archived: true } : { id, task: pl.task, repo, health: 'planned', phase: 'planned', running: false, result: '',
      status: { key: 'planned', label: 'Planned', tone: 'idle', reason: 'planned, not started', attention: false, steps: 'live', glyph: GLYPHS.working },
      progress: { done: 0, total: briefSteps(bf).length, current: null } };
    // "dropped": true marks a planned lane the lead decided not to run; it never counts as open work.
    const d = pl.dropped && v.health === 'planned' ? { health: 'dropped', phase: 'dropped', result: 'dropped',
      status: { key: 'dropped', label: 'Dropped', tone: 'idle', reason: typeof pl.dropped === 'string' ? pl.dropped : 'dropped by the lead, never started', attention: false, steps: 'hide', glyph: GLYPHS.idle },
      reason: typeof pl.dropped === 'string' ? pl.dropped : 'dropped by the lead, never started' } : {};
    if (pl.kind && ['code', 'art', 'review', 'docs'].includes(String(pl.kind).toLowerCase())) v.kind = String(pl.kind).toLowerCase(); // plan override
    return { ...v, ...d, plan: { model: pl.model || '', why: pl.why || '', files: pl.files || [], briefExists: fs.existsSync(bf) } };
  });
  const byTask = new Map(planned.map((x) => [x.task, x]));
  // "continues": "<task>" in a plan lane: the older lane was picked up by this one, so it reads as continued, not failed.
  for (const pl of (p.lanes || []).filter((x) => x && !x.removed)) {
    const old = pl.continues && byTask.get(pl.continues), nu = byTask.get(pl.task);
    if (old && nu && old.result && old.result !== 'done') {
      Object.assign(old, { health: 'continued', result: 'continued',
        status: { key: 'continued', label: 'Continued', tone: 'idle', reason: `continued in ${pl.task}${old.reason ? ' after ' + old.reason : ''}`, attention: false, steps: 'hide', glyph: GLYPHS.idle },
        continuedBy: nu.id, reason: `continued in ${pl.task}${old.reason ? ' after ' + old.reason : ''}` });
      // One agent, one station: the successor carries the earlier run(s); views show them as history, not as another lane.
      nu.continues = [...(old.continues || []), { id: old.id, task: old.task, reason: old.reason, commits: old.commits, progress: old.progress, elapsed: old.elapsed }];
      nu.runs = (nu.runs || 1) + (old.runs || 1);
      old.folded = true;
    }
  }
  const waves = (p.waves && p.waves.length ? p.waves : [{ name: 'Lanes', lanes: planned.map((x) => x.task) }]).map((w) => {
    const all = (w.lanes || []).map((t) => byTask.get(t)).filter(Boolean);
    const ls = all.filter((x) => !x.folded);
    // The wave status and the plan state share laneSetState; a wave passes no plan context.
    const st = laneSetState(ls, {});
    return { name: w.name, note: w.note || w.after || '', status: st, lanes: ls, folded: all.length && !ls.length };
  }).filter((w) => !w.folded).map(({ folded, ...w }) => w); // a wave whose lanes all continued elsewhere is history, not a stage
  // The plan badge comes from what the lanes really do, never only from the hand-written status: a plan whose
  // lead said "running" but has no running lane reads as waiting (with how long), so it never looks stuck.
  const allL = waves.flatMap((w) => w.lanes); const live = allL.filter((x) => x.result !== 'dropped');
  // Done counts every settled lane (verified, done, or handled/merged by the lead), so a closed plan whose lanes the lead merged never reads "1/3 lanes done" under a Done badge.
  const fin = (x) => settledKey(statusKey(x)) || ['done', 'needs review'].includes(x.result);
  const counts = { total: live.length, done: live.filter(fin).length, running: live.filter((x) => x.running).length,
    notStarted: live.filter((x) => x.health === 'planned').length, dropped: allL.length - live.length };
  const ts = (t) => { const n = typeof t === 'number' ? t : new Date(t || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const lastActivity = Math.max(r.mtime || 0, ...allL.map((x) => Math.max(ts(x.finishedAt), ts(x.startedAt))));
  const closed = /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || '');
  // The plan state reads the same rule as every wave status, with the plan's own context.
  const state = laneSetState(allL, { closed, phase: p.phase, status: p.status || '' });
  const idle = Date.now() - lastActivity; const dur = (ms) => ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : ms < 86400e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
  const bits = [`${counts.done}/${counts.total} lanes done`];
  if (counts.running) bits.push(`${counts.running} running`);
  if (counts.notStarted && state !== 'running') bits.push(`${counts.notStarted} not started`);
  if (counts.dropped) bits.push(`${counts.dropped} dropped`);
  if (state === 'waiting' || state === 'attention' || state === 'paused') bits.push(`idle ${dur(idle)}`);
  // Plan tokens: every lane counts, folded (continued) ones included; per agent like the lane views.
  const tokensBy = { build: sumTokens(planned.map((x) => x.tokensBy?.build)), review: sumTokens(planned.map((x) => x.tokensBy?.review)), other: sumTokens(planned.map((x) => x.tokensBy?.other)) };
  const modelKeys = [...new Set(planned.flatMap((x) => Object.keys(x.tokensByModel || {})))];
  const tokensByModel = {};
  for (const m of modelKeys) { const e = sumTok(planned.map((x) => x.tokensByModel?.[m])); tokensByModel[m] = { ...e, who: 'worker', source: (e.steps > 0 && e.total === 0) ? 'none' : 'runner' }; }
  // The lead spends tokens too: merge its by-model usage into the same table, tagged who and source.
  const leadModel = leadView(p);
  for (const [m, e] of Object.entries(leadModel)) {
    const cur = tokensByModel[m];
    if (cur && e.source !== 'none') tokensByModel[m] = modelRow({ input: cur.input + e.input, output: cur.output + e.output, reasoning: cur.reasoning + e.reasoning, cacheRead: cur.cacheRead + e.cacheRead, cacheWrite: cur.cacheWrite + e.cacheWrite, steps: cur.steps + e.steps }, 'lead', e.source);
    else if (!cur) tokensByModel[m] = e;
  }
  const missing = Object.entries(tokensByModel).filter(([, e]) => e.source === 'none').map(([m]) => m);
  // Every lane's aggregate counts (the sum the plan shows), plus the lead's known spend. 'none' rows stay
  // unknown rather than a false 0, so a lane that never reported usage is not silently dropped from the total.
  const tokens = sumTok([sumTokens(planned.map((x) => x.tokens)), ...Object.values(leadModel).filter((e) => e.source !== 'none')]);
  tokens.complete = missing.length === 0; tokens.missing = missing; tokens.count = Object.keys(tokensByModel).length;
  const time = planTime(p, r, planned);
  // The lead surface: phase, revision and bounded activity, plus the age of the last lead update. Freshness
  // is the newest of updatedAt (an update) and nowAt (a --now note), so a note refreshes it too. A plan with
  // neither reports updatedAt/age as null (never a false age), so a legacy plan is not mistaken for stale.
  const atMs = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0);
  const freshMs = Math.max(atMs(p.updatedAt), atMs(p.nowAt)) || null;
  const lead = { tokensByModel: leadModel, phase: typeof p.phase === 'string' ? p.phase : null,
    revision: Number(p.revision) || 0, updatedAt: freshMs ? new Date(freshMs).toISOString() : null, nowAt: typeof p.nowAt === 'string' ? p.nowAt : null,
    age: freshMs ? Date.now() - freshMs : null,
    activity: Array.isArray(p.leadActivity) ? p.leadActivity.slice(-ACTIVITY_MAX) : [] };
  const view = { id: r.id, file: r.file, updatedAt: r.mtime, time, title: p.title || r.id, goal: p.goal || '', leadName: p.lead || 'Claude', status: p.status || '', now: p.now || '',
    state, counts, summary: bits.join(' · '), lastActivity, closed: state === 'done' || state === 'closed', tokens, tokensBy, tokensByModel, lead,
    next: (p.next || []).map((x) => (typeof x === 'string' ? { text: x, done: false } : { text: x.text, done: !!x.done })),
    decisions: (p.decisions || []).slice(-30), risks: p.risks || [], waves };
  view.glance = glanceOf(view);
  // The one badge every plan surface shows (status contract part 2): exactly the glance word, tone and
  // glyph. The views render plan.badge, never a word they compute themselves.
  view.badge = { word: view.glance.word, tone: GLANCE_TONE[view.glance.state] || 'idle', glyph: GLANCE_GLYPH[view.glance.state] || GLANCE_GLYPH.idle };
  return view;
}
export function laneDetail(l) {
  const s = l.s; const rd = (f) => { try { return fs.readFileSync(path.join(l.dir, f), 'utf8'); } catch { return ''; } };
  let brief = ''; try { brief = fs.readFileSync(path.join(l.repo, 'tasks', `${l.task}.md`), 'utf8'); } catch {}
  return { ...laneView(l), steps: stepProgress(s).list, commits: s.commitLog || [], todos: s.todos || [], files: s.files || [], gates: s.gates || [],
    interruptions: s.interruptions || [], steers: s.steers || [], permissions: s.permissions || [], outside: s.outside || [], errors: s.errors || [],
    phases: s.phases || [], checks: s.checks || [], verdict: s.verdict || '', brief, review: rd('review.md'), summary: rd('summary.md'), stepReviews: s.stepReviews || [], config: s.config || {} };
}
