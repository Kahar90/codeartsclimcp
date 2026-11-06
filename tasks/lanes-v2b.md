MODEL: maas/glm-5.3
REVIEW_MODEL: maas/glm-5.3
You are working in a git repo (current directory). This continues the lane in `tasks/lanes-v2.md`: read it first, it is the full spec. Steps 1 to 6 of it are already committed (see git log). The lead looked at screenshots and found the bugs below. Fix them, then finish the remaining steps.

Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number below). Do not ask questions; decide and keep going. Make a change, run the check, read its numbers; do not compute layout numbers in your head for more than a minute. Keep each reasoning block short and act. The browser check for this page is (re)written in the test hook step; before that step run only the other CHECK lines.

1. Narrow layout (< 760 px): the "Plans and lanes" `<details>` is shown closed but the whole rail body still renders under it; closed must hide the rail body and open must show it. On the lane route the order is: back link, identity, metrics, path, phase strip, Now, steps, context, evidence; the action bar is fixed to the bottom of the viewport (not in the middle of the page, as now where it appears above the identity row), with page bottom padding equal to its height plus 16 px. No horizontal page overflow. Commit.
2. Desktop action bar: at 1586x992 on the lane route the bar sits at y about 860 while the evidence panel border continues below it to the bottom of the window. The main column must be the scroll container, the bar sticky at its bottom edge with an opaque --bg background and a top border, nothing painted below it, and 80 px of bottom padding so the last transcript row is readable above the bar. Commit.
3. Demo lookups: `/?demo=1#/lane/office-layout` (short task name) shows "The brief has no numbered steps" and one transcript line. The demo fetch layer must resolve lane ids like the server (exact id, then task name, then substring), and every demo lane detail must carry its steps; office-layout has the 7 steps of the fixture with step 1 current, and its transcript starts with at least 6 lines (Lane started, Build session opened, Reading layout code, read runner/office.html, read checks/layout.check.mjs, ...) before the 1.5 s growth. Also move the wave collapse chevron to the left of the wave title (it is a small play triangle at the far right now) and label the lead band "Lead now". Commit.
4. Test hook and check (step 7 of the original brief): Test hook and check: `window.__lanes.state()` returns {route:{kind,id}, rail:{plans:[{id,selected}], finished:[id]}, plan:{waves:[{name, collapsed, lanes:[{id, href, stepsOpen}]}]}|null, lane:{id, phase, liveSegment, tab, follow, transcriptScrollTop, transcriptAtBottom, steps:[{n,state}], draft, sending}|null, sprites:{count, animating}, overflowX:boolean (document.documentElement.scrollWidth > innerWidth)}. Write `checks/lanes.check.mjs` (copy the CDP harness pattern from `checks/office.check.mjs`: own dash port, headless Chrome on a free CDP port with an absolute `--user-data-dir`, real `Input.dispatchKeyEvent`/`Input.dispatchMouseEvent`, screenshots into `checks/out` or argv[2]) that loads `/?demo=1` and asserts: rail lists 2 plans and 5 finished; the top bar counts are inside the viewport at 1280x800 and at 390x844; the first plan's route renders 1 wave with a lane link whose href is `#/lane/<id>`; the step disclosure opens without changing the route; on the second plan, collapsing its wave and expanding it again keeps an open step disclosure open; clicking the lane link routes to the lane, history.back() returns to the plan; on the lane, Follow live on keeps transcriptAtBottom true as lines arrive; turn it off, scroll up, wait 3 s: scrollTop unchanged; switch to Brief, wait 3 s, back to Transcript: follow still off and scrollTop restored; type a steer draft, navigate to another lane and back: draft restored; Steer on a finished lane shows the inline error and keeps the text; ArrowRight on the focused Transcript tab selects Review; no horizontal overflow at 390x844; `/` without demo and with an empty registry shows `#onboard`. Screenshots: lanes-home, lanes-detail-transcript, lanes-detail-brief, lanes-phone-home, lanes-phone-detail. Commit.
5. Self check: re-read your changes against both briefs, run every CHECK line and fix every FAIL. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself except through `node checks/lanes.check.mjs`.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/assets.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/onboard.check.mjs
CHECK: node checks/think.check.mjs
Constraints: no em dashes anywhere. Only touch runner/dash.html and checks/lanes.check.mjs. Do not edit runner/office.html, runner/ca.mjs or anything in runner/assets/.

Final reply: the steps with their commit hashes, and anything skipped.
