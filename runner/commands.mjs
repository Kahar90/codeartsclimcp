import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CA_ENTRY, EXE, HERE, PLANS, REG, ackNote, alive, caEnv, compact, controlTarget, dashUrl, die, dur, findLane, health, killTree, laneAlive, laneId, laneIndex, laneMemoFor, laneSeen, lanes, now, oneLine, planClosed, plans, plansSnapshot, readAcks, readJSON, readJSONCached, resultOf, setAck, sleep, stepProgress, writeAcks } from './common.mjs';
import { laneActions, laneBucket, laneKind, laneOutcome } from './controls.mjs';
import { tokenTotal, withTotal } from './tokens.mjs';

// ---------- control commands ----------
export function laneHealthOf(l) { const m = laneMemoFor(l); if (m.health === undefined) m.health = health(l.s); return m.health; }
export function bucketFor(l) {
  const m = laneMemoFor(l); if (m.bucket) return m.bucket;
  const s = l.s; const r = laneBucket({ s, alive: laneAlive(l), health: laneHealthOf(l) });
  let out;
  if (s.result && laneSeen(l.id, s.finishedAt)) {
    const note = ackNote(l.id); out = { bucket: r.bucket === 'attention' ? 'ended' : r.bucket, reason: `handled${note ? ': ' + note : ''} (was ${r.reason})`, handled: true };
  } else if (r.bucket === 'attention' && s.result && closedPlanLanes().has(l.id)) out = { bucket: 'ended', reason: r.reason, handled: false };
  else out = r;
  m.bucket = out; return out;
}
export function bucketOf(l) { return bucketFor(l).bucket; }
// Lane ids that belong to a closed plan: their ended lanes need nothing from the human. Cached by the
// registered plans' ids and mtimes, so a poll over many lanes reads the plan files once.
let closedLanes = { key: null, ids: new Set() };
export function closedPlanLanes() {
  const rs = plansSnapshot();
  const key = rs.map((r) => `${r.id}:${r.mtime}`).join('|');
  if (closedLanes.key === key) return closedLanes.ids;
  const ids = new Set();
  for (const r of rs) {
    const p = r.plan || readJSONCached(r.file) || {};
    if (!planClosed(p)) continue;
    const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
    for (const pl of p.lanes || []) { if (!pl || pl.removed) continue; ids.add(laneId(path.resolve(base, pl.repo || '.'), pl.task)); }
  }
  closedLanes = { key, ids };
  return ids;
}
// The one status a person sees for this lane, shown the same way in the CLI, MCP and both views.
// bucketFor already decides whether a finished lane was acknowledged (handled) and whether the lane is
// an ended lane of a closed plan; pass both through so the label and the attention flag agree everywhere.
export function laneStatusOf(l, s = l.s) {
  const r = bucketFor(l);
  const closed = !!s.result && closedPlanLanes().has(l.id);
  return laneOutcome({ s, health: health(s), handled: !!r.handled, note: r.handled ? ackNote(l.id) : '', closed, progress: stepProgress(s) });
}
// Lane kind for the Office characters; the brief is read once per change (mtime), not on every poll.
export const kindCache = new Map();
export function kindOf(l) {
  const bf = path.join(l.repo || '', 'tasks', `${l.task}.md`); let mt = 0; try { mt = fs.statSync(bf).mtimeMs; } catch {}
  const key = `${mt}|${(l.s.files || []).length}`; const c = kindCache.get(l.id);
  if (c && c.key === key) return c.kind;
  let brief = ''; try { brief = fs.readFileSync(bf, 'utf8'); } catch {}
  const kind = laneKind({ task: l.task, brief, files: l.s.files || [] }); kindCache.set(l.id, { key, kind }); return kind;
}
export function laneRow(l) {
  const s = l.s; const end = s.finishedAt || now();
  return { lane: l.id, bucket: bucketOf(l), health: laneHealthOf(l), phase: s.phase, elapsed: dur(end - s.startedAt), idle: s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt)),
    commits: `${s.commits}/${s.steps}`, tokens: compact(tokenTotal(s.tokens)), steers: (s.steers || []).filter((x) => x.by !== 'runner notice').length, interrupts: s.interruptions?.length || 0, verdict: s.verdict || '', now: oneLine(s.activity, 70) };
}
// A status row for scripts: every laneRow field plus identity, result, progress and file paths.
export function statusRow(l) {
  const s = l.s; const pg = stepProgress(s); const sm = path.join(l.dir, 'summary.md');
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, result: s.result || '', reason: s.reason || '', status: laneStatusOf(l),
    progress: { done: pg.done, total: pg.total, current: pg.current }, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s),
    blocked: s.blocker || null, summaryPath: fs.existsSync(sm) ? sm : null, dashUrl: dashUrl() };
}
// cacheWrite bills into the totals but is not modeled by tokens.mjs (kept read-only): carry it here.
export const tokTotal = (t) => (!t ? 0 : (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0));
export function sumTok(list = []) {
  const r = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0 };
  for (const t of list || []) { if (!t) continue; r.input += t.input || 0; r.output += t.output || 0; r.reasoning += t.reasoning || 0; r.cacheRead += t.cacheRead || 0; r.cacheWrite += t.cacheWrite || 0; r.steps += t.steps || 0; }
  r.total = tokTotal(r); return r;
}
// One by-model row: who spent it and where the numbers come from. A lane whose steps ran but whose
// provider returned no usage is 'none' (unknown), never a false 0.
export function modelRow(t, who, source) {
  const e = { input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, steps: t.steps || 0, who };
  e.total = tokTotal(e); e.source = (e.steps > 0 && e.total === 0) ? 'none' : source; return e;
}
export function tokensByView(s) {
  return { build: withTotal(s.tokensBy?.build), review: withTotal(s.tokensBy?.review), other: withTotal(s.tokensBy?.other) };
}
export function tokensByModelView(s) {
  const out = {}; for (const [m, t] of Object.entries(s.tokensByModel || {})) out[m] = modelRow(t, 'worker', 'runner');
  if (Object.keys(out).length || !tokTotal(s.tokens || {})) return out;
  // Lanes from before per-model counting: attribute by the lane's models (source 'lane', not counted per reply).
  const add = (m, t) => { if (!t || !tokTotal(t)) return; const k = m || 'unknown model'; const c = out[k];
    out[k] = modelRow(c ? { input: c.input + (t.input || 0), output: c.output + (t.output || 0), reasoning: c.reasoning + (t.reasoning || 0), cacheRead: c.cacheRead + (t.cacheRead || 0), steps: c.steps + (t.steps || 0) } : t, 'worker', 'lane'); };
  const by = s.tokensBy || {};
  if (tokTotal(by.build || {}) + tokTotal(by.review || {}) + tokTotal(by.other || {})) { add(s.models?.build, by.build); add(s.models?.review, by.review); add('codearts/hidden', by.other); }
  else add(s.models?.build, s.tokens);
  return out;
}
export function printRows(rows) {
  const cols = ['lane', 'bucket', 'health', 'phase', 'elapsed', 'idle', 'commits', 'tokens', 'steers', 'interrupts', 'verdict', 'now'];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
}
// One line on stderr when a newer release is known and the cache is fresh; when the cache is missing
// or stale, start a detached background refresh (ca update --check --json) and never wait for it.
// CA_NO_UPDATE_CHECK=1 turns it off; --json output never carries it; a non-TTY stderr stays quiet
// unless CA_UPDATE_NOTICE=1. Wrapped so the notice can never slow or fail the command.
export async function updateNotice(args) {
  try {
    if (process.env.CA_NO_UPDATE_CHECK === '1') return;
    if (args.some((a) => a === '--json')) return;
    if (!(process.stderr.isTTY || process.env.CA_UPDATE_NOTICE === '1')) return;
    const { readUpdateCache, compareVersions, UPDATE_TTL_MS } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
    const cache = readUpdateCache();
    if (cache && cache.available && cache.latest && compareVersions(cache.latest, cache.current || '0.0.0') > 0) {
      process.stderr.write(`Update available: ${cache.current} -> ${cache.latest}. What's new: ca update --check. Install: ca update\n`);
    }
    const fresh = cache && typeof cache.checkedAt === 'number' && (Date.now() - cache.checkedAt) < UPDATE_TTL_MS;
    if (!fresh) {
      try { spawn(process.execPath, [CA_ENTRY, 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    }
  } catch {}
}
export function cmdStatus(args) {
  // Control room order: what needs a human first (attention), then running, done, ended.
  const rank = { attention: 0, running: 1, done: 2, ended: 3 };
  const all = lanes().filter((l) => args.includes('--all') || !l.s.result || now() - (l.s.finishedAt || 0) < 24 * 3600e3);
  const ls = all.map((l) => ({ l, b: bucketOf(l) })).sort((a, b) => (rank[a.b] ?? 9) - (rank[b.b] ?? 9)).map((x) => x.l);
  if (args.includes('--json')) { console.log(JSON.stringify(ls.map(statusRow), null, 2)); return; }
  const rows = ls.map(laneRow);
  if (!rows.length) { console.log('no lanes (ca status --all for older ones)'); return; }
  printRows(rows);
}
export function cmdSummary(args) {
  const l = findLane(args.filter((a) => !a.startsWith('--'))[0]);
  const s = l.s; const sm = path.join(l.dir, 'summary.md');
  const text = fs.existsSync(sm) ? fs.readFileSync(sm, 'utf8') : '';
  if (args.includes('--json')) {
    const pg = stepProgress(s);
    console.log(JSON.stringify({ id: l.id, task: l.task, repo: l.repo, result: s.result || '', status: laneStatusOf(l), reason: s.reason || '', verdict: s.verdict || '',
      elapsedMs: (s.finishedAt || now()) - s.startedAt, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s), commits: s.commitLog || [], steps: pg.list,
      gates: s.gates || [], steers: s.steers || [], interruptions: s.interruptions || [], outside: s.outside || [], summary: text, dir: l.dir, blocked: s.blocker || null }, null, 2));
    return;
  }
  if (text) { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); return; }
  console.log(`lane ${l.id} ${s.result ? s.result + ', no summary.md yet' : 'still running'}`);
  printRows([laneRow(l)]);
}
export async function cmdTail(args) {
  const follow = args.includes('-f'); const ni = args.indexOf('-n'); const n = ni >= 0 ? Number(args[ni + 1]) : 40;
  const q = args.filter((a, i) => !a.startsWith('-') && !(ni >= 0 && i === ni + 1))[0];
  const l = findLane(q); const f = path.join(l.dir, 'live.log');
  let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  process.stdout.write(text.split('\n').slice(-n - 1).join('\n'));
  if (!follow) return;
  let pos = Buffer.byteLength(text);
  for (;;) {
    await sleep(1000);
    try { const st = fs.statSync(f); if (st.size > pos) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(st.size - pos); fs.readSync(fd, b, 0, b.length, pos); fs.closeSync(fd); pos = st.size; process.stdout.write(b.toString('utf8')); } } catch {}
    const s = readJSON(path.join(l.dir, 'state.json'));
    if (s?.result) { await sleep(500); process.stdout.write(`\n[lane ${s.result}]\n`); return; }
  }
}
// Queue a steering message. Returns { error, code } instead of dying, so a dashboard route can
// answer 409 without ever exiting the long-lived dashboard process.
export function steer(l, text) {
  if (l.s.result) return { error: `lane ${l.id} already ${l.s.result}`, code: 409 };
  if (!alive(l.s.pid)) return { error: `lane ${l.id} supervisor is not running`, code: 409 };
  fs.mkdirSync(path.join(l.dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(l.dir, 'inbox', `${now()}-${crypto.randomBytes(3).toString('hex')}.txt`), text);
  return { ok: true };
}
export function cmdSteer(args) {
  const [q, ...rest] = args; if (!q || !rest.length) die('usage: ca steer <lane> <message>', 2);
  const l = controlTarget(q, 'steer'); const r = steer(l, rest.join(' '));
  if (r.error) die(r.error, 2);
  console.log(`queued for ${l.id}; it goes into the session within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
export function cmdAttach(args) {
  const l = findLane(args[0]); const s = l.s;
  if (s.result || !s.server) die(`lane ${l.id} is ${s.result || 'not started'}; nothing to attach to`, 2);
  const sid = s.activeSession || s.buildSession;
  console.log(`attaching to ${l.id} session ${sid} at ${s.server.url}. Typing here steers the builder; leave the TUI with ctrl+c (the lane keeps running).`);
  const r = spawnSync(EXE, ['attach', s.server.url, '-s', sid, '-p', s.server.pw], { stdio: 'inherit', env: caEnv() });
  process.exit(r.status ?? 0);
}
// Parse a CLI duration for --older-than: a number followed by m, h or d (for example 30m, 48h, 2d).
// Anything else is null so the caller can raise a usage error.
export function parseAge(v) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3);
}
// ca ack --stale: mark every finished Needs-you lane older than the given age handled in one go.
// Only finished lanes are selected; running, stalled and DEAD lanes are never touched.
export function ackStale(args) {
  const oi = args.indexOf('--older-than');
  const durArg = oi >= 0 ? (args[oi + 1] ?? '') : '48h';
  const ms = parseAge(durArg);
  if (ms == null) die(`invalid --older-than "${durArg}": use a number with m, h or d (for example 48h)`, 2);
  const ni = args.indexOf('--note'); const note = ni >= 0 ? args.slice(ni + 1).join(' ').trim() : '';
  const dry = args.includes('--dry-run');
  const cut = now() - ms;
  const old = lanes().filter((l) => bucketFor(l).bucket === 'attention' && l.s.result && ((l.s.finishedAt || l.s.lastEventAt) < cut));
  if (!old.length) { console.log(`nothing in Needs you is older than ${durArg}`); return; }
  for (const l of old) {
    const b = bucketFor(l); const ts = l.s.finishedAt || l.s.lastEventAt;
    if (dry) { console.log(`would mark handled: ${l.id} (${b.reason}, ${dur(now() - ts)} ago)`); continue; }
    setAck(l.id, true, l.s.finishedAt || null, oneLine(note, 200));
    console.log(`${l.id}: handled (${b.reason})`);
  }
}
export function cmdAck(args) {
  if (args.includes('--stale')) return ackStale(args);
  const ni = args.indexOf('--note'); const note = ni >= 0 ? args.slice(ni + 1).join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : undefined).find((a) => !a.startsWith('--'));
  const l = controlTarget(q, 'ack', 'usage: ca ack <lane> [--note "text"] [--undo]');
  if (!l.s.result) {
    // A running lane with an open blocker: acknowledge it by file, the supervisor clears it on the next tick.
    if (l.s.blocker && alive(l.s.pid)) { fs.writeFileSync(path.join(l.dir, 'BLOCKER_ACK'), String(now())); console.log(`${l.id}: blocker acknowledged (${l.s.blocker.kind})`); return; }
    die(`lane ${l.id} is not finished (${health(l.s)}): resume or stop it instead`, 2);
  }
  const undo = args.includes('--undo'); setAck(l.id, !undo, l.s.finishedAt || null, oneLine(note, 200));
  const b = bucketFor(l);
  console.log(`${l.id}: ${undo ? 'unseen again' : 'acknowledged'}; bucket ${b.bucket} (${b.reason})`);
}
export function cmdStop(args) {
  const l = controlTarget(args.find((a) => !a.startsWith('--')), 'stop');
  fs.writeFileSync(path.join(l.dir, 'STOP'), String(now()));
  if (!alive(l.s.pid)) { killTree(l.s.server?.pid); const s = l.s; s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)'; fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); console.log(`supervisor was gone; killed its server and marked ${l.id} stopped`); return; }
  console.log(`stop requested for ${l.id}; the supervisor aborts the session and writes the summary within a few seconds`);
}
// A resume logged on the plan that owns the lane, so the lead sees who continued what.
export function noteResume(l, by, note) {
  for (const r of plans()) {
    const p = readJSON(r.file) || {};
    const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
    if (!(p.lanes || []).some((pl) => laneId(path.resolve(base, pl.repo || '.'), pl.task) === l.id)) continue;
    (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Resumed ${l.id} from the ${by}${note ? ': ' + note : ''}` });
    try { fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n'); } catch {}
    return r.id;
  }
  return null;
}
// Resume a paused, failed, stopped or DEAD lane from anywhere (CLI, dashboard, MCP).
// CA_RESUME_DRY=1 answers with the argv without spawning (checks, cautious leads).
export function resumeLane(l, { note = '', by = 'ca resume' } = {}) {
  const s = l.s;
  if (s.result === 'done') return { error: `lane ${l.id} is done; nothing to resume`, code: 409 };
  if (!s.result && alive(s.pid)) return { error: `lane ${l.id} is still running (pid ${s.pid}); steer or stop it instead`, code: 409 };
  if (!fs.existsSync(path.join(l.repo, 'tasks', `${l.task}.md`))) return { error: `brief missing: tasks/${l.task}.md in ${l.repo}`, code: 409 };
  if (!s.result && !alive(s.pid)) {
    // DEAD supervisor: kill its server and close the old run before starting a new one.
    killTree(s.server?.pid);
    s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)';
    try { fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); } catch {}
  }
  if (note) { try { fs.mkdirSync(l.dir, { recursive: true }); fs.appendFileSync(path.join(l.dir, 'resume-note.txt'), `[${new Date().toISOString()} ${by}] ${note}\n`); } catch {} }
  noteResume(l, by, note);
  const argv = [CA_ENTRY, 'lane', l.repo, l.task, '--resume'];
  if (process.env.CA_RESUME_DRY === '1') return { ok: true, dry: true, argv, message: `would resume ${l.id} with: ${argv.join(' ')}` };
  const logFile = path.join(l.repo, 'tasks', `${l.task}.lane.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, CA_RESUMED_BY: by } });
  child.unref(); fs.closeSync(out); // the child keeps its own handle; the long-lived dashboard must not leak one per resume
  return { ok: true, dry: false, argv, message: `resumed ${l.id} (pid ${child.pid}); log: ${logFile}` };
}
export function cmdResume(args) {
  const ni = args.indexOf('--note');
  const note = ni >= 0 ? args.slice(ni + 1).filter((a) => a !== '--dry-run').join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : args.length).find((a) => !a.startsWith('--'));
  if (!q) die('usage: ca resume <lane> [--note "<text>"] [--dry-run]', 2);
  if (args.includes('--dry-run')) process.env.CA_RESUME_DRY = '1';
  const l = controlTarget(q, 'resume');
  const r = resumeLane(l, { note, by: 'ca resume' });
  if (r.error) die(r.error, 2);
  console.log(`CA_RESUME ${JSON.stringify({ lane: l.id, ok: true, dry: !!r.dry, argv: r.argv, message: r.message })}`);
}
// Queue a kick for a stuck turn. The supervisor consumes the file within 2 s (or at the next
// backoff poll): turn/now retry the turn, fresh starts a clean session, server restarts
// codearts serve, now also skips a backoff wait. Refused when the lane cannot act on it.
export function kickLane(l, { mode = 'turn', text = '', by = 'ca kick' } = {}) {
  const s = l.s;
  const need = { turn: ['kick'], now: ['kick', 'skip-wait'], fresh: ['fresh'], server: ['restart-server'] }[mode];
  if (!need) return { error: `unknown kick mode "${mode}" (turn, fresh, server or now)`, code: 400 };
  if (s.result) return { error: `lane ${l.id} already ${resultOf(s)}; use ca resume ${l.id} to continue it`, code: 409 };
  if (!alive(s.pid)) return { error: `lane ${l.id} is DEAD (supervisor not running); use ca resume ${l.id} instead`, code: 409 };
  const { actions } = laneActions({ s, alive: true, health: health(s), canResume: true });
  if (!need.some((n) => actions.includes(n))) return { error: `kick (${mode}) is not allowed while ${l.id} is in phase ${s.phase} (allowed: ${actions.join(', ') || 'nothing; wait or stop'})`, code: 409 };
  fs.mkdirSync(l.dir, { recursive: true });
  const file = path.join(l.dir, 'KICK');
  fs.writeFileSync(file, JSON.stringify({ at: now(), mode, text, by }));
  return { ok: true, file };
}
export function cmdKick(args) {
  const flags = { '--fresh': 'fresh', '--server': 'server', '--now': 'now' };
  let mode = 'turn'; const rest = [];
  for (const a of args) { if (flags[a]) mode = flags[a]; else rest.push(a); }
  const [q, ...msg] = rest;
  if (!q) die('usage: ca kick <lane> [--fresh|--server|--now] [message]', 2);
  const l = controlTarget(q, 'kick');
  const r = kickLane(l, { mode, text: msg.join(' ').trim(), by: 'ca kick' });
  if (r.error) die(r.error, 2);
  console.log(`CA_KICK ${JSON.stringify({ lane: l.id, ok: true, mode, file: r.file })}`);
  console.log(`kick (${mode}) queued for ${l.id}; the supervisor applies it within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
export function cmdGc() {
  for (const l of lanes()) if (l.s.result && now() - (l.s.finishedAt || 0) > 3 * 24 * 3600e3) { fs.rmSync(path.join(REG, `${l.id}.json`), { force: true }); fs.rmSync(path.join(REG, 'final', `${l.id}.json`), { force: true }); console.log(`forgot ${l.id}`); }
}

// ---------- remove lanes and plans ----------
// Delete a lane for good: stop its supervisor and its codearts server (only the pids this lane
// recorded, never by name), unregister it, drop its lane logs and mark it removed in every plan
// that listed it. The brief tasks/<task>.md and any git worktree or branch are never touched.
export async function removeLane(l, { purge = true, by = 'ca rm' } = {}) {
  if (!l || !l.id) return { error: 'no lane given', code: 400 };
  const id = l.id; const s = l.s || {};
  const killed = []; const stop = [];
  try {
    if (s.pid && alive(s.pid)) {
      try { fs.mkdirSync(l.dir, { recursive: true }); fs.writeFileSync(path.join(l.dir, 'STOP'), String(now())); } catch {}
      killTree(s.pid); killed.push(s.pid); stop.push(s.pid);
    }
    if (s.server?.pid && alive(s.server.pid)) { killTree(s.server.pid); killed.push(s.server.pid); stop.push(s.server.pid); }
    const t0 = now();
    while (now() - t0 < 5000 && stop.some((p) => alive(p))) await sleep(100);
    const removed = [];
    const drop = (f) => { try { if (f && fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); } } catch {} };
    drop(path.join(REG, `${id}.json`));
    drop(path.join(REG, 'final', `${id}.json`));
    const acks = readAcks();
    if (Object.prototype.hasOwnProperty.call(acks, id)) { const next = { ...acks }; delete next[id]; writeAcks(next); }
    if (purge) {
      try { if (l.dir && fs.existsSync(l.dir)) { fs.rmSync(l.dir, { recursive: true, force: true }); removed.push(l.dir); } } catch {}
      if (l.repo && l.task) drop(path.join(l.repo, 'tasks', `${l.task}.lane.log`));
    }
    for (const r of plans()) {
      const p = readJSON(r.file) || {};
      const base = path.resolve(path.dirname(r.file), '..', p.repo || '.');
      let changed = false;
      for (const pl of (p.lanes || [])) {
        if (pl && laneId(path.resolve(base, pl.repo || '.'), pl.task) === id) { pl.removed = true; changed = true; }
      }
      if (!changed) continue;
      (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Lane ${l.task} deleted from the ${by}` });
      try { fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n'); } catch {}
    }
    return { ok: true, id, killed, removed };
  } catch (err) { return { error: String((err && err.message) || err), code: 500 }; }
}

// Delete a plan for good: remove every lane it lists that is still registered (killing its
// processes and dropping its logs), then mark the plan file closed and removed and unregister it.
// The plan.json file is kept (marked removed), so a later lane start never resurrects it.
export async function removePlan(r, { by = 'ca plan rm' } = {}) {
  if (!r || !r.id) return { error: 'no plan given', code: 400 };
  try {
    const snapshot = readJSON(r.file) || {};
    const base = path.resolve(path.dirname(r.file), '..', snapshot.repo || '.');
  const reg = laneIndex();
    const wanted = (snapshot.lanes || []).filter(Boolean).map((pl) => laneId(path.resolve(base, pl.repo || '.'), pl.task));
    const laneIds = []; const killed = [];
    for (const id of wanted) {
      const l = reg.get(id); if (!l) continue;
      const res = await removeLane(l, { by });
      if (res && res.ok) { laneIds.push(id); killed.push(...(res.killed || [])); }
    }
    const p = readJSON(r.file) || snapshot;
    p.status = 'closed'; p.removed = true; p.now = `Deleted from the ${by}`;
    (p.decisions ||= []).push({ at: new Date().toISOString(), text: `Plan ${r.id} deleted from the ${by}` });
    try { fs.writeFileSync(r.file, JSON.stringify(p, null, 2) + '\n'); } catch {}
    try { fs.rmSync(path.join(PLANS, `${r.id}.json`), { force: true }); } catch {}
    return { ok: true, id: r.id, lanes: laneIds, killed };
  } catch (err) { return { error: String((err && err.message) || err), code: 500 }; }
}

// ca rm <lane> [--keep-logs]: delete a lane for good. findLane dies (exit 2) on an unknown or
// ambiguous lane, exactly like the other lane commands.
export async function cmdRm(args) {
  const keep = args.includes('--keep-logs');
  const q = args.filter((a) => !a.startsWith('--'))[0];
  const l = controlTarget(q, 'rm', 'usage: ca rm <lane> [--keep-logs]');
  const r = await removeLane(l, { purge: !keep, by: 'ca rm' });
  if (r.error) die(r.error, r.code || 1);
  console.log(`removed ${r.id}; killed [${r.killed.join(', ') || '-'}]; deleted [${r.removed.join(', ') || '(none)'}]`);
}

