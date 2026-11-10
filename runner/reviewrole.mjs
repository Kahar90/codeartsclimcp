// Scoped role for the independent reviewer on the private lane server. The builder runs its own
// sessions as the default/build agent, while every review (final, fix round and step review) runs
// as the plan agent (see the `agent: 'plan'` prompts in runner/lane.mjs). So the reviewer role is
// scoped by overriding ONLY agent.plan: its prompt and the permissions of the few tools a reviewer
// must never use. Everything else (provider credentials/config, every builder setting, the plan
// model and options, and every unrelated permission) is carried through untouched.
//
// A live plan agent denied `edit` but still permitted write/apply_patch/deleteFile and spent review
// turns investigating its own live runner logs instead of the source. This module gives the plan
// agent a focused, read-only reviewer role and denies those mutation tools on the private server the
// runner starts. It is pure (no I/O, no dependency) except for the one small environment wrapper, so
// the check can exercise it without a CodeArts server.

// The mutation tools a reviewer must never be allowed to use. Only these are ever set, and only to
// 'deny': a mutation allow is never inserted.
export const REVIEW_ROLE_MUTATION_TOOLS = Object.freeze(['edit', 'write', 'apply_patch', 'deleteFile']);

// The role the plan agent runs under. It is a reviewer, not a builder: read-only, focused on the
// prompt it was given, and it never touches the lane's own live logs or reruns the CHECK gates.
export const REVIEW_ROLE_PROMPT = [
  'You are the independent read-only reviewer working under the lead.',
  'Follow the full review, fix-round or step prompt you were given and satisfy every requirement it states, including the requested output format.',
  'Serve the task only: read the source you need. If a relevant file was not supplied in the prompt, read its relevant ranges; source already prepared and supplied in the prompt counts as read, so do not reread it.',
  'Do not run the parent preflight, planning or replanning, do not read live lane logs, and do not rerun the CHECK gate commands.',
  'You are read-only: never edit or create files, never commit, and never run a mutating shell command. Use read-only inspection (read, glob, grep and similar) only.',
  'Report concrete bugs with the file and line evidence, then finish with the requested output format (the numbered item list and the final VERDICT line).',
].join('\n');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ''/unset and 'default' keep the scoped role (the feature is on by default). 'native' is the escape
// hatch that keeps the prior environment exactly. Anything else is an explicit but unknown value:
// fail visibly instead of silently guessing, so a typo is never read as "off".
export function reviewRoleMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '' || v === 'default') return 'default';
  if (v === 'native') return 'native';
  return 'unknown';
}

// A coarse permission (a single allow/ask/deny string) applies to every tool; keep it as the '*'
// catch-all that it was, so the specific denies below only override the mutation tools. An object is
// copied as-is (its own '*' and its other keys stay). Anything else is a corrupted permission: fail.
function permissionFor(perm) {
  if (perm === undefined || perm === null) return {};
  if (typeof perm === 'string') return { '*': perm };
  if (isObject(perm)) return { ...perm };
  throw new Error('review role: agent.plan.permission must be an allow/ask/deny string or a JSON object');
}

// Pure: return a new config with the scoped reviewer role on agent.plan. It never mutates the input,
// and it never inserts a mutation allow. Provider, build agent, plan model/options and every other
// permission are carried through. A config (or its agent/plan) that is not a JSON object is
// malformed: fail visibly rather than silently applying a partial role.
export function reviewRoleConfig(config) {
  const src = config === undefined ? {} : config;
  if (!isObject(src)) throw new Error('review role: explicit config must be a JSON object');
  if (src.agent !== undefined && !isObject(src.agent)) throw new Error('review role: explicit config agent must be a JSON object');
  const agent = src.agent || {};
  if (agent.plan !== undefined && !isObject(agent.plan)) throw new Error('review role: explicit config agent.plan must be a JSON object');
  const plan = agent.plan || {};
  const permission = permissionFor(plan.permission);
  for (const tool of REVIEW_ROLE_MUTATION_TOOLS) permission[tool] = 'deny';
  return { ...src, agent: { ...agent, plan: { ...plan, prompt: REVIEW_ROLE_PROMPT, permission } } };
}

// The environment wrapper for the private Server startup. It takes the base environment (the same
// `caEnv(...)` the server spawns with), and returns the child environment to actually use: the
// scoped role is merged into OPENCODE_CONFIG_CONTENT (which is merged over codearts_cli.json). The
// caller's environment is never mutated. 'native' returns the prior environment exactly, unchanged.
// An unknown role value, or an explicit config that does not parse to a JSON object, fails visibly,
// and neither the raw value nor the config body is ever printed (it may carry the provider key).
export function reviewRoleEnv(env) {
  const src = isObject(env) ? env : {};
  const mode = reviewRoleMode(src.CA_REVIEW_ROLE);
  if (mode === 'native') return env; // prior environment exactly: nothing added, same object back
  if (mode === 'unknown') throw new Error('review role: unknown CA_REVIEW_ROLE (expected "default" or "native")');
  const raw = src.OPENCODE_CONFIG_CONTENT;
  let config;
  if (raw === undefined || raw === '') config = {};
  else {
    try { config = JSON.parse(raw); }
    catch { throw new Error('review role: OPENCODE_CONFIG_CONTENT is not valid JSON'); }
  }
  return { ...src, OPENCODE_CONFIG_CONTENT: JSON.stringify(reviewRoleConfig(config)) };
}
