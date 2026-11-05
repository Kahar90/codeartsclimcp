// Headless Chrome via CDP: drive index.html with real key events, assert on window.__snake.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const url = 'file:///D:/Coding/snake-codearts/index.html';
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9336', `--user-data-dir=${process.cwd()}\profile-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 120 && !ws; i++) { await wait(250); try { const t = await (await fetch('http://127.0.0.1:9336/json')).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch { /* not up yet */ } }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errors = [];
sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const KEYS = { ' ': ['Space', 32], Enter: ['Enter', 13], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], p: ['KeyP', 80] };
const key = async (k) => { const [code, kc] = KEYS[k]; await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: kc }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc }); };
const st = () => ev('window.__snake.state()');
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 560, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await wait(1000);
await ev(`localStorage.setItem('snake-best','0')`); await send('Page.reload'); await wait(800);
let s = await st();
check('starts ready, length 3, moving right', s.status === 'ready' && s.snake.length === 3 && s.dir.x === 1, JSON.stringify(s.snake[0]));
check('food not on snake', !s.snake.some((c) => c.x === s.food.x && c.y === s.food.y));
await shot('1-ready');

await key(' '); await wait(50); s = await st();
check('Space starts', s.status === 'playing');
await key(' '); s = await st(); check('Space pauses', s.status === 'paused');
// deterministic stepping while paused
const h0 = (await st()).snake[0];
await ev('window.__snake.step()'); s = await st();
check('step() advances one cell right', s.snake[0].x === h0.x + 1 && s.snake[0].y === h0.y);
await key('ArrowLeft'); await ev('window.__snake.step()'); s = await st();
check('reverse turn ignored', s.dir.x === 1 && s.dir.y === 0);
await key('ArrowUp'); await key('ArrowLeft'); await ev('window.__snake.step()'); s = await st();
check('queued turn 1 (Up)', s.dir.y === -1);
await ev('window.__snake.step()'); s = await st();
check('queued turn 2 (Left)', s.dir.x === -1);
await key('p'); s = await st(); check('P resumes', s.status === 'playing');
await key('p');
// drive into the left wall while paused-stepping
for (let i = 0; i < 25 && (await st()).status !== 'over'; i++) await ev('window.__snake.step()');
s = await st();
// step() only ticks when paused/ready; status turns over on wall hit
check('wall hit ends game', s.status === 'over', `head=${JSON.stringify(s.snake[0])}`);
await shot('2-over');

// eat food: place the head next to food by stepping toward it from a fresh start
await key('Enter'); await key(' '); s = await st();
check('Enter restarts, state reset', s.snake.length === 3 && s.score === 0 && s.dir.x === 1, s.status);
const target = s.food; let guard = 0;
while (guard++ < 60) {
  s = await st(); const h = s.snake[0];
  if (s.score > 0 || s.status === 'over') break;
  // greedy toward food, never the reverse of the current direction
  const moves = [['ArrowRight', 1, 0], ['ArrowLeft', -1, 0], ['ArrowDown', 0, 1], ['ArrowUp', 0, -1]]
    .filter(([, dx, dy]) => !(dx === -s.dir.x && dy === -s.dir.y))
    .filter(([, dx, dy]) => h.x + dx >= 0 && h.x + dx < 20 && h.y + dy >= 0 && h.y + dy < 20)
    .sort((a, b) => (Math.abs(h.x + a[1] - target.x) + Math.abs(h.y + a[2] - target.y)) - (Math.abs(h.x + b[1] - target.x) + Math.abs(h.y + b[2] - target.y)));
  const want = moves[0][0];
  await key(want); await ev('window.__snake.step()');
}
s = await st();
check('eating grows and scores', s.score === 10 && s.snake.length === 4, `score=${s.score} len=${s.snake.length} status=${s.status}`);

// real-time loop: resume and let it run
await key(' '); const before = (await st()).snake[0]; await wait(700); s = await st();
check('real-time loop moves the snake', s.status !== 'playing' || JSON.stringify(s.snake[0]) !== JSON.stringify(before));
await key(' '); await shot('3-paused');
// die, then best persists across reload
for (let i = 0; i < 40 && (await st()).status !== 'over'; i++) await ev('window.__snake.step()');
await send('Page.reload'); await wait(800); s = await st();
check('best persists in localStorage', s.best === 10 && (await ev(`localStorage.getItem('snake-best')`)) === '10');
await key(' '); await wait(900); await shot('4-playing');
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(results.join('\n'));
sock.close(); chrome.kill();
