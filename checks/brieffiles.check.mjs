import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { briefWarningsFor } from '../runner/common.mjs';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-brieffiles-')));
try {
  fs.mkdirSync(path.join(tmp, 'tasks')); fs.mkdirSync(path.join(tmp, 'checks'));
  fs.writeFileSync(path.join(tmp, 'README.md'), 'fixture');
  for (const args of [['init', '-q'], ['add', 'README.md'], ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  }
  fs.writeFileSync(path.join(tmp, 'tasks/work.md'), '1. Implement the feature.\nCHECK: node checks/new.check.mjs\n');
  const checkFile = path.join(tmp, 'checks/new.check.mjs');
  fs.writeFileSync(checkFile, 'console.log("PASS");');
  assert.ok(!briefWarningsFor(tmp, 'work').some(w => w.kind === 'missing-check-file'), 'an existing untracked contract is not a missing file');
  fs.unlinkSync(checkFile);
  assert.ok(briefWarningsFor(tmp, 'work').some(w => w.kind === 'missing-check-file'), 'a truly absent contract still warns');
  console.log('PASS brief preflight distinguishes an untracked contract from a missing file');
} finally {
  const target = path.resolve(tmp), base = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(base)) throw Error('unsafe cleanup path');
  fs.rmSync(target, { recursive: true, force: true });
}
