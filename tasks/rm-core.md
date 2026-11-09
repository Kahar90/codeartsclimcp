You are working in a git repo (current directory), a dependency-free Node ESM project (the `ca` lane runner).
Goal: add a clean delete for lanes and plans. Deleting kills every process of the lane (supervisor
and codearts server), unregisters it and purges its lane logs, so nothing is left running or tracked.
It must work from the CLI, the dashboard HTTP API and MCP. Another lane builds the UI buttons
against the API contract in step 4; keep that contract exact.
NOTE: runner/ca.mjs already holds an uncommitted draft of step 1 from an earlier run (see `git diff`).
Review it, finish step 1 and commit it as step 1. Git works normally in this folder.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Background (runner/ca.mjs): lanes are registered as `<REG>/<id>.json` ({id, dir, repo, task}),
a finished copy may sit in `<REG>/final/<id>.json`, acks in `<REG>/acks.json` (readAcks/writeAcks).
Lane state is `<dir>/state.json` (`s.pid` = supervisor, `s.server.pid` = codearts server). The lane
dir is `<repo>/tasks/<task>.lane/`, the log is `<repo>/tasks/<task>.lane.log`, the brief is
`<repo>/tasks/<task>.md`. Helpers exist: `lanes()`, `findLane`, `pickOne`, `alive`, `killTree`,
`plans()`, `findPlan`, `planView`, `planClosed`, `ensurePlan`, `PLANS`, `laneId`, `projectOf`.
Dashboard routes live in `cmdDash` (`/api/lane/<id>/<action>` handlers, `readBody`, `json`).

1. In runner/ca.mjs add `removeLane(l, { purge = true, by = 'ca rm' } = {})`:
   - if the supervisor `s.pid` is alive: write `<dir>/STOP`, then `killTree(s.pid)`; always
     `killTree(s.server?.pid)` when that pid is alive; then poll up to 5 s until neither pid is alive.
     Collect the killed pids.
   - delete `<REG>/<id>.json`, `<REG>/final/<id>.json` and the lane's entry in acks.json.
   - if purge: `fs.rmSync` the lane dir (recursive, force) and the `.lane.log` file. Never delete the
     brief `tasks/<task>.md`, never touch git worktrees or branches.
   - in every registered plan file that lists this lane (same matching as `noteResume`), set
     `removed: true` on that lane entry and push a decision `Lane <task> deleted from the <by>`.
   - return `{ ok: true, id, killed: [pids], removed: [paths deleted] }`; errors as `{ error, code }`.
   Make `planView` (and anything that builds a plan's wave lane list) skip lane entries with
   `removed: true`, so a deleted lane does not come back as "planned". Commit.
2. Add `removePlan(r, { by })`: call `removeLane` for every lane of the plan that resolves to a
   registered lane (use the same id resolution planView uses); then in the plan file set
   `status: 'closed'`, `removed: true`, `now: 'Deleted from the <by>'` plus a decision, and delete
   `<PLANS>/<id>.json`. Return `{ ok: true, id, lanes: [removed lane ids], killed: [pids] }`.
   Make `plans()` skip plans whose file has `removed: true`. In `ensurePlan`, when the current
   plan.json is closed AND `removed: true`, archive it as today but do NOT register the archive
   (a deleted plan must never reappear). Commit.
3. CLI: `ca rm <lane> [--keep-logs]` (uses findLane; prints one line with the id, killed pids and
   removed paths; exit 0; unknown lane exits 2 like other commands). Change `ca plan rm <id>` to
   call removePlan (kills and deletes its lanes); add `ca plan rm <id> --keep-lanes` for the old
   unregister-only behaviour. Update the usage/help comment block at the top of ca.mjs and the
   command table. Commit.
4. Dashboard API in cmdDash (POST, content-type application/json, body `{}` or `{keepLogs:true}`):
   - `POST /api/lane/<id>/remove` -> removeLane result as JSON (200), 404 unknown, 409 ambiguous.
   - `POST /api/plans/<id>/remove` -> removePlan result (200); 404 when no registered plan has that
     exact id (ids may contain `~` and `.`; decodeURIComponent the segment; exact id match only).
   Commit.
5. MCP (runner/mcp.mjs): add tools `ca_rm` {lane: string, keep_logs?: boolean} and
   `ca_plan_rm` {id: string, keep_lanes?: boolean}, implemented the same way the existing tools call
   the CLI; add both to DESTRUCTIVE_TOOLS. Clear descriptions: "kills the lane's processes,
   unregisters it and deletes its lane logs; the brief is kept". Commit.
6. Add checks/remove.check.mjs (style of checks/planstate.check.mjs: temp CA_REGISTRY, CA_DASH=0,
   fake lanes, never starts CodeArts, prints PASS/FAIL lines, exits 1 on any FAIL). It must verify:
   a finished lane: `ca rm` removes registry json, final json, lane dir, log; keeps the brief; `ca status`
   no longer lists it. A "running" lane whose state.json has `pid` and `server.pid` set to two
   long-sleeping node child processes the check spawns itself (`node -e "setTimeout(()=>{},600000)"`,
   detached): after `ca rm` both pids are dead and the lane is gone. A plan listing two lanes:
   `ca plan rm` removes both lanes, unregisters the plan, plan file has removed:true, `ca plan list`
   no longer shows it. `--keep-lanes` leaves lanes registered. The HTTP API: start `ca dash <freeport>`
   with the temp registry, POST both remove routes and check 200 + effect, 404 on unknown ids, 415
   without JSON content-type. MCP: tools/list (see checks/mcp.check.mjs for how) includes ca_rm and
   ca_plan_rm with destructiveHint true. Kill anything the check spawned in a finally block. Commit.
7. Self check: re-read your changes against this brief and fix bugs you find. Run every CHECK.
   Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git). The
  check may kill only the sleeper processes it spawned itself.
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- Never run `ca rm`, `ca plan rm` or `ca gc` against the real registry: only with a temp CA_REGISTRY.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node --check runner/mcp.mjs
CHECK: node checks/remove.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/mcp.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs, runner/mcp.mjs, checks/remove.check.mjs,
and checks/planstate.check.mjs or checks/mcp.check.mjs only if an assertion there contradicts this brief
(say so in the commit). Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
