# CodeArts lanes

Delegate coding work to the Huawei CodeArts agent from the tools you already use. Your
lead agent (Claude Code, Kiro, Cursor, Codex, VS Code, or you in a shell) plans and writes a
short brief; a CodeArts **lane** writes the code in your git repo, commits each step, runs your
checks, fixes what fails and gets a read-only review. You read one summary and decide.

- **Reliable:** a watchdog tells running from stuck (STALLED, DEAD), resumes stalled sessions,
  backs off on model-service errors, restarts a crashed server, and never answers permission
  prompts or questions by hanging.
- **Honest:** your `CHECK:` commands run by the runner itself when the agent says it is done;
  failures go back to the agent (up to 3 rounds); uncommitted work is never reported as done.
- **Informative:** `ca status`, `ca wait` with exit codes, `--json` everywhere, a live dashboard
  and an animated Office view (who is working on what, step by step).
- **Works with any harness:** one MCP server (`ca mcp`) plus rules files, set up with one command.

## Quickstart (3 commands)

```sh
npm install -g <path-or-git-url-of-this-repo>   # puts `ca` on PATH (Node 20+, no dependencies)
cd your-repo
ca onboard --yes                                # checks, fixes, detects your harness, configures it
```

`ca onboard` checks Node, the CodeArts CLI, credentials, git and folder trust, fixes what it
safely can (trusted folder, `git init`), detects your harness from `.kiro/`, `.cursor/`,
`.claude/`, `opencode.json`, `AGENTS.md` or `.vscode/`, writes its MCP config and rules, and prints the first
prompt to type. Without `--yes` it asks before each fix; in a terminal it can also take your
AK/SK with hidden input. Add `--smoke` to run a 25 s probe lane. `--dry-run` shows the plan.

Prerequisites it will point you to if missing:
- CodeArts Agent CLI (`~/.codeartsdoer/installers/bin/codearts.exe`).
- `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` (from
  https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth) in your user env.
- Optional `MAAS_API_KEY` (Huawei Cloud ModelArts MaaS) for the faster builder models; without
  it lanes use your CodeArts quota models.

## Use it from your harness

| Harness | Setup | Start | Verified |
|---|---|---|---|
| Kiro | `ca setup kiro` writes `.kiro/settings/mcp.json` (read-only tools in `autoApprove`) + `.kiro/steering/codearts-lanes.md` (manual) | In chat: `#codearts-lanes` and your goal | format checked against kiro.dev docs |
| Cursor | `ca setup cursor` writes `.cursor/mcp.json` + `.cursor/rules/codearts-lanes.mdc` | In chat: `@codearts-lanes` and your goal (or let the agent pick the rule) | format checked against cursor.com docs |
| Claude Code | `ca setup claude` writes `.mcp.json` (or `claude mcp add -s user codearts -- node <ca.mjs> mcp`) | `/codearts-build <goal>` (skill) or the `codearts_build` MCP prompt | real client run |
| Codex | `ca setup codex --write` appends `[mcp_servers.codearts]` (read-only tools pre-approved) to `~/.codex/config.toml`, adds an AGENTS.md section | Ask it to follow the CodeArts lanes section | real `codex exec` run |
| opencode | `ca setup opencode` writes `opencode.json` (`mcp.codearts`) + an AGENTS.md section | Ask it to follow the CodeArts lanes section | real `opencode run` |
| VS Code | `ca setup vscode` writes `.vscode/mcp.json` (VS Code also reads the root `.mcp.json` from `ca setup claude`) | Agent mode chat, codearts tools | format checked against code.visualstudio.com docs |
| Shell / CI | nothing | `ca init`, `ca lane --detach`, `ca wait` (below) | contract checks |

Every setup merges into existing config (other servers and keys are kept), is safe to rerun,
and supports `--dry-run`. Read-only tools (`ca_status`, `ca_summary`, `ca_tail`, `ca_wait`,
`ca_doctor`) are auto-approved in Kiro; starting, steering and stopping lanes ask first.

MCP tools: `ca_doctor`, `ca_init`, `ca_lane_start`, `ca_status`, `ca_wait`, `ca_summary`,
`ca_tail`, `ca_steer`, `ca_stop`, `ca_plan`, `ca_note`, plus the prompt `codearts_build` (the
lead workflow in `docs/workflow.md`).

## Your first lane in 5 minutes (shell)

```sh
ca init . add-health-endpoint --goal "Add GET /health returning {ok:true} with a test"
# edit tasks/add-health-endpoint.md: at most 8 numbered steps, and your check commands:
#   CHECK: npm test
ca lane . add-health-endpoint --detach     # returns at once; log in tasks/add-health-endpoint.lane.log
ca wait add-health-endpoint                 # progress lines, then CA_RESULT {...}; exit code = result
ca summary add-health-endpoint              # commits, gates, review, VERDICT
```

Watch live at http://127.0.0.1:4777 (Lanes view) or http://127.0.0.1:4777/office (Office view),
or `ca attach <lane>` for the CodeArts TUI on the live session (typing there steers it).
Change course mid-run with `ca steer <lane> "also handle HEAD requests"`; stop with `ca stop <lane>`.

## Commands

| Command | What it does |
|---|---|
| `ca onboard [--harness h] [--repo d] [--yes] [--smoke] [--dry-run] [--json]` | guided first-run setup |
| `ca doctor [--json] [repo]` | preflight: node, codearts, credentials, MaaS key, git, trust, shell, dashboard |
| `ca setup <harness> [repo] [--dry-run] [--write]` | MCP + rules config for claude, kiro, cursor, codex, opencode, vscode |
| `ca init <repo> <task> [--goal ..] [--force]` | scaffold `tasks/<task>.md` from the brief template |
| `ca lane <repo> <task> [--detach]` | run a lane (foreground, or detached with a log file) |
| `ca wait <lane...> [--timeout S] [--json] [--quiet]` | block until lanes finish; exit code = worst result |
| `ca status [--json] [--all]` | one row per lane: health, phase, step, idle, verdict, now |
| `ca summary <lane> [--json]` | the lane summary (commits, gates, review, VERDICT) |
| `ca tail <lane> [-f] [-n N]` | readable transcript |
| `ca steer <lane> <message>` | queue a message into the running session |
| `ca attach <lane>` | CodeArts TUI on the live session |
| `ca stop <lane>` | abort the session and end the lane |
| `ca dash [port]` | dashboard (starts on demand) |
| `ca plan [plan.json]`, `ca note [--now] <text>` | show the lead plan and decisions on the dashboard |
| `ca mcp` | MCP stdio server |
| `ca gc` | forget lanes finished more than 3 days ago |

Exit codes: `0` done (review ready or skipped), `1` failed / stopped / killed, `2` usage or
unknown lane, `3` missing credentials, `4` needs review, `124` wait timeout. Lanes and `ca wait`
also print a machine-readable line: `CA_RESULT {"lane":..,"result":..,"verdict":..,"exit":..,"summaryPath":..}`.

## Lane health

| Health | Meaning | What to do |
|---|---|---|
| running / running tool | working, events in the last minute | nothing |
| quiet | no events for 60 s (normal model gaps are 5 to 15 s) | wait |
| STALLED | silent past STALL_S (240 s) or one tool over 900 s | nothing: the watchdog aborts and resumes |
| DEAD | supervisor process gone | `ca stop <lane>` cleans up, then rerun |
| done / needs review / failed / stopped | finished | `ca summary <lane>` |

## Troubleshooting

Run `ca doctor`; every failing row has a fix line. Common ones:
- **credentials missing** (exit 3): set `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` in your user env
  (`ca onboard` can do it), then open a new terminal.
- **Folder not trusted**: `ca onboard --yes` adds the repo to CodeArts trusted folders.
- **First bash call hangs**: SHELL points to Git's MSYS `usr/bin/bash.exe`; the runner forces
  `Git/bin/bash.exe`, `ca doctor` shows which one it uses.
- **Model service timeouts**: lanes back off 2, 4, 6 minutes and resume; see `interruptions` in
  the summary.

Env knobs: `BUILD_MODEL`, `REVIEW_MODEL`, `STALL_S`, `TOOL_STALL_S`, `THINK_S`, `MAX_RETRIES`, `MAX_FIXES`,
`CHECK_TIMEOUT`, `LANE_TIMEOUT`, `NO_REVIEW=1`, `CA_DASH=0`, `CA_DASH_PORT`, `CA_REGISTRY`.

## Privacy

Your code and briefs go to Huawei Cloud models. Credentials stay in your environment and are
never written to the repo or printed. Lane state lives in `tasks/<task>.lane/` (gitignored).

## Development

`npm run check` runs every contract check in `checks/` (fake lanes, no paid model calls;
the Office checks drive headless Chrome).
