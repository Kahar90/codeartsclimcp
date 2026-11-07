KIND: code
You are working in a git repo (current directory). Goal: the MCP server tells other harnesses' leads the truth: `ca_wait` returns paused (exit 5) and rejected keys (exit 3) as results with a next step, new tools `ca_plan_close`, `ca_plan_list` and `ca_gc`, the server version comes from package.json, read-only tools carry MCP annotations, and the brief template can no longer produce a fake check line. Files: `runner/mcp.mjs`, `templates/brief.md`, `checks/mcp.check.mjs`. Node 22 ESM, no dependencies. Read `checks/mcpwave.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. `waitResult` in `runner/mcp.mjs`: exit codes 0, 1, 3, 4, 5 and 124 are results (not tool errors); 2 and anything else stay tool errors. Add a `next` string to the returned JSON: 0 `read ca_summary for each lane and verify the work`, 1 `read ca_summary; ca_resume continues a failed or stopped lane with a note`, 3 `keys missing or rejected: ask the human to run ca auth (a local form opens; never ask for keys in chat), then ca_resume the lane`, 4 `read ca_summary: the reviewer asked for changes`, 5 `paused at LANE_TIMEOUT: ca_resume the lane to continue where it stopped`, 124 `still running: call ca_wait again`. Commit.
2. `ca_wait` description: list the exits as 0 done, 1 failed or stopped, 3 keys missing or rejected (run ca auth), 4 needs review, 5 paused (ca_resume continues it), 124 still running; mention the `next` field. Commit.
3. New tools: `ca_plan_list` (no args, `ca plan list`, ok [0]); `ca_plan_close` (`id` optional string, default the newest plan; `reason` optional string; runs `ca plan close [id] --reason <reason>`; ok [0]; its description says to close a plan when the work is finished or a wave will not run, and that never-started lanes become Dropped); `ca_gc` (no args, `ca gc`, ok [0], forgets lanes finished more than 3 days ago). Commit.
4. Version: replace the hardcoded `VERSION = '1.0.0'` with the `version` read from `../package.json` (resolved relative to this file, read once at start; fall back to `'0.0.0'` if unreadable). Commit.
5. Annotations: `tools/list` returns `annotations` for every tool: `{ readOnlyHint: true }` for ca_doctor, ca_status, ca_wait, ca_summary, ca_tail, ca_plan_list; `{ readOnlyHint: false, destructiveHint: true }` for ca_stop and ca_plan_close; `{ readOnlyHint: false, destructiveHint: false }` for the rest. Keep `name`, `description` and `inputSchema` as they are. Commit.
6. `templates/brief.md`: the sentence that says the runner runs "every CHECK: line itself" must not contain `CHECK:` at all. Rewrite that paragraph as: `Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.` Keep the two `CHECK: <...>` placeholder lines exactly as they are (each on its own line, starting at column 0). No other prose line in the file may contain `CHECK:`. Commit.
7. Test hook / check: `checks/mcp.check.mjs` lists the expected tools in `want`: add `ca_plan_list`, `ca_plan_close`, `ca_gc` there (change nothing else in that file). `node checks/mcpwave.check.mjs` and `node checks/mcp.check.mjs` print ALL PASS. Commit.
8. Self check: re-read against this brief, make sure stdout of the MCP server still carries only JSON-RPC (no console.log), no em dashes, every CHECK line passes. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- Never run `ca plan close`, `ca gc` or `ca stop` against the real registry by hand: only the checks below (they use a private CA_REGISTRY).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/mcp.mjs
CHECK: node checks/mcpwave.check.mjs
CHECK: node checks/mcp.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/mcp.mjs`, `templates/brief.md`, `checks/mcp.check.mjs`. Do not edit `runner/ca.mjs`, `docs/` or other checks.

Final reply: the steps with their commit hashes, and anything skipped.
