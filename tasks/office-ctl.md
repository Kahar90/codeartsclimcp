MODEL: maas/glm-5.3
You are working in a git repo (current directory): the Office view `runner/office.html` (Pixel Workshop room
with the lead and worker stations, nameplates and a floating agent window) of the `ca` CodeArts lane runner.
Goal: show token counts per agent and for the whole plan, and let a human restart, retry or resume a stuck or
ended lane from the Office view (and steer it with one click) without opening their coding harness.
Files: runner/office.html and checks/office.check.mjs only. Shared helpers already exist in
runner/assets/workshop.js (read them, do not edit): CAUI.tokenTotal, CAUI.fmtTokens, CAUI.tokenDetail,
CAUI.tokenSplit, CAUI.ACTIONS (label, title, danger confirm text, note flag), CAUI.QUICK_STEERS, CAUI.control.
Data from the server (another lane adds it; you work against the demo fixtures):
- every lane: tokens {input, output, reasoning, cacheRead, steps, total}; tokensBy {build, review, other}, each the
  same shape; actions: array of ids from steer, stop, attach, kick, fresh, restart-server, skip-wait, resume;
  suggest: one of those ids or ''; why: short reason text for the suggestion.
- every plan: tokens and tokensBy, sums over its lanes.
- POST /api/lane/:id/kick {mode: turn|fresh|server|now, text} and POST /api/lane/:id/resume {note}, both answer
  {ok, message} or {error}. CAUI.control(id, action, extra) sends them (extra {text} for kick, {note} for resume).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Make a change, run the check, read its output. Do not reason for a long time without running something.

1. Demo fixtures: every demo lane (?demo=1, done, big) gets tokens with total and tokensBy whose totals add up,
   plus actions, suggest and why (running lanes ['steer', 'stop', 'attach', 'kick', 'fresh', 'restart-server'],
   finished done lanes []); the demo plan gets tokens and tokensBy sums. Add `?demo=stuck`: builder STALLED
   (suggest 'kick', why 'no model activity for 6m'), artist running, reviewer failed (actions ['resume'], suggest
   'resume', why 'gave up after 3 interruptions (transport)'). In demo mode, kick and resume do not fetch: they
   answer {ok: true, message} and append {laneId, action, body} to a `demoControls` list. Existing demo modes must
   keep passing the existing office checks. Commit.
2. Agent window tokens: a Tokens row with the compact total (CAUI.fmtTokens) and a three-segment bar for builder,
   reviewer and hidden sessions (CAUI.tokenSplit) with small labels; CAUI.tokenDetail in the title. Commit.
3. Room tokens: each worker nameplate shows its lane's compact token total after the progress (keep plates from
   overlapping; the existing check tests that); the top bar shows the plan total, for example "Tokens 1.24M", with
   the by-agent split in its title. Commit.
4. Agent window controls: a row of buttons from the lane's actions in this order: suggested first, then
   skip-wait, kick, fresh, restart-server, resume, attach, stop (labels and titles from CAUI.ACTIONS; steer stays
   the steer input). The suggested button is primary and the why text shows under the row. Danger actions ask
   confirm() first. Note actions open a small inline textarea ("Note for the worker, optional") with Send and
   Cancel; Send calls CAUI.control (kick: {text}, resume: {note}). Show the answer as a short toast and refresh at
   once. Quick steering chips from CAUI.QUICK_STEERS above the steer input fill the draft (do not send). Commit.
5. Attention badge: a worker whose lane has a non-empty suggest shows a small "!" badge on its nameplate
   (title = why); clicking the badge opens that agent window with the controls row in view. Commit.
6. Test hook: window.__office.state() adds stations[].tokens (total number) and stations[].suggest, window:
   { tokens: {total, build, review, other}, actions (button ids in DOM order), suggest, noteOpen }, planTokens
   (number), controls (the demoControls list), quickSteers (chip count). Commit.
7. Extend checks/office.check.mjs (it already starts `ca dash` and headless Chrome itself) with ?demo=stuck:
   the builder plate has the badge; clicking it opens the window whose first control is the primary 'kick';
   Retry turn opens the note box, a typed note and Send log {action: 'kick', body.mode: 'turn', body.text}; the
   reviewer window offers Resume and a note logs body.note; window token total equals the sum of the three
   agent parts; plan tokens shown in the top bar; a quick chip fills the steer draft; plates still do not
   overlap; no horizontal overflow at 390 px. Save a screenshot of the window with controls. Commit.
8. Self check: re-read your changes against this brief, run every check below, fix every FAIL. Commit if changed.
   Add `[hidden]{display:none!important}` if any overlay you added uses display rules.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write new browser scripts; only checks/office.check.mjs drives Chrome.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs each of the following itself when you finish
and sends you the output if one fails.
CHECK: node checks/office.check.mjs
CHECK: node checks/assets.check.mjs
Constraints: no em dashes anywhere. Only touch runner/office.html and checks/office.check.mjs.

Final reply: the steps with their commit hashes, and anything skipped.
