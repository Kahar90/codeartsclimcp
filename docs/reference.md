# Reference

## Commands

| Command | What it does |
|---|---|
| `ca onboard [--harness h] [--repo d] [--yes] [--smoke] [--dry-run] [--json]` | guided first-run setup |
| `ca auth [--wait [--timeout S]] [--status] [--stdin] [--force] [--no-open] [--json]` | keys through a local browser form (never through chat), stored in a user-only file |
| `ca doctor [--json] [repo]` | preflight: node, codearts, credentials, MaaS key, git, trust, shell, dashboard |
| `ca setup <harness> [repo] [--dry-run] [--write] [--user]` | MCP + rules config for claude, kiro, cursor, codex, opencode, vscode |
| `ca init <repo> <task> [--goal ..] [--force]` | scaffold `tasks/<task>.md` from the brief template |
| `ca lane <repo> <task> [--detach] [--resume]` | run a lane (foreground, or detached with a log file) |
| `ca wait <lane...> [--timeout S] [--json] [--quiet]` | block until lanes finish; exit code = worst result |
| `ca status [--json] [--all]` | one row per lane: health, phase, step, idle, verdict, now |
| `ca summary <lane> [--json]` | the lane summary (commits, gates, review, VERDICT) |
| `ca tail <lane> [-f] [-n N]` | readable transcript |
| `ca steer <lane> <message>` | queue a message into the running session |
| `ca attach <lane>` | CodeArts TUI on the live session (typing there steers it) |
| `ca stop <lane>` | abort the session and end the lane |
| `ca dash [port]` | dashboard (starts on demand) |
| `ca plan [plan.json]`, `ca note [--now] <text>` | show the lead plan and decisions on the dashboard |
| `ca plan list`, `ca plan close [id] [--reason t]`, `ca plan rm <id>` | plan state from real lanes; close marks never-started lanes Dropped; rm unregisters |
| `ca workflow` | print the lead workflow (`docs/workflow.md`) |
| `ca mcp` | MCP stdio server |
| `ca gc` | forget lanes finished more than 3 days ago |

MCP tools: `ca_doctor`, `ca_init`, `ca_lane_start`, `ca_status`, `ca_wait`, `ca_summary`,
`ca_tail`, `ca_steer`, `ca_stop`, `ca_plan`, `ca_note`, plus the prompt `codearts_build` (the
lead workflow in [workflow.md](workflow.md)).

## Exit codes

`0` done (review ready or skipped), `1` failed / stopped / killed, `2` usage or unknown lane,
`3` missing credentials, `4` needs review, `5` paused at LANE_TIMEOUT (`ca lane <repo> <task>
--resume`), `124` wait timeout. Lanes and `ca wait` also print a machine-readable line:
`CA_RESULT {"lane":..,"result":..,"verdict":..,"exit":..,"summaryPath":..}`.

## Lane health

| Health | Meaning | What to do |
|---|---|---|
| running / running tool | working, events in the last minute | nothing |
| quiet | no events for 60 s (normal model gaps are 5 to 15 s) | wait |
| STALLED | silent past STALL_S (240 s) or one tool over 900 s | nothing: the watchdog aborts and resumes |
| DEAD | supervisor process gone | `ca stop <lane>` cleans up, then rerun |
| done / needs review / failed / stopped | finished | `ca summary <lane>` |

## Models

- With a MaaS key: builder `maas/deepseek-v4.1-flash` (default, fast), `maas/glm-5.3` (long or
  cross-cutting lanes, also the default reviewer), `maas/glm-5.2`.
- Without it: `huaweicloud-maas/GLM-5.2` (builder) and `huaweicloud-maas/GLM-5.1` (reviewer) on
  the CodeArts quota.
- Per lane: first brief line `MODEL: maas/glm-5.3` and/or `REVIEW_MODEL: ...`. Globally: env
  `BUILD_MODEL`, `REVIEW_MODEL`. `NO_REVIEW=1` skips the review.

## Troubleshooting

Run `ca doctor`; every failing row has a fix line. Common ones:

- **Credentials missing** (exit 3): `ca auth`.
- **CodeArts CLI not found**: `ca onboard --yes` installs it.
- **Folder not trusted**: `ca onboard --yes` adds the repo to the CodeArts trusted folders.
- **Harness does not show the tools**: restart or reload the harness after setup (Claude
  Code: restart, or `/mcp`).
- **First bash call hangs** (Windows): SHELL points to Git's MSYS `usr/bin/bash.exe`; the
  runner forces `Git/bin/bash.exe`, `ca doctor` shows which one it uses.
- **Model service timeouts**: lanes back off 2, 4, 6 minutes and resume; see
  `interruptions` in the summary.

Env knobs: `BUILD_MODEL`, `REVIEW_MODEL`, `STALL_S`, `TOOL_STALL_S`, `THINK_S`, `MAX_RETRIES`,
`MAX_FIXES`, `CHECK_TIMEOUT`, `LANE_TIMEOUT`, `NO_REVIEW=1`, `CA_DASH=0`, `CA_DASH_PORT`,
`CA_REGISTRY`, `CA_CREDENTIALS`.
