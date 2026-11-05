MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: fix three findings in the Office view `runner/office.html` from review. `checks/motion.check.mjs` now has tests for each (read it first).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.

1. Resize geometry (office.html around `layout` / `nodeSvg` / `updateNode`, line ~319 and ~397): when the layout is recomputed (window resize, crossing the 700 px small breakpoint), `updateNode` must re-bake every platform's geometry in place: the top ellipse rx/ry, the side wall path (`wallD`), the front arc (`frontArcD`), glow layers, the name plate position and the character size, keeping the same `[data-node]` elements (no rebuild). Give each platform's top ellipse the class `plat-top`. Expose `state().geometry = {small, RX, RY, WALL}`. Commit.
2. Reduced motion effects (office.html ~953): with `prefers-reduced-motion: reduce`, lane-done burst, lane-failed shake and the red flash must not be skipped; show each as a simple opacity fade of 150 ms (the glow layer or a flash overlay), and keep logging them in `state().anim.effects`. Commit.
3. Completion sentence: total lane time is printed as raw seconds ("5160 s"); format durations as `1h 26m`, `12m 5s` or `40s` (one helper, also used in the table if times appear there). Commit.
4. Self check: run every CHECK line until all pass; fix anything else you broke. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node checks/motion.check.mjs
CHECK: node checks/office.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office.html`. Do not edit `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
