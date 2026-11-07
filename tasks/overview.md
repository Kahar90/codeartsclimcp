MODEL: maas/deepseek-v4.1-flash
You are working in a git repo (current directory): the `ca` CodeArts lane runner and its dashboard.
Goal: the user runs lanes in several repos and projects at once and acts as the management plane. Rework the
Lanes page home into a Control room that answers in two seconds: what needs me, what is running, what finished,
what ended. Every lane already has from the server: bucket (attention | running | done | ended), bucketWhy (short
reason), project {key, name}, health, actions, suggest, why, tokens, progress, startedAt, finishedAt.
GET /api/overview returns { counts, lanes }.
Files: runner/dash.html, runner/ca.mjs (only the parts named below), runner/mcp.mjs (ca_lead_tokens), runner/office.html,
checks/lanes.check.mjs, new checks/overview.check.mjs. Shared helpers in runner/assets/workshop.js: read, do not edit.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Make a change, run the check, read its output. Do not reason for a long time without running something.

1. Server, ack: POST /api/lane/:id/ack {seen: true|false} stores the lane id and finishedAt in
   `<registry>/acks.json` (the CA_REGISTRY folder; JSON content-type required like the other POSTs); laneView adds
   `seen` (true when acked for this finishedAt, so a resumed and finished-again lane is unseen again). `ca status`
   sorts attention first, then running, done, ended, and adds a BUCKET column as the first column after LANE.
   checks/overview.check.mjs: fake lanes in a private CA_REGISTRY (copy the style of checks/resume.check.mjs), assert
   ack round trip, seen reset after a new finishedAt, status order, /api/overview counts. Commit.
2. Control room route `#/` (the default when no plan or lane is selected; the rail gets a "Control room" entry at
   the top with the attention count). Top: four count tiles, Needs you (bad colour), Running (run colour), Done
   (done colour, counts only unseen), Ended (idle colour). Each tile is a filter toggle. Status is never colour
   only: each bucket also has its own icon shape and word. Commit.
3. Lane rows: one row per lane, sections in bucket order (Needs you, Running, Done, Ended collapsed by default,
   Done already seen collapsed as "Seen earlier"). A row shows: bucket badge, project name chip, task name, the
   bucketWhy text, a time phrase ("stuck 6m", "running 24m, step 3/8", "finished 2h ago"), step progress bar,
   compact token total, the suggested action button (same confirm and note flow as the lane detail controls) and
   an Open link to the lane detail. Done rows get "Mark seen"; seen rows "Mark unseen". Commit.
4. Projects: a group toggle "By status | By project". By project shows one block per project.key with its counts
   and its lanes in bucket order. Project filter chips (all projects plus each project with its attention count)
   above the list. Remember the toggle, filters and collapsed sections in localStorage (wrapped in try/catch).
   Commit.
5. Always trustworthy: a "Updated Ns ago" freshness label that turns into a red banner "Dashboard cannot reach
   the runner since HH:MM:SS" when /api calls fail for over 10 s; the tab title becomes "(N) Needs you · Lanes"
   when N > 0, else "Lanes"; a Notifications toggle (off by default, asks permission on click) that shows a
   browser notification when a lane enters attention or done (diff by lane id between polls, never on first
   load). Commit.
6. Lane detail header: show the bucket badge and bucketWhy prominently above the controls bar, and a "Back to
   Control room" link. Rail lanes get a small bucket dot. Office view (runner/office.html): the top bar gets a
   "Needs you N" pill (hidden at 0) linking to `/#/`, and the plan status there uses the same bucket wording. Commit.
7. Tokens by model, lead included. Lanes and plans already expose tokensByModel ({"maas/glm-5.3": {..., total}, ...}).
   Server (ca.mjs planView): a plan may name its lead's usage in plan.json as `leadSession` (path to a Claude Code
   transcript .jsonl) or `leadTokens` ({"<model>": {input, output, cacheRead, cacheWrite}}, written by any harness).
   For leadSession, parse the jsonl lines whose message.role is assistant and message.usage exists, count each
   message.id once, and sum per message.model: input = input_tokens, cacheRead = cache_read_input_tokens,
   cacheWrite = cache_creation_input_tokens, output = output_tokens; only lines with timestamp >= plan.leadSince when
   set. Cache the result by file mtime. planView adds `lead: { tokensByModel }` and merges it into tokensByModel and
   tokens (total includes cacheWrite) with each entry marked `who: 'lead' | 'worker'`. New CLI `ca lead-tokens
   [--plan id] [--session file]` sets leadSession on the plan (default session: newest .jsonl in
   ~/.claude/projects/<cwd with every char that is not a letter, digit or - replaced by ->/, for example
   D--Coding-codearts-testing) and prints the per-model totals. UI: a "Tokens by model" table
   on the plan home and the Control room (model short name, lead or worker tag, total, in / out / cache) sorted by
   total, plus the same per lane in lane detail; the Office top bar Tokens pill title lists the per-model lines.
   Unknown is never zero (many harnesses cannot report usage): every by-model entry carries `source`
   ('runner' = counted from CodeArts events, 'transcript' = leadSession, 'reported' = leadTokens or ca lead-tokens
   --set, 'none'). A plan with no lead data still lists its lead as one row: the model from plan.lead (or "lead"),
   `source: 'none'`, total null, shown as "not reported" with a hint "ca lead-tokens --set ... or leadTokens in
   plan.json". A worker lane whose steps ran but whose provider returned no usage (steps > 0 and every count 0)
   gets `source: 'none'` too and shows "not reported", not 0. Plan totals: `tokens.total` sums known entries only and
   `tokens.complete` is false when any entry is 'none'; the UI then labels the total "Known 7.4M" with a title
   naming what is missing. Harness-neutral reporting: `ca lead-tokens --set <model> --input N --output N
   [--cache-read N] [--cache-write N] [--plan id]` writes leadTokens (adds to an existing entry with --add), and
   runner/mcp.mjs gets a `ca_lead_tokens` tool with the same fields so Kiro, Cursor, Codex or any MCP lead can report.
   Add asserts to checks/overview.check.mjs with a small fake transcript (duplicate message ids counted once), a plan
   with no lead data (row with source none, complete false), --set and --add, and a zero-usage worker lane. Commit.
8. Test hook and checks: window.__lanes.state() adds overview { counts, group, filter, sections: [{ bucket, ids }],
   projects: [ids], title: document.title, banner: bool }. Extend the ?demo=1 fixture with bucket, bucketWhy and
   project on every lane (at least two projects, one lane per bucket, one seen done lane) and demo answers for
   /api/overview and ack. Extend checks/lanes.check.mjs: default route is the Control room; Needs you section
   first and holds the stuck and failed lanes; tile filter shows only that bucket; By project groups by key; Mark
   seen moves a row to Seen earlier; document.title has the count; a simulated API failure (demo hook) shows the
   banner; no horizontal overflow at 390 px; screenshots of the Control room at 1280 and 390 px. Then re-read this
   brief, fix every FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write new browser scripts; only the check files drive Chrome. Never start a real lane.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs each of the following itself when you finish
and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/overview.check.mjs
CHECK: node checks/controls.check.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/assets.check.mjs
Constraints: no em dashes anywhere. Add `[hidden]{display:none!important}` if a section uses display rules.

Final reply: the steps with their commit hashes, and anything skipped.
