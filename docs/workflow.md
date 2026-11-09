# CodeArts lanes: lead workflow

You are the lead. CodeArts (a coding agent on Huawei Cloud models) is the worker: it writes the
code, commits each step and runs the checks. You plan, write short briefs, wait, read the
summary, verify and decide. Keep your own tokens for planning and the final check: read lane
summaries, not transcripts.

## 1. Preflight
- `ca_doctor` (or `ca doctor`). Fix every `fail` row before starting; `warn` rows are optional.
- The repo must be a git repo with a first commit: if it is not, run `git init` and
  `git commit --allow-empty -m "first commit"` yourself (`ca lane` trusts the folder by itself).
- Run `git status`. If the human's own files are untracked or modified (common right after
  `git init`), tell them and ask to commit them first (or commit them yourself as a baseline if
  they agree): otherwise the lane's first step commits them together with its change, and the
  reviewer reports them as rewritten. Never commit `.env` files or secrets.
- Know the repo's check commands (tests, typecheck, lint); if there are none, plan a step that adds one.
- `ca_update_check {}` reports whether a newer codearts-lanes exists; if so, tell the user once and
  offer `ca_update` (it reinstalls, then they restart the agent and any open dashboard).

## 2. Plan
- Split the goal into lanes that do not touch the same files. Up to 3 lanes at once.
- Parallel lanes each get a git worktree: `git worktree add ../<repo>-wt-<task> -b lane/<task>`.
- Optional plan for the dashboard: `tasks/plan.json` with `title, goal, lead, status, now,
  startedAt (an ISO time; write it when you start planning), waves[{name, lanes}], lanes[{task,
  repo, model, why, files}], next, decisions, risks`, then `ca_plan`. If startedAt is missing,
  `ca plan` fills it in from the first decision or lane, so the plan's total time stays stable.
  `ca plan close` also records `closedAt`; the dashboard then shows how long the whole plan took,
  split into lead planning, lanes running, lead between lanes and lead verifying. Update the
  "lead is doing" line with `ca_note` (now: true).

## 3. Brief (one per lane)
- `ca_init {repo, task, goal}` writes `tasks/<task>.md` from the template; then edit it:
  - at most 8 numbered steps, exact files and behaviour, "commit after each step" with subject
    `step N: ...`;
  - one `CHECK: <command>` line per check: the runner runs them itself when the worker goes idle
    and feeds failures back (up to 3 fix rounds);
  - a step that adds a test hook or script so results can be verified without looking at a UI;
  - "only touch <files>", "do not ask questions", the safety rules from the template;
  - no MODEL line by default: flash builds every lane, GLM 5.3 reviews. Add `MODEL: maas/glm-5.3`
    only for very complex lanes (many files across modules, long context, hard design reasoning).

## 4. Run and watch
- `ca_lane_start {repo, task}` (CLI: `ca lane <repo> <task> --detach`). It returns at once.
- `ca_wait {lanes, timeout_s}` blocks until every lane has a result or the timeout passes (at
  most 55 s per call, so your MCP client never times out; exit 124: still running, call it again
  right away). A lane takes minutes: expect several calls. Do not poll `ca_status` in a loop.
- The human watches the dashboard (http://127.0.0.1:4777, Office view at /office) or attaches the
  CodeArts TUI with `ca attach <lane>`.
- Health values: running, running tool, quiet (>60 s silent), STALLED (watchdog will abort and
  resume), DEAD (supervisor gone, `ca_stop` cleans up), done, needs review, failed, stopped.
- Steering: `ca_steer {lane, message}` for clarifications, scope cuts, "also do X". A real change
  of direction: `ca_stop`, edit the brief, start again.
- Stuck turn: `ca_kick {lane, mode, message}` (turn retries the turn, fresh starts a clean
  session, server restarts the codearts server, now skips a backoff wait). Ended lane:
  `ca_resume {lane, note}` continues a paused, failed, stopped or DEAD lane in place, applying
  the note first. The human can do both from the dashboard.
- Handled: after you deal with a failed, paused or needs-review lane yourself (merged it, took it
  over, dropped it), `ca_ack {lane, note}` moves it out of the human's "Needs you" list into
  Ended with your note. It comes back if the lane runs and ends again. Old leftovers from earlier
  sessions: `ca_ack {stale: true, note}` handles every finished Needs-you lane older than 48 h
  (`older_than_h` to change it); tell the human which ones.
- Tokens of the lead: Claude Code leads run `ca lead-tokens` once per plan (reads the session
  transcript live); other harnesses report with `ca_lead_tokens` or `leadTokens` in plan.json.
  Unknown usage shows as "not reported", never as 0.
- Token counters: each lane tracks its tokens per agent (build, review, other sessions) and per
  model; `ca_status`, `ca_summary` and the plan views carry them, so cost is visible per lane
  and per plan.

## 5. Judge and verify
- Exit codes / results: 0 done (review ready), 4 needs review, 1 failed or stopped,
  2 usage or unknown lane, 3 keys missing or rejected (ask the human to run `ca auth`; never ask
  for keys in chat), 5 paused at the time limit (`ca_resume` continues it), 124 still running.
  `ca_wait` returns a `next` hint for each.
- Rate limits, network drops and a crowded model are waited out by the runner; a lane that shows
  `rate limited`, `offline` or `queued` needs nothing from you.
- `ca_summary {lane}`: commits, gates, fix rounds, interruptions, steering, outside-repo access,
  reviewer findings and VERDICT. Open `ca_tail` only when the summary points at a problem.
- Judge reviewer findings against the brief and the steering; overrule ones that contradict
  them and say so.
- Run the checks yourself on the lane's branch; for UI, drive the real app. Check `git status`.
- Real bug: write `tasks/<task>-fix.md` (finding, file:line, expected behaviour, CHECK line) and
  run it as a new lane. Fix one-liners yourself.
- Merge worktree lanes into main yourself, run the checks on main, remove the worktree.

## 6. Report and close
What was built, commits, checks and in-app results, verdicts and what you overruled, open items.
If you registered a plan, close it when the work is done or a wave will not run: `ca_plan_close
{id, reason}` (never-started lanes become Dropped). Never leave a plan open.
The brief stays in `tasks/<task>.md` (lane logs and state are gitignored): say so in the report, and
commit it with the work or delete it as the human prefers. Do not push unless the human asks.

## Rules
- Never commit secrets, CLI configs or lane logs (`tasks/*.lane/`, `tasks/*.lane.log`).
- The code goes to Huawei Cloud models: briefs on private data say "numbers only, never print
  private text".
