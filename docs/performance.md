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

For lead responsiveness, test event-to-alert latency independently using the scripted fake server.
A model's response time is different from the runner's time to make its question visible through
`ca wait`, status and the dashboards. The lead must keep waiting with step events enabled and act
on `CA_BLOCKED`; visibility does not itself answer the worker.
