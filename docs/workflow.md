# CodeArts lanes: lead workflow

You are the lead. CodeArts (a coding agent on Huawei Cloud models) is the worker: it writes the
code, commits each step and runs the checks. You plan, write short briefs, wait, read the
summary, verify and decide. Keep your own tokens for planning and the final check: read lane
summaries, not transcripts.

## 1. Preflight
- `ca_doctor` (or `ca doctor`). Fix every `fail` row before starting; `warn` rows are optional.
- The repo must be a git repo with a first commit: if it is not, run `git init` and
  `git commit --allow-empty -m "first commit"` yourself (`ca lane` trusts the folder by itself).
  Know its check commands (tests, typecheck, lint); if there are none, plan a step that adds one.

## 2. Plan
- Split the goal into lanes that do not touch the same files. Up to 3 lanes at once.
- Parallel lanes each get a git worktree: `git worktree add ../<repo>-wt-<task> -b lane/<task>`.
- Optional plan for the dashboard: `tasks/plan.json` with `title, goal, lead, status, now,
  waves[{name, lanes}], lanes[{task, repo, model, why, files}], next, decisions, risks`, then
  `ca_plan`. Update the "lead is doing" line with `ca_note` (now: true).

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
- `ca_wait {lanes, timeout_s}` blocks until every lane has a result or the timeout passes
  (exit 124: still running, call it again). Do not poll `ca_status` in a loop.
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
  Ended with your note. It comes back if the lane runs and ends again.
- Tokens of the lead: Claude Code leads run `ca lead-tokens` once per plan (reads the session
  transcript live); other harnesses report with `ca_lead_tokens` or `leadTokens` in plan.json.
  Unknown usage shows as "not reported", never as 0.
- Token counters: each lane tracks its tokens per agent (build, review, other sessions) and per
  model; `ca_status`, `ca_summary` and the plan views carry them, so cost is visible per lane
  and per plan.

## 5. Judge and verify
- Exit codes / results: 0 done (review ready), 4 needs review, 1 failed or stopped,
  2 usage or unknown lane, 3 missing credentials, 124 wait timeout.
- `ca_summary {lane}`: commits, gates, fix rounds, interruptions, steering, outside-repo access,
  reviewer findings and VERDICT. Open `ca_tail` only when the summary points at a problem.
- Judge reviewer findings against the brief and the steering; overrule ones that contradict
  them and say so.
- Run the checks yourself on the lane's branch; for UI, drive the real app. Check `git status`.
- Real bug: write `tasks/<task>-fix.md` (finding, file:line, expected behaviour, CHECK line) and
  run it as a new lane. Fix one-liners yourself.
- Merge worktree lanes into main yourself, run the checks on main, remove the worktree.

## 6. Report
What was built, commits, checks and in-app results, verdicts and what you overruled, open items.

## Rules
- Never commit secrets, CLI configs or lane logs (`tasks/*.lane/`, `tasks/*.lane.log`).
- The code goes to Huawei Cloud models: briefs on private data say "numbers only, never print
  private text".
