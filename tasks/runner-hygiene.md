You are working in a git repo (current directory). Goal: fix four runner problems seen in real lanes, so workers
waste fewer tokens, never get contradictory orders, are never marked unverified by mistake, and the lead reads
less. Follow this brief directly; do not write another plan. Read only relevant code: `runner/ca.mjs`
(`handlePermission` near line 533, the event loop that sees tool calls, `gates()` and the build loop near 800-900),
`runner/controls.mjs` (`classifyCheck`), `runner/mcp.mjs` (`ca_wait`). Do not ask questions; decide and keep going.
After each step works, run its targeted check, then `git add -A && git commit -m "step N: <summary>"`.

1. No sleep-polling: workers ran `sleep 200; cat log` style commands while a check ran in the background, and every
   such idle turn replays the whole context (5 to 13M tokens per lane, about 90% cache read). When a worker bash
   call (a permission request or a tool call the runner sees) contains `sleep N` with N >= 20, reject it when it
   comes as a permission request, otherwise queue one steer per lane, with the message "Do not sleep-poll: run the
   check in the foreground with a timeout and read its output once." Record each in `S.interruptions` with kind
   `sleep-poll` so the summary shows it. Commit.
2. No contradictory orders: when the tree is dirty and the worker's last reply reports a failed `git commit` (a
   `fatal:` or `error:` line from git, or "Unable to create", "Permission denied", "index.lock"), end the build loop
   at once as failed with reason `commit failed: <first error line>` instead of a fix round that says "commit"
   again (the brief tells the worker to stop on a commit failure, so the runner must not push it to retry).
   Commit.
3. Truthful check results and a lean wait: in `classifyCheck`, exit 126/127 is "infra" only when the output says a
   command or file was not found (or the output is empty); a crash after printing PASS lines (for example a Node
   `Assertion failed` abort) is "fail", so a lane is never marked Unverified because a check crashed at exit. In
   `ca_wait` (MCP) and `ca wait --json`, add `compact: true` (default true in MCP) that returns per lane only
   `{lane, status: {key, label, attention}, progress: "d/t", commits, tokens: total, next}` instead of every token
   breakdown, so a lead's wait call costs a few hundred tokens. Commit.
4. Check: `checks/hygiene.check.mjs` covering: the sleep matcher (sleep 5 allowed, `sleep 200; cat x` caught,
   `sleep 30 && tail` caught), the commit-failure detector on sample replies, classifyCheck on (127 + "command not
   found") infra, (127 + PASS lines + Assertion failed) fail, (127 + empty) infra, and compact wait rows having only
   the listed fields. Export the pure helpers from `runner/controls.mjs` so the check imports them. PASS/FAIL,
   exit 1 on any FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks in the foreground with a timeout; never sleep-poll a background job. The runner runs
the CHECK lines once when you finish and sends failures back.
CHECK: node --check runner/ca.mjs
CHECK: node checks/hygiene.check.mjs
CHECK: node checks/checkrunner.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/writeguard.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs`, `runner/controls.mjs`, `runner/mcp.mjs` and
`checks/hygiene.check.mjs`. If an existing check asserts the old classifyCheck or wait shape, update only that
assertion in `checks/checkrunner.check.mjs` or `checks/mcp.check.mjs` and say so in your reply.

Final reply: the steps with their commit hashes, and anything skipped.
