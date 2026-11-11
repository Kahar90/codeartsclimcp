# Changelog

## 0.9.0 (2026-11-11)

Updates
- One lane state machine: a lane's phases, results and end causes are declared in `runner/lanestate.mjs`, and
  one classifier decides its health, status, bucket and actions. The CLI, MCP, Lanes and Office views all read
  that one answer, so a lane can no longer sit under Needs you with a Running badge. Contract:
  `docs/contracts/lanestate.txt`.
- A lane waiting on the lead says so on its own badge: "Asked lead" (a worker question), "No progress" and
  "Not acting" (thinking without a tool call) now carry the needs-you mark, like the bucket they sit in.
- Truthful end labels: a finished lane records why it ended (`end.cause`). "Missing credentials: run ca auth"
  shows only for a real credentials failure (not for any reason that mentions "auth"), and a lane closed after
  its supervisor died reads "Stopped (supervisor died)", not "Stopped by lead".
- Plans follow their lanes: a plan reads Needs you exactly when one of its lanes does. A lane the lead stopped
  no longer makes the plan read Needs you or Failed, and a lane waiting on review, stalled or asking a question
  always does. The Office lead badge shows the same plan badge as every other plan pill.
- The runner nudges a builder that reads without writing: after 25 read-only tool calls or 5 minutes without a
  file change it is told to make the first change now (`READ_STREAK`, `FIRST_WRITE_S`; a brief line
  `WRITE_FIRST: off` turns it off). Keep the default flash builder even for complex lanes: on this release's
  lanes two GLM 5.3 builders went 15 and 40 minutes without writing a file.
- `ca wait` no longer wakes the lead again with a blocker it just answered (a steer or ack the supervisor had
  not applied yet), and a repeat-fail blocker now carries the tool's own error.
- `ca brief-check` no longer warns about the files an "Only touch ..." rule allows, and a path that ends a
  sentence is matched.
- `ca stop` and `ca resume` on a dead lane write its final state atomically and never rewrite a lane that
  already finished. The step list shows the current step during review too.
- View fallbacks (older server, demo mode) follow the server rules: needs review is never counted as done,
  continued and stopped lanes are ended, and bar and result colours come from the lane status.


## 0.8.0 (2026-11-11)

Updates
- Truthful progress: a step counts as done only with a `step N:` commit. Both views now show the real fraction
  ("2/3") on a finished, merged or stopped lane with open steps (new `steps: "partial"` in the status
  contract), never a forced "3/3" check mark.
- The lead hears about trouble at once: a worker's plain-text question at the end of a turn, an environment
  failure it cannot fix (a refused commit, a Git access or certificate error, a sandbox permission error) and
  a check wrapper stuck after its check finished all become a blocker that wakes `ca wait` (exit 11)
  immediately. Rhetorical questions, quoted code and retried network errors stay quiet.
- A lane cannot end `done` with work missing: dirty work is recovered before the completion check, and the tree
  and HEAD are checked again after the gates before done is accepted.
- Reviewer: the final and step reviewers run in a scoped read-only role (edit, write and patch tools denied on
  the lane's own server) and review the source, not their own runner logs. A healthy reviewer session is reused
  for the fix re-review, and step reviews already covered by the final review are skipped.
- Shared model quota: optional step reviews wait while other lanes' builders use the same model (flash
  reasoning aliases count as one model), so early reviews no longer slow the builders down.
- Gates: a CHECK line that already passed on the same source is not run again, also when another line must
  run; `CHECK_PARALLEL: N` in a brief runs independent CHECK lines side by side (default stays sequential).
- Builders start with the small source files the brief names quoted in the first prompt, bounded and filtered
  (no secrets, config or binaries). Briefs can set `TOOL_PROFILE: core` to give the builder only the coding
  tools; the brief template uses it.
- `ca brief-check` sees untracked contract files the lead just wrote.
- Speed: the 4-step benchmark is not faster yet (median 411 s on 0.7.1, 467 to 547 s on candidates of this
  release, 3 runs each); see docs/benchmark-results.md. This release is about truth and lead control.

## 0.7.1 (2026-11-10)

Updates
- macOS: output printed right before ca exits (CA_RESULT, error messages) is no longer lost when an agent or the MCP server reads ca through a pipe.
- Phones: the top bar fits a 390 px screen with Linux and macOS fonts (the Needs you pill stuck out by up to 25 px).
- CI is green on Linux (Node 20 and 22), macOS and Windows: check fixes for zombie processes, animation timing and font metrics.

## 0.7.0 (2026-11-10)

Updates
- A blocked worker reaches the lead in seconds instead of looping unseen. A worker question no longer just
  disappears: the lane moves to Needs you with the question ("asked the lead: ..."), the worker is told to
  continue with its best option, and `ca wait` / MCP `ca_wait` return at once with exit 11 and a `CA_BLOCKED`
  line. A steer, a new commit or `ca ack` clears it. The plan glance and the Office sign say Needs you too.
- No-progress alarm: no commit for a new step in `NO_COMMIT_S` seconds (default 900, 0 disables) raises the same
  alert with the step it is stuck before. Busywork commits ("wip: ...") do not reset it; fix rounds count any commit.
- `ca brief-check <repo> <task>` (MCP `ca_brief_check`, also run at lane start and listed in the summary) warns
  when a "do not edit X" rule protects files that name files the brief changes, and when a CHECK line runs a
  missing file. Warnings never block a lane.
- Lane control never guesses: `stop`, `rm`, `kick`, `resume`, `ack` and `steer` need a lane name, and a lane can
  never control itself (`CA_IN_LANE`), so a worker testing the CLI cannot stop its own lane.
- Guards: the runner restores its check helper if a worker overwrites it and tells the worker; a supervisor whose
  repo was deleted stops itself and its CodeArts server.
- Any OpenAI-compatible API for a lane: a `maas/<model>` named in BUILD_MODEL, REVIEW_MODEL, STEP_REVIEW_MODEL or
  THINK_FALLBACK_MODEL that is not built in is declared on the fly, so `MAAS_BASE_URL` + `MAAS_API_KEY` point a
  lane at another region or another vendor's API.
- `ca doctor` no longer reports a repo under a Windows 8.3 short path as a git worktree.
- Internals: `runner/ca.mjs` (3,430 lines) is split into `common`, `server`, `lane`, `commands`, `engineer`, `plan`
  and `dash-server` modules (pure move, every check unchanged). Repo cleanup: owner-specific files removed,
  CONTRIBUTING.md, SECURITY.md, .editorconfig, CI on Node 20 and 22, a faster onboard check (no real download).


## 0.6.0 (2026-11-10)

Updates
- Lanes reach a ready verdict about 2x faster at the same quality. On a fixed benchmark (a 4-step notes API
  with a 29-check contract; `node tools/bench.mjs` runs it and does the lead's fix lanes until the review says
  ready and the contract is green), 0.5.4 took a median 14.9 min over 18 runs and needed a whole fix lane in
  10 of them. 0.6.0 took a median 6.9 min (16.0 min vs 6.9 min in the same rounds, run side by side), the
  slowest run went from 23.2 to 9.5 min, and no run needed a fix lane. Every run passed the same quality gate.
  Here is how:
- Review fix rounds: a "needs fixes" verdict no longer ends the lane. The findings go back to the same builder
  session (context kept), the gates run again, and a focused re-review checks only the fix (`REVIEW_FIXES`,
  default 1; a brief line `REVIEW_FIXES: N`; 0 for the old behaviour).
- Check service: the CodeArts sandbox has no local network, so a worker's (or reviewer's) own run of a check
  that starts a server hung for minutes, and workers spent more minutes fighting the sandbox. Every lane now
  has `node tasks/<task>.lane/check.mjs <N|all>`, which runs a CHECK line outside the sandbox and prints the real
  output. If the worker already ran every CHECK line green on the final commit, the gate reuses those runs.
- Step reviews: every `step N:` commit gets a short read-only review while the builder works on the next step,
  and real findings reach the builder at once. On MaaS they use flash, so they do not compete with the GLM final
  review (`STEP_REVIEW_MODEL`; `STEP_REVIEW: off` or `STEP_REVIEW=0` turns them off). When the builder is done, a
  step review still running gets a 20 s grace (`STEP_REVIEW_GRACE_S`), then the final review covers its commits.
- The final review starts as soon as every numbered step is committed and the tree is clean, while the builder
  wraps up, and keeps running while the CHECK lines run. A newer commit or a failed check discards it and it
  runs again.
- Reviewers read the code instead of rerunning the checks the runner already gates, and are told their sandbox
  has no local network.
- `ca wait --steps [--after N]` and MCP `ca_wait {steps: true, after}` also return (exit 10, `CA_STEP`) when a
  lane commits a step, with the changed files and a `ui` flag, so the lead can look at UI steps during the build.
- New opt-in model `maas/deepseek-v4.1-flash-fast` (flash with thinking off). Measured: about half the latency
  per call, but lanes took twice as long (more turns and mistakes), so it is not the default.
- Lead workflow (MCP prompt and skill): prefer small parallel lanes, run a brief's existing checks before
  starting it, do your own share while lanes run, verify once after the merge.
- For maintainers: `tools/bench.mjs` times real lanes against a quality gate; `tools/ship.mjs [--push]` runs
  the release tail (full checks, install, push) in one command.

## 0.5.4 (2026-11-10)

Updates
- Snappier dashboard: every poll used to re-read every lane and plan file once per plan and once per lane
  (about 1 s per request at 100 lanes and 8 plans, so two open tabs kept the dashboard half busy). Parsed files
  are now cached until they change and each request reads the lanes and plans once: about 25 ms per request.
- Open in Lanes from the Office agent window shows the lane name at once ("Opening lane...") while its
  detail loads, so it never looks like the Control room.
- Faster commands: user environment variables are read in one registry query instead of one PowerShell
  start per name (`ca doctor` 5.4 s to 3.3 s; lane start and `ca auth` gain the same).
- Checks: `npm run check` runs the fast set (no browser) in parallel in about 1.5 min with per-check times;
  `npm run check:full` runs all 48 in about 4 min (was over 10).

## 0.5.3 (2026-11-09)

Updates
- Time taken: every plan shows how long the work took, from when the lead started planning (`startedAt`
  in plan.json) to `ca plan close` (or now while it is open). Hover, focus or tap the **Time** chip in Lanes
  or the Office top bar for the breakdown: lead planning, lanes running, lead between lanes, lead verifying,
  worker time per phase (build, checks, fix, review, waiting) and per lane. Paused gaps are not lane time.
- `ca plan` stamps a missing `startedAt`, `ca plan close` records `closedAt`, `ca plan list` prints the total,
  and every lane carries its own time split (the Elapsed metric shows it on hover).

## 0.5.2 (2026-11-08)

Updates
- Office uses a wider room (a panorama with more wall, windows and stairs at the sides), so wide
  screens are filled edge to edge without zooming in: 1280x800, 1920x945 and 2560x1080 all show the
  whole working area with no band. Stations, hot desks and the ceiling lamp glow were re-placed on the
  new art; the lamp position now comes from scene.json.
- Phones show a taller room: the narrow layout crops the outer walls to the stations instead of
  shrinking the whole panorama into a thin strip.

## 0.5.1 (2026-11-08)

Updates
- Office fills the stage: no more dark bands beside the room. The room is scaled to cover the whole
  stage as far as every station sprite and nameplate stays in view, which fully covers 16:9 desktop
  screens; on ultra-wide screens the leftover area shows a blurred, dimmed copy of the room instead of
  a flat dark band. The narrow (phone, portrait tablet) layout is unchanged.

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
