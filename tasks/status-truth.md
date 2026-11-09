You are working in a git repo (current directory). Goal: the server gives every lane and plan one truthful,
glanceable status, so the views can never show two statuses that disagree. Read `tasks/status-contract.txt`
first: it is the exact shape the two view lanes rely on. Follow this brief directly; do not write another plan.
Read only relevant code: `runner/controls.mjs` (laneOutcome, laneBucket), `runner/ca.mjs` (bucketFor near line
1120, cmdAck near 1300, glanceOf and planView near 2050, cmdPlan update). Do not ask questions; decide and keep
going. After each step works, run its targeted check, then `git add -A && git commit -m "step N: <summary>"`.

1. Lane status: in `laneOutcome` add `attention`, `steps` and `glyph` exactly as in the contract, and the labels
   "Handled by lead", "Merged", "Stopped by lead". Make `ca ack` on any finished lane (stopped, killed, done,
   needs-you...) mark it handled, so an acked stopped lane reads "Handled by lead" (today bucketFor only treats
   acked attention lanes as handled). In `planView`, every ended lane of a closed plan gets `attention: false`,
   and its bucket must not be "attention" in `/api/lanes` and `ca status` either. Commit.
2. Plan badge and detail: add `plan.badge` from the glance (contract part 2) and strip a leading "Closed:" and
   "Done:" from a closed plan's glance detail. Add `ca plan update <id> --patch-file <file>` and `--patch -`
   (read JSON from stdin), since Windows PowerShell splits a JSON argument with spaces. Commit.
3. Worker guidance and check: in `templates/brief.md` and the runner's gate failure message in `runner/ca.mjs`
   (`gates()`), tell the worker to run checks in the foreground with a timeout and never sleep-poll a
   background job (`sleep N; cat log`), because every idle turn replays the whole context. Add
   `checks/statustruth.check.mjs` covering: every laneOutcome key gets the contract attention/steps/glyph;
   ack of a stopped lane gives "Handled by lead" with steps hide; a closed plan's lanes have attention false
   and plan.badge equals the glance word; the Closed:/Done: prefixes are stripped; `--patch-file` and
   `--patch -` work. Reuse the temp-home pattern of `checks/planstate.check.mjs`. PASS/FAIL lines, exit 1 on
   any FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing, in the foreground with a timeout. The runner
runs the CHECK lines once when you finish and sends failures back.
CHECK: node --check runner/ca.mjs
CHECK: node checks/statustruth.check.mjs
CHECK: node checks/glance.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/status.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/controls.mjs`, `runner/ca.mjs`, `templates/brief.md`,
`checks/statustruth.check.mjs`. If an existing check asserts an old label ("Handled", "Stopped"), update only
that assertion inside `checks/status.check.mjs` or `checks/glance.check.mjs` and say so in your reply.

Final reply: the steps with their commit hashes, and anything skipped.
