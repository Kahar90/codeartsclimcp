KIND: code
You are working in a git repo (current directory). Goal: lanes survive a network drop, a laptop sleep and a crowded model. A network error waits for the network to come back instead of using up retries, a long gap between watchdog ticks is treated as a sleep (not a stall), and a lane waits for a free slot when too many lanes already use its model. Files: new `runner/netwait.mjs` and the lane supervisor in `runner/ca.mjs` (plus its help text). Node 22 ESM, no dependencies. Read `checks/netwait.check.mjs` first: it is the contract and must print ALL PASS (do not edit it).
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"` (N = the step number; the dashboard tracks
progress from it). Do not ask questions; decide and keep going.

Facts: the supervisor in `runner/ca.mjs` classifies session errors (search for `'auth'` near `Authentication failed|MISSING_CREDENTIAL`, and the transport backoff of 2, 4, 6 minutes), runs a watchdog tick every few seconds (search `STALL_S`, `THINK_S`) and reads the build model from the brief (`BUILD`, `buildModel`). Lanes register in the registry dir `REG` with a `state.json` per lane (`lanes()` lists them; a running lane has no `result`). MaaS answered `rate limit 1000000 tokens per minute` with 3 GLM lanes running.

1. New `runner/netwait.mjs`: `isNetworkError(text)` true for ENOTFOUND, EAI_AGAIN, ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH, `fetch failed`, `socket hang up`, `network socket disconnected`, `Cannot connect to the model service`; false for everything else (auth, rate limits, infer timeouts, HTTP 5xx, aborts). Commit.
2. `waitOnline({ probe, intervalMs = 15000, timeoutMs, onWait })`: calls `probe()` until it resolves true (a throw counts as false), calling `onWait({ tries, waitedMs })` after each failed try; resolves `{ online, tries, waitedMs }`, never rejects. Default probe: `dns.promises.lookup` of the model host (MaaS host from MAAS_BASE_URL, default `api-ap-southeast-1.modelarts-maas.com`) followed by a HEAD request with a 5 s timeout; any HTTP answer counts as online. `detectSleep(prevTickMs, nowTickMs, intervalMs)`: true when the gap is greater than `Math.max(120000, 4 * intervalMs)`. Commit.
3. `parseLimits(spec)` from a string like `maas/glm-5.3=2,default=4` returns `{ limitFor(model) }`: default 3 for any model whose id contains `glm` (case-insensitive), 4 for others; `default=N` changes the non-matching default; `0` or `off` means Infinity. `laneSlots({ model, running, limits })` returns `{ ok: true }` or `{ ok: false, reason: '<n> lanes already use <model> (limit <n>)' }`. Commit.
4. Wire network waits into `runner/ca.mjs`: where a session error is classified, if `isNetworkError(text)` (and it is not an auth problem), set the lane activity to `offline: waiting for the network (<waited>)`, log `! network down, waiting (try N)` to live.log at most once a minute, `await waitOnline({ timeoutMs: NET_WAIT_S*1000, onWait })` (env `NET_WAIT_S`, default 1800), then resume the same session WITHOUT counting the interruption against MAX_RETRIES. If it stays offline past NET_WAIT_S, end the phase as today's transport failure. Commit.
5. Sleep: in the watchdog tick, keep the previous tick time; when `detectSleep` is true, log `! woke from sleep after <gap>`, reset the stall, tool and thinking timers (the silence was the sleep, not the model), restart the SSE event stream if the server still answers, and if the codearts server died during the sleep restart it the way a crash is handled today. Commit.
6. Model slots: before the build session starts (and before a fresh session after a fallback model switch), compute the models of the other running lanes from the registry (`lanes()` without a result, excluding this lane; their current build model from state) and call `laneSlots` with `parseLimits(process.env.CA_MAX_LANES_PER_MODEL || '')`. While not ok: activity `queued: <reason>`, a `queued` line in live.log once, check again every 20 s; `ca stop` must still work while queued. Record the waited time in state (`queuedMs`) and show it in the summary interruptions line when non-zero. Add `NET_WAIT_S` and `CA_MAX_LANES_PER_MODEL` to the help text env knobs. Commit.
7. Test hook / check: `node checks/netwait.check.mjs` prints ALL PASS; `node checks/think.check.mjs`, `node checks/resume.check.mjs`, `node checks/controls.check.mjs` and `node checks/authfast.check.mjs` still pass. Commit if anything changed.
8. Self check: re-read against this brief; a real outage of the model service (HTTP 503 with the network up) must still back off 2, 4, 6 minutes as before; auth problems must still end at once with exit 3; a lane waiting for the network or a slot must show it in `ca status` (activity) and never look STALLED. Run every CHECK line. Commit if changed.

Safety rules (hard):
- Never run `ca lane`, `ca stop` or `ca dash` by hand against the real registry; only the checks below.
- Never disable network adapters, change firewall rules, or put the machine to sleep.
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run these before each commit. The runner also runs every check line below by itself when you finish and sends you the output if one fails.
CHECK: node --check runner/ca.mjs
CHECK: node checks/netwait.check.mjs
CHECK: node checks/think.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/controls.check.mjs
CHECK: node checks/authfast.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/netwait.mjs` and the lane supervisor plus help text in `runner/ca.mjs`. Do not edit the dashboard server in `runner/ca.mjs`, the doctor, the command dispatch table, `runner/auth.mjs`, `runner/onboard.mjs`, `runner/setup.mjs` or any check.

Final reply: the steps with their commit hashes, and anything skipped.
