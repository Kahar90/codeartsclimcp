You are working in a git repo (current directory). Goal: `runner/setup.mjs`, one-command setup of the CodeArts lanes MCP server and workflow rules for other agent harnesses. `ca setup <harness> [repo] [--dry-run] [--write]` already imports this file and calls its default export with the args array after `setup` (see `runner/ca.mjs`). Node 22 ESM, no dependencies. Read `checks/setup.check.mjs` (the contract) and `docs/workflow.md` first.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. Skeleton: `export default async function setup(args)`. Parse harness (claude|kiro|cursor|codex|vscode), repo (default cwd, resolved absolute), flags `--dry-run`, `--write`. No or unknown harness: print usage listing the harnesses, `process.exitCode = 2`, return. The server entry is `{command:'node', args:[<absolute path of runner/ca.mjs with forward slashes>, 'mcp']}`; the rules text is `docs/workflow.md` (resolve relative to this file: `../docs/workflow.md`). A helper `plan` list of {path, content, action} is built first; `--dry-run` prints each path and content and writes nothing; otherwise write and print one line per file ("wrote", "updated" or "unchanged"). Commit.
2. JSON merge helper: read the target, parse; missing file = `{}`; parse failure = do not touch the file, print the snippet to add by hand, exitCode 1. Set only the `codearts` key under the harness's server map, keep every other key, write with 2-space indent and a trailing newline. Commit.
3. kiro: `<repo>/.kiro/settings/mcp.json` `mcpServers.codearts` = server + `disabled:false` + `autoApprove: ['ca_doctor','ca_status','ca_summary','ca_tail','ca_wait']`; `<repo>/.kiro/steering/codearts-lanes.md` = front matter `---\ninclusion: manual\n---\n` + the workflow text (users reference it with #codearts-lanes in chat; say so in the printed hint). Commit.
4. cursor: `<repo>/.cursor/mcp.json` `mcpServers.codearts` = server; `<repo>/.cursor/rules/codearts-lanes.mdc` = front matter `---\ndescription: Delegate coding work to CodeArts lanes (plan, brief, start, wait, verify)\nalwaysApply: false\n---\n` + workflow. vscode: `<repo>/.vscode/mcp.json` `servers.codearts` = `{type:'stdio', ...server}`. Commit.
5. claude: `<repo>/.mcp.json` `mcpServers.codearts` = server; also print the user-scope alternative `claude mcp add -s user codearts -- node <ca.mjs> mcp` and that the Claude Code skill `codearts-build` covers the workflow. Commit.
6. codex: build the TOML block `[mcp_servers.codearts]\ncommand = "node"\nargs = ["<ca.mjs>", "mcp"]\n` (TOML string escaping). Without `--write`: print it and the target path (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`), write nothing there. With `--write`: append it only if `[mcp_servers.codearts]` is not already in the file (create the file if missing), keep existing content. In both cases write the workflow into `<repo>/AGENTS.md` between `<!-- codearts-lanes:start -->` and `<!-- codearts-lanes:end -->` (replace the block if present, append otherwise, keep the rest of the file). Commit.
7. Test hook / check: `node checks/setup.check.mjs` must print ALL PASS (do not edit `checks/`). Commit.
8. Self check: re-read against this brief, fix bugs (Windows backslashes in JSON and TOML, CRLF in existing files, idempotent reruns). Run all CHECK lines. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- Never write to the real `~/.codex`, `~/.kiro`, `~/.cursor` or this repo's harness folders while testing: the check uses temp dirs and CODEX_HOME.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node --check runner/setup.mjs
CHECK: node checks/setup.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/setup.mjs`. Do not edit `runner/ca.mjs`, `docs/` or `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
