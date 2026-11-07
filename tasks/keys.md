KIND: code
You are working in a git repo (current directory). Goal: wrong keys are caught at once and explained in plain words. A lane whose AK/SK or MaaS key is rejected ends in seconds with exit 3 and a message that names the key and the fix, `ca auth` checks a MaaS key before saving it, and `ca doctor` prints readable rows. Files: new `runner/authsignal.mjs`, `runner/ca.mjs`, `runner/auth.mjs`, `checks/auth.check.mjs`. Node 22 ESM, no dependencies. Read `checks/authfast.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Facts measured on real lanes (use them, do not rediscover them):
- Wrong AK/SK: the codearts server log (`tasks/<task>.lane/server.log`) gets, right at start, `ERROR ... service=auth "调用错误：503{}"` and `service=auth "getUserInfo 返回空值..."`; every model call then fails with `Backend service unavailable (HTTP 503, url: snap-access.ap-southeast-1.myhuaweicloud.com)`. Today the lane retries for 70 s and ends "failed (gave up after 3 interruptions)", exit 1. With correct keys the server log has no `service=auth` ERROR line.
- Wrong MaaS key on a `maas/` model: session error `APIError: Invalid authorization header.`; the runner already ends with "failed (auth)", exit 3, but the summary never says which key or what to do.

1. New `runner/authsignal.mjs`: `export function authProblem({ model, error, serverLog })` returns `null` or `{ key: 'aksk'|'maas', message }`. aksk when serverLog has an ERROR line with `service=auth` (with or without a session error); message: `CodeArts could not sign in with your AK/SK (wrong or disabled keys, or Huawei IAM is down). Run ca auth --force to enter them again.` maas when model starts with `maas/` and error matches invalid authorization / 401 / 403 / unauthorized; message: `The ModelArts MaaS API key was rejected. Run ca auth --force to enter it again (or remove it to use the CodeArts quota models).` Everything else (plain 503 with a clean log, timeouts) returns null. Commit.
2. `runner/ca.mjs`: import it. Where a session error is classified (the function near the `'auth'` classification, around `if (/Authentication failed|MISSING_CREDENTIAL|...` and `if (cls === 'auth') return { ok: false, ... exit: 3 ...}`), read the lane's server.log (last 200 KB at most) and call `authProblem({ model: <current build or review model>, error: <error text>, serverLog })`. A non-null result ends the phase at once with reason `auth`, exit 3, no retries and no backoff; its message goes to live.log (one `! ` line), to the summary (a line `keys: <message>`) and to the CA_RESULT `error` field. Also check once right after the codearts server is up (wait up to 3 s for the log) so a bad AK/SK ends before the first prompt. Keep every other classification unchanged. Commit.
3. `runner/auth.mjs`: before saving a `MAAS_API_KEY` (in `--stdin` and in the form's save handler), verify it: `GET <MAAS_BASE_URL or https://api-ap-southeast-1.modelarts-maas.com/openai/v1>/models` with `Authorization: Bearer <key>`, timeout 8 s. 200: save, and print/return `MAAS_API_KEY verified`. 401/403: do not save that key (other keys in the same request are still saved), exit 1 for `--stdin`, form JSON `{ok:false, error:'MaaS API key rejected by ModelArts MaaS (HTTP 401)'}` shown in the form message. Network error or other status: save and warn `could not verify the MaaS API key (<reason>); saved anyway`. Never print the key. Commit.
4. `runner/auth.mjs` form page: under the MaaS field add a short line `Create one in the ModelArts Studio (MaaS) console under API Key Management (Singapore region).` with a link to `https://support.huaweicloud.com/intl/en-us/usermanual-maas-modelarts/maas-modelarts-0073.html` (target _blank, rel noopener). When the form gets `{ok:false}` show the error in the message line in the error colour and keep the inputs. Commit.
5. `checks/auth.check.mjs`: its `--stdin` test saves a fake MaaS key, which now gets verified against the real endpoint; give its env a `MAAS_BASE_URL` of a tiny local http server started in the check that answers 200 to `Bearer mk-333` (or set the URL to an unreachable `http://127.0.0.1:9/openai/v1` and accept the could-not-verify warning). Change nothing else in that file. Commit.
6. `ca doctor` text output in `runner/ca.mjs` (`cmdDoctor`): no padded table. One line per row: `  <status padded to 5>  <name>: <detail>`; for rows that are not ok, the fix on the next line as `         fix: <fix>`. Keep the final `doctor: ready` / `doctor: not ready (N fail)` line and the `--json` output exactly as today. Commit.
7. Test hook / check: `node checks/authfast.check.mjs` prints ALL PASS; `node checks/auth.check.mjs` and `node checks/cli.check.mjs` still pass. Commit if anything changed.
8. Self check: re-read your changes against this brief; make sure a real outage (plain 503, clean server log) still retries with backoff as before, the key value is never printed or logged, and the summary line appears once. Run every CHECK line. Commit if changed.

Safety rules (hard):
- Never run `ca auth` or `ca lane` by hand against the real credentials file or real keys; only run the CHECK commands below (they use temp files and a fake MaaS endpoint).
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every one of them itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node --check runner/auth.mjs
CHECK: node checks/authfast.check.mjs
CHECK: node checks/auth.check.mjs
CHECK: node checks/cli.check.mjs
CHECK: node checks/think.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/authsignal.mjs`, `runner/ca.mjs`, `runner/auth.mjs`, `checks/auth.check.mjs`. Do not edit `runner/onboard.mjs`, `runner/setup.mjs`, `runner/dash.html`, `docs/` or other checks.

Final reply: the steps with their commit hashes, and anything skipped.
