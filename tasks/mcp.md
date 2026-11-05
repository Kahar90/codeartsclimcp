MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: `runner/mcp.mjs`, a dependency-free MCP server (stdio transport: one JSON-RPC 2.0 message per line on stdin/stdout) that exposes the lane runner CLI `runner/ca.mjs` as tools, so any agent harness (Claude Code, Kiro, Cursor, Codex, VS Code) can plan, start, watch, steer and judge CodeArts lanes. `ca mcp` already runs this file in-process (see the `mcp` entry in the command table of `runner/ca.mjs`). Read `runner/ca.mjs` (usage block, exit codes, `--json` outputs of status/summary/wait/doctor), `docs/workflow.md` and `checks/mcp.check.mjs` (the contract) first.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. Transport: read stdin line by line, parse JSON (bad JSON: reply `{jsonrpc:'2.0', id:null, error:{code:-32700, message}}` and keep going), dispatch requests, ignore notifications, unknown method: -32601. Write only JSON-RPC lines to stdout; all logging to stderr. Exit when stdin ends. Handle requests concurrently (a long `ca_wait` must not block `ping`). Commit.
2. `initialize`: answer with the client's protocolVersion if it is one of '2025-06-18', '2025-03-26', '2024-11-05', else '2025-06-18'; `capabilities: {tools:{}, prompts:{}}`, `serverInfo: {name:'codearts-lanes', version}`, and `instructions`: 3 to 6 sentences on the loop (write a brief, ca_lane_start, ca_wait, ca_summary, verify yourself, steer with ca_steer, stop with ca_stop, dashboard URL). `ping` returns `{}`. Commit.
3. Tool runner helper: run `node <this dir>/ca.mjs <args>` with `child_process.spawn` (async, never spawnSync), inherit env, collect stdout/stderr, timeout per tool. Result: `{content:[{type:'text', text}], isError}`, text = stdout (trimmed) or, on error, stderr + stdout. isError when the exit code is not in the tool's ok set. Commit.
4. Tools (each with a clear description that says when to use it, and an `inputSchema` of type object with `properties` and `required`):
   `ca_doctor {repo?}` -> `doctor --json [repo]` (ok exits 0,1: a failing doctor is data, not a tool error);
   `ca_init {repo, task, goal?, force?}` -> `init`;
   `ca_lane_start {repo, task}` -> `lane <repo> <task> --detach`;
   `ca_status {all?}` -> `status --json [--all]`;
   `ca_summary {lane}` -> `summary <lane> --json`;
   `ca_tail {lane, lines?=60}` -> `tail <lane> -n N`;
   `ca_steer {lane, message}` -> `steer`;
   `ca_stop {lane}` -> `stop`;
   `ca_plan {file}` -> `plan <file>`;
   `ca_note {text, now?}` -> `note [--now] <text>`.
   Missing required args: return isError with a message naming the argument (do not run the CLI). Unknown tool: JSON-RPC error -32602. Commit.
5. `ca_wait {lanes:[...], timeout_s?}`: run `wait <lanes...> --json --quiet --timeout S` (default 300, max 3000, so MCP clients do not time out). Return the final `{"lanes":[...]}` JSON from stdout plus `exit` (the CLI exit code) and `timedOut` (exit 124). Exit codes 0, 1, 4 and 124 are not tool errors (they are results); 2 is (unknown lane). On timeout include the current status rows so the agent can decide to wait again. Commit.
6. Prompt: `prompts/list` returns `codearts_build` (argument `goal`, required false); `prompts/get` returns one user message whose text is `docs/workflow.md` (read at call time, resolve relative to this file: `../docs/workflow.md`) with a first line `Goal: <goal>` when given. Commit.
7. Test hook / check: `node checks/mcp.check.mjs` must print ALL PASS (do not edit `checks/`). Commit.
8. Self check: re-read against this brief, fix bugs (Windows paths with spaces in args, partial lines on stdout, unhandled promise rejections, a child process left running after stdin ends). Run all CHECK lines. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- Do not call `ca lane` for real (it starts a paid model session); the checks use fake lanes.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node --check runner/mcp.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/cli.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/mcp.mjs`. If a CLI command is missing or broken, work around it in mcp.mjs and say so in the final reply; do not edit `runner/ca.mjs`, `docs/` or `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
