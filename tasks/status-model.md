You are working in a git repo (current directory), a dependency-free Node ESM project (the `ca` lane
runner): runner/ca.mjs (supervisor, CLI, dashboard server), runner/controls.mjs (pure lane controls and
buckets), runner/assets/workshop.js (shared UI helpers, `CAUI.status` / `CAUI.badge`), runner/dash.html
(Lanes dashboard) and runner/office.html (Office view).
Goal: lane statuses are misleading. Today "failed" mixes three things: the work is bad, the checks could
not even run (for example `bash` resolved to WSL and `node` was "command not found", exit 127), and the
lead already dealt with the lane (acked as handled). Split them into a clear status model, shown the same
way everywhere (CLI, MCP, Lanes dashboard, Office view).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

The model (final results; running states stay as they are):
- verified: build finished, every CHECK ran and passed (and the review did not ask for fixes). Tone done.
- unverified: build finished but a CHECK could not RUN (infrastructure, not a test failure): exit 126 or
  127, or output matching /command not found|is not recognized as an internal or external command|
  ENOENT|EACCES|Sandbox Network Error|cannot find module 'node'|\[runner: timed out/i. Tone warn.
  Reason like "checks couldn't run: node --check runner/ca.mjs (node: command not found)".
- checks failing: a CHECK ran and failed after the fix rounds. Tone bad. Reason names the check and exit.
- needs review: as today (reviewer asked for fixes). Tone warn.
- failed: only real breakdowns: auth (exit 3), worker or model error, crash, no progress, supervisor gone.
- paused / stopped / killed / continued / dropped: as today; stopped says who if known ("stopped by the lead").
- handled: a finished lane the lead or human acked (acks.json, laneSeen + ackNote). Overrides the badge
  everywhere: label "Merged" when the note matches /merg/i, else "Handled"; tone done for Merged, idle for
  Handled; the reason line is the note. It stops being handled when the lane runs again (as today).
"done" stays the stored result value for compatibility; the display label for a done lane is Verified
when its last check gates all passed, and "Done" when the brief had no CHECK lines.

1. runner/controls.mjs: add pure exports `classifyCheck({ code, out })` -> 'pass' | 'fail' | 'infra'
   (rules above) and `laneOutcome({ s, health, handled, note })` -> `{ key, label, tone, reason }` where key
   is one of verified, done, unverified, checks failing, needs review, failed, paused, stopped, killed,
   continued, dropped, handled, running (and the live health states unchanged), tone is run | done |
   warn | bad | idle. It must also read LEGACY states: a finished lane with result 'failed' and reason
   /gates still failing/ is 'checks failing', unless its last failed gate in `s.gates` has code 126/127
   (or a stored `kind: 'infra'`), then 'unverified'. Update `laneBucket` to use it: unverified and checks
   failing go to attention with that reason; handled stays ended (bucketFor already does this). Update
   `laneActions`: suggest resume only for paused, supervisor died, and checks failing ("resume gives the
   worker another fix round"); for unverified keep 'resume' available but do not suggest it, why = "checks
   couldn't run: fix the environment, then resume to rerun them"; handled lanes suggest nothing. Commit.
2. runner/ca.mjs gates(): store `kind: classifyCheck(...)` on every check gate entry. When a check fails
   as 'infra', rerun that one check once after 3 s; if it is still infra, do NOT start a fix round (the
   worker cannot fix the machine): end the build loop with result 'unverified' and the reason above. Real
   'fail' keeps the fix rounds; after the last round the result is 'checks failing' with reason
   "checks failing after N fix rounds: <check> (exit <code>)". The review still runs for unverified
   (it reads code, not checks); if the reviewer asks for fixes the result becomes 'needs review'.
   Exit codes: unverified -> 4 (needs a human look, like needs review), checks failing -> 1. Make
   `resultOf`, `health`, `laneExit`, `cmdWait` next hints, `ca status`, `ca summary` and the summary.md
   header understand the new results. Commit.
3. runner/ca.mjs laneView and statusRow: add `status: laneOutcome(...)` (with handled and the ack note) to
   every lane in /api/lanes, /api/plans lanes, `ca status --json` and the MCP status/wait/summary output
   (runner/mcp.mjs only if it shapes these itself). Plan badges: a plan whose lanes are all verified,
   done or handled reads done; any checks failing or failed lane makes it attention. Commit.
4. runner/assets/workshop.js: `CAUI.status` learns Verified (done), Unverified (warn), Checks failing (bad),
   Merged (done), Handled (idle); add `CAUI.laneStatus(l)` that returns `l.status` when present (falls
   back to CAUI.status(l.health, l.result)). runner/dash.html and runner/office.html: every lane badge,
   plate, desk card, hot desk and lane window uses `CAUI.laneStatus(l)`; where the lane window or detail
   shows "Now: <health>" for a finished lane, show the status reason instead (e.g. "Now: checks couldn't
   run: node --check runner/ca.mjs (node: command not found)" or "Now: Merged: merged into main by the
   lead"). Show the Resume button as primary only when `suggest === 'resume'`; otherwise a plain secondary
   button. Add one demo lane per new status to both demo fixtures (dash.html `demoLanes`, office.html
   demo sets): an unverified lane, a checks failing lane and a handled (merged) lane, without changing the
   counts other checks assert (add them as ended or extra items; adjust a count in lanes/office checks
   only if unavoidable and say so in the commit). Commit.
5. Add checks/status.check.mjs: (a) unit-test classifyCheck and laneOutcome for every row of the model,
   including the two legacy cases (failed + gates still failing with code 127 -> unverified; with code 1
   -> checks failing) and handled/merged overrides; (b) with a temp CA_REGISTRY and fake lane state files
   (style of checks/planstate.check.mjs, CA_DASH=0) assert `ca status --json` rows carry status.key/label
   and `ca wait` exit codes (unverified 4, checks failing 1); (c) start `ca dash` on a free port with that
   registry and assert /api/lanes status fields; (d) headless Chrome over CDP (checks/lib/chrome.mjs, like
   checks/lanes.check.mjs) on /?demo=1 and /office?demo=1: the demo unverified lane badge reads
   "Unverified", the merged lane reads "Merged", the checks failing lane reads "Checks failing", and no
   badge reads "Failed" for those three. PASS/FAIL lines, exit 1 on FAIL, 300 s timeout, kill only what
   it spawned. Commit.
6. Self check: re-read against this brief; the docs that list results and exit codes (docs/workflow.md,
   README.md) mention unverified and checks failing in one line each. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write other browser scripts; only run the CHECK commands.
- Never touch the real registry (~/.codeartsdoer/lanes) or the dashboard on port 4777.
- Your shell sandbox blocks loopback ports: browser checks and ca dash checks hang or fail with
  "Sandbox Network Error" in your shell. Do not run them and do not work around it; before each commit run
  only `node --check` on the files you changed and `node checks/status.check.mjs --unit` (make the check
  accept `--unit` to run part (a) and (b) only). The runner runs every CHECK line itself outside the
  sandbox when you finish and sends you real failures.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/status.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/remove.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
Constraints: no em dashes anywhere. Only touch runner/controls.mjs, runner/ca.mjs, runner/mcp.mjs,
runner/assets/workshop.js, runner/dash.html, runner/office.html, checks/status.check.mjs, docs/workflow.md,
README.md, and checks/lanes.check.mjs or checks/office.check.mjs only for an unavoidable demo count.
Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
