# Changelog

## 0.2.0 (2026-11-07)

Setup and first use
- Setup is once per machine: `ca onboard` writes your harness's user-level config (Claude Code,
  Kiro, Cursor, Codex, opencode, VS Code), so every repo works without setting it up again.
  `--repo-only` keeps the old per-repo files.
- Codex: the MCP server is always written to `~/.codex/config.toml`, and stale paths are replaced.
- The smoke test runs in `~/.codeartsdoer/ca-smoke`, never inside your repo, and is marked seen.
- First-run dashboard: one setup prompt to paste, what to type in each agent, a Connect keys
  button, readable doctor rows, works on a phone.
- `ca --version`; INSTALL.md always installs or updates, so an old copy is never reused.
- `ca update` reinstalls and refreshes every harness config; `ca uninstall` removes exactly what
  setup added (`--keys` also removes the keys).
- `ca doctor` prints readable rows, warns when a harness config points at a missing install, and
  when the CodeArts CLI version has never passed the smoke test.

Keys
- A rejected AK/SK or MaaS key ends a lane in seconds with exit 3 and names the key and the fix
  (`ca auth --force`); before, a wrong AK/SK looked like an IAM outage and retried for minutes.
- `ca auth` checks a MaaS key before saving it.
- Windows: keys are stored encrypted with DPAPI; old plain files are migrated; an unreadable file
  is explained.

Reliability
- Rate limits are waited out on their own budget (`RATE_WAIT_S`, 30 min) instead of failing the lane.
- Network drops are waited out (`NET_WAIT_S`), a laptop sleep is recognised, and lanes queue for a
  free slot when too many use one model (`CA_MAX_LANES_PER_MODEL`).
- macOS and Linux: fixed the folder-trust crash; CI runs every check on Ubuntu, macOS and Windows.

Security
- The dashboard rejects foreign Host headers (DNS rebinding) and answers 400 on bad JSON.
- `CA_DUMP_ENV` never writes a secret; `NODE_TLS_REJECT_UNAUTHORIZED=0` is gone.
- Lane and plan names must match exactly or uniquely; ambiguous names are refused.

MCP
- `ca_wait` returns paused (5) and key (3) results with a `next` hint instead of a tool error.
- New tools: `ca_plan_close`, `ca_plan_list`, `ca_gc`. Read-only tools carry `readOnlyHint`.
