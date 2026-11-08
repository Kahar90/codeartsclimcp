You are working in a git repo (current directory). Goal: fix the runner problems seen in real lanes, above all
the commit "Permission denied" that blocked whole lanes. Workers must never lose work to a refused commit, must
not waste tokens sleep-polling, must not be marked unverified by a crashed check, and the lead must read less.
Follow this brief directly; do not write another plan. Read only relevant code: `runner/ca.mjs`
(`writeProbe` near line 168, `handlePermission` near 533, `gates()` and the build loop near 800-920, `doctorData`,
`cmdInit`), `runner/controls.mjs` (`classifyCheck`), `runner/mcp.mjs` (`ca_wait`, tool list), `templates/claude-skill.md`,
`docs/workflow.md`. Do not ask questions; decide and keep going. After each step works, run its targeted check, then
`git add -A && git commit -m "step N: <summary>"`.

Background, the Permission denied: lanes ran in git worktrees. A worktree keeps its git dir in the MAIN repo's
`.git/worktrees/<name>`, outside the lane folder the CodeArts sandbox confines worker commands to, so sandboxed git
commands fail with `fatal: Unable to create '.../.git/worktrees/<name>/index.lock': Permission denied`, while the
runner itself (not sandboxed) can write there. A clone keeps `.git` inside the lane folder.

1. Lane workspaces are clones: add `ca workspace <repo> <task> [--from <branch>]` (and MCP `ca_workspace`
   {repo, task, from}) that creates `../<repo-name>-wt-<task>` as `git clone --local --no-hardlinks <repo>` on a new
   branch `lane/<task>` from `--from` (default: the repo's current branch), copies `tasks/<task>.md` if it is
   untracked, and prints the folder plus the merge-back command
   `git -C <repo> fetch <clone> lane/<task> && git -C <repo> merge --no-ff FETCH_HEAD`. Add `ca workspace --land
   <repo> <task>` that runs that fetch and merge (refusing on a dirty main tree) and then deletes the clone folder.
   In `writeProbe`/`ca doctor`, when the git dir is outside the repo folder (a worktree), the `repo writable` row is
   `warn` with fix "this is a git worktree: its git dir is outside the lane folder, so the CodeArts sandbox refuses
   commits; use `ca workspace` (a local clone) instead". Update `templates/claude-skill.md` section 2 and
   `docs/workflow.md`: parallel lanes use `ca workspace`, never `git worktree add`; merge with `ca workspace --land`.
   Commit.
2. Runner commits when the worker cannot: when the tree is dirty at the gate and the worker's commit was refused
   (its last reply or tool output has `Unable to create`, `index.lock`, `Permission denied` or a git `fatal:`),
   and the runner's own `writeProbe` passes, the runner commits the work itself (`git add -A` and
   `git commit -m "step N: <the worker's step subject if it gave one, else the current step text>" -m "committed by
   the runner: the worker's commit was refused (<first error line>)"`), logs it in `S.interruptions` with kind
   `commit-fallback`, and continues to the gates without a fix round. Only when the runner cannot write either does
   the lane end as failed with reason `commit failed: <first error line>` (no fix round that says "commit" again).
   Commit.
3. No sleep-polling: when a worker bash call (a permission request or a tool call the runner sees) contains
   `sleep N` with N >= 20, reject it when it is a permission request, otherwise queue one steer per lane, with the
   message "Do not sleep-poll: run the check in the foreground with a timeout and read its output once." Record
   each in `S.interruptions` with kind `sleep-poll`. Commit.
4. Truthful checks and a lean wait: in `classifyCheck`, exit 126/127 is "infra" only when the output says a
   command or file was not found, or the output is empty; a crash after printing PASS lines (a Node `Assertion
   failed` abort) is "fail". `ca_wait` (MCP) and `ca wait --json` get `compact` (default true in MCP) returning per
   lane only `{lane, status: {key, label, attention}, progress: "d/t", commits, tokens: total, next}`. Commit.
5. Check: `checks/hygiene.check.mjs`: `ca workspace` creates a clone whose `git rev-parse --absolute-git-dir` is
   inside the clone, on branch lane/<task>, and `--land` merges a commit back and removes the folder (temp repos
   only); doctor warns on a worktree; the commit-failure detector and fallback decision on sample replies; the
   sleep matcher (`sleep 5` allowed, `sleep 200; cat x` and `sleep 30 && tail` caught); classifyCheck on
   (127 + "command not found") infra, (127 + PASS lines + Assertion failed) fail, (127 + empty) infra; compact
   wait rows have only the listed fields. Export pure helpers from `runner/controls.mjs`. PASS/FAIL lines, exit 1 on
   any FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers.
- If `git commit` fails, do NOT try workarounds: keep working, leave the work uncommitted and list in your final
  reply which files belong to which step; the runner or the lead commits it.

Checks: run targeted checks in the foreground with a timeout; never sleep-poll a background job. The runner runs
the CHECK lines once when you finish and sends failures back.
CHECK: node --check runner/ca.mjs
CHECK: node checks/hygiene.check.mjs
CHECK: node checks/checkrunner.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/writeguard.check.mjs
CHECK: node checks/statustruth.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs`, `runner/controls.mjs`, `runner/mcp.mjs`,
`templates/claude-skill.md`, `docs/workflow.md` and `checks/hygiene.check.mjs`. If an existing check asserts the
old classifyCheck, doctor or wait shape, update only that assertion in `checks/checkrunner.check.mjs`,
`checks/mcp.check.mjs` or `checks/writeguard.check.mjs` and say so in your reply.

Final reply: the steps with their commit hashes, and anything skipped.
