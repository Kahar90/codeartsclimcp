# MCP lead visibility implementation plan

Goal: portable MCP updates for lead activity and current plan; lean briefs. User approved MCP approach and deferred budgets and harness integration.
Architecture: extend existing note/plan CLI and MCP wrappers, persist timestamped activity on the plan using locked atomic writes, render in both existing views. The model publishes scope changes and progress; no access to private reasoning or chat is implied.
Stack: Node ESM, no dependencies, no em dashes.

1. Add tested MCP/CLI updates: explicit plan targeting, lead activity phases/history/age, validated partial plan updates preserving unrelated data and rejecting closed/missing/ambiguous plans. Test behavior with fake plans and actual MCP stdio, including concurrent writes.
2. Display lead activity, freshness, recent events, current goal and pending tasks in both views. Browser fixture checks demonstrate updates without reload and stale/legacy behavior.
3. Simplify brief and generated workflow instructions, require the lead to publish meaningful transitions and changed scope. Preserve runner review and final verification. Run targeted checks and commit each step.

Review focus: multi-plan targeting, lost concurrent updates, closed plan resurrection, legacy plans, misleading freshness. No token budget work. Full checks run by lead once after lane completion.
