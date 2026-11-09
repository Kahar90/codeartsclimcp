You are working in a git repo (current directory). Goal: the dashboard API answers fast as plans and lanes pile up. Only runner/ca.mjs changes (plain Node ESM).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Measured cause (by the lead, CPU profile of `ca dash`): 70% of every /api/plans, /api/lanes and /api/overview answer is readFileSync + JSON.parse of the same small files, over and over:
- `planView(r)` calls `lanes()` once per plan, and `lanes()` reads every registry entry and every lane's state.json.
- `laneStatusOf` calls `closedPlanLanes()` for every lane, and that calls `plans()`, which readdirs the plans folder, reads every registration and every plan.json (the `removed` filter) and stats them, per lane.
- `projectOf` spawns git per repo (cached), fine.
The contract is checks/perf.check.mjs (already written; read it, do not edit it): 8 plans x 10 lanes + 20 loose lanes, each route's median must be under 60 ms (today about 1000 ms), and a changed state.json or plan.json must show on the very next poll.

1. Add a file cache in runner/ca.mjs: `readJSONCached(file)` keyed by path, valid while `fs.statSync` mtimeMs and size are unchanged (return the cached parsed value, never a shared mutable object the callers then mutate: return a structuredClone, or make sure callers do not mutate it; check the callers you switch). Missing file: return null, and drop the entry. Use it in `lanes()` (registry entries, state.json, final/), `plans()` and `closedPlanLanes()` (plan files), and `planView` (plan.json). Keep `readJSON` for writers and CLI paths that read-modify-write. Commit.
2. Snapshot per request: `lanes()` and `plans()` results memoised for the duration of one HTTP request in `ca dash` (for example a module-level memo cleared at the start of each request, or a 250 ms TTL that the request handler resets). planView must reuse the snapshot instead of calling lanes() per plan; closedPlanLanes must reuse plans(). CLI commands outside the dashboard must behave exactly as before. Commit.
3. Remove any other per-lane or per-plan repeated work the CPU profile would still show (measure with the check, not by reading code: run `node checks/perf.check.mjs` and look at the numbers). Commit.
4. Self check: run every check below, fix what fails. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.
- Use grep to find code; do not read the whole 2500 line file. One edit per sub-change, then run the check.

Checks: run these before each commit (the runner also runs every line below when you finish).
CHECK: node --check runner/ca.mjs
CHECK: node checks/perf.check.mjs
CHECK: node checks/time.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/bucket.check.mjs
CHECK: node checks/glance.check.mjs
CHECK: node checks/controls.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs. Do not edit any file under checks/.

Final reply: the steps with their commit hashes, the before/after median of each route from perf.check, and anything skipped.
