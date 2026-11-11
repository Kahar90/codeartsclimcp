// Contract check for lane hardening: problems a lead used to find by hand after 20+ minutes.
//  (a) brief lint: `ca brief-check <repo> <task> [--json]` and the start of `ca lane` warn when the brief
//      protects files ("do not edit/touch/change X") that reference files the brief changes, and when a
//      CHECK line runs a file that does not exist. Warnings never block a lane.
//  (b) helper guard: the runner owns tasks/<task>.lane/check.mjs; a worker that overwrites it gets it
//      restored within seconds and is told not to edit runner files.
//  (c) orphan guard: a supervisor whose repo was deleted (no .git) stops itself and its server.
//  (d) step progress: only a commit for a NEW step resets the no-progress clock in the build phase
//      (busywork commits like "wip: ..." do not), so NO_COMMIT_S still fires.
// Fake CodeArts server, private registry, no paid model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, pool } from './lib/pool.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-hardening-')));
const reg = path.join(tmp, 'registry'); fs.mkdirSync(reg);
const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ security: { trustedFolders: [] } }));
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
const env = { ...process.env, CA_REGISTRY: reg, CA_SETTINGS: settings, CA_DASH: '0', CA_NO_UPDATE_CHECK: '1', CODEARTS_EXE: process.execPath, NO_REVIEW: '1',
  CODEARTS_CLI_AK: 'fake-ak', CODEARTS_CLI_SK: 'fake-sk', STALL_S: '600', THINK_S: '0', LANE_TIMEOUT: '240' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await sleep(500); } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const ca = (cwd, args, ms = 120000, extra = {}) => run(process.execPath, [CA, ...args], { cwd, env: { ...env, ...extra }, timeout: ms });

function makeRepo(name, { script = ['ok'], brief = 'Goal: one page.\n1. Write page1.html. Commit.\nCHECK: node -e 0\n', files = {} } = {}) {
  const repo = path.join(tmp, name); fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'checks', 'lib', 'fake-codearts.cjs'), path.join(repo, 'serve'));
  fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); }
  fs.writeFileSync(path.join(repo, 'tasks', 'work.md'), brief);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}

// ---------- (a) brief lint ----------
const lintFiles = {
  'src/core.mjs': 'export const x = 1;\n',
  'src/other.mjs': 'export const y = 2;\n',
  'checks/core.check.mjs': "import fs from 'node:fs';\nconst src = fs.readFileSync('src/core.mjs', 'utf8');\nif (!/export const x/.test(src)) process.exit(1);\n",
  'checks/other.check.mjs': "import fs from 'node:fs';\nfs.readFileSync('src/other.mjs', 'utf8');\n",
};
const badBrief = 'Goal: split the core.\nRules: do not edit `checks/`.\n1. Move the code of `src/core.mjs` into `src/core-a.mjs` and `src/core-b.mjs`. Commit.\nCHECK: node checks/core.check.mjs\nCHECK: node checks/missing.check.mjs\n';

async function scenLint() {
  const local = []; const chk = (name, ok, info = '') => local.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
  const lint = makeRepo('lint', { brief: badBrief, files: lintFiles });
  let r = await ca(lint, ['brief-check', lint, 'work', '--json'], 30000);
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  const ws = j?.warnings || [];
  chk('brief-check --json returns {warnings: [...]} and exits 0 (warnings never block)', r.status === 0 && Array.isArray(j?.warnings), `${r.status} ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  const prot = ws.find((w) => w.kind === 'protected-dependent');
  chk('warns that protected checks/core.check.mjs references src/core.mjs, which the brief changes', !!prot && /checks\/core\.check\.mjs/.test(prot.file) && /src\/core\.mjs/.test(String(prot.references)) && /checks/.test(prot.rule || ''), JSON.stringify(ws));
  chk('does not warn about protected files that reference nothing the brief changes', !ws.some((w) => /other\.check/.test(w.file || '')), JSON.stringify(ws));
  const miss = ws.find((w) => w.kind === 'missing-check-file');
  chk('warns that a CHECK line runs a file that does not exist', !!miss && /checks\/missing\.check\.mjs/.test(miss.file || ''), JSON.stringify(ws));
  r = await ca(lint, ['brief-check', lint, 'work'], 30000);
  chk('plain brief-check prints one readable line per warning', r.status === 0 && /core\.check\.mjs/.test(r.stdout) && /missing\.check\.mjs/.test(r.stdout), r.stdout.slice(0, 300));
  const clean = makeRepo('clean', { files: lintFiles });
  r = await ca(clean, ['brief-check', clean, 'work', '--json'], 30000);
  try { j = JSON.parse(r.stdout); } catch { j = null; }
  chk('a clean brief has no warnings', r.status === 0 && Array.isArray(j?.warnings) && j.warnings.length === 0, r.stdout.slice(0, 200));
  r = await ca(lint, ['lane', lint, 'work', '--detach'], 60000);
  chk('ca lane prints the brief warnings at start and still starts', r.status === 0 && /brief warning/i.test(r.stdout + r.stderr) && /core\.check\.mjs/.test(r.stdout + r.stderr), `${r.status} ${(r.stdout + r.stderr).slice(0, 300)}`);
  r = await ca(lint, ['wait', 'lint--work', '--timeout', '90', '--quiet'], 120000);
  chk('the summary lists the brief warnings', /brief warning/i.test(read(path.join(lint, 'tasks', 'work.lane', 'summary.md'))), read(path.join(lint, 'tasks', 'work.lane', 'summary.md')).slice(0, 300));
  return local;
}

// ---------- (b) helper guard ----------
async function scenHelper() {
  const local = []; const chk = (name, ok, info = '') => local.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
  const hRepo = makeRepo('helper', { script: ['commit:1+wait:3000+write:tasks/work.lane/check.mjs=console.log(1)+wait:15000', 'ok'] });
  await ca(hRepo, ['lane', hRepo, 'work', '--detach']);
  const helper = path.join(hRepo, 'tasks', 'work.lane', 'check.mjs');
  const original = await until(() => { const t = read(helper); return t && !/^console\.log\(1\)/.test(t) ? t : ''; }, 15000);
  chk('the runner writes its check helper at lane start', original.length > 50, original.slice(0, 80));
  const overwritten = await until(() => read(helper) === 'console.log(1)', 15000);
  const restored = await until(() => read(helper) === original, 15000);
  chk('a worker that overwrites the helper gets it restored within seconds', restored, `overwritten seen: ${!!overwritten}; now: ${read(helper).slice(0, 60)}`);
  const toldH = await until(() => /do not (edit|write|change)[^\n]*(runner|tasks\/work\.lane)/i.test(read(path.join(hRepo, 'fake-prompts.log'))), 10000);
  chk('the worker is told not to edit runner files', !!toldH, read(path.join(hRepo, 'fake-prompts.log')).slice(-300));
  chk('the restore is logged in live.log', /helper restored|restored the check helper/i.test(read(path.join(hRepo, 'tasks', 'work.lane', 'live.log'))));
  await ca(hRepo, ['wait', 'helper--work', '--timeout', '90', '--quiet'], 120000);
  return local;
}

// ---------- (c) orphan guard ----------
async function scenOrphan() {
  const local = []; const chk = (name, ok, info = '') => local.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
  const oRepo = makeRepo('orphan', { script: ['commit:1+wait:90000', 'ok'] });
  await ca(oRepo, ['lane', oRepo, 'work', '--detach']);
  const st = await until(() => { try { const s = JSON.parse(read(path.join(oRepo, 'tasks', 'work.lane', 'state.json'))); return s.pid && s.server?.pid ? s : null; } catch { return null; } }, 20000);
  chk('orphan lane runs with a supervisor and a server', !!st && alive(st.pid) && alive(st.server.pid), JSON.stringify(st && { pid: st.pid, server: st.server?.pid }));
  fs.rmSync(path.join(oRepo, '.git'), { recursive: true, force: true, maxRetries: 5 });
  const gone = await until(() => st && !alive(st.pid) && !alive(st.server.pid), 20000);
  chk('deleting the repo (.git gone) stops the supervisor and its server within 20 s', !!gone, st ? `supervisor ${alive(st.pid)} server ${alive(st.server?.pid)}` : 'no state');
  if (st) for (const p of [st.pid, st.server?.pid]) if (alive(p)) { try { process.kill(p); } catch {} } // never leak a supervisor when this fails
  return local;
}

// ---------- (d) step progress ----------
async function scenBusy() {
  const local = []; const chk = (name, ok, info = '') => local.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 300) : ''}`);
  const pRepo = makeRepo('busy', { script: ['commit:1+noise:1+wait:3000+noise:2+wait:3000+noise:3+wait:3000+noise:4+wait:20000', 'ok'],
    brief: 'Goal: two pages.\n1. Write page1.html. Commit.\n2. Write page2.html. Commit.\nCHECK: node -e 0\n' });
  await ca(pRepo, ['lane', pRepo, 'work', '--detach'], 60000, { NO_COMMIT_S: '7' });
  const r = await ca(pRepo, ['wait', 'busy--work', '--timeout', '40', '--quiet'], 60000);
  const bl = String(r.stdout).split(/\r?\n/).filter((l) => l.startsWith('CA_BLOCKED ')).map((l) => { try { return JSON.parse(l.slice(11)); } catch { return null; } }).filter(Boolean);
  chk('busywork commits do not reset the no-progress clock: CA_BLOCKED no-progress fires', r.status === 11 && bl[0]?.kind === 'no-progress' && /no commit in/.test(bl[0]?.text || ''), `${r.status} ${r.stdout.slice(0, 300)}`);
  chk('the no-progress text names the step it is stuck before', /step 2/.test(bl[0]?.text || ''), bl[0]?.text);
  await ca(pRepo, ['ack', 'busy--work']); await ca(pRepo, ['wait', 'busy--work', '--timeout', '90', '--quiet'], 120000);
  return local;
}

// The four end-to-end scenarios are independent (own repo, shared registry), so overlap them.
const [lintL, helperL, orphanL, busyL] = await pool(4, [scenLint, scenHelper, scenOrphan, scenBusy]);
results.push(...lintL, ...helperL, ...orphanL, ...busyL);

const helpR = await ca(tmp, ['help'], 10000);
check('ca help lists brief-check', /brief-check/.test(helpR.stdout));

for (const l of results) console.log(l);
const fails = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
process.exit(fails ? 1 : 0);
