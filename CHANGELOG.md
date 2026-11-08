# Changelog

## 0.5.0 (2026-11-08)

Updates
- One truthful status: the server owns every status word. Each lane carries `attention` (does it need
  you), `steps` (live, complete or hide) and a glyph; each plan carries `badge`, always the glance word.
  Pills, labels, banners and the sign can no longer disagree, settled lanes never show a stray step
  fraction ("Handled by lead", "Stopped by lead", "Merged 3/3"), and lanes of a closed plan never need you.
- Office fits the whole room on any screen (no cropping), draws agents 20% smaller, places the sign where
  it covers no agent, and animates running lanes again (lane sprites were stuck on idle with real data).
- Glance toggle (eye button, `g` key) in both views: off gives a plain agent-team view; the choice is
  shared by both views and remembered.
- Lanes no longer fail on "Permission denied": `ca workspace <repo> <task>` makes each lane a local clone
  (a worktree's git dir sits outside the lane folder the CodeArts sandbox allows), `ca workspace --land`
  merges it back, `ca doctor` warns on a worktree, and the runner commits for a worker whose commit was
  refused instead of looping.
- Workers are kept from sleep-polling (`sleep 20+` is refused or steered), a check that crashes after
  passing counts as failed instead of "couldn't run", and `ca_wait` returns compact rows.
- `ca ack` handles any finished lane; `ca plan update --patch-file <file>` and `--patch -` (stdin).
- Every browser check exits cleanly under Node 26; three outdated checks were brought up to date.


## 0.4.0 (2026-11-08)

Updates
- Glance status: every plan has one state (Working, Needs you, Failed, Done, Check Claude) readable from
  across the room. The Office view hangs a pixel sign over the back wall, lights the room edges in the
  state color and gives the lead a speech bubble; the Lanes view shows a banner, rail dots and the
  worst open plan on the Control room. Both set the tab title and favicon; Notify also fires on plan
  Done, Needs you and Failed.
- New lead phase `asking`: the lead posts it before ending a turn with a question, so the dashboard
  shows Needs you. A plan with no lead update for 15 minutes and nothing running reads Check Claude.
- `ca doctor` has a `repo writable` row: it writes a probe file and a git lock through the worker shell,
  catching Windows Controlled Folder Access and sandbox ACLs before any lane starts.
- A lane whose repo cannot be written fails at once (`repo not writable`) instead of spending fix rounds.
- `ca wait --any` (MCP `any: true`) returns when the first lane ends.
- `scripts/install-local.mjs` installs this checkout's committed code globally and restarts the dashboard.

## 0.3.0 (2026-11-08)

Updates
- You now hear about new versions: `ca status`, `ca doctor`, `ca plan` and `ca lane` print one line when
  a newer release is out (checked at most once a day in the background, never slowing a command;
  `CA_NO_UPDATE_CHECK=1` turns it off).
- `ca update --check` shows what is new in every newer version; `ca update` installs it and says to
  restart your agent so its MCP server loads the new code.
- Both dashboards show an Update pill with the release notes, Update now (installs, restarts the
  dashboard and reloads the page), Copy command and Later.
- MCP: `ca_update_check` and `ca_update`; your agent is told once when an update is available.
- `ca doctor` has a `ca version` row.

Office
- Agent windows always stay on screen at any window size, scroll inside themselves when tall, and
  move back inside when you resize.
- On phones and portrait tablets the room sits on top with the lane list below, and an agent opens
  as a bottom sheet.
- Every window, menu, card and toast animates in and out (instant with reduced motion); nameplates
  respond to hover and press and stay highlighted while their window is open.
- A first run shows a friendly empty state instead of "Not finished".
- Every lane belongs to a plan, and the Office follows the plan that is working.

Lanes dashboard
- Redesigned Control room tiles and rows, animated sections, consistent disclosure arrows.
- Lane page: one breadcrumb, one status badge, a read-only pipeline stepper; on phones the steer box
  and controls take two compact rows.
- Needs-you rows show their age; lanes older than 2 days group under one Mark all handled
  (`ca ack --stale`, MCP `ca_ack` stale).
- Bigger tap targets on phones, themed scrollbars, skeleton while loading.

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
