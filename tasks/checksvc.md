You are working in a git repo (current directory): codearts-lanes, a Node lane runner (`runner/ca.mjs`, no deps).
Goal: workers run in a CodeArts sandbox that blocks loopback networking, so their own check runs of anything that starts
a local server hang or fail and cost minutes. Give the worker a helper that asks the runner (outside the sandbox) to
run a CHECK line, and let the gate reuse green worker runs on the same commit. The contract is
`checks/checkservice.check.mjs` (committed; read its header comment first). It and `checks/lib/fake-codearts.cjs` are
fixed: never edit them. Do the steps in order. After each step that works, run `node --check runner/ca.mjs`, then
`git add -A && git commit -m "step N: <summary>"`. Do not ask questions; decide and keep going. Follow this brief
directly; do not restate it. Use grep to find code; read only runLane (search `async function runLane`), not the
whole file. Your own sandbox blocks loopback too: do not run the contract or other fake-server checks yourself, and
never try to unset SANDBOX_* variables; the runner runs every CHECK line outside the sandbox when you end your turn.

1. Helper file. At lane start (after the lane dir exists, before the first prompt), write
   `tasks/<task>.lane/check.mjs` (plain Node, no imports beyond node:fs/node:path). Usage:
   `node tasks/<task>.lane/check.mjs [N|all]`. With no argument it prints each CHECK line numbered (`1. <cmd>`) and
   exits 0. Otherwise it writes `tasks/<task>.lane/checkreq/<id>.json` ({id, arg, at}; id = Date.now() + random),
   then waits for `<id>.result.json` (poll every 250 ms; give up after CHECK_TIMEOUT + 60 s with exit 124 and a
   message). It prints the result's `out` (last 60 lines of each check run, each preceded by `== check N: <cmd>`) and
   the line `exit <code>`, deletes both files and exits with `code`. Embed the CHECK commands in the helper as JSON
   so listing needs no runner. Commit.
2. Runner side. In the waitTurn tick (every 2 s), look for request files. Handle one at a time per lane without
   blocking the tick: start an async job that runs the requested lines with the existing runCheck (same shell,
   env and timeout as the gates). `all` runs every line in order and stops at the first failure. N out of range
   gives code 2 and the message "no CHECK line N: use 1 to <count>". Write the result file (atomically: write
   .tmp, then rename). Record every line run in S.workerChecks (initialise to []): {n, cmd, code, ms, at, head
   (git rev-parse HEAD at the start of the run), clean (true when dirty() was empty at the start)}. Log each run in
   live.log as `  > check service: N <cmd>` / `  < check service: exit <code> (<dur>)`. Keep the tool watchdog
   happy: the worker's bash tool is waiting on the helper, which is normal. Commit.
3. Tell the worker. Append a short block to the first build prompt (also to the continuation brief and to every
   gate fix-round message): "Run a CHECK line with `node tasks/<task>.lane/check.mjs <N>` (1 = first line, `all`
   = every line, no argument lists them). It runs outside your sandbox, where the local network works, and prints
   the output and exit code. Use it instead of running a check command directly." Commit.
4. Gate reuse. In the gates, after git clean passes: for each CHECK line, find the newest S.workerChecks entry for
   that n. If every line has one with code 0, head === the current HEAD and clean === true, skip running them.
   Push gate rows {gate: cmd, ok: true, code: 0, kind: 'pass', ms, reused: true}, and log
   `== gate check reused (worker ran it green on <short head>)`. Otherwise run all of them as today. Never reuse
   when any line is missing, failed or ran on another HEAD. Commit.
5. Summary: add `worker checks: <count> runs (<green> green), gate reused: yes|no` after the gates line. Run the
   CHECK lines through your helper if you like (it now exists), fix what fails, commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node --check runner/ca.mjs
CHECK: node checks/checkservice.check.mjs
CHECK: node checks/stepreview.check.mjs
CHECK: node checks/ratelimit.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/think.check.mjs
CHECK: node checks/hygiene.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs. Do not edit checks/, docs/, README.md or CHANGELOG.md.

Final reply: the steps with their commit hashes, and anything skipped.
