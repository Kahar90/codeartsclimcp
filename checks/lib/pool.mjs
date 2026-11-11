// Run independent check scenarios at the same time instead of one after another.
//   run(cmd, args, opts)  async stand-in for spawnSync(cmd, args, { encoding: 'utf8', ... }): resolves
//                         { status, stdout, stderr } and kills the child after opts.timeout ms.
//   pool(limit, thunks)   runs the async thunks at most `limit` at once; results keep the thunks' order.
import { spawn } from 'node:child_process';

export function run(cmd, args, { timeout = 0, ...opts } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timer = null;
    const ch = spawn(cmd, args, { windowsHide: true, ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.on('data', (d) => { stdout += d; });
    ch.stderr.on('data', (d) => { stderr += d; });
    if (timeout) timer = setTimeout(() => ch.kill(), timeout);
    const end = (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); };
    ch.on('close', (code) => end(code));
    ch.on('error', (e) => { stderr += String(e); end(null); });
  });
}

export async function pool(limit, thunks) {
  const results = new Array(thunks.length); let next = 0;
  const worker = async () => { while (next < thunks.length) { const i = next++; results[i] = await thunks[i](); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, worker));
  return results;
}
