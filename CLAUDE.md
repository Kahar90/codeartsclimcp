# ca-office

Source of codearts-lanes: the lane runner (`runner/ca.mjs`), the MCP server (`runner/mcp.mjs`), the
dashboards (`runner/dash.html`, Office view `runner/office.html` with Pixel Workshop assets in
`runner/assets/`) and the skill template (`templates/claude-skill.md`). We build it with itself, so
what runs is the global install at `npm root -g`/codearts-lanes, not this checkout.

## Ship every feature to ourselves (required)
A feature is not finished until the installed copy runs it:
1. Merge into main, run the checks below on main.
2. `node tools/release.mjs <next version>`, fill the new `CHANGELOG.md` section, commit.
3. With no lane running: `node scripts/install-local.mjs` (packs main, installs it globally, reruns
   `ca setup` for every harness, restarts the dashboard). Then reconnect the MCP server (`/mcp`).
4. Push main to origin when the human has asked for it.
Steps 1 (check:full) to 4 in one command, after step 2's version bump and changelog:
`node tools/ship.mjs [--push]` (commits the release files, runs check:full, install-local, push; run it
in the background while you write the report).

## Before starting lanes
- Parallel lanes run in local clones, never `git worktree add`: a worktree's git dir lives in the main repo's
  `.git/worktrees/`, outside the lane folder the CodeArts sandbox confines the worker to, so its commits fail with
  `Unable to create .../index.lock: Permission denied`. Use `ca workspace <repo> <task>` (or
  `git clone --local --no-hardlinks <repo> ../<repo>-wt-<task>` + `git checkout -b lane/<task>`), and merge back
  with `ca workspace --land` (or `git fetch <clone> lane/<task>` + `git merge --no-ff FETCH_HEAD`).
- `ca doctor <worktree>` must have no `fail` row (the `repo writable` row catches Windows Controlled
  Folder Access and sandbox ACLs that block git and node in Documents).
- Wait with `ca wait --any` (MCP `any: true`) and check that each lane has commits within minutes.

Checks (the runner prints per-check times; slow ones are listed in checks/out/timings.json):
- `npm run check`: the fast set, every check that does not drive a browser, in parallel (about 1.5 min).
  Run it once after a merge, not per step.
- `npm run check:full`: everything, browser checks included (at most 3 Chrome at once). Once before a
  release, and in CI.
- `node tools/run-checks.mjs <name>`: only matching checks (browser ones too), for the files you touched.
- `node checks/perf.check.mjs`: dashboard poll cost on 100 lanes and 8 plans (median under 60 ms per route).

Manual: `node runner/ca.mjs dash 4790`, then http://127.0.0.1:4790/office (`?demo=1`, `?demo=done`,
`?demo=needs`, `?demo=failed`, `?demo=quiet`, `?demo=big`); Lanes: http://127.0.0.1:4790/?demo=1
(`&glance=done|failed|quiet`). Design specs: `docs/design/`; status contracts: `docs/contracts/`.
