import fs from 'node:fs';
import path from 'node:path';

// A small, safe context packet for the initial builder prompt. The worker would otherwise spend its
// first turns rediscovering the few source files the brief already names. This collects only those
// explicit, relative, allow-listed source paths, quotes them verbatim and bounds the result hard, so
// the packet is cheap and can never leak secrets, config, data or binary content into the model.

export const CONTEXT_MARKER = '## Builder context packet';

export const CONTEXT_ROLE = 'You are the coding worker for this lane. The parent agent already produced the plan and the original brief; follow that brief exactly and do not restate or re-plan it. Do not run preflight, planning, repo-wide discovery or any other lane.';

export const CONTEXT_INSTRUCTIONS = 'The source below is quoted read-only data captured by the runner. Each quoted file is complete, not a summary or edited excerpt; the packet may omit other named files. If a needed file has no quoted block, read its relevant ranges before editing it. Use quoted files directly and do not reread these files unless a specific uncertainty remains that the quoted text cannot resolve. Run every check through the lane helper described at the end of this message.';

// Negative paths a reviewer checks that the brief may leave implicit. Scoped to what the brief asks for:
// never invent requirements, and never add hints specific to any benchmark or fixture.
export const CONTEXT_NEGATIVE_PATHS = 'Within the brief\'s scope, also make the code hold on the negative paths a reviewer looks for, where the task calls for them: reject invalid input and mistrust corrupted or missing persisted state (fail closed, do not assume it is well formed), handle I/O and tool failures instead of assuming success, keep a shared entrypoint consistent with every caller, and bound resource use (sizes, counts, timeouts). Do not invent requirements or add checks the brief does not call for.';

export const CONTEXT_POINTER = 'Oversized or unavailable paths named in the brief (read them with targeted ranged reads only if a specific uncertainty remains):';

const ALLOWED_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.css', '.html']);
const PER_FILE_LIMIT = 24000;
const TOTAL_LIMIT = 32000;
const HARD_LIMIT = 32000;
const NOTES_LIMIT = 1200;
const MAX_FILES = 6;

// A path candidate: unicode-aware run of path characters that ends in an allow-listed extension.
const PATH_RE = /(?<![\p{L}\p{N}_.\\/-])([\p{L}\p{N}_.\\/-]*[\p{L}\p{N}_])\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|css|html)(?![\p{L}\p{N}_])/gu;
// Names that suggest secrets, config, credentials, data or logs. Boundaries keep legit words intact.
const DENY_NAME_RE = /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|apikey|api[_-]?key|private|config|settings|conf|data|log|logs|env|id_rsa|id_ed25519)([._-]|$)/i;
const DENY_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.log']);

function extractPaths(brief) {
  const out = [];
  for (const m of brief.matchAll(PATH_RE)) out.push(m[1] + '.' + m[2]);
  return out;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function toPosix(rel) {
  return String(rel).split(path.sep).join('/');
}

// Reject absolute paths, drive paths, UNC paths and any explicit parent traversal.
function cleanRel(rel) {
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('//')) return null;
  const segs = rel.split(/[\\/]+/);
  if (segs.some((s) => s === '..')) return null;
  return segs.filter((s) => s && s !== '.').join('/');
}

function isHidden(rel) {
  return rel.split('/').some((s) => s.startsWith('.'));
}

// Every path segment is checked, not just the basename: config/app.mjs, data/y.js and secrets/x.js
// must not pass. Used for both the named relative path and the resolved realpath inside the repo.
function isDenied(rel) {
  return rel.split('/').some((seg) => DENY_EXT.has(path.extname(seg).toLowerCase()) || DENY_NAME_RE.test(seg));
}

function readText(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.length === 0) return '';
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

function langFor(rel) {
  const low = rel.toLowerCase();
  if (low.endsWith('.py')) return 'python';
  if (low.endsWith('.go')) return 'go';
  if (low.endsWith('.rs')) return 'rust';
  if (low.endsWith('.java')) return 'java';
  if (low.endsWith('.css')) return 'css';
  if (low.endsWith('.html')) return 'html';
  if (low.endsWith('.ts') || low.endsWith('.tsx')) return 'ts';
  return 'js';
}

export function builderContext(repo, brief) {
  const notes = [];
  let noteChars = 0;
  const addNote = (s) => {
    if (noteChars >= NOTES_LIMIT) return;
    const line = '- ' + s;
    const room = NOTES_LIMIT - noteChars;
    const t = line.length > room ? line.slice(0, Math.max(0, room - 3)) + '...' : line;
    notes.push(t);
    noteChars += t.length + 1;
  };
  try {
    const repoRoot = path.resolve(String(repo || '.'));
    let repoReal = repoRoot;
    try { repoReal = fs.realpathSync(repoRoot); } catch {}
    const seen = new Set();
    const files = [];
    let total = 0;
    let overflow = 0;
    for (const raw of extractPaths(String(brief || ''))) {
      if (files.length >= MAX_FILES) { overflow++; continue; }
      const rel = cleanRel(raw);
      if (!rel) continue;
      if (isHidden(rel)) continue;
      if (!ALLOWED_EXT.has(path.extname(path.basename(rel)).toLowerCase())) continue;
      if (isDenied(rel)) continue;
      const abs = path.resolve(repoRoot, rel);
      if (!inside(repoRoot, abs)) continue;
      let real;
      let stat;
      try { real = fs.realpathSync(abs); stat = fs.statSync(real); } catch { continue; }
      if (!inside(repoReal, real)) continue;
      if (!stat.isFile()) continue;
      // Inspect the resolved target too, so an allowed alias to a hidden/secret file is rejected.
      const realRel = toPosix(path.relative(repoReal, real));
      if (realRel) {
        if (isHidden(realRel)) continue;
        if (isDenied(realRel)) continue;
        if (!ALLOWED_EXT.has(path.extname(path.basename(realRel)).toLowerCase())) continue;
      }
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      if (stat.size > PER_FILE_LIMIT) { addNote(`${rel}: too large to inline (${stat.size} bytes, over ${PER_FILE_LIMIT}); read it with targeted ranges.`); continue; }
      const text = readText(real);
      if (text === null) { addNote(`${rel}: not UTF-8 text (binary or unreadable); skipped.`); continue; }
      if (total + text.length > TOTAL_LIMIT) { addNote(`${rel}: skipped to keep the packet under ${TOTAL_LIMIT} characters; read it with targeted ranges.`); continue; }
      total += text.length;
      files.push({ rel, text });
    }
    if (overflow) addNote(`${overflow} further named path(s) were not inlined (over the ${MAX_FILES}-file limit); read them with targeted ranges.`);
    const head = [CONTEXT_MARKER, '', CONTEXT_ROLE, '', CONTEXT_INSTRUCTIONS, '', CONTEXT_NEGATIVE_PATHS, ''].join('\n');
    const blocks = files.map((f) => {
      const runs = f.text.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      return `--- BEGIN QUOTED FILE ${f.rel} (complete) ---\n${fence}${langFor(f.rel)}\n${f.text.replace(/\s+$/, '')}\n${fence}\n--- END QUOTED FILE ${f.rel} ---\n\n`;
    });
    const noteBlock = notes.length ? `${CONTEXT_POINTER}\n${notes.join('\n')}\n\n` : '';
    let out = head + blocks.join('');
    if (out.length + noteBlock.length > HARD_LIMIT) {
      // The cap covers wrappers and notes, not just source text. Keep every inlined file complete and
      // drop whole trailing files (never truncate source) until the packet fits.
      const keep = blocks.slice();
      while (keep.length && (head + keep.join('')).length + noteBlock.length > HARD_LIMIT) keep.pop();
      out = head + keep.join('');
    }
    if (out.length + noteBlock.length <= HARD_LIMIT) out += noteBlock;
    return out;
  } catch {
    // Never block a lane: fall back to the role and instructions only.
    return [CONTEXT_MARKER, '', CONTEXT_ROLE, '', CONTEXT_INSTRUCTIONS, '', CONTEXT_NEGATIVE_PATHS, ''].join('\n');
  }
}
