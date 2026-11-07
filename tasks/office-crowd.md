MODEL: maas/glm-5.3
You are working in a git repo (current directory): the Office view `runner/office.html` of the `ca` CodeArts lane
runner (Pixel Workshop room with the lead and three worker stations). Goal: when more than three lanes exist, the
extra lanes appear in the room as real sprites at hot desks instead of only a list: five hot desks, then a "+N more"
pill for anything beyond eight lanes. The art is ready, do not draw or change it:
- runner/assets/sprites.json roles hot1..hot5 (same clips as builder: idle, work, receive, complete, blocked) and
  props.hotdesk { image, anchor, size } (a small desk with a monitor, drawn BEHIND the worker; place its anchor on
  the worker's foot point, scale like the sprites: spriteScale(), image-rendering pixelated).
- runner/assets/scene.json hotdesks: [{ key: 'hot1'..'hot5', role, foot: [x, y] stage pixels, prop: 'hotdesk',
  plate: 'below' }]. A preview of the intended look: design/office-hotdesks-preview.png.
Files: runner/office.html and checks/office.check.mjs only. Shared runtime runner/assets/workshop.js: read, do not edit.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.
Make a change, run the check, read its output. Do not compute pixel layouts by hand: change, run the check, read numbers.

1. Load hotdesks from scene.json (fall back to the same five entries in code) and the hotdesk prop from the sprite
   manifest. A hot desk is drawn only while a lane sits there (an empty room stays as today with up to 3 lanes).
   Worker sprites and desks are stacked by foot y so nearer things cover farther ones. Commit.
2. Seating. Main stations keep today's sticky assignment. Remaining lanes go to hot desks, sticky by lane id while
   the page is open. Candidates are ordered: needs-you lanes first (health STALLED, DEAD, failed, paused, thinking,
   needs review, or bucket 'attention' when present), then running, then finished by newest finishedAt. When a new
   candidate has no seat, the seat of a finished lane (done, stopped, continued, dropped) is released for it, so a
   stuck or running lane is never left off the stage while a finished one keeps a desk. Commit.
3. Hot desk worker: sprite role hotN with the same clip mapping as the main workers (work while running, blocked for
   STALLED, DEAD or failed, complete on finish, idle otherwise), one-shot cues like the main stations, a compact
   nameplate below the foot (task name, status word, steps x/y, compact tokens) that never overlaps other plates, the
   "!" attention badge when the lane has a suggest, and click (sprite or plate) opens the same agent window with
   tokens, steps, controls and steer. Connector lines from the lead only for the three main stations (keep the room
   calm); hovering a hot worker may show a thin dashed line. Commit.
4. Overflow: lanes beyond the eight seats go into a "+N more" pill at the bottom right (replacing the current
   "Other lanes" panel): it opens a short list, needs-you first, each row with status word, "!" when suggested,
   compact tokens; a row click opens the agent window. At phone width (body.narrow) the pill stays visible as a bar
   under the stage. Commit.
5. Demo `?demo=crowd`: ten lanes in one plan: 3 main stations busy, hot desks with 2 needing you (one STALLED with
   suggest kick, one failed with suggest resume), 2 running, 1 done, plus 2 more lanes (one running, one done) so the
   pill shows 2. Tokens, tokensBy, actions, suggest and why on every lane like the other demos. Existing demo modes
   must render exactly as before (their checks keep passing). Commit.
6. Test hook: window.__office.state() stations include hot desks (station 'hot1'..'hot5', role, laneId, status,
   clip, plate rect, foot, suggest, desk: true when the prop is drawn) and overflow: { count, ids, open }. Commit.
7. Extend checks/office.check.mjs with ?demo=crowd at 1280x800 and 390 px: 8 lane sprites plus the lead are on
   stage; both needs-you lanes are seated (not in the pill); every seated hot worker has its desk; no two plates
   overlap (main and compact plates together) and all plates are inside the stage; the pill shows 2 and lists them;
   clicking a hot worker opens the window and its controls show the suggested action first; no horizontal overflow
   at 390 px. Save screenshots 8-crowd.png and 8-crowd-phone.png. Commit.
8. Self check: re-read your changes against this brief, run every check below, fix every FAIL. Commit if changed.

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
