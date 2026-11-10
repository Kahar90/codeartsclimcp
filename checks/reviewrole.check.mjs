// Contract check for the scoped independent reviewer role (runner/reviewrole.mjs + its wiring in
// runner/server.mjs). It exercises the pure config transform and the environment wrapper (no I/O, no
// dependency), then captures what a fake private server is actually started with: the check writes a
// tiny fake `codearts serve`, starts the real Server, and reads back the runner's own redacted
// CA_DUMP_ENV, proving the role and the mutation denies reach the spawned child while provider
// secrets stay redacted. No CodeArts server and no model are ever used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewRoleConfig, reviewRoleEnv, reviewRoleMode, REVIEW_ROLE_MUTATION_TOOLS } from '../runner/reviewrole.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return { threw: false, msg: '' }; } catch (e) { return { threw: true, msg: String((e && e.message) || e) }; } };
const denies = (perm) => perm && REVIEW_ROLE_MUTATION_TOOLS.every((t) => perm[t] === 'deny');
const noMutationAllow = (perm) => perm && REVIEW_ROLE_MUTATION_TOOLS.every((t) => perm[t] !== 'allow' && perm[t] !== true);

// The supplied base mirrors a real OPENCODE_CONFIG_CONTENT: a custom provider with credentials, the
// builder agent, and the plan agent with its own model, options and permissions.
const base = {
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'fixture-only' }, models: { 'glm-5.3': {} } } },
  agent: {
    build: { prompt: 'builder unchanged', model: 'maas/deepseek-v4.1-flash' },
    plan: { model: 'maas/glm-5.3', options: { reasoning: true }, permission: { read: 'allow', edit: 'deny', bash: 'ask' } },
  },
};

try {
  // ---- 1. config preservation and caller immutability ----
  {
    const snapshot = JSON.stringify(base);
    const out = reviewRoleConfig(base);
    check('caller config is not mutated', JSON.stringify(base) === snapshot);
    check('provider credentials/config preserved', out.provider === base.provider && deepEq(out.provider, base.provider));
    check('every builder setting preserved', out.agent.build === base.agent.build && deepEq(out.agent.build, base.agent.build));
    check('plan model and options preserved', out.agent.plan.model === base.agent.plan.model && deepEq(out.agent.plan.options, base.agent.plan.options));
    check('unrelated plan permissions preserved', out.agent.plan.permission.read === 'allow' && out.agent.plan.permission.bash === 'ask');
    check('mutation tools denied: ' + REVIEW_ROLE_MUTATION_TOOLS.join(', '), denies(out.agent.plan.permission));
    check('never inserts a mutation allow', noMutationAllow(out.agent.plan.permission));
    check('role prompt names reviewer, read-only and the requirement', /reviewer/i.test(out.agent.plan.prompt) && /read.only/i.test(out.agent.plan.prompt) && /requirement/i.test(out.agent.plan.prompt));
    check('role prompt keeps the requested output format', /output format/i.test(out.agent.plan.prompt) && /VERDICT/.test(out.agent.plan.prompt));
    check('role prompt forbids live lane logs and CHECK reruns', /live lane logs/i.test(out.agent.plan.prompt) && /CHECK/.test(out.agent.plan.prompt));
    check('role prompt forbids edits, commits and mutating shell', /never edit/i.test(out.agent.plan.prompt) && /never commit/i.test(out.agent.plan.prompt) && /mutating shell/i.test(out.agent.plan.prompt));
    check('output builds new objects (no aliasing of agent/plan/permission)', out !== base && out.agent !== base.agent && out.agent.plan !== base.agent.plan && out.agent.plan.permission !== base.agent.plan.permission);
  }

  // ---- 2. permission forms ----
  {
    const absent = reviewRoleConfig({ agent: { plan: { model: 'm' } } });
    check('permission absent: the four denies are added and no wildcard is invented', denies(absent.agent.plan.permission) && !Object.hasOwn(absent.agent.plan.permission, '*'));
    for (const form of ['allow', 'ask', 'deny']) {
      const o = reviewRoleConfig({ agent: { plan: { permission: form } } });
      check(`coarse permission string "${form}" is kept via '*' before the denies`, o.agent.plan.permission['*'] === form && denies(o.agent.plan.permission));
    }
    const obj = reviewRoleConfig({ agent: { plan: { permission: { '*': 'ask', read: 'allow', edit: 'allow', write: true } } } });
    check("object permission keeps its own '*' and unrelated keys", obj.agent.plan.permission['*'] === 'ask' && obj.agent.plan.permission.read === 'allow');
    check('an existing mutation allow is overridden to deny', obj.agent.plan.permission.edit === 'deny' && obj.agent.plan.permission.write === 'deny');
    check('no mutation allow survives any permission form', noMutationAllow(obj.agent.plan.permission));
    const corrupt = throws(() => reviewRoleConfig({ agent: { plan: { permission: 42 } } }));
    check('a corrupted permission value fails visibly', corrupt.threw, corrupt.msg);
    for (const permission of ['bogus', '', null]) check('invalid coarse permission is rejected', throws(() => reviewRoleConfig({ agent: { plan: { permission } } })).threw);
  }

  // ---- 3. environment wrapper: default path, preservation, immutability ----
  {
    const env = { PATH: 'x', KEEP: '1', CUSTOM_PROVIDER_KEYS: 'fixture', OPENCODE_CONFIG_CONTENT: JSON.stringify(base) };
    const before = env.OPENCODE_CONFIG_CONTENT;
    let w = null;
    try { w = reviewRoleEnv(env); } catch (e) { check('env wrapper default path runs', false, e.message); }
    check('env wrapper returns a new env and does not mutate the caller', w !== env && env.OPENCODE_CONFIG_CONTENT === before);
    check('unrelated environment entries preserved', !!w && w.PATH === 'x' && w.KEEP === '1' && w.CUSTOM_PROVIDER_KEYS === 'fixture');
    let cfg = null; try { cfg = JSON.parse(w.OPENCODE_CONFIG_CONTENT); } catch {}
    check('captured child config keeps provider, builder and model', cfg && deepEq(cfg.provider, base.provider) && deepEq(cfg.agent.build, base.agent.build) && cfg.agent.plan.model === base.agent.plan.model);
    check('captured child config carries the scoped role and denies', cfg && /reviewer/i.test(cfg.agent.plan.prompt) && denies(cfg.agent.plan.permission));
    check('captured child config never adds a mutation allow', cfg && noMutationAllow(cfg.agent.plan.permission));

    const w2 = reviewRoleEnv({ ONLY: '1' });
    let cfg2 = null; try { cfg2 = JSON.parse(w2.OPENCODE_CONFIG_CONTENT); } catch {}
    check('an absent config gets a scoped role config instead of failing', cfg2 && /reviewer/i.test(cfg2.agent.plan.prompt) && denies(cfg2.agent.plan.permission));
  }

  // ---- 4. native escape hatch, unknown value, malformed explicit config ----
  {
    const env = { CA_REVIEW_ROLE: 'native', OPENCODE_CONFIG_CONTENT: 'RAW-CONFIG', KEEP: '1' };
    const w = reviewRoleEnv(env);
    check('native keeps the prior environment exactly (same object, nothing injected)', w === env && w.OPENCODE_CONFIG_CONTENT === 'RAW-CONFIG');
    if (process.platform === 'win32') {
      const lower = { ca_review_role: 'native', OPENCODE_CONFIG_CONTENT: 'RAW' };
      check('Windows case-insensitive native escape hatch is preserved', reviewRoleEnv(lower) === lower);
    }
    for (const v of ['  NATIVE  ', 'Native']) check(`native is case/space tolerant ("${v}")`, reviewRoleEnv({ CA_REVIEW_ROLE: v, OPENCODE_CONFIG_CONTENT: 'RAW' }).OPENCODE_CONFIG_CONTENT === 'RAW');

    check('reviewRoleMode: unset/blank/default mean scoped role, native the escape hatch, else unknown',
      reviewRoleMode(undefined) === 'default' && reviewRoleMode('') === 'default' && reviewRoleMode('  ') === 'default' && reviewRoleMode('Default') === 'default' && reviewRoleMode(' native ') === 'native' && reviewRoleMode('weird') === 'unknown');

    const unk = throws(() => reviewRoleEnv({ CA_REVIEW_ROLE: 'bogus-role', OPENCODE_CONFIG_CONTENT: '{}' }));
    check('unknown CA_REVIEW_ROLE fails visibly', unk.threw && /CA_REVIEW_ROLE/.test(unk.msg));
    check('unknown value is not printed back', !/bogus-role/.test(unk.msg));

    for (const [name, raw] of [['not JSON', '{oops'], ['a JSON array', '[1,2]'], ['a JSON number', '42'], ['JSON null', 'null']]) {
      const r = throws(() => reviewRoleEnv({ OPENCODE_CONFIG_CONTENT: raw }));
      check(`malformed explicit config fails visibly: ${name}`, r.threw, r.msg);
      check(`malformed config body is never printed: ${name}`, !r.msg.includes(raw));
    }

    check('reviewRoleConfig rejects a non-object config', throws(() => reviewRoleConfig('nope')).threw && throws(() => reviewRoleConfig([])).threw && throws(() => reviewRoleConfig(7)).threw && throws(() => reviewRoleConfig(null)).threw);
    check('reviewRoleConfig rejects a corrupted nested agent/plan', throws(() => reviewRoleConfig({ agent: 'x' })).threw && throws(() => reviewRoleConfig({ agent: { plan: 5 } })).threw);
    check('reviewRoleConfig treats an absent config as empty', denies(reviewRoleConfig().agent.plan.permission));
  }

  // ---- 5. wiring: the role is scoped to the private Server start, not to caEnv or user config ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'runner', 'server.mjs'), 'utf8');
    const start = src.slice(src.indexOf('async start()'), src.indexOf('async api('));
    check('server imports the review role wrapper', /import\s*\{\s*reviewRoleEnv\s*\}\s*from\s*'\.\/reviewrole\.mjs'/.test(src));
    check('server start computes one child env via reviewRoleEnv', /reviewRoleEnv\(caEnv\(/.test(start));
    check('server spawn uses that single child env', /env:\s*childEnv\b/.test(start) && !/env:\s*caEnv\(/.test(start));
    check('the redacted env dump uses the same child env', /redactEnv\(childEnv\)/.test(start));
    const common = fs.readFileSync(path.join(ROOT, 'runner', 'common.mjs'), 'utf8');
    check('global caEnv/user config is untouched (role is server-start scoped only)', !/reviewRole/.test(common));
  }

  // ---- 6. fake private-server capture: the actual spawned child env carries the role ----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-reviewrole-'));
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo, { recursive: true });
    // A tiny fake `codearts serve` (node runs this file): answer health, then idly serve {}.
    fs.writeFileSync(path.join(repo, 'serve'),
      "const http=require('node:http');const p=Number(process.argv[process.argv.indexOf('--port')+1]);" +
      "http.createServer((q,s)=>{if(String(q.url).endsWith('/global/health')){s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({healthy:true,version:'fake-1'}));return;}" +
      "s.writeHead(200,{'content-type':'application/json'});s.end('{}');}).listen(p,'127.0.0.1');\n");
    const dump = path.join(tmp, 'env-dump.json');
    const secret = 'REVIEWROLESECRET123';
    const saved = { CODEARTS_EXE: process.env.CODEARTS_EXE, CA_DUMP_ENV: process.env.CA_DUMP_ENV, MAAS_API_KEY: process.env.MAAS_API_KEY, CA_REVIEW_ROLE: process.env.CA_REVIEW_ROLE };
    const setKey = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    process.env.CODEARTS_EXE = process.execPath;
    process.env.CA_DUMP_ENV = dump;
    process.env.MAAS_API_KEY = secret;
    delete process.env.CA_REVIEW_ROLE;
    let server = null; let startErr = '';
    try {
      const { Server } = await import('../runner/server.mjs');
      server = new Server(repo, path.join(tmp, 'server.log'));
      server.pw = 'pw';
      await server.start();
      const invalidLog = path.join(tmp, 'invalid-role.log');
      const originalOpen = fs.openSync; const logFds = []; let rejected = false;
      const invalidServer = new Server(repo, invalidLog);
      fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (file === invalidLog) logFds.push(fd); return fd; };
      process.env.CA_REVIEW_ROLE = 'invalid';
      try { await invalidServer.start(); } catch (e) { rejected = /unknown CA_REVIEW_ROLE/.test(e.message); }
      finally {
        fs.openSync = originalOpen; delete process.env.CA_REVIEW_ROLE; invalidServer.stop();
        for (const fd of logFds) { try { fs.closeSync(fd); } catch {} }
      }
      check('invalid role is rejected before opening a log descriptor', rejected && logFds.length === 0);
    } catch (e) { startErr = String((e && e.message) || e); }
    finally {
      try { server?.stop(); } catch {}
      for (const [k, v] of Object.entries(saved)) setKey(k, v);
    }
    check('fake private server: start() succeeded against the fake serve', !startErr, startErr);
    const text = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
    check('fake private server: the runner wrote the child env dump', text.length > 0);
    check('fake private server: the provider key is redacted in the dump', text.length > 0 && !text.includes(secret));
    let dj = null; try { dj = JSON.parse(text); } catch {}
    let cfg = null; try { cfg = JSON.parse((dj && dj.env && dj.env.OPENCODE_CONFIG_CONTENT) || 'null'); } catch {}
    check('fake private server: the actual spawned env carries the scoped role', cfg && /reviewer/i.test(cfg.agent.plan.prompt));
    check('fake private server: the actual spawned env denies the mutation tools', cfg && denies(cfg.agent.plan.permission));
    check('fake private server: provider config preserved with the key redacted', cfg && cfg.provider && cfg.provider.maas && cfg.provider.maas.options.apiKey === '<redacted>');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
} finally {
  for (const line of results) console.log(line);
  const failed = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
