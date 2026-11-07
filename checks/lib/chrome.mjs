// checks/lib/chrome.mjs: find a Chrome/Chromium binary on Windows, macOS and Linux, and give the
// browser checks a fresh long-form temp profile plus the flags Linux CI needs. CHROME_PATH wins
// when it points at a real file; findChrome() returns null when nothing is found so a check can
// print SKIP and exit 0 instead of failing on a machine without Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const existing = (p) => (typeof p === 'string' && p.length > 0 && fs.existsSync(p) ? p : null);

export function findChrome() {
  const fromEnv = existing(process.env.CHROME_PATH);
  if (fromEnv) return fromEnv;
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const c of candidates) { const hit = existing(c); if (hit) return hit; }
  return null;
}

// A fresh profile dir under the long-form temp path: Chrome refuses an 8.3 short --user-data-dir
// (for example C:\Users\RUNNER~1\...) by exiting silently, so resolve the real temp dir first.
export function chromeProfileDir(name) {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `ca-${name}-profile-`));
}

// Never throttle timers or animation frames: CI runners (Windows, macOS) can treat the headless
// window as backgrounded, and the dashboards' step effects and polls then never fire.
const noThrottle = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
export const chromeFlags = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', ...noThrottle] : noThrottle;
