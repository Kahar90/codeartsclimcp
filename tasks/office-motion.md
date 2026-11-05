MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: make the Office view (`runner/office.html`, characters from `runner/office-sprites.js`) feel polished and alive, like a product launch demo: smooth intro, calm ambient motion, crisp interaction feedback and satisfying live events, at a steady 60 fps. Vanilla JS, CSS animations and the Web Animations API only, no libraries. Read `runner/office.html`, `runner/office-sprites.js`, `checks/office.check.mjs` and `checks/motion.check.mjs` (the motion contract) first.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Motion rules for every step: animate only transform, opacity, filter and stroke-dashoffset (never width/height/top/left/box-shadow/colors in keyframes; fade a glow layer's opacity instead). Easing: entrances `cubic-bezier(.2,.8,.2,1)` or a spring-like overshoot `cubic-bezier(.34,1.56,.64,1)`, exits `cubic-bezier(.4,0,1,1)`. Durations: micro 120 to 200 ms, UI 240 to 400 ms, intro total under 2.5 s. Tokens as CSS variables at the top (`--ease-out`, `--ease-spring`, `--dur-ui` ...). `will-change` only on elements that animate.

1. Keyed rendering: every data tick (live poll every 2 s, and a 2 s demo tick that goes through the same code path) updates existing DOM nodes by id (`data-node="<id>"` on each platform group, lead is "lead"), creating nodes only for new ids and removing only gone ones; never rebuild the scene or card with innerHTML on a tick. Count ticks in `state().ticks`. Also fix the look while you are here: characters are too small and stand on the back rim. Make each character about 40 percent of the platform width, feet on the platform center (slightly below the ellipse center, so they stand on the disc), drawn above the platform top. Give each platform a visible disc thickness: a side wall about 14 px tall below the top ellipse (darker gradient) with the health rim glow along the lower front edge, like a thick puck seen from above. Commit.
2. Intro: on first render the floor fades in and settles from a steeper tilt (perspective rotateX) to its resting angle, platforms rise and scale in staggered 90 ms apart with the spring ease (lead first, then by wave), links draw from the lead outward with stroke-dashoffset, characters drop in with a small bounce after their platform, name plates fade in last. `state().anim.intro` is 'running' then 'done'. Commit.
3. Ambient: running platforms: the rim glow layer breathes (opacity, 2.4 s), packets travel along links (CSS offset-path or WAAPI on transform along precomputed points) with a short fading trail of 3 dots; idle and done characters float 2 px slowly with per-node phase offsets so they never move in sync; a very slow drift of the floor grid (transform). quiet: slower breathing; STALLED: amber-red flicker every few seconds. Commit.
4. Interaction: hover lifts the platform group 6 px and brightens its rim glow (transition 180 ms), with the cursor a pointer; `state().hovered` = id or null. Selection: spotlight cone fades and scales in; the card pops from the platform side (transform-origin toward the platform, scale .92 to 1 + fade, 260 ms), checklist rows stagger in 40 ms apart, closing reverses quickly (160 ms). `state().anim.card` = 'opening' | 'open' | 'closing' | 'closed'. Commit.
5. Live effects (diff the previous and new data per lane): a step turns done: its check mark draws in (stroke-dashoffset), the progress bar fills with a smooth transform scaleX, and the platform emits a ripple ring (an element with class `ripple`, scale 1 to 1.6 and fade, removed on animationend, about 1 s). A lane gets result done: rim turns green with a soft burst (8 short rays, fade) and the character switches to idle with a crossfade. A lane fails or stops: a short horizontal shake (3 cycles, 300 ms) and a red flash of the rim glow. Health colour changes crossfade via two stacked glow layers. Log every effect in `state().anim.effects` (last 20, strings like 'step-done:<id>', 'lane-done:<id>', 'lane-failed:<id>') and the newest in `state().anim.lastEffect`. Commit.
6. Demo controls for testing and showing off: `__office.demoAdvance(id)` marks that lane's next step done (and finishes the lane after the last one), `__office.demoFail(id)` fails it; both only in demo mode, then the next tick picks the change up through the normal diff. Completion panel: slides up, rows stagger in, and the summary numbers count up over 1.2 s (elements with `data-count="<final value>"`, final text equals the value). Commit.
7. Reduced motion: with `prefers-reduced-motion: reduce` skip the intro (`anim.intro` 'done' at once), no infinite animations (no breathing, packets, float, drift), effects become simple 150 ms fades; `state().anim.reducedMotion` reflects it and updates if the media query changes. Commit.
8. Self check: re-read against this brief, fix jank (layout reads inside animation loops, timers that leak, animations restarting on ticks, effects firing twice on first load: the first data load must not count as changes). Run all CHECK lines until they pass. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node checks/office.check.mjs
CHECK: node checks/motion.check.mjs
CHECK: node checks/sprites.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office.html` and, for character motion only (keep its API and contract), `runner/office-sprites.js`. Do not edit `checks/`, `runner/ca.mjs`, `runner/dash.html`.

Final reply: the steps with their commit hashes, and anything skipped.
