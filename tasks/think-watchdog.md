MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: the lane runner must notice a builder that keeps "thinking" (streaming reasoning) for many minutes without calling a tool or writing answer text, show that honestly in `ca status` and the dashboards, and nudge it back to work. Today reasoning deltas reset the silence watchdog, so such a lane shows "running, idle 1s" for half an hour. The contract is `checks/think.check.mjs`: read it first, it lists every name and string you need. Then read `runner/ca.mjs` functions `onEvent`, `waitTurn`, `drive`, `send` (the code that posts a prompt), `health` and `cmdHelp`.

How to work: small edits, then run `node checks/think.check.mjs` and read its FAIL lines; do not reason about the design for more than a minute before your next edit. Step 1 is a new small file: write and commit it within your first few tool calls.

Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. New file `runner/watchdog.mjs` (pure, no imports, no I/O): `progressAge({turnStartAt, lastToolAt, lastTextAt, now})` = now minus the latest of the three, and `thinkStall({busy, toolsRunning, turnStartAt, lastToolAt, lastTextAt, now, thinkS})` returning `{stall, ageMs, nudge}`: stall is true only when busy, no tool is running, thinkS > 0 and progressAge > thinkS seconds. `nudge` is a short resume message (under 400 chars, no em dash) telling the builder it spent N minutes reasoning without a tool call, to stop planning, make the next edit now and run the check. Commit.
2. Track progress in `runner/ca.mjs`: keep `S.turnStartAt` (set when a prompt is sent to the active session), `S.lastToolAt` (a tool part of the active session starts or completes) and `S.lastTextAt` (an assistant text part of the active session updates; reasoning parts do not count). They are saved in state.json like the other fields. Commit.
3. Watchdog in `waitTurn`: config `think: num('THINK_S', 480)` next to `stall` (also in `S.config`). When `thinkStall(...)` says stall, log `== watchdog: thinking <age> with no tool call (> THINK_S s): abort and nudge`, abort, and return `{ kind: 'think', what: 'thinking <age> with no tool call', nudge }`. In `drive`, a `think` result is recorded as an interruption of kind `think`, waits only 5 s (no long backoff), and resumes in the same session with the nudge text as the resume prompt. It counts toward MAX_RETRIES like the others. Commit.
4. Health: in `health(s)`, a busy lane with no running tool whose `progressAge` is over `s.config.think` (default 480 s) reports `thinking (<age>, no tool call)` using the same duration format as the rest of `ca status` (e.g. `thinking (25m3s, no tool call)`). Lanes whose state has none of the three fields (older runners) keep today's behaviour. STALLED still wins when the model is fully silent. Commit.
5. Help and docs: `ca help` lists THINK_S with the other env knobs (one line: what it does, default 480, 0 disables). Add the same knob to the env list in `README.md` and to `docs/workflow.md` if it lists env knobs. Commit.
6. Dashboards: in `runner/office.html` add "thinking" to the list that `healthKey` maps to "warn"; in `runner/dash.html` give the thinking health the warning colour (the class is built from the health text like `.h-quiet`). Change nothing else in those files. Commit.
7. Self check: re-read your changes against this brief and fix bugs you find; run every CHECK line and fix every FAIL (do not edit files under `checks/`). Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not start real lanes (`ca lane`) or CodeArts sessions; the checks use fake lanes.
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run `node checks/think.check.mjs` before each commit. The runner also runs every CHECK: line itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/think.check.mjs
CHECK: node checks/cli.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/mcp.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/watchdog.mjs`, `runner/ca.mjs`, `runner/office.html` (one list), `runner/dash.html` (one style rule), `README.md`, `docs/workflow.md`. Do not edit anything under `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
