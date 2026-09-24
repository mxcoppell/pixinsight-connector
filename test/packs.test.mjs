import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, mergeCatalogs, isFilesystemSpec } from '../src/packs.mjs';
import { fixture, fixtureSource, tmpHomeContaining, coreWith, coreHandlerFor, packToolsFrom, packHandlerFor } from './helpers.mjs';

test('loads a pack from PIXINSIGHT_CONNECTOR_PACKS and surfaces its tools', async () => {
  const { packs, tools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-ok') }, log() {} });
  assert.equal(packs.length, 1);
  assert.equal(packs[0].status, 'loaded');
  assert.equal(packs[0].toolCount, 1);
  assert.ok(tools.some((t) => t.name === 'fixture_stretch'));
});

test('accepts several packs, comma-separated', async () => {
  const { packs } = await loadPacks({
    env: { PIXINSIGHT_CONNECTOR_PACKS: `${fixture('pack-ok')},${fixture('pack-collides')}` }, log() {} });
  assert.equal(packs.filter((p) => p.status === 'loaded').length, 2);
});

test('no PIXINSIGHT_CONNECTOR_PACKS means no packs: an old ~/.pixinsight-mcp/packs/ folder is not read', async () => {
  const home = await tmpHomeContaining('packs/mypack', fixtureSource('pack-ok'));
  for (const env of [{}, { PIXINSIGHT_CONNECTOR_PACKS: '' }, { PIXINSIGHT_CONNECTOR_PACKS: ' , ' }]) {
    const { packs, tools } = await loadPacks({ env, homeDir: home, log() {} });
    assert.deepEqual(packs, []);
    assert.deepEqual(tools, []);
  }
});

test('~ in PIXINSIGHT_CONNECTOR_PACKS expands against the injected home directory', async () => {
  const home = await tmpHomeContaining('packs/mypack', fixtureSource('pack-ok'));
  const { packs } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: '~/.pixinsight-mcp/packs/mypack' }, homeDir: home, log() {} });
  assert.equal(packs[0].status, 'loaded', packs[0].reason);
});

test('an unsupported apiVersion is skipped with a reason, not loaded', async () => {
  const warned = [];
  const { packs, tools } = await loadPacks({
    env: { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-badversion') }, log: (m) => warned.push(m) });
  assert.equal(packs[0].status, 'skipped');
  assert.match(packs[0].reason, /apiVersion/);
  assert.equal(tools.length, 0);
  assert.ok(warned.some((w) => /apiVersion/.test(w)));
});

test('a pack that throws on import does not take the server down, and the others still load', async () => {
  const { packs, tools } = await loadPacks({
    env: { PIXINSIGHT_CONNECTOR_PACKS: `${fixture('pack-throws')},${fixture('pack-ok')}` }, log() {} });
  assert.equal(packs.find((p) => /throws/.test(p.source)).status, 'skipped');
  assert.ok(tools.some((t) => t.name === 'fixture_stretch'), 'a good pack must still load');
});

// NOTE: packToolsFrom() is async (it dynamically imports the fixture module), so it must be
// awaited before being handed to mergeCatalogs() -- otherwise packTools would be a pending
// Promise, not an array. The brief's literal test bodies omitted the `async`/`await` for this;
// fixed here (that omission would otherwise throw "packTools is not iterable" or a similar
// TypeError, never actually exercising mergeCatalogs).
test('a pack may shadow a core tool, and the shadowing is reported', async () => {
  const merged = mergeCatalogs({
    core: coreWith(['run_bxt', 'resume_bridge']),
    packTools: await packToolsFrom('pack-collides'),
    log() {},
  });
  assert.deepEqual(merged.shadowed, ['run_bxt']);
  assert.equal(merged.handlers.get('run_bxt'), packHandlerFor('run_bxt'));
});

test('a reserved tool cannot be shadowed — the core one survives', async () => {
  const warned = [];
  const merged = mergeCatalogs({
    core: coreWith(['run_bxt', 'resume_bridge']),
    packTools: await packToolsFrom('pack-collides'),
    log: (m) => warned.push(m),
  });
  assert.equal(merged.handlers.get('resume_bridge'), coreHandlerFor('resume_bridge'));
  assert.ok(warned.some((w) => /resume_bridge.*reserved/i.test(w)));
});

test('a malformed tool in an otherwise valid pack is rejected individually', async () => {
  const { tools } = await loadPacks({ env: {}, log() {}, importer: async () => ({
    apiVersion: 1, name: 'half-bad', version: '1.0.0',
    tools: [
      { name: 'Bad-Name', description: 'x', inputSchema: { type: 'object' }, handler: async () => ({}) },
      { name: 'good_tool', description: 'A valid fixture tool used by the loader tests.',
        inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: '' }) },
    ],
  }), packSpecs: ['fake'] });
  assert.deepEqual(tools.map((t) => t.name), ['good_tool']);
});

// --- Fix round 1: specifiers, symlinked pack dirs, collisions, malformed pack modules ---

test('a spec is a filesystem path only if absolute, ./ or ~ relative, or a drive/UNC path on win32', () => {
  for (const s of ['/opt/packs/a', './a', '../a', '~', '~/a']) assert.equal(isFilesystemSpec(s, 'darwin'), true, s);
  for (const s of ['C:\\packs\\a', 'C:/packs/a', '\\\\server\\share\\a', '~\\a', './a']) assert.equal(isFilesystemSpec(s, 'win32'), true, s);
  for (const s of ['@scope/pack', 'pkg/sub', 'pkg', 'astro-extra']) {
    assert.equal(isFilesystemSpec(s, 'darwin'), false, s);
    assert.equal(isFilesystemSpec(s, 'win32'), false, s);
  }
});

// Plants a package under <home>/<relDir>/node_modules/<pkgName>, its index.mjs copied from pack-ok.
async function homeWithPackage(relDir, pkgName) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pixi-home-'));
  const dir = path.join(home, relDir, 'node_modules', ...pkgName.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0', type: 'module', exports: './index.mjs' }));
  await writeFile(path.join(dir, 'index.mjs'), await fixtureSource('pack-ok'));
  return home;
}

test('a package name is refused with the fix: packs load only from paths, so nothing resolves from a per-user folder', async () => {
  const home = await homeWithPackage('.pixinsight-mcp', '@astro/extra-pack');
  for (const spec of ['@astro/extra-pack', 'astro-extra']) {
    const { packs } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: spec }, homeDir: home, cwd: home, log() {} });
    assert.equal(packs[0].status, 'skipped', spec);
    assert.match(packs[0].reason, /not a path/);
    assert.match(packs[0].reason, new RegExp(`node_modules/${spec}`));
  }
});

test('an installed npm package loads by the path to its folder', async () => {
  const home = await homeWithPackage('somewhere', '@astro/extra-pack');
  const dir = path.join(home, 'somewhere', 'node_modules', '@astro', 'extra-pack');
  const { packs, tools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: dir }, homeDir: home, log() {} });
  assert.equal(packs[0].status, 'loaded', packs[0].reason);
  assert.ok(tools.some((t) => t.name === 'fixture_stretch'));
});

const tool = (name, handler = async () => ({ text: name })) =>
  ({ name, description: 'A fixture tool used by the collision tests.', inputSchema: { type: 'object' }, handler });

test('two packs providing the same tool: the later one wins, and the collision is logged', async () => {
  const first = tool('dup_tool');
  const second = tool('dup_tool');
  const mods = { a: { apiVersion: 1, name: 'a', version: '1.0.0', tools: [first] },
    b: { apiVersion: 1, name: 'b', version: '1.0.0', tools: [second] } };
  const warned = [];
  const { tools } = await loadPacks({ packSpecs: ['a', 'b'], importer: async (s) => mods[s], log: (m) => warned.push(m) });
  assert.equal(tools.filter((t) => t.name === 'dup_tool').length, 1);
  assert.equal(tools.find((t) => t.name === 'dup_tool').handler, second.handler);
  assert.ok(warned.some((w) => /dup_tool/.test(w) && /"a"/.test(w) && /"b"/.test(w)), warned.join('\n'));
});

test('mergeCatalogs reports a shadowed core tool once even if several pack tools shadow it', () => {
  const last = tool('run_bxt');
  const merged = mergeCatalogs({ core: coreWith(['run_bxt']), packTools: [tool('run_bxt'), last], log() {} });
  assert.deepEqual(merged.shadowed, ['run_bxt']);
  assert.equal(merged.handlers.get('run_bxt'), last.handler);
  assert.equal(merged.definitions.filter((d) => d.name === 'run_bxt').length, 1);
});

test('a pack with no tools array, or no valid tools, is skipped with a reason', async () => {
  const mods = {
    none: { apiVersion: 1, name: 'none', version: '1.0.0' },
    notarray: { apiVersion: 1, name: 'notarray', version: '1.0.0', tools: { a: 1 } },
    empty: { apiVersion: 1, name: 'empty', version: '1.0.0', tools: [] },
    allbad: { apiVersion: 1, name: 'allbad', version: '1.0.0', tools: [{ name: 'Bad-Name' }] },
  };
  const { packs } = await loadPacks({ packSpecs: Object.keys(mods), importer: async (s) => mods[s], log() {} });
  for (const p of packs) {
    assert.equal(p.status, 'skipped', p.source);
    assert.match(p.reason, /tools/, p.source);
  }
});

test('a pack missing name/version still loads, with a warning that names its source', async () => {
  const warned = [];
  const { packs } = await loadPacks({ packSpecs: ['/packs/anon'], log: (m) => warned.push(m),
    importer: async () => ({ apiVersion: 1, tools: [tool('anon_tool')] }) });
  assert.equal(packs[0].status, 'loaded');
  assert.ok(warned.some((w) => /\/packs\/anon/.test(w) && /name/.test(w) && /version/.test(w)), warned.join('\n'));
});

// CONTRIBUTING.md's "Developing a pack" section shows a worked example; it must stay exactly the
// pack-ok fixture, which the tests above really load (via PIXINSIGHT_CONNECTOR_PACKS), so the documented
// pack is one the loader provably accepts.
test('CONTRIBUTING.md\'s worked pack example is exactly test/fixtures/pack-ok/index.mjs', async () => {
  const lf = (t) => t.replace(/\r\n/g, '\n');
  const doc = lf(await readFile('CONTRIBUTING.md', 'utf8'));
  const m = doc.match(/<!-- pack-example: test\/fixtures\/pack-ok\/index\.mjs -->\n```js\n([\s\S]*?)```/);
  assert.ok(m, 'CONTRIBUTING.md must carry the marked pack example block');
  assert.equal(m[1], lf(await fixtureSource('pack-ok')));
});
