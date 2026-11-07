#!/usr/bin/env node
// runner/onboard.mjs: guided first-run setup for the CodeArts lanes runner, called by
// `ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json] [--repo-only]`.
// It walks the environment (doctor rows), the repo (git, trusted folder), the harness
// (marker detection + `ca setup`) and, only with --smoke, a throwaway probe lane.
// The default scope is machine-wide (`ca setup <h> <repo> --user`); --repo-only keeps the old
// repo-level setup (`ca setup <h> <repo>`).
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
const EXE = process.env.CODEARTS_EXE || path.join(CA_HOME, 'installers', 'bin', process.platform === 'win32' ? 'codearts.exe' : 'codearts');
const INSTALL_BASE = 'https://apsoutheast1-cloudide-marketplace.obs.ap-southeast-1.myhuaweicloud.com/codearts/cli_tui/install_script';
// The official installer. CA_INSTALL_CMD overrides it (a shell command line; used by the checks).
const INSTALL = process.env.CA_INSTALL_CMD
  ? { cmd: process.env.CA_INSTALL_CMD, args: [], shell: true, show: process.env.CA_INSTALL_CMD }
  : process.platform === 'win32'
    ? { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${INSTALL_BASE}/install.ps1 | iex`], show: `irm ${INSTALL_BASE}/install.ps1 | iex` }
    : { cmd: 'bash', args: ['-c', `curl -fsSL ${INSTALL_BASE}/install.sh | bash`], show: `curl -fsSL ${INSTALL_BASE}/install.sh | bash` };
const SETTINGS = process.env.CA_SETTINGS || path.join(CA_HOME, 'cli-data', 'settings.json');
const HARNESSES = ['kiro', 'cursor', 'claude', 'codex', 'vscode', 'opencode'];
// Marker -> harness, first match wins (.claude/CLAUDE.md -> claude, .codex/AGENTS.md -> codex).
const MARKERS = [['kiro', '.kiro'], ['cursor', '.cursor'], ['claude', '.claude'], ['claude', 'CLAUDE.md'], ['opencode', 'opencode.json'], ['opencode', '.opencode'], ['codex', '.codex'], ['codex', 'AGENTS.md'], ['vscode', '.vscode']];
const HARNESS_NEXT = {
  kiro: 'In Kiro chat: #codearts-lanes then describe the goal',
  cursor: 'In Cursor chat: @codearts-lanes then describe the goal',
  claude: 'Restart Claude Code in this repo (or run /mcp), then type: /codearts-build <goal>',
  codex: 'In Codex: ask it to follow AGENTS.md CodeArts lanes section',
  vscode: 'In VS Code chat (agent mode): use the codearts MCP tools',
  opencode: 'In opencode: ask it to follow the CodeArts lanes section of AGENTS.md (codearts MCP tools)',
};
// Machine-wide scope: the MCP server and rules are installed once, so these work in any repo.
const HARNESS_NEXT_USER = {
  kiro: 'Restart Kiro, then in any repo type: #codearts-lanes <goal>',
  cursor: 'Restart Cursor, then in any repo ask: use CodeArts lanes to <goal>',
  claude: 'Restart Claude Code (or run /mcp), then in any repo type: /codearts-build <goal>',
  codex: 'Restart Codex, then in any repo ask: use CodeArts lanes to <goal>',
  vscode: 'Restart VS Code, then in any repo ask: use CodeArts lanes to <goal>',
  opencode: 'Restart opencode, then in any repo ask: use CodeArts lanes to <goal>',
};
const PORTAL = 'https://codearts.ap-southeast-1.huaweicloud.com/portal/settings/cli-auth';
const DASH = 'http://127.0.0.1:4777';
const oneLine = (s, n = 200) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h`; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, input: '', ...opts });
const git = (cwd, ...args) => run('git', args, { cwd });
const usage = (msg) => { process.stderr.write(`${msg}\nusage: ca onboard [--harness h] [--repo dir] [--yes] [--smoke] [--dry-run] [--json] [--repo-only]\n`); process.exit(2); };

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
// Base dir for the throwaway smoke repo: prefer ~/.t3/scratch, else the first trusted
// folder that exists and is writable, else the OS temp dir when it is trusted.
function pickSmokeBase() {
  const { obj } = loadSettings();
  const trusted = trustedList(obj);
  const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
  const scratch = path.join(os.homedir(), '.t3', 'scratch');
  if (fs.existsSync(scratch) && writable(scratch)) return scratch;
  for (const t of trusted) { const p = path.resolve(t); if (fs.existsSync(p) && writable(p)) return p; }
  const tmp = os.tmpdir();
  if (isUnder(trusted, tmp)) return tmp;
  return null;
}

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
  const scope = flags.has('--repo-only') ? 'repo' : 'user';
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
    const credFix = (what) => [`run: ca auth   (opens a local form for the human; then: ca auth --wait)`, `${what} at ${PORTAL}`].join('\n');
    for (const c of docChecks) {
      if (/^trusted folder$/i.test(c.name)) continue; // section 2 checks and fixes it
      let fix = c.fix || '';
      if (/^credentials$/i.test(c.name) && c.status !== 'ok') fix = credFix('the human creates an AK/SK');
      else if (/^maas key$/i.test(c.name) && c.status !== 'ok') fix = 'optional: ca auth --force (the form takes a MaaS API key from the Huawei Cloud ModelArts MaaS console)';
      add(envRows, c.name, c.status, c.detail || '', fix);
    }
    if (interactive) await offerSecrets(envRows);
    await offerInstall(envRows, { yes, dry, interactive, asJson });
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
      const re = loadSettings(); // re-read: keep every other setting
      if (re.err) add(repoRows, 'trusted folder', 'fail', `cannot parse ${SETTINGS}: ${re.err}`, 'fix the JSON (or rename the file) and rerun; nothing was overwritten');
      else {
        const obj = re.obj;
        obj.security = obj.security && typeof obj.security === 'object' && !Array.isArray(obj.security) ? obj.security : {};
        if (!Array.isArray(obj.security.trustedFolders)) obj.security.trustedFolders = [];
        if (!isUnder(obj.security.trustedFolders.map(String).filter(Boolean), repo)) obj.security.trustedFolders.push(repo);
        fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
        fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
        add(repoRows, 'trusted folder', 'fixed', `added ${repo} to security.trustedFolders`);
      }
    } else add(repoRows, 'trusted folder', 'planned', `${repo} is not in security.trustedFolders`, `ca onboard --yes adds it (or add it to ${SETTINGS})`);
  }

  // ---- 3. harness: detect from markers (--harness overrides), then run ca setup ----
  let harness = harnessArg || null;
  let via = harnessArg ? `--harness ${harnessArg}` : '';
  if (!harness) {
    const hit = MARKERS.find(([, m]) => fs.existsSync(path.join(repo, m)));
    if (hit) { harness = hit[0]; via = `detected from ${hit[1]}`; }
  }
  if (!harness) {
    add(harnessRows, 'harness', 'warn', 'no harness detected (no .kiro, .cursor, .claude or CLAUDE.md, .codex or AGENTS.md, .vscode, opencode.json)', `ca onboard --harness <${HARNESSES.join('|')}>`);
  } else {
    add(harnessRows, 'harness', 'ok', `${harness} (${via})`);
    const setupArgs = [CA_MJS, 'setup', harness, repo, ...(dry ? ['--dry-run'] : []), ...(scope === 'repo' ? [] : ['--user'])];
    if (dry) {
      const r = run(process.execPath, setupArgs, { timeout: 30000 });
      if (r.status !== 0) add(harnessRows, 'harness setup', 'fail', `ca setup ${harness} --dry-run exited ${r.status ?? '?'}: ${oneLine(r.stderr || r.stdout, 180)}`, `run node ca.mjs setup ${harness} ${repo}`);
      else {
        const planned = (r.stdout || '').split(/\r?\n/).map((l) => l.trim())
          .filter((l) => { const lo = l.toLowerCase(); return lo === repo.toLowerCase() || lo.startsWith(repo.toLowerCase() + path.sep); });
        add(harnessRows, 'harness setup', 'planned', planned.length ? `would write: ${planned.join(', ')}` : `ca setup ${harness} ${repo} (dry run)`, 'ca onboard --yes');
      }
    } else {
      let doFix = yes;
      if (!doFix && interactive) doFix = await confirm(`Run ca setup ${harness} for ${repo} (writes the MCP server and rules config)?`);
      if (doFix) {
        const r = run(process.execPath, setupArgs, { timeout: 30000 });
        if (r.status !== 0) add(harnessRows, 'harness setup', 'fail', `ca setup ${harness} exited ${r.status ?? '?'}: ${oneLine(r.stderr || r.stdout, 180)}`, `run node ca.mjs setup ${harness} ${repo}`);
        else {
          const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
          const acts = lines.map((l) => l.match(/^(wrote|updated|unchanged) (.+)$/)).filter(Boolean);
          // "restart ..." notes repeat the Next line; paths inside the repo are shown relative.
          const notes = lines.filter((l) => !/^(wrote|updated|unchanged) /.test(l) && !/^\w+: restart /.test(l));
          const rel = (p) => { const r = path.relative(repo, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
          const detail = [acts.map((m) => `${m[1]} ${rel(m[2])}`).join(', '), ...notes.map((n) => oneLine(n, 140))].filter(Boolean).join('; ');
          add(harnessRows, 'harness setup', acts.some((m) => m[1] !== 'unchanged') ? 'fixed' : 'ok', detail || `ca setup ${harness} ran`);
        }
      } else add(harnessRows, 'harness setup', 'planned', `ca setup ${harness} ${repo} writes the MCP server and rules config`, 'ca onboard --yes');
    }
  }

  // ---- 4. smoke test: only with --smoke, never by default ----
  if (!smoke) add(smokeRows, 'smoke test', 'skipped', 'not requested; ca onboard --smoke runs a throwaway probe lane');
  else if (dry) add(smokeRows, 'smoke test', 'skipped', 'dry run: no lane started');
  else {
    const base = pickSmokeBase();
    if (!base) add(smokeRows, 'smoke test', 'warn', 'no writable trusted folder for a throwaway repo (tried ~/.t3/scratch, security.trustedFolders, the temp dir)', 'add a trusted folder (ca onboard --yes) and rerun with --smoke');
    else {
      const dir = path.join(base, `ca-smoke-${Math.floor(Date.now() / 1000)}`);
      let err = '';
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (git(dir, 'init').status !== 0) err = 'git init failed';
        if (!err) {
          let c = git(dir, 'commit', '--allow-empty', '-m', 'init');
          if (c.status !== 0) c = git(dir, '-c', 'user.email=ca@localhost', '-c', 'user.name=ca', 'commit', '--allow-empty', '-m', 'init');
          if (c.status !== 0) err = oneLine(c.stderr, 140);
        }
        if (!err) {
          fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'tasks', 'probe.md'), 'Run `git log --oneline -1` with your bash tool once, reply with its output.\n');
        }
      } catch (e) { err = e.message; }
      if (err) add(smokeRows, 'smoke test', 'fail', `could not prepare ${dir}: ${err}`);
      else {
        const t0 = Date.now();
        const r = run(process.execPath, [CA_MJS, 'lane', dir, 'probe'], { timeout: 180000, env: { ...process.env, NO_REVIEW: '1' } });
        const took = dur(Date.now() - t0);
        if (r.status === 0) add(smokeRows, 'smoke test', 'ok', `probe lane done in ${took} (${dir})`);
        else add(smokeRows, 'smoke test', 'fail', `probe lane failed (exit ${r.status ?? '?'}) in ${took}: ${oneLine((r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '), 180)}`, `see ${path.join(dir, 'tasks', 'probe.lane')}`);
      }
    }
  }

  // ---- output ----
  const steps = [...envRows, ...repoRows, ...harnessRows, ...smokeRows];
  const fails = steps.filter((s) => s.status === 'fail').length;
  const ready = fails === 0;
  const next = [];
  if (!harness) next.push(`ca onboard --harness <${HARNESSES.join('|')}>`);
  else next.push(scope === 'repo' ? HARNESS_NEXT[harness] : HARNESS_NEXT_USER[harness]);
  next.push(`Dashboard: ${DASH}`);

  if (asJson) console.log(JSON.stringify({ harness, repo, scope, ready, steps, next }, null, 2));
  else {
    const L = (s) => process.stdout.write(s + '\n');
    const W = 7;
    const show = { ok: 'ok', warn: 'warn', fail: 'FAIL', fixed: 'fixed', planned: 'planned', skipped: 'skipped' };
    L('CodeArts lanes onboarding');
    L(`repo: ${repo}${harness ? `  harness: ${harness}` : ''}`);
    L(`scope: ${scope === 'repo' ? 'this repo' : 'machine-wide'}`);
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

// Hidden input on a TTY: raw mode, nothing echoed; Enter returns the value, Ctrl-C exits,
// backspace edits. Only reached in interactive mode, so isTTY is guaranteed.
function askHidden(prompt) {
  return new Promise((res) => {
    process.stdout.write(prompt);
    let buf = Buffer.alloc(0);
    const finish = () => {
      process.stdin.removeListener('data', on);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      res(buf.toString('utf8'));
    };
    const on = (d) => {
      for (const b of d) {
        if (b === 0x0d || b === 0x0a) return finish();
        if (b === 0x03) { process.stdout.write('^C\n'); process.exit(130); }
        if (b === 0x08 || b === 0x7f) { buf = buf.subarray(0, -1); continue; }
        buf = Buffer.concat([buf, Buffer.from([b])]);
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', on);
  });
}

// Store one user-level env var via PowerShell. The secret travels in the child process
// env (CA_ONBOARD_SECRET), never on the command line, and is never printed or logged.
function storeUserEnv(name, value) {
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Environment]::SetEnvironmentVariable('${name}', $env:CA_ONBOARD_SECRET, 'User')`],
    { env: { ...process.env, CA_ONBOARD_SECRET: value }, timeout: 20000 });
  return r.status === 0;
}

// Missing CodeArts CLI: run the official installer with --yes (or after y/N on a TTY),
// plan it with --dry-run. The row turns fixed only when the executable really exists.
async function offerInstall(rows, { yes, dry, interactive, asJson }) {
  const r = rows.find((x) => x.name.toLowerCase() === 'codearts' && x.status === 'fail' && /not found/.test(x.detail));
  if (!r) return;
  if (dry) { r.status = 'planned'; r.detail = `not installed; ca onboard --yes runs the official installer`; r.fix = INSTALL.show; return; }
  let doFix = yes;
  if (!doFix && interactive) doFix = await confirm('Install the CodeArts Agent CLI now (official Huawei Cloud installer)?');
  if (!doFix) { r.fix = `${INSTALL.show}\nor: ca onboard --yes`; return; }
  if (!asJson) process.stdout.write(`installing the CodeArts CLI: ${INSTALL.show}\n`);
  const res = spawnSync(INSTALL.cmd, INSTALL.args, { stdio: asJson ? ['ignore', 'ignore', 'pipe'] : 'inherit', shell: !!INSTALL.shell, timeout: 600000, windowsHide: true, encoding: 'utf8' });
  if (fs.existsSync(EXE)) {
    r.status = 'fixed'; r.detail = `installed at ${EXE}`; r.fix = '';
  } else {
    r.detail = `installer ${res.status === 0 ? 'finished' : `failed (exit ${res.status ?? res.error?.code ?? '?'})`} but ${EXE} is still missing`;
    r.fix = `run it by hand and read its output: ${INSTALL.show}`;
  }
}

// Interactive only: for a failing/warning credentials or maas key row, offer to type the
// missing keys with hidden input and store them in the user environment right away.
async function offerSecrets(rows) {
  const groups = [
    { name: 'credentials', keys: ['CODEARTS_CLI_AK', 'CODEARTS_CLI_SK'], what: 'CodeArts AK/SK' },
    { name: 'maas key', keys: ['MAAS_API_KEY'], what: 'MaaS API key' },
  ];
  for (const g of groups) {
    const r = rows.find((x) => x.name.toLowerCase() === g.name && ['fail', 'warn'].includes(x.status));
    if (!r) continue;
    const missing = g.keys.filter((k) => !process.env[k]);
    if (!missing.length) continue;
    if (!(await confirm(`Enter the missing ${g.what} (${missing.join(', ')}) now and store it in the user environment? Input is hidden`))) continue;
    const vals = [];
    for (const k of missing) {
      const v = await askHidden(`${k}: `);
      if (!v) break;
      vals.push([k, v]);
    }
    if (vals.length < missing.length) { process.stdout.write('  skipped, no value entered (the manual steps below still apply)\n'); continue; }
    const failed = [];
    for (const [k, v] of vals) {
      process.env[k] = v; // this run sees it too (the smoke lane inherits our env)
      if (!storeUserEnv(k, v)) failed.push(k);
    }
    if (!failed.length) {
      r.status = 'fixed';
      r.detail = `${missing.join(', ')} stored in the user environment; open a new terminal so other programs see it`;
      r.fix = '';
    } else {
      const done = vals.map(([k]) => k).filter((k) => !failed.includes(k));
      r.detail = `${r.detail}; could not store ${failed.join(', ')} automatically (PowerShell failed)${done.length ? `, stored ${done.join(', ')}` : ''}`;
    }
  }
}
