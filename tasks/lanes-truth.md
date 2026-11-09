You are working in a git repo (current directory). Goal: the Lanes view (`runner/dash.html`) shows one truthful
status per plan and per lane, so a person can tell at a glance whether anything needs them. Read
`tasks/status-contract.txt` first: the server adds `lane.status.attention`, `lane.status.steps`,
`lane.status.glyph` and `plan.badge` (another lane builds them; do not edit `runner/ca.mjs` or
`runner/controls.mjs`); fall back to today's behaviour when missing. Follow this brief directly; do not write
another plan. Read only relevant code. Do not ask questions; decide and keep going. After each step works, run its
targeted check, then `git add -A && git commit -m "step N: <summary>"`.

1. Plan truth: the plan homescreen status pill, the rail badge and the Control room plan rows show `plan.badge`
   (word, tone, glyph) instead of a word computed in the page, so they always equal the glance banner. Commit.
2. Lane truth: lane cards, rail rows and the Finished list show the status label with its glyph; show the step
   bar and "d/t steps" only when `status.steps` is live, a full bar with a check when complete, and no bar or
   fraction when hide (the lane detail page still lists the steps). Lanes with `status.attention` get the
   needs-you colour and are the only ones counted in the Needs you tile and title count. Add to the `?demo=1`
   fixture a closed plan "Glance status" with lanes Merged (complete), Handled by lead (hide), Stopped by lead
   (hide) and badge Done. Commit.
3. Check: `checks/lanestruth.check.mjs` (copy the harness of `checks/glancelanes.check.mjs`) asserting: the
   plan pill word equals the banner word on every demo plan; hide lanes show no step fraction or bar; complete
   lanes show a full bar; the Needs you count equals the number of attention lanes; no page errors. Save
   `lanestruth-*.png` screenshots. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing, in the foreground with a timeout; never
sleep-poll a background job. The runner runs the CHECK lines once when you finish and sends failures back.
CHECK: node checks/lanestruth.check.mjs
CHECK: node checks/glancelanes.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/removeui.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/dash.html` and `checks/lanestruth.check.mjs`. If an existing
check asserts an old label or count, update only that assertion in `checks/lanes.check.mjs` or
`checks/glancelanes.check.mjs` and say so in your reply.

Final reply: the steps with their commit hashes, and anything skipped.
