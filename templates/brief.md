MODEL: maas/deepseek-v4.1-flash   (optional line: build model for this lane; REVIEW_MODEL: too)
You are working in a git repo (current directory). <one sentence goal, the files to touch, the stack>.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. <step: exact behaviour, file names>. Commit.
2. <step>. Commit.
...
7. Test hook / check: <how a script can verify this without vision, e.g. window.__app.state()>. Commit.
8. Self check: re-read your changes against this brief and fix bugs you find. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: <exact command, e.g. npm run typecheck>
CHECK: <another command, e.g. npm test>
Constraints: no em dashes anywhere. Only touch <files>. Numbers only, never print private data.

Final reply: the steps with their commit hashes, and anything skipped.
