# Contributing

codearts-lanes is plain Node ESM (Node 20+) with no npm dependencies. Keep it that way: a new
dependency needs a strong reason in the pull request.

## Layout

| Path | What |
| --- | --- |
| `runner/ca.mjs` | the `ca` CLI and lane supervisor |
| `runner/mcp.mjs` | MCP stdio server (tools for any agent harness) |
| `runner/setup.mjs`, `onboard.mjs`, `lifecycle.mjs`, `auth.mjs` | harness setup, guided first run, update/uninstall, credentials |
| `runner/controls.mjs`, `watchdog.mjs`, `netwait.mjs`, `tokens.mjs`, `authsignal.mjs` | shared pure logic used by the CLI, MCP and dashboards |
| `runner/dash.html`, `runner/office.html`, `runner/assets/` | the Lanes dashboard and the Office view |
| `templates/` | brief, review and skill templates shipped to users |
| `checks/` | contract checks (`*.check.mjs`), helpers in `checks/lib/` |
| `tools/` | check runner, release, ship, bench |
| `bin/` | `ca` shims for sh and cmd |
| `scripts/` | `install-local.mjs` (install this checkout globally), `trust.mjs` (CodeArts folder trust) |
| `bench/` | the benchmark fixture (`node tools/bench.mjs`; results go to the gitignored `bench/results.jsonl`) |
| `docs/` | user docs; `docs/contracts/` status contracts the checks enforce |

`tasks/` is the lead's working folder (briefs, plans, lane logs) and is not tracked.

## Checks

- `npm run check`: every check that does not drive a browser, in parallel (about 1.5 min). Fake
  lanes only, no paid model calls.
- `npm run check:full`: everything, browser checks included (needs Chrome). Runs in CI on Linux,
  macOS and Windows.
- `node tools/run-checks.mjs <name>`: only the checks whose file name contains `<name>`.

A new feature comes with a contract check in `checks/<feature>.check.mjs`: temp repos, a private
`CA_REGISTRY`, `CA_DASH=0`, and `PASS`/`FAIL` lines on stdout. Checks never touch the real home
folder, registry or CodeArts config.

## Style

- Node ESM, `node:` imports, two-space indent, LF line endings (see `.editorconfig`).
- HTTP handlers never call `die()`; user-facing errors carry a fix line.
- No em dashes in code, docs or commit messages.
- Never commit secrets, CLI configs or lane logs.

## Releases

1. Merge into `main`, run `npm run check`.
2. `node tools/release.mjs <version>`, then fill the new `CHANGELOG.md` section.
3. `node tools/ship.mjs [--push]`: commits the release, runs `check:full`, installs it locally.
