MODEL: maas/glm-5.3
REVIEW_MODEL: maas/glm-5.3
You are working in a git repo (current directory). This continues the lane in `tasks/office-v2.md`: read it first, it is the full spec. Steps 1 to 6 of it are already committed (see git log). The lead looked at screenshots and found the bugs below. Fix them, then finish the remaining steps.

Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number below). Do not ask questions; decide and keep going. Make a change, run the check, read its numbers; do not compute layout numbers in your head for more than a minute. Keep each reasoning block short and act. The browser check for this page is (re)written in the test hook step; before that step run only the other CHECK lines.

1. Window anchoring: in `?demo=1` with office-scene selected at 1280x800 the window opens to the right and covers the office-review nameplate and part of the reviewer sprite. Score every candidate (right, left, below, above) by its overlap area with the other stations nameplates and sprite boxes (client rects), keep only candidates inside the stage with a 10 px inset, and pick the lowest score (ties: the order right, left, below, above). Keep the tail pointing at the station. Commit.
2. Narrow run strip: at 390 px wide the strip shows "Of..." and "Now: ...". Below 700 px let the strip wrap: plan title on its own line (wraps, never ellipsis), then the Now text (wraps), then the chips and Motion button on one row. Commit.
3. Test hook and check (step 7 of the original brief): Test hook and check: `window.__office.state()` returns {mode, plan, goal, stage:{x,y,w,h,k}, stations:[{station, role, laneId, name, status, clip, foot:{x,y} client px, plate:{x,y,w,h} client px, done, total}], overflow:[laneId], window:{open, laneId, x,y,w,h, focusInside}, effects:[{type, laneId, at}], motion:bool}; `__office.press(laneIdOrLead)`, `__office.demoAdvance(id)` (next step, then done), `__office.demoFail(id)`. Rewrite `checks/office.check.mjs` (keep its CDP harness code and its first server checks; screenshots into the out dir) to assert: stage aspect 16:9 and full width at 1280x800; four stations in `?demo=1` with sprites inside the stage; stage rect identical before and after opening the window; pressing another station moves the window (still one `[role=dialog]` in the DOM); Escape closes and returns focus to the trigger (real `Input.dispatchKeyEvent` keys: Tab to a nameplate, Enter, Escape); outside click closes; window rect inside the stage at 1280x800 and at 390x844; `?demo=big` has 5 overflow lanes; demoAdvance adds exactly one `step` effect and a second state() call adds none; reload with the same state adds no effects; with `Emulation.setEmulatedMedia` prefers-reduced-motion every sprite reports its static frame; steer draft for lane A survives switching to lane B and back. Screenshots: 1-scene, 2-window, 3-window-switched, 4-phone, 5-big, 6-live. Commit.
4. Self check: re-read your changes against both briefs, run every CHECK line and fix every FAIL. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself except through `node checks/office.check.mjs`.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/assets.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/think.check.mjs
Constraints: no em dashes anywhere. Only touch runner/office.html, checks/office.check.mjs, checks/think.check.mjs (that one check), the files step 1 deletes, and the one route line in runner/ca.mjs. Do not edit runner/dash.html or anything in runner/assets/.

Final reply: the steps with their commit hashes, and anything skipped.
