You are working in a git repo (current directory): codearts-lanes, a Node lane runner (`runner/ca.mjs`, no deps).
Goal: when the final review says "VERDICT: needs fixes", fix it inside the same lane instead of ending the lane.
Send the findings to the builder session, which keeps its context, run the gates again, then run a focused
re-review of just the fix. The contract is `checks/reviewfix.check.mjs` (committed; read its header comment
first). It and `checks/lib/fake-codearts.cjs` are fixed: never edit them. Do the steps in order. After each step
that works, run `node --check runner/ca.mjs`, then `git add -A && git commit -m "step N: <summary>"`. Do not ask
questions; decide and keep going. Follow this brief directly; do not restate it. Use grep to find code; read only
runLane (search `async function runLane`), not the whole file. Your shell runs in a sandbox with no local network,
so the fake-server checks cannot run there: do not run them, and never try to unset SANDBOX_* variables. The runner
runs every CHECK line outside the sandbox when you end your turn, and sends you the real failures.

1. Setting. REVIEW_FIXES: env REVIEW_FIXES (default 1), overridden by a brief line `REVIEW_FIXES: N`. Parse it the
   way MODEL:/STEP_REVIEW: lines are parsed. 0 keeps today's behaviour exactly. Commit.
2. Wrap the build loop and the final review in an outer loop. Today, once the review has run (it may run while
   the CHECK lines run), a "needs fixes" verdict ends the lane. Instead, while the verdict is "needs fixes" and
   fewer than REVIEW_FIXES rounds have run: send the builder session (S.buildSession, buildModel) the message
   "The reviewer found these problems:\n<the review text>\nFix the real bugs (ignore a finding that contradicts
   the brief or the lead's steering), run the checks, and commit as \"fix: review findings\"." Then go through the
   same build loop (drive, step-review wait, inbox, gates with gate fix rounds) and review again. Review fix
   rounds must not count in S.fixes. Keep every existing exit path (stop, timeout, auth, infra/unverified, write
   failure): they end the outer loop as today. Commit.
3. Focused re-review. For round 2 and later, the review prompt is the normal review template plus a block:
   "Previous review findings:\n<previous review text>\nReview only the fix: git log --oneline <head of the
   previous review>..HEAD and git diff <head>..HEAD. Say whether each finding is fixed and whether the fix broke
   anything; same output format and VERDICT line." Record each final review in S.reviewRounds (initialise to []):
   {round, verdict, at, ms, from (the review range start), to (HEAD the review saw)}. The last verdict is S.verdict
   and review.md holds the last review text (also append the earlier ones under a "## Earlier review" heading).
   Commit.
4. Summary and resume. Add the summary line `review rounds: N (<v1> -> <v2> ...)` after the gates line, but only
   when at least one review ran. A resumed lane keeps reviewRounds the same way stepReviews is kept. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node --check runner/ca.mjs
CHECK: node checks/reviewfix.check.mjs
CHECK: node checks/stepreview.check.mjs
CHECK: node checks/ratelimit.check.mjs
CHECK: node checks/resume.check.mjs
CHECK: node checks/think.check.mjs
CHECK: node checks/time.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs. Do not edit checks/, docs/, README.md or CHANGELOG.md.

Final reply: the steps with their commit hashes, and anything skipped.
