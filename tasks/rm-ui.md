You are working in a git repo (current directory), a dependency-free Node ESM project (the `ca` lane
runner) with two browser pages served by `ca dash`: the Lanes dashboard `runner/dash.html` (route `/`)
and the Office view `runner/office.html` (route `/office`).
Goal: users find both pages cluttered. Add Delete buttons so a user can delete a plan or a single
lane and it disappears from view. Another lane builds the server side in parallel; this lane only
calls this API contract (do not implement it, do not touch runner/ca.mjs):
- `POST /api/lane/<encodeURIComponent(laneId)>/remove`, headers content-type application/json, body `{}`
  -> 200 `{ ok: true, id, killed: [pids], removed: [paths] }`, or 4xx `{ error }`.
- `POST /api/plans/<encodeURIComponent(planId)>/remove`, same headers, body `{}`
  -> 200 `{ ok: true, id, lanes: [lane ids], killed: [pids] }`, or 4xx `{ error }`.
Deleting kills running lanes and deletes their logs; the brief file is kept.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Pointers: dash.html has `api()` (every /api call; `?demo=1` swaps it to `demoApi`), `demoPost`,
`demoLanes`, `demoPlans`, `demoControls`, `sendControl`, `toast`, the plans rail, the plan homescreen
and the full-page lane detail. office.html has `renderPlanMenu`, `pickPlan`, `renderControls(l)`,
the lane window, a live loader that fetches `/api/plans` and `/api/lanes`, and demo modes
(`?demo=1`, `?demo=done`, `?demo=big`, `?demo=crowd`, `?demo=stuck`).

1. dash.html: a small "Delete" control (trash icon + text, matching existing button styles, keyboard
   reachable, aria-label "Delete plan <title>" / "Delete lane <task>") on every plan in the plans rail
   and on the plan homescreen header, and on every lane row/card and the lane detail page header.
   Clicking asks `window.confirm()` with a clear message: for a plan "Delete plan <title>? Its N
   lane(s) will be stopped, their processes killed and their logs deleted. Briefs are kept."; for a
   lane the same for one lane ("running: it will be stopped and killed" when it is running). On OK it
   POSTs the route through `api()`, shows a toast with the result, removes the item from view at once,
   refetches, and if the user was viewing the deleted plan or lane, navigates back to the home view.
   Errors show as an error toast and nothing is removed. Commit.
2. dash.html demo fixture: `demoPost('remove', id)` for lanes and a demo handler for
   `/api/plans/<id>/remove`; keep a module-level `demoRemoved` Set of lane ids and plan ids that
   `demoLanes()` and `demoPlans()` filter out (a deleted plan also removes its lanes; a deleted lane
   also disappears from its plan's waves). Push `{action:'remove', laneId|planId}` to `demoControls`.
   Expose `window.__lanes.removed()` returning the Set as an array (extend the existing
   `window.__lanes` hook object if there is one). Commit.
3. office.html: a Delete control on each plan in the plan menu (`renderPlanMenu`, a trash button next
   to each item that does not trigger pickPlan) and in the lane window controls (`renderControls`).
   Same confirm text, same POSTs (fetch with content-type application/json). After success remove the
   desk/station/card from the scene at once and reload data; if the shown plan was deleted, switch to
   the next plan (defaultPlanId) or the empty state. In demo modes do not fetch: drop the plan or lane
   from the demo data in memory. Expose `window.__office.removed()` (or extend the existing office test
   hook) returning removed ids. Commit.
4. Add checks/removeui.check.mjs modelled on checks/lanes.check.mjs (free ports, `ca dash`, headless
   Chrome over CDP via checks/lib/chrome.mjs, PASS/FAIL lines, exit 1 on FAIL, 300 s timeout, cleanup
   kills only the Chrome and dash it spawned). In page, override `window.confirm = () => true`. On
   `/?demo=1`: delete one lane via its Delete button (click the real element), assert its row is gone
   and `__lanes.removed()` has it; delete a plan via its Delete button, assert the plan and its lanes
   are gone from the rail and lists. Then set `window.confirm = () => false`, click Delete on another
   lane, assert it is still shown. On `/office?demo=1`: delete a plan from the plan menu and a lane from
   its window, assert they are gone from the DOM and the hook. Save screenshots to the out dir
   (argv[2] or checks/out). Commit.
5. Self check: re-read the changes against this brief, keyboard focus and Escape still work, no
   console errors, the existing checks still pass. Fix and commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write other browser scripts; only run the CHECK commands.
- Never POST to a real dashboard on port 4777; only demo mode and dashboards the checks start.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/removeui.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
Constraints: no em dashes anywhere. Only touch runner/dash.html, runner/office.html,
checks/removeui.check.mjs, and checks/lanes.check.mjs or checks/office.check.mjs only if a count of
demo items there must change (say so in the commit). Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
