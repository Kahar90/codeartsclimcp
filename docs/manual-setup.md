# Manual setup

Most people never need this page: the [one-prompt setup](../README.md#set-it-up-in-one-prompt)
lets your coding agent do all of it. Use these steps if you prefer to run the commands
yourself, are setting up CI, or your harness has no shell tool.

## Requirements

- Node.js 20 or newer, and git.
- A Huawei Cloud account with CodeArts access, for the AK/SK.
- Optional: a Huawei Cloud ModelArts MaaS API key, for the faster builder models. Without it,
  lanes use your CodeArts quota models.

## 1. Install `ca`

```sh
npm install -g github:Kahar90/codeartsclimcp
```

No global installs allowed? Clone it and use `node ~/.codearts-lanes/runner/ca.mjs` wherever
these docs say `ca`:

```sh
git clone --depth 1 https://github.com/Kahar90/codeartsclimcp ~/.codearts-lanes
```

## 2. Onboard your repository

```sh
cd your-repo
ca onboard --yes
```

`ca onboard` checks and fixes everything it safely can:

- installs the CodeArts Agent CLI with the official Huawei Cloud installer if it is missing;
- makes the folder a git repo with a first commit if needed;
- adds the folder to the CodeArts trusted folders;
- detects your harness (`.claude/` or `CLAUDE.md`, `.kiro/`, `.cursor/`, `.codex/` or
  `AGENTS.md`, `opencode.json`, `.vscode/`) and writes its MCP config and rules.

Useful flags: `--harness <name>` to choose the harness, `--dry-run` to only show the plan,
without `--yes` it asks before each fix, `--smoke` runs a 25 s test lane at the end.

To install the CodeArts CLI yourself instead:

```powershell
# Windows (PowerShell)
irm https://apsoutheast1-cloudide-marketplace.obs.ap-southeast-1.myhuaweicloud.com/codearts/cli_tui/install_script/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://apsoutheast1-cloudide-marketplace.obs.ap-southeast-1.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh | bash
```

## 3. Add your keys

```sh
ca auth
```

This opens a local form in your browser. Paste the AK/SK you created at
[CodeArts CLI auth settings](https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth)
(and optionally your MaaS API key) and click Save. The keys are stored in a file only your
user can read (`~/.config/codearts-lanes/credentials.json`), never in the repo.

Other ways: `ca auth --stdin` reads `CODEARTS_CLI_AK=...` / `CODEARTS_CLI_SK=...` lines from
the terminal, or set `CODEARTS_CLI_AK`, `CODEARTS_CLI_SK` and `MAAS_API_KEY` as environment
variables. `ca auth --status` shows which keys are set (never their values).

## 4. Check it works

```sh
ca onboard --yes --smoke
```

`onboard: ready` and a passing smoke test mean you are done.

## Connect a harness by hand

`ca onboard` does this for you. Run the line for your harness inside the repo to redo or
change it. Every command merges into existing config, is safe to rerun and accepts
`--dry-run`.

| Harness | Command | What it writes | Then |
|---|---|---|---|
| Claude Code | `ca setup claude` (`--user`: skill for every project) | `.mcp.json`, the `/codearts-build` skill, `.claude/settings.local.json` (server enabled, read-only tools allowed) | restart, then `/codearts-build <goal>` |
| Kiro | `ca setup kiro` | `.kiro/settings/mcp.json` (read-only tools auto-approved), `.kiro/steering/codearts-lanes.md` | `#codearts-lanes` and your goal |
| Cursor | `ca setup cursor` | `.cursor/mcp.json`, `.cursor/rules/codearts-lanes.mdc` | `@codearts-lanes` and your goal |
| Codex | `ca setup codex --write` | `[mcp_servers.codearts]` in `~/.codex/config.toml`, an AGENTS.md section | "use CodeArts lanes to ..." |
| opencode | `ca setup opencode` | `opencode.json`, an AGENTS.md section | "use CodeArts lanes to ..." |
| VS Code | `ca setup vscode` | `.vscode/mcp.json` | agent mode, codearts tools |
| Other MCP clients | add a stdio server: command `ca`, args `["mcp"]` | your client's MCP config | |

Read-only tools (`ca_doctor`, `ca_status`, `ca_summary`, `ca_tail`, `ca_wait`) are
pre-approved where the harness supports it; starting, steering and stopping lanes always ask.

## Your first lane from the shell

```sh
ca init . add-health-endpoint --goal "Add GET /health returning {ok:true} with a test"
# edit tasks/add-health-endpoint.md: at most 8 numbered steps, and your check commands:
#   CHECK: npm test
ca lane . add-health-endpoint --detach     # returns at once
ca wait add-health-endpoint                 # progress lines; exit code = result
ca summary add-health-endpoint              # commits, checks, review, VERDICT
```

Watch it at http://127.0.0.1:4777, steer it with `ca steer <lane> "also handle HEAD"`, stop it
with `ca stop <lane>`. Every command is in the [reference](reference.md).
