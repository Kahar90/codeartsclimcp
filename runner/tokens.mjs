// Token counters for one lane or one plan: what each agent (build, review, other) spent.
// A step-finish record carries { input, output, reasoning, cache: { read, write } }; the
// runner bills each part once (countedSteps), so a reconnect never double-counts a step.
// Pure module: no imports, no side effects.

export function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 };
}

// Add one step-finish token record. cache.read is billed as cacheRead; steps counts turns.
export function addStepTokens(acc, tk = {}) {
  acc.input += tk.input || 0;
  acc.output += tk.output || 0;
  acc.reasoning += tk.reasoning || 0;
  acc.cacheRead += tk.cache?.read || 0;
  acc.steps += 1;
  return acc;
}

export const tokenTotal = (t) => (!t ? 0 : (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0));

// A token block with its total, zeros filled for missing fields (old lanes have no tokensBy).
export function withTotal(t) {
  const r = { ...emptyTokens(), ...(t || {}) };
  r.total = tokenTotal(r);
  return r;
}

// Sum a list of token blocks (null and {} entries allowed); total excludes steps.
export function sumTokens(list = []) {
  const r = emptyTokens();
  for (const t of list || []) {
    if (!t) continue;
    r.input += t.input || 0;
    r.output += t.output || 0;
    r.reasoning += t.reasoning || 0;
    r.cacheRead += t.cacheRead || 0;
    r.steps += t.steps || 0;
  }
  r.total = tokenTotal(r);
  return r;
}
