import fs from 'node:fs';
import path from 'node:path';
import { PLANS, REG, laneId, lanes, now, oneLine, plans, projectOf, readJSON, writeAtomic } from './common.mjs';

// ---------- the lead's plan (written by Claude, shown on the dashboard) ----------
// <repo>/tasks/plan.json: { title, goal, lead, status, now, waves:[{name, lanes:[task], note}],
//   lanes:[{task, repo?, model?, why?, files?}], next:[text | {text, done}], decisions:[{at, text}], risks:[text] }
// Lane repo paths are relative to the plan's repo (the folder that holds tasks/).
export const planId = (file) => path.basename(path.dirname(path.dirname(path.resolve(file)))).replace(/[^\w.-]+/g, '_');

// A plan with status done or closed is closed (never appended to, only archived and replaced).
export const planClosed = (p) => !!(p && /^(done|closed|abandoned|cancell?ed)$/i.test(p.status || ''));

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
