KIND: code
You are working in a git repo (current directory). Goal: every lane belongs to a plan and the Office always shows the plan that is working. When `ca lane` starts a lane whose task is not in the repo's open plan, the runner adds it (creating and registering a plan when there is none, archiving a closed one); the Office view shows the plan with a running lane, else the newest open plan, and switches to a new plan or to a lane that newly starts running, and it never shows lanes outside the shown plan. Files: `runner/ca.mjs` (a new `ensurePlan` helper called from `runLane`, plus the plan registry helpers), `runner/onboard.mjs` (one env var), `runner/office.html` (plan selection), `checks/visibility.check.mjs`. Node 22 ESM, no dependencies. Read `checks/planbind.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Commit messages are plain: no Co-Authored-By or any other trailer. Do not ask questions; decide and keep going.

Facts: a plan is `<main repo>/tasks/plan.json`, registered in `REG/plans/<id>.json` as `{id, file}` with `id = planId(file)` (the main repo folder name); `planView` matches a plan lane to a running lane by `laneId(path.resolve(base, pl.repo || '.'), pl.task)` where `base` is the plan file's repo. A lane may run in a git worktree: its main repo is the parent folder of `git rev-parse --git-common-dir` (resolved against the lane repo). `ca plan close` sets `status: "done"`; a plan with status `done` or `closed` is closed.

1. `runner/ca.mjs`: add `ensurePlan(repo, task, briefText)`. Skip it when `process.env.CA_NO_PLAN === '1'`. Find the main repo (worktree aware), `planFile = <main>/tasks/plan.json`, `rel = path.relative(main, repo)` with forward slashes (`'.'` when equal). If the plan file exists, is open and already lists the task (same task and same resolved repo): only make sure it is registered (write `REG/plans/<planId>.json` if missing). Commit.
2. Same helper, open plan without the task: append `{ task, repo: rel, why: <brief goal>, added: 'runner' }` to `lanes` and the task to a wave named `Added while running` (create that wave at the end if missing), log a decision `Lane <task> added by the runner (it was not in the plan)`, write the file atomically (write a temp file, then rename), and make sure it is registered. Use a lock file `<planFile>.lock` (create with flag `wx`, retry for up to 5 s, remove it in finally) so two lanes starting at once do not lose each other's edits. Commit.
3. Same helper, no plan file or a closed one: if a closed plan exists, move it to `<main>/tasks/plans/<YYYYMMDD-HHMMSS>.json` and update its registry entry to `{ id: '<planId>~<stamp>', file: <new path> }` (rename the registry file accordingly) so it stays listed as closed. Then create a new open plan: `title` and `goal` from the brief (the text after `Goal:` up to the first period, else the first sentence, else `Lane <task>`), `lead: process.env.CA_LEAD || 'lead'`, `status: 'running'`, `now: ''`, `waves: [{ name: 'Lanes', lanes: [task] }]`, `lanes: [{ task, repo: rel, why: <goal> }]`, `decisions: [{ at, text: 'Plan created by the runner: lane <task> started without an open plan.' }]`, `next: []`, `risks: []`; register it. Commit.
4. Call `ensurePlan` in `runLane` right after the brief checks (after the placeholder CHECK refusal, before the lane is registered), never for `--resume` runs that are already in a plan, and wrap it so a failure only logs a warning line and never stops the lane. `runner/onboard.mjs`: run the smoke lane with `CA_NO_PLAN: '1'` in its env. Commit.
5. `runner/office.html` plan selection: remove the cast extension that adds running lanes from outside the shown plan (`liveModel` shows only the plan's lanes again). Default view (`defaultPlanId`): the plan with a running lane, else the newest open plan, else the newest plan; use the "Recent lanes" view only when there are no plans at all, and do not offer it in the picker when plans exist. Commit.
6. `runner/office.html` following new work: keep the rule that a plan appearing while the page is open is shown at once (even over a hand pick). Add: when a lane id becomes running that was not running at the previous poll, show the plan that lists it (even over a hand pick). Track the previous running ids; the first poll only records them. Commit.
7. `checks/visibility.check.mjs`: update it to the new rules (no lanes outside a plan on screen; the old "running lane outside the plan joins the cast" assertions become "a lane started in a plan switches the Office to that plan"; give its quick lanes a plan the way the runner would). Then `node checks/planbind.check.mjs`, `node checks/visibility.check.mjs`, `node checks/office.check.mjs`, `node checks/officeclick.check.mjs`, `node checks/planstate.check.mjs`, `node checks/resume.check.mjs`, `node checks/ratelimit.check.mjs` and `node checks/onboard.check.mjs` pass. Commit.
8. Self check: re-read against this brief; a lane can never end up outside a plan (except CA_NO_PLAN=1); a lead-written plan is never rewritten except to append a missing lane; a broken plan file never stops a lane (warning only); no em dashes. Run every check line. Commit if changed.

Safety rules (hard):
- Never run `ca lane`, `ca plan`, `ca stop` or `ca dash` by hand against the real registry: only the checks below (they use a private CA_REGISTRY and a fake CodeArts server).
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/planbind.check.mjs
CHECK: node checks/visibility.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/officeclick.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/ratelimit.check.mjs
CHECK: node checks/onboard.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs` (ensurePlan, runLane's call, plan registry helpers), `runner/onboard.mjs` (the smoke env), `runner/office.html` (plan selection) and `checks/visibility.check.mjs`. Do not edit `runner/dash.html`, `runner/mcp.mjs`, `cmdAck`, the help text, `docs/` or other checks.

Final reply: the steps with their commit hashes, and anything skipped.
