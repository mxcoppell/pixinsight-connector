// A pack laid out the way a published one is (index.mjs re-exporting tools from its own tools/ and
// lib/ modules), loaded the way serve() loads it: loadPacks() with PIXINSIGHT_CONNECTOR_PACKS, composed by
// assembleCatalog(), served by createServer(). test/server.test.mjs covers a one-file pack; this
// covers the loader resolving a pack's own relative imports, a relative `./` spec, and a pack
// handler reaching PixInsight through api.pjsr over MCP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, assembleCatalog } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { loadPacks } from '../src/packs.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { fixture } from './helpers.mjs';

const PACK_DIR = fixture('pack-multi');
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_TOOLS = ['fixture_console_echo', 'fixture_note'];

test('a multi-module pack loads, and assembleCatalog serves core + the server-defined tools + every pack tool', async () => {
  const logs = [];
  const { packs, tools: packTools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: PACK_DIR }, log: (m) => logs.push(m) });
  assert.equal(packs.length, 1);
  assert.deepEqual(
    { name: packs[0].name, version: packs[0].version, apiVersion: packs[0].apiVersion, status: packs[0].status, toolCount: packs[0].toolCount },
    { name: 'multi', version: '0.1.0', apiVersion: 1, status: 'loaded', toolCount: PACK_TOOLS.length },
  );
  assert.deepEqual(logs, [], 'no tool rejected, no missing name/version');
  assert.deepEqual(packTools.map((t) => t.name).sort(), PACK_TOOLS);

  const core = await buildCoreCatalog();
  const mergeLogs = [];
  const catalog = assembleCatalog({ core, packs, packTools, resetBridge: () => {}, log: (m) => mergeLogs.push(m) });
  assert.deepEqual(catalog.shadowed, [], 'no pack tool replaces a core tool');
  assert.deepEqual(mergeLogs, [], 'no reserved-name rejection or collision');
  assert.equal(catalog.definitions.length, core.definitions.length + 4 + PACK_TOOLS.length);
  const names = new Set(catalog.definitions.map((d) => d.name));
  for (const n of [...core.definitions.map((d) => d.name), 'workspace_info', 'set_workspace', 'resume_bridge', 'list_packs', ...PACK_TOOLS]) {
    assert.ok(names.has(n), `${n} is served`);
  }
});

test('a relative ./ spec in PIXINSIGHT_CONNECTOR_PACKS loads from the working directory', async () => {
  const { packs } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: './test/fixtures/pack-multi' }, cwd: REPO_ROOT });
  assert.equal(packs[0].status, 'loaded', packs[0].reason);
  assert.equal(packs[0].toolCount, PACK_TOOLS.length);
});

test('a served pack tool reaches PixInsight through api.pjsr over MCP, and list_packs reports the pack', async () => {
  const { packs, tools: packTools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: PACK_DIR } });
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs, packTools, resetBridge: () => {} });
  const { ctx, emitted } = createFakeBridge({ replies: ['hello from PixInsight'] });
  const server = createServer({ catalog, api: apiFrom(ctx) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === 'fixture_console_echo'));
    const out = await client.callTool({ name: 'fixture_console_echo', arguments: { message: 'hello' } });
    assert.ok(!out.isError, out.content[0].text);
    assert.equal(out.content[0].text, 'hello from PixInsight');
    assert.deepEqual(emitted, ['console.writeln("hello");']);
    const info = JSON.parse((await client.callTool({ name: 'list_packs', arguments: {} })).content[0].text);
    assert.equal(info.packs.find((p) => p.name === 'multi')?.toolCount, PACK_TOOLS.length);
  } finally {
    await client.close();
    await server.close();
  }
});
