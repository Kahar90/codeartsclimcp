# Tool profile (opt-in)

The live CodeArts backend exposes about 80 tools, so every `prompt_async` request ships the full
tool schema. A coding lane only needs a handful of them. `CA_TOOL_PROFILE=core` trims that schema
down on the private lane server, cutting the irrelevant tool/context overhead the model has to
carry on each request.

This is **opt-in and off by default**. A brief with no `TOOL_PROFILE:` header and no environment
value behaves exactly as before: the request is sent unchanged and nothing extra is fetched.

## Select it per lane (brief header)

`ca init` writes coding briefs from `templates/brief.md`, which carries the header

```
TOOL_PROFILE: core
```

so a newly scaffolded coding lane opts into the core profile with no environment change. The lane
selects the mode **once**, before its private server starts, and records it in the lane state
(`toolProfile`). Precedence, highest first:

1. `CA_TOOL_PROFILE` in the environment, including an explicit empty value (which means `full`).
2. `TOOL_PROFILE:` in the brief (`core` or `full`).
3. Neither present (a legacy brief and no variable): `full`, exactly as before.

So old briefs and direct Server callers keep the previous unprofiled behaviour, newly scaffolded
coding briefs opt into `core`, and `CA_TOOL_PROFILE=full` is the escape hatch for a broader task
that needs more than the coding tools. The lane reads this from its brief and environment only: it
never writes `process.env` or user config, so a per-lane choice cannot leak into another lane or the
global config.

## Enable it by environment

Set the variable for the lane process (it also overrides any brief header, per lane):

```sh
# one lane
CA_TOOL_PROFILE=core ca lane <repo> <task>

# or for this shell, every lane started from it
export CA_TOOL_PROFILE=core
```

Revert by unsetting it (the brief header then decides) or setting `CA_TOOL_PROFILE=full`.

## What it does

For `POST /session/:id/prompt_async` requests **only**, when the profile is `core`:

1. The server reads `GET /experimental/tool/ids` from the same private lane server once, and caches
   the result for that server's lifetime (a restart clears the cache).
2. It denies every id that is not a core coding tool by adding `tools: { <id>: false }` to the
   outgoing request.

Core tools (never added and never altered, so their inherited permissions stay inherited):

`bash`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `question`

Properties of the change:

- **Deny only.** It never inserts `true` and never adds or edits a core id, so inherited core and
  plan read-only permissions are untouched. The caller's own `tools` entries are kept (an explicit
  caller `false` stays `false`); for a reported non-core id the deny map wins, so no unrelated
  known or future id (or a duplicate) can stay enabled. An id the server does not report keeps the
  caller's value, since the profile can only deny what the endpoint actually lists.
- **Other fields intact.** `agent`, `parts` and every other request field are sent unchanged. A new
  body and a new `tools` object are built, so the caller's request object is never mutated.
- **No new network.** The only extra call goes to `/experimental/tool/ids` on the same private
  local server, bounded by a 5 s timeout. Nothing else is contacted.

## Limitations

- **`prompt_async` only.** Session creation, aborts, health checks and event streams are never
  touched.
- **Fail visible, never silent.** An unknown `CA_TOOL_PROFILE` value, or metadata that is
  unavailable or malformed, makes the request fail with a clear error instead of quietly falling
  back to the unprofiled (or the truncated) request.
- **It does not change model, reasoning, quality gates, review or permissions** beyond the explicit
  non-core denies above.
- **Actual token savings are not asserted here.** Enable it only after measuring the real provider
  token counts and confirming the inherited permissions on your backend.

## Env summary

| Value | Effect |
|---|---|
| unset | Use the brief's `TOOL_PROFILE:` header; a brief without one stays `full` |
| `full` | Off: request unchanged, no metadata fetch |
| `core` | Deny every non-core tool id on `prompt_async` requests |
| anything else | Error (the request fails visibly) |

## Tests

`node checks/toolprofile.check.mjs` covers the profile off/on paths, explicit caller denies, the
per-server cache and its reset on restart, malformed/unavailable metadata, the `prompt_async`-only
scope, and that neither the outgoing request nor the caller's body is mutated.

`node checks/briefprofile.check.mjs` covers the per-lane selection: the `TOOL_PROFILE:` header that
`ca init` writes, the environment override (including an empty value), legacy briefs, the prompt
denies a `core` brief produces, and that selecting a profile mutates neither `process.env` nor
another lane's server.
