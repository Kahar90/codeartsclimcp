# Delivery benchmark record

All rows use the unchanged four-step notes API fixture, three parallel runs, the flash builder,
GLM 5.3 independent final reviewer, final CHECK gates, and a separate API contract rerun. Times include
review repairs and follow-up lanes. No candidate below meets the requested 50% delivery target.

| Cohort | Seconds per run | Passing | Median seconds |
|---|---|---|---|
| Baseline, installed 0.7.1 | 321.359, 410.994, 546.483 | 3/3 | 410.994 |
| Candidate `c498fdf` | 546.214, 547.428, 730.971 | 3/3 | 547.428 |
| Candidate `a522b23`, `CA_TOOL_PROFILE=core` | 504.005, 519.726, 668.760 | 3/3 | 519.726 |
| Candidate `6561c7b`, `CA_TOOL_PROFILE=core` | 454.425, 467.005, 509.143 | 3/3 | 467.005 |

The target is **205.497 seconds**. The earlier exploratory single run at `64b32cb` passed in
410.070 seconds and is not a matched cohort.

The `a522b23` build phases were 165.837, 214.159 and 268.148 seconds; review and repair remained
substantial. The provider reported its 1M-token-per-minute limit during concurrent builders and early
step reviews. The raw timings retain those delays. This observation motivates testing foreground
quota priority; it does not establish that throttling alone explains the result.

The `6561c7b` cohort includes scoped reviewer instructions, foreground quota priority, live reviewer
control handoff, warm repair-review sessions and the duplicate step-review fix. Its build phases were
131.221, 145.379 and 312.667 seconds. All three final reviews found real defects that required repair;
the complete delivery times retain those repairs. In run 2, `ca wait` surfaced a direct sandbox CHECK
as a blocker and the lead acknowledged it and kicked the turn with the outside-sandbox helper command.
That interruption is included. The median is still 13.6% slower than the baseline, so these results
do not establish the requested speed improvement.

A later `candidate-6561c7b-fast-core` experiment disabled thinking for the flash builder only
(`BUILD_MODEL=maas/deepseek-v4.1-flash-fast`), retaining the original GLM reviewer. The lead stopped
all three runs after each had exceeded the delivery target and required review repairs; none had a
final passing delivery. They are incomplete trials, not passing timings or a median. The trial also
exposed a quota-priority bug: the flash and flash-fast aliases were treated as different provider
models. Commit `197efc1` corrects that comparison and its regressions; the frozen experiment did not
contain that fix. No default model or reasoning setting was changed.

On this backend, a separate identical ACK request with the same flash model and plan agent used
23,189 input-plus-cache-read tokens with the full tool profile and 20,566 with the core profile.
That is a context-size observation from one pair, not an end-to-end speed claim.

Raw delivery results remain in ignored `bench/results.jsonl`; temporary repositories and logs are
outside the source repository. See [performance.md](performance.md) for the method and commands.
