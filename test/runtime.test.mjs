// materializeWatcher (src/runtime.mjs): the watcher script is written into the target, one per
// target and machine, with that target's bridge dir baked in. In-memory fs; nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { materializeWatcher, watcherPathOf, spaceInPathNote } from '../src/runtime.mjs';
import { fakeFs } from './helpers.mjs';

const TEMPLATE = await readFile(new URL('../pjsr/watcher.template.js', import.meta.url), 'utf8');

test('the script goes to <state>/watcher/<version>/<machine-id>/watcher.js, beside the bridge dir it serves', () => {
  const state = path.join(path.sep, 'astro', 'M31', 'agentic');
  assert.equal(watcherPathOf(path.join(state, 'bridge', 'rig'), '1.1.0'), path.join(state, 'watcher', '1.1.0', 'rig', 'watcher.js'));
});

test('substitutes the ImageSolver path and bakes in the bridge dir as a JSON string literal', async () => {
  const h = fakeFs({ bridgeDir: path.join(path.sep, 'x', 'My "Target"', 'agentic', 'bridge', 'rig') });
  const { path: p, action } = await materializeWatcher(h);
  assert.equal(action, 'created');
  assert.equal(p, watcherPathOf(h.bridgeDir, h.version));
  const body = h.files.get(p);
  assert.match(body, /#include "\/Applications\/PixInsight\/src\/scripts\/ImageSolver\/ImageSolver\.js"/);
  const dir = vm.runInNewContext(body.split('\n')[1] + '; BRIDGE_DIR');
  assert.equal(dir, h.bridgeDir.replace(/\\/g, '/'), 'quotes and spaces survive as one string');
});

test('emits forward slashes for a Windows ImageSolver path and bridge dir — a backslash is an escape in PJSR', async () => {
  const h = fakeFs({
    platform: { imageSolverPath: 'C:\\Program Files\\PixInsight\\src\\scripts\\ImageSolver\\ImageSolver.js' },
    bridgeDir: 'C:\\Astro\\M31 rgb\\agentic\\bridge\\rig',
  });
  const { path: p } = await materializeWatcher(h);
  const body = h.files.get(p);
  assert.ok(!body.includes('\\'), body);
  assert.match(body, /"C:\/Astro\/M31 rgb\/agentic\/bridge\/rig"/);
});

test('a backslash in a POSIX folder name is kept: the baked-in bridge dir is the real one', async () => {
  const bridgeDir = '/t/back\\slash/agentic/bridge/rig';
  const h = fakeFs({ bridgeDir });
  const { path: p } = await materializeWatcher(h);
  const dir = vm.runInNewContext(h.files.get(p).split('\n')[1] + '; BRIDGE_DIR');
  assert.equal(dir, bridgeDir);
});

test('the real template compiles with both tokens substituted (the #directives stripped)', async () => {
  const h = fakeFs({ template: TEMPLATE });
  const { path: p } = await materializeWatcher(h);
  const body = h.files.get(p);
  assert.doesNotMatch(body, /@@[A-Z]+@@/);
  new vm.Script(body.replace(/^#.*$/gm, ''), { filename: 'watcher.js' });
});

test('is idempotent — identical content is reused, not rewritten', async () => {
  const h = fakeFs({});
  assert.equal((await materializeWatcher(h)).action, 'created');
  assert.equal((await materializeWatcher(h)).action, 'reused');
  assert.equal(h.writeCount, 1);
});

test('a version bump writes a new directory rather than reusing a stale watcher', async () => {
  const h = fakeFs({});
  const a = await materializeWatcher({ ...h, version: '1.2.3' });
  const b = await materializeWatcher({ ...h, version: '1.3.0' });
  assert.notEqual(a.path, b.path);
});

test('two machines sharing one target each get their own script, each serving its own subdir', async () => {
  const state = path.join(path.sep, 'nas', 'M31', 'agentic');
  const h = fakeFs({});
  const a = await materializeWatcher({ ...h, bridgeDir: path.join(state, 'bridge', 'mac') });
  const b = await materializeWatcher({ ...h, bridgeDir: path.join(state, 'bridge', 'pc') });
  assert.notEqual(a.path, b.path);
  assert.match(h.files.get(a.path), /bridge\/mac"/);
  assert.match(h.files.get(b.path), /bridge\/pc"/);
});

test('warns when ImageSolver is missing: the watcher #includes it and cannot compile without it', async () => {
  const { warnings } = await materializeWatcher(fakeFs({ imageSolverExists: false }));
  assert.ok(warnings.some((w) => /ImageSolver not found/.test(w) && /PIXINSIGHT_DIR/.test(w)), warnings.join('\n'));
});

test('no warning at all when ImageSolver exists, whatever the path', async () => {
  const { warnings } = await materializeWatcher(fakeFs({ bridgeDir: path.join(path.sep, 'My Target', 'agentic', 'bridge', 'rig') }));
  assert.deepEqual(warnings, []);
});

test('writes atomically — a temp file then a rename, never a partial watcher', async () => {
  const h = fakeFs({});
  await materializeWatcher(h);
  assert.match(h.ops.join(' '), /write .*\.tmp .*rename/);
});

test('a write error propagates: there is no fallback location outside the target', async () => {
  const h = fakeFs({});
  h.mkdir = async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  await assert.rejects(materializeWatcher(h), (e) => e.code === 'EACCES');
});

test('spaceInPathNote: a path with a space is verified on macOS only', () => {
  assert.equal(spaceInPathNote('darwin', '/Volumes/x/My Target'), null);
  assert.equal(spaceInPathNote('linux', '/home/u/M31'), null);
  for (const os of ['win32', 'linux']) {
    const note = spaceInPathNote(os, '/data/My Target');
    assert.match(note, /space/);
    assert.match(note, /unverified/);
  }
});
