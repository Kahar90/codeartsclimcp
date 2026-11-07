MODEL: maas/deepseek-v4.1-flash
You are working in a git repo (current directory): the CodeArts Office view `runner/office.html` (plain HTML/CSS/JS, one file, about 1950 lines, a pixel room with nameplates, a floating agent window, a plan menu, hover cards, a "+N more" list and a phone layout). Goal: make every floating surface stay on screen at any viewport size, and make the interactions feel polished: animated open/close, hover/press/selected states, a phone bottom sheet. The contract is `checks/polish.check.mjs` (section `office`): read it first, it prints what is off screen with coordinates.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going. Use grep to find code (`positionWin`, `openWin`, `closeWin`, `placeFloat`, `openPlanMenu`, `showHoverCard`, `#overflow`, `narrow`); do not read the whole file; make one edit per sub-change, run the check, read its numbers. Do not calculate layout by hand.

1. Agent window fits the screen: `#win` becomes a flex column (header, scrolling body, footer with the controls row and the steer box) with the body `overflow-y: auto; min-height: 0` so the header and steer box stay visible. In `positionWin`, compute the visible region as the stage rect intersected with the viewport (minus 8px margins), set `win.style.maxHeight` to that height before measuring, then place and clamp inside that region (not just inside the stage). Commit.
2. Keep it placed: re-run `positionWin` on window resize, on scroll of the page or the stage, and from a `ResizeObserver` on `#win` (its content changes on every poll), throttled with requestAnimationFrame. The polish check shrinks the viewport while the window is open and expects it back inside. Commit.
3. Phone (`body.narrow`): the agent window is a bottom sheet: `position: fixed; left: 0; right: 0; bottom: 0; max-height: 85vh; border-radius: 16px 16px 0 0`, a small grab handle bar at the top (decorative), slides up with a `sheet-up` keyframe (translateY(100%) to none, 260ms, cubic-bezier(.2,.8,.2,1)) and down on close; a `#winScrim` backdrop (fixed, inset 0, rgba(10,6,16,.5)) fades in behind it and closes the sheet on tap. Desktop keeps the anchored window. Commit.
4. Open/close motion for every floating surface, with keyframes defined in office.html: the desktop agent window scales from its anchor side (transform-origin on the side of the tail, `win-in` 180ms ease-out: opacity 0, scale(.96), translate 4px toward the anchor, to none; `win-out` 120ms); the plan menu and the "+N more" list use a `menu-in` pop (opacity 0, translateY(-4px) scale(.98) to none, 160ms) and the menu rows stagger by 15ms each (max 8 rows); the hover card fades and rises in after a 120ms hover intent delay and never flickers when the pointer moves between its triggers; the toast slides up and fades. With `prefers-reduced-motion: reduce` or when sprite motion is off, every one of these opens instantly (no animation, keep the existing `winInstant()` idea). Commit.
5. The plan menu and the hover card stay inside the viewport vertically as well: `placeFloat` flips above the anchor when there is no room below and sets `max-height` to the available space (the menu already scrolls). Hover cards hide on scroll and on Escape. Commit.
6. Nameplates and controls feel alive: `.plate` gets transitions (transform, border-color, box-shadow, 120ms); hover lifts it (`translate(-50%, calc(-50% - 1px))`) with a border in `var(--sel)`; `:active` presses it back; the plate whose window is open stays highlighted (`aria-expanded="true"` -> border var(--sel), soft glow `0 0 0 3px var(--sel-bg)`); the "!" badge pulses softly every 2.4s (box-shadow ring, not size) except under reduced motion; `.ov-row`, `#ovPill`, `#planBtn`, the window's control buttons and quick-steer chips get hover backgrounds and an `:active` press. On phone the needs pill and every button in the window are at least 32px tall. Commit.
7. Small details: the window close button has a 32px hit area with a hover circle; the window header text truncates with an ellipsis instead of wrapping under the close button; long lane names in plates truncate at 220px with an ellipsis and a title attribute; the "Needs you" pill count changes with a short scale bump (not on first render). Commit.
8. Test hook and self check: add `window.__office.state().win = { open, sheet: body.narrow, rect: {x, y, w, h}, maxHeight }`. Run every check below, fix what fails, re-read this brief and fix gaps. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below (they start their own headless Chrome).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit; the runner runs each of the lines below by itself at the end and sends you any failure.
CHECK: node checks/polish.check.mjs --only office
CHECK: node checks/office.check.mjs
CHECK: node checks/officeclick.check.mjs
CHECK: node checks/visibility.check.mjs
Constraints: no em dashes anywhere. `[hidden]` must always hide (add `[hidden]{display:none!important}` in office.html if a display rule could beat it). Only touch runner/office.html. Do not edit runner/assets/, runner/dash.html, runner/ca.mjs or any check.

Final reply: the steps with their commit hashes, and anything skipped.
