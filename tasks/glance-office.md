You are working in a git repo (current directory). Goal: the Office view (`runner/office.html`) shows, at a glance
from across a room, whether the focused plan is working, done, failed, needs the human or has gone quiet, while
keeping the Pixel Workshop look (warm oak, dusk windows, violet shadows, pixel art, crisp HTML text).
Read `tasks/glance-contract.txt` first: the server adds `plan.glance` with exactly that shape (another lane builds
the server side; do not edit `runner/ca.mjs`). If `plan.glance` is missing, hide everything below.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number). Do not ask questions; decide and keep going.

1. Status sign and room light: add a hanging pixel signboard at the top centre of the stage (a DOM element
   `#glanceSign` with `data-state`), framed like a dark wooden board with a 2-3 px pixel border, showing the glyph
   and the word large (about 44 px at a 1280 px wide stage, scaling with the stage, never under 22 px) in the
   state color as a soft LED glow, and the detail line below in small text. For working, add a thin bar under the
   word with done/total lanes. Keep it clear of the stations and their labels (it hangs over the back wall) and
   `pointer-events: none`; at narrow widths it becomes a full-width strip above the stage. Add `#glanceGlow`, a
   pointer-events-none overlay on the stage edges (inset glow 40-80 px in the state color): faint for working,
   steady green for done, a slow 2.4 s breathing pulse for needs-you and failed, dim and still for quiet, none for
   idle. Use `role="status"` and `aria-live="polite"` on the sign so changes are announced once. Commit.
2. Lead bubble, tab and done cue: a pixel speech bubble above the lead's station with the glyph ("?" for
   needs-you and quiet, the x for failed, the check for done, none otherwise). Set `document.title` and a canvas
   favicon from the glance as in the contract (restore the plain title when idle). When the glance changes to done
   from another state during this page's life (never on first load or plan switch), play a short (about 1 s) pixel
   sparkle around the sign. Reduced motion and the Motion toggle off: no pulse and no sparkle, colors and text stay.
   Commit.
3. Demo and check: give the demo fixture plans a `glance` (`?demo=1` working with the live running counts,
   `?demo=done` done) and add `?demo=needs`, `?demo=failed` and `?demo=quiet` (reuse the default fixture with a
   fixed glance; needs uses phase asking with detail "Claude is asking: merge the three lanes now?"). Expose
   `window.__office.glance()` returning `{state, word, detail, title, favicon}`. Add `checks/glanceoffice.check.mjs`
   (copy the harness pattern of `checks/office.check.mjs`: free port, `ca dash`, headless Chrome over CDP) that
   loads `/office?demo=` 1, done, needs, failed and quiet, asserts the sign's data-state and word, the title prefix,
   a data: favicon, that the sign does not overlap any station button rect, and saves `glance-<state>.png` plus a
   390 px wide phone shot of needs into the out dir. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node checks/glanceoffice.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/assets.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office.html`, `runner/assets/workshop.css` (only if needed)
and `checks/glanceoffice.check.mjs`.

Final reply: the steps with their commit hashes, and anything skipped.