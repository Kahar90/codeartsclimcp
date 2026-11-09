You are working in a git repo (current directory). Goal: plans and lanes show how long the work took: a total "time taken" per plan, and hovering (or focusing, or tapping) it shows the breakdown. Stack: plain Node ESM (runner/ca.mjs), plain HTML pages (runner/dash.html = Lanes, runner/office.html = Office), shared runtime runner/assets/workshop.js and workshop.css.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

The contract is checks/time.check.mjs (already written, read it first; do not edit it). It builds fake lanes and plans in a private registry and asserts the exact numbers below.

1. Lane time in runner/ca.mjs. Add `laneTime(s, isAlive)` returning `{ ms, byPhase, windows }`:
   - windows = one [start, end] per run: every entry of `s.runs` ({startedAt, finishedAt}) plus the current run [s.runStartedAt || s.startedAt, end], where end = s.finishedAt, else Date.now() when the supervisor is alive, else s.lastEventAt. Drop windows with end <= start. Paused gaps between runs are not lane time.
   - byPhase always has the six keys wait, build, checks, fix, review, other (numbers in ms). Each entry of `s.phases` ({phase, at}) lasts until the next entry's `at`; clip every phase interval to the windows. Map starting/restart/backoff to wait, build to build, gate to checks, fix to fix, review to review, anything else to other. Window time before the first phase entry counts as wait. A lane with no phases (rebuilt from a log by laneFromLog) puts its whole window time in other.
   - ms = sum of the window lengths.
   Add `time: laneTime(s, isAlive)` to laneView (so /api/lanes rows, plan lanes and laneDetail all carry it). Commit.
2. Plan time in planView (runner/ca.mjs). Add `time` to the returned object:
   - startedAt (ms number): Date of plan.json `startedAt` when present; else the earliest of every decision `at` and every plan lane window start; else the plan file mtime.
   - endedAt: Date of `closedAt` when present; else when the plan is closed (status done/closed/abandoned/cancelled) the latest of the last lane window end and the latest decision `at`; else null. live = endedAt == null; the end used for maths is endedAt or Date.now(). Never let the end be before the start.
   - totalMs = end - startedAt.
   - segments, always these four in this order, each {key, label, ms}, summing to totalMs: planning "Lead planning" (start to the first lane window start, or the whole total when no lane ever ran), lanes "Lanes running" (length of the union of all plan lane windows, folded/continued lanes included, clipped to start..end), verify "Lead verifying" (last lane window end to end; 0 while a lane runs), between "Lead between lanes" (the rest). Order in the array: planning, lanes, between, verify.
   - work: { totalMs, byPhase } = the sum of every plan lane's time.ms and time.byPhase (parallel lanes add up, so work can exceed totalMs).
   - lanes: [{ task, ms, byPhase }] one per plan lane that ever ran (time.ms > 0), in plan order.
   Use the numbers in checks/time.check.mjs as the worked example. Commit.
3. CLI in runner/ca.mjs. `ca plan <file>`: when plan.json has no `startedAt`, write one (ISO string) = the planView time.startedAt computed from decisions and lanes (or now when there is neither); never overwrite an existing value. `ca plan close`: also write `closedAt` = now (ISO). `ca plan list`: append the total to each line as `  time 2h 0m` (format below). Add a shared duration formatter in ca.mjs: under 60 s "45s", under 60 min "12m", under 24 h "2h 0m", else "3d 4h". Commit.
4. Shared UI in runner/assets/workshop.js and workshop.css. Add `CAUI.fmtDur(ms)` (same format as step 3) and `CAUI.timeCard(time)` returning the inner HTML of a hover card: kicker "Time taken" (or "Time so far" when time.live), big total, a stacked bar of the four segments (lead segments in the lead colour, lanes in the builder colour, between/verify in muted tones; use existing tokens such as var(--builder), var(--lead) if present, var(--faint)), one row per segment with swatch, label and fmtDur (skip 0 ms rows except Lanes running), then a section "Worker time <fmtDur(work.totalMs)>" with rows for Build, Checks, Fix, Review, Waiting, Other (skip zeros), then a section "By lane" with task and fmtDur, then a muted footer "Started <local HH:MM, plus the date when not today>" and " · finished <...>" or " · still running". Escape every string with CAUI.esc. Reuse the existing `.ca-card` look and the hc-* row style idea from office.html (copy the needed rules into workshop.css as `.tc-*` classes so both pages share them). Guard any DOM access so workshop.js still loads in a vm without a DOM. Commit.
5. Lanes page runner/dash.html. In the plan head, the `.plan-tok` line becomes `Tokens 12M · Time 2h 0m` where "Time ..." is a focusable element `<span class="plan-time" id="planTime" tabindex="0" role="button" aria-describedby="timeCard">` with a dotted underline. Add one `<div id="timeCard" class="ca-card" role="tooltip" hidden>` to the page; show it with CAUI.timeCard(p.time) on mouseenter and focus of #planTime, place it with CAUI.place(card, anchor, {side:'bottom', align:'start'}), hide on mouseleave, blur and Escape; a tap (pointerType touch or a click) toggles it. It must stay open and keep its content current across the 2 s poll re-renders (re-bind after render, do not replay its entry animation). Also append ` · <fmtDur>` to each plan's `rail-sub` line in the Control room/plan rail, and give the lane detail "Elapsed" metric a title listing the lane's time.byPhase (non-zero only, "Build 19m / Checks 2m / ..."). Add a `time` object with realistic numbers (one live plan, one finished) to the `?demo=1` fixtures (demoPlans and demo lanes) so the demo shows it. Test hook: window.__lanes.state().plan gains `time: { total: <ms>, label: <the chip text> , cardOpen: <bool> }`. Add `[hidden]{display:none!important}` style protection for #timeCard if the card class sets display. Commit.
6. Office page runner/office.html. Add a `<span class="chip" id="timeChip" tabindex="0" hidden>` right after #tokenChip in the top bar, text "Time 2h 0m" (CAUI.fmtDur(p.time.totalMs)), hidden when the plan has no time. It uses the existing #hoverCard mechanism exactly like #tokenChip (find where hoverCard picks tokenCard and add the timeChip case returning CAUI.timeCard(model.plan.time)), plus an aria-label with the total and segment split. Add `time` to the office demo fixtures (`?demo=1`, `?demo=done`, `?demo=big`). Test hook: window.__office state gains `time: { total, label }`. The top bar must not overflow at 390 px wide: on narrow screens the time chip may drop the word "Time". Commit.
7. Docs: README.md (dashboard section: one or two sentences on time taken and the hover breakdown) and docs/workflow.md (the lead writes `"startedAt"` as an ISO time in plan.json when it starts planning, `ca plan` fills it in if missing, `ca plan close` records closedAt). Commit.
8. Self check: re-read your changes against this brief, run every check below, fix what fails. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below (they drive headless Chrome themselves).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.
- Use grep to find the code you change; do not read whole 2000 line files. Make an edit, run the check, read its output; do not calculate layouts or numbers by hand.

Checks: run these before each commit (the runner also runs every line below when you finish).
CHECK: node --check runner/ca.mjs
CHECK: node checks/time.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/assets.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/polish.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs, runner/dash.html, runner/office.html, runner/assets/workshop.js, runner/assets/workshop.css, README.md, docs/workflow.md. Do not edit any file under checks/.

Final reply: the steps with their commit hashes, and anything skipped.
