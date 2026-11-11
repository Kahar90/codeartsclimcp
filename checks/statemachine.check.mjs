// Contract check for stage 2 of the lane state machine: one classifier (runner/lanestate.mjs classify)
// is the only place that decides a lane's health, status, bucket, glyph, steps and actions. Every older
// helper (laneOutcome, laneBucket, laneActions, health) is a projection of it, and a table over every
// phase x result x liveness x blocker x handled x closed combination proves the invariants of
// docs/contracts/status.txt. Pure module calls; never starts CodeArts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = []; let passN = 0;
// Table rows can number in the hundreds: print every failure, count the passes.
const check = (name, ok, info = '') => { if (ok) passN++; else results.push(`FAIL ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`); };
const imp = async (f) => { try { return await import(pathToFileURL(path.join(ROOT, 'runner', f)).href); } catch (e) { check(`runner/${f} loads`, false, e.message); return null; } };
const J = (v) => JSON.stringify(v);
const LS = await imp('lanestate.mjs');
const C = await imp('controls.mjs');
const CM = await imp('common.mjs');

const GL = { working: '●', needs: '!', failed: '✕', done: '✓', idle: '–' };
const now = Date.now();
const DEAD_PID = 999999, LIVE_PID = process.pid;
const steps3 = [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }];
const base = (o) => ({ id: 'x', startedAt: now - 3600e3, lastEventAt: now - 5000, stepList: steps3, commitLog: [{ hash: 'a1', subject: 'step 1: a' }], gates: [], activity: 'working', config: {}, ...o });

// ---------- the grid ----------
const rows = [];
const LIVE = ['starting', 'build', 'gate', 'fix', 'review', 'backoff', 'restart'];
const liveVariants = {
  normal: { busy: true },
  idle: { busy: false },
  tool: { busy: true, tools: [{ name: 'bash' }] },
  quiet: { busy: true, lastEventAt: now - 120e3 },
  stalled: { busy: true, lastEventAt: now - 900e3 },
  thinking: { busy: true, lastEventAt: now - 5000, turnStartAt: now - 900e3, lastToolAt: now - 900e3, lastTextAt: now - 900e3 },
  question: { busy: true, blocker: { kind: 'question', text: 'which file?', at: now } },
  noprogress: { busy: true, blocker: { kind: 'no-progress', text: 'no commit for 15m', at: now } },
};
for (const phase of LIVE) for (const [vn, v] of Object.entries(liveVariants)) for (const pid of [LIVE_PID, DEAD_PID]) {
  rows.push({ name: `${phase}/${vn}/${pid === LIVE_PID ? 'alive' : 'dead'}`, s: base({ phase, pid, result: null, ...v }) });
}
const ended = {
  done: { result: 'done', exitCode: 0 },
  verified: { result: 'done', exitCode: 0, gates: [{ gate: 'git clean', ok: true }, { gate: 'npm test', ok: true, code: 0 }] },
  'needs review': { result: 'needs review', exitCode: 4, reason: 'reviewer asked for fixes' },
  unverified: { result: 'unverified', exitCode: 4, reason: 'npm not found' },
  'checks failing': { result: 'checks failing', exitCode: 1, reason: 'a check fails' },
  paused: { result: 'paused', exitCode: 5, reason: 'timeout' },
  'legacy pause': { result: 'failed', exitCode: 1, reason: 'timeout' },
  'lead stop': { result: 'stopped', exitCode: 1, reason: 'stopped' },
  'dead stop': { result: 'stopped', exitCode: 1, activity: 'stopped (supervisor had died)', end: { result: 'stopped', cause: 'supervisor-died', detail: '' } },
  failed: { result: 'failed', exitCode: 1, reason: 'gave up after 3 interruptions' },
  auth: { result: 'failed', exitCode: 3, reason: 'auth' },
  'runner error': { result: 'failed', exitCode: 1, reason: 'runner error: Cannot find module ./authsignal.mjs' },
  'legacy gates': { result: 'failed', exitCode: 1, reason: 'gates still failing', gates: [{ gate: 'npm test', ok: false, code: 1 }] },
  'legacy gates infra': { result: 'failed', exitCode: 1, reason: 'gates still failing', gates: [{ gate: 'npm test', ok: false, code: 127 }] },
  killed: { result: 'killed', exitCode: 1 },
};
for (const [en, e] of Object.entries(ended)) rows.push({ name: en, s: base({ phase: 'finished', pid: DEAD_PID, finishedAt: now - 60e3, busy: false, ...e }) });

if (LS && C && CM) {
  check('lanestate exports classify and healthOf', typeof LS.classify === 'function' && typeof LS.healthOf === 'function');
  check('lanestate exports LIVE_PHASES and WORK_PHASES', Array.isArray(LS.LIVE_PHASES) && Array.isArray(LS.WORK_PHASES));
  check('LIVE_PHASES is every phase but finished', J([...(LS.LIVE_PHASES || [])].sort()) === J([...LIVE].sort()), J(LS.LIVE_PHASES));
  check('WORK_PHASES (a model turn runs, kick allowed) are build, fix, review, restart', J([...(LS.WORK_PHASES || [])].sort()) === J(['build', 'fix', 'restart', 'review']), J(LS.WORK_PHASES));
  const OUT = ['key', 'label', 'tone', 'reason', 'attention', 'steps', 'glyph'];
  let n = 0;
  for (const r of rows) for (const handled of [false, true]) for (const closed of [false, true]) {
    const s = structuredClone(r.s); const alive = CM.alive(s.pid);
    if ((handled || closed) && !s.result) continue; // only finished lanes can be handled or belong to a closed plan's ended set
    const tag = `${r.name}${handled ? '/handled' : ''}${closed ? '/closed' : ''}`;
    const hText = CM.health(s);
    const progress = CM.stepProgress(s);
    const note = handled ? 'merged into main' : '';
    let c = null; try { c = LS.classify({ s, alive, handled, note, closed, progress, canResume: true, now }); } catch (e) { check(`classify does not throw: ${tag}`, false, e.message); continue; }
    n++;
    const h = LS.healthOf(s, { alive, now });
    check(`healthOf text equals health(): ${tag}`, h && h.text === hText, `${J(h)} vs ${hText}`);
    check(`healthOf has a kind: ${tag}`, h && ['running', 'tool', 'quiet', 'thinking', 'stalled', 'dead', 'ended'].includes(h.kind), J(h));
    // projections: the old helpers answer exactly what classify answers
    const o = C.laneOutcome({ s, health: hText, handled, note, closed, progress });
    check(`laneOutcome is a projection of classify: ${tag}`, OUT.every((k) => J(o[k]) === J(c[k])), `${J(o)} vs ${J(OUT.reduce((a, k) => ({ ...a, [k]: c[k] }), {}))}`);
    const plain = handled || closed ? LS.classify({ s, alive, progress, canResume: true, now }) : c;
    const b = C.laneBucket({ s, alive, health: hText });
    check(`laneBucket is a projection of classify: ${tag}`, b.bucket === plain.bucket && b.reason === plain.bucketReason, `${J(b)} vs ${plain.bucket}/${plain.bucketReason}`);
    const a = C.laneActions({ s, alive, health: hText, canResume: true, handled });
    check(`laneActions is a projection of classify: ${tag}`, J(a.actions) === J(c.actions) && a.suggest === c.suggest && a.why === c.why, `${J(a)} vs ${J({ actions: c.actions, suggest: c.suggest, why: c.why })}`);
    // invariants of the status contract
    check(`attention <=> Needs you bucket: ${tag}`, c.attention === (c.bucket === 'attention'), `${c.attention} ${c.bucket}`);
    if (handled) check(`a handled lane never needs you: ${tag}`, !c.attention && c.bucket !== 'attention');
    if (closed) check(`an ended lane of a closed plan never needs you: ${tag}`, !c.attention && c.bucket !== 'attention');
    if (c.attention) check(`an attention lane shows ! or x: ${tag}`, c.glyph === GL.needs || c.glyph === GL.failed, c.glyph);
    if (c.attention) check(`an attention lane offers an action or says why: ${tag}`, c.actions.length > 0 || !!c.why, J(c.actions));
    if (!s.result && alive) check(`a live lane can be steered and stopped: ${tag}`, c.actions.includes('steer') && c.actions.includes('stop'), J(c.actions));
    if (!s.result && !alive) check(`a DEAD lane needs you and offers resume: ${tag}`, c.attention && c.actions.includes('resume'), J(c));
    if (c.key === 'running') check(`a running lane shows live steps: ${tag}`, c.steps === 'live', c.steps);
    if (!c.attention && c.key === 'running') check(`a running lane that needs nobody shows the working dot: ${tag}`, c.glyph === GL.working, c.glyph);
    if (s.result) check(`a finished lane is never running: ${tag}`, c.key !== 'running' && c.bucket !== 'running', `${c.key} ${c.bucket}`);
    if (['done', 'verified'].includes(c.key)) check(`done and verified show the check: ${tag}`, c.glyph === GL.done, c.glyph);
    check(`label and reason are non-empty: ${tag}`, !!c.label && !!c.reason && !!c.bucketReason);
    if (c.end) check(`end cause is declared: ${tag}`, (LS.CAUSES || []).includes(c.end.cause), J(c.end));
  }
  check('the table covers at least 150 combinations', n >= 150, String(n));
  // A lane in review with steps still open shows the next step as current (review is a working phase).
  const sp = CM.stepProgress(base({ phase: 'review', result: null, pid: LIVE_PID }));
  check('stepProgress marks a current step during review', sp.current && sp.current.n === 2, J(sp.current));
}

// ---------- one source of truth in the code ----------
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, 'runner', f), 'utf8'); } catch { return ''; } };
const ctl = src('controls.mjs'), com = src('common.mjs'), cmds = src('commands.mjs');
for (const [rx, what] of [[/\/\^dead\/i/, '/^dead/i'], [/\/\^?stall(ed)?\/i/, '/stalled/i'], [/\/\^quiet\/i/, '/^quiet/i'], [/\/no tool call\/i/, '/no tool call/i'], [/\/\^thinking\/i/, '/^thinking/i']]) {
  check(`controls.mjs parses no health string with ${what}`, !rx.test(ctl));
}
check('controls.mjs and common.mjs hold no inline phase lists', !/\[\s*'(build|gate|backoff)'\s*,\s*'(fix|backoff|restart|gate|starting)'/.test(ctl + com));
const legacyPause = /result === 'failed' && s\.reason === 'timeout'/;
for (const f of fs.readdirSync(path.join(ROOT, 'runner')).filter((x) => x.endsWith('.mjs') && x !== 'lanestate.mjs')) {
  check(`legacy pause rule lives only in lanestate.mjs: ${f}`, !legacyPause.test(src(f)));
}
check('commands.mjs bucketFor goes through classify', /classify\(/.test(cmds));

console.log(results.join('\n'));
const bad = results.length;
console.log(bad ? `${bad} FAILED, ${passN} passed` : `all ${passN} passed`);
process.exitCode = bad ? 1 : 0;
