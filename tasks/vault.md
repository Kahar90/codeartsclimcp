KIND: code
You are working in a git repo (current directory). Goal: keys at rest are encrypted on Windows. The credentials file written by `ca auth` holds DPAPI-encrypted values (CurrentUser scope) instead of plain keys, old plain files are migrated on first read, and an unreadable file is explained instead of silently reading as "not set". Other platforms keep a plain JSON file with mode 0600. File: `runner/auth.mjs` only. Node 22 ESM, no dependencies. Read `checks/vault.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Facts: `readCreds()` in `runner/auth.mjs` is imported by `runner/ca.mjs` (`userEnv`, once per key name, many times per process) and used by `ca auth`; `saveCreds()` writes the file. Values must never appear on a command line, in output or in logs. PowerShell DPAPI: encrypt with `ConvertFrom-SecureString (ConvertTo-SecureString $env:X -AsPlainText -Force)` (prints a hex blob); decrypt with `$s = ConvertTo-SecureString $env:Y; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`. One PowerShell start costs 0.3 to 1 s: batch all keys into one call and cache.

1. Format v2 on Windows: `{ "v": 2, "protection": "dpapi", "keys": { "<NAME>": "<hex blob>" } }`. Helpers `protect(map)` and `unprotect(map)`: one PowerShell call each for all keys, values passed in env vars named `CA_VAULT_0`, `CA_VAULT_1`, ... (never in the command text), results returned as JSON on stdout; `process.platform === 'win32'` on the same line as every `spawnSync('powershell', ...)`. Commit.
2. `saveCreds` on Windows writes v2 (merging with the current decrypted keys); elsewhere plain JSON as today with mode 0600. `readCreds()` returns plain `{ NAME: value }` in every case: v2 is decrypted (cached in memory keyed by the file mtime and size, so repeated calls cost nothing); a plain v1 file is returned as is and, on Windows, rewritten as v2 once (migration). Commit.
3. Errors: a v2 file that cannot be decrypted (other user, other machine, corrupt blob) or a file that is not valid JSON makes `readCreds()` return `{}` and sets an exported `credsProblem()` to a short reason; `ca auth --status` (text and `--json`, field `problem`) then says `the keys file could not be read (<reason>); run ca auth --force to enter the keys again`. Never throw from `readCreds`. Commit.
4. Make the other PowerShell call in this file (the user env lookup in `isSet`) carry `process.platform === 'win32'` on the same line too (it is already Windows-only by an early return; the portability check needs the guard on that line). Commit.
5. Speed: `ca auth --status` stays under 5 s on Windows (one PowerShell call at most). Verify with the check's timing line. Commit if you changed anything.
6. `ca auth --stdin` and the browser form keep working unchanged from the outside (the MaaS key verification stays as it is), and `--status` never prints values. Run `node checks/auth.check.mjs` and `node checks/authfast.check.mjs`. Commit if anything changed.
7. Test hook / check: `node checks/vault.check.mjs` prints ALL PASS. Commit if anything changed.
8. Self check: re-read against this brief; no value in argv, stdout, stderr or thrown messages; the cache is invalidated when the file changes; non-Windows behaviour unchanged. Run every CHECK line. Commit if changed.

Safety rules (hard):
- Never read, print, migrate or rewrite the real keys file (`~/.config/codearts-lanes/credentials.json`) or the real user environment; only the checks below (they use a temp CA_CREDENTIALS file and fake keys).
- Never run `ca auth` by hand without `CA_CREDENTIALS` pointing to a temp file.
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/auth.mjs
CHECK: node checks/vault.check.mjs
CHECK: node checks/auth.check.mjs
CHECK: node checks/authfast.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/auth.mjs`. Do not edit `runner/ca.mjs`, other runner files or any check.

Final reply: the steps with their commit hashes, and anything skipped.
