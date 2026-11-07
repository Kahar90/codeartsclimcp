MODEL: maas/glm-5.3
You are working in a git repo (current directory): the `ca` CodeArts lane runner (Node 20, no dependencies).
Goal: token counters per agent (builder, reviewer, hidden sessions), per lane and per plan, and lane
controls a human can use from the dashboard without the lead: retry a stuck turn, fresh session, restart
the codearts server, skip a backoff wait, and resume a paused, failed, stopped or DEAD lane.
Files: runner/ca.mjs, new runner/tokens.mjs, new runner/controls.mjs, runner/mcp.mjs, checks/mcp.check.mjs,
README.md, docs/workflow.md. The contract is checks/controls.check.mjs: read it first, it is the spec.
Do not edit checks/controls.check.mjs, runner/dash.html, runner/office.html or runner/assets/.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Make a change, run the check, read its output. Do not reason for a long time without running something.

1. runner/tokens.mjs (pure ES module): `emptyTokens()` -> {input, output, reasoning, cacheRead, steps} all 0;
   `addStepTokens(acc, tk)` adds one step-finish record (tk.input, tk.output, tk.reasoning, tk.cache.read; steps += 1);
   `tokenTotal(t)` = input + output + reasoning + cacheRead (0 for null); `withTotal(t)` = copy plus total;
   `sumTokens(list)` sums every field over a list (null entries ok) and adds total.
   In runLane: replace the inline step-finish math with addStepTokens on S.tokens AND on
   S.tokensBy[role], where S.tokensBy = {build, review, other} (emptyTokens each) and role is: 'review' for
   S.reviewSession, 'build' for any session in a Set of builder sessions (the first build session and every
   fresh session created by drive() for build or fix), otherwise 'other' (hidden CodeArts sessions such as
   auto memory). Count each step-finish part once: keep a Set named `countedSteps` of part ids.
   On --resume, carry tokensBy over like tokens. Commit.
2. Views. laneView, statusRow and `ca summary --json`: `tokens` = withTotal(s.tokens), `tokensBy` =
   {build, review, other}, each withTotal and zeros when missing (old lanes). planView: `tokens` = sumTokens of
   every plan lane including folded (continued) ones, `tokensBy` = per role sums. laneFromLog also parses
   `(cache read N)`. `ca status` table: a TOKENS column right after COMMITS with compact numbers
   (950, 6.3k, 12k, 1.24M). Summary line: keep `tokens in X out Y (cache read Z) over S steps` exactly as
   now and append ` | total T | by agent: build B, review R, other O`. Commit.
3. runner/controls.mjs (pure): `laneActions({ s, alive, health, canResume })` -> { actions, suggest, why }.
   Running (no s.result, alive): base ['steer', 'stop', 'attach']; phase build, fix, review or restart adds
   'kick', 'fresh', 'restart-server'; phase backoff adds 'skip-wait', 'restart-server' (no kick) and suggests
   'skip-wait'; gate and starting add nothing. health STALLED, quiet or thinking... suggests 'kick' with a
   why such as "no model activity for 6m" or "thinking 12m with no tool call".
   No result but not alive (DEAD): ['resume', 'stop'] (only 'stop' if !canResume), suggest 'resume'.
   result paused, stopped, failed, killed or needs review: ['resume'] if canResume; suggest 'resume' for paused
   and failed, except a credential failure (s.exitCode 3 or reason auth): no suggest, why says "missing
   credentials: run ca auth". done: no actions. Wire into laneView: actions, suggest, why (canResume = repo
   folder and tasks/<task>.md exist; alive = alive(s.pid); health = health(s)). Commit.
4. Kick, inside the supervisor. File `<lane dir>/KICK`, JSON {at, mode, text, by}, mode one of turn | fresh |
   server | now. Delete a stale KICK when a lane starts. In waitTurn, when KICK exists: read it, delete it, log
   `== kick (<mode>) from <by>: <text>`, then: turn / now / fresh -> abort(sid) and return {kind: 'kick', mode, text, by};
   server -> abort(sid), killTree(server.child.pid), wait up to 15 s until !server.alive, return
   {kind: 'server-died', kicked: true, text, by}. In drive(): a kicked outcome is pushed to S.interruptions with
   kind 'kick' but does NOT count toward MAX_RETRIES and has no backoff. turn / now: send resumeText plus, when
   text is set, "\n\nMessage from the lead: <text>". fresh: new session (added to the builder Set when the label is
   build or fix) and send freshSession(...) plus the text; without freshSession (review) behave like turn.
   server: the existing restart path, then resume like turn. In waitInterruptible (backoff): if KICK exists,
   read it, delete it, log `== backoff skipped by <by>`, return true at once; remember its mode so a server or
   fresh kick still applies on that resume. Commit.
5. Resume from anywhere. In ca.mjs add `resumeLane(l, { note, by })` returning {ok, message, argv, dry} or
   {error, code: 409}: refuse a done lane and a running lane (no result and alive). DEAD (no result, not
   alive): killTree(s.server?.pid) and mark the state stopped like cmdStop does. A note is appended to
   `<lane dir>/resume-note.txt` as "[<ISO time> <by>] <note>\n" (never in the repo's tasks/ folder).
   argv = [ca.mjs path, 'lane', repo, task, '--resume']. With env CA_RESUME_DRY=1 do not spawn: return
   {ok, dry: true, argv}. Otherwise spawn it detached (windowsHide) with stdout and stderr appended to
   <repo>/tasks/<task>.lane.log and env CA_RESUMED_BY=<by>. If a registered plan contains the lane, append a
   plan decision "Resumed <lane id> from the <by><: note if any>". In runLane --resume: read and delete
   resume-note.txt and put its text into the "Notes from the lead" block together with tasks/<task>.resume.md;
   store CA_RESUMED_BY as `resumedBy` on the run and say it. CLI: `ca resume <lane> [--note "text"] [--dry-run]`
   (--dry-run = CA_RESUME_DRY) prints `CA_RESUME <json>`, exit 0; a refusal goes to stderr with exit 2. Commit.
6. CLI `ca kick <lane> [--fresh|--server|--now] [message]` (default mode turn, by 'ca kick'): exit 2 with a reason
   when the lane is finished, DEAD (say "use ca resume") or the action is not in laneActions (for example during
   the gate). Dashboard API in cmdDash: POST /api/lane/:id/kick {mode, text} (by 'dashboard'; 400 for a bad
   mode, 409 when not allowed, the DEAD message mentions resume), POST /api/lane/:id/resume {note} (by
   'dashboard', 409 on refusal). Every POST under /api/ must carry content-type application/json, else 415
   (blocks cross-site form posts). Add both commands to the usage header comment so `ca help` lists them. Commit.
7. MCP and docs: runner/mcp.mjs gets `ca_kick` (lane, mode enum turn|fresh|server|now, message) and
   `ca_resume` (lane, note) in the same style as ca_steer and ca_stop; mention them in INSTRUCTIONS; update
   checks/mcp.check.mjs if it counts tools. README.md: a short "Controls and tokens" section; docs/workflow.md:
   one paragraph on kick, resume and token counters. Commit.
8. Self check: re-read your changes against this brief, run every check below, fix every FAIL. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers and never start a real lane (`ca lane`); use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs each of the following itself when you finish
and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/controls.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/cli.check.mjs
Constraints: no em dashes anywhere. Only touch the files listed above.

Final reply: the steps with their commit hashes, and anything skipped.
