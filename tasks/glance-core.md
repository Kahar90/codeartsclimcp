You are working in a git repo (current directory). Goal: the server computes one glance state per plan, so a
person across the room can tell at once if the work is running, done, failed or waiting on them.
Read `tasks/glance-contract.txt` first: it is the exact shape and wording the two view lanes rely on.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.

1. Lead phase `asking`: in `runner/ca.mjs` add `asking` to `LEAD_PHASES` (it means the lead ended its turn
   with a question for the human). Update every place that lists the phases: the usage comment near line 55,
   `runner/mcp.mjs` (instructions near line 59, the ca_note description near line 405 and the phase field
   description near line 412) and `templates/claude-skill.md`. In the template, add one bullet under the
   plan-keeping rules: "Before you end your turn to ask the human anything (a question, a choice, an approval),
   post `ca_note {now: true, phase: 'asking', text: '<the question in one line>'}`; when work resumes, post the
   next phase. The dashboard shows it as Needs you." Keep the template's existing style. Commit.
2. Glance: in `runner/ca.mjs` `planView`, add `glance` to the returned object as in the contract. Rules, first
   match wins (QUIET_MS = 15 minutes, `age` = lead.age, attn lanes = lanes whose statusKey passes attnKey):
   a. plan closed (state done or closed): "failed" if any live lane has status key failed, checks failing or
      killed, else "done" (detail "All N lanes finished" or the close reason when the plan has one).
   b. lead.phase "asking": "needs-you", detail "Claude is asking: <latest activity text or now>".
   c. lead.phase "done": "done".
   d. counts.running > 0: "working", detail "<running> of <total> lanes running" plus ", step d/t" of the first
      running lane when it has progress.
   e. age not null and age < QUIET_MS and lead.phase in planning, building, waiting, verifying: "working",
      detail "Claude is <phase>" (verifying, planning, ...).
   f. any attn lane: "failed" if one has key failed, checks failing or killed (detail "<task> failed: <reason>"),
      else "needs-you" (detail "<task>: <status label>").
   g. lanes exist or a lead phase is set: "quiet", word "Check Claude", detail "No lead update for <dur>;
      Claude may be waiting on you" (use "No lead update yet" when age is null).
   h. otherwise "idle".
   `at`: for done the newest of lead update and last lane finish, for asking the lead nowAt, else null is fine.
   Keep it one small pure function `glanceOf(view)` next to planView, exported nowhere new. Commit.
3. Check: add `checks/glance.check.mjs` that tests `glanceOf` on hand-built plan views for every rule above
   (import it the way other checks reach ca.mjs internals; if ca.mjs exposes nothing importable, run
   `node runner/ca.mjs` against temp plan.json files in a temp CA home like `checks/planstate.check.mjs` does,
   and read `/api/plans` from `ca dash` on a free port). Also assert `ca note --phase asking` is accepted and
   `--phase bogus` is refused. Print PASS/FAIL lines, exit 1 on any FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node --check runner/ca.mjs
CHECK: node checks/glance.check.mjs
CHECK: node checks/planstate.check.mjs
CHECK: node checks/mcp.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs`, `runner/mcp.mjs`, `templates/claude-skill.md`,
`checks/glance.check.mjs`. Do not touch `runner/office.html` or `runner/dash.html`.

Final reply: the steps with their commit hashes, and anything skipped.