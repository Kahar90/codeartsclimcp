You are working in a git repo (current directory), a dependency-free Node ESM project (the `ca` lane
runner) with two browser pages served by `ca dash`: the Lanes dashboard `runner/dash.html` (route `/`,
polls with `refresh(false)` every 2.5 s) and the Office view `runner/office.html` (route `/office`,
polls with `tick` every 2 s).
Goal: two UX bugs reported by the user.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Bug A, flicker on hover: when the mouse rests on a plan (plan menu / plans rail) or on the tokens chip,
the hover card or tooltip disappears and reappears every few seconds. Cause: the poll rebuilds those
elements (innerHTML) even when nothing changed, which destroys the hovered node, fires mouseleave and
drops the hover card. Known spots in office.html: `renderPlanMenu` (`m.innerHTML = html` on every
render), the hover card `#hoverCard` (`card.innerHTML`), `#tokenChip`, `#planBtn`, `renderTokensRow`
(`tkBar`/`tkLegend` innerHTML), `renderWinContent`. In dash.html: the plans rail and token chips that
`refresh(false)` rebuilds.

1. office.html: make every poll-driven render a no-op when its output did not change: compare the new
   html (or a signature) with the last one and skip the DOM write, the same way `statusBadge` already
   does (`if (el.innerHTML !== html)`). The hover card must stay open and keep its position while the
   pointer stays on its anchor; when its content changes, update the text in place without hiding it.
   The plan menu must keep its open state, active item and scroll position across polls. Commit.
2. dash.html: the same for the plans rail, plan cards, token chips and any element with a hover card or
   title tooltip that `refresh(false)` rebuilds: skip unchanged writes; when a row changes, update that
   row in place (keyed by plan/lane id) instead of rebuilding the whole list. Commit.
3. Test hook: in both pages count DOM writes of these regions, e.g. `window.__office.renders()` and
   `window.__lanes.renders()` returning `{planMenu, hoverCard, tokens, rail, ...}` counters. Add
   checks/hover.check.mjs (model it on checks/lanes.check.mjs: free ports, `ca dash`, headless Chrome
   over CDP via checks/lib/chrome.mjs, PASS/FAIL lines, exit 1 on FAIL, 300 s timeout). On
   `/office?demo=1` and `/?demo=1`: open the plan menu / hover the tokens chip (dispatch real
   mouse events over CDP with Input.dispatchMouseEvent), wait 7 s (3 or more polls), assert the hover
   card is still visible, the hovered element is the same node (tag it with a property before waiting),
   and the render counters did not grow for unchanged data. Commit.
4. Bug B, office.html lane window: the "Steer this lane" input row sits tight against the quick-reply
   chips above it (Continue, Commit and go on, Stop planning, Run the checks, Wrap up). Give it room:
   about 12 px space above the input row, and a subtle separator (1px top border in the existing border
   color token with ~10 px padding) so it reads as its own section. Keep the window height bounded; do
   not change the chips. Check light and dark tokens. Commit.
5. Bug C, current step should look alive: in the Office lane window step list (`renderChecklist` /
   `#winSteps`, the `st-current` item whose mark is a static dot) and in the dash.html lane step list,
   replace the current step's dot with a small spinning ring (CSS only: ~10 px circle, 2 px border in
   the accent token with one transparent side, `animation: spin 0.9s linear infinite`), aligned exactly
   where the dot sat so the text does not shift. Only while the lane is running; a paused, failed or
   stopped lane keeps a static mark. Under `prefers-reduced-motion: reduce` show a static ring with no
   animation. The poll must not restart the animation (do not re-create the node when unchanged, see
   step 1). The hover check asserts the spinner element exists on the current step in `?demo=1`. Commit.
6. Self check: re-read against this brief; keyboard focus and Escape still work; no console errors; all
   CHECKs pass. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write other browser scripts; only run the CHECK commands.
- Never POST to a real dashboard on port 4777.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/hover.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/removeui.check.mjs
Constraints: no em dashes anywhere. Only touch runner/dash.html, runner/office.html,
checks/hover.check.mjs. Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
