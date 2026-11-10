// Contract check: every unattended subprocess launch in runner/ca.mjs hides its console window on
// Windows (windowsHide: true), so background lanes never pop empty console windows; the intentional
// interactive launches (ca attach, the dashboard "Open TUI") stay visible. The check instruments
// node:child_process (syncBuiltinESMExports) and runs the REAL launch statements extracted from the
// runner through the instrumented functions, so it asserts the production options, not a copy.
// Nothing here starts CodeArts, touches credentials, the network or a paid model.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = path.join(ROOT, 'runner', 'ca.mjs');
const src = [CA, ...['common', 'server', 'lane', 'commands', 'engineer', 'plan', 'dash-server'].map((m) => path.join(ROOT, 'runner', `${m}.mjs`)).filter((f) => fs.existsSync(f))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 240) : ''}`);

// ---- instrument node:child_process: record every launch and its options, spawn nothing ----
const calls = [];
const rec = (fn) => (file, argv, opts, ...rest) => {
  const options = [opts, ...rest].find((o) => o && typeof o === 'object' && !Array.isArray(o)) || {};
  calls.push({ fn, file, argv, options });
  if (fn === 'spawn') return { pid: 4242, on() { return this; }, unref() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  return { status: 0, stdout: 'recorded', stderr: '', error: undefined };
};
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const orig = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execSync: cp.execSync };
cp.spawn = rec('spawn'); cp.spawnSync = rec('spawnSync'); cp.execFileSync = rec('execFileSync'); cp.execSync = rec('execSync');
syncBuiltinESMExports();
const stub = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execSync: cp.execSync };
const last = (fn, match) => [...calls].reverse().find((c) => c.fn === fn && (!match || match(c)));

// ---- extract a real statement from the runner source and run it against the instrumented calls ----
const balanced = (start, open, close) => {
  let depth = 0;
  for (let i = start; i < src.length; i++) { const c = src[i]; if (c === open) depth++; else if (c === close && --depth === 0) return src.slice(start, i + 1); }
  throw new Error(`unbalanced ${open}`);
};
const callExpr = (marker, callee) => {
  const mi = src.indexOf(marker); if (mi < 0) throw new Error(`marker not found: ${marker}`);
  const ci = src.indexOf(callee + '(', mi); if (ci < 0) throw new Error(`callee not found: ${callee} after ${marker}`);
  const paren = ci + callee.length;
  return src.slice(ci, paren) + balanced(paren, '(', ')');
};
const arrowExpr = (marker) => {
  const mi = src.indexOf(marker); if (mi < 0) throw new Error(`marker not found: ${marker}`);
  const eq = src.indexOf('=>', mi); const body = src.indexOf('{', eq); const par = src.lastIndexOf('(', eq);
  return src.slice(par, body) + balanced(body, '{', '}');
};
const evalExpr = (expr, scope) => { const keys = Object.keys(scope); return new Function(...keys, `return (${expr});`)(...keys.map((k) => scope[k])); };
const runCall = (expr, scope, thisArg) => { const keys = Object.keys(scope); const fn = new Function(...keys, `return (${expr});`); return thisArg ? fn.call(thisArg, ...keys.map((k) => scope[k])) : fn(...keys.map((k) => scope[k])); };
const run = (name, fn) => { try { return fn(); } catch (e) { check(name, false, e.message); return null; } };

// 0. positive control: an already-correct launch must be detected as hidden (proves the harness works)
run('control: runCheck launch is detected as hidden', () => {
  calls.length = 0;
  evalExpr(callExpr(`const ch = spawn(checkShell()`, 'spawn'), { spawn: stub.spawn, repo: '/repo', id: 'x', cmd: 'true', checkShell: () => 'bash', checkEnv: () => ({}) });
  const c = calls[0];
  check('control: runCheck launch is detected as hidden', !!c && c.options.windowsHide === true, JSON.stringify(c && c.options));
});

// 1. the git helper (syncCommits polls it every 5000 ms in lane supervision)
run('git helper hides its window', () => {
  calls.length = 0;
  const gitFn = evalExpr(arrowExpr('const git = '), { spawnSync: stub.spawnSync });
  gitFn('/repo', 'log', '--oneline');
  const c = calls[0];
  check('git helper hides its window', !!c && c.file === 'git' && c.options.windowsHide === true, JSON.stringify(c && c.options));
  check('git helper keeps cwd, argv and encoding', !!c && c.options.cwd === '/repo' && c.options.encoding === 'utf8' && Array.isArray(c.argv) && c.argv.join(' ') === 'log --oneline', JSON.stringify(c && c.argv));
});

// 2. the user-environment read through reg query (userEnv on Windows)
run('credential registry read hides its window', () => {
  calls.length = 0;
  evalExpr(callExpr(`execFileSync('reg'`, 'execFileSync'), { execFileSync: stub.execFileSync });
  const c = calls[0];
  check('credential registry read hides its window', !!c && c.file === 'reg' && c.options.windowsHide === true && c.options.encoding === 'utf8', JSON.stringify(c && c.options));
});

// 3. the killTree taskkill cleanup (Windows branch)
run('taskkill cleanup hides its window', () => {
  calls.length = 0;
  const killFn = evalExpr(arrowExpr('const killTree = '), { spawnSync: stub.spawnSync, process: { platform: 'win32', kill() {} } });
  killFn(4242);
  const c = calls[0];
  check('taskkill cleanup hides its window', !!c && c.file === 'taskkill' && c.options.windowsHide === true, JSON.stringify(c && c.options));
  check('taskkill cleanup keeps stdio and /PID /T /F', !!c && c.options.stdio === 'ignore' && Array.isArray(c.argv) && c.argv.join(' ') === '/PID 4242 /T /F', JSON.stringify(c && c.argv));
});

// 4. the private codearts serve spawn
run('codearts serve spawn hides its window', () => {
  calls.length = 0;
  runCall(callExpr('this.child = spawn', 'spawn'), { spawn: stub.spawn, EXE: 'codearts', caEnv: () => ({}), out: 1 }, { cwd: '/repo', port: 1234, pw: 'secret' });
  const c = calls[0];
  check('codearts serve spawn hides its window', !!c && c.fn === 'spawn' && c.file === 'codearts' && c.options.windowsHide === true, JSON.stringify(c && c.options));
  check('codearts serve spawn keeps stdio, cwd and args', !!c && Array.isArray(c.options.stdio) && c.options.stdio[0] === 'ignore' && c.options.cwd === '/repo' && Array.isArray(c.argv) && c.argv.includes('serve') && c.argv.includes('--print-logs'), JSON.stringify(c && c.argv));
});

// 5. the folder trust helper (node scripts/trust.mjs)
run('folder trust helper hides its window', () => {
  calls.length = 0;
  evalExpr(callExpr('const tr = spawnSync(process.execPath,', 'spawnSync'), { spawnSync: stub.spawnSync, process: { execPath: 'node' }, path, SKILL: '/skill', repo: '/repo' });
  const c = calls[0];
  check('folder trust helper hides its window', !!c && c.fn === 'spawnSync' && c.file === 'node' && c.options.windowsHide === true && c.options.encoding === 'utf8', JSON.stringify(c && c.options));
  check('folder trust helper still calls scripts/trust.mjs with the repo', !!c && Array.isArray(c.argv) && /scripts[\\/]trust\.mjs$/.test(c.argv[0]) && c.argv[1] === '/repo', JSON.stringify(c && c.argv));
});

// 6. the doctor git --version probe
run('doctor git version hides its window', () => {
  calls.length = 0;
  evalExpr(callExpr(`const g = spawnSync('git', ['--version']`, 'spawnSync'), { spawnSync: stub.spawnSync });
  const c = calls[0];
  check('doctor git version hides its window', !!c && c.file === 'git' && c.options.windowsHide === true && c.options.encoding === 'utf8', JSON.stringify(c && c.options));
});

// 7. the intentional interactive launches must stay visible (attach behavior preserved)
run('ca attach stays interactive in the caller terminal', () => {
  calls.length = 0;
  evalExpr(callExpr(`spawnSync(EXE, ['attach'`, 'spawnSync'), { spawnSync: stub.spawnSync, EXE: 'codearts', caEnv: () => ({}), sid: 'ses', s: { server: { url: 'http://127.0.0.1:1', pw: 'pw' }, activeSession: 'ses' } });
  const c = calls[0];
  check('ca attach stays interactive in the caller terminal', !!c && c.options.windowsHide !== true && c.options.stdio === 'inherit', JSON.stringify(c && c.options));
});
run('dashboard Open TUI keeps a visible console window', () => {
  calls.length = 0;
  evalExpr(callExpr(`spawn('cmd.exe'`, 'spawn'), { spawn: stub.spawn, caEnv: () => ({}), EXE: 'codearts', l: { id: 'x' }, sid: 'ses', s: { server: { url: 'u', pw: 'p' }, activeSession: 'ses' } });
  const c = calls[0];
  check('dashboard Open TUI keeps a visible console window', !!c && c.fn === 'spawn' && c.file === 'cmd.exe' && c.options.windowsHide !== true && c.options.detached === true && c.options.windowsVerbatimArguments === true, JSON.stringify(c && c.options));
});

// 8. catch-all: no spawn/spawnSync/execFileSync site in the runner may omit windowsHide, except the
// two intentional interactive windows (ca attach, the dashboard Open TUI). Keeps a future launch from
// silently reintroducing the empty-window bug.
run('no unattended launch is left unhidden', () => {
  const bad = [];
  for (const name of ['spawn', 'spawnSync', 'execFileSync', 'execSync']) {
    let i = -1;
    while ((i = src.indexOf(name + '(', i + 1)) >= 0) {
      const lineStart = src.lastIndexOf('\n', i - 1) + 1;
      if (src.slice(lineStart, i).includes('//')) continue; // a comment, not a call
      let text; try { text = src.slice(i, i + name.length) + balanced(i + name.length, '(', ')'); } catch { continue; }
      if (text.includes('windowsHide')) continue;
      if (text.includes("'attach'") || text.includes("'cmd.exe'")) continue; // intentional interactive windows
      bad.push(text.replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  check('no unattended launch is left unhidden', bad.length === 0, bad.join(' | '));
});

// restore the real functions before this process exits
cp.spawn = orig.spawn; cp.spawnSync = orig.spawnSync; cp.execFileSync = orig.execFileSync; cp.execSync = orig.execSync; syncBuiltinESMExports();

console.log(results.join('\n'));
const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
