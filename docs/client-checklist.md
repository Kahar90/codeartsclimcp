# Real-client checklist (Kiro, Cursor, VS Code)

Claude Code, Codex and opencode are tested automatically against the generated config. Kiro,
Cursor and VS Code need a signed-in person, so run this once per release (about 10 minutes per
client). Note the client version and tick each box; anything that fails, paste the exact
message into an issue.

## Before you start

```sh
ca update                      # latest version, refreshes every harness config
ca doctor                      # every row ok (warn rows are fine)
```

Make a throwaway repo: `mkdir ca-client-test && cd ca-client-test && git init && git commit --allow-empty -m init`.

## For each client

Run `ca onboard --yes --harness <kiro|cursor|vscode>` once, then restart the client and open the
throwaway repo.

| # | Step | Kiro | Cursor | VS Code |
|---|---|---|---|---|
| 1 | The `codearts` MCP server shows as connected (Kiro: MCP panel; Cursor: Settings, MCP; VS Code: `MCP: List Servers`) | [ ] | [ ] | [ ] |
| 2 | Its tools are listed (ca_doctor, ca_status, ca_lane_start, ca_wait, ...) | [ ] | [ ] | [ ] |
| 3 | Ask: "run ca_doctor". It runs without an approval prompt (read-only tools are pre-approved; VS Code may ask once) and shows the rows | [ ] | [ ] | [ ] |
| 4 | Ask: "Use CodeArts lanes to add a hello.txt file containing hi, with a check that it exists" (Kiro: `#codearts-lanes` first). The agent writes a brief, asks to start the lane, you approve | [ ] | [ ] | [ ] |
| 5 | http://127.0.0.1:4777 shows the lane running; the Office view shows a worker at a desk | [ ] | [ ] | [ ] |
| 6 | The agent waits with ca_wait (no polling loop) and reports the summary: commits, gates, verdict | [ ] | [ ] | [ ] |
| 7 | `git log` in the repo shows the lane's `step N:` commits | [ ] | [ ] | [ ] |
| 8 | Open a second, different repo. Step 3 works there too without any setup (machine-wide config) | [ ] | [ ] | [ ] |

## Where the config lives (if step 1 fails)

- Kiro: `~/.kiro/settings/mcp.json` and `~/.kiro/steering/codearts-lanes.md`.
- Cursor: `~/.cursor/mcp.json`.
- VS Code: the user-profile `mcp.json` (`MCP: Open User Configuration`).

`ca setup <harness> --user --dry-run` prints exactly what it would write. `ca uninstall --harness <h>`
removes it again.

## Clean up

`ca uninstall --harness <h>` for any client you do not keep, and delete the throwaway repos.
