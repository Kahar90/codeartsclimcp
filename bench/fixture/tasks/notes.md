You are working in a git repo (current directory): a tiny Node notes API in `server.mjs` (no dependencies,
in-memory). Goal: full CRUD with search and validation. The contract is `checks/api.check.mjs`: read it first
and do not edit it. Do the steps in order. After each step that works, run its checks, then
`git add -A && git commit -m "step N: <summary>"`. Do not ask questions; decide and keep going. Follow this brief
directly; do not write another plan or restate the requirements.

1. POST /notes {title, body}: trim the title; it is required and at most 120 chars, else 400 {error}. Body is an
   optional string (default ""). Answer 201 with {id, title, body, createdAt (ISO)}. GET /notes lists newest
   first. Commit.
2. GET /notes?q=<text>: case-insensitive match on title or body. GET /notes/:id, PATCH /notes/:id (title and/or
   body, same validation as POST), DELETE /notes/:id (204). An unknown id is 404 {error}. Ids never get reused.
   Commit.
3. Run the check, fix what fails, commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run the check in the foreground with a timeout; never sleep-poll a background job. The runner runs the line below once when you finish.
CHECK: node checks/api.check.mjs
Constraints: no em dashes anywhere. Only touch server.mjs.

Final reply: the steps with their commit hashes, and anything skipped.
