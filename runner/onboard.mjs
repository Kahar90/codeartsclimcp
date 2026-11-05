#!/usr/bin/env node
// runner/onboard.mjs: guided first-run setup for the CodeArts lanes runner, called by
// `ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json]`.
// It walks the environment (doctor rows), the repo (git, trusted folder), the harness
// (marker detection + `ca setup`) and, only with --smoke, a throwaway probe lane.
// Every step is {name, status: ok|warn|fail|fixed|skipped|planned, detail, fix};
// --json prints {harness, repo, ready, steps, next} only. Exit 0 when ready (no fail
// row), 1 otherwise. --yes applies the fixes, --dry-run only plans them; with a TTY
// and neither flag it asks y/N per fix and can store missing AK/SK/MAAS keys with
// hidden input (the value goes to PowerShell through the env, never argv, never printed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_MJS = path.join(HERE, 'ca.mjs');
const CA_HOME = path.join(os.homedir(), '.codeartsdoer');
const SETTINGS = process.env.CA_SETTINGS || path.join(CA_HOME, 'cli-data', 'settings.json');
const HARNESSES = ['kiro', 'cursor', 'claude', 'codex', 'vscode'];
const PORTAL = 'https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth';
const DASH = 'http://127.0.0.1:4777';
const oneLine = (s, n = 200) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h`; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, input: '', ...opts });
const git = (cwd, ...args) => run('git', args, { cwd });
const usage = (msg) => { process.stderr.write(`${msg}\nusage: ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json]\n`); process.exit(2); };

// settings.json (security.trustedFolders): BOM and CRLF tolerant; a file we cannot parse
// as a JSON object is reported and never overwritten.
function loadSettings() {
  if (!fs.existsSync(SETTINGS)) return { obj: {}, err: null };
  try {
    const v = JSON.parse(fs.readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? { obj: v, err: null } : { obj: null, err: 'not a JSON object' };
  } catch (e) { return { obj: null, err: e.message }; }
}
const trustedList = (obj) => [].concat(obj?.security?.trustedFolders || []).map(String).filter(Boolean);
// Prefix match, case-insensitive (Windows paths differ in case and slash direction).
const isUnder = (list, p) => {
  const a = path.resolve(p).toLowerCase();
  return list.some((f) => { const b = path.resolve(f).toLowerCase(); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); });
};

export default async function onboard(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const ri = args.indexOf('--repo'), hi = args.indexOf('--harness');
  if (ri >= 0 && (ri + 1 >= args.length || args[ri + 1].startsWith('--'))) usage('--repo needs a directory');
  if (hi >= 0 && (hi + 1 >= args.length || args[hi + 1].startsWith('--'))) usage('--harness needs a name');
  const harnessArg = hi >= 0 ? args[hi + 1] : '';
  if (harnessArg && !HARNESSES.includes(harnessArg)) usage(`unknown harness "${harnessArg}" (one of ${HARNESSES.join(', ')})`);
  const pos = args.filter((a, i) => !a.startsWith('--') && i !== ri + 1 && i !== hi + 1);
  const repo = path.resolve((ri >= 0 ? args[ri + 1] : '') || pos[0] || process.cwd());
  const yes = flags.has('--yes'), dry = flags.has('--dry-run'), asJson = flags.has('--json'), smoke = flags.has('--smoke');
  const interactive = !yes && !asJson && !dry && !!(process.stdin.isTTY && process.stdout.isTTY);
  const envRows = [], repoRows = [], harnessRows = [], smokeRows = [];
  const add = (rows, name, status, detail, fix = '') => rows.push({ name, status, detail: oneLine(detail), fix });

  // ---- 1. environment: doctor rows, with exact fix steps for missing credentials ----
  const dr = run(process.execPath, [CA_MJS, 'doctor', '--json', repo], { timeout: 45000 });
  let docChecks = null;
  try { docChecks = JSON.parse(dr.stdout || '').checks; } catch {}
  if (!Array.isArray(docChecks) || !docChecks.length) {
    add(envRows, 'doctor', 'fail', `could not run doctor: ${oneLine(dr.stderr || dr.error?.message || 'no JSON output', 160)}`, `node ca.mjs doctor --json ${repo}`);
  } else {
    const psLine = (k) => `[Environment]::SetEnvironmentVariable('${k}', '<value>', 'User')`;
    const credFix = (what, ...keys) => [`${what} at ${PORTAL}`, ...keys.map((k) => `PowerShell: ${psLine(k)}`), 'open a new terminal so the new value is visible'].join('\n');
    for (const c of docChecks) {
      let fix = c.fix || '';
      if (/^credentials$/i.test(c.name) && c.status !== 'ok') fix = credFix('create an AK/SK', 'CODEARTS_CLI_AK', 'CODEARTS_CLI_SK');
      else if (/^maas key$/i.test(c.name) && c.status !== 'ok') fix = credFix('create a MaaS API key', 'MAAS_API_KEY');
      add(envRows, c.name, c.status, c.detail || '', fix);
    }
  }

  // ---- 2. repository: git repo with a commit, trusted folder ----
  const isRepo = git(repo, 'rev-parse', '--git-dir').status === 0;
  const hasCommit = isRepo && git(repo, 'rev-parse', 'HEAD').status === 0;
  if (isRepo && hasCommit) add(repoRows, 'git repo', 'ok', `${repo} is a git repo with commits`);
  else {
    const why = isRepo ? 'a git repo, but it has no commits yet' : 'not a git repo yet';
    const cmd = isRepo ? 'git commit --allow-empty -m "first commit"' : 'git init && git commit --allow-empty -m "first commit"';
    if (dry) add(repoRows, 'git repo', 'planned', why, cmd);
    else {
      let doFix = yes;
      if (!doFix && interactive) doFix = await confirm(`${isRepo ? 'Create the first (empty) commit' : 'Run git init and create the first (empty) commit'} in ${repo}?`);
      if (doFix) {
        let err = '';
        if (!isRepo) { const r = git(repo, 'init'); if (r.status !== 0) err = oneLine(r.stderr, 160); }
        if (!err) {
          let c = git(repo, 'commit', '--allow-empty', '-m', 'first commit');
          if (c.status !== 0) c = git(repo, '-c', 'user.email=ca@localhost', '-c', 'user.name=ca', 'commit', '--allow-empty', '-m', 'first commit');
          if (c.status !== 0) err = oneLine(c.stderr, 160);
        }
        if (err) add(repoRows, 'git repo', 'fail', `git init/commit failed: ${err}`, cmd);
        else add(repoRows, 'git repo', 'fixed', isRepo ? 'created the first (empty) commit' : 'git init + first (empty) commit');
      } else add(repoRows, 'git repo', 'planned', why, cmd);
    }
  }

  const { obj: settingsObj, err: settingsErr } = loadSettings();
  if (settingsErr) add(repoRows, 'trusted folder', 'fail', `cannot parse ${SETTINGS}: ${settingsErr}`, 'fix the JSON (or rename the file) and rerun; nothing was overwritten');
  else if (isUnder(trustedList(settingsObj), repo)) add(repoRows, 'trusted folder', 'ok', `${repo} is in security.trustedFolders`);
  else if (dry) add(repoRows, 'trusted folder', 'warn', `${repo} is not in security.trustedFolders`, `ca onboard --yes adds it (or add it to ${SETTINGS})`);
  else {
    let doFix = yes;
    if (!doFix && interactive) doFix = await confirm(`Add ${repo} to the CodeArts trusted folders?`);
    if (doFix) {
      const obj = loadSettings().obj; // re-read: keep every other setting
      obj.security = obj.security && typeof obj.security === 'object' && !Array.isArray(obj.security) ? obj.security : {};
      if (!Array.isArray(obj.security.trustedFolders)) obj.security.trustedFolders = [];
      if (!isUnder(obj.security.trustedFolders.map(String).filter(Boolean), repo)) obj.security.trustedFolders.push(repo);
      fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
      fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
      add(repoRows, 'trusted folder', 'fixed', `added ${repo} to security.trustedFolders`);
    } else add(repoRows, 'trusted folder', 'planned', `${repo} is not in security.trustedFolders`, `ca onboard --yes adds it (or add it to ${SETTINGS})`);
  }

  // ---- 3. harness ----
  const harness = harnessArg || null;

  // ---- 4. smoke test ----
  add(smokeRows, 'smoke test', 'skipped', 'not requested; ca onboard --smoke runs a throwaway probe lane');

  // ---- output ----
  const steps = [...envRows, ...repoRows, ...harnessRows, ...smokeRows];
  const fails = steps.filter((s) => s.status === 'fail').length;
  const ready = fails === 0;
  const next = [];
  if (!harness) next.push(`ca onboard --harness <${HARNESSES.join('|')}>`);
  next.push(`Dashboard: ${DASH}`);

  if (asJson) console.log(JSON.stringify({ harness, repo, ready, steps, next }, null, 2));
  else {
    const L = (s) => process.stdout.write(s + '\n');
    const W = 7;
    const show = { ok: 'ok', warn: 'warn', fail: 'FAIL', fixed: 'fixed', planned: 'planned', skipped: 'skipped' };
    L('CodeArts lanes onboarding');
    L(`repo: ${repo}${harness ? `  harness: ${harness}` : ''}`);
    const section = (n, title, rows) => {
      L('');
      L(`${n}. ${title}`);
      for (const r of rows) {
        L(`  ${(show[r.status] || r.status).padEnd(W)}  ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
        if (r.fix && ['fail', 'warn', 'planned'].includes(r.status)) for (const ln of String(r.fix).split(/\r?\n/)) L(`${' '.repeat(W + 4)}${ln}`);
      }
    };
    section(1, 'Environment', envRows);
    section(2, 'Repository', repoRows);
    section(3, 'Harness', harnessRows);
    section(4, 'Smoke test', smokeRows);
    L('');
    L('Next:');
    for (const n of next) L(`  - ${n}`);
    L('');
    L(ready ? 'onboard: ready' : `onboard: not ready (${fails} to fix)`);
  }
  process.exit(ready ? 0 : 1);
}

// y/N prompt on a TTY; never called without one (non-interactive runs never read stdin).
function askLine() {
  return new Promise((res) => {
    const on = (d) => { process.stdin.removeListener('data', on); process.stdin.pause(); res(d.toString().replace(/\r?\n$/, '')); };
    process.stdin.resume(); process.stdin.on('data', on);
  });
}
async function confirm(q) { process.stdout.write(`${q} [y/N] `); return /^y(es)?$/i.test((await askLine()).trim()); }
