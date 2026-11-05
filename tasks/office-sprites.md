MODEL: maas/glm-5.3
You are working in a git repo (current directory). Goal: `runner/office-sprites.js`, a small library of hand-drawn SVG characters for an isometric "agent office" scene (dark floor, round glowing platforms, people at work, 3/4 view from above, soft 3D-cartoon look with gradients and shading). Plain browser script, no modules, no libraries. Another lane builds the page that uses it; you only build this file.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

1. API skeleton: the file sets `window.OfficeSprites = { roles: ['lead','builder','reviewer','fixer','idle'], draw(role, opts) }` and touches nothing else at load (no document, no DOM). `draw` returns one self-contained SVG string: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200" ...>`, character standing on the bottom center (feet near y=185) so the page can place it on a platform. `opts = {state:'working'|'idle', hue:0..360}`, both optional (defaults idle, 210). Unknown role: return the idle sprite. Deterministic: same input, same string. Commit.
2. Shared parts as small functions: head (skin tone, hair with the given hue shifted for variety, simple face: eyes, smile), torso with shirt in `hue`, arms, legs, shoes, soft ellipse floor shadow. Use linearGradient/radialGradient for a rounded 3D feel. Gradient ids must be unique per sprite: prefix every id with `os-<role>-<hue>-<state>-`. No external URLs, no `<script>`, no images. Commit.
3. `lead`: a person in a dark suit standing next to a black easel whiteboard showing a small flow chart (3 boxes and lines). working: the pointing arm moves slightly (CSS @keyframes inside an inline `<style>` with class names prefixed `os-`). Commit.
4. `builder`: a person sitting on an office chair at a small desk with a monitor (screen glows in `hue`), hands on the keyboard. working: arms tap (keyframes) and code lines on the screen flicker. `fixer`: same desk but the person holds a laptop and a small wrench icon floats above; working: the wrench rotates a little. Commit.
5. `reviewer`: a person in an armchair reading a laptop on their lap, glasses. working: a magnifier glyph above the laptop pulses. `idle`: an empty desk with a chair and a dark monitor (planned seat, nobody there yet). Commit.
6. State: with state idle no element animates (no @keyframes and no `<animate>` in the string); with working at least one does. Keep each SVG under 30000 characters. Commit.
7. Test hook / check: `checks/sprites.check.mjs` (already in the repo, do not edit it) loads the file in a bare vm and checks the contract. Also add `runner/office-sprites.preview.html`: a dark page that shows every role in both states in a grid with labels (for a human visual check), loading `office-sprites.js` with a relative script tag. Commit.
8. Self check: re-read the file against this brief, fix bugs (unbalanced tags, duplicate ids, NaN in coordinates), run the CHECK line until it says ALL PASS. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every CHECK: line itself when you
finish and sends you the output if one fails.
CHECK: node checks/sprites.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/office-sprites.js` and `runner/office-sprites.preview.html`. Do not edit `checks/`.

Final reply: the steps with their commit hashes, and anything skipped.
