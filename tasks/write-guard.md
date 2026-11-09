You are working in a git repo (current directory). Goal: a lane whose repo cannot be written (Windows Controlled
Folder Access, sandbox ACLs, read-only disk) is caught before it starts, and a lane whose commits start failing
ends at once with a clear reason instead of spending fix rounds. Also let the lead wait for the first lane to end.
Follow this brief directly; do not write another plan or restate the requirements. Read only relevant code
(`runner/ca.mjs`: `doctorData` near line 1522, `gates()` near line 799, the build loop near line 885; `runner/mcp.mjs`
for ca_wait). Do not ask questions; decide and keep going. After each step works, run its targeted check, then
`git add -A && git commit -m "step N: <summary>"`.

1. Write probe: add `writeProbe(repo)` in `runner/ca.mjs`. Through the worker shell (`workerShell()`, Git Bash), create
   and delete a probe file in the repo root and in the git dir (`git rev-parse --absolute-git-dir`, so a worktree
   tests its own `.git/worktrees/<name>` dir), and run `git update-index --refresh` style lock creation by creating and
   removing `<gitdir>/ca-probe.lock`. Return `{ ok, where, error }` (error: first line of the failing output). Env
   `CA_WRITE_PROBE_FAIL=1` forces a failure (test hook). Use it in three places:
   a. `ca doctor`: a `repo writable` row, `fail` when the probe fails, detail = where and error, fix = on Windows
      "Windows Controlled Folder Access or a sandbox ACL is blocking writes: allow git, Git Bash and node in
      Defender (Controlled Folder Access, Allow an app) or move the repo out of Documents", elsewhere "check the
      folder permissions".
   b. `ca lane` start: probe before starting the codearts server; on failure end the lane at once as failed with
      reason `repo not writable: <where>: <error>` (exit 1), no server, no model calls.
   c. `gates()`: when the tree is dirty, probe; if it fails, end the build loop at once as failed with the same
      reason and no fix round (the worker cannot fix a blocked disk). Commit.
2. Wait for the first: `ca wait <lanes...> --any` returns as soon as any one lane has a result (exit = that lane's
   exit, others listed as still running), and `ca_wait` in `runner/mcp.mjs` gets `any: boolean` with the same
   meaning. Mention it in `templates/claude-skill.md` section 4 in one line ("wait with any: true when lanes run in
   parallel, so an early failure is seen at once"), and add to section 1 that a `repo writable` fail row stops
   everything. Commit.
3. Check: `checks/writeguard.check.mjs` (temp git repo, like `checks/resume.check.mjs` sets up its temp home):
   doctor shows `repo writable` ok on a normal temp repo and fail with `CA_WRITE_PROBE_FAIL=1`; `ca lane` with the
   env set ends within 30 s as failed with reason starting `repo not writable` and never starts a server; and
   `ca wait --any` returns for the first of two fake finished/running lane states (reuse how other checks fake lane
   state.json). PASS/FAIL lines, exit 1 on any FAIL. Commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod); use the env test hook instead.
- Do not launch browsers.
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run targeted checks for changed behavior before committing. The runner runs the CHECK lines once when you
finish and sends failures back.
CHECK: node --check runner/ca.mjs
CHECK: node checks/writeguard.check.mjs
CHECK: node checks/mcp.check.mjs
CHECK: node checks/resume.check.mjs
Constraints: no em dashes anywhere. Only touch `runner/ca.mjs`, `runner/mcp.mjs`, `templates/claude-skill.md`,
`checks/writeguard.check.mjs`.

Final reply: the steps with their commit hashes, and anything skipped.
