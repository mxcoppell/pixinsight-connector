import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge } from './fake-bridge.mjs';
import { fakeCtx, fakePlatform, fakeWs } from './helpers.mjs';
import { buildApi } from '../src/api.mjs';

test('exposes exactly the documented v1 surface — no more, no less', () => {
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace: fakeWs(), log() {}, version: '1.0.0' });
  assert.deepEqual(Object.keys(api).sort(),
    ['connectorVersion', 'listImages', 'log', 'pjsr', 'platform', 'runProcess', 'stats', 'workspace'].sort());
});

test('runProcess throws when the process declines rather than reporting success', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'the process did not run' } }] });
  const api = buildApi({ ctx, platform: fakePlatform(), workspace: fakeWs(), log() {}, version: '1.0.0' });
  await assert.rejects(() => api.runProcess('SCNR', { amount: 0.5 }, 'RGB'), /did not run/);
});

test('platform is not mutable by a pack', () => {
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace: fakeWs(), log() {}, version: '1.0.0' });
  assert.throws(() => { api.platform.piBin = '/evil'; });
});

test('log writes to stderr and never to stdout', () => {
  const lines = [];
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace: fakeWs(),
                         log: (m) => lines.push(m), version: '1.0.0' });
  api.log('hello');
  assert.deepEqual(lines, ['hello']);
});

test('the api object itself is frozen: a pack cannot swap out pjsr (or anything) for every other tool', () => {
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace: fakeWs(), log() {}, version: '1.0.0' });
  const original = api.pjsr;
  assert.ok(Object.isFrozen(api));
  assert.throws(() => { api.pjsr = async () => 'hijacked'; }, TypeError);
  assert.throws(() => { api.extra = 1; }, TypeError);
  assert.equal(api.pjsr, original);
});

test('api.workspace has the shape { dir, scratchDir, outputDir } but follows a workspace switch', async () => {
  const { createWorkspace } = await import('../src/workspace.mjs');
  const path = await import('node:path');
  const fs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
  const workspace = createWorkspace({ cwd: path.resolve('/a'), env: {}, homeDir: path.resolve('/home/u'), platform: 'linux', fs });
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace, log() {}, version: '1.0.0' });
  assert.deepEqual(Object.keys(api.workspace).sort(), ['dir', 'outputDir', 'scratchDir']);
  assert.equal(api.workspace.dir, path.resolve('/a'));
  await workspace.set(path.resolve('/b'));
  assert.equal(api.workspace.dir, path.resolve('/b'));
  assert.equal(api.workspace.scratchDir, path.join(path.resolve('/b'), 'agentic', 'scratch'));
  assert.equal(api.workspace.outputDir, path.join(path.resolve('/b'), 'output'));
  assert.ok(Object.isFrozen(api.workspace));
  assert.throws(() => { api.workspace.dir = '/evil'; }, TypeError);
});

test('api.workspace throws the WorkspaceError naming the fix while the workspace is unusable', async () => {
  const { createWorkspace } = await import('../src/workspace.mjs');
  const path = await import('node:path');
  const fs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
  const workspace = createWorkspace({ cwd: path.resolve('/home/u'), env: {}, homeDir: path.resolve('/home/u'), platform: 'linux', fs });
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace, log() {}, version: '1.0.0' });
  assert.throws(() => api.workspace.scratchDir, { name: 'WorkspaceError', message: /call set_workspace/ });
  assert.throws(() => api.workspace.dir, { name: 'WorkspaceError' });
  assert.throws(() => api.workspace.outputDir, { name: 'WorkspaceError' });
});

test('a plain { dir, scratchDir, outputDir } workspace still works (tests and embedders)', () => {
  const api = buildApi({ ctx: fakeCtx(), platform: fakePlatform(), workspace: fakeWs(), log() {}, version: '1.0.0' });
  assert.equal(api.workspace.dir, '/tmp/ws');
  assert.equal(api.workspace.scratchDir, '/tmp/ws/agentic/scratch');
  assert.equal(api.workspace.outputDir, '/tmp/ws/output');
});
