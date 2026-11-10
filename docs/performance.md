# Measuring delivery speed

Measure the whole path to checked, reviewed code. A shorter build phase alone does not prove faster
delivery if it adds a review fix round or leaves work for the lead.

`node tools/bench.mjs --label baseline --runs 3 --ca <baseline runner/ca.mjs>` copies the fixed
four-step notes API fixture into temporary repositories. Each run includes the builder, checks,
independent review, review fixes and any follow-up lanes. It passes only when the final lane reports
`done`, its reviewer reports `ready`, and the API contract passes again outside the lane. Results
are stored in the ignored `bench/results.jsonl`; logs stay outside the source repository.

Repeat with the candidate runner and a different label. Keep the fixture, run count, models,
review settings and machine the same. Compare passing-run medians and report failures as well as
time. Do not present a deterministic check-execution speedup as an end-to-end model speedup.
Provider queueing, retries and token limits can affect model benchmarks; retain the phase timings
and avoid making a universal guarantee from a small sample.

The November 10, 2026 baseline on Windows, version 0.7.1, passed all three runs: 321.359,
410.994 and 546.483 seconds. Median: **410.994 seconds**. All runs used the default flash builder
and GLM 5.3 final reviewer. No checks or reviews were disabled.

The first combined candidate (`c498fdf`) also passed all three runs, at 546.214, 547.428 and 730.971 seconds. Its median was **547.428 seconds**, slower than the baseline. The earlier exploratory single run at `64b32cb` passed in 410.070 seconds. Neither result meets the 50% delivery target (205.497 seconds). Review and repair dominate the candidate timings; further changes must be measured using the same fixture and gates.

For lead responsiveness, test event-to-alert latency independently using the scripted fake server.
A model's response time is different from the runner's time to make its question visible through
`ca wait`, status and the dashboards. The lead must keep waiting with step events enabled and act
on `CA_BLOCKED`; visibility does not itself answer the worker.

## Using the delivery improvements

For independent CHECK lines, put `CHECK_PARALLEL: 4` in the lane brief. The runner defaults to
sequential execution because one check may depend on another. An explicit `CHECK_PARALLEL`
environment value overrides the brief; `0` forces sequential execution. Parallel results are
reported in CHECK order, and every executed result remains visible even when another line fails.

Use `node tasks/<task>.lane/check.mjs <N|all>` for worker checks. Successful helper results can
be reused within that lane when the command and tested source content are unchanged, including
across a commit. Failures, unreadable content, content mutations and dirty submodules do not qualify.
The final gate validates the content again before accepting reused results.

The initial builder prompt includes a bounded packet of explicitly named source files; the final
review receives prepared brief and diff context. Files omitted from either packet still need to be
read when relevant. The independent reviewer remains responsible for every requirement. A review
that outlives the speculative polling budget can continue in its existing session instead of
restarting on the same commit.
