KIND: code
You are working in a git repo (current directory). Goal: CodeArts lanes run on Linux and macOS as well as Windows, the contract checks run anywhere Chrome is (and skip cleanly where it is not), and GitHub Actions runs the whole suite on Ubuntu, macOS and Windows with failures shown as annotations. Files: `scripts/trust.mjs`, `runner/ca.mjs` (only the lines named below), new `checks/lib/chrome.mjs`, `checks/lanes.check.mjs`, `checks/office.check.mjs`, new `tools/run-checks.mjs`, `package.json`, new `.github/workflows/check.yml`, `README.md` (one line). Node 22 ESM, no dependencies. Read `checks/portable.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Facts: `scripts/trust.mjs` builds its default path from `process.env.USERPROFILE`, which does not exist on Linux or macOS, so every `ca lane` there crashes at the trust step. The CodeArts CLI installs to `~/.codeartsdoer/installers/bin/codearts` on Linux and macOS (`codearts.exe` on Windows). GitHub runners: ubuntu-latest has `/usr/bin/google-chrome`; macos-latest has `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; windows-latest has `C:\Program Files\Google\Chrome\Application\chrome.exe`. None of them has CodeArts or keys: the checks use fakes and must not need either.

1. `scripts/trust.mjs`: default settings path `path.join(os.homedir(), '.codeartsdoer', 'cli-data', 'settings.json')` (CA_SETTINGS still wins). Search `runner/` and `scripts/` for any other `process.env.USERPROFILE` or `process.env.HOME` and replace it with `os.homedir()`. Commit.
2. `runner/ca.mjs` Open TUI (the `attach` dashboard route, the `spawn('cmd.exe', ...)` line): only on win32 (put `process.platform === 'win32'` on that same line, for example `if (process.platform === 'win32') spawn('cmd.exe', ...)`); on other platforms answer 501 `{error: 'Open TUI needs Windows; run ca attach <lane> in a terminal'}`. Make sure the EXE constant in `runner/ca.mjs` uses `codearts.exe` only on win32 and `codearts` elsewhere, with `win32` on that same line. Touch nothing else in `runner/ca.mjs`. Commit.
3. New `checks/lib/chrome.mjs`: `export function findChrome()` returns `CHROME_PATH` when that file exists, else the first existing of: Windows Program Files and LocalAppData Chrome, macOS `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`; else null. Also `export function chromeProfileDir(name)`: a fresh dir under `fs.realpathSync.native(os.tmpdir())` (long-form path: Chrome exits silently with an 8.3 short `--user-data-dir`). Linux CI needs `--no-sandbox` and `--disable-dev-shm-usage`: add `export const chromeFlags = [...]` with those two on Linux only. Commit.
4. `checks/lanes.check.mjs` and `checks/office.check.mjs`: use `findChrome()`, `chromeProfileDir()` and `chromeFlags` instead of the hardcoded `C:/Program Files/...chrome.exe` and temp profile path; when `findChrome()` is null print `SKIP <name>: no Chrome found (set CHROME_PATH)` and exit 0. Change nothing else in them. Commit.
5. New `tools/run-checks.mjs` and `package.json` `"check": "node tools/run-checks.mjs"`: run every `checks/*.check.mjs` in name order with node (cwd = repo root, inherit env), print `== <file>` before each and its output; under `GITHUB_ACTIONS=true` print `::error title=<file>::<line>` for every line that starts with `FAIL` and for a check that exits non-zero without a FAIL line. Finish with `checks: N passed, M failed (<names>)` and exit 1 when any failed. Optional args filter by name substring (`npm run check -- scope`). Commit.
6. New `.github/workflows/check.yml`: on push and pull_request; job `check` with `strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, macos-latest, windows-latest] } }`, `runs-on: ${{ matrix.os }}`, steps `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 22`, git identity (`git config --global user.email ci@example.com` and `user.name ci`), then `npm run check`. Set `CA_DASH: '0'` in the job env. Commit.
7. Make the remaining checks portable where they assume Windows: search `checks/*.check.mjs` for `powershell`, `cmd.exe`, `.exe'`, backslash-only paths and `process.env.USERPROFILE`; where a check builds an exe name use `process.platform === 'win32' ? 'codearts.exe' : 'codearts'`; where a check only makes sense on Windows (for example DPAPI or registry), skip that assertion off Windows with a PASS line saying `(skipped: not Windows)`. Do not change what any check asserts on Windows. Add one line under the README intro: `Runs on Windows, macOS and Linux (Node 20+, git).` Commit.
8. Self check: re-read against this brief; run every CHECK line; also run `node tools/run-checks.mjs portable` and `GITHUB_ACTIONS=true node tools/run-checks.mjs portable` and look at the output format. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below (they drive headless Chrome themselves).
- Never run `ca lane`, `ca setup`, `ca onboard` or `ca auth` by hand; only the checks.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node checks/portable.check.mjs
CHECK: node --check runner/ca.mjs
CHECK: node checks/lanes.check.mjs
CHECK: node checks/office.check.mjs
CHECK: node checks/onboard.check.mjs
CHECK: node checks/runnerwave.check.mjs
Constraints: no em dashes anywhere. Only touch the files named in the goal (plus small portability fixes inside `checks/*.check.mjs` in step 7). Do not edit `runner/auth.mjs`, `runner/onboard.mjs`, `runner/setup.mjs`, `runner/mcp.mjs`, `checks/portable.check.mjs` or the other new contract checks (lifecycle, netwait, vault).

Final reply: the steps with their commit hashes, and anything skipped.
