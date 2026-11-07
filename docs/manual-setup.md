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

## 2. Onboard this machine

```sh
ca onboard --yes --harness claude    # or kiro, cursor, codex, opencode, vscode
```

`ca onboard` checks and fixes everything it safely can:

- installs the CodeArts Agent CLI with the official Huawei Cloud installer if it is missing;
- writes your harness's user-level MCP config and rules (see the table below), so every repo
  works from then on;
- when run inside a repo: makes it a git repo with a first commit if needed and adds it to the
  CodeArts trusted folders (`ca lane` also trusts a repo by itself the first time).

Useful flags: `--harness <name>` to choose the harness (without it, onboard detects it from
`.claude/`, `.kiro/`, `.cursor/`, `.codex/`, `AGENTS.md`, `opencode.json` or `.vscode/` in the
repo), `--repo-only` to write the config into this repo instead of your user folders,
`--dry-run` to only show the plan, `--smoke` to run a short test lane at the end (in
`~/.codeartsdoer/ca-smoke`, never in your repo). Without `--yes` it asks before each fix.

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

`onboard: ready` and a passing smoke test mean you are done. If the smoke test says
`keys rejected`, run `ca auth --force` and enter the key it names again.

## Connect a harness by hand

`ca onboard` does this for you (it runs `ca setup <harness> --user`). Run a line yourself to
redo or change it. Every command merges into existing config (other servers and settings are
kept), is safe to rerun and accepts `--dry-run`.

Machine-wide (`ca setup <harness> --user`, the default of `ca onboard`):

| Harness | What it writes | Then, in any repo |
|---|---|---|
| Claude Code | user MCP server (through `claude mcp add -s user`, or `~/.claude.json`), `~/.claude/skills/codearts-build/SKILL.md`, read-only tools allowed in `~/.claude/settings.json` | restart, then `/codearts-build <goal>` |
| Kiro | `~/.kiro/settings/mcp.json` (read-only tools auto-approved), `~/.kiro/steering/codearts-lanes.md` | `#codearts-lanes <goal>` |
| Cursor | `~/.cursor/mcp.json` (the server carries the workflow instructions) | "use CodeArts lanes to ..." |
| Codex | `[mcp_servers.codearts]` in `~/.codex/config.toml` (read-only tools pre-approved), a section in `~/.codex/AGENTS.md` | "use CodeArts lanes to ..." |
| opencode | `~/.config/opencode/opencode.json`, a section in `~/.config/opencode/AGENTS.md` | "use CodeArts lanes to ..." |
| VS Code | the user-profile `mcp.json` (`%APPDATA%\Code\User` on Windows) | agent mode, "use CodeArts lanes to ..." |
| Other MCP clients | add a stdio server: command `ca`, args `["mcp"]` | |

One repo only (`ca setup <harness>` inside the repo, or `ca onboard --repo-only`): Claude Code
`.mcp.json`, `.claude/skills/codearts-build/SKILL.md`, `.claude/settings.local.json`; Kiro
`.kiro/settings/mcp.json`, `.kiro/steering/codearts-lanes.md`; Cursor `.cursor/mcp.json`,
`.cursor/rules/codearts-lanes.mdc` (then `@codearts-lanes`); Codex an AGENTS.md section (the
MCP server always lives in `~/.codex/config.toml`); opencode `opencode.json` and an AGENTS.md
section; VS Code `.vscode/mcp.json`.

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
