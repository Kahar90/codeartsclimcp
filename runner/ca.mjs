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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cmdAck, cmdAttach, cmdGc, cmdKick, cmdRm, cmdResume, cmdStatus, cmdSteer, cmdStop, cmdSummary, cmdTail, updateNotice } from './commands.mjs';
import { HERE } from './common.mjs';
import { cmdDash } from './dash-server.mjs';
import { cmdAuth, cmdBriefCheck, cmdDoctor, cmdInit, cmdMcp, cmdOnboard, cmdSetup, cmdWait, cmdWorkspace } from './engineer.mjs';
import { cmdDetach, runLane } from './lane.mjs';
import { cmdLeadTokens, cmdNote, cmdPlan } from './plan.mjs';

// On macOS a pipe to stdout/stderr is asynchronous, so a line printed right before process.exit() (CA_RESULT,
// a die() message) can be lost when an agent or the MCP server reads ca through a pipe. Blocking writes
// flush before every exit, on every OS.
for (const s of [process.stdout, process.stderr]) { try { if (s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true); } catch {} }

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
