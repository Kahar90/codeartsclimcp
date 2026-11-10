#!/usr/bin/env node
// ca: CodeArts lane supervisor and control CLI (no dependencies, Node 20+).
//
// A lane owns one private `codearts serve` (127.0.0.1, random port and password) in the repo,
// drives it over HTTP + SSE, and writes everything to <repo>/tasks/<task>.lane/:
//   state.json   live state (phase, activity, idle time, tokens, commits)  -> ca status / dash
//   live.log     readable transcript: replies, thinking, every tool call  -> ca tail / dash
//   events.jsonl raw server events (minus deltas and heartbeats), for debugging
//   summary.md   final report (also printed to stdout when the lane ends)
//   inbox/       steering messages queued by `ca steer` / the dashboard
//
// Reliability: a watchdog aborts and resumes a session after STALL_S without model activity
// (or TOOL_STALL_S on one tool call, or THINK_S of reasoning with no tool call), permission
// prompts are answered by policy so nothing waits forever, retries continue the SAME session
// (context kept), the runner itself runs the brief's CHECK: lines and the git-clean gate,
// and feeds failures back to the builder.
//
// usage: ca lane <repo> <task> [--detach] [--resume]  run a lane (foreground; --detach: background with a log;
//                                  --resume: continue a paused/stopped/failed lane in place, same id and step count,
//                                  plus the lead's notes from tasks/<task>.resume.md if present)
//        ca status [--json] [--all]        table of lanes (--json adds id, task, repo, result, progress)
//        ca wait <lane...> [--any] [--timeout S] [--json] [--compact] [--quiet] [--steps] [--after N|lane=N,...]
//                                  block until lanes end (--any: first); exit = worst lane
//                                  --steps also returns (exit 10, CA_STEP) when a lane commits a new step; pass the printed commits as --after next time
//        ca summary <lane> [--json]        final report of a lane (live status row while it runs)
//        ca init <repo> <task> [--goal "<text>"] [--force]  scaffold <repo>/tasks/<task>.md
//        ca brief-check <repo> <task> [--json]  lint the brief for problems a lead used to find by hand
//                                  (a protected file the brief changes, a CHECK that runs a missing file);
//                                  warnings never block a lane; --json prints {warnings: [...]}
//        ca workspace <repo> <task> [--from <branch>]   prepare a parallel lane workspace as a local
//                                  clone (../<repo-name>-wt-<task>) on branch lane/<task>; --land merges
//                                  that branch back into <repo> and deletes the clone
//        ca doctor [--json] [<repo>]       preflight: node, codearts, credentials, git, trust, shell
//        ca setup <harness> [repo] [--user]   write MCP + rules config for claude|kiro|cursor|codex|vscode|opencode
//        ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json]   guided first-run setup
//        ca update [--check] [--json] [--dry-run]   reinstall the latest version and refresh every
//                                  harness config; --check only reports whether a newer one exists
//        ca uninstall [--harness h] [--keys] [--dry-run]   remove exactly what setup added (and the keys with --keys)
//        ca auth [--wait [--timeout S]] [--status] [--stdin] [--no-open] [--json]   keys via a local browser form, never through chat
//        ca workflow                       print the lead workflow (docs/workflow.md)
//        ca mcp                            run the MCP server (runner/mcp.mjs), if installed
//        ca tail <lane> [-f] [-n N]        readable transcript
//        ca steer <lane> <message>         queue a message into the running session
//        ca attach <lane>                  open the CodeArts TUI on the live session (watch + type)
//        ca stop <lane>                    abort the session and end the lane
//        ca ack <lane> [--note t] [--undo]  mark a finished lane seen; a needs-you lane becomes handled (ended)
//        ca ack --stale [--older-than 48h] [--dry-run] [--note t]   mark every Needs-you lane older than that handled
//        ca kick <lane> [--fresh|--server|--now] [message]  unstick a stuck turn: retry it (default),
//                                  start a fresh session, restart the codearts server or skip a backoff
//        ca resume <lane> [--note "<text>"] [--dry-run]  continue a paused, failed, stopped or DEAD
//                                  lane in place (same id, tokens and history; the note waits in
//                                  the lane folder; --dry-run prints the argv without spawning)
//        ca dash [port]                    local web dashboard of all lanes (default 4777)
//        ca gc                             forget lanes finished more than 3 days ago
//        ca rm <lane> [--keep-logs]        delete a lane: kill its processes, unregister it and drop
//                                  its lane logs (--keep-logs keeps the lane dir and log; the brief is always kept)
//        ca plan [<plan.json>]             show the lead's plan on the dashboard (goal, waves, next)
//        ca plan list [--json] | close [id] [--reason t] | rm <id> [--keep-lanes]   plan state; close drops unstarted
//                                  lanes; rm kills and deletes the plan's lanes (--keep-lanes only unregisters)
//        ca plan update <id> --patch <json>   change plan fields (title, goal, now, status, phase, next, waves,
//                                  lanes, risks); bumps revision and updatedAt; refuses unknown fields
//        ca note [--now] [--plan <id>] [--phase <phase>] <text>   log a lead decision (--now: set the "lead is
//                                  doing" line; --phase: planning|building|waiting|verifying|asking|done)
//        ca lead-tokens [--plan id] [--session file]   point the plan at the lead's Claude transcript and print totals
//        ca lead-tokens --set <model> --input N --output N [--cache-read N] [--cache-write N] [--add]
//                                  report the lead's own token use on the plan (any harness; --add accumulates)
//        ca version | --version            the installed version and where it lives
//        ca help | -h | --help             this usage
//        Env knobs: THINK_FALLBACK_MODEL (builder model after 2 thinking stalls; brief line FALLBACK_MODEL:, none disables)
//        STALL_S=240 TOOL_STALL_S=900 THINK_S=480 (watchdogs: silent model, one tool
//        call, thinking with no tool call; THINK_S 0 disables) MAX_RETRIES=3 MAX_FIXES=3
//        LANE_TIMEOUT=5400 CHECK_TIMEOUT=900 NO_COMMIT_S=900 BUILD_MODEL REVIEW_MODEL NO_REVIEW=1
//        (NO_COMMIT_S: a running builder with no new commit this long raises a blocker the lead
//        sees at once; 0 disables)
//        NET_WAIT_S=1800 (a network error waits this long for the network instead of using a retry)
//        CA_MAX_LANES_PER_MODEL=maas/glm-5.3=2,default=4 (cap lanes per build model; glm 3,
//        others 4, "off" or 0 disables; a lane waits for a free slot before its build session)
//        Exit codes: 0 done (review ready or skipped), 1 failed/stopped/killed or checks failing,
//        2 usage or unknown lane, 3 missing credentials, 4 needs review or unverified (a check
//        could not run), 5 paused at LANE_TIMEOUT (resume with --resume), 10 a step was committed
//        (ca wait --steps; look at it and call again with --after), 11 a lane is blocked (a worker
//        question or no progress: ca wait prints CA_BLOCKED, answer with ca steer which clears it,
//        or ca ack to dismiss it), 124 wait timeout.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import authCmd from './auth.mjs';
import { EXE, HERE, INSTALL_HINT, PLANS, REG, SETTINGS, SKILL, ackNote, alive, briefWarningLines, briefWarningsFor, caEnv, compact, dashUrl, die, dur, findLane, fmtDur, git, health, hhmmss, killTree, laneAlive, laneId, laneIndex, laneMemoFor, laneSeen, lanes, lanesSnapshot, now, num, oneLine, pickOne, plans, plansSnapshot, projectOf, readAcks, readJSON, readJSONCached, resultOf, setAck, setReqSnap, sleep, stepProgress, userEnv, workerShell, writeAcks, writeAtomic, writeProbe } from './common.mjs';
import { GLYPHS, laneActions, laneBucket, laneKind, laneOutcome } from './controls.mjs';
import { ensureDash } from './dash-server.mjs';
import { cmdDetach, runLane } from './lane.mjs';
import { planClosed, planId, withPlanLock } from './plan.mjs';
import { sumTokens, tokenTotal, withTotal } from './tokens.mjs';

// ---------- control commands ----------
function laneHealthOf(l) { const m = laneMemoFor(l); if (m.health === undefined) m.health = health(l.s); return m.health; }
function bucketFor(l) {
  const m = laneMemoFor(l); if (m.bucket) return m.bucket;
  const s = l.s; const r = laneBucket({ s, alive: laneAlive(l), health: laneHealthOf(l) });
  let out;
  if (s.result && laneSeen(l.id, s.finishedAt)) {
    const note = ackNote(l.id); out = { bucket: r.bucket === 'attention' ? 'ended' : r.bucket, reason: `handled${note ? ': ' + note : ''} (was ${r.reason})`, handled: true };
  } else if (r.bucket === 'attention' && s.result && closedPlanLanes().has(l.id)) out = { bucket: 'ended', reason: r.reason, handled: false };
  else out = r;
  m.bucket = out; return out;
}
function bucketOf(l) { return bucketFor(l).bucket; }
// Lane ids that belong to a closed plan: their ended lanes need nothing from the human. Cached by the
// registered plans' ids and mtimes, so a poll over many lanes reads the plan files once.
let closedLanes = { key: null, ids: new Set() };
function closedPlanLanes() {
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
function laneStatusOf(l, s = l.s) {
  const r = bucketFor(l);
  const closed = !!s.result && closedPlanLanes().has(l.id);
  return laneOutcome({ s, health: health(s), handled: !!r.handled, note: r.handled ? ackNote(l.id) : '', closed });
}
// Lane kind for the Office characters; the brief is read once per change (mtime), not on every poll.
const kindCache = new Map();
function kindOf(l) {
  const bf = path.join(l.repo || '', 'tasks', `${l.task}.md`); let mt = 0; try { mt = fs.statSync(bf).mtimeMs; } catch {}
  const key = `${mt}|${(l.s.files || []).length}`; const c = kindCache.get(l.id);
  if (c && c.key === key) return c.kind;
  let brief = ''; try { brief = fs.readFileSync(bf, 'utf8'); } catch {}
  const kind = laneKind({ task: l.task, brief, files: l.s.files || [] }); kindCache.set(l.id, { key, kind }); return kind;
}
function laneRow(l) {
  const s = l.s; const end = s.finishedAt || now();
  return { lane: l.id, bucket: bucketOf(l), health: laneHealthOf(l), phase: s.phase, elapsed: dur(end - s.startedAt), idle: s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt)),
    commits: `${s.commits}/${s.steps}`, tokens: compact(tokenTotal(s.tokens)), steers: (s.steers || []).filter((x) => x.by !== 'runner notice').length, interrupts: s.interruptions?.length || 0, verdict: s.verdict || '', now: oneLine(s.activity, 70) };
}
// A status row for scripts: every laneRow field plus identity, result, progress and file paths.
function statusRow(l) {
  const s = l.s; const pg = stepProgress(s); const sm = path.join(l.dir, 'summary.md');
  return { ...laneRow(l), id: l.id, task: l.task, repo: l.repo, result: s.result || '', reason: s.reason || '', status: laneStatusOf(l),
    progress: { done: pg.done, total: pg.total, current: pg.current }, tokens: withTotal(s.tokens), tokensBy: tokensByView(s), tokensByModel: tokensByModelView(s),
    blocked: s.blocker || null, summaryPath: fs.existsSync(sm) ? sm : null, dashUrl: dashUrl() };
}
// cacheWrite bills into the totals but is not modeled by tokens.mjs (kept read-only): carry it here.
const tokTotal = (t) => (!t ? 0 : (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0));
function sumTok(list = []) {
  const r = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0 };
  for (const t of list || []) { if (!t) continue; r.input += t.input || 0; r.output += t.output || 0; r.reasoning += t.reasoning || 0; r.cacheRead += t.cacheRead || 0; r.cacheWrite += t.cacheWrite || 0; r.steps += t.steps || 0; }
  r.total = tokTotal(r); return r;
}
// One by-model row: who spent it and where the numbers come from. A lane whose steps ran but whose
// provider returned no usage is 'none' (unknown), never a false 0.
function modelRow(t, who, source) {
  const e = { input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, steps: t.steps || 0, who };
  e.total = tokTotal(e); e.source = (e.steps > 0 && e.total === 0) ? 'none' : source; return e;
}
function tokensByView(s) {
  return { build: withTotal(s.tokensBy?.build), review: withTotal(s.tokensBy?.review), other: withTotal(s.tokensBy?.other) };
}
function tokensByModelView(s) {
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
function printRows(rows) {
  const cols = ['lane', 'bucket', 'health', 'phase', 'elapsed', 'idle', 'commits', 'tokens', 'steers', 'interrupts', 'verdict', 'now'];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
}
// One line on stderr when a newer release is known and the cache is fresh; when the cache is missing
// or stale, start a detached background refresh (ca update --check --json) and never wait for it.
// CA_NO_UPDATE_CHECK=1 turns it off; --json output never carries it; a non-TTY stderr stays quiet
// unless CA_UPDATE_NOTICE=1. Wrapped so the notice can never slow or fail the command.
async function updateNotice(args) {
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
      try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    }
  } catch {}
}
function cmdStatus(args) {
  // Control room order: what needs a human first (attention), then running, done, ended.
  const rank = { attention: 0, running: 1, done: 2, ended: 3 };
  const all = lanes().filter((l) => args.includes('--all') || !l.s.result || now() - (l.s.finishedAt || 0) < 24 * 3600e3);
  const ls = all.map((l) => ({ l, b: bucketOf(l) })).sort((a, b) => (rank[a.b] ?? 9) - (rank[b.b] ?? 9)).map((x) => x.l);
  if (args.includes('--json')) { console.log(JSON.stringify(ls.map(statusRow), null, 2)); return; }
  const rows = ls.map(laneRow);
  if (!rows.length) { console.log('no lanes (ca status --all for older ones)'); return; }
  printRows(rows);
}
function cmdSummary(args) {
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
async function cmdTail(args) {
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
function steer(l, text) {
  if (l.s.result) return { error: `lane ${l.id} already ${l.s.result}`, code: 409 };
  if (!alive(l.s.pid)) return { error: `lane ${l.id} supervisor is not running`, code: 409 };
  fs.mkdirSync(path.join(l.dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(l.dir, 'inbox', `${now()}-${crypto.randomBytes(3).toString('hex')}.txt`), text);
  return { ok: true };
}
function cmdSteer(args) {
  const [q, ...rest] = args; if (!q || !rest.length) die('usage: ca steer <lane> <message>', 2);
  const l = findLane(q); const r = steer(l, rest.join(' '));
  if (r.error) die(r.error, 2);
  console.log(`queued for ${l.id}; it goes into the session within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
function cmdAttach(args) {
  const l = findLane(args[0]); const s = l.s;
  if (s.result || !s.server) die(`lane ${l.id} is ${s.result || 'not started'}; nothing to attach to`, 2);
  const sid = s.activeSession || s.buildSession;
  console.log(`attaching to ${l.id} session ${sid} at ${s.server.url}. Typing here steers the builder; leave the TUI with ctrl+c (the lane keeps running).`);
  const r = spawnSync(EXE, ['attach', s.server.url, '-s', sid, '-p', s.server.pw], { stdio: 'inherit', env: caEnv() });
  process.exit(r.status ?? 0);
}
// Parse a CLI duration for --older-than: a number followed by m, h or d (for example 30m, 48h, 2d).
// Anything else is null so the caller can raise a usage error.
function parseAge(v) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3);
}
// ca ack --stale: mark every finished Needs-you lane older than the given age handled in one go.
// Only finished lanes are selected; running, stalled and DEAD lanes are never touched.
function ackStale(args) {
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
function cmdAck(args) {
  if (args.includes('--stale')) return ackStale(args);
  const ni = args.indexOf('--note'); const note = ni >= 0 ? args.slice(ni + 1).join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : undefined).find((a) => !a.startsWith('--'));
  if (!q) die('usage: ca ack <lane> [--note "text"] [--undo]', 2);
  const l = findLane(q);
  if (!l.s.result) {
    // A running lane with an open blocker: acknowledge it by file, the supervisor clears it on the next tick.
    if (l.s.blocker && alive(l.s.pid)) { fs.writeFileSync(path.join(l.dir, 'BLOCKER_ACK'), String(now())); console.log(`${l.id}: blocker acknowledged (${l.s.blocker.kind})`); return; }
    die(`lane ${l.id} is not finished (${health(l.s)}): resume or stop it instead`, 2);
  }
  const undo = args.includes('--undo'); setAck(l.id, !undo, l.s.finishedAt || null, oneLine(note, 200));
  const b = bucketFor(l);
  console.log(`${l.id}: ${undo ? 'unseen again' : 'acknowledged'}; bucket ${b.bucket} (${b.reason})`);
}
function cmdStop(args) {
  const l = findLane(args[0]);
  fs.writeFileSync(path.join(l.dir, 'STOP'), String(now()));
  if (!alive(l.s.pid)) { killTree(l.s.server?.pid); const s = l.s; s.result = s.result || 'stopped'; s.phase = 'finished'; s.finishedAt = s.finishedAt || now(); s.activity = 'stopped (supervisor had died)'; fs.writeFileSync(path.join(l.dir, 'state.json'), JSON.stringify(s, null, 2)); console.log(`supervisor was gone; killed its server and marked ${l.id} stopped`); return; }
  console.log(`stop requested for ${l.id}; the supervisor aborts the session and writes the summary within a few seconds`);
}
// A resume logged on the plan that owns the lane, so the lead sees who continued what.
function noteResume(l, by, note) {
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
function resumeLane(l, { note = '', by = 'ca resume' } = {}) {
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
  const argv = [fileURLToPath(import.meta.url), 'lane', l.repo, l.task, '--resume'];
  if (process.env.CA_RESUME_DRY === '1') return { ok: true, dry: true, argv, message: `would resume ${l.id} with: ${argv.join(' ')}` };
  const logFile = path.join(l.repo, 'tasks', `${l.task}.lane.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, CA_RESUMED_BY: by } });
  child.unref(); fs.closeSync(out); // the child keeps its own handle; the long-lived dashboard must not leak one per resume
  return { ok: true, dry: false, argv, message: `resumed ${l.id} (pid ${child.pid}); log: ${logFile}` };
}
function cmdResume(args) {
  const ni = args.indexOf('--note');
  const note = ni >= 0 ? args.slice(ni + 1).filter((a) => a !== '--dry-run').join(' ').trim() : '';
  const q = args.slice(0, ni >= 0 ? ni : args.length).find((a) => !a.startsWith('--'));
  if (!q) die('usage: ca resume <lane> [--note "<text>"] [--dry-run]', 2);
  if (args.includes('--dry-run')) process.env.CA_RESUME_DRY = '1';
  const l = findLane(q);
  const r = resumeLane(l, { note, by: 'ca resume' });
  if (r.error) die(r.error, 2);
  console.log(`CA_RESUME ${JSON.stringify({ lane: l.id, ok: true, dry: !!r.dry, argv: r.argv, message: r.message })}`);
}
// Queue a kick for a stuck turn. The supervisor consumes the file within 2 s (or at the next
// backoff poll): turn/now retry the turn, fresh starts a clean session, server restarts
// codearts serve, now also skips a backoff wait. Refused when the lane cannot act on it.
function kickLane(l, { mode = 'turn', text = '', by = 'ca kick' } = {}) {
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
function cmdKick(args) {
  const flags = { '--fresh': 'fresh', '--server': 'server', '--now': 'now' };
  let mode = 'turn'; const rest = [];
  for (const a of args) { if (flags[a]) mode = flags[a]; else rest.push(a); }
  const [q, ...msg] = rest;
  if (!q) die('usage: ca kick <lane> [--fresh|--server|--now] [message]', 2);
  const l = findLane(q);
  const r = kickLane(l, { mode, text: msg.join(' ').trim(), by: 'ca kick' });
  if (r.error) die(r.error, 2);
  console.log(`CA_KICK ${JSON.stringify({ lane: l.id, ok: true, mode, file: r.file })}`);
  console.log(`kick (${mode}) queued for ${l.id}; the supervisor applies it within 2 s (phase ${l.s.phase}). Follow: ca tail ${l.id} -f`);
}
function cmdGc() {
  for (const l of lanes()) if (l.s.result && now() - (l.s.finishedAt || 0) > 3 * 24 * 3600e3) { fs.rmSync(path.join(REG, `${l.id}.json`), { force: true }); fs.rmSync(path.join(REG, 'final', `${l.id}.json`), { force: true }); console.log(`forgot ${l.id}`); }
}

// ---------- remove lanes and plans ----------
// Delete a lane for good: stop its supervisor and its codearts server (only the pids this lane
// recorded, never by name), unregister it, drop its lane logs and mark it removed in every plan
// that listed it. The brief tasks/<task>.md and any git worktree or branch are never touched.
async function removeLane(l, { purge = true, by = 'ca rm' } = {}) {
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
async function removePlan(r, { by = 'ca plan rm' } = {}) {
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
async function cmdRm(args) {
  const keep = args.includes('--keep-logs');
  const q = args.filter((a) => !a.startsWith('--'))[0];
  const l = findLane(q);
  const r = await removeLane(l, { purge: !keep, by: 'ca rm' });
  if (r.error) die(r.error, r.code || 1);
  console.log(`removed ${r.id}; killed [${r.killed.join(', ') || '-'}]; deleted [${r.removed.join(', ') || '(none)'}]`);
}

// ---------- engineer workflow: setup, wait, summary, init, doctor ----------
async function cmdSetup(args) {
  const f = path.join(HERE, 'setup.mjs');
  if (!fs.existsSync(f)) die('setup not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('setup.mjs has no default export', 2);
  await mod.default(args);
}
// `ca auth ...`: get the keys from the human through a local form (runner/auth.mjs).
async function cmdAuth(args) { await authCmd(args); }
// `ca onboard ...`: guided first-run setup, implemented in runner/onboard.mjs.
async function cmdOnboard(args) {
  const f = path.join(HERE, 'onboard.mjs');
  if (!fs.existsSync(f)) die('onboard not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('onboard.mjs has no default export', 2);
  await mod.default(args);
}
// Exit code of a finished lane, from the usage table: 0 done (review ready or skipped),
// 1 failed/stopped/killed, 3 missing credentials, 4 needs review.
function laneExit(s) {
  if (s.result === 'done') return !s.verdict || s.verdict === 'ready' ? 0 : 4;
  if (s.result === 'needs review') return 4;
  if (s.result === 'unverified') return 4;
  if (resultOf(s) === 'paused') return 5;
  if (s.result === 'failed' && s.exitCode === 3) return 3;
  return 1;
}
const exitRank = (c) => ({ 1: 4, 3: 3, 5: 2, 4: 1 }[c] ?? 0);
const worstExit = (codes) => codes.reduce((a, b) => (exitRank(b) > exitRank(a) ? b : a), 0);
// The compact `ca wait --json --compact` row: only what a lead needs to decide and call again, so the
// context stays small when many lanes are watched. `next` is the per-lane action for its exit code.
const WAIT_NEXT = {
  0: 'read ca_summary for each lane and verify the work',
  1: 'read ca_summary; ca_resume continues a failed, stopped or checks-failing lane with a note',
  3: 'keys missing or rejected: ask the human to run ca auth (never ask for keys in chat), then ca_resume the lane',
  4: 'read ca_summary: the reviewer asked for changes, or the checks could not run (unverified)',
  5: 'paused at LANE_TIMEOUT: ca_resume the lane to continue where it stopped',
  124: 'still running: call ca wait again',
};
function compactWaitRow(l, s) {
  const st = laneStatusOf(l, s); const pg = stepProgress(s);
  return { lane: l.id, status: { key: st.key, label: st.label, attention: st.attention }, progress: `${pg.done}/${pg.total}`,
    commits: s.commits || 0, tokens: tokenTotal(s.tokens), next: WAIT_NEXT[s.result ? laneExit(s) : 124] || '' };
}
// --steps: the lead wakes when a lane commits a NEW step instead of only when the lane ends, so it can
// look at the step (screenshot the ui files) and steer early. stepOf reads "step N" from a commit subject
// (null when the subject is not a step). stepFiles is the diff of the first new commit's parent against the
// last new commit, capped at 50 (a step that rewrites many files still fits one line); empty when the repo
// is gone or the first new commit has no parent.
const UI_EXT = /\.(html|css|js|mjs|ts|tsx|jsx|vue|svelte|svg|png)$/i;
const stepOf = (subject) => { const m = String(subject || '').match(/^\s*step\s+(\d+)\s*:/i); return m ? Number(m[1]) : null; };
function stepFiles(repo, fresh) {
  if (!fresh.length) return [];
  const first = fresh[0].hash; const last = fresh[fresh.length - 1].hash;
  const out = git(repo, 'diff', '--name-only', `${first}^`, last);
  return out ? out.split(/\r?\n/).filter(Boolean).slice(0, 50) : [];
}
// The lane's commit log read live from the lane repo: state.json is refreshed by the supervisor at most
// every 5 s inside a turn, so a step committed shortly before the lane ends can be invisible there and the
// finished-lane rule would win. git is the source of truth; fall back to state.json only without a start.
function liveLog(l, s) {
  if (!l.repo || !s || !s.start) return (s && s.commitLog) || [];
  const out = git(l.repo, 'log', '--reverse', '--format=%h%x09%s', `${s.start}..HEAD`);
  if (!out) return [];
  return out.split(/\r?\n/).map((ln) => { const [hash, ...r] = ln.split('\t'); return { hash, subject: oneLine(r.join(' '), 160) }; });
}
function stepEvent(l, log, base) {
  const fresh = log.slice(base);
  const files = stepFiles(l.repo, fresh);
  return { lane: l.id, commits: log.length, new: fresh.map((c) => ({ hash: c.hash, subject: c.subject, step: stepOf(c.subject) })), files, ui: files.some((f) => UI_EXT.test(f)) };
}
async function cmdWait(args) {
  const asJson = args.includes('--json'); const quiet = args.includes('--quiet');
  // --compact: with --json, return only the small per-lane decision rows a lead reads when many lanes
  // run at once. MCP ca_wait turns it on by default.
  const wantCompact = args.includes('--compact');
  // --any returns as soon as one lane has a result, so a lead watching parallel lanes sees an early
  // failure at once instead of waiting for the slowest lane. Others are listed as still running.
  const any = args.includes('--any');
  const usage = 'usage: ca wait <lane...> [--any] [--timeout S] [--json] [--compact] [--quiet] [--steps] [--after N|lane=N,...]';
  const ti = args.indexOf('--timeout');
  const timeoutS = ti >= 0 ? Number(args[ti + 1]) : NaN;
  if (ti >= 0 && (!Number.isFinite(timeoutS) || timeoutS < 0)) die(usage, 2);
  // --steps wakes the lead at each new commit; --after sets the baseline (a count for every lane, or a
  // lane=count list). A bad value is a usage error, with or without --steps.
  const stepsMode = args.includes('--steps');
  const ai = args.indexOf('--after');
  const afterRaw = ai >= 0 ? args[ai + 1] : '';
  let afterCount = null; let afterMap = null;
  if (ai >= 0) {
    if (!afterRaw || afterRaw.startsWith('--')) die(usage, 2);
    if (/^\d+$/.test(afterRaw)) afterCount = Number(afterRaw);
    else { afterMap = {}; for (const part of afterRaw.split(',')) { const m = part.match(/^(.+)=(\d+)$/); if (!m) die(usage, 2); afterMap[m[1]] = Number(m[2]); } }
  }
  const qs = args.filter((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1) && !(ai >= 0 && i === ai + 1));
  if (!qs.length) die(usage, 2);
  const targets = qs.map((q) => findLane(q)); // resolve every lane first: unknown -> exit 2
  const readState = (l) => readJSON(path.join(l.dir, 'state.json')) || l.s;
  // Baseline per lane: the --after value (keyed by lane id or task name), or the live commit count at wait
  // start, read the same way the loop compares it (git), so a resumed lane whose state.json count was reset
  // does not report its old commits as new.
  const baseline = new Map();
  const afterFor = (l) => { if (!afterMap) return undefined; for (const k of [l.id, l.task]) if (k && Object.prototype.hasOwnProperty.call(afterMap, k)) return afterMap[k]; return undefined; };
  for (const l of targets) { const a = afterFor(l); baseline.set(l.id, afterCount !== null ? afterCount : a !== undefined ? a : liveLog(l, readState(l)).length); }
  const deadline = Number.isFinite(timeoutS) && timeoutS > 0 ? now() + timeoutS * 1000 : Infinity;
  const last = new Map(); let lastBeat = 0;
  const note = (l, s) => {
    const pg = stepProgress(s);
    process.stderr.write(`[${hhmmss()}] ${l.id} ${health(s)} phase ${s.phase} step ${pg.done}/${pg.total} idle ${s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt))} now ${oneLine(s.activity, 70)}\n`);
  };
  for (;;) {
    const states = targets.map((l) => {
      const s = readState(l);
      return { l, s: !s.result && !alive(s.pid) ? { ...s, result: 'failed', reason: 'supervisor gone' } : s };
    });
    for (const { l, s } of states) {
      const pg = stepProgress(s);
      const key = `${health(s)}|${s.phase}|${pg.current?.n ?? ''}`;
      if (last.get(l.id) !== key) { last.set(l.id, key); if (!quiet) note(l, s); }
    }
    const finished = states.filter(({ s }) => s.result);
    if (any ? finished.length > 0 : states.every(({ s }) => s.result)) {
      const objs = finished.map(({ l, s }) => ({ lane: l.id, result: s.result, status: laneStatusOf(l, s), verdict: s.verdict || '', exit: laneExit(s),
        summaryPath: fs.existsSync(path.join(l.dir, 'summary.md')) ? path.join(l.dir, 'summary.md') : null }));
      const runningStates = states.filter(({ s }) => !s.result);
      const running = runningStates.map(({ l }) => l);
      for (const o of objs) process.stdout.write(`CA_RESULT ${JSON.stringify(o)}\n`);
      if (asJson) {
        const lanes = wantCompact ? finished.map(({ l, s }) => compactWaitRow(l, s)) : objs;
        const run = wantCompact ? runningStates.map(({ l, s }) => compactWaitRow(l, s)) : running.map(statusRow);
        process.stdout.write(JSON.stringify(any ? { lanes, any: true, running: run } : { lanes }) + '\n');
      } else if (any && running.length) process.stdout.write(`still running: ${running.map((l) => l.id).join(', ')}\n`);
      process.exit(worstExit(objs.map((o) => o.exit)));
    }
    // Blocked rule: a running lane with an open blocker reaches the lead at once (exit 11), so a worker's
    // question or a silent run is answered long before the lane ends. The finished-lane rule above wins.
    const blockedStates = states.filter(({ l, s }) => !s.result && s.blocker);
    if (blockedStates.length) {
      const blocked = blockedStates.map(({ l, s }) => ({ lane: l.id, kind: s.blocker.kind, text: s.blocker.text, at: s.blocker.at }));
      for (const o of blocked) process.stdout.write(`CA_BLOCKED ${JSON.stringify(o)}\n`);
      if (asJson) {
        const running = states.filter(({ s }) => !s.result && !s.blocker).map(({ l, s }) => (wantCompact ? compactWaitRow(l, s) : statusRow(l)));
        process.stdout.write(JSON.stringify({ blocked, running }) + '\n');
      }
      process.exit(11);
    }
    // --steps: a lane that passed its baseline has a new step. Wake the lead with one CA_STEP line per
    // such lane and exit 10; the finished-lane rule above wins, so an ended lane still reports its result.
    if (stepsMode) {
      const evs = states.map(({ l, s }) => ({ l, log: liveLog(l, s) })).filter(({ l, log }) => log.length > baseline.get(l.id)).map(({ l, log }) => stepEvent(l, log, baseline.get(l.id)));
      if (evs.length) {
        for (const o of evs) process.stdout.write(`CA_STEP ${JSON.stringify(o)}\n`);
        if (asJson) {
          const hit = new Set(evs.map((o) => o.lane));
          process.stdout.write(JSON.stringify({ steps: evs, running: states.filter(({ l }) => !hit.has(l.id)).map(({ l, s }) => compactWaitRow(l, s)) }) + '\n');
        }
        process.exit(10);
      }
    }
    if (now() >= deadline) {
      const runningStates = states.filter(({ s }) => !s.result);
      const running = runningStates.map(({ l }) => l);
      if (asJson) console.log(JSON.stringify({ timeout: true, waitedS: timeoutS, lanes: wantCompact ? runningStates.map(({ l, s }) => compactWaitRow(l, s)) : running.map(statusRow) }));
      else { console.log(`wait: timeout after ${timeoutS}s; still running:`); printRows(running.map(laneRow)); }
      process.exit(124);
    }
    if (!lastBeat) lastBeat = now();
    else if (now() - lastBeat >= 60000) { lastBeat = now(); if (!quiet) for (const { l, s } of states) if (!s.result) note(l, s); }
    // --steps polls faster: a step commit can be followed by the lane ending well inside the 2 s poll
    // window, and the finished-lane rule would then win over the step event. 500 ms keeps the lead ahead.
    await sleep(Math.min(stepsMode ? 500 : 2000, deadline - now()));
  }
}
function cmdInit(args) {
  const gi = args.indexOf('--goal');
  const goal = gi >= 0 ? args[gi + 1] : '';
  if (gi >= 0 && !goal) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1));
  const [repoArg, task] = pos;
  if (!repoArg || !task) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const repo = path.resolve(repoArg);
  const file = path.join(repo, 'tasks', `${task}.md`);
  if (fs.existsSync(file) && !args.includes('--force')) die(`${file} exists (use --force to overwrite)`, 2);
  const tpl = fs.readFileSync(path.join(SKILL, 'templates', 'brief.md'), 'utf8');
  fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.writeFileSync(file, tpl.replace(/<one sentence goal[^>]*>/, goal || 'TODO: goal'));
  console.log(`brief: ${file}`);
  if (!git(repo, 'rev-parse', '--git-dir')) console.log('not a git repo yet: run git init && git commit --allow-empty -m init');
  console.log(`next: ca lane ${repoArg} ${task} --detach`);
  console.log(`      ca wait ${laneId(repo, task)}`);
}
// `ca brief-check <repo> <task> [--json]`: print the brief warnings a lead should fix before a lane
// starts. Warnings never block a lane; the command always exits 0, so a missing brief just has none.
function cmdBriefCheck(args) {
  const asJson = args.includes('--json');
  const [repoArg, task] = args.filter((a) => !a.startsWith('--'));
  if (!repoArg || !task) die('usage: ca brief-check <repo> <task> [--json]', 2);
  const repo = path.resolve(repoArg);
  const warnings = briefWarningsFor(repo, task) || [];
  if (asJson) { console.log(JSON.stringify({ warnings }, null, 2)); return; }
  if (!warnings.length) console.log('brief: no warnings');
  else for (const t of briefWarningLines(warnings)) console.log(`brief warning: ${t}`);
}
// `ca workspace <repo> <task>`: prepare a parallel lane workspace as a LOCAL CLONE
// (../<repo-name>-wt-<task>) on a new branch lane/<task>, from --from (default: the repo's current
// branch). A clone keeps .git inside the lane folder, so the CodeArts sandbox can commit there; a
// git worktree keeps its git dir in the main repo (outside the folder) and every sandboxed commit
// fails with "Permission denied". `--land` fetches lane/<task> from the clone into <repo>, merges it
// (refusing on a dirty main tree), then deletes the clone folder.
function cmdWorkspace(args) {
  const usage = 'usage: ca workspace <repo> <task> [--from <branch>] | ca workspace --land <repo> <task>';
  const land = args.includes('--land');
  const fi = args.indexOf('--from');
  const from = fi >= 0 ? args[fi + 1] : '';
  if (fi >= 0 && (!from || from.startsWith('--'))) die(usage, 2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1));
  const [repoArg, task] = pos;
  if (!repoArg || !task) die(usage, 2);
  const repo = path.resolve(repoArg);
  if (!git(repo, 'rev-parse', '--git-dir')) die(`not a git repo: ${repo}`, 2);
  const branch = `lane/${task}`;
  const clone = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${task}`);
  const run = (cwd, ...gargs) => spawnSync('git', gargs, { cwd, encoding: 'utf8', windowsHide: true });
  const fail = (what, r) => die(`${what}: ${oneLine(String((r.stderr || '') + (r.stdout || '')).trim(), 300)}`, 1);
  if (land) {
    if (!fs.existsSync(clone)) die(`no workspace to land: ${clone}`, 2);
    // tasks/ holds the plan and lane logs the lead and runner update while lanes run: they never block a land.
    const dirtyTree = git(repo, 'status', '--porcelain', '--', '.', ':!tasks');
    if (dirtyTree) die(`main tree is dirty in ${repo}: commit or stash first, then land\n${oneLine(dirtyTree, 200)}`, 1);
    const f = run(repo, 'fetch', clone, branch);
    if (f.status !== 0) fail('git fetch failed', f);
    const m = run(repo, 'merge', '--no-ff', 'FETCH_HEAD');
    if (m.status !== 0) die(`git merge failed (resolve it in ${repo}): ${oneLine(String((m.stderr || '') + (m.stdout || '')).trim(), 300)}`, 1);
    fs.rmSync(clone, { recursive: true, force: true });
    console.log(`landed ${branch} into ${repo}`);
    console.log(`removed ${clone}`);
    const log = git(repo, 'log', '--oneline', '-1');
    if (log) console.log(`head: ${log}`);
    return;
  }
  if (fs.existsSync(clone)) die(`workspace already exists: ${clone} (land or remove it first)`, 2);
  const c = run(path.dirname(repo), 'clone', '--local', '--no-hardlinks', repo, clone);
  if (c.status !== 0) fail('git clone failed', c);
  // The clone carries the source branches as origin/<name>; a sha needs the plain name, so fall back.
  const start = from || git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') || 'HEAD';
  let b = run(clone, 'checkout', '-b', branch, `origin/${start}`);
  if (b.status !== 0) b = run(clone, 'checkout', '-b', branch, start);
  if (b.status !== 0) fail('git checkout failed', b);
  // A brief the repo has not committed yet is not in the clone: copy it so the lane can read it.
  const briefSrc = path.join(repo, 'tasks', `${task}.md`);
  const briefDst = path.join(clone, 'tasks', `${task}.md`);
  if (fs.existsSync(briefSrc) && !fs.existsSync(briefDst)) { fs.mkdirSync(path.dirname(briefDst), { recursive: true }); fs.copyFileSync(briefSrc, briefDst); }
  console.log(`workspace: ${clone}`);
  console.log(`branch: ${branch} (from ${from || start})`);
  console.log(`start the lane: ca lane ${clone} ${task} --detach`);
  console.log(`merge back: git -C ${repo} fetch ${clone} ${branch} && git -C ${repo} merge --no-ff FETCH_HEAD`);
  console.log(`or: ca workspace --land ${repoArg} ${task}`);
}
// Preflight for engineers and agents: every row is ok | warn | fail, secrets are never printed.
// Shared by `ca doctor` and the dashboard's GET /api/doctor (same function, no subprocess).
async function doctorData(repoArg) {
  const repo = path.resolve(repoArg || process.cwd());
  const rows = [];
  const add = (name, status, detail, fix = '') => rows.push({ name, status, detail, fix });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? '' : 'install Node 20 or newer');

  // One --version call per doctor run: the codearts version row reuses it (each call costs about a second).
  let caVersion = null;
  const firstLine = (s) => (String(s || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
  if (!fs.existsSync(EXE)) add('codearts', 'fail', `not found at ${EXE}`, `install the CodeArts CLI: ${INSTALL_HINT}`);
  else {
    const r = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000, env: caEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const v = oneLine(((r.stdout || '') + ' ' + (r.stderr || '')).trim(), 120);
    if (r.status === 0) { caVersion = firstLine(r.stdout) || firstLine(r.stderr); add('codearts', 'ok', v || 'installed (no --version output)'); }
    else add('codearts', 'warn', r.error ? `could not run: ${oneLine(r.error.message, 100)}` : `--version exited ${r.status ?? '?'}${v ? ': ' + v : ''}`, 'run the codearts exe manually to check the install');
  }

  const missCred = [!userEnv('CODEARTS_CLI_AK') && 'CODEARTS_CLI_AK', !userEnv('CODEARTS_CLI_SK') && 'CODEARTS_CLI_SK'].filter(Boolean);
  add('credentials', missCred.length ? 'fail' : 'ok', missCred.length ? `missing ${missCred.join(', ')}` : 'set',
    missCred.length ? 'run: ca auth (local browser form; values are never printed)' : '');

  add('maas key', userEnv('MAAS_API_KEY') ? 'ok' : 'warn', userEnv('MAAS_API_KEY') ? 'set' : 'not set, falls back to CodeArts quota models',
    userEnv('MAAS_API_KEY') ? '' : 'ca auth --force adds MAAS_API_KEY for the MaaS models');

  const g = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  add('git', g.status === 0 ? 'ok' : 'fail', oneLine(((g.stdout || '') + (g.stderr || '')).trim(), 120) || 'git not found', g.status === 0 ? '' : 'install git');

  const settings = readJSON(SETTINGS) || {};
  const trusted = [].concat(settings.security?.trustedFolders || []).map(String);
  const underTrusted = (p) => { const a = path.resolve(p).toLowerCase(); return trusted.some((f) => { const b = path.resolve(f).toLowerCase(); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }); };
  add('trusted folder', underTrusted(repo) ? 'ok' : 'warn', underTrusted(repo) ? `${repo} is trusted` : `${repo} is not in security.trustedFolders`,
    underTrusted(repo) ? '' : `node ${path.join(SKILL, 'scripts', 'trust.mjs')} ${repo} (a ca lane run trusts the repo too)`);

  const sh = workerShell();
  const shOk = !!(sh && fs.existsSync(sh));
  add('shell', shOk ? 'ok' : 'fail', sh || 'no SHELL set', shOk ? '' : 'set SHELL or CA_SHELL to Git bash (Git\\bin\\bash.exe)');

  // A repo the lane cannot write to fails every commit, so nothing else works: fail the row hard.
  // A git worktree is writable by the runner but its git dir lives in the main repo, outside the lane
  // folder the CodeArts sandbox confines the worker to: warn so the lead uses a clone instead.
  const wp = writeProbe(repo);
  if (wp.worktree) {
    add('repo writable', 'warn', `git dir is outside the lane folder (${git(repo, 'rev-parse', '--absolute-git-dir')})`,
      'this is a git worktree: its git dir is outside the lane folder, so the CodeArts sandbox refuses commits; use `ca workspace` (a local clone) instead');
  } else {
    add('repo writable', wp.ok ? 'ok' : 'fail', wp.ok ? `wrote and removed a probe in ${repo}` : `${wp.where}: ${wp.error}`,
      wp.ok ? '' : process.platform === 'win32'
        ? 'Windows Controlled Folder Access or a sandbox ACL is blocking writes: allow git, Git Bash and node in Defender (Controlled Folder Access, Allow an app) or move the repo out of Documents'
        : 'check the folder permissions');
  }

  try {
    const r = await fetch(`${dashUrl()}/api/lanes`, { signal: AbortSignal.timeout(1500) });
    add('dashboard', r.ok ? 'ok' : 'warn', r.ok ? `running at ${dashUrl()}` : `HTTP ${r.status}`, r.ok ? '' : 'ca dash (lanes start it on demand)');
  } catch { add('dashboard', 'warn', 'not running, starts on demand', 'ca dash (lanes start it on demand)'); }

  const chromeCands = [process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const chromePath = chromeCands.find((c) => fs.existsSync(c));
  add('chrome', chromePath ? 'ok' : 'warn', chromePath || 'not found (optional, used by browser checks)', chromePath ? '' : 'install Google Chrome for the office and sprite checks');

  // Install lifecycle: recorded harness configs still pointing at this ca.mjs, and the installed
  // CodeArts version vs the last smoke-tested one. A broken lifecycle.mjs must never break doctor.
  try {
    const { lifecycleRows } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
    for (const row of await lifecycleRows({ version: caVersion })) rows.push(row);
  } catch {}

  const fails = rows.filter((r) => r.status === 'fail').length;
  return { checks: rows, fails };
}
async function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const { checks, fails } = await doctorData(args.filter((a) => !a.startsWith('--'))[0]);
  if (asJson) console.log(JSON.stringify({ checks }, null, 2));
  else {
    // One readable line per row; the fix (if any) sits under it. No padded table.
    for (const r of checks) {
      console.log(`  ${String(r.status).padEnd(5)}  ${r.name}: ${r.detail}`);
      if (r.status !== 'ok' && r.fix) console.log(`         fix: ${r.fix}`);
    }
    console.log(`doctor: ${fails ? `not ready (${fails} fail)` : 'ready'}`);
  }
  if (fails) { await updateNotice(args); process.exit(1); }
}
async function cmdMcp() {
  const f = path.join(HERE, 'mcp.mjs');
  if (!fs.existsSync(f)) die('mcp server not installed', 2);
  await import(pathToFileURL(f).href);
}

// ---------- the lead's plan (written by Claude, shown on the dashboard) ----------
// The lead phase a note may report: a small closed set the views render as a badge.
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
async function cmdPlan(args) {
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
function cmdNote(args) {
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
function cmdLeadTokens(args) {
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
function laneView(l) {
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
// Anything a human must look at, plus the ended-without-a-result states the old badge read the same way.
const attnKey = (k) => ['checks failing', 'failed', 'unverified', 'stopped', 'killed'].includes(k);
// One glance state per plan, so a person across the room can tell at once whether the work is
// running, done, failed or waiting on them. Pure: it reads only the plan view it is handed.
const QUIET_MS = 15 * 60e3;
const GLANCE_WORD = { working: 'Working', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done', quiet: 'Check Claude', idle: 'Idle' };
// The tone and glyph a glance state maps to (status contract part 2): the plan badge is exactly the
// glance word, tone and glyph, so every pill in both views shows the same thing (never a page guess).
const GLANCE_TONE = { working: 'run', 'needs-you': 'warn', failed: 'bad', done: 'done', quiet: 'warn', idle: 'idle' };
const GLANCE_GLYPH = { working: GLYPHS.working, 'needs-you': GLYPHS['needs-you'], failed: GLYPHS.failed, done: GLYPHS.done, quiet: '?', idle: GLYPHS.idle };
const glanceBad = (k) => k === 'failed' || k === 'checks failing' || k === 'killed';
const glanceDur = (ms) => ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))}m` : ms < 86400e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
function glanceOf(view) {
  const lanes = (view.waves || []).flatMap((w) => w.lanes || []).filter((x) => x.result !== 'dropped');
  const lead = view.lead || {};
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
  if (phase === 'asking') return out('needs-you', `Claude is asking: ${lastText || view.now || ''}`, lead.nowAt || lead.updatedAt || null);
  // c. the lead reports done.
  if (phase === 'done') return out('done', lastText || 'Claude is done', atIso(Math.max(leadMs, laneMs)));
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
  if (age !== null && age < QUIET_MS && ['planning', 'building', 'waiting', 'verifying'].includes(phase)) return out('working', `Claude is ${phase}`);
  // f. a lane needs a human: a bad one is failed, any other attention lane is needs-you.
  const attn = lanes.filter((x) => attnKey(statusKey(x)));
  if (attn.length) {
    const bad = attn.find((x) => glanceBad(statusKey(x)));
    if (bad) return out('failed', `${bad.task} failed: ${statusKey(bad)}`);
    const a = attn[0];
    return out('needs-you', `${a.task}: ${(a.status && a.status.label) || statusKey(a)}`);
  }
  // g. lanes or a lead phase exist but nothing is fresh or needs a human.
  if (lanes.length || phase) {
    return out('quiet', age === null ? 'No lead update yet; Claude may be waiting on you' : `No lead update for ${glanceDur(age)}; Claude may be waiting on you`);
  }
  // h. nothing to look at.
  return out('idle', '');
}
function planView(r) {
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
    const ls = all.filter((x) => !x.folded); const act = ls.filter((x) => x.result !== 'dropped');
    const st = !ls.length ? 'planned' : !act.length ? 'dropped' : act.every((x) => settledKey(statusKey(x))) ? 'done' : act.some((x) => x.running) ? 'running'
      : act.some((x) => attnKey(statusKey(x))) ? 'attention' : act.some((x) => statusKey(x) === 'paused') ? 'paused' : act.some((x) => x.result) ? 'partial' : 'planned';
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
  const allSettled = live.length > 0 && live.every((x) => settledKey(statusKey(x)));
  const state = counts.running ? 'running' : closed ? (counts.done === counts.total ? 'done' : 'closed')
    : live.some((x) => attnKey(statusKey(x))) ? 'attention' : live.some((x) => statusKey(x) === 'paused') ? 'paused'
    : allSettled ? (/^verifying$/i.test(p.status || '') ? 'verifying' : 'done') : 'waiting';
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
function laneDetail(l) {
  const s = l.s; const rd = (f) => { try { return fs.readFileSync(path.join(l.dir, f), 'utf8'); } catch { return ''; } };
  let brief = ''; try { brief = fs.readFileSync(path.join(l.repo, 'tasks', `${l.task}.md`), 'utf8'); } catch {}
  return { ...laneView(l), steps: stepProgress(s).list, commits: s.commitLog || [], todos: s.todos || [], files: s.files || [], gates: s.gates || [],
    interruptions: s.interruptions || [], steers: s.steers || [], permissions: s.permissions || [], outside: s.outside || [], errors: s.errors || [],
    phases: s.phases || [], checks: s.checks || [], verdict: s.verdict || '', brief, review: rd('review.md'), summary: rd('summary.md'), stepReviews: s.stepReviews || [], config: s.config || {} };
}

// ---------- dashboard ----------
function cmdDash(args) {
  const port = Number(args[0] || process.env.CA_DASH_PORT || 4777);
  const page = fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8');
  // DNS-rebinding guard: the dashboard drives lanes, so trust only loopback Host headers for this
  // port. CA_DASH_HOSTS adds host or host:port names for a proxy in front of the dashboard.
  const allowHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const h of String(process.env.CA_DASH_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) { allowHosts.add(h); if (!h.includes(':')) allowHosts.add(`${h}:${port}`); }
  // One JSON reader for every POST body: invalid JSON or a body over 64 KB is a client error, not a 500.
  const MAX_BODY = 64 * 1024;
  const readJson = (req) => new Promise((resolve, reject) => {
    const parts = []; let size = 0; let done = false; // Buffers: a multibyte char may span two chunks
    const fail = (code) => { if (done) return; done = true; const e = new Error(code === 413 ? 'body too large' : 'invalid JSON body'); e.statusCode = code; reject(e); };
    req.on('data', (c) => { if (done) return; size += c.length; if (size > MAX_BODY) return fail(413); parts.push(c); });
    req.on('end', () => { if (done) return; done = true; const b = Buffer.concat(parts).toString('utf8'); try { const v = b.trim() ? JSON.parse(b) : {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); resolve(v); } catch { const e = new Error('invalid JSON body'); e.statusCode = 400; reject(e); } });
    req.on('error', () => fail(400));
  });
  const readBody = async (req) => { try { return { body: await readJson(req) }; } catch (e) { return { error: { error: e.statusCode === 413 ? 'request body too large' : 'invalid JSON body' }, code: e.statusCode || 400 }; } };
  const srv = http.createServer(async (req, res) => {
    setReqSnap({}); // one lanes()/plans() snapshot per request; rebuilt on the next poll
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      // A foreign Host header is a DNS-rebinding attempt: reject it before any route runs.
      const reqHost = String(req.headers.host || '').toLowerCase();
      if (!allowHosts.has(reqHost)) return json({ error: `forbidden host ${req.headers.host || '(none)'}; allow it with CA_DASH_HOSTS` }, 403);
      // Every POST under /api/ must be JSON: a cross-site form post cannot steer, stop, kick or resume.
      if (req.method === 'POST' && u.pathname.startsWith('/api/') && !/application\/json/i.test(String(req.headers['content-type'] || ''))) return json({ error: 'POST /api/ needs content-type application/json' }, 415);
      if (u.pathname === '/') { let html = page; try { html = fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8'); } catch {} res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); }
      if (u.pathname === '/office') { let html = ''; try { html = fs.readFileSync(path.join(HERE, 'office.html'), 'utf8'); } catch {} if (html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); } }
      if (u.pathname.startsWith('/assets/')) {
        // Static Pixel Workshop assets (room art, atlases, manifests, shared css/js). No traversal, known types only.
        const types = { '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
        const rel = decodeURIComponent(u.pathname.slice('/assets/'.length)); const root = path.join(HERE, 'assets'); const f = path.resolve(root, rel);
        const type = types[path.extname(f).toLowerCase()];
        if (!type || !f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return json({ error: 'not found' }, 404);
        res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('image/') ? 'max-age=3600' : 'no-store' }); return res.end(fs.readFileSync(f));
      }
      if (u.pathname === '/api/ui') {
        // UI version: newest mtime of the pages and shared assets. Open tabs poll it and reload when it changes,
        // so a deployed fix never keeps running stale page code.
        const files = ['dash.html', 'office.html', 'assets/workshop.js', 'assets/workshop.css'].map((f) => path.join(HERE, f));
        return json({ version: Math.max(0, ...files.map((f) => { try { return Math.round(fs.statSync(f).mtimeMs); } catch { return 0; } })) });
      }
      if (u.pathname === '/api/lanes') return json(lanesSnapshot().map(laneView));
      if (u.pathname === '/api/overview') {
        // The office view in one call: attention buckets and lanes not finished over 3 days ago.
        const ls = lanesSnapshot().filter((l) => !l.s.result || now() - (l.s.finishedAt || 0) < 3 * 24 * 3600e3).map(laneView);
        const counts = { attention: 0, running: 0, done: 0, ended: 0 };
        for (const v of ls) counts[v.bucket] = (counts[v.bucket] || 0) + 1;
        return json({ counts, lanes: ls });
      }
      if (u.pathname === '/api/plans') return json(plansSnapshot().map(planView).sort((a, b) => (a.closed - b.closed) || (b.lastActivity - a.lastActivity)));
      const pm = u.pathname.match(/^\/api\/plans\/(.+)\/remove$/);
      if (pm) {
        // Exact registered-plan id only (ids may carry ~ and .): decode the segment, never die().
        if (req.method !== 'POST') return json({ error: 'use POST /api/plans/<id>/remove' }, 405);
        const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
        const pid = decodeURIComponent(pm[1]);
        const pr = plansSnapshot().find((x) => x.id === pid);
        if (!pr) return json({ error: `no registered plan has id "${pid}"` }, 404);
        const res = await removePlan(pr, { by: 'dashboard' });
        if (res.error) return json({ error: res.error }, res.code || 500);
        return json(res);
      }
      if (u.pathname === '/api/doctor') return json({ checks: (await doctorData()).checks });
      if (u.pathname === '/api/update') {
        // The update pill: the cached check plus the running dash pid. A stale cache refreshes in
        // the background; ?refresh=1 waits for a fresh check. POST runs `ca update` and then
        // restarts this same dashboard on the same port (after the response is sent).
        const { readUpdateCache, checkUpdate, installCommand, currentVersion, UPDATE_TTL_MS } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
        const view = (c) => ({ current: (c && c.current) || currentVersion(), latest: (c && c.latest) || null, available: !!(c && c.available), notes: (c && Array.isArray(c.notes)) ? c.notes : [], cmd: (c && c.cmd) || installCommand(), checkedAt: (c && c.checkedAt) || 0, error: (c && c.error) || undefined, pid: process.pid });
        if (req.method === 'POST') {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--json'], { encoding: 'utf8', env: caEnv(), windowsHide: true });
          let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
          const code = await new Promise((res) => { const to = setTimeout(() => { try { child.kill(); } catch {} res(-1); }, 600000); child.on('close', (c) => { clearTimeout(to); res(c); }); child.on('error', () => { clearTimeout(to); res(-1); }); });
          if (code !== 0) {
            const tail = out.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 300);
            return json({ ok: false, error: `${tail} (exit ${code})` }, 500);
          }
          json({ ok: true, restarting: true, output: out.trim().slice(0, 2000) });
          res.on('finish', () => {
            try { srv.close(); } catch {}
            try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CA_DASH_RECLAIM: '1' } }).unref(); } catch {}
            setTimeout(() => process.exit(0), 50);
          });
          return;
        }
        let cache = readUpdateCache();
        const stale = !cache || typeof cache.checkedAt !== 'number' || Date.now() - cache.checkedAt >= UPDATE_TTL_MS;
        if (u.searchParams.get('refresh') === '1') { try { cache = await checkUpdate({ force: true, timeoutMs: 5000 }); } catch {} }
        else if (stale) { try { spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--check', '--json'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {} }
        return json(view(cache));
      }
      if (u.pathname === '/api/auth') {
        // Start the local key form (runner/auth.mjs) for the Connect keys button and hand back its
        // URL. The child prints JSON only; key values never reach this process, the page or the logs.
        // A route handler must never die(): a stale tab must not kill the dashboard.
        if (req.method !== 'POST') return json({ error: 'use POST /api/auth' }, 405);
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'auth', '--no-open', '--json'], { encoding: 'utf8', timeout: 20000, env: caEnv(), windowsHide: true });
        let v = null; try { v = JSON.parse(String(r.stdout || '').trim()); } catch {}
        if (!v) return json({ error: 'auth did not return JSON' }, 500);
        return json({ ready: !!v.ready, url: v.url || '' });
      }
      const m = u.pathname.match(/^\/api\/lane\/([^/]+)\/(log|summary|detail|steer|stop|attach|kick|resume|ack|remove)$/);
      if (m) {
        const q = decodeURIComponent(m[1]); const all = lanesSnapshot();
        const pr = pickOne(all, q, (x) => x.id, (x) => x.task);
        if (pr.matches) return json({ error: `ambiguous lane "${q}": matches ${pr.matches.join(', ')}; use the full id` }, 409);
        const l = pr.hit;
        if (!l) return json({ error: `no lane matches "${q}"` }, 404); // never die(): one stale browser tab must not kill the dashboard
        if (m[2] === 'detail') return json(laneDetail(l));
        if (m[2] === 'log') {
          const f = path.join(l.dir, 'live.log'); const from = Number(u.searchParams.get('from') || 0);
          const size = fs.existsSync(f) ? fs.statSync(f).size : 0; const start = from > size ? 0 : Math.max(from, size - 400000);
          let text = ''; if (size > start) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(size - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); text = b.toString('utf8'); }
          return json({ size, text, reset: from > size });
        }
        if (m[2] === 'summary') { const f = path.join(l.dir, 'summary.md'); return json({ text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }); }
        if (req.method === 'POST' && m[2] === 'steer') { const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code); const text = String(rb.body.text ?? '').trim(); if (!text) return json({ error: 'empty' }, 400); const sr = steer(l, text); if (sr.error) return json({ error: sr.error }, sr.code || 409); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'kick') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          const r = kickLane(l, { mode: String(body.mode || 'turn'), text: String(body.text || '').trim(), by: 'dashboard' });
          if (r.error) return json({ error: r.error }, r.code || 409);
          return json({ ok: true, mode: String(body.mode || 'turn'), file: r.file });
        }
        if (req.method === 'POST' && m[2] === 'resume') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          const r = resumeLane(l, { note: String(body.note || '').trim(), by: 'dashboard' });
          if (r.error) return json({ error: r.error }, r.code || 409);
          return json({ ok: true, dry: !!r.dry, argv: r.argv, message: r.message });
        }
        if (req.method === 'POST' && m[2] === 'stop') { fs.writeFileSync(path.join(l.dir, 'STOP'), String(now())); return json({ ok: true }); }
        if (req.method === 'POST' && m[2] === 'remove') {
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const res = await removeLane(l, { purge: rb.body.keepLogs !== true, by: 'dashboard' });
          if (res.error) return json({ error: res.error }, res.code || 500);
          return json(res);
        }
        if (req.method === 'POST' && m[2] === 'ack') {
          // Mark a finished lane seen (or unseen again) for this finishedAt; a later finish is unseen anew.
          const rb = await readBody(req); if (rb.error) return json(rb.error, rb.code);
          const body = rb.body;
          if (body.seen !== false && !l.s.result) return json({ error: 'lane is not finished: resume or stop it instead' }, 409);
          setAck(l.id, body.seen !== false, l.s.finishedAt || null, typeof body.note === 'string' ? oneLine(body.note, 200) : '');
          return json({ ok: true, seen: laneSeen(l.id, l.s.finishedAt || null) });
        }
        if (req.method === 'POST' && m[2] === 'attach') {
          // Open a new console window with the CodeArts TUI on the live session.
          if (process.platform !== 'win32') return json({ error: 'Open TUI needs Windows; run ca attach <lane> in a terminal' }, 501);
          const s = l.s; if (s.result || !s.server) return json({ error: 'lane not running' }, 400);
          const sid = s.activeSession || s.buildSession;
          if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', `"codearts ${l.id}"`, `"${EXE}"`, 'attach', s.server.url, '-s', sid, '-p', s.server.pw], { env: caEnv(), detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          return json({ ok: true });
        }
      }
      json({ error: 'not found' }, 404);
    } catch (err) { json({ error: String(err.message || err) }, 500); }
  });
  // Loopback by default (the dashboard drives lanes); CA_DASH_HOST only moves it within the machine.
  const dashHost = process.env.CA_DASH_HOST || '127.0.0.1';
  const listenStarted = Date.now();
  const listenDash = () => srv.listen(port, dashHost, () => { delete process.env.CA_DASH_RECLAIM; console.log(`ca dash: http://127.0.0.1:${port}  (ctrl+c to stop)`); });
  srv.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // A POST /api/update restart spawns a fresh dash that must reclaim the same port once the old
    // process releases it: retry for up to 10 s (the port is briefly busy), then give up.
    if (process.env.CA_DASH_RECLAIM === '1' && Date.now() - listenStarted < 10000) { setTimeout(listenDash, 250); return; }
    console.log(`ca dash is already running: http://127.0.0.1:${port}`); process.exit(0);
  });
  listenDash();
}


const [cmd, ...args] = process.argv.slice(2);
const usageText = () => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  .filter((l) => l.startsWith('// usage') || l.startsWith('//        ')).map((l) => l.slice(3)).join('\n');
const table = { lane: () => { const pos = args.filter((a) => !a.startsWith('--')); return args.includes('--detach') ? cmdDetach(...pos) : runLane(pos[0], pos[1], { resume: args.includes('--resume') }); }, status: () => cmdStatus(args), summary: () => cmdSummary(args), wait: () => cmdWait(args), init: () => cmdInit(args), 'brief-check': () => cmdBriefCheck(args), workspace: () => cmdWorkspace(args), doctor: () => cmdDoctor(args), mcp: () => cmdMcp(), tail: () => cmdTail(args), steer: () => cmdSteer(args), attach: () => cmdAttach(args), stop: () => cmdStop(args), ack: () => cmdAck(args), resume: () => cmdResume(args), kick: () => cmdKick(args), dash: () => cmdDash(args), gc: () => cmdGc(), rm: () => cmdRm(args), plan: () => cmdPlan(args), note: () => cmdNote(args), 'lead-tokens': () => cmdLeadTokens(args), setup: () => cmdSetup(args), onboard: () => cmdOnboard(args), auth: () => cmdAuth(args), update: async () => { const m = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href); return m.update(args); }, uninstall: async () => { const m = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href); return m.uninstall(args); }, workflow: () => process.stdout.write(fs.readFileSync(path.join(HERE, '..', 'docs', 'workflow.md'), 'utf8')) };
if (cmd === 'help' || cmd === '-h' || cmd === '--help' || !cmd) { process.stdout.write(usageText() + '\n'); await updateNotice(args); process.exit(0); }
if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  let v = '0.0.0'; try { v = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || v; } catch {}
  process.stdout.write(`codearts-lanes ${v} (${path.join(HERE, 'ca.mjs')})\n`); await updateNotice(args); process.exit(0);
}
if (!table[cmd]) { process.stderr.write(usageText() + '\n'); process.exit(2); }
if (cmd === 'lane') await updateNotice(args);
await table[cmd]();
if (cmd === 'status' || cmd === 'doctor' || cmd === 'plan') await updateNotice(args);
