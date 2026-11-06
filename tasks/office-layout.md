MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: the Office view (`runner/office.html`) must lay out the scene so that the new, larger isometric sprites never get clipped by the stage edge, never cover the nameplate of another platform, never overlap each other and stay legible, also for plans with many lanes. Read `runner/office.html` functions `computeLayout`, `nodeSvg`, `createChar`, `sizeChar`, `positionChar`, `demoModel` and the `.stage` CSS first, then `checks/layout.check.mjs` (the contract you must pass; do not edit it).

Facts about the sprites (`runner/office-sprites.js`, do not edit it): each sprite is an SVG with viewBox 160x200 drawn into a box of CW x CH (CW = RX * 1.15, CH = CW * 1.25). The feet anchor is at y = 186 of 200 (feetFrac 0.93), placed at the platform center plus footOff. The visible art spans roughly x 15 to 150 and y 22 to 200 of the viewBox (floating panels and badges reach the top). So the art rises about (186 - 22) / 200 * CH above the anchor.

Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. Demo fixture `?demo=big` (next to the existing demo fixtures; keep `?demo=1` and `?demo=done` exactly as they are): goal "Ship the harness-neutral CLI and Office view", lead "Claude Opus 5.5", 8 lanes in 4 waves shaped like a real plan. Wave 1: `office-scene` (running, phase build, 8 steps, 3 done, step 4 current), `office-sprites` (running, phase review, 8/8 done). Wave 2: `cli-dx` (done, 8/8, verdict ready). Wave 3: `mcp` (done, 8/8), `setup` (running, phase fix, 7/8), `office-motion` (needs review, 8/8, verdict "needs fixes"), `office-motion-fix` (planned, 4 steps). Wave 4: `onboard` (planned, 8 steps). Give each lane a model, tokens and step texts like the existing fixture. `?demo=big&done=1`: the same 8 lanes, all health done, result done, verdict ready, all steps done. Commit.
2. Row and column spacing in `computeLayout`: derive the row pitch from the sprite art height instead of a constant, so the art top of a lane on row r+1 sits at least 10 scene units below the bottom of the nameplate of row r (PLATE_Y + PLATE_H below the platform center). Derive the column pitch so neighbouring platforms and their art keep at least 24 units between them. Keep the lead top left and lanes by wave left to right, rows inside a wave. Commit.
3. ViewBox bounds in `computeLayout`: the top bound must include the tallest art (anchor minus the full art rise above it, plus padding), and the left/right bounds must include the art width as well as the platform, so no sprite is cut at any stage edge. Commit.
4. Stage size: keep the current stage height formula as the minimum, but when fitting the scene into that height would make the sprite boxes narrower than 105 px on desktop (stage width 700 px or more) or 52 px below 700 px, make the stage taller (height = what keeps that minimum sprite width at the current stage width, capped at 2400 px). The page then scrolls vertically; never horizontally. Sprites, platforms, links, cards and the completion section must stay correctly positioned after the resize (recompute positions on resize as today). Commit.
5. Card placement: the step card must stay inside the visible stage area after the stage grows (clamp its top and left to the stage box) and keep its tail pointing at the selected platform. Commit.
6. Test hook: keep `window.__office.state()` exactly as it is (nodes x/y in client px, card, complete). Make sure `?demo=big` nodes report the health values from step 1 and that `complete` is true only for `?demo=big&done=1`. Commit.
7. Self check: re-read your changes against this brief and fix bugs you find; run every CHECK line and fix every FAIL (do not edit files under `checks/`). Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit from step 2 on (step 1: `node checks/office.check.mjs`). The runner also runs every CHECK: line itself when you finish and sends you the output if one fails.
CHECK: node checks/layout.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/motion.check.mjs
CHECK: node checks/sprites.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office.html`. Do not edit `runner/office-sprites.js`, `runner/ca.mjs` or anything under `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
