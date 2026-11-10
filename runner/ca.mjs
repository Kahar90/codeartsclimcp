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
import { bucketFor, cmdAck, cmdAttach, cmdGc, cmdKick, cmdRm, cmdResume, cmdStatus, cmdSteer, cmdStop, cmdSummary, cmdTail, kindOf, kickLane, laneHealthOf, laneRow, laneStatusOf, modelRow, printRows, removeLane, removePlan, resumeLane, statusRow, steer, sumTok, tokTotal, tokensByModelView, tokensByView, updateNotice } from './commands.mjs';
import { EXE, HERE, INSTALL_HINT, PLANS, REG, SETTINGS, SKILL, ackNote, alive, briefWarningLines, briefWarningsFor, caEnv, compact, dashUrl, die, dur, findLane, fmtDur, git, health, hhmmss, killTree, laneAlive, laneId, laneIndex, laneMemoFor, laneSeen, lanes, lanesSnapshot, now, num, oneLine, pickOne, plans, plansSnapshot, projectOf, readAcks, readJSON, readJSONCached, resultOf, setAck, setReqSnap, sleep, stepProgress, userEnv, workerShell, writeAcks, writeAtomic, writeProbe } from './common.mjs';
import { GLYPHS, laneActions, laneBucket, laneKind, laneOutcome } from './controls.mjs';
import { ensureDash } from './dash-server.mjs';
import { cmdAuth, cmdBriefCheck, cmdDoctor, cmdInit, cmdMcp, cmdOnboard, cmdSetup, cmdWait, cmdWorkspace, doctorData } from './engineer.mjs';
import { cmdDetach, runLane } from './lane.mjs';
import { cmdLeadTokens, cmdNote, cmdPlan, laneDetail, laneView, planView } from './plan.mjs';
import { sumTokens, tokenTotal, withTotal } from './tokens.mjs';

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
