MODEL: maas/deepseek-v4.1-flash   (optional line: build model for this lane; REVIEW_MODEL: too; STEP_REVIEW: off skips the per-step reviews)
You are working in a git repo (current directory). <one sentence goal, the files to touch, the stack>.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going. Follow this brief directly; do not write another plan
or restate the requirements. Read only relevant code and keep tool output focused.

1. <step: exact behaviour, file names>. Commit.
2. <step>. Commit.
...

Name every source or contract file the worker should read as an exact relative path (for example `runner/lane.mjs`), because the runner quotes the small, code-only ones into the first prompt; skip naming secrets, config, data or log files. Keep the brief lean: aim for 1 to 3 steps and never more than 8. Each step is a piece of behaviour
a check can prove, not a chore. Reuse a `CHECK:` command that already exists instead of adding a
near-duplicate, and reuse an existing test hook or script to verify the result. Add one only if missing. Do not add a separate "re-read and fix"
self-review step: the runner's reviewer gate and the lead's verification cover that.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing. Run each check in the foreground with a timeout (for example `timeout 600 node checks/x.check.mjs`); never sleep-poll a background job (`sleep N; cat log`), because every idle turn replays the whole context. Do not repeat the full suite for every step. The runner runs the CHECK lines once when you finish and sends failures back for fixes.
CHECK: <exact command, e.g. npm run typecheck>
CHECK: <another command, e.g. npm test>
Constraints: no em dashes anywhere. Only touch <files>. Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
