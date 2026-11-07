MODEL: maas/glm-5.3
You are working in a git repo (current directory): the `ca` CodeArts lane runner and its dashboard.
Goal: the user runs lanes in several repos and projects at once and acts as the management plane. Rework the
Lanes page home into a Control room that answers in two seconds: what needs me, what is running, what finished,
what ended. Every lane already has from the server: bucket (attention | running | done | ended), bucketWhy (short
reason), project {key, name}, health, actions, suggest, why, tokens, progress, startedAt, finishedAt.
GET /api/overview returns { counts, lanes }.
Files: runner/dash.html, runner/ca.mjs (only the parts named below), runner/office.html (step 7 only),
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
   Control room" link. Rail lanes get a small bucket dot. Commit.
7. Office view: the top bar gets a "Needs you N" pill (hidden at 0) linking to `/#/`, and the plan status there uses
   the same bucket wording. Only this change in runner/office.html. Commit.
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
