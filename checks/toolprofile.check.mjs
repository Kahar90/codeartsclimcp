// Contract check for the opt-in per-lane core tool profile (CA_TOOL_PROFILE=core). It drives
// Server.api against a mocked fetch, so no CodeArts server is started and no loopback network is
// used (it runs inside the worker sandbox). Covers the profile off/on paths, explicit caller
// denies, the per-server cache and its reset on restart, malformed or unavailable metadata, the
// prompt_async-only scope, and that neither the outgoing request nor the caller's body is mutated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '../runner/server.mjs';
import { CORE_TOOLS, profileMode, parseToolIds, applyCoreProfile } from '../runner/toolprofile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The live backend exposes about 80 tools; every id here that is not core must be denied. The
// duplicate future_tool proves duplicate ids collapse to a single deny entry.
const DEFAULT_IDS = ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'question', 'task', 'skill', 'webfetch', 'future_tool', 'future_tool'];
const NON_CORE_IN_IDS = ['task', 'skill', 'webfetch', 'future_tool'];

const ORIGINAL_FETCH = globalThis.fetch;
const restoreFetch = () => { globalThis.fetch = ORIGINAL_FETCH; };
const setProfile = (v) => {
  const old = process.env.CA_TOOL_PROFILE;
  if (v === undefined) delete process.env.CA_TOOL_PROFILE; else process.env.CA_TOOL_PROFILE = v;
  return () => { if (old === undefined) delete process.env.CA_TOOL_PROFILE; else process.env.CA_TOOL_PROFILE = old; };
};
const server = () => { const s = new Server('.', 'unused'); s.url = 'http://local-probe'; s.pw = 'test'; return s; };
const post = { agent: 'build', parts: [{ type: 'text', text: 'go' }] };
const mock = (opts = {}) => {
  const calls = { ids: 0, requests: [] };
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (u.endsWith('/experimental/tool/ids')) {
      calls.ids++;
      if (typeof opts.idsStatus === 'number') return new Response('nope', { status: opts.idsStatus });
      if (opts.idsBody !== undefined) return new Response(opts.idsBody);
      return new Response(JSON.stringify(opts.ids ?? DEFAULT_IDS));
    }
    calls.requests.push({ url: u, method: o.method, body: o.body ? JSON.parse(o.body) : undefined });
    return new Response('{}');
  };
  return calls;
};
const throws = async (fn) => { try { await fn(); return { threw: false, msg: '' }; } catch (e) { return { threw: true, msg: e.message }; } };

try {
  // ---- 1. no profile (unset) and full: exact previous request, no metadata fetch, no mutation ----
  for (const value of [undefined, 'full']) {
    const label = value === undefined ? 'unset' : value;
    const s = server(); const und = setProfile(value); const calls = mock();
    const body = { agent: 'plan', parts: [{ type: 'text', text: 'review' }] };
    const snapshot = JSON.stringify(body);
    try { await s.api('POST', '/session/abc/prompt_async', body); } finally { restoreFetch(); und(); }
    const sent = (calls.requests[0] || {}).body;
    check(`profile ${label}: no tool ids fetched`, calls.ids === 0, `ids ${calls.ids}`);
    check(`profile ${label}: request body sent unchanged (no tools field)`, !!sent && deepEq(sent, body) && !Object.hasOwn(sent, 'tools'));
    check(`profile ${label}: caller body not mutated`, JSON.stringify(body) === snapshot);
  }

  // ---- 2. core: deny every non-core id, never touch core ids, keep the other fields ----
  {
    const s = server(); const und = setProfile('core'); const calls = mock();
    const body = { agent: 'plan', parts: [{ type: 'text', text: 'review' }] };
    try { await s.api('POST', '/session/abc/prompt_async', body); } finally { restoreFetch(); und(); }
    const sent = (calls.requests[0] || {}).body || {}; const tools = sent.tools || {};
    check('core: tool ids fetched once', calls.ids === 1, `ids ${calls.ids}`);
    check('core: every non-core id is denied false', NON_CORE_IN_IDS.every((id) => tools[id] === false), JSON.stringify(tools));
    check('core: duplicate ids collapse to one entry', Object.keys(tools).filter((id) => id === 'future_tool').length === 1);
    check('core: no core id is inserted or altered (inherited permissions stay inherited)', CORE_TOOLS.every((id) => !Object.hasOwn(tools, id)), JSON.stringify(tools));
    check('core: agent and parts are preserved', sent.agent === 'plan' && deepEq(sent.parts, body.parts));
    check('core: caller body is not mutated and gets no tools field', !Object.hasOwn(body, 'tools'));
  }

  // ---- 3. core keeps explicit caller denies and other fields, and still denies non-core ----
  {
    const s = server(); const und = setProfile('core'); const calls = mock();
    const body = { agent: 'build', parts: [{ type: 'text', text: 'go' }], tools: { task: false, skill: false, grep: false, webfetch: true, mcp: true } };
    const snapshot = JSON.stringify(body);
    try { await s.api('POST', '/session/abc/prompt_async', body); } finally { restoreFetch(); und(); }
    const tools = (((calls.requests[0] || {}).body) || {}).tools || {};
    check('core: explicit caller false for a core tool is kept', tools.grep === false);
    check('core: explicit caller false for a non-core tool is kept', tools.task === false && tools.skill === false);
    check('core: a caller true for a reported non-core id is overridden to false (cannot stay enabled)', tools.webfetch === false);
    check('core: an id the server does not report keeps the caller value', tools.mcp === true);
    check('core: caller body and its tools object are not mutated', JSON.stringify(body) === snapshot);
  }

  // ---- 4. cache: fetched once per private server; restart clears it and refetches ----
  {
    const s = server(); const und = setProfile('core'); const calls = mock();
    try {
      await s.api('POST', '/session/a/prompt_async', post);
      await s.api('POST', '/session/b/prompt_async', post);
      check('cache: tool ids fetched once for two requests', calls.ids === 1, `ids ${calls.ids}`);
      check('cache: both requests carry the deny map', calls.requests.length === 2 && calls.requests.every((r) => r.body.tools.task === false && r.body.tools.webfetch === false));
      s.resetToolProfile();
      await s.api('POST', '/session/c/prompt_async', post);
      check('restart: metadata cleared, ids fetched again', calls.ids === 2, `ids ${calls.ids}`);
    } finally { restoreFetch(); und(); }
    const startBody = fs.readFileSync(path.join(ROOT, 'runner', 'server.mjs'), 'utf8');
    const start = startBody.slice(startBody.indexOf('async start()'), startBody.indexOf('async api('));
    check('server start() clears the tool metadata, so a real restart refetches', /resetToolProfile\(\)/.test(start));
  }

  // ---- 5. malformed or unavailable metadata fails visibly and sends no prompt ----
  for (const [name, opts] of [
    ['non-array metadata', { idsBody: '{"ids":["bash","task"]}' }],
    ['array with a non-string id', { idsBody: JSON.stringify(['bash', 42, 'task']) }],
    ['empty id list (version skew, would silently deny nothing)', { idsBody: '[]' }],
    ['endpoint unavailable (500)', { idsStatus: 500 }],
  ]) {
    const s = server(); const und = setProfile('core'); const calls = mock(opts);
    const r = await throws(() => s.api('POST', '/session/abc/prompt_async', post));
    restoreFetch(); und();
    check(`malformed: ${name} fails visibly`, r.threw, r.msg);
    check(`malformed: ${name} sends no prompt`, calls.requests.length === 0, JSON.stringify(calls.requests));
  }

  // ---- 6. an unknown profile fails visibly instead of bypassing an explicit setting ----
  {
    const s = server(); const und = setProfile('weird'); const calls = mock();
    const r = await throws(() => s.api('POST', '/session/abc/prompt_async', post));
    restoreFetch(); und();
    check('unknown profile fails visibly and nothing is fetched or sent', r.threw && /unknown CA_TOOL_PROFILE/.test(r.msg) && calls.ids === 0 && calls.requests.length === 0, r.msg);
  }

  // ---- 7. the profile applies to prompt_async only ----
  {
    const s = server(); const und = setProfile('core'); const calls = mock();
    try { await s.api('GET', '/global/health'); await s.api('POST', '/session', { title: 't' }); await s.api('POST', '/session/a/abort', {}); }
    finally { restoreFetch(); und(); }
    check('profile applies to prompt_async only (no ids fetch for other calls)', calls.ids === 0, `ids ${calls.ids}`);
    check('profile leaves other request bodies untouched', calls.requests.every((r) => !Object.hasOwn(r.body || {}, 'tools')));
  }

  // ---- 8. the pure helpers ----
  check('CORE_TOOLS is exactly the coding set', deepEq([...CORE_TOOLS], ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'question']));
  check('profileMode: unset/blank/full mean no profile, core opts in, anything else is unknown',
    profileMode(undefined) === 'full' && profileMode('') === 'full' && profileMode('  FULL ') === 'full' && profileMode('full') === 'full' && profileMode('core') === 'core' && profileMode('weird') === 'unknown');
  check('parseToolIds: accepts a list of ids', deepEq(parseToolIds(['bash', 'task']), ['bash', 'task']));
  const bad = [[], { ids: [] }, ['bash', 1], ['bash', ''], 'bash', null, undefined];
  const badThrows = bad.every((v) => { try { parseToolIds(v); return false; } catch { return true; } });
  check('parseToolIds: rejects malformed metadata', badThrows);
  {
    const body = { agent: 'build', parts: [{ type: 'text', text: 'x' }], tools: { task: false } };
    const snapshot = JSON.stringify(body);
    const out = applyCoreProfile(body, ['bash', 'task', 'webfetch']);
    check('applyCoreProfile: returns a new body/tools and does not mutate the caller', JSON.stringify(body) === snapshot && out !== body && out.tools !== body.tools);
    check('applyCoreProfile: denies non-core and leaves core out', out.tools.webfetch === false && out.tools.task === false && !Object.hasOwn(out.tools, 'bash'));
  }
} finally {
  restoreFetch();
}

for (const line of results) console.log(line);
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
