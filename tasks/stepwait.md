You are working in a git repo (current directory): codearts-lanes, a Node lane runner (`runner/ca.mjs`) with an MCP
server (`runner/mcp.mjs`), no deps. Goal: let the lead wake up when a lane commits a step, so it can look at the step
(screenshots for UI files) and steer early, without waiting for the whole lane to end. The contract is
`checks/stepwait.check.mjs` (already committed): read it first. It and `checks/lib/fake-codearts.cjs` are fixed:
never edit them. Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"`. Do not ask questions; decide and keep going. Follow this brief
directly; do not write another plan or restate the requirements. Use grep to find code; do not read the whole of
runner/ca.mjs. Read only cmdWait (search `async function cmdWait`), the help text and the lanes registry helpers.

1. `ca wait --steps [--after N | --after <lane>=N[,<lane>=N...]]` in cmdWait. The baseline per lane is the --after
   value. With no --after, it is the lane's commit count (state.json commits) when the wait starts. A bad --after
   value (not a count or lane=count) exits 2 with the usage line, which mentions --steps and --after. The
   finished-lane rule runs first and is unchanged: when the result condition is met, print CA_RESULT and exit as
   today, even if new commits exist. Otherwise, when any target lane's commit count passes its baseline, print one
   line per such lane, `CA_STEP {json}`, and exit 10. The json holds: lane (id), commits (the new count, which is the
   next --after), new (the commitLog entries past the baseline: hash, subject, and step = N from a `step N:` subject
   or null), files (`git diff --name-only <first new>^ <last new>` in the lane repo, from the registry `repo`, at
   most 50), and ui (true when any file ends in .html .css .js .mjs .ts .tsx .jsx .vue .svelte .svg or .png). With
   --json, also print a final object {steps:[...same objects], running:[compact rows of the lanes with no new
   step]}. Without --steps, nothing changes. Commit.
2. Help and usage. Add --steps/--after to the `ca wait` usage strings and to `ca help` with one line: "--steps also
   returns (exit 10, CA_STEP) when a lane commits a new step; pass the printed commits as --after next time". Commit.
3. MCP ca_wait in runner/mcp.mjs. Add the inputSchema properties `steps` (boolean: "also return when a lane
   commits a new step, so you can look at it and steer early") and `after` (number or object {lane: count}: "the
   commits value from the previous step event; default the count when the call starts"). Pass them through as
   --steps and --after. Add exit 10 to the accepted result codes, with the WAIT_NEXT text "a step was committed:
   look at it now (screenshot the ui files), steer the lane if it went wrong, then call ca_wait again with
   steps: true and after set to the commits value". Return the steps array in the JSON text. Update the ca_wait
   description in one sentence. Do not change the defaults for calls without steps. Commit.
4. Run every CHECK line, fix what fails, commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run the targeted check for the step in the foreground with a timeout (for example `timeout 600 node checks/stepwait.check.mjs`); never sleep-poll a background job. Do not run the full list on every step: the runner runs every line below once when you finish.
CHECK: node --check runner/ca.mjs
CHECK: node --check runner/mcp.mjs
CHECK: node checks/stepwait.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/mcpwave.check.mjs
CHECK: node checks/cli.check.mjs
CHECK: node checks/ratelimit.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs (cmdWait, help/usage text) and runner/mcp.mjs. Do not
edit checks/, README.md, docs/ or CHANGELOG.md (the lead does docs).

Final reply: the steps with their commit hashes, and anything skipped.
