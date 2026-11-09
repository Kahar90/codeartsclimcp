You are working in a git repo (current directory): codearts-lanes, a Node lane runner (`runner/ca.mjs`, no deps).
Goal: make lanes finish sooner without losing review quality. (a) Review each step commit while the builder keeps
working, and send real findings to the builder as a steer. (b) Start the final review right after the git clean gate,
so it runs while the CHECK lines run. The contract is `checks/stepreview.check.mjs` (already committed). Read it
first, along with the fake server it drives (`checks/lib/fake-codearts.cjs`). Both are fixed: never edit either one.
Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"`. Do not ask questions; decide and keep going. Follow this brief
directly; do not write another plan or restate the requirements. Use grep to find code; do not read the whole of
runner/ca.mjs (2700 lines). Read only `runLane` (about lines 344 to 1110).

1. Step review switch and template. Add `templates/step-review.md`: a short read-only prompt with placeholders
   {TASK}, {STEPS} (e.g. "step 1, step 2"), {RANGE} (`<from>..<to>`) and {SUBJECTS} (the commit subject lines).
   It must say: spec is `tasks/{TASK}.md`, read only the numbered items for {STEPS}. Review only
   `git show`/`git diff {RANGE}`; later steps are still being built, so do not flag them as missing. List only real
   bugs with file:line, at most 6 lines. Files under tasks/ belong to the runner. End with a line that is exactly
   "STEP VERDICT: ok" or "STEP VERDICT: fix". In runLane, step reviews are on by default and off when env
   STEP_REVIEW=0, when the brief has a line `STEP_REVIEW: off`, or when NO_REVIEW=1. Parse that brief line the way
   MODEL:/REVIEW_MODEL: lines are parsed. Commit.
2. Run step reviews beside the builder. When syncCommits (the 5 s tick in waitTurn) finds new commits whose subject
   starts with `step N:` and no step review is running, start one in a NEW session titled `<task> step review N`:
   REVIEW model, agent `plan`, prompt from the template. Its range runs from the last reviewed commit (START at
   first) to the newest commit, so commits that land during a review get coalesced into the next one. Do NOT use
   drive(), send() or waitTurn() for it. They set S.activeSession, S.busy and the watchdog timers of the builder.
   Write a small independent poller instead: POST prompt_async with {model: splitModel(REVIEW), agent: 'plan',
   parts}, then poll GET /session/status every 3 s until the session has been busy and is idle again (or 60 s pass
   with no busy). Use a timeout of STEP_REVIEW_TIMEOUT seconds (default 600): on expiry, POST /abort and record
   verdict 'timeout'. Read the last assistant text from GET /session/:id/message. Any error records 'error' and
   never fails or retries the lane: the final review still covers everything. Make roleOf() bill these sessions
   as 'review' (keep a Set of review session ids). Record each one in S.stepReviews (initialise to []):
   {steps:[N...], hash (short hash of the newest commit), from, at, ms, verdict ok|fix|missing|timeout|error,
   text (trimmed, at most 1500 chars)}. Commit.
3. Findings reach the builder. On verdict 'fix', write an inbox file named `<now>-stepreview.txt`. Its text starts
   with "Reviewer on step N (commit <hash>):", then the findings, then "Fix the real bugs in a commit
   \"fix: step N review\" and keep going with the brief; ignore a finding that contradicts the brief or the lead's
   steering." In pumpInbox, a file whose name contains `stepreview` is logged in S.steers with by: 'step review'
   (other files stay 'ca steer'). When the builder goes idle, before the gates, wait for a running step review
   (bounded by its timeout). Then pumpInbox: if it sent anything, continue the build loop as it does today for a
   late steer. Step-review continues must not count as fix rounds, but cap them at MAX_FIXES so a lane cannot
   loop. Commit.
4. Overlap the final review with the checks. Split gates() so the git clean part (including the commit fallback)
   runs first. Once it passes and the review is on, start the final review session at once: same template, model
   and agent as today, plus a short appended block "Step reviews already done:" with one line per S.stepReviews
   entry (steps, verdict, first finding line). Then run the CHECK lines while it reviews. Set S.reviewStartedAt
   when its prompt is sent. The final review may use drive(), because no builder turn runs during the gates. Keep
   phase 'gate' while checks run, then phase('review') while you wait for the review to end. If a CHECK fails or
   cannot run, abort the review session (POST /session/:id/abort), wait for its promise to settle, discard it
   (no verdict), and go on with the fix round as today. The next passing gate starts a fresh final review. Keep
   every existing outcome the same: verdict parsing, 'unverified' when a check cannot run (the review still runs
   then, as today), the reviewer-committed warning, review.md. Commit.
5. Summary and dashboard. Add a summary line after the gates line:
   `step reviews: <count> (ok <n>, fix <n>, other <n>)` (or `step reviews: off`). In `runner/dash.html`, the lane
   view's review tab lists the step reviews above the final review text: one row each with the steps, verdict and
   duration, and the text in a <details>. Keep it small; reuse the existing classes. Run the CHECK lines and fix
   what they find. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the checks below.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run the targeted check for the step in the foreground with a timeout (for example `timeout 600 node checks/stepreview.check.mjs`); never sleep-poll a background job. Do not run the full list on every step: the runner runs every line below once when you finish.
CHECK: node --check runner/ca.mjs
CHECK: node checks/stepreview.check.mjs
CHECK: node checks/ratelimit.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/think.check.mjs
CHECK: node checks/time.check.mjs
CHECK: node checks/lanes.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs, runner/dash.html and templates/step-review.md. Do not
edit checks/, README.md, docs/ or CHANGELOG.md (the lead does docs).

Final reply: the steps with their commit hashes, and anything skipped.
