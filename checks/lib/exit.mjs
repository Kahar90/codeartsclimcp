// checks/lib/exit.mjs: shut a browser or CDP harness down cleanly. Under Node on Windows, calling
// process.exit() while a WebSocket, a child process or a timer is still closing aborts the process
// with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exits 127, which the runner
// reads as "the check could not run". Close the socket, kill the children, wait for them to exit,
// then set process.exitCode and let the event loop drain, so the real pass/fail code survives.
//
// guard({ socket, children }): remember the handles a harness started and install the process-level
// hooks once. A crash (uncaught exception or unhandled rejection) then still closes the socket and
// kills Chrome and the dash through the same settle() path instead of orphaning them, and a plain
// process exit kills the children as a last line of defence. Call it right after spawning, and
// again once the CDP socket exists.
const CLOSED = 3;

function closeSocket(socket, timeoutMs) {
  return new Promise((res) => {
    if (!socket || socket.readyState === CLOSED) return res();
    let done = false;
    const fin = () => { if (done) return; done = true; res(); };
    try { socket.addEventListener('close', fin, { once: true }); socket.close(); } catch { fin(); }
    setTimeout(fin, timeoutMs).unref();
  });
}

function childExit(child, timeoutMs) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return res();
    let done = false;
    const fin = () => { if (done) return; done = true; res(); };
    child.once('exit', fin);
    child.once('close', fin);
    try { child.kill(); } catch { fin(); }
    setTimeout(fin, timeoutMs).unref();
  });
}

const live = { socket: null, children: [] };
let hooked = false;

// Kill the tracked children synchronously; the process 'exit' hook cannot await.
function killSync(children) {
  for (const c of children) { try { if (c && c.exitCode === null && c.signalCode === null) c.kill(); } catch {} }
}

// guard({ socket, children }): register the handles a harness started and install the crash hooks
// once. Idempotent, so a harness can call it again once the CDP socket exists.
export function guard({ socket = null, children = [] } = {}) {
  if (socket) live.socket = socket;
  for (const c of children) if (c && !live.children.includes(c)) live.children.push(c);
  if (hooked) return;
  hooked = true;
  process.on('exit', () => killSync(live.children));
  const crash = (label) => (err) => {
    console.error(`${label}: ${(err && (err.stack || err.message)) || err}`);
    settle({ socket: live.socket, children: live.children, code: 1 });
  };
  process.on('uncaughtException', crash('UNCAUGHT EXCEPTION'));
  process.on('unhandledRejection', crash('UNHANDLED REJECTION'));
}

// settle({ socket, children, code }): close the CDP socket, kill and await every child process,
// then set process.exitCode. Returns once every handle is closed, so the caller can just return.
export async function settle({ socket = null, children = [], code = 0, timeoutMs = 15000 } = {}) {
  await closeSocket(socket, timeoutMs);
  await Promise.all(children.filter(Boolean).map((c) => childExit(c, timeoutMs)));
  process.exitCode = code;
}
