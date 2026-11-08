MODEL: maas/deepseek-v4.1-flash   (optional line: build model for this lane; REVIEW_MODEL: too)
You are working in a git repo (current directory). <one sentence goal, the files to touch, the stack>.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. <step: exact behaviour, file names>. Commit.
2. <step>. Commit.
...

Keep the brief lean: aim for 1 to 3 steps and never more than 8. Each step is a piece of behaviour
a check can prove, not a chore. Reuse a `CHECK:` command that already exists instead of adding a
near-duplicate, and include one step that adds a test hook or script so the result is verifiable
without vision (for example window.__app.state()). Do not add a separate "re-read and fix"
self-review step: the runner's reviewer gate and the lead's verification cover that.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: <exact command, e.g. npm run typecheck>
CHECK: <another command, e.g. npm test>
Constraints: no em dashes anywhere. Only touch <files>. Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
