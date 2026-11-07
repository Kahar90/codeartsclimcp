MODEL: maas/deepseek-v4.1-flash
You are working in a git repo (current directory): the Lanes dashboard page `runner/dash.html` of the `ca`
CodeArts lane runner. Goal: show token counts per agent, per lane and per plan, and let a human control a
stuck or ended lane from the page (retry turn, fresh session, restart server, retry now, resume with a note,
quick steering) without opening their coding harness.
Files: runner/dash.html and checks/lanes.check.mjs only. Shared helpers already exist in
runner/assets/workshop.js (read them, do not edit): CAUI.tokenTotal, CAUI.fmtTokens, CAUI.tokenDetail,
CAUI.tokenSplit, CAUI.ACTIONS (label, title, danger confirm text, note flag), CAUI.QUICK_STEERS, CAUI.control.
Data from the server (another lane adds it; you work against the ?demo=1 fixture):
- every lane: tokens {input, output, reasoning, cacheRead, steps, total}; tokensBy {build, review, other}, each the
  same shape; actions: array of ids from steer, stop, attach, kick, fresh, restart-server, skip-wait, resume;
  suggest: one of those ids or ''; why: short reason text for the suggestion.
- every plan: tokens and tokensBy, sums over its lanes.
- POST /api/lane/:id/kick {mode: turn|fresh|server|now, text} and POST /api/lane/:id/resume {note}, both answer
  {ok, message} or {error}. CAUI.control(id, action, extra) sends them (extra {text} for kick, {note} for resume).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Make a change, run the check, read its output. Do not reason for a long time without running something.

1. Demo fixture: give every demo lane tokens (with total) and tokensBy whose totals add up, plus actions, suggest
   and why: running lanes ['steer', 'stop', 'attach', 'kick', 'fresh', 'restart-server'] with suggest ''; add a
   running lane `demo-repo--stuck` (health 'STALLED', phase build, in the string-utils plan) with suggest 'kick' and
   why 'no model activity for 6m'; failed `stall` and stopped `orphan` lanes ['resume'] (stall suggests resume, why
   'gave up after 3 interruptions (transport)'); needs-review `chaos` ['resume'] with no suggest; done lanes [].
   Demo plans get tokens and tokensBy sums. The demo layer answers POST kick and resume with {ok: true, message}
   and appends {laneId, action: 'kick' | 'resume', body} to a `demoControls` list. Commit.
2. Lane detail tokens: the Tokens metric shows CAUI.fmtTokens(total) with CAUI.tokenDetail in its title. Add a
   "Tokens by agent" block: three rows (Builder, Reviewer, Hidden sessions from CAUI.tokenSplit) each with the
   compact total and a proportional bar, detail on hover. Use existing colour tokens. Commit.
3. Plan home and rail tokens: the plan header shows "Tokens <total>" (by-agent split in its title); every lane
   card in a wave shows its token total; each plan in the rail shows its compact total. Commit.
4. Controls bar in lane detail, rendered from d.actions in this order: suggested first, then skip-wait, kick,
   fresh, restart-server, resume, attach, stop (steer stays the steer box). Labels and titles from CAUI.ACTIONS.
   The suggested button gets the primary style and d.why shows next to it as a short hint. Actions with a danger
   text ask confirm() first. Actions with note: true open a small inline textarea ("Note for the worker,
   optional") with Send and Cancel; Send calls CAUI.control (kick: {text}, resume: {note}). Show the result as a
   toast (message or error) and refresh at once. The existing Stop and Open TUI buttons move into this bar,
   no duplicates. Commit.
5. One click from the plan home: a lane card with a non-empty suggest shows one small button with that action's
   label, using the same confirm and note flow, without navigating to the lane. Commit.
6. Quick steering: chips from CAUI.QUICK_STEERS above the steer box; a click fills the draft (does not send) so
   the user can edit and press Send. Commit.
7. Test hook and check: window.__lanes.state() adds lane.tokens {total, build, review, other} (numbers),
   lane.actions (control button ids in DOM order), lane.suggest, lane.noteOpen, plan.tokens (total number),
   plan.suggestButtons (lane ids with a one-click button), controls (the demoControls list), quickSteers (chip
   count). Extend checks/lanes.check.mjs (it already starts `ca dash` and headless Chrome itself): on ?demo=1
   the running lane's token total equals the sum of its three agent rows; the stuck lane's first control is the
   primary 'kick'; clicking it opens the note box, typing a note and Send logs {action: 'kick', body.mode: 'turn',
   body.text: the note}; the stall lane's Resume with a note logs body.note; the plan home shows plan tokens and
   the one-click button on the stuck card logs a kick without changing the route; a quick chip fills the draft;
   no horizontal overflow at 390 px. Save screenshots of the lane detail controls and plan home. Commit.
8. Self check: re-read your changes against this brief, run every check below, fix every FAIL. Commit if changed.
   Add `[hidden]{display:none!important}` if any overlay you added uses display rules.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write new browser scripts; only checks/lanes.check.mjs drives Chrome.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs each of the following itself when you finish
and sends you the output if one fails.
CHECK: node checks/lanes.check.mjs
CHECK: node checks/assets.check.mjs
Constraints: no em dashes anywhere. Only touch runner/dash.html and checks/lanes.check.mjs.

Final reply: the steps with their commit hashes, and anything skipped.
