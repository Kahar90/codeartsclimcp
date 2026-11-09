You are working in a git repo (current directory): codearts-lanes, a Node lane runner (`runner/ca.mjs`, no deps).
Goal: start the final review while the builder wraps up. Today it starts only after the builder goes idle, and the
builder spends 30 s to 2.6 min after its last step commit (final checks, a reply). The contract is
`checks/specreview.check.mjs` (committed; read its header comment first). It and `checks/lib/fake-codearts.cjs`
are fixed: never edit them. Do the steps in order. After each step that works, run `node --check runner/ca.mjs`,
then `git add -A && git commit -m "step N: <summary>"`. Do not ask questions; decide and keep going. Follow this
brief directly. Use grep; read only runLane (search `async function runLane`), especially runStepReview (an
independent review poller you can reuse), the final review code (search `Previous review findings` and
`reviewStartedAt`) and the build loop. Your shell runs in a sandbox with no local network: the fake-server checks
cannot run there, so do not run them and never try to unset SANDBOX_* variables. You can run CHECK lines with
`node tasks/specreview.lane/check.mjs <N>`, which runs them outside the sandbox and prints the real output.

1. Final review prompt builder. Factor the code that builds the final review prompt (template or
   tasks/<task>.review.md, step-review appendix, the "Previous review findings" block for fix rounds) into one
   function, so the normal and the speculative review send the exact same text. Commit.
2. Speculative start. In the builder's waitTurn tick (the 5 s syncCommits block, builder sessions only), when
   review is on, no review (speculative or normal) is running for the current round, every numbered brief step
   has a "step N:" commit (stepProgress), and dirty() is empty: start the final review in a new session with an
   independent poller like runStepReview, never drive()/send()/waitTurn(). Use the REVIEW model, plan agent, the
   prompt from step 1, and add the prompt to `sent`. Set S.specReview = {head: HEAD, at, used: false} and
   S.reviewStartedAt. Cancel an in-flight step review (the same way the idle grace cancels it). Store the
   promise. Commit.
3. Use or discard it. Where the final review starts today (after the git clean gate): if a speculative review
   exists for this round and HEAD === S.specReview.head, do not start another one. Await the speculative
   promise in place of the normal review promise (the CHECK lines still run while it reviews), set used: true,
   and take its text and verdict through the same code path (review.md, reviewRounds, verdict, fix rounds).
   Otherwise abort its session (POST /session/:id/abort), wait for it to settle, keep used: false, and start
   the normal final review as today. A failed CHECK aborts it the same way it aborts the normal review today.
   A review fix round starts fresh: the next round may speculate again once its fix is committed and the tree
   is clean (the fix round has no numbered steps, so only the normal path runs; that is fine). Commit.
4. Run every CHECK line through the helper, fix what fails, commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

CHECK: node --check runner/ca.mjs
CHECK: node checks/specreview.check.mjs
CHECK: node checks/reviewfix.check.mjs
CHECK: node checks/stepreview.check.mjs
CHECK: node checks/checkservice.check.mjs
CHECK: node checks/resume.check.mjs
Constraints: no em dashes anywhere. Only touch runner/ca.mjs. Do not edit checks/, docs/, README.md or CHANGELOG.md.

Final reply: the steps with their commit hashes, and anything skipped.
