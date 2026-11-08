KIND: review
Read-only codebase audit. Do not ask questions. Do not implement fixes.

1. Inspect runner/lifecycle.mjs, runner/netwait.mjs, runner/mcp.mjs, tools/run-checks.mjs and relevant checks for small correctness and reliability improvements.
2. Independently validate these candidates: zero matching check filter returns success; defaultProbe drops MAAS_BASE_URL scheme and port; installCommand leaves checkout path unquoted; update ignores harness setup exit status. Add better findings if found.
3. Return at most 5 prioritized findings with severity, exact file:line, concrete trigger and consequence, smallest fix and missing regression test. Skip style suggestions and speculative claims.

Audit exception: do not edit files, stage or commit. Only touch lane-managed logs/state. No new test hooks; existing checks below are verification hooks. The lead owns this brief. Existing untracked files must remain untouched. The lead's baseline commit failed with an index.lock filesystem error; leave git metadata alone.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node --check runner/ca.mjs
CHECK: node checks/netwait.check.mjs
Constraints: no em dashes anywhere. Never run git add, git commit, git push, git reset or git clean. Never print secrets or private text. Public source references permitted.

Final reply: findings, evidence, checks run, no changes and no commits.
