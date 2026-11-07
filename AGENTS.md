# AGENTS.md: set up and use CodeArts lanes from any agent

This file is for coding agents (Claude Code, Codex, Cursor, Kiro, opencode, VS Code Copilot,
Gemini CLI, Aider, or any other harness and model). Follow it top to bottom to install the
runner, connect it to your harness and run your first lane. Humans can read `README.md`.

What you get: a `ca` CLI and an MCP server that let you (the lead) hand a numbered brief to the
Huawei CodeArts coding agent. A lane writes the code in a git repo, commits each step, runs the
brief's `CHECK:` commands, fixes failures, gets a read-only review and ends with one summary
and a VERDICT. You plan, wait, read the summary and verify.

## 1. Install (once per machine)

Requirements: Node 20+, git, the CodeArts Agent CLI
(`~/.codeartsdoer/installers/bin/codearts.exe` on Windows; `ca onboard --yes` installs it). No npm dependencies.

```sh
npm install -g github:Kahar90/codeartsclimcp   # puts `ca` on PATH
ca doctor                                      # every failing row prints its fix
```

No global install allowed? Clone the repo and use `node <clone>/runner/ca.mjs <command>`
everywhere this file says `ca`.

Credentials (ask the human, never invent, print or commit them):
- `CODEARTS_CLI_AK` and `CODEARTS_CLI_SK` in the user environment (from
  https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth). Missing ones make
  lanes exit with code 3.
- Optional `MAAS_API_KEY` (Huawei Cloud ModelArts MaaS) for the faster builder models.

On Windows set them persistently from PowerShell, then open a new terminal:

```powershell
[Environment]::SetEnvironmentVariable('CODEARTS_CLI_AK', '<ak>', 'User')
[Environment]::SetEnvironmentVariable('CODEARTS_CLI_SK', '<sk>', 'User')
```

Or let the guided setup do it (asks for the keys with hidden input in a terminal):

```sh
cd <your git repo>
ca onboard --yes --smoke   # fixes folder trust and git, configures the detected harness, 25 s probe lane
```

## 2. Connect your harness (once per repo)

Run the line for your harness inside the target repo. Each one merges into existing config,
is safe to rerun and accepts `--dry-run`.

| Harness | Command | What it writes |
|---|---|---|
| Claude Code | `ca setup claude` (`--user`: skill for every project too) | `.mcp.json`, `.claude/skills/codearts-build/SKILL.md` (the `/codearts-build` skill), `.claude/settings.local.json` (server enabled, read-only tools allowed) |
| Codex | `ca setup codex --write` | `[mcp_servers.codearts]` in `~/.codex/config.toml` (read-only tools pre-approved) + an AGENTS.md section |
| Cursor | `ca setup cursor` | `.cursor/mcp.json` + `.cursor/rules/codearts-lanes.mdc` |
| Kiro | `ca setup kiro` | `.kiro/settings/mcp.json` + `.kiro/steering/codearts-lanes.md` |
| opencode | `ca setup opencode` | `opencode.json` (`mcp.codearts`) + an AGENTS.md section |
| VS Code | `ca setup vscode` | `.vscode/mcp.json` |
| Anything else with MCP | add a stdio server: command `ca`, args `["mcp"]` (or `node <clone>/runner/ca.mjs mcp`) | your client's MCP config |
| No MCP (shell only) | nothing | use the CLI commands in section 4 |

Restart or reload the harness so it picks up the MCP server. Verify by calling `ca_doctor`.

MCP tools: `ca_doctor`, `ca_init`, `ca_lane_start`, `ca_status`, `ca_wait`, `ca_summary`,
`ca_tail`, `ca_steer`, `ca_stop`, `ca_plan`, `ca_note`. MCP prompt: `codearts_build` (the full
lead workflow, same text as `docs/workflow.md`). Read-only tools are safe to auto-approve;
starting, steering and stopping lanes should stay behind approval.

## 3. Models

Two sets of models are involved; they are independent.

- **Your model (the lead):** any model your harness runs. It only plans, writes briefs and
  reads summaries, so a small context is enough.
- **The worker models (CodeArts):**
  - with `MAAS_API_KEY`: builder `maas/deepseek-v4.1-flash` (default, fast), `maas/glm-5.3`
    (long or cross-cutting lanes, also the default reviewer), `maas/glm-5.2`;
  - without it: `huaweicloud-maas/GLM-5.2` (builder) and `huaweicloud-maas/GLM-5.1` (reviewer)
    on the CodeArts quota.
  - Per lane: first brief line `MODEL: maas/glm-5.3` and/or `REVIEW_MODEL: ...`. Globally: env
    `BUILD_MODEL`, `REVIEW_MODEL`. `NO_REVIEW=1` skips the review.

## 4. Run a lane

MCP or CLI, same steps:

1. `ca doctor` (`ca_doctor`): fix every `fail` row.
2. `ca init <repo> <task> --goal "..."` (`ca_init`): writes `tasks/<task>.md`. Edit it:
   at most 8 numbered steps, exact files and behaviour, "commit after each step" with subject
   `step N: ...`, one `CHECK: <command>` line per check, "do not ask questions".
   Never start a prose line with `CHECK:`; the runner would run it as a command.
3. `ca lane <repo> <task> --detach` (`ca_lane_start`): returns at once.
4. `ca wait <lane> --timeout 3000` (`ca_wait`): blocks, exit code is the result. Exit 124
   means still running: call it again. Do not poll `ca status` in a loop.
5. `ca summary <lane>` (`ca_summary`): commits, gates, fix rounds, interruptions, steering,
   reviewer findings, VERDICT. Open `ca tail <lane>` only if the summary points at a problem.
6. Verify yourself: run the checks, `git status`, drive the app for UI work. Merge worktree
   lanes into main and rerun the checks there.

Lane names: `<repo dir name>--<task>`; `ca status` lists them.
Steer a running lane: `ca steer <lane> "also handle HEAD requests"`. Stop: `ca stop <lane>`.
Parallel lanes: one git worktree each (`git worktree add ../<repo>-wt-<task> -b lane/<task>`),
about 3 at once.

Exit codes: 0 done, 1 failed or stopped, 2 usage or unknown lane, 3 missing credentials,
4 needs review, 5 paused at LANE_TIMEOUT (`ca lane <repo> <task> --resume`), 124 wait timeout.
Lanes and `ca wait` also print `CA_RESULT {"lane":..,"result":..,"verdict":..,"exit":..}`.

The human can watch at http://127.0.0.1:4777 (Lanes) and http://127.0.0.1:4777/office
(Office view), or `ca attach <lane>` for the live CodeArts TUI. Keep the dashboard on
loopback: its steer box drives the lane.

## 5. Rules for agents

- Never print, log or commit credentials, CLI configs or lane logs (`tasks/*.lane/`,
  `tasks/*.lane.log`, `tasks/*.out`).
- Code and briefs go to Huawei Cloud models. For private data, briefs say "numbers only,
  never print private text".
- Do not drop new files into a repo while a lane runs there: its `git add -A` commits them.
- Judge reviewer findings against the brief and steering; overrule and say so when they
  contradict them.
- On Windows, if the first bash tool call of a lane hangs, `ca doctor` shows which SHELL is
  used (the runner forces `Git/bin/bash.exe`).

## 6. Working on this repo

- Layout: `runner/` (`ca.mjs` CLI and supervisor, `mcp.mjs`, `setup.mjs`, `onboard.mjs`,
  `dash.html`, `office.html`, `assets/`), `templates/` (brief and review), `docs/workflow.md`
  (lead workflow), `checks/` (contract checks), `design/` (Office art direction), `tasks/`
  (briefs used to build this repo).
- Checks: `npm run check` (all of `checks/*.check.mjs`; fake lanes, no paid model calls; the
  UI checks need Chrome). Quick: `node --check runner/ca.mjs`.
- Style: Node ESM, no dependencies, no em dashes in code, docs or commits.
