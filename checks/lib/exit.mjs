// checks/lib/exit.mjs: shut a browser or CDP harness down cleanly. Under Node on Windows, calling
// process.exit() while a WebSocket, a child process or a timer is still closing aborts the process
// with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exits 127, which the runner
// reads as "the check could not run". Close the socket, kill the children, wait for them to exit,
// then set process.exitCode and let the event loop drain, so the real pass/fail code survives.
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

// settle({ socket, children, code }): close the CDP socket, kill and await every child process,
// then set process.exitCode. Returns once every handle is closed, so the caller can just return.
export async function settle({ socket = null, children = [], code = 0, timeoutMs = 15000 } = {}) {
  await closeSocket(socket, timeoutMs);
  await Promise.all(children.filter(Boolean).map((c) => childExit(c, timeoutMs)));
  process.exitCode = code;
}
