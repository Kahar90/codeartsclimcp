KIND: code
You are working in a git repo (current directory). Goal: the dashboard's first-run panel (shown at http://127.0.0.1:4777/ while there are no plans and no lanes, `renderOnboard()` in `runner/dash.html`) becomes a clear "get started" page for a human who just installed CodeArts lanes: one prompt to paste into their coding agent, how to ask for work afterwards, a keys button, readable doctor rows, no overflow. Files: `runner/dash.html`, a small route in `runner/ca.mjs`, `checks/lanes.check.mjs`. Node 22 ESM, plain HTML/CSS/JS, no dependencies. Read `renderOnboard()` and the empty-registry block near the end of `checks/lanes.check.mjs` first.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Bugs seen on screenshots today: each doctor row shows the name and status glued together ("nodeok", "credentialsok": the status chip has no gap and no badge look), at 390 px the panel text and boxes run off the right edge, and at 1280x900 the left sidebar shows a horizontal scrollbar.

1. Doctor rows: name, then a real status chip with a gap (reuse the existing badge styles or add `.onb-chip` with padding, radius and the ok/warn/fail colours), detail below, fix below in a monospace block with a Copy button when the fix contains a command. Above the rows a one-line summary: `Ready: everything checks out` (ok colour) or `N to fix` (bad colour) plus `M optional` for warn rows. Commit.
2. Layout: no element inside `#onboard` may be wider than the viewport at 390 px (long paths and commands wrap: `overflow-wrap:anywhere` on details and code, `min-width:0` on flex children, the two-column grid becomes one column under 720 px). The sidebar must not scroll horizontally at 1280x900 (find the wide element and fix it). Commit.
3. New first box "Set up in one prompt": text `Paste this into your coding agent (Claude Code, Kiro, Cursor, Codex, opencode or VS Code). It installs and connects everything; you only paste your Huawei Cloud keys into a local form.` and a copy box with exactly `Set up CodeArts lanes by following https://raw.githubusercontent.com/Kahar90/codeartsclimcp/main/INSTALL.md`. Commit.
4. Second box "Then ask for work, in any repo": a small table, harness to what to type: Claude Code `/codearts-build <goal>`; Kiro `#codearts-lanes <goal>`; Cursor, Codex, opencode, VS Code `Use CodeArts lanes to <goal>`. One line under it: `Restart your agent once after setup so it loads the CodeArts tools.` Commit.
5. Keys button: when the credentials row is not ok, show a `Connect keys` button in that row. In `runner/ca.mjs` add a dashboard route `POST /api/auth` (next to the other POST routes of `ca dash`, same style and same localhost guard) that runs `node <ca.mjs> auth --no-open --json` as a child process (timeout 20 s) and returns its JSON (`{ready, url}`); never put key values in it. The button calls it and opens the returned url in a new tab (`window.open`), then shows `Waiting for the keys...` and refreshes the doctor rows every 5 s (bypass the 30 s doctor cache while waiting) until the credentials row is ok. A route handler must never call die() or exit the process. Commit.
6. Manual setup box: replace the `ca setup <harness> .` list with a harness picker (6 chips: claude, kiro, cursor, codex, opencode, vscode; default claude) and one copy box showing `ca onboard --yes --harness <picked> --smoke`, with the line `Run once per machine; every repo works after that.` Move "Your first lane" (the 4 CLI steps) into a closed `<details>` titled `Run a lane by hand`. Update the intro paragraph: one-time setup per machine, list all six harnesses. Commit.
7. Test hook and check: `window.__lanes.onboard()` returns `{ shown, ready, fails, warns, prompt, harness, cmd, rows: [{name, status}] }` (prompt = the setup prompt text, cmd = the manual command). In `checks/lanes.check.mjs`, in the existing empty-registry block, add checks: the hook works and `prompt` contains `INSTALL.md`; clicking the `codex` chip changes `cmd` to contain `--harness codex`; every doctor row name element and its chip do not overlap and have at least 4 px between them (getBoundingClientRect); at 390x844 no element in `#onboard` has `right > document.documentElement.clientWidth + 1`; at 1280x900 the sidebar's `scrollWidth <= clientWidth`; `POST /api/auth` exists (answer is JSON, status 200, or 4xx with JSON, never a connection reset; run it against the check's own dash with a temp `CA_CREDENTIALS` file in its env so no real keys are touched, and add `CA_CREDENTIALS_ONLY: '1'`). Commit.
8. Self check: re-read against this brief, keep the existing onboard checks passing (`#onboard`, `ca onboard`, `/api/doctor` must stay in the HTML), no page errors, light and dark themes both readable. Run every CHECK line. Commit if changed.

Safety rules (hard):
- Never run `ca auth`, `ca setup` or `ca onboard` by hand; only the checks below (they use temp dirs).
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below (they drive headless Chrome themselves).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every one of them itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/onboard.check.mjs
CHECK: node checks/overview.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/dash.html`, `runner/ca.mjs` (the one route), `checks/lanes.check.mjs`. Do not edit `runner/onboard.mjs`, `runner/setup.mjs`, `runner/auth.mjs`, `runner/office.html` or other checks. Add `[hidden]{display:none!important}` if you use the hidden attribute on flex elements.

Final reply: the steps with their commit hashes, and anything skipped.
