# Review role (scoped, on by default)

Every review in a lane (the full final review, a fix round and each step review) runs on the private
lane server as the **plan** agent, while the builder runs its own sessions as the default/build agent
(see the `agent: 'plan'` prompts in `runner/lane.mjs`). A live plan agent was not a good reviewer: it
spent review turns inspecting its own live runner logs instead of the source, and it denied only
`edit` while still permitting `write`, `apply_patch` and `deleteFile`.

The review role fixes that at the source. When the private server starts, `runner/server.mjs`
computes one child environment through `runner/reviewrole.mjs` and scopes **only `agent.plan`**:

- `agent.plan.prompt` is replaced with a focused, read-only reviewer role (work under the lead,
  follow the full/fix/step prompt and every requirement including the requested output format, read
  the source it needs but do not reread prepared source, no parent preflight or replanning, never
  read live lane logs, never rerun the CHECK gates, never edit or commit or run a mutating shell,
  report concrete bugs with file/line evidence, finish with the numbered item list and VERDICT).
- `agent.plan.permission` denies the mutation tools `edit`, `write`, `apply_patch` and `deleteFile`.

It never inserts a mutation allow, and it preserves the provider credentials/config, every builder
setting, the plan model and options, and every unrelated permission. A coarse permission given as a
single `allow` / `ask` / `deny` string is kept as its `'*'` catch-all, added before the specific
denies, so everything that is not a mutation tool keeps the coarse rule instead of being narrowed.

This is **on by default**. Builder sessions use a different agent, so they are unaffected; only the
review sessions see the scoped role. It changes no model, no reasoning, no quality gate and no final
acceptance.

## Turn it off

Set the escape hatch for the lane process to keep the previous environment exactly (no role, no
denies, nothing injected):

```sh
CA_REVIEW_ROLE=native ca lane <repo> <task>
```

An **unknown** `CA_REVIEW_ROLE` value, or an `OPENCODE_CONFIG_CONTENT` that is present but does not
parse to a JSON object, fails visibly instead of silently applying a partial role. Neither the raw
value nor the config body is ever printed, since the config can carry the provider key.

## Scope

- **Wired at the private Server start only.** `runner/server.mjs` `start()` computes the child env
  once and uses it for both the actual spawn and the redacted `CA_DUMP_ENV`, so the debug dump shows
  exactly what was spawned with every secret redacted. Global `caEnv` and the user/harness config are
  untouched.
- **`agent.plan` only.** The builder agent, every other agent and the provider block are carried
  through by value.
- **Pure and testable.** `reviewRoleConfig(config)` (the transform) and `reviewRoleEnv(env)` (the
  environment wrapper) have no I/O and no dependency, so they are covered without a server.

## Env summary

| Value | Effect |
|---|---|
| unset / blank / `default` | Scoped read-only reviewer role on `agent.plan`, mutation tools denied |
| `native` | Escape hatch: prior environment exactly, nothing injected |
| anything else | Error (the server start fails visibly) |

## Tests

`node checks/reviewrole.check.mjs` covers config/environment preservation, caller immutability, the
permission forms (absent, coarse string, object, wildcard), `native`/unknown/malformed behaviour and
a fake private-server capture: the check starts the real `Server` against a tiny fake `codearts
serve` and reads back the runner's redacted `CA_DUMP_ENV`, proving the role and the mutation denies
reach the spawned child while the provider key stays redacted. No model is used.
