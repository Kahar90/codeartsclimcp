You are working in a git repo (current directory). Goal: the Office view (`runner/office.html`) always shows the
whole room on any desktop or laptop screen, with smaller agents, a status sign that never covers an agent, and
labels that can never contradict the sign. Keep the Pixel Workshop look. Read `tasks/status-contract.txt` first:
the server adds `lane.status.attention`, `lane.status.steps`, `lane.status.glyph` and `plan.badge` (another lane
builds them; do not edit `runner/ca.mjs` or `runner/controls.mjs`); fall back to today's behaviour when missing.
Follow this brief directly; do not write another plan. Read only relevant code (`sizeStage` near line 792,
`layoutStations` near 1554, the glance sign near 1240, `planOutcome`/`planBadgeHtml` near 872). Do not ask
questions; decide and keep going. After each step works, run its targeted check, then
`git add -A && git commit -m "step N: <summary>"`.

1. Whole room, smaller agents: on desktop, scale the room to fit inside the stage (k = min of the width and
   height ratios, no cropping) and fill any leftover band with a backdrop that blends with the room (the dark
   plum shell colour with a soft vignette, no hard edge). Draw the agent sprites about 20% smaller, keeping
   their foot anchor on the same floor point. At 1920x945, 1536x864, 1366x768, 1280x720 and 2560x1440, every
   station sprite and its label must be fully inside the visible stage. Commit.
2. Sign that never covers an agent: place the glance sign so it overlaps no station sprite box, label or the
   lead bubble at every size above (pick the free spot from the station rects, shrink it down to its minimum
   font before moving it; on short screens it may sit in the empty floor area instead of the back wall).
   Commit.
3. One truth on screen: the header plan pill and its popover heading show `plan.badge` (word, tone, glyph), so
   a Done sign never sits next to "Not finished". Station labels: the status label with its glyph; show
   "step d/t" only when `status.steps` is live, "t/t" with a check when complete, and no fraction when hide;
   lanes with `status.attention` get the needs-you colour, settled lanes a calm done or idle colour. Add
   `?demo=closed`: a closed plan reproducing the case Done sign, lanes Merged, Handled by lead and Stopped by
   lead, plan.badge Done. Expose `window.__office.layout()` returning the stage, room, sign and every station
   sprite and label rect. Add `checks/officefit.check.mjs` (copy the harness of `checks/glanceoffice.check.mjs`)
   asserting at each size above: room fully visible, every sprite and label inside the stage, the sign overlaps
   none of them; on `?demo=closed` the header pill word equals the sign word and no label shows a step
   fraction for hide lanes. Save `fit-<w>x<h>.png` screenshots. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing, in the foreground with a timeout; never
sleep-poll a background job. The runner runs the CHECK lines once when you finish and sends failures back.
CHECK: node checks/officefit.check.mjs
CHECK: node checks/glanceoffice.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/officeclick.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office.html`, `runner/assets/workshop.css` (only if needed)
and `checks/officefit.check.mjs`. If an existing check asserts old geometry, update only that assertion in
`checks/office.check.mjs` or `checks/glanceoffice.check.mjs` and say so in your reply.

Final reply: the steps with their commit hashes, and anything skipped.
