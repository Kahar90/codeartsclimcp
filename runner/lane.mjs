import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { authProblem } from './authsignal.mjs';
import { CA_ENTRY, CFG, EXE, REG, SKILL, alive, briefWarningLines, briefWarningsFor, dashUrl, die, dur, ensureDash, git, health, hhmmss, killTree, laneId, lanes, now, oneLine, readJSON, resultOf, sleep, splitModel, stepProgress, workerShell, writeAtomic, writeProbe } from './common.mjs';
import { builderContext } from './context.mjs';
import { classifyCheck, commitFallbackDecision, commitRefused, sleepPoll } from './controls.mjs';
import { runOrdered } from './gate.mjs';
import { classifySignal, directCheckInvocation, noteFailure, toolFailureText, toolKey, uncommittedSteps, REPEAT_FAIL, SANDBOX_CHECK } from './signals.mjs';
import { detectSleep, isNetworkError, laneSlots, parseLimits, waitOnline } from './netwait.mjs';
import { ensurePlan, laneAlreadyPlanned } from './plan.mjs';
import { shouldDeferStepReview, stepReviewBlockers } from './reviewbudget.mjs';
import { Server } from './server.mjs';
import { selectToolProfile } from './toolprofile.mjs';
import { addStepTokens, emptyTokens, tokenTotal } from './tokens.mjs';
import { thinkStall } from './watchdog.mjs';

// ---------- lane supervisor ----------

export async function runLane(repoArg, task, opts = {}) {
  if (!repoArg || !task) die('usage: ca lane <repo> <task> [--detach]', 2);
  const repo = path.resolve(repoArg);
  const briefFile = path.join(repo, 'tasks', `${task}.md`);
  if (!task || !fs.existsSync(briefFile)) die(`usage: ca lane <repo> <task>   (needs ${briefFile})`, 2);
  // A brief copied from the template must not reach the builder with a placeholder CHECK line: the
  // runner would run the literal <...> text as a command. Refuse before anything is created.
  const briefEarly = fs.readFileSync(briefFile, 'utf8');
  const badCheck = [...briefEarly.matchAll(/^\s*(?:[-*]\s*)?CHECK:\s*`?(.+?)`?\s*$/gm)].map((m) => m[1]).find((c) => /<[^>]*>/.test(c));
  if (badCheck) die(`tasks/${task}.md still has a template placeholder CHECK line: "${badCheck}". Replace it with a real command or delete it.`, 2);
  if (!git(repo, 'rev-parse', '--git-dir')) die(`${repo} is not a git repo`, 2);
  const id = `${path.basename(repo)}--${task}`.replace(/[^\w.-]+/g, '_');
  process.env.CA_IN_LANE = id; // inherited by the codearts server and its worker: the lane never controls itself
  const dir = path.join(repo, 'tasks', `${task}.lane`);
  const prev = readJSON(path.join(dir, 'state.json'));
  if (prev && alive(prev.pid) && prev.pid !== process.pid && !prev.result) die(`lane ${id} is already running (pid ${prev.pid})`, 2);
  // --resume keeps the lane folder, its base commit, tokens and history; a fresh run starts clean.
  const resumed = opts.resume ? prev : null;
  if (opts.resume && !(prev && prev.result && prev.result !== 'done')) die(`nothing to resume: lane ${id} has no paused, stopped or failed run`, 2);
  // Request errors first (they need no CodeArts), then the install.
  if (!fs.existsSync(EXE)) die(`codearts not found at ${EXE}; ca onboard --yes installs it`, 2);
  if (!resumed) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.rmSync(path.join(dir, 'KICK'), { force: true }); // a stale kick must not fire at once on resume
  fs.rmSync(path.join(dir, 'STOP'), { force: true }); // nor the STOP that ended the previous run (resume after ca stop)
  fs.mkdirSync(REG, { recursive: true });
  fs.writeFileSync(path.join(REG, `${id}.json`), JSON.stringify({ id, dir, repo, task }, null, 2));

  // Keep CodeArts' folder and lane files out of commits.
  const gi = path.join(repo, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const want = ['.codeartsdoer/', 'tasks/*.lane/', 'tasks/*.lane.log', 'tasks/*.out'].filter((p) => !giText.split(/\r?\n/).includes(p));
  if (want.length) {
    fs.writeFileSync(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + want.join('\n') + '\n');
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'chore: ignore codearts state and lane files');
  }
  // Folder trust (prefix match in ~/.codeartsdoer/cli-data/settings.json).
  const tr = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'trust.mjs'), repo], { encoding: 'utf8', windowsHide: true });
  if (tr.status !== 0) die(`folder trust failed: ${tr.stderr}`, 4);

  const live = fs.openSync(path.join(dir, 'live.log'), 'a');
  const raw = fs.openSync(path.join(dir, 'events.jsonl'), 'a');
  const L = (s) => fs.writeSync(live, `${hhmmss()} ${s}\n`);
  const say = (s) => { L(s); process.stdout.write(`[${task} ${hhmmss()}] ${s}\n`); };
  const block = (prefix, text) => { for (const ln of String(text).replace(/\s+$/, '').split(/\r?\n/)) fs.writeSync(live, `         ${prefix}${ln}\n`); };

  const brief = fs.readFileSync(briefFile, 'utf8');
  const checks = [...brief.matchAll(/^\s*(?:[-*]\s*)?CHECK:\s*`?(.+?)`?\s*$/gm)].map((m) => m[1]);
  const stepList = [...brief.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: oneLine(m[2], 220) }));
  const stepCount = stepList.length;
  // Warn (never block) about a brief that protects a file it also changes or runs a missing CHECK file.
  const briefWarnings = briefWarningsFor(repo, task) || [];
  for (const t of briefWarningLines(briefWarnings)) say(`brief warning: ${t}`);
  // The worker's bash tool runs inside a sandbox that blocks the loopback network, so a check that
  // starts a local server hangs or fails there. Write a helper that asks this runner (outside the
  // sandbox) to run a CHECK line. Listing embeds the commands, so it needs no runner. Written now,
  // after the lane dir exists and before the first prompt.
  let HELPER_TEXT = '';
  {
    const helper = [
      '// Check service helper written by the runner for this lane. The CodeArts sandbox blocks the',
      '// loopback network, so a check that starts a local server hangs or fails in the worker shell.',
      '// This asks the runner (outside the sandbox) to run a CHECK line and prints its result.',
      `//   node tasks/${task}.lane/check.mjs        list the CHECK lines`,
      `//   node tasks/${task}.lane/check.mjs <N>    run CHECK line N (1-based)`,
      `//   node tasks/${task}.lane/check.mjs all     run every line in order, stop at the first failure`,
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const CHECKS = ' + JSON.stringify(checks) + ';',
      'const dir = path.dirname(path.resolve(process.argv[1]));',
      "const reqDir = path.join(dir, 'checkreq');",
      "const arg = String(process.argv[2] || '').trim();",
      'if (!arg) {',
      "  CHECKS.forEach((c, i) => console.log((i + 1) + '. ' + c));",
      '  process.exit(0);',
      '}',
      "const id = '' + Date.now() + Math.floor(Math.random() * 1e9);",
      'fs.mkdirSync(reqDir, { recursive: true });',
      "const reqFile = path.join(reqDir, id + '.json');",
      "const resFile = path.join(reqDir, id + '.result.json');",
      "fs.writeFileSync(reqFile + '.tmp', JSON.stringify({ id, arg, at: Date.now() })); fs.renameSync(reqFile + '.tmp', reqFile);",
      'const waitMs = (Number(process.env.CHECK_TIMEOUT) || 900) * 1000 + 60000;',
      'const deadline = Date.now() + waitMs;',
      'let res = null;',
      'while (Date.now() < deadline) {',
      "  try { res = JSON.parse(fs.readFileSync(resFile, 'utf8')); break; } catch {}",
      '  await new Promise((r) => setTimeout(r, 250));',
      '}',
      'if (!res) {',
      "  console.log('check service: the runner did not answer within ' + Math.round(waitMs / 1000) + 's');",
      "  console.log('exit 124');",
      '  try { fs.rmSync(reqFile, { force: true }); } catch {}',
      '  try { fs.rmSync(resFile, { force: true }); } catch {}',
      '  process.exit(124);',
      '}',
      "const out = String(res.out || '').replace(/\\s+$/, '');",
      'if (out) console.log(out);',
      "console.log('exit ' + res.code);",
      'try { fs.rmSync(reqFile, { force: true }); } catch {}',
      'try { fs.rmSync(resFile, { force: true }); } catch {}',
      'process.exit(res.code);',
      '',
    ].join('\n');
    HELPER_TEXT = helper;
    fs.writeFileSync(path.join(dir, 'check.mjs'), helper);
  }
  // The build prompt, the continuation brief and every gate fix round tell the worker to run a CHECK
  // line through that helper instead of its sandboxed shell.
  const CHECK_HELP = `\n\nRun a CHECK line with \`node tasks/${task}.lane/check.mjs <N>\` (1 = first line, \`all\` = every line, no argument lists them). It runs outside your sandbox, where the local network works, and prints the output and exit code. Use it instead of running a check command directly.`;
  // The runner owns tasks/<task>.lane/check.mjs: a worker that overwrites or deletes it gets it back
  // on the next tick, and at most once a minute a notice not to edit runner files (delivered like a steer).
  let lastHelperNotice = 0;
  const helperGuard = () => {
    let cur = ''; try { cur = fs.readFileSync(path.join(dir, 'check.mjs'), 'utf8'); } catch {}
    if (cur === HELPER_TEXT) return false;
    try { fs.writeFileSync(path.join(dir, 'check.mjs'), HELPER_TEXT); } catch { return false; }
    L(`helper restored (tasks/${task}.lane/check.mjs)`);
    if (now() - lastHelperNotice >= 60000) {
      lastHelperNotice = now();
      try { fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(dir, 'inbox', `${now()}-helper.txt`), `Message from the runner: do not edit runner files in tasks/${task}.lane/ (check.mjs was restored). Run checks with node tasks/${task}.lane/check.mjs <N>.`); } catch {}
    }
    return true;
  };
  // Orphan guard: a repo deleted out from under the lane (no .git for two ticks in a row) leaves the
  // supervisor running against a folder that is gone, so it stops itself and its own server.
  let repoGoneTicks = 0;
  const orphanGuard = () => {
    // The repo is gone when its git metadata is gone. A normal repo has `.git` as a directory with a
    // HEAD file; a linked worktree or submodule has `.git` as a file (a gitfile). Test the HEAD marker
    // for real repos too, because a restarted codearts server can recreate `.git/info/` (but not HEAD)
    // and otherwise make a deleted repo look present again.
    let gitAlive = false;
    try {
      const gitPath = path.join(repo, '.git');
      gitAlive = fs.lstatSync(gitPath).isDirectory() ? fs.existsSync(path.join(gitPath, 'HEAD')) : true;
    } catch { gitAlive = false; }
    if (gitAlive) { repoGoneTicks = 0; return false; }
    if (++repoGoneTicks < 2) return false;
    L('repo deleted: stopping');
    try { killTree(server?.child?.pid || S.server?.pid); } catch {}
    S.result = 'stopped'; S.exitCode = 1;
    S.phase = 'finished'; S.activity = 'repo deleted: stopping'; S.busy = false; S.finishedAt = now();
    try { save(true); } catch {}
    try { fs.rmSync(path.join(REG, `${id}.json`), { force: true }); } catch {}
    process.exit(1);
  };
  const BUILD = (brief.match(/^\s*MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.build;
  const FALLBACK = (brief.match(/^\s*FALLBACK_MODEL:\s*([\w.-]+\/[\w.-]+|none)/m) || [])[1] ?? CFG.thinkFallback;
  let buildModel = BUILD; // becomes FALLBACK after repeated thinking stalls
  const REVIEW = (brief.match(/^\s*REVIEW_MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.review;
  // Step reviews are an early warning, not the gate: they may use a faster model (STEP_REVIEW_MODEL env or brief line)
  // so they do not compete with the final review for the review model. The final review always uses REVIEW.
  const STEP_REVIEWER = (brief.match(/^\s*STEP_REVIEW_MODEL:\s*([\w.-]+\/[\w.-]+)/m) || [])[1] || CFG.stepReview || REVIEW;
  const stepReviewLine = (brief.match(/^\s*STEP_REVIEW:\s*([\w-]+)/m) || [])[1];
  const STEP_REVIEW = process.env.STEP_REVIEW !== '0' && !/^off$/i.test(stepReviewLine || '') && !CFG.noReview;
  // REVIEW_FIXES: how many review-fix rounds a final "needs fixes" verdict may trigger in place. A brief
  // line wins over the env var; the default is 1 and 0 restores the old "end the lane" behaviour.
  const reviewFixesLine = (brief.match(/^\s*REVIEW_FIXES:\s*(\d+)/m) || [])[1];
  const reviewFixesEnv = process.env.REVIEW_FIXES;
  const REVIEW_FIXES = reviewFixesLine !== undefined ? Math.max(0, Number(reviewFixesLine))
    : (reviewFixesEnv !== undefined && reviewFixesEnv !== '' && Number.isFinite(Number(reviewFixesEnv)) ? Math.max(0, Number(reviewFixesEnv)) : 1);
  // The tool profile for this lane: selected once from the brief header and the environment (an
  // explicit CA_TOOL_PROFILE wins, so a lead can force full for a broader task). It is handed to this
  // lane's private server only; the lane never writes process.env or user config, so the choice
  // cannot leak to another lane or the global config. Unknown values throw here, visibly.
  const TOOL_PROFILE_MODE = selectToolProfile(brief, process.env.CA_TOOL_PROFILE);
  const START = (resumed && resumed.start) || git(repo, 'rev-parse', 'HEAD');
  const dirtyAll = () => git(repo, 'status', '--porcelain').split(/\r?\n/).filter((l) => l && !/^.. "?(tasks\/|\.codeartsdoer)/.test(l));
  const PRE_DIRTY = new Set(dirtyAll());
  const T0 = now();

  const S = {
    v: 1, id, task, repo, dir, pid: process.pid, startedAt: T0, updatedAt: T0, phase: 'starting', attempt: 0, fixes: 0,
    server: null, buildSession: null, reviewSession: null, activeSession: null, busy: false, sse: false,
    lastEventAt: T0, turnStartAt: 0, lastToolAt: 0, lastTextAt: 0, activity: 'starting server', models: { build: BUILD, review: REVIEW }, toolProfile: TOOL_PROFILE_MODE, stepList, commitLog: [], todos: [], files: [], phases: [{ phase: 'starting', at: T0 }], start: START,
    config: { stall: CFG.stall, toolStall: CFG.toolStall, think: CFG.think, retries: CFG.retries, fixes: CFG.fixes, noCommit: CFG.noCommitS },
    tokens: emptyTokens(), tokensBy: { build: emptyTokens(), review: emptyTokens(), other: emptyTokens() }, tokensByModel: {},
    commits: 0, steps: stepCount, checks,
    interruptions: [], steers: [], permissions: [], gates: [], errors: [], outside: [], verdict: null, result: null, exitCode: null,
    stepReviews: [], stepReviewContinues: 0, workerChecks: [], reviewRounds: [], questions: [], blocker: null, blockerClearedAt: 0, lastCommitAt: 0, commitsSeen: 0, stepSeen: 0, noCommitAckAt: 0, briefWarnings,
  };
  if (resumed) {
    const runs = [...(resumed.runs || []), { startedAt: resumed.runStartedAt || resumed.startedAt, finishedAt: resumed.finishedAt, result: resultOf(resumed), reason: resumed.reason || '' }];
    const by = (r) => ({ ...emptyTokens(), ...(resumed.tokensBy?.[r] || {}) });
    const byModel = {}; for (const [m, t] of Object.entries(resumed.tokensByModel || {})) byModel[m] = { ...emptyTokens(), ...t };
    Object.assign(S, { startedAt: resumed.startedAt || T0, runStartedAt: T0, runs, resumes: runs.length, tokens: { ...S.tokens, ...(resumed.tokens || {}) },
      tokensBy: { build: by('build'), review: by('review'), other: by('other') }, tokensByModel: byModel,
      interruptions: resumed.interruptions || [], steers: resumed.steers || [], permissions: resumed.permissions || [], errors: resumed.errors || [],
      outside: resumed.outside || [], files: resumed.files || [], todos: resumed.todos || [], phases: [...(resumed.phases || []), { phase: 'starting', at: T0 }],
      stepReviews: resumed.stepReviews || [], stepReviewContinues: resumed.stepReviewContinues || 0, workerChecks: resumed.workerChecks || [], reviewRounds: resumed.reviewRounds || [], questions: resumed.questions || [], blocker: resumed.blocker || null, stepSeen: resumed.stepSeen || 0 });
  }
  const insideRepo = (f) => { const a = path.resolve(repo, String(f).replace(/[\\/]\*+$/, '')).toLowerCase(); return [repo, os.tmpdir()].some((r) => a === r.toLowerCase() || a.startsWith(r.toLowerCase() + path.sep)); };
  let lastWrite = 0;
  const save = (force) => { if (!force && now() - lastWrite < 1000) return; lastWrite = now(); S.updatedAt = now(); writeAtomic(path.join(dir, 'state.json'), JSON.stringify(S, null, 2));
    // finished lanes also keep a copy in the registry, so merged and removed worktrees stay visible
    if (S.result) try { fs.mkdirSync(path.join(REG, 'final'), { recursive: true }); fs.writeFileSync(path.join(REG, 'final', `${id}.json`), JSON.stringify(S, null, 2)); } catch {} };
  // Write the first state, then bind the lane to the repo's plan (create, append or un-archive it): the plan
  // never appears on the dashboard before its lane shows as running. A resume of a lane the plan already
  // lists is left alone; a failure here only warns, it never stops the lane.
  save(true);
  if (!(opts.resume && laneAlreadyPlanned(repo, task))) {
    try { ensurePlan(repo, task, briefEarly); }
    catch (e) { process.stderr.write(`[${task}] plan warning: ${oneLine(String((e && e.message) || e), 200)}\n`); }
  }
  const phase = (p, activity) => { if (S.phase !== p) S.phases.push({ phase: p, at: now() }); S.phase = p; if (activity) S.activity = activity; save(true); };
  // Clear an open blocker and restart the no-progress clock: a steer, a new commit or an ack answered the lead.
  const clearBlocker = (why) => {
    if (!S.blocker) return false;
    S.blocker = null; S.blockerClearedAt = now();
    L(`blocker cleared (${why})`); save(true);
    return true;
  };
  // A worker decision or environment failure the lead must see now: record it as the lane blocker so
  // ca wait (exit 11), ca status --json and the dashboard surface it in seconds. A repeated sighting of
  // the same signal does not churn the state; a steer or an ack clears it, never an unrelated commit.
  const raiseSignal = (sig) => {
    if (!sig) return false;
    if (S.blocker && S.blocker.kind === sig.kind && S.blocker.text === sig.text) return false;
    S.blocker = { kind: sig.kind, text: sig.text, at: now(), ...(sig.key ? { key: sig.key } : {}) };
    (S.signals ||= []).push({ at: now(), kind: sig.kind, text: sig.text });
    L(`  ! blocked (${sig.kind}): ${sig.text}`);
    save(true);
    return true;
  };
  const syncCommits = () => {
    const out = git(repo, 'log', '--reverse', '--format=%h%x09%s', `${START}..HEAD`);
    S.commitLog = out ? out.split(/\r?\n/).map((l) => { const [hash, ...r] = l.split('\t'); return { hash, subject: oneLine(r.join(' '), 160) }; }) : [];
    S.commits = S.commitLog.length;
    // The no-progress clock runs on real commit times. In the build phase only a commit for a NEW step
    // (`step N:` with an N above every step seen so far) restarts it, so busywork ("wip: ...") cannot hide
    // a stuck step; during a fix round any new commit counts. A commit that landed after the blocker clears
    // it; an older one observed late must not.
    if (S.commits > (S.commitsSeen || 0)) {
      // Classify every commit that landed since the last tick, not just the tip: a `step N:` commit
      // followed by a non-step commit in the same window must still restart the clock. The highest new
      // step number wins, so any `step N:` above every step seen so far counts as a new step.
      const fresh = S.commitLog.slice(S.commitsSeen || 0);
      S.commitsSeen = S.commits;
      let maxStep = S.stepSeen || 0;
      for (const c of fresh) {
        const m = c.subject.match(/^step\s*(\d+)\s*:/i);
        const n = m ? Number(m[1]) : 0;
        if (n > maxStep) maxStep = n;
      }
      const newStep = maxStep > (S.stepSeen || 0);
      if (newStep) { S.stepSeen = maxStep; S.stepContinues = 0; }
      if (newStep || S.phase === 'fix') {
        const ct = git(repo, 'log', '-1', '--format=%ct', 'HEAD').trim();
        S.lastCommitAt = ct ? Number(ct) * 1000 : now();
        // Only the no-progress alarm is answered by progress. A recorded decision or environment
        // failure waits for the lead: an unrelated commit must not silently clear it (steer/ack clears).
        if (S.blocker && S.blocker.kind === 'no-progress' && S.lastCommitAt > S.blocker.at) clearBlocker('a new commit landed');
      }
    }
  };

  // The codearts server writes sign-in failures to server.log right at start. Read only its tail:
  // enough for the classifier, never the whole (long) log.
  const serverLogTail = () => {
    try {
      const f = path.join(dir, 'server.log'); const st = fs.statSync(f);
      const start = Math.max(0, st.size - 200 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch { return ''; }
  };
  // Called when a turn ends in an error: null (keep the old behaviour) or a plain-words key problem.
  const keyProblem = (model, error) => authProblem({ model, error, serverLog: serverLogTail() });

  const server = new Server(repo, path.join(dir, 'server.log'), TOOL_PROFILE_MODE);
  let finished = false;
  const cleanup = () => { if (!finished) { finished = true; server.stop(); } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { S.result = S.result || 'killed'; S.activity = `killed by ${sig}`; save(true); cleanup(); process.exit(130); });

  // ---- event tracking ----
  const sess = {}; // sid -> { busy, sawBusy, lastAct, tools: Map, error, aborting }
  const sx = (sid) => (sess[sid] ||= { busy: false, sawBusy: false, lastAct: now(), tools: new Map(), error: null, aborting: false });
  const builderSessions = new Set(); // every session that ran the brief (build or fix): tokens bill as build
  const reviewSessions = new Set();  // the final review plus every step review: tokens bill as review
  const countedSteps = new Set();    // step-finish part ids already billed (a reconnect replays events)
  const roleOf = (sid) => (sid === S.reviewSession || reviewSessions.has(sid) ? 'review' : builderSessions.has(sid) ? 'build' : 'other');
  const roles = new Map();       // messageID -> role
  const msgModel = new Map();    // messageID -> providerID/modelID of assistant messages
  const sessionModel = new Map(); // sid -> the model the runner sent there (fallback when a message carries none)
  const parts = new Map();       // partID -> { type, text, logged }
  const sent = new Set();        // texts we sent (to tell TUI-typed steering apart)
  const seenUser = new Set();    // user partIDs already logged

  // The worker's last reply and last tool output: the gate reads them to tell whether its commit was
  // refused by the sandbox (then the runner commits instead of wasting a fix round that says "commit").
  let lastWorkerReply = ''; let lastToolOutput = '';
  // Sleep-polling wastes tokens: the model replays its whole context on every idle turn. Reject a
  // permission for it and queue at most one steer per lane telling the worker to run the check in
  // the foreground instead. Every sighting is recorded as an interruption.
  let sleepPollSteered = false;
  // The direct-check guidance is queued at most once per lane, and per tool-command failure counts feed
  // the repeated-failure signal. Both are supervisor-local; a resume starts them clean.
  let directCheckAlerted = false;
  const toolFails = new Map(); // toolKey -> { n, commits } (commits = lane commit count at first failure)
  const flagSleepPoll = (where) => {
    S.interruptions.push({ at: now(), phase: S.phase, kind: 'sleep-poll', what: where });
    save(true);
  };
  const queueSleepSteer = () => {
    if (sleepPollSteered) return; sleepPollSteered = true;
    try { fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(dir, 'inbox', `${now()}-sleep.txt`), 'Do not sleep-poll: run the check in the foreground with a timeout and read its output once.'); } catch {}
    save(true);
  };
  // Tell the worker, like a steer, to run the CHECK line through the helper instead of its sandbox.
  const queueHelperGuidance = () => {
    try {
      fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'inbox', `${now()}-helper-direct.txt`),
        `Do not run a CHECK line directly: your sandbox blocks the loopback network, so a check that starts a local server hangs. Run it with \`node tasks/${task}.lane/check.mjs <N>\` (no argument lists them); the runner runs it outside the sandbox and prints the output and the exit code.`);
    } catch {}
  };
  const flushPart = (pid) => {
    const p = parts.get(pid); if (!p || p.logged) return; p.logged = true;
    const t = (p.text || '').trim(); if (!t) return;
    // A finished builder reply (or, when real SSE sends no time.end, the idle sweep over every part)
    // may ask the lead to decide or grant permission: surface it once per part.
    if (p.type === 'text' && roleOf(p.sid) === 'build') raiseSignal(classifySignal({ text: t, agentRole: 'build', source: 'assistant' }));
    if (p.type === 'reasoning') L(`  ~ think: ${oneLine(t, 300)}`); else { lastWorkerReply = t; L('  assistant:'); block('│ ', t); }
  };
  const toolInput = (tool, inp = {}) => oneLine(inp.command ?? inp.filePath ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? JSON.stringify(inp), 200);

  const onEvent = (e) => {
    const pr = e.properties || {};
    const sid = pr.sessionID || pr.part?.sessionID || pr.info?.sessionID;
    if (e.type !== 'server.heartbeat' && e.type !== 'message.part.delta') { try { fs.writeSync(raw, JSON.stringify({ t: now(), ...e }) + '\n'); } catch {} }
    if (e.type === 'server.heartbeat') return;
    if (sid && sess[sid]) { sx(sid).lastAct = now(); S.lastEventAt = now(); }
    switch (e.type) {
      case 'session.status': {
        if (!sid) break; const s = sx(sid); const st = pr.status?.type;
        if (st === 'busy' || st === 'retry') { s.busy = true; s.sawBusy = true; }
        if (st === 'idle') s.busy = false;
        if (st === 'retry') { const msg = `model service retry ${pr.status.attempt ?? ''}: ${oneLine(pr.status.message, 160)}`; L(`  ! ${msg}`); S.activity = msg; S.lastRetry = { at: now(), message: oneLine(pr.status.message, 200) }; }
        if (sid === S.activeSession) S.busy = s.busy;
        break;
      }
      case 'session.idle': if (sid) { sx(sid).busy = false; if (sid === S.activeSession) S.busy = false; } break;
      case 'session.error': {
        const err = pr.error || {}; const s = sid ? sx(sid) : null;
        const msg = `${err.name || 'error'}: ${oneLine(err.data?.message || err.message || JSON.stringify(err), 300)}`;
        if (s && s.aborting && /Abort/i.test(err.name || '')) break;
        if (s) s.error = err;
        S.errors.push({ at: now(), msg }); L(`  ! session error ${msg}`); break;
      }
      case 'message.updated': {
        const info = pr.info || {}; if (info.id) roles.set(info.id, info.role);
        if (info.id && info.role === 'assistant' && info.providerID && info.modelID) msgModel.set(info.id, `${info.providerID}/${info.modelID}`);
        if (info.role === 'assistant' && info.error && sid && !(sx(sid).aborting && /Abort/i.test(info.error.name || ''))) sx(sid).error = info.error;
        break;
      }
      case 'message.part.delta': {
        const known = parts.has(pr.partID); const p = parts.get(pr.partID) || { type: 'text', text: '' }; if (pr.field === 'text') p.text = (p.text || '') + (pr.delta || '');
        parts.set(pr.partID, p); if (sid === S.activeSession && !sx(sid).tools.size) S.activity = p.type === 'reasoning' ? 'thinking' : 'writing reply';
        // only a part already announced as text counts as progress: an unannounced delta may be reasoning
        if (sid === S.activeSession && known && p.type === 'text') S.lastTextAt = now();
        break;
      }
      case 'message.part.updated': {
        const part = pr.part || {}; const role = roles.get(part.messageID);
        if (part.type === 'text' && (role === 'user' || part.metadata?.isUserInput)) {
          if (!seenUser.has(part.id)) { seenUser.add(part.id); if (!sent.has((part.text || '').trim()) && !part.synthetic) { L('>> user (TUI or external):'); block('» ', part.text); S.steers.push({ at: now(), by: 'tui', text: oneLine(part.text, 500) }); } }
          break;
        }
        if (part.type === 'text' || part.type === 'reasoning') {
          const p = parts.get(part.id) || { type: part.type, text: '' }; p.type = part.type; if (typeof part.text === 'string' && part.text.length >= (p.text || '').length) p.text = part.text;
          p.sid = sid; parts.set(part.id, p); if (part.time?.end) flushPart(part.id);
          if (sid === S.activeSession && !sx(sid).tools.size) S.activity = part.type === 'reasoning' ? 'thinking' : 'writing reply';
          if (sid === S.activeSession && part.type === 'text') S.lastTextAt = now();
        } else if (part.type === 'tool') {
          const s = sid ? sx(sid) : null; const st = part.state || {}; const key = part.callID || part.id;
          if (st.status === 'running' && s && !s.tools.has(key)) {
            for (const k of parts.keys()) flushPart(k);
            s.tools.set(key, { tool: part.tool, since: now(), input: toolInput(part.tool, st.input), helperWrapper: helperInCommand(st.input?.command) });
            L(`  > ${part.tool}  ${toolInput(part.tool, st.input)}`);
            { const n = sleepPoll(st.input?.command); if (n) { L(`  ! sleep-poll: ${part.tool} waits sleep ${n}`); flagSleepPoll(`${part.tool}: sleep ${n}`); queueSleepSteer(); } }
            // The lane's CHECK lines must run through the helper (outside the sandbox). A bash command
            // that runs one directly hangs the worker on the blocked loopback network: alert the lead
            // once and queue the helper guidance; a command that uses the helper is left alone.
            if (roleOf(sid) === 'build') {
              const bad = directCheckInvocation(st.input?.command, { checks, helper: `tasks/${task}.lane/check.mjs` });
              if (bad && !directCheckAlerted) {
                directCheckAlerted = true;
                L(`  ! check run directly in the sandbox: ${oneLine(bad, 160)}; steering to the helper`);
                raiseSignal({ kind: SANDBOX_CHECK, text: `ran this lane's check directly in the sandbox: ${oneLine(bad, 140)}`, why: 'the sandbox blocks the check' });
                queueHelperGuidance();
              }
            }
            // Global CodeArts permissions may allow external reads/writes; at least make them visible.
            const fp = st.input?.filePath ?? st.input?.path;
            if (typeof fp === 'string' && path.isAbsolute(fp) && !insideRepo(fp)) {
              S.outside.push({ at: now(), tool: part.tool, path: fp }); L(`  ! outside the repo: ${part.tool} ${fp}`);
            }
            if (sid === S.activeSession) S.lastToolAt = now();
          } else if ((st.status === 'completed' || st.status === 'error') && s) {
            const t = s.tools.get(key); s.tools.delete(key);
            const took = t ? ` (${dur(now() - t.since)})` : '';
            lastToolOutput = String(st.error || st.output || '').trim();
            if (st.status === 'error') L(`  ! ${part.tool} failed${took}: ${oneLine(st.error, 300)}`);
            else L(`  < ${part.tool} ok${took}${st.output ? ': ' + oneLine(st.output, 200) : ''}`);
            if (sid === S.activeSession) S.lastToolAt = now();
            // A failed builder tool is either status 'error' or a real CodeArts 'completed' with a nonzero
            // exit code. A passing command (exit 0) is never classified, so output that merely quotes an
            // error inside a green run does not raise a false blocker. Surface an environment failure at
            // once; otherwise the same command failing repeatedly with no progress is its own signal.
            const ft = roleOf(sid) === 'build' ? toolFailureText(st) : '';
            if (ft) {
              const esig = classifySignal({ text: ft, agentRole: 'build', source: 'tool' });
              if (esig) raiseSignal(esig);
              else {
                const key = toolKey(part.tool, st.input);
                const { state: nf, repeat } = noteFailure(toolFails.get(key), { commits: S.commits });
                toolFails.set(key, nf);
                if (repeat) raiseSignal({ kind: REPEAT_FAIL, text: `the same tool keeps failing with no progress: ${part.tool} ${oneLine(st.input?.command ?? st.input?.filePath ?? '', 120)}`, why: 'the same tool keeps failing' });
              }
            }
          }
          if (sid === S.activeSession && s) { const t = [...s.tools.values()][0]; S.activity = t ? `tool ${t.tool}: ${oneLine(t.input, 80)}` : 'thinking'; S.tools = [...s.tools.values()].map((x) => ({ tool: x.tool, input: oneLine(x.input, 120), since: x.since })); }
        } else if (part.type === 'step-finish') {
          for (const k of parts.keys()) flushPart(k);
          if (part.id && !countedSteps.has(part.id)) {
            countedSteps.add(part.id);
            const model = msgModel.get(part.messageID) || sessionModel.get(sid) || 'codearts/hidden';
            addStepTokens(S.tokens, part.tokens);
            addStepTokens(S.tokensBy[roleOf(sid)], part.tokens);
            addStepTokens((S.tokensByModel[model] ||= emptyTokens()), part.tokens);
          }
        }
        break;
      }
      case 'permission.asked': case 'permission.updated': handlePermission(pr); break;
      case 'question.asked': {
        const q = oneLine(pr.questions?.[0]?.question || JSON.stringify(pr), 300);
        L(`  ? question asked: ${q} -> rejected (headless, no questions)`);
        // The lead watches ca wait / status / the bucket, so record the question as a blocker and tell the
        // worker to carry on with its best option instead of waiting (the question is still rejected).
        S.blocker = { kind: 'question', text: q, at: now() };
        (S.questions ||= []).push({ text: q, at: now() });
        L(`  ! blocked: asked the lead: ${q}`);
        try { fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(dir, 'inbox', `${now()}-question.txt`), `Message from the runner: your question was sent to the lead: ${q}. Do not wait for an answer. Pick the option that best fits the brief, say which in one line, and continue. The lead will steer you if it disagrees.`); } catch {}
        save(true);
        server.api('POST', `/question/${pr.id}/reject`, {}).catch((err) => L(`  ! question reject failed: ${err.message}`)); break;
      }
      case 'todo.updated': if (Array.isArray(pr.todos) && (!sid || sid === S.buildSession || sid === S.activeSession)) S.todos = pr.todos.map((t) => ({ text: oneLine(t.content, 200), status: t.status })); break;
      case 'file.edited': { const f = pr.file && path.relative(repo, path.resolve(repo, pr.file)).replace(/\\/g, '/'); if (f && !f.startsWith('..') && !path.isAbsolute(f) && !/^(tasks\/|\.codeartsdoer)/.test(f) && !S.files.includes(f)) { S.files.push(f); if (S.files.length > 200) S.files.shift(); } break; }
      case 'tui.toast.show': if (pr.variant === 'error' || pr.variant === 'warning') L(`  ! toast ${pr.variant}: ${oneLine(pr.message, 200)}`); break;
    }
    save();
  };

  // Permission policy: never leave a prompt hanging. Inside the repo or temp: allow once.
  // Elsewhere, .env reads and doom loops: reject with a reason the model can act on.
  const handledPerm = new Set();
  function handlePermission(p) {
    if (!p.id || handledPerm.has(p.id)) return; handledPerm.add(p.id);
    const kind = p.permission || p.type || 'unknown';
    const pats = [].concat(p.patterns || p.pattern || []).map(String);
    let reply = 'once', why = '';
    const sp = sleepPoll([p.command, p.pattern, pats.join(' '), p.title, JSON.stringify(p.metadata || {})].filter(Boolean).join(' '));
    if (sp) { reply = 'reject'; why = 'Do not sleep-poll: run the check in the foreground with a timeout and read its output once.'; flagSleepPoll(`permission ${kind}: sleep ${sp}`); }
    else if (kind === 'external_directory' && !(pats.length && pats.every(insideRepo))) { reply = 'reject'; why = `Stay inside the repo ${repo}; do not touch other folders.`; }
    else if (kind === 'doom_loop') { reply = 'reject'; why = 'You repeated the same tool call several times. Stop, think about why it fails, and try a different approach.'; }
    else if (kind === 'read' && pats.some((x) => /\.env/i.test(x))) { reply = 'reject'; why = 'Do not read .env files.'; }
    S.permissions.push({ at: now(), kind, patterns: pats.slice(0, 3), reply });
    L(`  ? permission ${kind} ${oneLine(pats.join(' '), 120)} -> ${reply}${why ? ' (' + why + ')' : ''}`);
    server.api('POST', `/permission/${p.id}/reply`, { reply, ...(why ? { message: why } : {}) })
      .catch(() => server.api('POST', `/session/${p.sessionID}/permissions/${p.id}`, { response: reply }))
      .catch((err) => L(`  ! permission reply failed: ${err.message}`));
  }

  // ---- session helpers ----
  const newSession = async (title) => (await server.api('POST', '/session', { title })).id;
  const send = async (sid, text, model, agent) => {
    if (model) sessionModel.set(sid, model);
    sent.add(text.trim()); const s = sx(sid); s.error = null; s.sawBusy = false; s.lastAct = now(); s.sentAt = now();
    S.activeSession = sid; S.busy = true;
    S.turnStartAt = now(); S.lastToolAt = 0; S.lastTextAt = 0;
    await server.api('POST', `/session/${sid}/prompt_async`, { model: splitModel(model), ...(agent ? { agent } : {}), parts: [{ type: 'text', text }] });
  };
  const abort = async (sid) => {
    const s = sx(sid); s.aborting = true;
    try { await server.api('POST', `/session/${sid}/abort`, {}); } catch (err) { L(`  ! abort failed: ${err.message}`); }
    for (let i = 0; i < 30 && s.busy; i++) await sleep(1000);
    s.tools.clear(); s.busy = false; s.aborting = false;
  };
  const stopFile = path.join(dir, 'STOP');
  // ca ack writes this on a running blocked lane: the supervisor clears the blocker and deletes the file.
  const blockerAckFile = path.join(dir, 'BLOCKER_ACK');
  // A kick is a human decision delivered by file: {at, mode: turn|fresh|server|now, text, by}.
  // The supervisor consumes it at the next poll (2 s) or during a backoff wait.
  const kickFile = path.join(dir, 'KICK');
  const takeKick = () => {
    if (!fs.existsSync(kickFile)) return null;
    const k = readJSON(kickFile);
    try { fs.rmSync(kickFile, { force: true }); } catch {}
    return k && k.mode ? k : { mode: 'turn', text: '', by: 'unknown', at: now() };
  };
  let curModel = BUILD, curAgent;
  let lastPumpHadStepReview = false; // did the last pumpInbox() deliver a step-review finding?
  const pumpInbox = async (sid) => {
    lastPumpHadStepReview = false;
    let files = []; try { files = fs.readdirSync(path.join(dir, 'inbox')).filter((f) => f.endsWith('.txt')).sort(); } catch {}
    // A step-review finding is for the builder only: leave it for the builder, never steer a review session.
    if (!builderSessions.has(sid)) files = files.filter((f) => !/stepreview/i.test(f));
    for (const f of files) {
      const fp = path.join(dir, 'inbox', f); let text = ''; try { text = fs.readFileSync(fp, 'utf8').trim(); fs.rmSync(fp); } catch { continue; }
      if (!text) continue;
      const by = /stepreview/i.test(f) ? 'step review' : /question|sleep|helper/i.test(f) ? 'runner notice' : 'ca steer';
      if (by === 'step review') lastPumpHadStepReview = true;
      // A lead steer queued after the blocker clears it: the person answered the worker's question.
      if (S.blocker && by === 'ca steer') {
        const at = Number((f.match(/^(\d+)/) || [])[1]) || 0;
        // A steer answers the blocker; a steered wrapper stall stays muted for that same request.
        if (at > S.blocker.at) { if (S.blocker.kind === 'check-wrapper' && S.blocker.key) S.wrapperMuteKey = S.blocker.key; clearBlocker('steer delivered'); }
      }
      L('>> steer:'); block('» ', text); S.steers.push({ at: now(), by, phase: S.phase, text: oneLine(text, 500) });
      process.stdout.write(`[${task} ${hhmmss()}] steer received: ${oneLine(text, 100)}\n`);
      await send(sid, `Message from the lead (steering, applies on top of the brief): ${text}`, curModel, curAgent);
    }
    return files.length;
  };
  const inboxStepReviewFiles = () => { try { return fs.readdirSync(path.join(dir, 'inbox')).filter((f) => f.endsWith('.txt') && /stepreview/i.test(f)); } catch { return []; } };

  // A step review is a short read-only pass over one step commit, run while the builder keeps working.
  // It must never touch drive()/send()/waitTurn(): those set S.activeSession, S.busy and the builder
  // watchdogs. This is an independent poller: POST prompt_async, then poll the session status until it
  // has been busy and is idle again. Any error is recorded, never retried, never fails the lane.
  let stepReviewRunning = null;    // the promise of the review in flight, or null
  let stepReviewCancel = false;    // set when the builder went idle and the grace ran out
  let stepReviewTo = '';           // the head the in-flight step review covers, so a cancel can mark it reviewed
  // Commits up to here are already covered by a step review; a resumed lane continues after its last one.
  let lastReviewedHash = (S.stepReviews.length && S.stepReviews[S.stepReviews.length - 1].hash) || START;
  const reviewedAlready = (h) => spawnSync('git', ['merge-base', '--is-ancestor', h, lastReviewedHash], { cwd: repo, windowsHide: true }).status === 0;
  const stepReviewTemplate = () => {
    try { return fs.readFileSync(path.join(SKILL, 'templates', 'step-review.md'), 'utf8'); }
    catch { return 'Review git diff {RANGE} for {STEPS} in tasks/{TASK}.md. List only real bugs with file:line. End with "STEP VERDICT: ok" or "STEP VERDICT: fix".'; }
  };
  const lastAssistantText = (msgs) => {
    if (!Array.isArray(msgs)) return '';
    const last = [...msgs].reverse().find((m) => m.info?.role === 'assistant' && (m.parts || []).some((p) => p.type === 'text' && p.text?.trim()));
    return last ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim() : '';
  };
  // Read a session's messages (fail closed: null on any error, so a caller can never mistake an
  // unreadable session for an empty, safe one). The message id is the proof of a fresh turn.
  const assistantMessages = async (sid) => {
    try { const msgs = await server.api('GET', `/session/${sid}/message`); return Array.isArray(msgs) ? msgs : null; }
    catch { return null; }
  };
  const lastAssistant = (msgs) => {
    if (!Array.isArray(msgs)) return null;
    for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m && m.info && m.info.role === 'assistant' && (m.parts || []).some((p) => p.type === 'text' && p.text && p.text.trim())) return m; }
    return null;
  };
  const msgText = (m) => (m && m.parts ? m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim() : '');
  const msgIdOf = (m) => (m && m.info && (m.info.id || m.info.messageID)) || null;
  const writeStepReviewInbox = (steps, hash, text) => {
    const body = `Reviewer on ${steps.map((k) => `step ${k}`).join(', ')} (commit ${hash}):\n${text}\n`
      + `Fix the real bugs in a commit "fix: ${steps.map((k) => `step ${k}`).join(', ')} review" and keep going with the brief; ignore a finding that contradicts the brief or the lead's steering.`;
    try { fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(dir, 'inbox', `${now()}-stepreview.txt`), body); } catch {}
    return body;
  };
  const runStepReview = async (n, steps, from, to, subjects) => {
    const t0 = now(); let sid = null, text = '', verdict = 'error'; const hash = to.slice(0, 12);
    try {
      sid = await newSession(`${task} step review ${n}`); reviewSessions.add(sid);
      // Function replacers: a commit subject is worker-authored text, and a `$&`/`$1`/`$'` in a string
      // replacement would be read as a replacement directive and corrupt the prompt.
      const prompt = stepReviewTemplate().replaceAll('{TASK}', () => task).replaceAll('{STEPS}', () => steps.map((k) => `step ${k}`).join(', '))
        .replaceAll('{RANGE}', () => `${from}..${to}`).replaceAll('{SUBJECTS}', () => subjects.join('\n'));
      sent.add(prompt.trim()); // the runner's own prompt: never list it as a TUI steer
      await server.api('POST', `/session/${sid}/prompt_async`, { model: splitModel(STEP_REVIEWER), agent: 'plan', parts: [{ type: 'text', text: prompt }] });
      L(`== step review ${n} (${STEP_REVIEWER}, plan agent) session ${sid}: ${from.slice(0, 8)}..${to.slice(0, 8)} for ${steps.map((k) => `step ${k}`).join(', ')}`);
      const deadline = t0 + CFG.stepReviewTimeout * 1000; let sawBusy = false, done = false;
      while (!done) {
        if (now() > deadline) { try { await server.api('POST', `/session/${sid}/abort`, {}); } catch {} verdict = 'timeout'; break; }
        if (stepReviewCancel) { try { await server.api('POST', `/session/${sid}/abort`, {}); } catch {} verdict = 'cancelled'; break; }
        await sleep(3000);
        let st; try { st = (await server.api('GET', '/session/status', null, 10000))[sid]?.type; } catch { st = undefined; }
        if (st === 'busy' || st === 'retry') { sawBusy = true; continue; }
        try { text = lastAssistantText(await server.api('GET', `/session/${sid}/message`)); } catch {}
        if (sawBusy || text) done = true;
        else if (now() - t0 > 60000) { verdict = 'missing'; break; }
      }
      if (verdict !== 'timeout' && verdict !== 'missing' && verdict !== 'cancelled') {
        const m = text.match(/STEP VERDICT:\s*(ok|fix)/i);
        verdict = m ? m[1].toLowerCase() : (text ? 'missing' : 'error');
      }
    } catch (err) { verdict = 'error'; L(`! step review ${n} error: ${oneLine(String((err && err.message) || err), 200)}`); }
    const rec = { steps, hash, from, at: t0, ms: now() - t0, verdict, text: String(text || '').trim().slice(0, 1500) };
    S.stepReviews.push(rec); if (verdict !== 'cancelled') lastReviewedHash = to; save(true);
    if (verdict === 'fix') writeStepReviewInbox(steps, hash, rec.text);
    return rec;
  };
  // Reserve the shared model quota for foreground builders. While another alive, unfinished,
  // non-queued builder/fix phase uses the step-review model, this OPTIONAL early review waits.
  // Return true (and publish a bounded reason) when the caller must postpone. Fresh lane state and
  // liveness come from the registry here, so the pure decision in reviewbudget.mjs sees reality.
  const deferStepReview = (steps) => {
    const peers = lanes().map((l) => ({ id: l.id, alive: alive(l.s && l.s.pid), s: l.s }));
    if (!shouldDeferStepReview({ model: STEP_REVIEWER, selfId: id, lanes: peers })) return false;
    const holders = stepReviewBlockers({ model: STEP_REVIEWER, selfId: id, lanes: peers });
    S.stepReviewDeferred = {
      at: now(), model: STEP_REVIEWER, steps: steps.slice(0, 20),
      peers: holders.map((h) => h.id).slice(0, 5),
      reason: oneLine(`deferred: ${holders.length} foreground ${STEP_REVIEWER} builder(s) hold the model quota`, 200),
    };
    L(`== step review deferred: ${S.stepReviewDeferred.reason}`);
    save();
    return true;
  };
  // Clear the deferred marker once the review runs (resume) or the final review covers the range.
  const clearStepReviewDeferred = () => { if (S.stepReviewDeferred) { S.stepReviewDeferred = null; save(true); } };
  const maybeStepReview = () => {
    if (!STEP_REVIEW || stepReviewRunning) return;
    const idx = S.commitLog.findIndex((c) => c.hash === lastReviewedHash);
    const fresh = idx >= 0 ? S.commitLog.slice(idx + 1) : lastReviewedHash === START ? S.commitLog.slice() : S.commitLog.filter((c) => !reviewedAlready(c.hash));
    const stepFresh = fresh.filter((c) => /^step\s+\d+:/i.test(c.subject));
    if (!stepFresh.length) return;
    const to = S.commitLog.length ? S.commitLog[S.commitLog.length - 1].hash : lastReviewedHash;
    if (!to || to === lastReviewedHash) return;
    const steps = [...new Set(stepFresh.map((c) => Number((c.subject.match(/^step\s+(\d+):/i) || [])[1])))].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    // Deferred: do NOT advance lastReviewedHash and do NOT drop the pending step evidence, so once
    // the peers stop building the next eligible review coalesces every unreviewed step. The
    // mandatory final review still covers the entire required range regardless.
    if (deferStepReview(steps)) return;
    clearStepReviewDeferred();
    const subjects = stepFresh.map((c) => c.subject);
    const n = S.stepReviews.length + 1;
    stepReviewTo = to;
    stepReviewRunning = runStepReview(n, steps, lastReviewedHash, to, subjects).catch(() => null).finally(() => { stepReviewRunning = null; });
  };

  // The check service: the worker's helper drops a request file and waits for the result. The tick
  // below picks up at most one request per lane and runs it in the background so polling continues.
  const reqDir = path.join(dir, 'checkreq');
  let checkJobRunning = false;
  // Wrapper-stall detection. The worker's bash tool that calls this lane's helper (`node
  // tasks/<task>.lane/check.mjs ...`) is the wrapper. Normally it exits when the helper returns; a
  // finished helper whose wrapper stays active (e.g. the command was piped through `tail`, so the
  // pipeline never closes) leaves the lead seeing "Running" forever. Surface that one contradiction as
  // the blocker kind 'check-wrapper' (ca wait exit 11 / status / bucket); never abort automatically.
  const WRAPPER_STALL_S = 15;             // the helper must be done this long with the wrapper still live
  const WRAPPER_STALE_MS = 5 * 60 * 1000; // only correlate a wrapper that plausibly belongs to the finished request
  const WRAPPER_KIND = 'check-wrapper';
  const helperPathRe = new RegExp(`tasks[\\\\/]${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.lane[\\\\/]check\\.mjs`);
  const helperInCommand = (cmd) => typeof cmd === 'string' && helperPathRe.test(cmd.replace(/\s+/g, ' '));
  const pendingCheckReqs = () => { try { return fs.readdirSync(reqDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json')).length; } catch { return 0; } };
  let lastHelperReqDone = null;             // { id, at, doneAt } of the most recently completed helper request
  S.wrapperMuteKey ||= '';                  // the request id whose wrapper stall the lead acked/steered: stay quiet for it
  // A wrapper stall is a signal only when the helper is genuinely done and nothing else is running: a
  // live (long) CHECK holds it, a pending/later request holds it, an unrelated or completed tool never
  // matches, and an acked/steered incident (same request id) stays quiet until new activity.
  const wrapperStallSignal = (activeTools) => {
    if (checkJobRunning || pendingCheckReqs() || !lastHelperReqDone) return null;
    if (lastHelperReqDone.id && lastHelperReqDone.id === S.wrapperMuteKey) return null;
    const waited = now() - lastHelperReqDone.doneAt;
    if (waited < WRAPPER_STALL_S * 1000) return null;
    const hit = activeTools.find((t) => (t.helperWrapper || helperInCommand(t.input)) && t.since <= lastHelperReqDone.doneAt && lastHelperReqDone.doneAt - t.since <= WRAPPER_STALE_MS);
    if (!hit) return null;
    return { kind: WRAPPER_KIND, key: lastHelperReqDone.id, text: `the CHECK helper finished but its wrapper ${hit.tool} is still running ${dur(waited)}: rerun the check with \`node tasks/${task}.lane/check.mjs <N>\` (no pipe or tail), or kick the turn to inspect the wrapper` };
  };

  // Wait for one turn: idle, error, stall (watchdog), server death, stop or timeout.
  async function waitTurn(sid) {
    const s = sx(sid); let lastPoll = 0, lastCommitCheck = 0; let prevTick = now();
    for (;;) {
      await sleep(2000);
      const tickMs = now();
      // A gap far longer than the tick is the machine sleeping, not the model stalling: the silence
      // was the sleep. Reset every watchdog timer and reconnect SSE, so nothing aborts on wake.
      if (detectSleep(prevTick, tickMs, 2000)) {
        L(`  ! woke from sleep after ${dur(tickMs - prevTick)}`);
        s.lastAct = tickMs; S.lastEventAt = tickMs;
        S.turnStartAt = tickMs; S.lastToolAt = tickMs; S.lastTextAt = tickMs;
        for (const t of s.tools.values()) t.since = tickMs;
        if (server.alive) { try { await server.api('GET', '/global/health', null, 3000); } catch {} try { server.ac?.abort(); } catch {} }
        save(true);
      }
      prevTick = tickMs;
      if (fs.existsSync(stopFile)) { L('== stop requested'); await abort(sid); return { kind: 'stopped' }; }
      if (fs.existsSync(blockerAckFile)) {
        try { fs.rmSync(blockerAckFile, { force: true }); } catch {}
        // Only an ack that dismissed a no-progress blocker mutes the no-progress alarm until the next
        // commit. Dismissing a question must not hide a later silent gap, so the clock simply restarts.
        const wasNoProgress = !!(S.blocker && S.blocker.kind === 'no-progress');
        // An acked wrapper stall stays muted for that same finished request until new helper activity.
        const ackWrapperKey = S.blocker && S.blocker.kind === WRAPPER_KIND ? (S.blocker.key || '') : '';
        clearBlocker('ack');
        if (wasNoProgress) S.noCommitAckAt = now();
        if (ackWrapperKey) S.wrapperMuteKey = ackWrapperKey;
      }
      const k = takeKick();
      if (k) {
        L(`== kick (${k.mode}) from ${k.by}${k.text ? ': ' + oneLine(k.text, 160) : ''}`);
        await abort(sid);
        if (k.mode === 'server') {
          killTree(server.child?.pid);
          for (let i = 0; i < 15 && server.alive; i++) await sleep(1000);
          return { kind: 'server-died', kicked: true, mode: 'server', text: k.text || '', by: k.by };
        }
        return { kind: 'kick', mode: k.mode, text: k.text || '', by: k.by };
      }
      if (now() - T0 > CFG.laneTimeout * 1000) { L('== lane timeout'); await abort(sid); return { kind: 'timeout' }; }
      if (!server.alive) return { kind: 'server-died' };
      helperGuard();
      orphanGuard();
      await pumpInbox(sid);
      // The worker's helper (inside its sandbox) asks this runner to run a CHECK line outside the
      // sandbox. Pick up one request per tick and run it in the background so the tick never blocks.
      if (!checkJobRunning) {
        let reqs = []; try { reqs = fs.readdirSync(reqDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json')); } catch {}
        reqs.sort();
        if (reqs.length) {
          const rf = path.join(reqDir, reqs[0]); const req = readJSON(rf);
          try { fs.rmSync(rf, { force: true }); } catch {}
          if (req && req.id) {
            checkJobRunning = true;
            const seen = { id: req.id, at: Number(req.at) || now() };
            handleCheckRequest(req).catch((err) => L(`  ! check service error: ${oneLine(String((err && err.message) || err), 200)}`)).finally(() => {
              checkJobRunning = false;
              lastHelperReqDone = { id: seen.id, at: seen.at, doneAt: now() };
            });
          }
        }
      }
      // A check the worker asked for may run for minutes: its bash tool is waiting on the helper, which
      // is normal, so keep the tool watchdog from aborting that wait.
      if (checkJobRunning) for (const t of s.tools.values()) t.since = now();
      if (now() - lastCommitCheck > 5000) { lastCommitCheck = now(); syncCommits(); if (builderSessions.has(sid)) { maybeSpecReview().catch((err) => L(`! speculative review start failed: ${oneLine(String((err && err.message) || err), 200)}`)); maybeStepReview(); } }
      // No-progress alarm: a running builder that lands no commit for NO_COMMIT_S seconds is stuck. Raise
      // one blocker for the lead (ca wait / status / the bucket) instead of showing "running" forever. An
      // ack mutes it until a new commit lands, so the lead is not nagged about a gap it already saw.
      const ackMuted = S.noCommitAckAt && !(S.lastCommitAt > S.noCommitAckAt);
      if (CFG.noCommitS > 0 && !ackMuted && !S.blocker && (S.phase === 'build' || S.phase === 'fix')) {
        const base = Math.max(S.runStartedAt || S.startedAt || T0, S.lastCommitAt || 0, S.blockerClearedAt || 0);
        if (now() - base > CFG.noCommitS * 1000) {
          const cur = stepProgress(S).current;
          const text = `no commit in ${dur(now() - base)} for a new step${cur ? ` (stuck before step ${cur.n})` : ''}`;
          S.blocker = { kind: 'no-progress', text, at: now() };
          L(`  ! blocked: ${text}`); save(true);
        }
      }
      if (now() - lastPoll > 15000 || !S.sse) { // backup for missed SSE events
        lastPoll = now();
        try {
          const st = (await server.api('GET', '/session/status', null, 10000))[sid]?.type;
          if (st === 'busy' || st === 'retry') { s.busy = true; s.sawBusy = true; } else if (s.sawBusy || now() - s.sentAt > 20000) s.busy = false;
        } catch {}
      }
      S.busy = s.busy; save();
      if (!s.busy && (s.sawBusy || now() - s.sentAt > 60000)) {
        for (const k of parts.keys()) flushPart(k);
        if (!s.sawBusy) return { kind: 'no-start' };
        return s.error ? { kind: 'error', error: s.error } : { kind: 'idle' };
      }
      const tools = [...s.tools.values()];
      // A check-wrapper alert whose wrapper has since exited is resolved: drop it instead of showing a
      // stall the lead can no longer act on. Then re-check the contradiction and raise one blocker.
      if (S.blocker && S.blocker.kind === WRAPPER_KIND && !tools.some((t) => t.helperWrapper || helperInCommand(t.input))) clearBlocker('the wrapper exited');
      const wstall = wrapperStallSignal(tools);
      if (wstall && (!S.blocker || S.blocker.kind === WRAPPER_KIND) && !(S.blocker && S.blocker.key === wstall.key)) raiseSignal(wstall);
      const oldest = tools.reduce((m, t) => Math.min(m, t.since), Infinity);
      if (tools.length && now() - oldest > CFG.toolStall * 1000) {
        const t = tools.find((x) => x.since === oldest);
        L(`== watchdog: tool ${t.tool} running ${dur(now() - oldest)} (> ${CFG.toolStall}s): abort and resume`); await abort(sid);
        return { kind: 'stalled', what: `tool ${t.tool} ran over ${CFG.toolStall}s: ${oneLine(t.input, 120)}` };
      }
      if (!tools.length && s.busy && now() - s.lastAct > CFG.stall * 1000) {
        L(`== watchdog: no model activity for ${dur(now() - s.lastAct)} (> ${CFG.stall}s): abort and resume`); await abort(sid);
        return { kind: 'stalled', what: `model silent over ${CFG.stall}s` };
      }
      const ts = thinkStall({ busy: s.busy, toolsRunning: tools.length, turnStartAt: S.turnStartAt, lastToolAt: S.lastToolAt, lastTextAt: S.lastTextAt, now: now(), thinkS: CFG.think });
      if (ts.stall) {
        L(`== watchdog: thinking ${dur(ts.ageMs)} with no tool call (> ${CFG.think}s): abort and nudge`); await abort(sid);
        return { kind: 'think', what: `thinking ${dur(ts.ageMs)} with no tool call`, nudge: ts.nudge };
      }
    }
  }
  // CodeArts retries a rate limit itself and then aborts the turn: the error is a bare
  // MessageAbortedError, the reason is in the retry events just before it.
  const recentRate = () => !!(S.lastRetry && now() - S.lastRetry.at < 120000 && /429|rate.?limit|too many requests|quota|Queuing/i.test(S.lastRetry.message || ''));
  const classify = (err) => {
    const m = JSON.stringify(err || {});
    if (/Abort/i.test(m) && recentRate()) return 'rate';
    if (/Authentication failed|MISSING_CREDENTIAL|\b401\b|\b403\b|AK\/SK|invalid.*credential/i.test(m)) return 'auth';
    if (/\b429\b|rate.?limit|too many requests|quota|Queuing/i.test(m)) return 'rate';
    if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|\b50[0234]\b|Cannot connect|network/i.test(m)) return 'transport';
    return 'other';
  };
  let pendingKick = null; // a kick consumed during backoff: its mode applies to the resume
  const waitInterruptible = async (sec, label) => {
    const until = now() + sec * 1000;
    while (now() < until) {
      if (fs.existsSync(stopFile)) return false;
      helperGuard();
      orphanGuard();
      const k = takeKick();
      if (k) { L(`== backoff skipped by ${k.by}`); pendingKick = k; return true; }
      S.activity = `${label}: ${dur(until - now())} left`; save(); await sleep(1000);
    }
    return true;
  };

  // Drive a phase until its turn ends cleanly; resume interrupted turns in the same session.
  async function drive(sid, model, agent, label, resumeText, freshSession) {
    curModel = model; curAgent = agent;
    if (label === 'build' || label === 'fix') builderSessions.add(sid);
    let interruptions = 0, sameSessionFails = 0, thinkStalls = 0, rateHits = 0, rateWaited = 0;
    for (;;) {
      const o = await waitTurn(sid);
      if (o.kind === 'idle') return { ok: true, sid };
      if (o.kind === 'stopped' || o.kind === 'timeout') return { ok: false, sid, reason: o.kind };
      if (o.kind === 'kick' || (o.kind === 'server-died' && o.kicked)) {
        // A kick is a human decision, not a failure: no retry count, no backoff.
        const kmode = o.mode || 'server';
        S.interruptions.push({ at: now(), phase: label, kind: 'kick', what: `kick (${kmode}) from ${o.by}${o.text ? ': ' + oneLine(o.text, 160) : ''}` }); save(true);
        if (o.kind === 'server-died') {
          L('== kick: codearts server killed; restarting'); phase('restart', 'restarting codearts server');
          try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
        }
        phase(label, 'resuming after kick');
        const extra = o.text ? `\n\nMessage from the lead: ${o.text}` : '';
        if (kmode === 'fresh' && freshSession) {
          sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
          if (label === 'build' || label === 'fix') builderSessions.add(sid);
          say(`kick: switching to a fresh session ${sid}`);
          await send(sid, freshSession('kick', o.text || 'the lead asked for a clean restart') + extra, model, agent);
        } else {
          await send(sid, resumeText('kick', `${kmode} kick from ${o.by}`) + extra, model, agent);
        }
        if (label === 'build' || label === 'fix') S.buildSession = sid;
        continue;
      }
      const rawCls = o.kind === 'error' ? classify(o.error) : o.kind;
      const what = o.kind === 'error' ? `${o.error.name || 'error'}: ${oneLine(o.error.data?.message || o.error.message || '', 200)}` : (o.what || o.kind);
      // The transport itself is down (DNS, connect, reset, unreachable, fetch failed): wait for the
      // network instead of spending a retry. Auth problems are handled separately below.
      const netErr = o.kind === 'error' && rawCls !== 'auth' && isNetworkError(what);
      const cls = netErr ? 'transport' : rawCls;
      S.interruptions.push({ at: now(), phase: label, kind: cls, what }); save(true);
      // A rejected key can look like a plain 503 (AK/SK) or a maas/ authorization error: the classifier
      // reads the server log, so catch it here even when the error class is not 'auth'. End at once.
      if (o.kind === 'error') {
        const ap = keyProblem(model, what);
        if (ap) { L(`  ! ${ap.message}`); S.keysMessage = ap.message; return { ok: false, sid, reason: 'auth', exit: 3, what: ap.message, keys: ap.message }; }
      }
      if (cls === 'auth') return { ok: false, sid, reason: 'auth', exit: 3, what };
      if (netErr) {
        const netWaitS = CFG.netWait > 0 ? CFG.netWait : 1800;
        let netLoggedAt = 0;
        const onWait = ({ tries, waitedMs }) => {
          S.activity = `offline: waiting for the network (${dur(waitedMs)})`;
          // The silence is the outage, not the model: keep ca status from reading STALLED while we wait.
          S.lastEventAt = now(); S.turnStartAt = now(); S.lastToolAt = now(); S.lastTextAt = now();
          if (now() - netLoggedAt >= 60000) { netLoggedAt = now(); L(`  ! network down, waiting (try ${tries})`); }
          save();
        };
        onWait({ tries: 0, waitedMs: 0 });
        say(`network down (${oneLine(what, 140)}); waiting up to ${netWaitS}s (no retry used)`);
        const net = await waitOnline({ timeoutMs: netWaitS * 1000, onWait, shouldStop: () => fs.existsSync(stopFile) });
        if (net.stopped) return { ok: false, sid, reason: 'stopped' };
        if (net.online) {
          say(`network is back after ${dur(net.waitedMs)}; resuming the same session (no retry used)`);
          phase(label, 'resuming after network returned');
          await send(sid, resumeText('transport', `the network was down (${what})`), model, agent);
          if (label === 'build' || label === 'fix') S.buildSession = sid;
          continue;
        }
        L(`  ! still offline after ${dur(net.waitedMs)}; ending the phase as a transport failure`);
      }
      if (cls === 'other' && o.kind === 'error' && /Abort/i.test(o.error.name || '')) { /* user aborted in TUI: resume */ }
      // Rate limits are not failures: own budget (RATE_WAIT_S, default 1800 s), jittered backoff, no retry count.
      if (cls === 'rate' && rateWaited < CFG.rateWait) {
        rateHits++; const wait = Math.min(300, CFG.rateBackoff * 2 ** (rateHits - 1)) + Math.floor(Math.random() * Math.min(30, CFG.rateBackoff)); rateWaited += wait;
        say(`rate limited (${what}); waiting ${wait}s before resuming (${Math.round(rateWaited / 60)} of ${Math.round(CFG.rateWait / 60)} min rate budget)`);
        S.lastRetry = null; phase('backoff');
        if (!(await waitInterruptible(wait, 'rate limited, waiting'))) return { ok: false, sid, reason: 'stopped' };
        phase(label, 'resuming after rate limit');
        const rk = pendingKick; pendingKick = null; // a kick during the wait only ends the wait early
        await send(sid, resumeText('rate', 'the model service was rate limited; continue where you stopped') + (rk?.text ? `

Message from the lead: ${rk.text}` : ''), model, agent);
        continue;
      }
      if (++interruptions > CFG.retries) return { ok: false, sid, reason: `gave up after ${CFG.retries} interruptions (last: ${cls}: ${what})` };
      say(`interrupted (${cls}: ${what}); resume ${interruptions}/${CFG.retries}`);
      if (o.kind === 'server-died') {
        L('== codearts server died: restarting'); phase('restart', 'restarting codearts server');
        try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
      }
      const backoff = cls === 'think' ? 5 : cls === 'rate' || cls === 'transport' ? 120 * interruptions : 15;
      phase('backoff');
      if (!(await waitInterruptible(backoff, `backoff after ${cls}`))) return { ok: false, sid, reason: 'stopped' };
      phase(label, 'resuming');
      const kick = pendingKick; pendingKick = null;
      if (kick?.mode === 'server') {
        L('== kick: codearts server killed; restarting'); phase('restart', 'restarting codearts server');
        try { await server.start(); S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; } catch (err) { return { ok: false, sid, reason: `server restart failed: ${err.message}` }; }
        phase(label, 'resuming after kick');
      }
      const extra = kick?.text ? `\n\nMessage from the lead: ${kick.text}` : '';
      if (kick && kick.mode === 'fresh' && freshSession) {
        sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
        if (label === 'build' || label === 'fix') builderSessions.add(sid);
        say(`kick: switching to a fresh session ${sid}`);
        await send(sid, freshSession('kick', kick.text || 'the lead asked for a clean restart') + extra, model, agent);
      } else if (kick) {
        await send(sid, resumeText('kick', `${kick.mode} kick from ${kick.by}`) + extra, model, agent);
      } else if (o.kind === 'think') {
        let switched = false;
        if (++thinkStalls >= 2 && (label === 'build' || label === 'fix') && FALLBACK && FALLBACK !== 'none' && FALLBACK !== model) {
          say(`thinking stalled ${thinkStalls} times on ${model}: switching the builder to ${FALLBACK} (same session, context kept)`);
          S.modelSwitches = [...(S.modelSwitches || []), { at: now(), from: model, to: FALLBACK, why: `${thinkStalls} thinking stalls` }];
          model = FALLBACK; curModel = model; buildModel = model; S.models.build = model; thinkStalls = 0; interruptions = 0; save(true);
          switched = true;
        }
        if (switched) await waitForSlot(model);
        await send(sid, label === 'review' ? resumeText('think', o.what) : o.nudge, model, agent);
      } else if (++sameSessionFails >= 2 && freshSession) {
        sid = await newSession(`${task} ${label} (fresh)`); sameSessionFails = 0;
        if (label === 'build' || label === 'fix') builderSessions.add(sid);
        say(`switching to a fresh session ${sid}`); await send(sid, freshSession(cls, what), model, agent);
      } else {
        await send(sid, resumeText(cls, what), model, agent);
      }
      if (label === 'build' || label === 'fix') S.buildSession = sid;
    }
  }

  // Files already dirty before the lane started are not this lane's fault: leave them out of the gate.
  const dirty = () => dirtyAll().filter((l) => !PRE_DIRTY.has(l));
  // The CHECK shell inherits the runner's PATH. A supervisor launched by a service, a daemon or the
  // CodeArts CLI often has a minimal PATH with no node on it, so `node --check ...` exits 127
  // "command not found". Put the node running the runner first on PATH so every CHECK line resolves
  // `node` (and npm beside it) to a real binary.
  const checkEnv = () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const dir = path.dirname(process.execPath);
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const parts = String(process.env[key] || '').split(path.delimiter).filter(Boolean);
    if (!parts.some((p) => same(p, dir))) parts.unshift(dir);
    return { ...process.env, [key]: parts.join(path.delimiter) };
  };
  // Run the CHECK lines in the same shell the rest of the runner trusts. On Windows a bare 'bash'
  // can resolve to WSL's /bin/bash, which does not see the Windows node on PATH (the error reads
  // "/bin/bash: line 1: node: command not found"); workerShell() picks Git's bash, which inherits
  // the Windows environment and finds the node that checkEnv() put on PATH.
  const checkShell = () => { const s = workerShell(); return s && fs.existsSync(s) ? s : 'bash'; };
  const runCheck = (cmd) => new Promise((res) => {
    const t0 = now(); let out = '';
    const ch = spawn(checkShell(), ['-c', cmd], { cwd: repo, env: { ...checkEnv(), CA_LANE: id }, windowsHide: true });
    const timer = setTimeout(() => { out += `\n[runner: timed out after ${CFG.checkTimeout}s]`; killTree(ch.pid); }, CFG.checkTimeout * 1000);
    ch.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    ch.stderr.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    ch.on('close', (code) => { clearTimeout(timer); res({ code: code ?? 1, out, ms: now() - t0 }); });
    ch.on('error', (e) => { clearTimeout(timer); res({ code: 127, out: String(e), ms: now() - t0 }); });
  });
  // Fingerprint the exact content under test: every tracked file plus every nonignored untracked file,
  // by path and bytes. A commit that leaves the working tree byte-identical does not change it, so a
  // check run before that commit stays valid; any content change (or a check that writes the tree)
  // changes it and disables the reuse.
  const contentFingerprint = () => {
    const h = crypto.createHash('sha256');
    // NUL-delimited output, so a path with a space or a non-ASCII name is the raw bytes git has, not
    // the quoted escape form the newline output would give. Any git, stat or read error means the
    // fingerprint cannot vouch for the tree: return null so nothing is reused (fail closed).
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'buffer', windowsHide: true });
    const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'buffer', windowsHide: true });
    if (tracked.status !== 0 || others.status !== 0) return null;
    const list = new Set();
    for (const buf of [tracked.stdout, others.stdout]) for (const f of String(buf || '').split('\0')) if (f) list.add(f);
    // A submodule is a directory in the working tree but a committed gitlink in the index: lstat alone
    // would hash it as an opaque directory, so an in-submodule change (a moved HEAD the worker commits
    // as a new gitlink) would leave the fingerprint unchanged and wrongly reuse a stale green check.
    // Read the recorded gitlink commits from the index and hash the one this path points at.
    let gitlinks = null;
    const gitlinkSha = (f) => {
      if (!gitlinks) {
        gitlinks = new Map();
        const r = spawnSync('git', ['ls-files', '-s', '-z'], { cwd: repo, encoding: 'buffer', windowsHide: true });
        if (r.status === 0) for (const rec of String(r.stdout || '').split('\0')) {
          const m = rec.match(/^(\d{6}) ([0-9a-f]+) \d+\t([\s\S]+)$/);
          if (m && m[1] === '160000') gitlinks.set(m[3], m[2]);
        }
      }
      return gitlinks.get(f) || null;
    };
    for (const f of [...list].sort()) {
      h.update(f); h.update('\0');
      const full = path.join(repo, f);
      let st;
      try { st = fs.lstatSync(full); } catch { return null; }
      // File type and permission bits: an exec bit or a symlink swap changes the fingerprint.
      h.update(String(st.mode & 0o777777)); h.update('\0');
      if (st.isSymbolicLink()) {
        let target; try { target = fs.readlinkSync(full); } catch { return null; }
        h.update('link:'); h.update(target); h.update('\0');
      } else if (st.isFile()) {
        let data; try { data = fs.readFileSync(full); } catch { return null; }
        h.update('file:'); h.update(data); h.update('\0');
      } else {
        const sha = gitlinkSha(f);
        if (!sha) return null; // a directory the index does not track as a submodule: cannot vouch for it
        const subState = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: full, encoding: 'utf8', windowsHide: true });
        if (subState.status !== 0 || subState.stdout.trim() || git(full, 'rev-parse', 'HEAD') !== sha) return null;
        h.update('gitlink:'); h.update(sha); h.update('\0');
      }
    }
    return h.digest('hex');
  };
  // Run one CHECK request from the worker's helper: same shell, env and timeout as the gates. Every
  // line run is recorded in S.workerChecks, and the result file is written atomically (tmp + rename).
  const writeCheckResult = (rid, obj) => writeAtomic(path.join(reqDir, `${rid}.result.json`), JSON.stringify(obj));
  // Bounded in-memory cache of green check-service runs, keyed by line, command and content
  // fingerprint: repeating the same helper for the same content answers from here instead of running
  // the check again. Failures and mutated runs are never cached, and the cache holds only the output.
  const checkCache = [];
  const handleCheckRequest = async (req) => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const clean = dirty().length === 0;
    const arg = String(req.arg || '').trim();
    const runLine = async (n, cmd) => {
      const fpBefore = contentFingerprint();
      // Reuse the most recent green run of this exact line when the tested content and the command are
      // unchanged: the worker can run the same helper twice (a permission prompt, a retry) and should
      // not pay for the check twice. A missing fingerprint, changed content or a failed run is never
      // reused.
      let hit = null;
      if (fpBefore) for (let i = checkCache.length - 1; i >= 0; i--) { const e = checkCache[i]; if (e.n === n && e.cmd === cmd && e.fp === fpBefore) { hit = e; break; } }
      if (hit) {
        L(`  = check service: reused green ${n} (identical content)`);
        S.workerChecks.push({ n, cmd, code: hit.code, ms: hit.ms, at: now(), head, clean, fp: fpBefore, cached: true }); save(true);
        return { n, cmd, code: hit.code, ms: hit.ms, out: hit.out };
      }
      L(`  > check service: ${n} ${cmd}`);
      const t0 = now(); const r = await runCheck(cmd);
      // A check that mutated the tree cannot vouch for the content the gate will see: record no
      // fingerprint so the run is never reused.
      const fp = contentFingerprint() === fpBefore ? fpBefore : null;
      L(`  < check service: exit ${r.code} (${dur(now() - t0)})`);
      S.workerChecks.push({ n, cmd, code: r.code, ms: r.ms, at: now(), head, clean, fp }); save(true);
      // Cache only green runs with a valid fingerprint, bounded in memory: no secrets, no extra logs.
      if (fp && r.code === 0) { checkCache.push({ n, cmd, fp, code: r.code, ms: r.ms, out: r.out }); while (checkCache.length > 64) checkCache.shift(); }
      return { n, cmd, code: r.code, ms: r.ms, out: r.out };
    };
    const lines = [];
    if (arg === 'all') {
      for (let i = 0; i < checks.length; i++) { const rec = await runLine(i + 1, checks[i]); lines.push(rec); if (rec.code !== 0) break; }
    } else if (/^\d+$/.test(arg) && Number(arg) >= 1 && Number(arg) <= checks.length) {
      lines.push(await runLine(Number(arg), checks[Number(arg) - 1]));
    } else {
      const msg = `no CHECK line ${arg}: use 1 to ${checks.length}`;
      S.workerChecks.push({ n: Number(arg) || 0, cmd: '', code: 2, ms: 0, at: now(), head, clean }); save(true);
      writeCheckResult(req.id, { id: req.id, code: 2, out: msg, at: now() });
      return;
    }
    const code = lines.length ? lines[lines.length - 1].code : 2;
    const out = lines.map((x) => `== check ${x.n}: ${x.cmd}\n` + String(x.out || '').replace(/\s+$/, '').split(/\r?\n/).slice(-60).join('\n')).join('\n');
    writeCheckResult(req.id, { id: req.id, code, out, at: now() });
  };
  async function gitCleanGate() {
    const d = dirty();
    if (d.length) {
      // A dirty tree that cannot be written is a blocked disk, not a code problem: the worker can never
      // commit it, so end the build loop at once (no fix round) with the same reason as the start probe.
      const wp = writeProbe(repo);
      if (!wp.ok) {
        const why = `repo not writable: ${wp.where}: ${wp.error}`;
        S.gates.push({ at: now(), gate: 'repo writable', ok: false, detail: why }); L(`== gate repo writable: FAIL (${why})`);
        return { ok: false, write: true, what: 'repo writable', reason: why };
      }
      // The tree is dirty and the runner itself can write: if the worker's own commit was refused
      // (its reply or tool output shows a git error), commit the work here instead of wasting a fix
      // round on "commit"; the worker cannot fix a sandbox it is not allowed to write to.
      const refused = commitRefused(`${lastWorkerReply}\n${lastToolOutput}`);
      const dec = commitFallbackDecision({ dirty: true, refused, writable: true });
      if (dec.action === 'fail') {
        const why = dec.reason;
        S.gates.push({ at: now(), gate: 'git clean', ok: false, detail: why }); L(`== gate git clean: FAIL (${why})`);
        return { ok: false, write: true, what: 'commit failed', reason: why };
      }
      if (dec.action === 'commit') {
        const step = stepProgress(S).current;
        const subject = step ? `step ${step.n}: ${oneLine(step.text, 120)}` : `step ${S.commits + 1}: the worker's uncommitted work`;
        git(repo, 'add', '-A');
        const cm = spawnSync('git', ['commit', '-m', subject, '-m', `committed by the runner: the worker's commit was refused (${oneLine(refused, 200)})`], { cwd: repo, encoding: 'utf8', windowsHide: true });
        if (cm.status !== 0) {
          const first = String((cm.stderr || '') + (cm.stdout || '')).trim().split(/\r?\n/).find((l) => l.trim()) || `exit ${cm.status}`;
          const why = `commit failed: ${oneLine(first, 200)}`;
          S.gates.push({ at: now(), gate: 'git clean', ok: false, detail: why }); L(`== gate git clean: FAIL (${why})`);
          return { ok: false, write: true, what: 'commit failed', reason: why };
        }
        S.interruptions.push({ at: now(), phase: 'gate', kind: 'commit-fallback', what: `${subject} (${oneLine(refused, 160)})` }); save(true);
        L(`== commit fallback: committed "${subject}" (the worker's commit was refused)`);
        syncCommits();
        if (dirty().length) {
          const why = `commit failed: git clean still failing after the runner's commit`;
          S.gates.push({ at: now(), gate: 'git clean', ok: false, detail: why }); L(`== gate git clean: FAIL (${why})`);
          return { ok: false, write: true, what: 'commit failed', reason: why };
        }
        S.gates.push({ at: now(), gate: 'git clean', ok: true }); L('== gate git clean: ok (committed by the runner)');
      } else {
        S.gates.push({ at: now(), gate: 'git clean', ok: false, detail: d.slice(0, 5).join(', ') }); L(`== gate git clean: FAIL (${d.length} changed)`);
        return { ok: false, what: 'uncommitted changes', message: `Runner check failed: the turn ended with uncommitted changes:\n${d.slice(0, 20).join('\n')}\nFinish the step these belong to, run its checks, and commit. Do not leave work uncommitted. If a commit fails, put the exact error in your reply.` + CHECK_HELP };
      }
    } else {
      S.gates.push({ at: now(), gate: 'git clean', ok: true }); L('== gate git clean: ok');
    }
    return { ok: true };
  }
  // The final review starts right after the git clean gate and runs while these CHECK lines run.
  async function runChecks() {
    // Reuse the worker's own green runs independently per line when the exact tested content is
    // unchanged for that line. A commit that leaves the working tree byte-identical must not force the
    // gate to run the same checks again, and a stale, missing or failed line must not force the gate to
    // rerun the lines that are already green. The fingerprint covers tracked and nonignored untracked
    // content and the check command, so a run that mutated the tree, failed, or a command that changed
    // is never reused.
    // For each line, the latest recorded worker run of that exact line and command. Reuse needs that
    // run to be green with a stable, non-null fingerprint; a missing run, a non-zero exit or a null
    // fingerprint falls through to a real run so no failing result is ever lost.
    const latest = checks.map((c, i) => { let e = null; for (const x of S.workerChecks) if (x.n === i + 1 && x.cmd === c) e = x; return e; });
    // Bounded opt-in parallelism: one at a time by default (checks may depend on order), more with a
    // `CHECK_PARALLEL: N` brief line or the CHECK_PARALLEL env var (the env wins, so a lead can force
    // it). Capped at 8 so a typo cannot spawn a check storm; results come back in CHECK order either way.
    const briefParallel = Number((brief.match(/^\s*CHECK_PARALLEL:\s*(\d+)/m) || [])[1]) || 0;
    // The env var wins even when it is 0: a lead must be able to force the safe sequential path over a
    // brief `CHECK_PARALLEL` value. Only an unset or non-numeric env falls back to the brief line.
    const envRaw = process.env.CHECK_PARALLEL;
    const envParallel = envRaw !== undefined && envRaw !== '' && Number.isFinite(Number(envRaw)) ? Number(envRaw) : null;
    const want = envParallel !== null ? envParallel : (briefParallel || 1);
    const width = Math.max(1, Math.min(want, 8, checks.length || 1));
    if (width > 1) L(`== gate checks: ${checks.length} lines, up to ${width} in parallel`);
    const results = await runOrdered(checks, async (c, i) => {
      // Reuse only when this line's own latest run is green and the content under test right now is
      // byte-identical to what that run fingerprinted. Recomputing the fingerprint here means a run is
      // never reused after an earlier check changed the tree, so a reused gate always vouches for the
      // exact content the gate is about to accept.
      const e = latest[i];
      if (e && e.code === 0 && e.fp && contentFingerprint() === e.fp) {
        L(`== gate check reused (worker ran it green on identical content)`);
        return { cmd: c, code: 0, out: e.out || '', ms: e.ms, kind: 'pass', reused: true };
      }
      phase('gate', `running check: ${oneLine(c, 80)}`); L(`== gate check: ${c}`);
      let r = await runCheck(c);
      let kind = classifyCheck({ code: r.code, out: r.out });
      // An infra failure is the machine, not the work: rerun that one check once, 3 s later, before
      // deciding. A check that cannot run (missing tool, sandbox, timeout) never starts a fix round.
      if (kind === 'infra') {
        L(`== gate check could not run (exit ${r.code}); retrying once in 3 s`); await sleep(3000);
        r = await runCheck(c); kind = classifyCheck({ code: r.code, out: r.out });
      }
      return { cmd: c, code: r.code, out: r.out, ms: r.ms, kind, reused: false };
    }, { concurrency: width, stopOn: (r) => !r.value || r.value.kind !== 'pass' });
    // Report in CHECK order so the gates, the log and the fix message name the earliest failing line
    // whether the lines ran one by one or side by side. In parallel every line already ran, so every
    // result is recorded: the loop does not stop early, and the fix message returned afterwards names
    // the earliest failing line. A stopped sequential run leaves the unstarted lines undefined and skips
    // them, so it still records exactly the lines that ran (reused or executed).
    const bad = [];
    for (const res of results) {
      if (!res) continue;
      const c = res.value ? res.value.cmd : checks[res.index];
      const code = res.value ? res.value.code : 1;
      const out = res.value ? res.value.out : String(res.error || 'the check did not run');
      const ms = res.value ? res.value.ms : 0;
      const kind = res.value ? res.value.kind : 'infra';
      const reused = !!(res.value && res.value.reused);
      const tail = out.trim().split(/\r?\n/).slice(-40).join('\n');
      S.gates.push({ at: res.started, gate: c, ok: code === 0, code, kind, ms, ...(reused ? { reused: true } : {}) }); save(true);
      if (kind === 'infra') { L(`== gate check could not run (exit ${code}, ${dur(ms)})`); block('| ', tail); bad.push({ infra: true, what: c, code, message: `Runner check could not run: \`${c}\` exited ${code}. This is the machine, not your work (missing tool, sandbox or timeout), so there is nothing to fix in the code. Last output:\n\`\`\`\n${tail}\n\`\`\`` }); continue; }
      if (kind === 'fail') { L(`== gate check FAIL (exit ${code}, ${dur(ms)})`); block('| ', tail); bad.push({ what: c, code, message: `Runner check failed: \`${c}\` exited ${code}. Last output:\n\`\`\`\n${tail}\n\`\`\`\nFind the cause, fix it, rerun the check in the foreground with a timeout, and commit the fix. Never sleep-poll a background job (\`sleep N; cat log\`): every idle turn replays the whole context.` + CHECK_HELP }); continue; }
      L(`== gate check ok (${dur(ms)})`);
    }
    if (bad.length) return { ok: false, ...bad[0] };
    return { ok: true };
  }
  // The final review runs while the CHECK lines run. It may use drive() because no builder turn runs
  // during the gates. A stale review (a CHECK failed) is aborted and discarded; the next passing gate
  // starts a fresh one.
  const stepReviewAppendix = () => {
    if (!S.stepReviews.length) return '';
    const lines = S.stepReviews.map((x) => {
      // The first finding line: the verdict line is not a finding, so skip it (a review that found
      // nothing replies with the verdict line alone, which would otherwise read as a finding here).
      const first = (x.text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^STEP VERDICT:/i.test(l)) || '(no findings)';
      return `step ${(x.steps || []).join(', ')}: ${x.verdict}: ${oneLine(first, 120)}`;
    });
    return `\n\nStep reviews already done:\n${lines.join('\n')}`;
  };
  // A reused review session already holds an earlier turn's reply. Only a NEW assistant message id
  // proves this turn produced a fresh verdict; a brand-new session has no prior message to confuse.
  // A missing id on a reused session (or the same id as before) is never accepted: fail closed.
  const freshReviewReply = async (sid, baseline) => {
    const msgs = await assistantMessages(sid);
    if (msgs === null) return { ok: false, reason: 'read-failed', text: '' };
    const last = lastAssistant(msgs);
    if (!last) return { ok: false, reason: 'empty', text: '' };
    const id = msgIdOf(last); const text = msgText(last);
    if (baseline) {
      if (!id) return { ok: false, reason: 'no-id', text };
      if (id === baseline) return { ok: false, reason: 'stale', text };
    }
    return { ok: true, text, msgId: id || null };
  };
  // Pick the last healthy completed final-review session to reuse for a focused fix round. Reuse only
  // when the recorded round used the same reviewer model, its assistant id is still the session's last
  // assistant message (no intervening turn) and the session exists and is idle. Any doubt -> fresh.
  const reusableReviewSession = async (prev) => {
    if (!prev) return null;
    if (prev.model !== REVIEW) return null;                    // model changed -> fresh
    if (!prev.sid || !prev.msgId) return null;                 // missing ids -> fresh
    if (builderSessions.has(prev.sid) || prev.sid === S.buildSession) return null; // never a builder session
    let statuses; try { statuses = await server.api('GET', '/session/status', null, 10000); } catch { return null; }
    const st = statuses && statuses[prev.sid] ? statuses[prev.sid].type : undefined;
    if (st !== 'idle') return null;                            // busy/retry/error/missing session -> fresh
    const s = sess[prev.sid];
    if (s && s.error) return null;                             // a session that errored -> fresh
    const msgs = await assistantMessages(prev.sid);
    if (msgs === null) return null;                            // unreadable/missing -> fresh
    const last = lastAssistant(msgs);
    if (!last || msgIdOf(last) !== prev.msgId) return null;    // an intervening message -> fresh
    return prev.sid;
  };
  let reviewInvalidated = ''; // set when the acceptance revalidation finds the reviewed content changed
  const applyFinalReview = async (rsid, rres, head0, from, at) => {
    const text = String(rres.text || '').trim();
    let body = text || `(no review text: ${rres.reason || 'empty'})`;
    const vm = rres.ok && text.match(/VERDICT:\s*(ready|needs fixes)/i);
    S.verdict = vm ? vm[1].toLowerCase() : `missing${rres.ok ? '' : ' (' + rres.reason + ')'}`;
    // Acceptance revalidation: the reviewer is read-only. If HEAD moved or the work tree is dirty after
    // its turn, the verdict describes content that no longer exists, so it can never be accepted: end
    // needs review with an actionable reason and never auto-commit these changes.
    const warn = [];
    if (git(repo, 'rev-parse', 'HEAD') !== head0) warn.push('the reviewer moved HEAD');
    if (dirty().length) warn.push('the reviewer left uncommitted changes in the work tree');
    if (warn.length) {
      S.errors.push({ at: now(), msg: warn.join('; ') }); L(`! ${warn.join('; ')}`);
      S.verdict = 'needs fixes';
      reviewInvalidated = `the reviewer changed the reviewed content (${warn.join('; ')}); re-run the lane on the current commit`;
      body += `\n\nRunner acceptance revalidation failed: ${warn.join('; ')}. The reviewer must be read-only and the reviewed commit unchanged, so this verdict does not apply. The changes are left for a human to inspect (never auto-committed); re-run the lane on the current commit.`;
    }
    // review.md holds the latest review; the earlier rounds are kept below it under a heading.
    const earlier = S.reviewRounds.map((x) => x.text).filter(Boolean);
    fs.writeFileSync(path.join(dir, 'review.md'), earlier.length ? `${body}\n\n## Earlier review\n\n${earlier.join('\n\n---\n\n')}` : body);
    const t = Number.isFinite(at) ? at : now();
    S.reviewRounds.push({ round: S.reviewRounds.length + 1, verdict: S.verdict, at: t, ms: now() - t, from, to: head0, sid: rsid, model: REVIEW, msgId: rres.msgId || null, text: body });
    clearStepReviewDeferred(); // the final review covers the whole range: a deferred marker is moot
    save(true);
    review = text; finalReviewed = true;
  };
  // The runner collects the review context once so the reviewer does not spend tool round trips
  // rediscovering it: the brief, the commits, the diff stat and, while the change is small, the diff
  // itself. Every git read is bounded and fail-closed: a command that fails, overflows its buffer or a
  // change too large to inline becomes an explicit "read it yourself" pointer, never a silent empty
  // result that could read as "no changes". This is a starting point: the reviewer still reads the full
  // spec and whatever source it needs.
  const reviewContext = (from) => {
    const MAX_BRIEF = 8000, MAX_LOG = 6000, MAX_STAT = 6000, MAX_DIFF = 16000;
    // Bounded git read: a non-zero exit or an output over maxBuffer returns ok:false so the caller can
    // fall back to a pointer instead of presenting an empty stdout as a successful, empty result.
    const capture = (args, maxBuffer) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer, windowsHide: true });
      if (r.error || r.status !== 0) return { ok: false, text: '' };
      return { ok: true, text: String(r.stdout || '') };
    };
    // A truncated brief must say so and send the reviewer to the full spec: a partially pasted spec
    // could hide requirements, so it is never presented as the whole thing.
    const briefText = brief.length > MAX_BRIEF
      ? brief.slice(0, MAX_BRIEF) + `\n[truncated at ${MAX_BRIEF} chars: this is only the start of the spec. Open tasks/${task}.md and judge every requirement against the full file.]`
      : brief;
    const box = (label, c, max, empty, hint) => {
      if (!c.ok) return `${label}: could not be read here; read it yourself with \`${hint}\` and open the changed files.`;
      const t = c.text.trim();
      if (!t) return `${label}:\n\`\`\`\n${empty}\n\`\`\``;
      return `${label}:\n\`\`\`\n${t.length > max ? t.slice(0, max) + `\n[truncated at ${max} chars: read the rest with ${hint}]` : t}\n\`\`\``;
    };
    const parts = [`Task brief (tasks/${task}.md):\n\`\`\`\n${briefText}\n\`\`\``];
    parts.push(box(`Commits (${from}..HEAD)`, capture(['log', '--oneline', `${from}..HEAD`], MAX_LOG + 4096), MAX_LOG, '(none)', `git log --oneline ${from}..HEAD`));
    parts.push(box(`Diff stat (${from}..HEAD)`, capture(['diff', '--stat', from, 'HEAD'], MAX_STAT + 4096), MAX_STAT, '(no changes)', `git diff --stat ${from} HEAD`));
    // The raw diff inlines only while it fits the buffer and is small enough; a failure, an overflow or
    // a huge change all become the same explicit pointer, so a large change is never a silent empty diff.
    const diffC = capture(['diff', from, 'HEAD'], MAX_DIFF + 1);
    if (diffC.ok && !diffC.text.trim()) parts.push(`Diff (${from}..HEAD): no changes.`);
    else if (diffC.ok && diffC.text.length <= MAX_DIFF) parts.push(`Diff (${from}..HEAD):\n\`\`\`\n${diffC.text.trim()}\n\`\`\``);
    else parts.push(`Diff (${from}..HEAD): not inlined here (unavailable or too large to paste). Read the full change with \`git diff ${from} HEAD\` and open the changed source.`);
    return `\n\nPrepared context from the runner (a starting point; still open the source you need and judge every requirement yourself):\n\n${parts.join('\n\n')}`;
  };
  // One builder for the final review prompt, so the normal and the speculative review send the exact
  // same text: the template (or tasks/<task>.review.md), the step-review appendix, the prepared
  // context and, for a fix round, the previous findings block that names the fix range.
  const finalReviewPrompt = (prev) => {
    const rf = path.join(repo, 'tasks', `${task}.review.md`);
    const custom = fs.existsSync(rf);
    // A fix round gets its own dedicated fix-only prompt (every prior finding, the full fix range, a
    // regression assessment, the read-only rule and the same VERDICT line) instead of the full-review
    // template plus a replay of the whole review context, which only competes with the fix instructions.
    // A custom tasks/<task>.review.md is still honored: its instructions are kept alongside the fix prompt.
    if (prev && prev.to && prev.verdict === 'needs fixes') {
      // Function replacers: prior-review findings are untrusted text, and a `$&`/`$1`/`$'` in a string
      // replacement would be read as a replacement directive and corrupt or inject into the fix prompt.
      let rb = fs.readFileSync(path.join(SKILL, 'templates', 'review-fix.md'), 'utf8')
        .replaceAll('{TASK}', () => task).replaceAll('{START}', () => START).replaceAll('{FROM}', () => prev.to).replaceAll('{FINDINGS}', () => prev.text || '(no findings recorded)');
      if (custom) rb += `\n\nAdditional review instructions (tasks/${task}.review.md):\n${fs.readFileSync(rf, 'utf8')}`;
      return rb;
    }
    let rb = custom ? fs.readFileSync(rf, 'utf8')
      : fs.readFileSync(path.join(SKILL, 'templates', 'review.md'), 'utf8').replaceAll('{TASK}', () => task).replaceAll('{START}', () => START);
    rb += stepReviewAppendix();
    rb += reviewContext(prev && prev.to ? prev.to : START);
    return rb;
  };
  const startFinalReview = async (prev, forceFresh) => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    const rb = finalReviewPrompt(prev);
    // A focused fix round reuses the previous healthy reviewer session (its context is already warm),
    // unless it is missing, busy, errored, changed model or has an intervening turn: then a fresh one.
    const reused = forceFresh ? null : await reusableReviewSession(prev);
    let rsid, baseline = null;
    if (reused) { rsid = reused; baseline = prev.msgId; }
    else { rsid = await newSession(`${task} review`); }
    S.reviewSession = rsid; reviewSessions.add(rsid);
    L(`== review (${REVIEW}, read-only plan agent) session ${rsid}${reused ? ' (reused healthy reviewer context)' : ''}${prev ? `; fix round ${prev.round}` : ''}`);
    await send(rsid, rb, REVIEW, 'plan');
    S.reviewStartedAt = now();
    const promise = drive(rsid, REVIEW, 'plan', 'review', () => 'Your previous turn was interrupted. Finish the review: the numbered item list and the final VERDICT line.');
    return { sid: rsid, head0, from: prev && prev.to ? prev.to : START, at: S.reviewStartedAt, baseline, reused: !!reused, prev, promise };
  };
  const asNormalFr = (fr2) => ({ sid: fr2.sid, head: fr2.head0, from: fr2.from, at: fr2.at, promise: fr2.promise, spec: false, baseline: fr2.baseline, reused: fr2.reused, prev: fr2.prev });
  const discardFinalReview = async (fr) => {
    if (!fr) return;
    const s = sx(fr.sid);
    // A speculative review's own poller has no drive() loop to notice the abort: flag it so it stops at once
    // instead of spinning to its 60 s "missing" deadline (which would delay the fix-round message).
    if (fr.spec) specReviewCancel = true;
    try { await server.api('POST', `/session/${fr.sid}/abort`, {}); } catch (err) { L(`! review abort failed: ${err.message}`); }
    s.aborting = true; s.busy = false; s.sawBusy = true;
    try { await fr.promise; } catch {}
    s.aborting = false;
    if (fr.spec) specReviewCancel = false;
    if (S.reviewSession === fr.sid) S.reviewSession = null;
  };

  // ---- speculative final review ----
  // The builder spends 30 s to 2.6 min after its last step commit (final checks, wrap-up reply) before the
  // gates, and only then did the final review start. As soon as every numbered step has a "step N:" commit
  // and the work tree is clean, the final review starts in its own session while the builder wraps up. It is
  // an independent poller like runStepReview: never drive()/send()/waitTurn(), which belong to the builder.
  // State: S.specReview = { head, at, used }. When the builder goes idle and the git clean gate passes, a
  // review whose HEAD is still the one it saw is used as the final review; otherwise it is aborted and the
  // normal review runs. An in-flight step review is cancelled when the speculative one starts (it covers it).
  let specReview = null; // { sid, sidP, head, from, at, promise, used } for the current round, or null
  let specReviewStarting = false; // reserved while maybeSpecReview settles a step review before it starts
  let specReviewCancel = false;   // set when the speculative review is discarded, so its poller stops at once
  const startSpecReview = (prev) => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const at = now();
    const rb = finalReviewPrompt(prev);
    const rec = { sid: null, sidP: null, head, from: prev && prev.to ? prev.to : START, at, used: false, promise: null, prev, baseline: null, reused: false };
    S.specReview = { head, at, used: false };
    S.reviewStartedAt = at;
    save(true);
    specReviewCancel = false;
    // Create the session up front and keep the id promise: beginFinalReview and discardSpecReview need the
    // session even before the review promise finishes, so it can never be read as a not-yet-assigned null.
    // The selection is shared with the normal final review: a healthy completed reviewer session is reused
    // for a focused fix round, otherwise a fresh session is created.
    rec.sidP = (async () => {
      const reuse = await reusableReviewSession(prev);
      if (reuse) { rec.reused = true; rec.baseline = prev.msgId; return reuse; }
      return await newSession(`${task} review (speculative)`);
    })();
    rec.promise = (async () => {
      try {
        rec.sid = await rec.sidP;
        reviewSessions.add(rec.sid);
        sent.add(rb.trim()); // the runner's own prompt: never list it as a TUI steer
        await server.api('POST', `/session/${rec.sid}/prompt_async`, { model: splitModel(REVIEW), agent: 'plan', parts: [{ type: 'text', text: rb }] });
        L(`== speculative review (${REVIEW}, plan agent) session ${rec.sid}${rec.reused ? ' (reused healthy reviewer context)' : ''} on ${head.slice(0, 8)}: starts while the builder wraps up`);
        const deadline = at + CFG.stepReviewTimeout * 1000; let sawBusy = false, text = '';
        for (;;) {
          if (specReviewCancel) { try { await server.api('POST', `/session/${rec.sid}/abort`, {}); } catch {} return { sid: rec.sid, ok: false, reason: 'cancelled', text, reused: rec.reused }; }
          if (now() > deadline) {
            // The polling budget is spent. If the session is alive and progressing, do NOT abort it: hand it
            // to the normal final review, which drives the SAME session with the normal watchdog and the
            // overall lane deadline, instead of discarding it and replaying the whole review. Only a session
            // that never went busy is treated as missing and aborted here.
            if (sawBusy) return { sid: rec.sid, ok: false, reason: 'busy-timeout', text, reused: rec.reused };
            try { await server.api('POST', `/session/${rec.sid}/abort`, {}); } catch {}
            return { sid: rec.sid, ok: false, reason: 'timeout', text, reused: rec.reused };
          }
          await sleep(3000);
          let st; try { st = (await server.api('GET', '/session/status', null, 10000))[rec.sid]?.type; } catch { st = undefined; }
          if (st === 'busy' || st === 'retry') { sawBusy = true; continue; }
          // Read only through the freshness proof: a reused session's cached reply (same id as before)
          // must never be accepted as this turn's verdict.
          const fresh = await freshReviewReply(rec.sid, rec.baseline);
          text = fresh.text;
          // A NEW message id alone is not enough. Mirror drive()/waitTurn, which returns kind 'error'
          // when the session error is set: a turn that errors mid-reply can leave a partial assistant
          // message whose fresh id would otherwise be accepted as this turn's verdict. Fail here so the
          // normal final review takes over with its retry and auth detection instead.
          if (sx(rec.sid).error) return { sid: rec.sid, ok: false, reason: 'error', text: fresh.text, reused: rec.reused };
          if (sawBusy || fresh.ok) {
            return fresh.ok
              ? { sid: rec.sid, ok: true, reason: '', text: fresh.text, msgId: fresh.msgId, reused: rec.reused }
              : { sid: rec.sid, ok: false, reason: fresh.reason || 'empty', text: fresh.text, reused: rec.reused };
          }
          if (now() - at > 60000) return { sid: rec.sid, ok: false, reason: 'missing', text: '', reused: rec.reused };
        }
      } catch (err) { L(`! speculative review error: ${oneLine(String((err && err.message) || err), 200)}`); return { sid: rec.sid, ok: false, reason: 'error', text: '', reused: rec.reused }; }
    })().catch(() => ({ sid: rec.sid, ok: false, reason: 'error', text: '', reused: false }));
    specReview = rec;
    return rec;
  };
  const maybeSpecReview = async () => {
    if (CFG.noReview || specReview || specReviewStarting) return;
    const pg = stepProgress(S);
    if (!pg.total || pg.done !== pg.total) return;
    if (dirty().length) return;
    // Nothing new to review: in a review fix round the tree is clean at the HEAD the last review already saw
    // until the fix is committed. Speculating there only spends review tokens on a review that gets discarded.
    const lastRound = S.reviewRounds[S.reviewRounds.length - 1];
    if (lastRound && lastRound.to && git(repo, 'rev-parse', 'HEAD').startsWith(String(lastRound.to).slice(0, 7))) return;
    // Reserve the round before any await: a tick that runs during the grace below must not start a second
    // review alongside this one (startSpecReview sets specReview at once, but the guard also covers the gap).
    specReviewStarting = true;
    try {
      startSpecReview(S.reviewRounds[S.reviewRounds.length - 1]);
      // The speculative review reads the whole range, so cancel a step review still in flight, after the same
      // short grace the idle path allows (a nearly done finding can still reach the builder). Once cancelled,
      // mark the commits that review covered as reviewed so maybeStepReview does not relaunch it next tick.
      if (stepReviewRunning) {
        const sr = stepReviewRunning; const covered = stepReviewTo;
        const settled = await Promise.race([sr.then(() => true, () => true), sleep(CFG.stepReviewGrace * 1000).then(() => false)]);
        if (!settled) {
          stepReviewCancel = true;
          L(`== speculative review starts: step review still running after ${CFG.stepReviewGrace}s; cancelled (the final review covers those commits)`);
          try { await sr; } catch {}
          stepReviewCancel = false;
          if (covered) lastReviewedHash = covered;
          clearStepReviewDeferred();
        }
      }
    } finally { specReviewStarting = false; }
  };
  const discardSpecReview = async () => {
    const rec = specReview; if (!rec) return;
    const sid = rec.sid || (rec.sidP ? await rec.sidP.catch(() => null) : null);
    const s = sid ? sx(sid) : null;
    if (sid) { try { await server.api('POST', `/session/${sid}/abort`, {}); } catch (err) { L(`! speculative review abort failed: ${err.message}`); } }
    if (s) { s.aborting = true; s.busy = false; s.sawBusy = true; }
    specReviewCancel = true;
    try { await rec.promise; } catch {}
    specReviewCancel = false;
    if (s) s.aborting = false;
    specReview = null; // release the round: a discarded review must not block maybeSpecReview in the next fix round (S.specReview stays for the contract)
  };
  // Start (or reuse) the final review for the current round. A speculative review whose HEAD is still the
  // current HEAD is awaited in place of the normal review (its text and verdict go through applyFinalReview
  // unchanged); a stale one is aborted and the normal final review starts as before. Returns a normalized
  // handle { sid, head, from, at, promise, spec } or null when review is off.
  const beginFinalReview = async () => {
    if (CFG.noReview) return null;
    const head = git(repo, 'rev-parse', 'HEAD');
    if (specReview && specReview.head === head) {
      specReview.used = true;
      if (S.specReview) S.specReview.used = true;
      save(true);
      L(`== final review: using the speculative review on ${head.slice(0, 8)}`);
      const sid = specReview.sid || (specReview.sidP ? await specReview.sidP.catch(() => null) : null);
      return { sid, head, from: specReview.from, at: specReview.at, promise: specReview.promise, spec: true, baseline: specReview.baseline, reused: specReview.reused, prev: specReview.prev };
    }
    // A discarded speculative review may have REUSED the previous reviewer session and already sent it
    // this round's prompt. Re-selecting that same idle session would send the prompt a second time and
    // duplicate it in the reviewer's context, so force a fresh session in that case. A fresh speculative
    // session is not the reuse candidate, so the normal path is unchanged.
    let forceFresh = false;
    if (specReview) { const stale = specReview; await discardSpecReview(); forceFresh = !!stale.reused; } // settle asynchronous selection before deciding whether it reused context
    const fr = await startFinalReview(S.reviewRounds[S.reviewRounds.length - 1], forceFresh);
    return asNormalFr(fr);
  };
  // Await the overlapped final review and record it. A speculative review that did not finish (a transient
  // error, a review past the timeout, or a credentials error its poller cannot report) falls back to the
  // normal review, which drive()s the session with retries and detects auth, instead of turning the lane into
  // "needs review" with an empty verdict.
  const finishFinalReview = async (fr) => {
    let rr = await fr.promise;
    if (!rr.ok && fr.spec && rr.reason === 'busy-timeout') {
      // A healthy speculative session that only ran past its polling budget keeps its turn: drive the same
      // session with the normal watchdog and the overall lane deadline. No new session and no replayed
      // prompt, so one final review covers this HEAD and its findings are the ones already being produced.
      L(`== speculative review still running after ${CFG.stepReviewTimeout}s; adopting the same session with the normal watchdog`);
      const o = await drive(fr.sid, REVIEW, 'plan', 'review', () => 'Your previous turn was interrupted. Finish the review: the numbered item list and the final VERDICT line.');
      rr = o.ok ? { sid: fr.sid, ok: true, reason: '', text: '' } : { sid: fr.sid, ok: false, reason: o.reason || 'error', text: '' };
    } else if (!rr.ok && fr.spec && rr.reason !== 'cancelled') {
      L(`== speculative review did not finish (${rr.reason}); running the normal final review`);
      await discardSpecReview();
      if (S.specReview) { S.specReview.used = false; save(true); }
      // A reused session that produced no accepted fresh verdict (a cached id, a missing id, an
      // unreadable reply) must not be reused again: force a fresh session so the same stale answer
      // cannot be replayed. A non-reused failure may retry the normal path unchanged.
      const fr2 = await startFinalReview(fr.prev, fr.reused || rr.reason === 'stale');
      fr = asNormalFr(fr2);
      rr = await fr2.promise;
    }
    // Freshness: a reused session may reply with its cached verdict (no new turn). Accept only a NEW
    // assistant message id after the prompt; otherwise the old verdict is never applied and a fresh
    // session re-reviews instead.
    if (rr.ok) {
      let fresh = await freshReviewReply(fr.sid, fr.baseline);
      if (!fresh.ok && fr.reused) {
        L(`== reused review session ${fr.sid} gave no fresh verdict (${fresh.reason}); running a fresh review session`);
        const fr2 = await startFinalReview(fr.prev, true);
        fr = asNormalFr(fr2);
        rr = await fr2.promise;
        if (rr.ok) fresh = await freshReviewReply(fr.sid, fr.baseline);
      }
      if (rr.ok && fresh.ok) rr = { ...rr, ok: true, text: fresh.text, msgId: fresh.msgId || null };
      else if (rr.ok) rr = { sid: fr.sid, ok: false, reason: fresh.reason || 'empty', text: fresh.text || '' };
    }
    if (!rr.ok && rr.reason === 'auth') { reason = 'auth'; exitCode = 3; forcedResult = ''; if (rr.keys) S.keysMessage = rr.keys; }
    await applyFinalReview(fr.sid, rr, fr.head, fr.from, fr.at);
  };

  const contBrief = (cls, what) => `${brief}\n\n## Continuation (previous session stopped: ${cls}: ${what})\nAlready committed since the start:\n${git(repo, 'log', '--oneline', `${START}..HEAD`) || '(nothing)'}\nUncommitted changes:\n${git(repo, 'status', '--short') || '(none)'}\nCheck what is done, finish only the remaining steps, commit after each.` + CHECK_HELP;
  const resumeMsg = (cls, what) => `Your previous turn was interrupted (${cls}: ${what}). Run \`git log --oneline\` and \`git status\` to see where you are, then continue with the remaining steps of the brief. Commit after each step that works.`;
  // A numbered brief step with no explicit "step N:" commit is not done. The builder gets a bounded number
  // of focused continuations naming the missing steps before the lane ends as needs review.
  const STEP_CONTINUES = Math.max(0, Number(process.env.STEP_CONTINUES || 2));
  const stepContinuation = (missing) => `You stopped before committing every numbered step of the brief. Missing: ${missing.map((n) => `step ${n}`).join(', ')}. Do not ask questions. Do not redo steps already committed (see \`git log --oneline\`): finish each remaining numbered step and commit it with the subject \`step N: <summary>\`.` + CHECK_HELP;

  // Model slots: before a build session starts (and after a fallback model switch), wait until
  // fewer than the model's cap of the OTHER running lanes use it. A crowded model must not get
  // another session. While queued the lane shows it in its activity and ca stop still works.
  let queuedTotal = 0;
  const waitForSlot = async (model) => {
    const limits = parseLimits(process.env.CA_MAX_LANES_PER_MODEL || '');
    const t0 = now(); let logged = false;
    for (;;) {
      // Only lanes that are alive and working hold a slot: queued lanes (or every lane over the limit
      // would wait forever) and DEAD lanes (supervisor gone) do not.
      const running = lanes().filter((l) => !l.s.result && l.id !== id && alive(l.s.pid) && !/^queued/.test(l.s.activity || '')).map((l) => (l.s.models && l.s.models.build) || '').filter(Boolean);
      const slot = laneSlots({ model, running, limits });
      if (slot.ok) break;
      if (!logged) { logged = true; say(`queued: ${slot.reason}`); L(`  ! queued: ${slot.reason}`); }
      S.activity = `queued: ${slot.reason}`; S.queuedMs = queuedTotal + (now() - t0);
      // Waiting for a slot is not a stall: keep ca status from reading STALLED while we queue.
      S.lastEventAt = now(); S.turnStartAt = now(); S.lastToolAt = now(); S.lastTextAt = now(); save();
      if (fs.existsSync(stopFile)) { const e = new Error('stopped'); e.caStop = true; throw e; }
      helperGuard(); orphanGuard();
      await sleep(20000);
    }
    if (logged) { queuedTotal += now() - t0; S.queuedMs = queuedTotal; say(`slot free for ${model} after ${dur(now() - t0)}`); save(true); }
  };

  // ---- run ----
  let exitCode = 1, reason = '', review = null, forcedResult = '', finalReviewed = false;
  server.events(onEvent, (up) => { S.sse = up; }).catch(() => {});
  try {
    // Probe before the codearts server: a repo the lane cannot write to will fail every commit, so end
    // the lane at once as failed instead of starting a server and spending model calls on a blocked disk.
    const wp = writeProbe(repo);
    if (!wp.ok) { L(`  ! repo not writable: ${wp.where}: ${wp.error}`); throw Object.assign(new Error('repo not writable'), { caWrite: true, where: wp.where, wpError: wp.error }); }
    say(`lane ${id}: starting codearts server in ${repo}`);
    await server.start();
    S.server = { url: server.url, pw: server.pw, pid: server.child.pid, version: server.version }; save(true);
    say(`server ${server.url} (codearts ${server.version}); watch: ca tail ${id} -f | ca attach ${id} | ca dash`);
    ensureDash().then((u) => u && L(`dashboard: ${u}`));
    if (PRE_DIRTY.size) { S.preDirty = [...PRE_DIRTY].slice(0, 20); say(`note: ${PRE_DIRTY.size} file(s) were already dirty before the lane (excluded from the git gate): ${S.preDirty.slice(0, 5).join(', ')}`); }

    // A wrong AK/SK is written to server.log at sign-in, before the first model call. Give the log up
    // to 3 s, then end the lane at once instead of retrying for a minute. No retry, no backoff.
    let startKeys = null;
    for (let i = 0; i < 30 && !startKeys; i++) { startKeys = keyProblem(buildModel, ''); if (!startKeys) await sleep(100); }
    if (startKeys) { L(`  ! ${startKeys.message}`); S.keysMessage = startKeys.message; throw Object.assign(new Error('auth'), { caAuth: true }); }

    // BUILD (first wait for a free slot on the build model: a crowded model must not start a session)
    await waitForSlot(buildModel);
    let sid = await newSession(`${task} build`); S.buildSession = sid; builderSessions.add(sid); S.attempt = 1;
    phase('build', 'sending brief'); L(`== build (${BUILD}) session ${sid}; ${checks.length} CHECK lines, ${stepCount} steps`);
    let first = brief;
    if (resumed) {
      const done = git(repo, 'log', '--reverse', '--format=%h %s', `${START}..HEAD`);
      const nf = path.join(repo, 'tasks', `${task}.resume.md`); let notes = fs.existsSync(nf) ? fs.readFileSync(nf, 'utf8').trim() : '';
      const rnf = path.join(dir, 'resume-note.txt'); const rn = fs.existsSync(rnf) ? fs.readFileSync(rnf, 'utf8').trim() : '';
      if (rn) { try { fs.rmSync(rnf, { force: true }); } catch {} notes = `${rn}\n${notes}`.trim(); }
      S.resumedBy = process.env.CA_RESUMED_BY || '';
      first += `\n\n---\nRESUMED RUN ${S.resumes + 1}. The previous run ended ${resultOf(resumed)}${resumed.reason ? ' (' + resumed.reason + ')' : ''}. These commits are already in the repo; do not redo them:\n${done || '(none)'}\n`
        + (notes ? `\nNotes from the lead (apply these first, commit each as "fix: <summary>"):\n${notes}\n` : '')
        + 'Then continue with the first numbered step that has no "step N:" commit, keeping the same commit subjects.';
      say(`resuming run ${S.resumes + 1} from ${START.slice(0, 7)} (${done ? done.split(/\r?\n/).length : 0} commits kept${notes ? ', lead notes' : ''})`);
      if (S.resumedBy) say(`resumed by ${S.resumedBy}`);
    }
    // The initial build prompt carries a small bounded packet of the source files the brief names, so the
    // worker starts from complete quoted context instead of spending turns rediscovering it. Sent once,
    // here only: every continuation (contBrief, resumeMsg, review fix rounds) keeps the plain brief.
    await send(sid, first + builderContext(repo, brief) + CHECK_HELP, BUILD);
    // A final "needs fixes" verdict no longer ends the lane. The findings go back to the same builder
    // session (context kept), the gates run again and the review runs again, up to REVIEW_FIXES rounds.
    // Review fix rounds do not count in S.fixes and every existing exit path (stop, timeout, auth,
    // infra/unverified, write failure) still ends the outer loop as before.
    // A resumed lane already spent some of its review-fix budget, so its rounds count too.
    let reviewFixRounds = Math.max(0, (S.reviewRounds || []).length - 1);
    for (;;) {
      let cleanEnd = false;
      for (;;) {
        const r = await drive(sid, buildModel, undefined, S.fixes ? 'fix' : 'build', resumeMsg, contBrief);
        sid = r.sid; S.buildSession = sid;
        if (!r.ok) { reason = r.reason; exitCode = r.exit || 1; if (r.keys) S.keysMessage = r.keys; break; }
        // The builder is idle: give a step review still in flight a short grace so a nearly done finding
        // can be steered in, then cancel it. The final review reads the whole range anyway, so waiting
        // minutes for a slow step review only delays the gates (measured: 1.3 to 3.4 min per lane).
        if (stepReviewRunning) {
          const settled = await Promise.race([stepReviewRunning.then(() => true, () => true), sleep(CFG.stepReviewGrace * 1000).then(() => false)]);
          if (!settled) {
            stepReviewCancel = true; L(`== builder idle: step review still running after ${CFG.stepReviewGrace}s; cancelled (the final review covers those commits)`);
            try { await stepReviewRunning; } catch {}
            stepReviewCancel = false;
          }
        }
        const srFiles = inboxStepReviewFiles();
        if (srFiles.length && (S.stepReviewContinues || 0) >= CFG.fixes) {
          for (const f of srFiles) { try { fs.rmSync(path.join(dir, 'inbox', f), { force: true }); } catch {} }
          L(`== step-review steers capped at ${CFG.fixes}; not looping again`);
        }
        if (await pumpInbox(sid)) {
          if (lastPumpHadStepReview) S.stepReviewContinues = (S.stepReviewContinues || 0) + 1;
          continue; // a steer arrived right at the end: let the builder handle it
        }
        phase('gate', 'running gates');
        // The git clean part runs first: a wrong tree ends the loop before any model call, and once it
        // passes the final review can start and run while the CHECK lines run. The runner's own recovery
        // paths (write probe, refused-commit fallback and ordinary uncommitted handling) run here, before
        // the strict numbered-step proof, so a completed step the sandbox refused to commit is recovered
        // instead of being reported as a missing step.
        let g = await gitCleanGate();
        if (!g.ok) {
          // A blocked disk ends the build loop at once: the worker cannot commit, so a fix round is wasted.
          if (g.write) { reason = g.reason; exitCode = 1; forcedResult = ''; say(`${g.what === 'repo writable' ? 'repo not writable' : 'commit could not be made'}; no fix round (${g.reason || g.what})`); break; }
          if (++S.fixes > CFG.fixes) { reason = `gates still failing after ${CFG.fixes} fix rounds: ${g.what}`; exitCode = 1; break; }
          say(`gate failed (${g.what}); fix round ${S.fixes}/${CFG.fixes}`);
          phase('fix', `fix round ${S.fixes}`); await send(sid, g.message, buildModel);
          continue;
        }
        // Git clean passed (or the runner just recovered a refused commit). Refresh the commit evidence
        // after any fallback, then enforce the strict proof: a numbered brief step with no explicit
        // "step N:" commit is not done. Send a focused continuation naming the missing steps (bounded);
        // an unrelated wip commit never counts and a commit is never faked.
        syncCommits();
        const missingSteps = uncommittedSteps(S.stepList, S.commitLog);
        if (stepCount > 0 && missingSteps.length) {
          if ((S.stepContinues || 0) < STEP_CONTINUES) {
            S.stepContinues = (S.stepContinues || 0) + 1; save(true);
            L(`== builder idle with step ${missingSteps.join(', ')} uncommitted; continuation ${S.stepContinues}/${STEP_CONTINUES}`);
            say(`step ${missingSteps.join(', ')} not committed; asking the builder to finish (${S.stepContinues}/${STEP_CONTINUES})`);
            phase('build', `continuation for step ${missingSteps.join(', ')}`);
            await send(sid, stepContinuation(missingSteps), buildModel);
            continue;
          }
          reason = `step ${missingSteps.join(', ')} not committed after ${STEP_CONTINUES} continuation${STEP_CONTINUES === 1 ? '' : 's'}`;
          exitCode = 4; forcedResult = 'needs review';
          say(`step ${missingSteps.join(', ')} still uncommitted after ${STEP_CONTINUES} continuation${STEP_CONTINUES === 1 ? '' : 's'}; needs review`);
          break;
        }
        // Git clean and the strict step proof both passed: start the final review now (when review is on)
        // and run the CHECK lines while it reviews. A speculative review that is still valid is awaited in
        // place of a new one; a stale one is aborted and replaced. A CHECK that fails or cannot run aborts
        // and discards this review. Record HEAD first: a CHECK that moves it or writes the tree makes this
        // review stale, and that must be caught before the lane can be accepted as done.
        const headBeforeChecks = git(repo, 'rev-parse', 'HEAD');
        const fr = await beginFinalReview();
        g = await runChecks();
        if (!g.ok) {
          if (fr) { await discardFinalReview(fr); if (fr.spec) specReview = null; }
          // A check that cannot run ends the build loop as unverified: no fix round (the worker cannot
          // repair the machine), but a human must look, so exit 4 like needs review.
          if (g.infra) { reason = `checks couldn't run: ${g.what} (exit ${g.code})`; exitCode = 4; forcedResult = 'unverified'; say(`check could not run (${g.what}, exit ${g.code}); no fix round`); break; }
          if (++S.fixes > CFG.fixes) { reason = `checks failing after ${CFG.fixes} fix rounds: ${g.what} (exit ${g.code})`; forcedResult = 'checks failing'; exitCode = 1; break; }
          say(`gate failed (${g.what}); fix round ${S.fixes}/${CFG.fixes}`);
          phase('fix', `fix round ${S.fixes}`); await send(sid, g.message, buildModel);
          continue;
        }
        // The checks were green, but a CHECK line can write the working tree or move HEAD (a stray test,
        // a formatter, a check that commits). The green checks and the review describe the content as it
        // was before the CHECK ran, so that proof is stale the moment the tree or HEAD moved. Never mark a
        // tree the checks changed as done: discard the stale review and require a commit through the same
        // bounded fix path, then run the gates and the review again on the new HEAD.
        const dirtyAfterChecks = dirty();
        const headAfterChecks = git(repo, 'rev-parse', 'HEAD');
        if (dirtyAfterChecks.length || headAfterChecks !== headBeforeChecks) {
          if (fr) { await discardFinalReview(fr); if (fr.spec) specReview = null; }
          const what = dirtyAfterChecks.length ? `${dirtyAfterChecks.length} uncommitted change${dirtyAfterChecks.length === 1 ? '' : 's'} left by the checks` : 'the checks moved HEAD';
          // Same result family as a failing check (exit 1, "checks failing"): a non-canonical result
          // would render as an idle lane with no attention flag and no resume, hiding it from the human.
          if (++S.fixes > CFG.fixes) { reason = `the checks changed the work after they passed, unresolved after ${CFG.fixes} fix round${CFG.fixes === 1 ? '' : 's'}: ${what}`; forcedResult = 'checks failing'; exitCode = 1; break; }
          say(`checks changed the work after they passed (${what}); fix round ${S.fixes}/${CFG.fixes}`);
          phase('fix', `fix round ${S.fixes}`);
          await send(sid, (dirtyAfterChecks.length
            ? `Runner check passed but left uncommitted changes, so the reviewed content is stale. Commit the intended result (a "step N:" or "fix:" subject) and leave the working tree clean; remove any change that is not part of the step. Changed paths:\n${dirtyAfterChecks.slice(0, 20).join('\n')}`
            : `The CHECK lines moved HEAD after the content was reviewed, so that review is stale. Run \`git log --oneline\` and \`git status\`, keep the working tree clean, and commit anything still uncommitted.`) + CHECK_HELP, buildModel);
          continue;
        }
        // The checks passed on content that is still the reviewed HEAD and clean: wait for the
        // overlapped review to end and record its verdict.
        if (fr) {
          phase('review', 'reviewing');
          await finishFinalReview(fr);
          if (exitCode === 3) break;
        }
        // Acceptance revalidation: the reviewed commit must still be HEAD and the tree clean after the
        // review. The reviewer is read-only, so a moved HEAD or a dirty tree means its verdict no longer
        // describes the content: end needs review with an actionable reason instead of accepting done.
        if (reviewInvalidated) { reason = reviewInvalidated; exitCode = 4; forcedResult = 'needs review'; cleanEnd = false; say(`acceptance revalidation failed: ${reason}`); break; }
        reason = ''; exitCode = 0; cleanEnd = true; break;
      }
      syncCommits();

      // REVIEW (read-only plan agent, different model). It reads code, not checks, so it still runs
      // when the checks could not run (unverified): a reviewer asking for fixes wins over it. The clean
      // success path already ran its review beside the checks, so this only covers the rest.
      if (!finalReviewed && (exitCode === 0 || forcedResult === 'unverified') && !CFG.noReview) {
        const fr = await beginFinalReview();
        phase('review', 'reviewing');
        await finishFinalReview(fr);
        if (reviewInvalidated) { reason = reviewInvalidated; exitCode = 4; forcedResult = 'needs review'; cleanEnd = false; }
      }

      if (!cleanEnd) break; // a stop, timeout, auth, infra/unverified or write failure ends the lane
      // The review said needs fixes and the budget still allows a round: send the findings to the same
      // builder session and go through the build loop, gates and review again.
      if (!(S.verdict === 'needs fixes' && reviewFixRounds < REVIEW_FIXES && S.buildSession)) break;
      reviewFixRounds++;
      specReview = null; // a review fix round starts fresh: the next round may speculate again once its fix is committed and the tree is clean
      say(`review says needs fixes; review fix round ${reviewFixRounds}/${REVIEW_FIXES}`);
      phase('fix', `review fix round ${reviewFixRounds}`);
      await send(S.buildSession, `The reviewer found these problems:\n${review || ''}\nFix the real bugs (ignore a finding that contradicts the brief or the lead's steering), run the checks, and commit as "fix: review findings".` + CHECK_HELP, buildModel);
      sid = S.buildSession;
    }
  } catch (err) {
    forcedResult = '';
    if (err && err.caWrite) { reason = `repo not writable: ${err.where}: ${err.wpError}`; exitCode = 1; L(`! ${reason}`); }
    else if (err && err.caAuth) { reason = 'auth'; exitCode = 3; }
    else if (err && err.caStop) { reason = 'stopped'; exitCode = 1; L('== stopped while queued for a model slot'); }
    else { reason = `runner error: ${err.message}`; exitCode = 1; L(`! ${reason}`); }
  }

  // ---- summary ----
  syncCommits();
  // A lane that reaches LANE_TIMEOUT is paused, not failed: the safeguard worked and `--resume` continues it in place.
  S.result = exitCode === 0 ? (S.verdict && S.verdict !== 'ready' && !CFG.noReview ? 'needs review' : 'done')
    : forcedResult === 'unverified' && exitCode === 4 ? (S.verdict && S.verdict !== 'ready' && !CFG.noReview ? 'needs review' : 'unverified')
    : (forcedResult || (reason === 'stopped' ? 'stopped' : reason === 'timeout' ? 'paused' : 'failed'));
  const finalExit = S.result === 'needs review' ? 4 : S.result === 'paused' ? 5 : S.result === 'unverified' ? 4 : S.result === 'checks failing' ? 1 : exitCode;
  S.reason = reason; S.exitCode = finalExit; S.phase = 'finished'; S.activity = S.result; S.busy = false; S.finishedAt = now();
  const log = git(repo, 'log', '--oneline', `${START}..HEAD`);
  const left = dirty();
  const reviewBody = review ? (() => { const ls = review.split(/\r?\n/); const i = ls.findIndex((l) => /^\s*1\.\s/.test(l)); return ls.slice(i >= 0 ? i : Math.max(0, ls.length - 16)).filter((l) => l.trim() && !/^\s*VERDICT:/i.test(l)).slice(0, 24).join('\n'); })() : '';
  const modelBits = Object.entries(S.tokensByModel).map(([m, t]) => `${m} ${tokenTotal(t)}`).join(', ');
  const wcGreen = S.workerChecks.filter((x) => x.code === 0).length;
  const gateReused = S.gates.some((g) => g.reused === true);
  const byModel = modelBits ? ` | by model: ${modelBits}` : '';
  const md = [
    `=== lane ${id}: ${S.result.toUpperCase()}${reason ? ' (' + reason + ')' : ''} in ${dur(now() - T0)} ===`,
    `models: build ${buildModel}, review ${REVIEW} | tokens in ${S.tokens.input} out ${S.tokens.output} (cache read ${S.tokens.cacheRead}) over ${S.tokens.steps} steps | total ${tokenTotal(S.tokens)} | by agent: build ${tokenTotal(S.tokensBy.build)}, review ${tokenTotal(S.tokensBy.review)}, other ${tokenTotal(S.tokensBy.other)}${byModel}`,
    `commits ${S.commits} (brief has ${stepCount} numbered lines):`, log || '(none)',
    ...(S.briefWarnings?.length ? [`brief warnings: ${briefWarningLines(S.briefWarnings).join(' | ')}`] : []),
    left.length ? `UNCOMMITTED: ${left.slice(0, 8).join(', ')}` : 'work tree: clean',
    ...(PRE_DIRTY.size ? [`already dirty before the lane (ignored): ${[...PRE_DIRTY].slice(0, 8).join(', ')}`] : []),
    `gates: ${S.gates.length ? S.gates.map((g) => `${g.gate} ${g.ok ? 'ok' : 'FAIL'}`).join(' | ') : '(none ran)'} | fix rounds ${S.fixes}`,
    `worker checks: ${S.workerChecks.length} runs (${wcGreen} green), gate reused: ${gateReused ? 'yes' : 'no'}`,
    ...(S.reviewRounds.length ? [`review rounds: ${S.reviewRounds.length} (${S.reviewRounds.map((x) => x.verdict).join(' -> ')})`] : []),
    `step reviews: ${STEP_REVIEW ? `${S.stepReviews.length} (ok ${S.stepReviews.filter((x) => x.verdict === 'ok').length}, fix ${S.stepReviews.filter((x) => x.verdict === 'fix').length}, other ${S.stepReviews.filter((x) => x.verdict !== 'ok' && x.verdict !== 'fix').length})` : 'off'}`,
    `interruptions: ${S.interruptions.length ? S.interruptions.map((x) => `${x.phase}/${x.kind}: ${x.what}`).join('; ') : 'none'}${S.queuedMs ? ` (queued ${dur(S.queuedMs)} for a model slot)` : ''}`,
    ...(S.keysMessage ? [`keys: ${S.keysMessage}`] : []),
    ...(S.modelSwitches?.length ? [`model switch: ${S.modelSwitches.map((x) => `${x.from} -> ${x.to} (${x.why})`).join('; ')}`] : []),
    `steering: ${S.steers.length ? S.steers.map((x) => `[${x.by}] ${oneLine(x.text, 160)}`).join(' / ') : 'none'}`,
    `questions: ${S.questions?.length ? S.questions.map((x) => oneLine(x.text, 200)).join(' / ') : 'none'}`,
    `outside-repo file access: ${S.outside.length ? S.outside.slice(0, 5).map((x) => `${x.tool} ${x.path}`).join(', ') : 'none'}`,
    `permissions: ${S.permissions.length ? S.permissions.map((x) => `${x.kind}->${x.reply}`).join(', ') : 'none asked'}`,
    ...(S.errors.length ? [`errors: ${S.errors.slice(-3).map((x) => x.msg).join(' / ')}`] : []),
    '--- review ---', reviewBody || '(no review)', `VERDICT: ${S.verdict || 'none'}`,
    ...(S.result === 'paused' ? [`paused at the time limit (LANE_TIMEOUT ${CFG.laneTimeout}s). Continue in place: ca lane ${repo} ${task} --resume   (optional lead notes: tasks/${task}.resume.md)`] : []),
    ...(S.result === 'unverified' ? [`checks could not run (a machine problem, not a test failure): fix the environment, then rerun them. ca resume ${id}`] : []),
    ...(S.result === 'checks failing' ? [`a check still fails after ${S.fixes} fix rounds. Fix it or resume for another round: ca resume ${id}`] : []),
    `files: ${dir} (live.log, review.md, events.jsonl)`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n');
  L(`== finished: ${S.result}${reason ? ' (' + reason + ')' : ''}`);
  save(true);
  process.stdout.write('\n' + md + '\n');
  process.stdout.write(`CA_RESULT ${JSON.stringify({ lane: id, result: S.result, verdict: S.verdict || '', exit: finalExit, ...(S.keysMessage ? { error: S.keysMessage } : {}), summaryPath: path.join(dir, 'summary.md') })}\n`);
  cleanup();
  process.exit(finalExit);
}

// `ca lane <repo> <task> --detach`: same lane, background, log file, returns at once.
export function cmdDetach(repoArg, task) {
  if (!repoArg || !task) die('usage: ca lane <repo> <task> [--detach]', 2);
  const repo = path.resolve(repoArg);
  const briefFile = path.join(repo, 'tasks', `${task}.md`);
  if (!task || !fs.existsSync(briefFile)) die(`usage: ca lane <repo> <task>   (needs ${briefFile})`, 2);
  // Print the same brief warnings the foreground lane does, before the child starts.
  for (const t of briefWarningLines(briefWarningsFor(repo, task) || [])) console.log(`brief warning: ${t}`);
  const id = laneId(repo, task);
  const logFile = path.join(repo, 'tasks', `${task}.lane.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [CA_ENTRY, 'lane', repoArg, task, ...(process.argv.includes('--resume') ? ['--resume'] : [])], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  // Return only once the lane is really running (its state.json carries this supervisor's pid), so an
  // immediate `ca wait` / ca_wait finds it; if it dies at startup, say why and pass its exit code on.
  const stateFile = path.join(repo, 'tasks', `${task}.lane`, 'state.json');
  let exited = null; child.on('exit', (code) => { exited = code ?? 1; });
  const t0 = now();
  const tick = () => {
    const s = readJSON(stateFile);
    if (s && s.pid === child.pid && fs.existsSync(path.join(REG, `${id}.json`))) {
      child.unref();
      console.log(`lane ${id} started (pid ${child.pid}). Log: ${logFile}. Wait: ca wait ${id}. Watch: ${dashUrl()}`);
      process.exit(0);
    }
    if (exited !== null) {
      let tail = ''; try { tail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n'); } catch {}
      console.error(`lane ${id} did not start (exit ${exited}):\n${tail}`);
      process.exit(exited || 1);
    }
    if (now() - t0 > 30000) { child.unref(); console.log(`lane ${id} is still starting (pid ${child.pid}). Log: ${logFile}. Wait: ca wait ${id}`); process.exit(0); }
    setTimeout(tick, 200);
  };
  tick();
}
