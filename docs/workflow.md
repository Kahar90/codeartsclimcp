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
- Register the plan as soon as you split the goal: `tasks/plan.json` with `title, goal, lead,
  status, now, waves[{name, lanes}], lanes[{task, repo, model, why, files}], next, decisions,
  risks`, then `ca_plan`. The plan is how the human sees your intent, so register it even for a
  single lane. Never leave a plan open at the end (section 6).
- Add `startedAt` (an ISO time) when you start planning; `ca plan` fills it in from the first decision or
  lane if missing, and `ca plan close` records `closedAt`. The dashboard shows the plan's total time and,
  on hover, lead planning, lanes running, lead between lanes, lead verifying and worker time per phase.
- Keep it current while the work moves, and only when something real changed:
  - `ca_note {text, now: true, phase}` for a transition or progress; the phases are `planning`,
    `building`, `waiting`, `verifying`, `done`. Each now note is timestamped and kept in a bounded
    recent-activity history both views show, so the dashboard reads the lead phase, latest activity
    and how long ago you last updated.
  - `ca_plan_update {id, patch}` for changed scope: a revised `goal`, new `next` tasks, or `waves`
    and `lanes`. It patches only the fields you send and bumps the revision.
  - Publish real transitions, not a heartbeat: nothing changed means nothing to post. Never paste
    private reasoning or chat, only what you did and what is next.
- Publish activity before long waits, before verification and before closing. When a user message
  changes scope, publish the revised goal, pending tasks and lanes before starting the added work.
  Pass the plan id explicitly to notes so concurrent projects cannot steal your updates.
- Split the goal into lanes that do not touch the same files. Up to 3 lanes at once.
- Wall time is mostly waiting, so plan for overlap (it costs no quality):
  - Prefer two or three small lanes (1 to 4 steps each, split by file) running in parallel over one
    long lane: a 3-step lane ends in about 20 to 30 minutes, an 8-step lane in 60 to 90.
  - Write the contract check (the new behaviour as a failing check) before the brief, and run the
    brief's existing CHECK lines on main before you start the lane. A check that is already broken costs a
    whole fix round (15 minutes or more) to rediscover.
  - While lanes run, do your own share (docs, the next wave's contract check and brief) instead of
    waiting. Write those files on main, never inside a running lane's folder: its `git add -A` would
    sweep them into its commits.
- Parallel lanes each get a local clone: `ca_workspace {repo, task, from}` (CLI
  `ca workspace <repo> <task> [--from <branch>]`) makes `../<repo>-wt-<task>` on branch
  `lane/<task>`. Never use `git worktree add` for a lane: a worktree keeps its git dir in the main
  repo, outside the lane folder, so the CodeArts sandbox refuses every commit ("Permission denied").

## 3. Brief (one per lane)
- `ca_init {repo, task, goal}` writes `tasks/<task>.md` from the template; then edit it to be lean:
  - aim for 1 to 3 outcome steps, and never more than 8. Each step is a piece of behaviour a check
    can prove, names the exact files and behaviour, and says "commit after each step" with subject
    `step N: ...`. A step is not a chore list.
  - one `CHECK: <command>` line per check, and reuse a check another step or lane already has
    instead of adding a near-duplicate. The runner runs the lines itself when the worker goes idle
    and feeds failures back (up to 3 fix rounds).
  - reuse existing test hooks or scripts; add one only when needed to verify new behavior.
  - "only touch <files>", "do not ask questions", the safety rules from the template.
  - no separate self-review step: the runner's reviewer gate and your own verification cover it,
    and the worker commits only steps that work, so a "re-read and fix" step just burns time.
  - no MODEL line by default: flash builds every lane, GLM 5.3 reviews. Add `MODEL: maas/glm-5.3`
    only for very complex lanes (many files across modules, long context, hard design reasoning).
  - the worker runs only the check for the step before each commit; the runner runs every CHECK
    line once at the end. Do not ask for the whole suite per step: it multiplies the lane time.
- Step reviews are on by default: each `step N:` commit gets a short read-only review (the review
  model) while the builder works on the next step. Real findings reach the builder as a steer at
  once, instead of in a fix round at the end. The final review then starts as soon as the work tree
  is clean and runs while the CHECK lines run. Turn step reviews off for one lane with a brief line
  `STEP_REVIEW: off`, or everywhere with env `STEP_REVIEW=0` (both cost review tokens, not time).
- A final "needs fixes" verdict is fixed inside the lane: the findings go back to the same builder
  session, the gates run again and a focused re-review checks only the fix (`REVIEW_FIXES`, default 1
  round; a brief line `REVIEW_FIXES: 2` allows more, 0 ends the lane at the first verdict as before).
  You only get "needs review" when the findings survive that round.
- Workers run in the CodeArts sandbox, which has no local network: a check that starts a server cannot
  run in the worker's own shell. The runner gives every lane a helper the worker uses instead
  (`node tasks/<task>.lane/check.mjs <N|all>`): it runs the CHECK line outside the sandbox and prints the
  real output. When the worker ran every CHECK line green on the final commit, the gate reuses those
  results instead of running them again. Briefs need nothing extra for this; the runner tells the worker.

Precise briefs reduce ambiguity; they cannot disable model reasoning. Keep file reads and tool
outputs targeted, batch independent reads, and avoid rereading full files. Token savings require
measured evidence across comparable tasks. Workers run targeted checks on changed behavior before
committing; the runner runs final CHECK gates at idle and the lead verifies the final result.

## 4. Run and watch
- `ca_lane_start {repo, task}` (CLI: `ca lane <repo> <task> --detach`). It returns at once.
- `ca_wait {lanes, timeout_s}` blocks until every lane has a result or the timeout passes (at
  most 55 s per call, so your MCP client never times out; exit 124: still running, call it again
  right away). A lane takes minutes: expect several calls. Do not poll `ca_status` in a loop.
- Look at the work while it is built, not after: `ca_wait {lanes, steps: true, after}` (CLI
  `ca wait <lane> --steps --after N`) also returns (exit 10) when a lane commits a new step, with the
  new commits, the changed files and `ui: true` when they include page or style files. For UI steps,
  screenshot the changed surface right away and `ca_steer` the lane if it looks wrong. Then call
  `ca_wait` again with `after` set to the returned `commits`. A visual bug found at step 2 costs one
  steer; found after the lane ends, it costs a fix lane or your own time.
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
- Reading the numbers: `cache read` is context the model replayed from cache on every turn. It
  accumulates fast and usually dwarfs the rest, but it is replayed context, not new generation and
  not the same as price. `reasoning` (thinking) tokens are the model's own deliberation and output
  tokens are what it wrote; judge cost from input, output, cache-read and cache-write separately.
  The views show cumulative totals, so a large cache-read total means long context replayed many
  times, not that many tokens were generated, and turning thinking off does not remove the replay.

## 5. Judge and verify
- Exit codes / results: 0 done (review ready), 4 needs review, 1 failed or stopped,
  2 usage or unknown lane, 3 keys missing or rejected (ask the human to run `ca auth`; never ask
  for keys in chat), 5 paused at the time limit (`ca_resume` continues it), 10 a step was committed
  (only with `steps: true`), 124 still running.
  `ca_wait` returns a `next` hint for each.
- A finished lane whose CHECK lines could not run (missing tool, sandbox) is `unverified` (exit
  4); one whose CHECK ran and still failed after the fix rounds is `checks failing` (exit 1).
- Rate limits, network drops and a crowded model are waited out by the runner; a lane that shows
  `rate limited`, `offline` or `queued` needs nothing from you.
- `ca_summary {lane}`: commits, gates, fix rounds, interruptions, steering, outside-repo access,
  step reviews, reviewer findings and VERDICT. Open `ca_tail` only when the summary points at a problem.
- Verify once: the lane's gates already ran its CHECK lines on its last commit, so do not rerun them
  on the same commit. After merging, run the repo's fast suite once. Run any slow or browser suite
  once, right before a release.
- Judge reviewer findings against the brief and the steering; overrule ones that contradict
  them and say so.
- Run the checks yourself on the lane's branch; for UI, drive the real app. Check `git status`.
- Real bug: write `tasks/<task>-fix.md` (finding, file:line, expected behaviour, CHECK line) and
  run it as a new lane. Fix one-liners yourself.
- Merge a lane workspace back yourself with `ca_workspace --land {repo, task}` (CLI
  `ca workspace --land <repo> <task>`): it refuses on a dirty main tree, fetches and merges the lane
  branch, then removes the clone. Run the checks on main.

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
