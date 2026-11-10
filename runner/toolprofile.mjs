// Pure helpers for the opt-in per-lane core tool profile. The live CodeArts backend exposes about
// 80 tools, but a coding lane only needs the handful below; with CA_TOOL_PROFILE=core the private
// server denies every unrelated tool id in a prompt_async request instead of letting the
// builder/reviewer inherit the full tool schema. No I/O and no dependency here, so the check can
// exercise the profile logic without a CodeArts server.
export const CORE_TOOLS = Object.freeze(['bash', 'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'question']);
const CORE = new Set(CORE_TOOLS);

// ''/unset and 'full' mean "no profile": send the request exactly as before and never fetch the
// tool ids. 'core' opts in. Anything else is an explicit but unknown profile: the caller said
// something, so fail visibly instead of silently falling back to the unprofiled request. Unknown
// also covers a config typo, which must never be read as "off".
export function profileMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '' || v === 'full') return 'full';
  if (v === 'core') return 'core';
  return 'unknown';
}

// /experimental/tool/ids must answer with a non-empty JSON array of non-empty strings. Any other
// shape is malformed metadata: throw, so an explicit profile is never silently bypassed. An empty
// list is rejected too: on this experimental endpoint a version skew could answer [] and, taken
// literally, the core profile would deny nothing and inherit the full schema while still labelling
// the request as profiled.
export function parseToolIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error('tool profile: /experimental/tool/ids returned malformed metadata');
  }
  return raw;
}

// Build the outgoing tools map for a prompt_async body under the core profile: deny every id that
// is not a core coding tool. Never inserts true and never adds a core id, so inherited core/plan
// read-only permissions stay inherited. The caller's own entries are kept: a caller false stays
// false, and the deny map wins for a non-core id, so no unrelated tool (known or future, even a
// duplicate) can stay enabled. Returns a new body with a new tools object, so the caller's request
// object is never mutated.
export function applyCoreProfile(body, toolIds) {
  const deny = {};
  for (const id of toolIds || []) if (typeof id === 'string' && id && !CORE.has(id)) deny[id] = false;
  return { ...body, tools: { ...(body.tools || {}), ...deny } };
}
