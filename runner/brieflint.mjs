// Pure brief lint for `ca brief-check` and the start of `ca lane`: find, before a lane wastes a
// long run, the problems a lead used to catch by hand. No fs, no child_process: the caller passes
// listFiles() (tracked files, repo-relative with forward slashes) and readFile(rel).
// Warnings: protected-dependent (a file the brief protects references a file the brief changes) and
// missing-check-file (a CHECK line runs a relative script path that is not a file in the repo).
const PROTECTED_RE = /\b(?:do not|don't|never)\s+(?:edit|touch|change|modify)\b/i;
const NUM_STEP_RE = /^\s*\d+\.\s+/;
const CHECK_RE = /^\s*(?:[-*]\s*)?CHECK:\s*(.+?)\s*$/i;
// node/python/bash/sh followed by a relative script path (with an extension): the interesting CHECK.
const SCRIPT_RE = /\b(?:node|python|python3|bash|sh)\b\s+(?:"([^"]+\.[A-Za-z0-9]+)"|'([^']+\.[A-Za-z0-9]+)'|((?:\.?\/)?[^\s'"]+\.[A-Za-z0-9]+))/i;

const isPathLike = (t) => /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
const norm = (p) => String(p).trim().replace(/^[`"']+|[`"']+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');

// Backticked spans plus bare path-like tokens (one or more separators, or a dotted name).
function tokens(text) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\n]+)`/g)) { const t = norm(m[1]); if (t) out.push(t); }
  for (const m of String(text).matchAll(/[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)+\/?/g)) { const t = norm(m[0]); if (isPathLike(t)) out.push(t); }
  for (const m of String(text).matchAll(/(?:^|[\s(])([A-Za-z0-9_@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),.;:])/g)) { const t = norm(m[1]); if (isPathLike(t)) out.push(t); }
  return [...new Set(out)];
}

export function lintBrief({ repo, briefText, listFiles, readFile } = {}) {
  const files = new Set((listFiles ? listFiles() : []).map((f) => norm(f)).filter(Boolean));
  const lines = String(briefText || '').split(/\r?\n/);
  const warnings = [];

  // Protected files: every tracked file under a path a "do not edit/touch/change/modify" line names.
  const protectedFiles = new Map();
  lines.forEach((text, i) => {
    if (!PROTECTED_RE.test(text)) return;
    const rule = text.trim();
    for (const t of tokens(text)) for (const f of files) {
      if (f === t || f.startsWith(t.endsWith('/') ? t : t + '/')) if (!protectedFiles.has(f)) protectedFiles.set(f, { rule, line: i + 1 });
    }
  });

  // Changed files: path-like tokens on a numbered step line that are tracked files.
  const changed = new Set();
  lines.forEach((text) => {
    if (!NUM_STEP_RE.test(text)) return;
    for (const t of tokens(text)) if (files.has(t)) changed.add(t);
  });

  // A protected file the brief does not change, but whose text names a changed file (path or name).
  for (const [f, meta] of protectedFiles) {
    if (changed.has(f)) continue;
    let body = ''; try { body = readFile ? String(readFile(f) ?? '') : ''; } catch { body = ''; }
    const references = [];
    for (const c of changed) {
      const base = c.split('/').pop();
      if (body.includes(c) || (base && body.includes(base))) references.push(c);
    }
    if (references.length) warnings.push({ kind: 'protected-dependent', file: f, references, rule: meta.rule, line: meta.line });
  }

  // A CHECK line that runs a relative script path the repo does not contain.
  lines.forEach((text, i) => {
    const m = text.match(CHECK_RE);
    if (!m) return;
    const cmd = m[1].replace(/`/g, '');
    const sm = cmd.match(SCRIPT_RE);
    if (!sm) return;
    const p = norm(sm[1] || sm[2] || sm[3] || '');
    if (!p || !/[\\/]/.test(p) || /^[\\/]/.test(p) || files.has(p)) return;
    warnings.push({ kind: 'missing-check-file', file: p, line: i + 1 });
  });

  return warnings;
}
