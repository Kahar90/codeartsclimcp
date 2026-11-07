// Ensure a folder is covered by CodeArts folder trust (prefix match on trustedFolders).
// usage: node trust.mjs <windows-path>   adds that folder itself if nothing covers it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const target = path.win32.resolve(process.argv[2]);
const file = process.env.CA_SETTINGS || path.join(os.homedir(), '.codeartsdoer', 'cli-data', 'settings.json');
const s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
s.security ??= {}; s.security.folderTrust ??= { enabled: true };
const list = Array.isArray(s.security.trustedFolders) ? s.security.trustedFolders : [];
const lower = (p) => p.toLowerCase();
if (list.some((f) => lower(target) === lower(f) || lower(target).startsWith(lower(f) + '\\'))) process.exit(0);
const add = target;
s.security.trustedFolders = [...list, add];
writeFileSync(file, JSON.stringify(s, null, 2));
console.log(`codearts: trusted ${add}`);
