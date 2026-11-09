You are working in a git repo (current directory). The Office room must fill the whole desktop stage with no dark letterbox bands, while every station sprite, nameplate and the sign stay inside the stage.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going. Follow this brief directly; do not write another plan
or restate the requirements. Read only relevant code and keep tool output focused.

Context: `sizeStage()` in `runner/office.html` (around line 882) sets `k = Math.min(w / STAGE_W, h / STAGE_H)`
on desktop, so the room (`<img id="room">`, 1280x720 art) is letterboxed and the dark `#stage` background
shows as bands left/right (or top/bottom). Every sprite, desk, plate, lamp and bubble is placed with
`ox + x * k`, `oy + y * k`, so changing `k`, `ox`, `oy` moves everything together. The narrow layout
(`narrow` true) must stay exactly as it is.

1. Content-aware cover fit in `sizeStage()` (desktop branch only), `runner/office.html`:
   - `kFit = Math.min(w/STAGE_W, h/STAGE_H)`, `kCover = Math.max(w/STAGE_W, h/STAGE_H)`.
   - Content box in room units from `SCENE.stations` and `SCENE.hotdesks` feet:
     x from `minFootX - 130` to `maxFootX + 130`, y from `minFootY - 120` to `maxFootY + 80`
     (sprites and desks sit above the foot, the plate sits 34 units below it), clamped to the room [0..STAGE_W]x[0..STAGE_H].
   - `k = Math.max(kFit, Math.min(kCover, w / boxW, h / boxH))` where boxW/boxH are the content box size,
     with a 10 px stage margin taken into account (use `(w - 20) / boxW`, `(h - 20) / boxH`).
   - Offsets: start centred (`ox = (w - iw)/2`, `oy = (h - ih)/2`), then on each axis where the room is
     larger than the stage, clamp so the room still covers the stage (`ox <= 0`, `ox >= w - iw`) and,
     within that, shift so the content box stays inside with the 10 px margin. Where the room is smaller
     than the stage on an axis, keep it centred.
   - Update the comments there and the CSS comment above `#stage` to describe the new behaviour.
   Commit.
2. No dark band when the room cannot cover (ultra-wide): add a `<div id="roomfill" aria-hidden="true">`
   as the first child of `#stage`, styled `position:absolute; inset:0; background:url(/assets/workshop.png) center/cover no-repeat;
   filter: blur(14px) brightness(.55) saturate(1.1); transform: scale(1.08); pointer-events:none;` so any
   leftover area shows a blurred, dimmed copy of the room, never a flat dark band. Hide it in the narrow
   layout (`body.narrow #roomfill { display:none }`). Commit.
3. Update `checks/officefit.check.mjs`: replace the `room fully visible` check with
   `room covers the stage` (room rect contains the stage rect, 1 px tolerance) for every size in its
   `sizes` list except 2560x1440 (16:9 ultra-large may still cover; if it does not, assert instead that
   `#roomfill` is visible there). Keep every other check. Update the header comment ("whole room always
   visible") to match. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing. Run each check in the foreground with a timeout (for example `timeout 600 node checks/x.check.mjs`); never sleep-poll a background job (`sleep N; cat log`), because every idle turn replays the whole context. Do not repeat the full suite for every step. The runner runs the CHECK lines once when you finish and sends failures back for fixes.
CHECK: node checks/officefit.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/glanceoffice.check.mjs
Constraints: no em dashes anywhere. Only touch runner/office.html and checks/officefit.check.mjs. If an existing check in office.check.mjs or glanceoffice.check.mjs fails because the room no longer letterboxes, report it in the final reply instead of editing those files.

Final reply: the steps with their commit hashes, and anything skipped.
