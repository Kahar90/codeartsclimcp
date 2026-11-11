import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import authCmd from './auth.mjs';
import { laneRow, laneStatusOf, printRows, statusRow, updateNotice } from './commands.mjs';
import { EXE, HERE, INSTALL_HINT, SETTINGS, SKILL, alive, briefWarningLines, briefWarningsFor, caEnv, dashUrl, die, dur, findLane, git, health, hhmmss, laneId, now, oneLine, readJSON, resultOf, sleep, stepProgress, userEnv, workerShell, writeProbe } from './common.mjs';
import { tokenTotal } from './tokens.mjs';

// ---------- engineer workflow: setup, wait, summary, init, doctor ----------
export async function cmdSetup(args) {
  const f = path.join(HERE, 'setup.mjs');
  if (!fs.existsSync(f)) die('setup not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('setup.mjs has no default export', 2);
  await mod.default(args);
}
// `ca auth ...`: get the keys from the human through a local form (runner/auth.mjs).
export async function cmdAuth(args) { await authCmd(args); }
// `ca onboard ...`: guided first-run setup, implemented in runner/onboard.mjs.
export async function cmdOnboard(args) {
  const f = path.join(HERE, 'onboard.mjs');
  if (!fs.existsSync(f)) die('onboard not installed', 2);
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.default !== 'function') die('onboard.mjs has no default export', 2);
  await mod.default(args);
}
// Exit code of a finished lane, from the usage table: 0 done (review ready or skipped),
// 1 failed/stopped/killed, 3 missing credentials, 4 needs review.
export function laneExit(s) {
  if (s.result === 'done') return !s.verdict || s.verdict === 'ready' ? 0 : 4;
  if (s.result === 'needs review') return 4;
  if (s.result === 'unverified') return 4;
  if (resultOf(s) === 'paused') return 5;
  if (s.result === 'failed' && s.exitCode === 3) return 3;
  return 1;
}
export const exitRank = (c) => ({ 1: 4, 3: 3, 5: 2, 4: 1 }[c] ?? 0);
export const worstExit = (codes) => codes.reduce((a, b) => (exitRank(b) > exitRank(a) ? b : a), 0);
// The compact `ca wait --json --compact` row: only what a lead needs to decide and call again, so the
// context stays small when many lanes are watched. `next` is the per-lane action for its exit code.
export const WAIT_NEXT = {
  0: 'read ca_summary for each lane and verify the work',
  1: 'read ca_summary; ca_resume continues a failed, stopped or checks-failing lane with a note',
  3: 'keys missing or rejected: ask the human to run ca auth (never ask for keys in chat), then ca_resume the lane',
  4: 'read ca_summary: the reviewer asked for changes, or the checks could not run (unverified)',
  5: 'paused at LANE_TIMEOUT: ca_resume the lane to continue where it stopped',
  124: 'still running: call ca wait again',
};
export function compactWaitRow(l, s) {
  const st = laneStatusOf(l, s); const pg = stepProgress(s);
  return { lane: l.id, status: { key: st.key, label: st.label, attention: st.attention }, progress: `${pg.done}/${pg.total}`,
    commits: s.commits || 0, tokens: tokenTotal(s.tokens), next: WAIT_NEXT[s.result ? laneExit(s) : 124] || '' };
}
// --steps: the lead wakes when a lane commits a NEW step instead of only when the lane ends, so it can
// look at the step (screenshot the ui files) and steer early. stepOf reads "step N" from a commit subject
// (null when the subject is not a step). stepFiles is the diff of the first new commit's parent against the
// last new commit, capped at 50 (a step that rewrites many files still fits one line); empty when the repo
// is gone or the first new commit has no parent.
export const UI_EXT = /\.(html|css|js|mjs|ts|tsx|jsx|vue|svelte|svg|png)$/i;
export const stepOf = (subject) => { const m = String(subject || '').match(/^\s*step\s+(\d+)\s*:/i); return m ? Number(m[1]) : null; };
export function stepFiles(repo, fresh) {
  if (!fresh.length) return [];
  const first = fresh[0].hash; const last = fresh[fresh.length - 1].hash;
  const out = git(repo, 'diff', '--name-only', `${first}^`, last);
  return out ? out.split(/\r?\n/).filter(Boolean).slice(0, 50) : [];
}
// The lane's commit log read live from the lane repo: state.json is refreshed by the supervisor at most
// every 5 s inside a turn, so a step committed shortly before the lane ends can be invisible there and the
// finished-lane rule would win. git is the source of truth; fall back to state.json only without a start.
export function liveLog(l, s) {
  if (!l.repo || !s || !s.start) return (s && s.commitLog) || [];
  const out = git(l.repo, 'log', '--reverse', '--format=%h%x09%s', `${s.start}..HEAD`);
  if (!out) return [];
  return out.split(/\r?\n/).map((ln) => { const [hash, ...r] = ln.split('\t'); return { hash, subject: oneLine(r.join(' '), 160) }; });
}
export function stepEvent(l, log, base) {
  const fresh = log.slice(base);
  const files = stepFiles(l.repo, fresh);
  return { lane: l.id, commits: log.length, new: fresh.map((c) => ({ hash: c.hash, subject: c.subject, step: stepOf(c.subject) })), files, ui: files.some((f) => UI_EXT.test(f)) };
}
// Has the lead answered this blocker by file, before the supervisor consumed it? A BLOCKER_ACK, or a
// lead steer in the inbox queued after the blocker (step-review and runner notices do not count).
export function blockerAnswered(dir, blocker) {
  try {
    if (fs.existsSync(path.join(dir, 'BLOCKER_ACK'))) return true;
    const at = Number(blocker && blocker.at) || 0;
    return fs.readdirSync(path.join(dir, 'inbox')).some((f) => f.endsWith('.txt') && !/stepreview|question|sleep|helper|nudge/i.test(f) && (Number((f.match(/^(\d+)/) || [])[1]) || 0) > at);
  } catch { return false; }
}
export async function cmdWait(args) {
  const asJson = args.includes('--json'); const quiet = args.includes('--quiet');
  // --compact: with --json, return only the small per-lane decision rows a lead reads when many lanes
  // run at once. MCP ca_wait turns it on by default.
  const wantCompact = args.includes('--compact');
  // --any returns as soon as one lane has a result, so a lead watching parallel lanes sees an early
  // failure at once instead of waiting for the slowest lane. Others are listed as still running.
  const any = args.includes('--any');
  const usage = 'usage: ca wait <lane...> [--any] [--timeout S] [--json] [--compact] [--quiet] [--steps] [--after N|lane=N,...]';
  const ti = args.indexOf('--timeout');
  const timeoutS = ti >= 0 ? Number(args[ti + 1]) : NaN;
  if (ti >= 0 && (!Number.isFinite(timeoutS) || timeoutS < 0)) die(usage, 2);
  // --steps wakes the lead at each new commit; --after sets the baseline (a count for every lane, or a
  // lane=count list). A bad value is a usage error, with or without --steps.
  const stepsMode = args.includes('--steps');
  const ai = args.indexOf('--after');
  const afterRaw = ai >= 0 ? args[ai + 1] : '';
  let afterCount = null; let afterMap = null;
  if (ai >= 0) {
    if (!afterRaw || afterRaw.startsWith('--')) die(usage, 2);
    if (/^\d+$/.test(afterRaw)) afterCount = Number(afterRaw);
    else { afterMap = {}; for (const part of afterRaw.split(',')) { const m = part.match(/^(.+)=(\d+)$/); if (!m) die(usage, 2); afterMap[m[1]] = Number(m[2]); } }
  }
  const qs = args.filter((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1) && !(ai >= 0 && i === ai + 1));
  if (!qs.length) die(usage, 2);
  const targets = qs.map((q) => findLane(q)); // resolve every lane first: unknown -> exit 2
  const readState = (l) => readJSON(path.join(l.dir, 'state.json')) || l.s;
  // Baseline per lane: the --after value (keyed by lane id or task name), or the live commit count at wait
  // start, read the same way the loop compares it (git), so a resumed lane whose state.json count was reset
  // does not report its old commits as new.
  const baseline = new Map();
  const afterFor = (l) => { if (!afterMap) return undefined; for (const k of [l.id, l.task]) if (k && Object.prototype.hasOwnProperty.call(afterMap, k)) return afterMap[k]; return undefined; };
  for (const l of targets) { const a = afterFor(l); baseline.set(l.id, afterCount !== null ? afterCount : a !== undefined ? a : liveLog(l, readState(l)).length); }
  const deadline = Number.isFinite(timeoutS) && timeoutS > 0 ? now() + timeoutS * 1000 : Infinity;
  const last = new Map(); let lastBeat = 0;
  const note = (l, s) => {
    const pg = stepProgress(s);
    process.stderr.write(`[${hhmmss()}] ${l.id} ${health(s)} phase ${s.phase} step ${pg.done}/${pg.total} idle ${s.result ? '-' : dur(now() - (s.lastEventAt || s.startedAt))} now ${oneLine(s.activity, 70)}\n`);
  };
  for (;;) {
    const states = targets.map((l) => {
      const s = readState(l);
      return { l, s: !s.result && !alive(s.pid) ? { ...s, result: 'failed', reason: 'supervisor gone' } : s };
    });
    for (const { l, s } of states) {
      const pg = stepProgress(s);
      const key = `${health(s)}|${s.phase}|${pg.current?.n ?? ''}`;
      if (last.get(l.id) !== key) { last.set(l.id, key); if (!quiet) note(l, s); }
    }
    const finished = states.filter(({ s }) => s.result);
    if (any ? finished.length > 0 : states.every(({ s }) => s.result)) {
      const objs = finished.map(({ l, s }) => ({ lane: l.id, result: s.result, status: laneStatusOf(l, s), verdict: s.verdict || '', exit: laneExit(s),
        summaryPath: fs.existsSync(path.join(l.dir, 'summary.md')) ? path.join(l.dir, 'summary.md') : null }));
      const runningStates = states.filter(({ s }) => !s.result);
      const running = runningStates.map(({ l }) => l);
      for (const o of objs) process.stdout.write(`CA_RESULT ${JSON.stringify(o)}\n`);
      if (asJson) {
        const lanes = wantCompact ? finished.map(({ l, s }) => compactWaitRow(l, s)) : objs;
        // Render every still-running row from the state just read, never from the lane object's memo.
        const run = wantCompact ? runningStates.map(({ l, s }) => compactWaitRow(l, s)) : runningStates.map(({ l, s }) => statusRow({ ...l, s }));
        process.stdout.write(JSON.stringify(any ? { lanes, any: true, running: run } : { lanes }) + '\n');
      } else if (any && running.length) process.stdout.write(`still running: ${running.map((l) => l.id).join(', ')}\n`);
      process.exit(worstExit(objs.map((o) => o.exit)));
    }
    // Blocked rule: a running lane with an open blocker reaches the lead at once (exit 11), so a worker's
    // question or a silent run is answered long before the lane ends. The finished-lane rule above wins.
    // A blocker the lead already answered (a ca steer queued after it, or a ca ack) is cleared by the
    // supervisor on its next tick; until then state.json still shows it. Skip it here, or a wait called
    // right after the answer wakes the lead again with the very blocker it just handled.
    const blockedStates = states.filter(({ l, s }) => !s.result && s.blocker && !blockerAnswered(l.dir, s.blocker));
    if (blockedStates.length) {
      const blocked = blockedStates.map(({ l, s }) => ({ lane: l.id, kind: s.blocker.kind, text: s.blocker.text, at: s.blocker.at }));
      for (const o of blocked) process.stdout.write(`CA_BLOCKED ${JSON.stringify(o)}\n`);
      if (asJson) {
        const running = states.filter(({ s }) => !s.result && !s.blocker).map(({ l, s }) => (wantCompact ? compactWaitRow(l, s) : statusRow({ ...l, s })));
        process.stdout.write(JSON.stringify({ blocked, running }) + '\n');
      }
      process.exit(11);
    }
    // --steps: a lane that passed its baseline has a new step. Wake the lead with one CA_STEP line per
    // such lane and exit 10; the finished-lane rule above wins, so an ended lane still reports its result.
    if (stepsMode) {
      const evs = states.map(({ l, s }) => ({ l, log: liveLog(l, s) })).filter(({ l, log }) => log.length > baseline.get(l.id)).map(({ l, log }) => stepEvent(l, log, baseline.get(l.id)));
      if (evs.length) {
        for (const o of evs) process.stdout.write(`CA_STEP ${JSON.stringify(o)}\n`);
        if (asJson) {
          const hit = new Set(evs.map((o) => o.lane));
          process.stdout.write(JSON.stringify({ steps: evs, running: states.filter(({ l }) => !hit.has(l.id)).map(({ l, s }) => compactWaitRow(l, s)) }) + '\n');
        }
        process.exit(10);
      }
    }
    if (now() >= deadline) {
      const runningStates = states.filter(({ s }) => !s.result);
      // The timeout rows render the state read this tick (phase, activity, tools), not the lane
      // object's snapshot from when ca wait started: a lane that moved from starting to build is shown
      // as it is now, so a lead reading the timeout text sees the latest phase and tool.
      if (asJson) console.log(JSON.stringify({ timeout: true, waitedS: timeoutS, lanes: wantCompact ? runningStates.map(({ l, s }) => compactWaitRow(l, s)) : runningStates.map(({ l, s }) => statusRow({ ...l, s })) }));
      else { console.log(`wait: timeout after ${timeoutS}s; still running:`); printRows(runningStates.map(({ l, s }) => laneRow({ ...l, s }))); }
      process.exit(124);
    }
    if (!lastBeat) lastBeat = now();
    else if (now() - lastBeat >= 60000) { lastBeat = now(); if (!quiet) for (const { l, s } of states) if (!s.result) note(l, s); }
    // --steps polls faster: a step commit can be followed by the lane ending well inside the 2 s poll
    // window, and the finished-lane rule would then win over the step event. 500 ms keeps the lead ahead.
    await sleep(Math.min(stepsMode ? 500 : 2000, deadline - now()));
  }
}
export function cmdInit(args) {
  const gi = args.indexOf('--goal');
  const goal = gi >= 0 ? args[gi + 1] : '';
  if (gi >= 0 && !goal) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1));
  const [repoArg, task] = pos;
  if (!repoArg || !task) die('usage: ca init <repo> <task> [--goal "<text>"] [--force]', 2);
  const repo = path.resolve(repoArg);
  const file = path.join(repo, 'tasks', `${task}.md`);
  if (fs.existsSync(file) && !args.includes('--force')) die(`${file} exists (use --force to overwrite)`, 2);
  const tpl = fs.readFileSync(path.join(SKILL, 'templates', 'brief.md'), 'utf8');
  fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.writeFileSync(file, tpl.replace(/<one sentence goal[^>]*>/, goal || 'TODO: goal'));
  console.log(`brief: ${file}`);
  if (!git(repo, 'rev-parse', '--git-dir')) console.log('not a git repo yet: run git init && git commit --allow-empty -m init');
  console.log(`next: ca lane ${repoArg} ${task} --detach`);
  console.log(`      ca wait ${laneId(repo, task)}`);
}
// `ca brief-check <repo> <task> [--json]`: print the brief warnings a lead should fix before a lane
// starts. Warnings never block a lane; the command always exits 0, so a missing brief just has none.
export function cmdBriefCheck(args) {
  const asJson = args.includes('--json');
  const [repoArg, task] = args.filter((a) => !a.startsWith('--'));
  if (!repoArg || !task) die('usage: ca brief-check <repo> <task> [--json]', 2);
  const repo = path.resolve(repoArg);
  const warnings = briefWarningsFor(repo, task) || [];
  if (asJson) { console.log(JSON.stringify({ warnings }, null, 2)); return; }
  if (!warnings.length) console.log('brief: no warnings');
  else for (const t of briefWarningLines(warnings)) console.log(`brief warning: ${t}`);
}
// `ca workspace <repo> <task>`: prepare a parallel lane workspace as a LOCAL CLONE
// (../<repo-name>-wt-<task>) on a new branch lane/<task>, from --from (default: the repo's current
// branch). A clone keeps .git inside the lane folder, so the CodeArts sandbox can commit there; a
// git worktree keeps its git dir in the main repo (outside the folder) and every sandboxed commit
// fails with "Permission denied". `--land` fetches lane/<task> from the clone into <repo>, merges it
// (refusing on a dirty main tree), then deletes the clone folder.
export function cmdWorkspace(args) {
  const usage = 'usage: ca workspace <repo> <task> [--from <branch>] | ca workspace --land <repo> <task>';
  const land = args.includes('--land');
  const fi = args.indexOf('--from');
  const from = fi >= 0 ? args[fi + 1] : '';
  if (fi >= 0 && (!from || from.startsWith('--'))) die(usage, 2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1));
  const [repoArg, task] = pos;
  if (!repoArg || !task) die(usage, 2);
  const repo = path.resolve(repoArg);
  if (!git(repo, 'rev-parse', '--git-dir')) die(`not a git repo: ${repo}`, 2);
  const branch = `lane/${task}`;
  const clone = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${task}`);
  const run = (cwd, ...gargs) => spawnSync('git', gargs, { cwd, encoding: 'utf8', windowsHide: true });
  const fail = (what, r) => die(`${what}: ${oneLine(String((r.stderr || '') + (r.stdout || '')).trim(), 300)}`, 1);
  if (land) {
    if (!fs.existsSync(clone)) die(`no workspace to land: ${clone}`, 2);
    // tasks/ holds the plan and lane logs the lead and runner update while lanes run: they never block a land.
    const dirtyTree = git(repo, 'status', '--porcelain', '--', '.', ':!tasks');
    if (dirtyTree) die(`main tree is dirty in ${repo}: commit or stash first, then land\n${oneLine(dirtyTree, 200)}`, 1);
    const f = run(repo, 'fetch', clone, branch);
    if (f.status !== 0) fail('git fetch failed', f);
    const m = run(repo, 'merge', '--no-ff', 'FETCH_HEAD');
    if (m.status !== 0) die(`git merge failed (resolve it in ${repo}): ${oneLine(String((m.stderr || '') + (m.stdout || '')).trim(), 300)}`, 1);
    fs.rmSync(clone, { recursive: true, force: true });
    console.log(`landed ${branch} into ${repo}`);
    console.log(`removed ${clone}`);
    const log = git(repo, 'log', '--oneline', '-1');
    if (log) console.log(`head: ${log}`);
    return;
  }
  if (fs.existsSync(clone)) die(`workspace already exists: ${clone} (land or remove it first)`, 2);
  const c = run(path.dirname(repo), 'clone', '--local', '--no-hardlinks', repo, clone);
  if (c.status !== 0) fail('git clone failed', c);
  // The clone carries the source branches as origin/<name>; a sha needs the plain name, so fall back.
  const start = from || git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') || 'HEAD';
  let b = run(clone, 'checkout', '-b', branch, `origin/${start}`);
  if (b.status !== 0) b = run(clone, 'checkout', '-b', branch, start);
  if (b.status !== 0) fail('git checkout failed', b);
  // A brief the repo has not committed yet is not in the clone: copy it so the lane can read it.
  const briefSrc = path.join(repo, 'tasks', `${task}.md`);
  const briefDst = path.join(clone, 'tasks', `${task}.md`);
  if (fs.existsSync(briefSrc) && !fs.existsSync(briefDst)) { fs.mkdirSync(path.dirname(briefDst), { recursive: true }); fs.copyFileSync(briefSrc, briefDst); }
  console.log(`workspace: ${clone}`);
  console.log(`branch: ${branch} (from ${from || start})`);
  console.log(`start the lane: ca lane ${clone} ${task} --detach`);
  console.log(`merge back: git -C ${repo} fetch ${clone} ${branch} && git -C ${repo} merge --no-ff FETCH_HEAD`);
  console.log(`or: ca workspace --land ${repoArg} ${task}`);
}
// Preflight for engineers and agents: every row is ok | warn | fail, secrets are never printed.
// Shared by `ca doctor` and the dashboard's GET /api/doctor (same function, no subprocess).
export async function doctorData(repoArg) {
  const repo = path.resolve(repoArg || process.cwd());
  const rows = [];
  const add = (name, status, detail, fix = '') => rows.push({ name, status, detail, fix });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? '' : 'install Node 20 or newer');

  // One --version call per doctor run: the codearts version row reuses it (each call costs about a second).
  let caVersion = null;
  const firstLine = (s) => (String(s || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
  if (!fs.existsSync(EXE)) add('codearts', 'fail', `not found at ${EXE}`, `install the CodeArts CLI: ${INSTALL_HINT}`);
  else {
    const r = spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000, env: caEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const v = oneLine(((r.stdout || '') + ' ' + (r.stderr || '')).trim(), 120);
    if (r.status === 0) { caVersion = firstLine(r.stdout) || firstLine(r.stderr); add('codearts', 'ok', v || 'installed (no --version output)'); }
    else add('codearts', 'warn', r.error ? `could not run: ${oneLine(r.error.message, 100)}` : `--version exited ${r.status ?? '?'}${v ? ': ' + v : ''}`, 'run the codearts exe manually to check the install');
  }

  const missCred = [!userEnv('CODEARTS_CLI_AK') && 'CODEARTS_CLI_AK', !userEnv('CODEARTS_CLI_SK') && 'CODEARTS_CLI_SK'].filter(Boolean);
  add('credentials', missCred.length ? 'fail' : 'ok', missCred.length ? `missing ${missCred.join(', ')}` : 'set',
    missCred.length ? 'run: ca auth (local browser form; values are never printed)' : '');

  add('maas key', userEnv('MAAS_API_KEY') ? 'ok' : 'warn', userEnv('MAAS_API_KEY') ? 'set' : 'not set, falls back to CodeArts quota models',
    userEnv('MAAS_API_KEY') ? '' : 'ca auth --force adds MAAS_API_KEY for the MaaS models');

  const g = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  add('git', g.status === 0 ? 'ok' : 'fail', oneLine(((g.stdout || '') + (g.stderr || '')).trim(), 120) || 'git not found', g.status === 0 ? '' : 'install git');

  const settings = readJSON(SETTINGS) || {};
  const trusted = [].concat(settings.security?.trustedFolders || []).map(String);
  const underTrusted = (p) => { const a = path.resolve(p).toLowerCase(); return trusted.some((f) => { const b = path.resolve(f).toLowerCase(); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }); };
  add('trusted folder', underTrusted(repo) ? 'ok' : 'warn', underTrusted(repo) ? `${repo} is trusted` : `${repo} is not in security.trustedFolders`,
    underTrusted(repo) ? '' : `node ${path.join(SKILL, 'scripts', 'trust.mjs')} ${repo} (a ca lane run trusts the repo too)`);

  const sh = workerShell();
  const shOk = !!(sh && fs.existsSync(sh));
  add('shell', shOk ? 'ok' : 'fail', sh || 'no SHELL set', shOk ? '' : 'set SHELL or CA_SHELL to Git bash (Git\\bin\\bash.exe)');

  // A repo the lane cannot write to fails every commit, so nothing else works: fail the row hard.
  // A git worktree is writable by the runner but its git dir lives in the main repo, outside the lane
  // folder the CodeArts sandbox confines the worker to: warn so the lead uses a clone instead.
  const wp = writeProbe(repo);
  if (wp.worktree) {
    add('repo writable', 'warn', `git dir is outside the lane folder (${git(repo, 'rev-parse', '--absolute-git-dir')})`,
      'this is a git worktree: its git dir is outside the lane folder, so the CodeArts sandbox refuses commits; use `ca workspace` (a local clone) instead');
  } else {
    add('repo writable', wp.ok ? 'ok' : 'fail', wp.ok ? `wrote and removed a probe in ${repo}` : `${wp.where}: ${wp.error}`,
      wp.ok ? '' : process.platform === 'win32'
        ? 'Windows Controlled Folder Access or a sandbox ACL is blocking writes: allow git, Git Bash and node in Defender (Controlled Folder Access, Allow an app) or move the repo out of Documents'
        : 'check the folder permissions');
  }

  try {
    const r = await fetch(`${dashUrl()}/api/lanes`, { signal: AbortSignal.timeout(1500) });
    add('dashboard', r.ok ? 'ok' : 'warn', r.ok ? `running at ${dashUrl()}` : `HTTP ${r.status}`, r.ok ? '' : 'ca dash (lanes start it on demand)');
  } catch { add('dashboard', 'warn', 'not running, starts on demand', 'ca dash (lanes start it on demand)'); }

  const chromeCands = [process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const chromePath = chromeCands.find((c) => fs.existsSync(c));
  add('chrome', chromePath ? 'ok' : 'warn', chromePath || 'not found (optional, used by browser checks)', chromePath ? '' : 'install Google Chrome for the office and sprite checks');

  // Install lifecycle: recorded harness configs still pointing at this ca.mjs, and the installed
  // CodeArts version vs the last smoke-tested one. A broken lifecycle.mjs must never break doctor.
  try {
    const { lifecycleRows } = await import(pathToFileURL(path.join(HERE, 'lifecycle.mjs')).href);
    for (const row of await lifecycleRows({ version: caVersion })) rows.push(row);
  } catch {}

  const fails = rows.filter((r) => r.status === 'fail').length;
  return { checks: rows, fails };
}
export async function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const { checks, fails } = await doctorData(args.filter((a) => !a.startsWith('--'))[0]);
  if (asJson) console.log(JSON.stringify({ checks }, null, 2));
  else {
    // One readable line per row; the fix (if any) sits under it. No padded table.
    for (const r of checks) {
      console.log(`  ${String(r.status).padEnd(5)}  ${r.name}: ${r.detail}`);
      if (r.status !== 'ok' && r.fix) console.log(`         fix: ${r.fix}`);
    }
    console.log(`doctor: ${fails ? `not ready (${fails} fail)` : 'ready'}`);
  }
  if (fails) { await updateNotice(args); process.exit(1); }
}
export async function cmdMcp() {
  const f = path.join(HERE, 'mcp.mjs');
  if (!fs.existsSync(f)) die('mcp server not installed', 2);
  await import(pathToFileURL(f).href);
}

