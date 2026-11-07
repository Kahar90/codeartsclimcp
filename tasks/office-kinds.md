You are working in a git repo (current directory): the Office view `runner/office.html` of the `ca` CodeArts lane
runner. Goal: every worker character matches what its lane does, instead of every extra lane being a robot.
The art and the data are ready, do not draw or change them:
- Every lane from /api/lanes (and every plan lane) now has `kind`: 'code' | 'art' | 'review' | 'docs'.
- runner/assets/sprites.json `kinds`: { code: { rolePrefix: 'hot', prop: 'hotdesk', label: 'Coder' }, art: { rolePrefix:
  'painter', prop: 'easel', label: 'Painter' }, review: { rolePrefix: 'inspector', prop: 'board', label: 'Inspector' },
  docs: { rolePrefix: 'writer', prop: 'bookdesk', label: 'Writer' } }. Roles `<rolePrefix>1` .. `<rolePrefix>5` exist for
  every kind (five colours, same clips as the other roles) and props hotdesk, easel, board, bookdesk share one frame
  (same size and anchor), so any prop fits any hot desk. Preview of the intended look: design/office-kinds-preview.png.
Files: runner/office.html and checks/office.check.mjs only. Do not edit runner/assets/ or runner/ca.mjs.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Your very next action after reading this must be a grep, then an edit. Use grep to find code (hotdesk, HOTDESKS,
stationLane, hotCandidates, isNeedsYou, demo crowd, __office) instead of reading the whole file. One edit per change.

1. Hot desk cast: a lane seated at hot desk N (1..5) uses role `<kinds[lane.kind].rolePrefix>N` and prop
   `kinds[lane.kind].prop` (unknown or missing kind = code). If the lane's kind changes while seated, swap the role and
   prop in place. The colour still comes from the seat number, so neighbours differ. Commit.
2. Main stations by kind: when a main station (builder, artist, reviewer) is free and a lane needs a seat, prefer a
   lane whose kind matches it (code -> builder, art -> artist, review -> reviewer); docs lanes and the rest go to hot
   desks. Sticky seats stay sticky: never move a lane that is already seated. Commit.
3. Agent window and plates: the window title row shows the kind label (for example "Painter") next to the status; the
   hot-desk plate title attribute says "<label> · <task>". Commit.
4. Demo: give every lane in ?demo=crowd a kind so the hot desks show at least one painter, one inspector, one writer
   and one coder (needs-you lanes stay seated first). Add kind to the other demo lanes too (office-scene code,
   office-sprites art, office-review review). Commit.
5. Test hook and check: __office.state() stations carry `kind` and `role`; window carries `kind`. In
   checks/office.check.mjs (?demo=crowd): every hot station's role starts with its kind's rolePrefix and its desk image
   is that kind's prop; the hot desks show at least 3 different kinds; every plate centre still hits its own plate
   (existing check); screenshot 9-kinds.png. Commit.
6. Self check: re-read this brief, run every check below, fix every FAIL. Add `[hidden]{display:none!important}` for
   any new element with display rules. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers yourself or write new browser scripts; only checks/office.check.mjs drives Chrome.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs each of the following itself when you finish
and sends you the output if one fails.
CHECK: node checks/office.check.mjs
CHECK: node checks/assets.check.mjs
Constraints: no em dashes anywhere. Only touch runner/office.html and checks/office.check.mjs.

Final reply: the steps with their commit hashes, and anything skipped.
