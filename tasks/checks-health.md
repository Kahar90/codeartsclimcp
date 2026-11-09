You are working in a git repo (current directory). Goal: every check in `checks/` gives a truthful exit code, so
the runner's gates and the lead can trust them. Follow this brief directly; do not write another plan. Read only
relevant code. Do not ask questions; decide and keep going. After each step works, run its targeted check, then
`git add -A && git commit -m "step N: <summary>"`.

1. Clean exit: under Node 26 on Windows several CDP harnesses print every PASS, then abort with
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` and exit 127, which the runner
   reads as "checks couldn't run" (seen in `checks/assets.check.mjs`, `checks/bucket.check.mjs`,
   `checks/glanceoffice.check.mjs`). Find the shared cause (a WebSocket, child process or timer still closing when
   `process.exit` runs) and fix it once in `checks/lib/` with a helper every CDP harness uses to close the socket,
   kill Chrome and the dash, wait for them to exit, then set `process.exitCode` instead of calling
   `process.exit`. Each harness must exit 0 when all pass and 1 on any FAIL. Commit.
2. Stale failures: `checks/controls.check.mjs` ("failed lane suggests resume"), `checks/updateui.check.mjs`
   ("Update now shows progress") and `checks/windows-hide.check.mjs` ("marker not found: const ch =
   spawn('bash'") fail on main and on older commits. For each, decide whether the assertion is stale (the
   product changed on purpose: update the assertion to the current intended behaviour, quoting the code that
   proves it in the commit message) or a real product bug (do not fix product code: leave the assertion, and
   describe the bug with file:line in your final reply). Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks in the foreground with a timeout; never sleep-poll a background job.
CHECK: node checks/assets.check.mjs
CHECK: node checks/bucket.check.mjs
CHECK: node checks/glanceoffice.check.mjs
CHECK: node checks/controls.check.mjs
CHECK: node checks/updateui.check.mjs
CHECK: node checks/windows-hide.check.mjs
Constraints: no em dashes anywhere. Only touch files under `checks/`.

Final reply: the steps with their commit hashes, which failures were stale and which are product bugs (file:line).
