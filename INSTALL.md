# Install CodeArts lanes (instructions for the coding agent)

You are a coding agent (Claude Code, Kiro, Cursor, Codex, opencode, VS Code, or another
harness). The human pasted a link to this file and wants CodeArts lanes set up. Setup is
**once per machine**: afterwards every repo works without setting anything up again.
**Do every step yourself with your shell tool. Do not ask the human to run commands.** The only
thing the human does is paste their Huawei Cloud keys into a local form (step 4). Keep your
messages to the human short: one line per step.

## 0. Already set up?

Run `ca --version`. If it prints `codearts-lanes 0.2.0` or newer, `ca doctor` prints `doctor:
ready` and your CodeArts tools (`ca_status`, `ca_lane_start`, ...) are already available to you,
skip to step 6. Anything else (no `ca`, an older version, a failing row, no tools): go to step 1.

## 1. Check the basics

Run `node --version` and `git --version`.
- Node must be 20 or newer. If it is missing or older, install it with the system package
  manager (`winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS,
  your distro's package or nvm on Linux), then continue.
- git must exist (`winget install Git.Git`, `brew install git`, or the distro package).

## 2. Install the `ca` command

Always run the install, also when `ca` already exists: it updates an older copy (an old copy
silently lacks fixes and writes the wrong config).

```sh
npm install -g github:Kahar90/codeartsclimcp
ca --version
```

`ca --version` must print `codearts-lanes 0.2.0` or newer. If it prints an older version, an
older `ca` is earlier on PATH: use the one npm just installed,
`node "$(npm root -g)/codearts-lanes/runner/ca.mjs"`, everywhere this file says `ca`.

If `ca` is not found at all afterwards (your shell's PATH lacks the npm global folder), use
`node "$(npm root -g)/codearts-lanes/runner/ca.mjs"` everywhere this file says `ca`. The
harness config written in step 3 uses that absolute path, so PATH does not matter later.

If the install fails (no permission for global installs, no npm), clone instead and use
`node ~/.codearts-lanes/runner/ca.mjs` everywhere this file says `ca`:

```sh
git clone --depth 1 https://github.com/Kahar90/codeartsclimcp ~/.codearts-lanes
```

To update later: `ca update` (reinstalls and refreshes every harness config).

## 3. Onboard this machine

Pick your harness name: `claude` (Claude Code), `kiro`, `cursor`, `codex`, `opencode` or
`vscode`. If you are none of these but support MCP, use the closest one and also add a stdio
MCP server named `codearts` with command `ca` and args `["mcp"]` to your own user config.

From the repository the human is working in (or any folder):

```sh
ca onboard --yes --harness <your harness> --json
```

This installs the CodeArts Agent CLI if it is missing (official Huawei Cloud installer, under a
minute), writes your harness's **user-level** config (MCP server and workflow rules; for Claude
Code also the `/codearts-build` skill), and, in a repo, makes it a git repo with a first commit
if needed and trusts the folder for CodeArts. Read the JSON: every step has `status` and, when
not ok, a `fix`.

- `codearts` row `fail`: run the `fix` command it shows yourself, then rerun onboard.
- `credentials` row `fail`: go to step 4.
- any other `fail`: follow its `fix` yourself; ask the human only if it needs a decision.

Only if the human wants the setup limited to this one repo, add `--repo-only` (it then writes
the config into the repo instead of the user folders).

## 4. Keys (the only human step)

Never ask the human to paste keys into the chat, and never print, log or commit them.

```sh
ca auth --json
```

It opens a local form in the human's browser (127.0.0.1 only) and returns at once with its
`url`. Tell the human in one message:

> A browser tab opened to connect CodeArts. Create an AK/SK at
> https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth, paste them into
> the form and click Save. (If no tab opened: <url>.)

Then wait for it:

```sh
ca auth --wait --timeout 540
```

Exit 0 means saved. Exit 124 means not yet: run the same command again (the form stays open
for 15 minutes; after that run `ca auth` again for a new link). The keys go to a user-only
file that the runner reads; no new terminal is needed.

Headless machine without a browser: ask the human to run `ca auth --stdin` in their own
terminal and paste `CODEARTS_CLI_AK=...` and `CODEARTS_CLI_SK=...` lines there.

## 5. Prove it works

```sh
ca onboard --yes --harness <your harness> --smoke --json
```

`ready: true` and the `smoke test` row `ok` (a throwaway lane of about 15 s, in its own folder
under `~/.codeartsdoer/ca-smoke`, never in the human's repo) mean everything works end to end.
If the smoke row says `keys rejected`, run `ca auth --force --json` and repeat step 4 (tell the
human which key was rejected, from the detail). Any other failure: read its `detail` and `fix`,
fix what you can, and rerun.

## 6. Hand over

Tell the human, in at most three lines:
- CodeArts lanes are ready on this machine, in every repo; the dashboard is at
  http://127.0.0.1:4777 (Office view at /office).
- How to use it from now on: Claude Code `/codearts-build <goal>`; Kiro `#codearts-lanes <goal>`;
  Cursor, Codex, opencode and VS Code: "use CodeArts lanes to <goal>".
- Restart the agent once so it loads the CodeArts tools (Claude Code: restart, or `/mcp`).

If the human already gave you a coding goal, do not wait for the restart: start it now with
the shell, following the workflow (`ca init`, edit the brief, `ca lane <repo> <task> --detach`,
`ca wait`, `ca summary`). `ca workflow` prints the full lead workflow; `ca help` lists every
command.
