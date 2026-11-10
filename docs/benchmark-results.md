# Delivery benchmark record

All rows use the unchanged four-step notes API fixture, three parallel runs, the flash builder,
GLM 5.3 independent final reviewer, final CHECK gates, and a separate API contract rerun. Times include
review repairs and follow-up lanes. No candidate below meets the requested 50% delivery target.

| Cohort | Seconds per run | Passing | Median seconds |
|---|---|---|---|
| Baseline, installed 0.7.1 | 321.359, 410.994, 546.483 | 3/3 | 410.994 |
| Candidate `c498fdf` | 546.214, 547.428, 730.971 | 3/3 | 547.428 |
| Candidate `a522b23`, `CA_TOOL_PROFILE=core` | 504.005, 519.726, 668.760 | 3/3 | 519.726 |

The target is **205.497 seconds**. The earlier exploratory single run at `64b32cb` passed in
410.070 seconds and is not a matched cohort.

The `a522b23` build phases were 165.837, 214.159 and 268.148 seconds; review and repair remained
substantial. The provider reported its 1M-token-per-minute limit during concurrent builders and early
step reviews. The raw timings retain those delays. This observation motivates testing foreground
quota priority; it does not establish that throttling alone explains the result.

On this backend, a separate identical ACK request with the same flash model and plan agent used
23,189 input-plus-cache-read tokens with the full tool profile and 20,566 with the core profile.
That is a context-size observation from one pair, not an end-to-end speed claim.

Raw delivery results remain in ignored `bench/results.jsonl`; temporary repositories and logs are
outside the source repository. See [performance.md](performance.md) for the method and commands.
