You are working in a git repo (current directory). Goal: the Lanes view (`runner/dash.html`) shows, at a glance,
whether the work is working, done, failed, needs the human or has gone quiet, in its current plum Pixel Workshop
style. Read `tasks/glance-contract.txt` first: the server adds `plan.glance` with exactly that shape (another lane
builds the server side; do not edit `runner/ca.mjs`). If `plan.glance` is missing, hide everything below.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.

1. Glance banner: on the plan homescreen, a full-width banner `#glanceBanner` (with `data-state`) above the plan
   title: a 6 px left stripe and soft background tint in the state color, the glyph and word large (about 28 px,
   bold), the detail line beside it, and for working a thin done/total lanes bar. needs-you and failed breathe
   slowly (2.4 s) unless reduced motion. On the Control room, the same banner shows the worst glance over open
   plans (contract priority) with the plan title and a link to that plan. In the plans rail, put a small dot in the
   glance color before each plan name. Use `role="status"` and `aria-live="polite"`. Commit.
2. Tab, favicon, notification: set `document.title` and a canvas favicon from the shown glance as in the contract
   (on the Control room from the worst open plan), keeping the needs-you lane count in the title when it is above
   zero, e.g. "! Needs you (2) - <plan title>". When Notify is on, also send one browser notification when a
   plan's glance changes to done, needs-you or failed during this page's life (never on first load), tagged by
   plan id and state. Commit.
3. Demo and check: give the `?demo=1` fixture plans a `glance` (office-polish working, string-utils needs-you
   with detail "Claude is asking: keep the stuck lane or drop it?"), and add `?demo=1&glance=<state>` to force the
   first plan's glance to done, failed or quiet. Expose `window.__lanes.glance()` returning
   `{state, word, detail, title, favicon}`. Add `checks/glancelanes.check.mjs` (copy the harness pattern of
   `checks/lanes.check.mjs`) asserting the banner on the Control room shows needs-you, the plan homescreen shows
   working, each `glance=` override, the title prefix, a data: favicon, and that a forced change from working to
   done fires one notification (stub `window.Notification` in the page before toggling Notify). Save
   `glance-lanes-<state>.png` screenshots in the out dir. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node checks/glancelanes.check.mjs
CHECK: node checks/lanes.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/dash.html` and `checks/glancelanes.check.mjs`.

Final reply: the steps with their commit hashes, and anything skipped.