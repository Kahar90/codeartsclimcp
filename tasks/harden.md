KIND: code
You are working in a git repo (current directory). Goal: harden the runner and its dashboard: the CA_DUMP_ENV debug dump never contains a secret, `ca lane` refuses template placeholder CHECK lines, the dashboard rejects foreign Host headers (DNS rebinding) and bad JSON bodies, lane and plan lookups refuse ambiguous partial names, and Open TUI works when the CodeArts exe path has spaces. File: `runner/ca.mjs` only. Node 22 ESM, no dependencies. Read `checks/runnerwave.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. Env dump (`Server.start`, the `process.env.CA_DUMP_ENV` line): add a helper `redactEnv(env)` that returns a copy where every variable whose name matches `/KEY|SECRET|TOKEN|PASSWORD|(^|_)AK$|(^|_)SK$/i` has the value `<redacted>`, and every remaining value has each of those secret values (length 6 or more) replaced by `<redacted>` wherever it occurs (this covers the MaaS apiKey inside `OPENCODE_CONFIG_CONTENT`). The dump uses `redactEnv(caEnv({ CODEARTS_SERVER_PASSWORD: this.pw }))`. Commit.
2. Placeholder CHECK lines: in `runLane`, before anything is registered or created (right after the brief file is found, before the lane folder, registry entry, .gitignore or trust steps), read the brief and if any CHECK line's command contains `<` followed later by `>` (a template placeholder such as `<exact command, e.g. npm test>`), `die()` with exit 2: `tasks/<task>.md still has a template placeholder CHECK line: "<the line>". Replace it with a real command or delete it.` Commit.
3. Lookup helper: one function `pickOne(items, q, idOf, taskOf)` used by `findLane`, the dashboard's lane route and `findPlan`: exact id, then exact task (lanes only), then the substring matches; one substring match is returned; more than one is ambiguous. `findLane` dies with exit 2 `ambiguous lane "<q>": matches <id1>, <id2>; use the full id`; `findPlan` dies the same way for plans (exit 2); the dashboard route answers 409 with that message as `{error}` and never calls die(). Commit.
4. Host check: at the top of the `ca dash` request handler, allow only `Host` values `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` (case-insensitive, `<port>` = the port this dashboard listens on); anything else, or a missing Host, gets 403 `{error: 'forbidden host'}` before any route runs (pages, assets and APIs alike). Env `CA_DASH_HOSTS` (comma-separated `host` or `host:port` values) adds allowed hosts for proxies; mention it in the 403 message (`forbidden host <h>; allow it with CA_DASH_HOSTS`). Commit.
5. Bad JSON: every POST body in the dashboard is parsed by one helper `readJson(req)` that rejects with a marked error on invalid JSON (and on bodies over 64 KB); the routes answer 400 `{error: 'invalid JSON body'}` (413 for too large) instead of 500. Use it for steer, kick, resume, ack and any other POST route that reads a body. Commit.
6. Open TUI: the attach route spawns `cmd.exe /c start "<title>" "<exe>" attach <url> -s <sid> -p <pw>` with the exe path inside double quotes when `windowsVerbatimArguments: true` is kept (or build the args so Node quotes them, without verbatim). The window title stays first. Verify by reading the code; do not open a window. Commit.
7. Test hook / check: `node checks/runnerwave.check.mjs` prints ALL PASS, and `node checks/controls.check.mjs`, `node checks/cli.check.mjs`, `node checks/planstate.check.mjs` still pass. Commit if anything changed.
8. Self check: re-read against this brief; the Host check must not break the dashboard's own pages (the checks above load them through 127.0.0.1), no secret value reaches stdout, live.log or the dump, no route handler can call die() or exit. Run every CHECK line. Commit if changed.

Safety rules (hard):
- Never run `ca lane`, `ca stop`, `ca plan close` or `ca dash` by hand against the real registry: only the checks below (they use a private CA_REGISTRY and settings, and node as a fake CodeArts exe).
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/runnerwave.check.mjs
CHECK: node checks/controls.check.mjs
CHECK: node checks/cli.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/overview.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs`. Do not edit `runner/mcp.mjs`, `runner/dash.html`, `templates/`, `docs/` or any check.

Final reply: the steps with their commit hashes, and anything skipped.
