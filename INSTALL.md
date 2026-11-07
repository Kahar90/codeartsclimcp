# Install CodeArts lanes (instructions for the coding agent)

You are a coding agent (Claude Code, Kiro, Cursor, Codex, opencode, VS Code, or another
harness). The human pasted a link to this file and wants CodeArts lanes set up in the
current repository. **Do every step yourself with your shell tool. Do not ask the human to run
commands.** The only thing the human does is paste their Huawei Cloud keys into a local form
(step 4). Keep your messages to the human short: one line per step.

## 1. Check the basics

Run `node --version` and `git --version`.
- Node must be 20 or newer. If it is missing or older, install it with the system package
  manager (`winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS,
  your distro's package or nvm on Linux), then continue.
- git must exist (`winget install Git.Git`, `brew install git`, or the distro package).

## 2. Install the `ca` command

Run `ca help`. If it prints the usage, skip to step 3. Otherwise:

```sh
npm install -g github:Kahar90/codeartsclimcp
```

If `ca` is still not found afterwards (your shell's PATH lacks the npm global folder), use
`node "$(npm root -g)/codearts-lanes/runner/ca.mjs"` everywhere this file says `ca`. The
harness config written in step 3 uses that absolute path, so PATH does not matter later.

If the install fails (no permission for global installs, no npm), clone instead and use
`node ~/.codearts-lanes/runner/ca.mjs` everywhere this file says `ca`:

```sh
git clone --depth 1 https://github.com/Kahar90/codeartsclimcp ~/.codearts-lanes
```

To update later, run the same install command again.

## 3. Onboard this repository

Pick your harness name: `claude` (Claude Code), `kiro`, `cursor`, `codex`, `opencode` or
`vscode`. If you are none of these but support MCP, use the closest one and also add a stdio
MCP server named `codearts` with command `ca` and args `["mcp"]` to your own config.

From the repository root:

```sh
ca onboard --yes --harness <your harness> --json
```

This installs the CodeArts Agent CLI if it is missing (official Huawei Cloud installer, can
take a few minutes), makes the folder a git repo with a first commit if needed, trusts the
folder for CodeArts, and writes your harness config (MCP server, rules, and for Claude Code the
`/codearts-build` skill). Read the JSON: every step has `status` and, when not ok, a `fix`.

- `codearts` row `fail`: run the `fix` command it shows yourself, then rerun onboard.
- `credentials` row `fail`: go to step 4, then rerun onboard.
- any other `fail`: follow its `fix` yourself; ask the human only if it needs a decision.

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
file that the runner reads; no new terminal is needed. Then rerun step 3.

Headless machine without a browser: ask the human to run `ca auth --stdin` in their own
terminal and paste `CODEARTS_CLI_AK=...` and `CODEARTS_CLI_SK=...` lines there.

## 5. Prove it works

```sh
ca onboard --yes --harness <your harness> --smoke --json
```

`ready: true` and the `smoke test` row `ok` (a throwaway 25 s lane) mean everything works end
to end. If the smoke test fails, read its `detail` and `fix`, fix what you can, and rerun.

## 6. Hand over

Tell the human, in at most three lines:
- CodeArts lanes are ready in this repo; the dashboard is at http://127.0.0.1:4777 (Office
  view at /office).
- How to use it from now on: Claude Code `/codearts-build <goal>`; Kiro `#codearts-lanes` and
  the goal; Cursor `@codearts-lanes` and the goal; Codex, opencode and VS Code: "use CodeArts
  lanes to <goal>".
- Your harness loads the new MCP tools on its next start (Claude Code: restart, or `/mcp`).

If the human already gave you a coding goal, do not wait for the restart: start it now with
the shell, following the workflow (`ca init`, edit the brief, `ca lane <repo> <task> --detach`,
`ca wait`, `ca summary`). `ca workflow` prints the full lead workflow; `ca help` lists every
command.
