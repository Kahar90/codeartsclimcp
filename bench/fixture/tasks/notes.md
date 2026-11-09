You are working in a git repo (current directory): a small Node notes API in `server.mjs` (no dependencies).
Goal: a complete, hardened notes API. The contract is `checks/api.check.mjs`: read it first and do not edit it.
Do the steps in order. After each step that works, run its checks, then `git add -A && git commit -m "step N: <summary>"`.
Do not ask questions; decide and keep going. Follow this brief directly; do not write another plan or restate the
requirements.

1. CRUD and validation in server.mjs. POST /notes {title, body, tags}: title is trimmed, required, at most 120
   chars; body an optional string (default ""); tags an optional array of strings, stored lower-case (default []).
   201 with {id, title, body, tags, createdAt (ISO)}. GET /notes/:id, PATCH /notes/:id (title, body and/or tags,
   same rules as POST; validate the whole request before changing anything), DELETE /notes/:id (204). Ids are
   positive integers in canonical form ("01" is not an id); unknown ids are 404 {error}; ids are never reused.
   Every error is a JSON {error} with a clear message. Commit.
2. Listing. GET /notes is newest first with limit (default 10, 1 to 100, else 400) and offset (default 0), and the
   X-Total-Count header with the number of matches before paging. q matches the title or the body
   case-insensitively (each field on its own). tag filters by one tag; q and tag combine. Commit.
3. Persistence. createServer({file}) loads {notes, nextId} from the file when it exists and saves after every
   change with an atomic write (write a temp file next to it, then rename). Without a file option the server is
   in-memory as before. `node server.mjs [port]` uses data/notes.json. Commit.
4. Hardening. Malformed JSON is 400. A request body over 64 KB is 413 (stop reading it). An unsupported method on
   a known route is 405; an unknown route is 404. Run the check, fix what fails, commit.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- If `git commit` fails, do NOT try workarounds: stop and put the exact error in your final reply.

Checks: run the check in the foreground with a timeout; never sleep-poll a background job. The runner runs the line below once when you finish.
CHECK: node checks/api.check.mjs
Constraints: no em dashes anywhere. Only touch server.mjs and data/ (add data/ to .gitignore).

Final reply: the steps with their commit hashes, and anything skipped.
