// A long review must not consume the next fix phase's no-progress allowance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fixclock-')));
const repo = path.join(tmp, 'work');
fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
fs.copyFileSync(path.join(root, 'checks/lib/fake-codearts.cjs'), path.join(repo, 'serve'));
fs.writeFileSync(path.join(repo, 'fake-script.json'), JSON.stringify(['steps:1', 'wait:4000+noise:1']));
fs.writeFileSync(path.join(repo, 'fake-review.json'), JSON.stringify([
  ['Previous review findings', '1. Fixed\nVERDICT: ready'],
  ['VERDICT', '1. Finding\nVERDICT: needs fixes'],
]));
fs.writeFileSync(path.join(repo, '.gitignore'), 'fake-*.log\n');
fs.writeFileSync(path.join(repo, 'tasks/work.md'), '1. Write page1.html and commit.\nCHECK: node -e 0\n');
fs.writeFileSync(path.join(tmp, 'settings.json'), '{"security":{"trustedFolders":[]}}');
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q'); git('add', '-A');
git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture');
const env = {
  ...process.env, CA_REGISTRY: path.join(tmp, 'registry'),
  CA_SETTINGS: path.join(tmp, 'settings.json'), CA_DASH: '0',
  CODEARTS_EXE: process.execPath, CODEARTS_CLI_AK: 'fake', CODEARTS_CLI_SK: 'fake',
  MAAS_API_KEY: 'fixture-only', STEP_REVIEW: '0', NO_REVIEW: '0', THINK_S: '0',
  NO_COMMIT_S: '10', FAKE_REVIEW_MS: '12000', LANE_TIMEOUT: '90', CA_TOOL_PROFILE: 'full',
};
const ca = (...args) => spawnSync(process.execPath, [path.join(root, 'runner/ca.mjs'), ...args], {
  cwd: repo, env, encoding: 'utf8', timeout: 60000,
});
try {
  assert.equal(ca('lane', repo, 'work', '--detach').status, 0);
  const result = ca('wait', 'work--work', '--timeout', '50', '--quiet');
  assert.equal(result.status, 0, 'an actively progressing fix must not inherit review time: ' + result.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(repo, 'tasks/work.lane/state.json'), 'utf8'));
  assert.equal(state.result, 'done');
  assert.equal(state.verdict, 'ready');
  assert.equal(state.reviewRounds.length, 2, 'the full independent review and fix review both ran');
  console.log('PASS long review does not generate a false no-progress alert in a fresh fix phase');
} finally {
  ca('stop', 'work--work');
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (path.relative(os.tmpdir(), tmp).startsWith('ca-fixclock-')) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
