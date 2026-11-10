// A fake `codearts serve` for runner checks: node runs this file as `<node> serve --port N ...`
// (copy it into the lane repo as `serve` and set CODEARTS_EXE to node). It speaks the small part of
// the opencode server API the runner uses and plays one scenario per prompt from fake-script.json
// in its cwd: ["rate", "net", "ok", ...]; the last entry repeats.
//   ok         busy, an answer text, idle
//   rate       busy, 3 rate-limit retries, MessageAbortedError (what CodeArts does on a 429), idle
//   net        busy, session error "TypeError: fetch failed", idle
//   auth       writes a service=auth sign-in error to stdout (the server log) first, then like net
//   steps:1,2  commits page<N>.html as "step N: thing N" for each listed N, FAKE_STEP_GAP_MS apart
//              (default 6000), then answers
//   fix        writes and commits `fixed` as "fix: make the check pass", then answers
// Prompts sent with agent "plan" (reviews) never consume the script: they are answered after
// FAKE_REVIEW_MS (default 2000) with the reply of the first [regex, reply] pair in fake-review.json
// whose regex matches the prompt text (default "1. DONE\nVERDICT: ready"). A third element opts
// object adds hooks, so the reply carries a STABLE message id the runner can prove is new:
//   { noId: true }            the reply has no message id (missing-id fallback)
//   { stale: true }           answer with the session's EXISTING message id (an old cached verdict)
//   { commit: ['rel=text'] }  write and commit the files while reviewing (reviewer-time mutation)
//   { write: ['rel=text'] }   write the files, no commit (a dirty tree during review)
//   { busyAfter: MS }         after the turn goes idle, flip the session busy (busy-reuse fallback)
//   { errorAfter: MS }        after the turn goes idle, emit a session error (error-reuse fallback)
// /session/:id/message returns every assistant message for the session (with its stable id).
// A prompt sent to a busy session is queued and played when the turn ends (steering).
// Logs in the cwd: fake-turns.log (one scenario per line), fake-prompts.log (JSON per prompt:
// t, sid, agent, text) and fake-aborts.log (JSON per abort: t, sid, agent).
const http = require('node:http');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
// Keep the fake's own logs out of the lane's git clean gate, whatever the repo's .gitignore says.
try { const ex = '.git/info/exclude'; const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''; if (!/^fake-\*\.log$/m.test(cur)) { fs.mkdirSync('.git/info', { recursive: true }); fs.appendFileSync(ex, '\nfake-*.log\n'); } } catch {}
let script = ['ok']; try { script = JSON.parse(fs.readFileSync('fake-script.json', 'utf8')); } catch {}
let reviews = []; try { reviews = JSON.parse(fs.readFileSync('fake-review.json', 'utf8')); } catch {}
const stepGap = Number(process.env.FAKE_STEP_GAP_MS || 6000);
const reviewMs = Number(process.env.FAKE_REVIEW_MS || 2000);
let turn = 0; const status = {}; const clients = new Set(); let n = 0;
const agentOf = {}; const queue = {}; const answers = {}; const timers = {};
// Per-session assistant messages, each with a STABLE message id: the runner uses the id to prove a
// reused reviewer session produced a NEW reply instead of replaying a cached verdict.
const msgs = {};
const emit = (type, properties) => { const d = `data: ${JSON.stringify({ type, properties })}\n\n`; for (const c of clients) c.write(d); };
const later = (sid, ms, f) => { const t = setTimeout(() => { (timers[sid] || []).splice((timers[sid] || []).indexOf(t), 1); f(); }, ms); (timers[sid] ||= []).push(t); };
const setStatus = (sid, type, extra = {}) => { status[sid] = { type, ...extra }; emit('session.status', { sessionID: sid, status: status[sid] }); if (type === 'idle') emit('session.idle', { sessionID: sid }); };
const git = (...a) => execFileSync('git', ['-c', 'user.email=fake@x', '-c', 'user.name=fake', ...a], { stdio: 'ignore' });
const answer = (sid, text, opts = {}) => {
  const mid = opts.noId ? null : (opts.msgId || `m${++n}`);
  answers[sid] = text;
  const part = { id: `p${++n}`, sessionID: sid, ...(mid ? { messageID: mid } : {}), type: 'text', text, time: { end: Date.now() } };
  (msgs[sid] ||= []).push({ info: { ...(mid ? { id: mid } : {}), role: 'assistant' }, parts: [part] });
  emit('message.part.updated', { part });
};
const finish = (sid) => {
  setStatus(sid, 'idle');
  const next = (queue[sid] || []).shift();
  if (next) setTimeout(() => start(sid, next), 200);
};
function playReview(sid, text) {
  const hit = reviews.find(([re]) => new RegExp(re, 'i').test(text));
  const opts = (hit && hit.length > 2 && hit[2]) || {};
  const ms = /STEP VERDICT/.test(text) && process.env.FAKE_STEP_REVIEW_MS ? Number(process.env.FAKE_STEP_REVIEW_MS) : reviewMs;
  later(sid, ms, () => {
    // A reviewer-time mutation: write (and optionally commit) files while the review turn runs. Used to
    // prove the runner revalidates HEAD and the work tree after the review.
    if (opts.write || opts.commit) {
      const p = require('node:path');
      for (const spec of [].concat(opts.write || [], opts.commit || [])) {
        const [rel, ...rest] = String(spec).split('=');
        if (!rel) continue;
        fs.mkdirSync(p.dirname(rel), { recursive: true });
        fs.writeFileSync(rel, rest.join('=') || `stray ${rel}\n`);
      }
      if (opts.commit) { try { git('add', '-A'); git('commit', '-qm', opts.msg || 'reviewer: stray change'); } catch {} }
    }
    if (opts.busyAfter) later(sid, Number(opts.busyAfter), () => setStatus(sid, 'busy'));
    // An error on a completed review session must block its reuse (the runner reads sess[sid].error).
    if (opts.errorAfter) later(sid, Number(opts.errorAfter), () => emit('session.error', { sessionID: sid, error: { name: 'UnknownError', data: { message: 'injected review-session error' } } }));
    // A stale reply reuses the session's existing message id, so the runner must reject it as no new turn.
    const cached = opts.stale && msgs[sid] && msgs[sid].length ? msgs[sid][msgs[sid].length - 1].info.id : null;
    answer(sid, hit ? hit[1] : '1. DONE\nVERDICT: ready', cached ? { msgId: cached } : { noId: !!opts.noId });
    later(sid, 100, () => finish(sid));
  });
}
// Chained turn: "commit:1+run:all+ok" runs its parts in order inside one turn, then answers.
//   commit:K   writes page<K>.html and commits it as "step K: thing K"
//   run:ARG    runs the runner's check helper (tasks/*.lane/check.mjs ARG) like a worker's bash tool
//              would, and appends {arg, code, out} to fake-checks.log
//   wait:MS    waits
//   noise:K    commits noise<K>.txt as "wip: noise K" (a commit that is not a step)
//   write:REL=TEXT  writes TEXT to REL (relative to the repo), no commit
//   ask:TEXT   asks the lead a question (question.asked); rejections land in fake-questions.log
async function playChain(sid, kind) {
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const part of kind.split('+')) {
    const [verb, arg = ''] = [part.split(':')[0], part.split(':').slice(1).join(':')];
    if (verb === 'commit') { fs.writeFileSync(`page${arg}.html`, `<p>thing ${arg}</p>\n`); git('add', '-A'); git('commit', '-qm', `step ${arg}: thing ${arg}`); }
    else if (verb === 'wait') await sleepMs(Number(arg));
    else if (verb === 'noise') { fs.writeFileSync(`noise${arg}.txt`, `noise ${arg}\n`); git('add', '-A'); git('commit', '-qm', `wip: noise ${arg}`); }
    else if (verb === 'write') { const [rel, ...rest] = arg.split('='); fs.mkdirSync(require('node:path').dirname(rel), { recursive: true }); fs.writeFileSync(rel, rest.join('=') || 'written by the worker\n'); }
    else if (verb === 'ask')emit('question.asked', { id: `que_fake${++n}`, sessionID: sid, questions: [{ header: 'Choice', question: arg, options: [{ label: 'A' }, { label: 'B' }] }] });
    else if (verb === 'decide') answer(sid, arg); // a finished reply text part (a request for the lead)
    else if (verb === 'toolerr') emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: `c${n}`, tool: 'bash', state: { status: 'error', input: { command: 'git commit' }, error: arg } } });
    else if (verb === 'bash') { const cid = `c${++n}`; emit('message.part.updated', { part: { id: `p${n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: cid, tool: 'bash', state: { status: 'running', input: { command: arg } } } }); emit('message.part.updated', { part: { id: `p${n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: cid, tool: 'bash', state: { status: 'completed', input: { command: arg }, output: 'ok' } } }); }
    else if (verb === 'shfail') emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: `c${n}`, tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: arg, metadata: { exit: 1, exitCode: 1 } } } });
    else if (verb === 'shok') emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: `c${n}`, tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: arg, metadata: { exit: 0, exitCode: 0 } } } });
    else if (verb === 'decideopen') emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'text', text: arg } }); // a text part with NO time.end
    else if (verb === 'run') {
      const lane = (fs.readdirSync('tasks').find((d) => d.endsWith('.lane') && fs.existsSync(`tasks/${d}/check.mjs`)));
      const helper = lane ? `tasks/${lane}/check.mjs` : 'tasks/missing-helper.mjs';
      const r = await new Promise((res) => {
        const ch = spawn(process.execPath, [helper, ...(arg ? [arg] : [])], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
        ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', (d) => (out += d));
        ch.on('close', (code) => res({ code, out })); ch.on('error', (e) => res({ code: -1, out: String(e) }));
      });
      fs.appendFileSync('fake-checks.log', JSON.stringify({ t: Date.now(), arg, helper, code: r.code, out: r.out.slice(-2000) }) + '\n');
    }
    emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: `c${n}`, tool: 'bash', state: { status: 'completed', input: { command: part }, output: 'ok' } } });
  }
  answer(sid, 'done'); setTimeout(() => finish(sid), 300);
}
function playBuild(sid) {
  const kind = String(script[Math.min(turn, script.length - 1)]); turn++;
  fs.appendFileSync('fake-turns.log', `${kind}\n`);
  if (/^(commit|run|wait|decide|toolerr|bash|shfail|shok|decideopen):/.test(kind) || kind.includes('+')) { playChain(sid, kind); return; }
  if (kind === 'ok') { later(sid, 300, () => answer(sid, 'done')); later(sid, 600, () => finish(sid)); return; }
  if (kind.startsWith('steps:')) {
    const ns = kind.slice(6).split(',').map((x) => x.trim()).filter(Boolean);
    ns.forEach((k, i) => later(sid, 500 + i * stepGap, () => {
      fs.writeFileSync(`page${k}.html`, `<p>thing ${k}</p>\n`);
      git('add', '-A'); git('commit', '-qm', `step ${k}: thing ${k}`);
      emit('message.part.updated', { part: { id: `p${++n}`, sessionID: sid, messageID: `m${n}`, type: 'tool', callID: `c${n}`, tool: 'bash', state: { status: 'completed', input: { command: 'git commit' }, output: 'ok' } } });
    }));
    const end = 500 + (ns.length - 1) * stepGap + 1000;
    later(sid, end, () => answer(sid, 'done'));
    later(sid, end + 300, () => finish(sid));
    return;
  }
  if (kind === 'fix') {
    later(sid, 300, () => { fs.writeFileSync('fixed', 'yes\n'); git('add', '-A'); git('commit', '-qm', 'fix: make the check pass'); answer(sid, 'fixed'); });
    later(sid, 600, () => finish(sid));
    return;
  }
  if (kind === 'auth') process.stdout.write('ERROR  2026-11-07T19:53:08.839 +1340ms service=auth "fake sign-in failure 503{}"\n');
  if (kind === 'rate') for (let a = 1; a <= 3; a++) later(sid, 100 * a, () => setStatus(sid, 'retry', { attempt: a, message: 'Too many requests, the rate limit is 1000000 tokens per minute.' }));
  const err = kind === 'rate' ? { name: 'MessageAbortedError', data: { message: 'Aborted' } } : { name: 'UnknownError', data: { message: 'TypeError: fetch failed' } };
  later(sid, 500, () => emit('session.error', { sessionID: sid, error: err }));
  later(sid, 700, () => finish(sid));
}
function start(sid, p) {
  setStatus(sid, 'busy');
  if (p.agent === 'plan') playReview(sid, p.text); else playBuild(sid);
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/global/health') return json({ healthy: true, version: 'fake-1' });
    if (u.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); clients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      const hb = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 5000);
      res.on('close', () => { clearInterval(hb); clients.delete(res); }); return;
    }
    if (req.method === 'POST' && u.pathname === '/session') { const id = `ses_fake${++n}`; status[id] = { type: 'idle' }; return json({ id }); }
    if (u.pathname === '/session/status') return json(status);
    let m = u.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (m) {
      const sid = m[1]; let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
      const text = (b.parts || []).map((x) => x.text || '').join('\n');
      if (b.agent) agentOf[sid] = b.agent;
      const p = { agent: b.agent || agentOf[sid] || '', text };
      fs.appendFileSync('fake-prompts.log', JSON.stringify({ t: Date.now(), sid, agent: p.agent, text }) + '\n');
      json({});
      if (status[sid]?.type === 'busy' || status[sid]?.type === 'retry') (queue[sid] ||= []).push(p);
      else setTimeout(() => start(sid, p), 400);
      return;
    }
    m = u.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (m) {
      const sid = m[1];
      fs.appendFileSync('fake-aborts.log', JSON.stringify({ t: Date.now(), sid, agent: agentOf[sid] || '' }) + '\n');
      for (const t of timers[sid] || []) clearTimeout(t); timers[sid] = []; queue[sid] = [];
      setStatus(sid, 'idle'); return json(true);
    }
    m = u.pathname.match(/^\/question\/([^/]+)\/reject$/);
    if (m) { fs.appendFileSync('fake-questions.log', JSON.stringify({ t: Date.now(), id: m[1], reply: 'reject' }) + '\n'); return json(true); }
    m = u.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (m) return json(msgs[m[1]] || []);
    return json({});
  });
}).listen(port, '127.0.0.1');
