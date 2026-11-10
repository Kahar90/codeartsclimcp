import { spawn } from 'node:child_process';
import http from 'node:http';
import { CA_ENTRY, lanes } from './common.mjs';

// ---------- dashboard ----------
// Lanes start the dashboard on demand (detached, survives the lane). CA_DASH=0 turns it off.
export async function ensureDash() {
  if (process.env.CA_DASH === '0') return null;
  const port = Number(process.env.CA_DASH_PORT || 4777); const url = `http://127.0.0.1:${port}`;
  try { if ((await fetch(url + '/api/lanes', { signal: AbortSignal.timeout(1500) })).ok) return url; } catch {}
  try { spawn(process.execPath, [CA_ENTRY, 'dash', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return url; } catch { return null; }
}
