import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, resumeBridgeTool, buildRuntimeApi, assembleCatalog, resolveServePlatform } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { createBridge, BridgeAbortError, BridgeCrashError } from '../src/bridge.mjs';
import { resolvePlatform } from '../src/platform.mjs';
import { createProcessProbe } from '../src/process-probe.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { loadPacks } from '../src/packs.mjs';
import { createCallLog } from '../src/call-log.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { fixture } from './helpers.mjs';

// Never the real home: the fakes below inject the machine id, and nothing here sends a real command.

// A real buildRuntimeApi(), the same function serve() calls, wired with fully injected/fake
// platform+probe+workspace inputs so it needs no real PixInsight install or real cwd -- unlike
// the createFakeBridge()/apiFrom() tests above, `api.pjsr`/`api.listImages` here go through the
// REAL src/bridge.mjs createBridge() the moment anything calls them (lazily). Tests using this
// must therefore only dispatch tools that never touch pjsr/listImages (workspace_info,
// pixinsight_info, resume_bridge, or bare tools/list) -- dispatching a PixInsight-touching tool
// here would attempt a real bridge IPC round trip.
function realRuntimeApi() {
  const platform = resolvePlatform({ env: { PIXINSIGHT_BIN: '/fake/PixInsight' }, platform: 'darwin', existsSync: () => true, homeDir: '/fake/home' });
  const probe = createProcessProbe({ platform: 'darwin', exec: async () => '' });
  const workspace = trustedWorkspace('/fake/ws');
  return { ...buildRuntimeApi({ platform, probe, workspace, log: () => {}, connectorVersion: '0.0.0-test' }), workspace };
}

// A workspace at `dir` over an injected filesystem where every folder exists and is writable, so a
// test never depends on the real disk or home directory.
function trustedWorkspace(dir) {
  const fs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
  return createWorkspace({ cwd: path.resolve(dir), env: {}, homeDir: path.resolve('/fake/home'), platform: 'linux', fs });
}

// Captures the tools/call dispatch function createServer() registers, so the tests below can
// invoke it directly with a hand-built request/extra -- exercising the keepalive timer and the
// console-error/abort/crash mapping fast and precisely, without a full client/transport round trip.
// `takeConsoleErrors` is a separate, optional third argument -- since the buildApi/server.mjs
// reconciliation (Task 12), it no longer lives on `api` (a pure Pack API v1 object never carries
// dispatch-internal bookkeeping); createServer() reads it from its own third constructor argument.
function captureDispatch(catalog, api, takeConsoleErrors) {
  let dispatch;
  const original = Server.prototype.setRequestHandler;
  Server.prototype.setRequestHandler = function (schema, handler) {
    if (schema === CallToolRequestSchema) dispatch = handler;
    return original.call(this, schema, handler);
  };
  try {
    createServer({ catalog, api, takeConsoleErrors });
  } finally {
    Server.prototype.setRequestHandler = original;
  }
  return dispatch;
}

// Spies every fs method that would indicate a write (sync, callback and fs/promises) and every
// child_process launcher, by monkey-patching the real (shared, cached) builtin module objects -- so
// a call from ANY module this test exercises (server.mjs, bridge.mjs, runtime.mjs, ...) is caught,
// not just a call made directly from this file. Patching the CommonJS objects alone does not reach
// a module that imported a builtin by NAME (`import { spawn } from 'node:child_process'`): its
// ESM binding is a copy until module.syncBuiltinESMExports() runs, so that is called after
// patching and again after restoring. The canary test below proves the spy sees those calls.
function spyOnWritesAndSpawn() {
  const fsWrites = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'renameSync', 'copyFileSync',
    'writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir', 'rename', 'copyFile'];
  const fspWrites = ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir', 'rename', 'copyFile'];
  const launchers = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const calls = [];
  const restorers = [];
  const patch = (obj, name) => {
    const original = obj[name];
    obj[name] = function (...args) { calls.push(name); return original.apply(this, args); };
    restorers.push(() => { obj[name] = original; });
  };
  for (const name of fsWrites) patch(fs, name);
  for (const name of fspWrites) patch(fs.promises, name);
  for (const name of launchers) patch(childProcess, name);
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      restorers.forEach((r) => r());
      syncBuiltinESMExports();
    },
  };
}

// Lets fire-and-forget work started during initialize/tools/list (an eager materializeWatcher(),
// say, whose first write follows two async reads) reach its first write while the spy still
// listens, instead of landing after restore() and passing unseen.
const settle = () => new Promise((r) => setTimeout(r, 200));

// The spy's own canary: a module that imports its builtins by NAME (as src/bridge.mjs, runtime.mjs
// and process-probe.mjs do) and writes through fs/promises (as materializeWatcher does) must be
// caught. Imported before the spy is installed, the hardest case: its bindings exist already.
test('the write/spawn spy catches named-import spawn/execFile and fs/promises writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pixi-spy-canary-'));
  const modPath = path.join(dir, 'canary.mjs');
  fs.writeFileSync(modPath, [
    "import { spawn, execFile } from 'node:child_process';",
    "import { writeFile, mkdir } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function act(dir) {',
    "  await mkdir(path.join(dir, 'sub'), { recursive: true });",
    "  await writeFile(path.join(dir, 'sub', 'x.txt'), 'x');",
    "  await new Promise((r) => spawn(process.execPath, ['-e', '']).on('exit', r));",
    "  await new Promise((r) => execFile(process.execPath, ['-e', ''], () => r()));",
    '}',
  ].join('\n'));
  const { act } = await import(pathToFileURL(modPath).href);
  const spy = spyOnWritesAndSpawn();
  try {
    await act(dir);
  } finally {
    spy.restore();
  }
  for (const name of ['mkdir', 'writeFile', 'spawn', 'execFile']) {
    assert.ok(spy.calls.includes(name), `spy missed ${name}; recorded ${JSON.stringify(spy.calls)}`);
  }
});

// Merges resume_bridge into the auto-discovered catalog exactly the way serve() does, but with a
// plain spy in place of the real lazy-bridge reset -- this file tests createServer/dispatch, not
// src/bridge.mjs's real construction (that's test/bridge.test.mjs's job).
async function catalogWithResumeBridge(resetBridge = () => {}) {
  const core = await buildCoreCatalog();
  const resumeBridge = resumeBridgeTool(resetBridge);
  return {
    definitions: [...core.definitions, { name: resumeBridge.name, description: resumeBridge.description, inputSchema: resumeBridge.inputSchema }],
    handlers: new Map(core.handlers).set(resumeBridge.name, resumeBridge.handler),
  };
}

test('in-process initialize + tools/list returns >=45 tools, advertises tools capability, and touches no disk and spawns nothing', async () => {
  const spy = spyOnWritesAndSpawn();
  let client;
  let server;
  try {
    const catalog = await catalogWithResumeBridge();
    const { ctx } = createFakeBridge();
    const api = apiFrom(ctx);
    server = createServer({ catalog, api });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools, 'expected capabilities.tools to be advertised');

    const { tools } = await client.listTools();
    assert.ok(tools.length >= 45, `expected >=45 tools, got ${tools.length}`);
    assert.ok(tools.some((t) => t.name === 'resume_bridge'), 'resume_bridge must be reachable via tools/list');
  } finally {
    if (client) await client.close();
    if (server) await server.close();
    await settle();
    spy.restore();
  }

  assert.deepEqual(spy.calls, [], 'initialize + tools/list must not write to disk or spawn a process');
});

test('resume_bridge is dispatchable via tools/call like any other tool and genuinely resets the lazy bridge', async () => {
  let resetCalled = false;
  const catalog = await catalogWithResumeBridge(() => { resetCalled = true; });
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx);
  const server = createServer({ catalog, api });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: 'resume_bridge', arguments: {} });
    assert.equal(resetCalled, true, 'resume_bridge handler must call the closed-over resetBridge');
    assert.match(result.content[0].text, /Bridge reset/);
    assert.notEqual(result.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('an unknown tool name returns an isError result instead of throwing', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx);
  const server = createServer({ catalog, api });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a call naming a view that is not open is rejected before the handler runs (missingViews pre-check)', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx); // listImages() -> [] by default, so any view_id is "not open"
  const server = createServer({ catalog, api });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: 'close_image', arguments: { view_id: 'RGB' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /View not found: view_id="RGB"/);
  } finally {
    await client.close();
    await server.close();
  }
});

// --- Deeper dispatch behaviors, exercised directly against the captured handler ---

test('a console error line is appended to the result without promoting isError', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge({ replies: ['ok'] });
  const api = apiFrom(ctx);
  const dispatch = captureDispatch(catalog, api, () => ['Warning: something minor']);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.notEqual(result.isError, true);
  assert.ok(result.content.some((c) => c.text.includes('Warning: something minor')));
});

test('a console error line matching "*** Error" promotes the result to isError and prepends the warning text', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge({ replies: ['ok'] });
  const api = apiFrom(ctx);
  const dispatch = captureDispatch(catalog, api, () => ['*** Error: PixelMath did not run']);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'PIXINSIGHT REPORTED AN ERROR while running this tool, so the operation may not have been applied (details at the end of this result).');
  assert.ok(result.content.some((c) => c.text.includes('*** Error: PixelMath did not run')));
});

test('a BridgeAbortError thrown by a handler maps to the STOPPED BY USER text, not a generic error', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { pjsr: async () => { throw new BridgeAbortError('user pressed abort'); } });
  const dispatch = captureDispatch(catalog, api);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /STOPPED BY USER/);
  assert.match(result.content[0].text, /resume_bridge only after they tell you to continue/);
});

test('a BridgeCrashError thrown by a handler surfaces its own message, not a hardcoded string', async () => {
  // Regression test: the dispatch catch block used to hardcode "PixInsight is not running (or
  // crashed). Ask the user to start PixInsight, then retry." here, completely ignoring e.message
  // -- so bridge.mjs's real, accurate BridgeCrashError text (e.g. the autostart-failed message
  // added in this same task) never actually reached an MCP client. Whatever the thrown error's
  // message says must now be exactly what the client sees.
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { pjsr: async () => { throw new BridgeCrashError('pgrep found nothing'); } });
  const dispatch = captureDispatch(catalog, api);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'pgrep found nothing');
});

test('the REAL bridge.mjs BridgeCrashError message reaches a real MCP client through the real dispatch path', async () => {
  // Closes the gap the test above leaves: that one proves the dispatch stopped ignoring
  // e.message, using a hand-written BridgeCrashError. This one drives an actual createBridge()
  // (the same code bridge.test.mjs exercises) through a REAL MCP Client/Server round trip, so the
  // exact, current bridge.mjs wording -- not a copy of it that could drift -- is what's asserted.
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixinsight-server-test-'));

  const bridge = createBridge({
    platform: { piBin: '/fake/PixInsight' },
    probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null },
    watcherPath: 'fake-watcher.js',
    log: () => {},
    autoLaunch: true,
    env: { PIXINSIGHT_CONNECTOR_AUTOSTART: '0' }, // decline autostart deterministically -- no real spawn, no wait
    bridgeDir: path.join(root, 'bridge'),
  });

  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { pjsr: (code) => bridge.pjsr(code) });
  const server = createServer({ catalog, api });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: 'run_pjsr', arguments: { code: '1;' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PixInsight could not be started/);
    assert.match(result.content[0].text, /npx -y github:mxcoppell\/pixinsight-connector doctor/);
    assert.match(result.content[0].text, /PIXINSIGHT_BIN/);
    assert.doesNotMatch(result.content[0].text, /ask the user to start PixInsight/i, 'the stale self-start instruction must be gone');
  } finally {
    await client.close();
    await server.close();
  }
});

test('an MCP_ABORTED-tagged error maps to the interrupted-command STOPPED BY USER text', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { pjsr: async () => { throw new Error('MCP_ABORTED: command interrupted'); } });
  const dispatch = captureDispatch(catalog, api);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /STOPPED BY USER: Pause\/Abort interrupted the running command/);
});

test('a progressToken schedules a 10s-interval keepalive notification and stops it once the call finishes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  return (async () => {
    const catalog = await catalogWithResumeBridge();
    const { ctx } = createFakeBridge();
    let resolveHandler;
    const api = apiFrom(ctx, {
      pjsr: () => new Promise((resolve) => { resolveHandler = () => resolve({ status: 'ok', outputs: { consoleOutput: 'ok' }, result: 'ok' }); }),
    });
    const dispatch = captureDispatch(catalog, api);

    const notifications = [];
    const call = dispatch(
      { params: { name: 'run_pjsr', arguments: { code: '1;' }, _meta: { progressToken: 'tok-1' } } },
      { sendNotification: async (n) => { notifications.push(n); } }
    );

    t.mock.timers.tick(10_000);
    await Promise.resolve(); // let the interval's async sendNotification microtask run
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].params.progressToken, 'tok-1');

    t.mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(notifications.length, 2);

    resolveHandler();
    await call;

    // the interval must be cleared once the call settles -- ticking further must not add more
    t.mock.timers.tick(30_000);
    assert.equal(notifications.length, 2, 'keepalive must stop firing after the call finishes');
  })();
});

// --- Regression coverage against the REAL production bridge-construction path ---
//
// Everything above wires createServer() to createFakeBridge()/apiFrom() -- a synthetic double
// that never touches src/bridge.mjs's real createBridge(). That left a real gap: the property
// Step 1 of this task was dispatched to prove (initialize/tools/list touch no disk, spawn
// nothing) was only ever demonstrated against the fake, not against buildRuntimeApi()/serve(),
// which is what an actual MCP client runs through. The tests below close that gap, and pin down
// the fix for a real bug the gap let through: the dispatch wrapper's unconditional
// takeConsoleErrors() calls (both before and after every handler) used to route through
// getBridge(), which lazily constructs a real bridge -- so resume_bridge's handler resetting the
// bridge got silently undone by the wrapper's own post-handler call reconstructing one right
// after, and workspace_info/pixinsight_info (which need zero PixInsight interaction) forced a
// real bridge into existence too. createBridge()'s constructor is the only place in this whole
// call path that invokes the synchronous fs.readdirSync (everything else here uses async
// fs/promises APIs or fs.existsSync), so counting it is a precise proxy for "was a real bridge
// actually constructed" without needing to intercept the createBridge import binding itself.

test('the REAL buildRuntimeApi (production bridge-construction path) also touches no disk and spawns nothing during initialize + tools/list', async () => {
  const spy = spyOnWritesAndSpawn();
  let client;
  let server;
  try {
    const { api, takeConsoleErrors } = realRuntimeApi();
    const catalog = await catalogWithResumeBridge();
    server = createServer({ catalog, api, takeConsoleErrors });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools, 'expected capabilities.tools to be advertised');
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 45, `expected >=45 tools, got ${tools.length}`);
  } finally {
    if (client) await client.close();
    if (server) await server.close();
    await settle();
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], 'the real buildRuntimeApi-backed server must not write to disk or spawn during initialize + tools/list');
});

// The unusable-workspace case (a harness launching from the home directory): the server still starts
// and lists every tool, and neither that nor a refused tool call nor workspace_info writes a file or
// spawns a process. The home directory is a real temp folder, so the check runs on the real disk.
test('with an unusable workspace, initialize + tools/list + refused calls touch no disk and spawn nothing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pixi-home-'));
  const platform = resolvePlatform({ env: { PIXINSIGHT_BIN: '/fake/PixInsight' }, platform: 'darwin', existsSync: () => true, homeDir: '/fake/home' });
  const probe = createProcessProbe({ platform: 'darwin', exec: async () => '' });
  const spy = spyOnWritesAndSpawn();
  let client;
  let server;
  try {
    const workspace = createWorkspace({ cwd: home, env: {}, homeDir: home, platform: process.platform });
    const { api, resetBridge, takeConsoleErrors } = buildRuntimeApi({ platform, probe, workspace, log: () => {}, connectorVersion: '0.0.0-test' });
    const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge, workspace });
    server = createServer({ catalog, api, takeConsoleErrors });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    assert.ok(tools.length >= 45, `expected the full catalog, got ${tools.length}`);
    const pjsr = await client.callTool({ name: 'run_pjsr', arguments: { code: '1;' } });
    assert.equal(pjsr.isError, true);
    assert.match(pjsr.content[0].text, /call set_workspace/);
    const info = JSON.parse((await client.callTool({ name: 'workspace_info', arguments: {} })).content[0].text);
    assert.equal(info.usable, false);
  } finally {
    if (client) await client.close();
    if (server) await server.close();
    await settle();
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], 'an unusable workspace must not lead to a write or a spawn');
});

// The call log is created by the first tool call that needs the workspace, never by initialize or
// tools/list, nor by workspace_info: a usable real workspace with logging on, spied, then a call that
// does create the file.
test('with the call log on, initialize + tools/list write nothing; the first call that needs the workspace creates the log file', async () => {
  const root = fs.realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'pixi-lazylog-')));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const platform = resolvePlatform({ env: { PIXINSIGHT_BIN: '/fake/PixInsight' }, platform: 'darwin', existsSync: () => true, homeDir: '/fake/home' });
  const probe = createProcessProbe({ platform: 'darwin', exec: async () => '' });
  const spy = spyOnWritesAndSpawn();
  let client;
  let server;
  let logsAfterList;
  try {
    const workspace = createWorkspace({ cwd: ws, env: {}, homeDir: path.join(root, 'home'), platform: process.platform });
    const callLog = createCallLog({ workspace, env: {}, log: () => {}, onExit: () => {} });
    const { api, resetBridge } = buildRuntimeApi({ platform, probe, workspace, log: () => {}, connectorVersion: '0.0.0-test', callLog });
    const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge, workspace, callLog });
    server = createServer({ catalog, api, callLog });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 45);
    await settle();
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], 'initialize + tools/list must not create the log');
  logsAfterList = fs.existsSync(path.join(ws, 'agentic'));
  try {
    const before = JSON.parse((await client.callTool({ name: 'workspace_info', arguments: {} })).content[0].text);
    assert.deepEqual(before.log, { state: 'on', file: null, dir: path.join(ws, 'agentic', 'logs') });
    assert.equal(fs.existsSync(path.join(ws, 'agentic')), false, 'workspace_info alone creates no log');
    await client.callTool({ name: 'scan_workspace', arguments: {} });
    const info = JSON.parse((await client.callTool({ name: 'workspace_info', arguments: {} })).content[0].text);
    assert.equal(info.log.state, 'on');
    assert.equal(path.dirname(info.log.file), path.join(ws, 'agentic', 'logs'));
    assert.equal(fs.existsSync(info.log.file), true);
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(logsAfterList, false, 'no state dir before the first call');
});

test('resume_bridge and workspace_info never force the lazy PixInsight bridge into existence (fixes the double-reconstruction bug)', async () => {
  const { api, resetBridge, takeConsoleErrors, workspace } = realRuntimeApi();
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge, workspace });
  const dispatch = captureDispatch(catalog, api, takeConsoleErrors);

  const originalReaddirSync = fs.readdirSync;
  let bridgeConstructions = 0;
  fs.readdirSync = (...args) => { bridgeConstructions++; return originalReaddirSync(...args); };
  try {
    const wsResult = await dispatch({ params: { name: 'workspace_info', arguments: {} } }, { sendNotification: async () => {} });
    assert.notEqual(wsResult.isError, true);
    assert.equal(bridgeConstructions, 0, 'workspace_info must not construct a real bridge');

    const piResult = await dispatch({ params: { name: 'pixinsight_info', arguments: {} } }, { sendNotification: async () => {} });
    assert.notEqual(piResult.isError, true);
    assert.equal(bridgeConstructions, 0, 'pixinsight_info must not construct a real bridge');

    const rbResult = await dispatch({ params: { name: 'resume_bridge', arguments: {} } }, { sendNotification: async () => {} });
    assert.notEqual(rbResult.isError, true);
    assert.match(rbResult.content[0].text, /Bridge reset/);
    assert.equal(bridgeConstructions, 0, 'resume_bridge must not construct a real bridge before, during or after its own handler runs (that would silently undo its own reset)');
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

// --- PixInsight not found: the server still starts (I1) ---
//
// resolvePlatform() throws PlatformError when PixInsight is not at the default path and no override
// is set. serve() used to let that escape before server.connect(), so the harness saw only a closed
// connection and no tools at all, including the ones that never touch PixInsight.

test('an unresolved PixInsight install is held, not thrown: resolveServePlatform returns the error', () => {
  const r = resolveServePlatform({ env: {}, platform: 'win32', existsSync: () => false, homeDir: 'C:\\Users\\u' });
  assert.equal(r.platform, null);
  assert.equal(r.platformError?.name, 'PlatformError');
  assert.match(r.platformError.message, /Could not find a PixInsight installation/);
});

test('resolveServePlatform rethrows anything that is not a PlatformError', () => {
  assert.throws(
    () => resolveServePlatform({ env: {}, platform: 'darwin', existsSync: () => { throw new TypeError('boom'); }, homeDir: '/Users/u' }),
    TypeError
  );
});

test('with PixInsight not found, tools/list works, bridge tools fail with the held message, pixinsight_info reports it', async () => {
  const { platform, platformError } = resolveServePlatform({ env: {}, platform: 'linux', existsSync: () => false, homeDir: '/home/u' });
  const probe = createProcessProbe({ platform: 'linux', listProc: async () => [], readFile: async () => null });
  const workspace = trustedWorkspace('/fake/ws');
  const { api, resetBridge, takeConsoleErrors } = buildRuntimeApi({ platform, platformError, probe, workspace, log: () => {}, connectorVersion: '0.0.0-test' });
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge, workspace });
  const server = createServer({ catalog, api, takeConsoleErrors });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 45, `expected the full catalog, got ${tools.length}`);

    const pjsr = await client.callTool({ name: 'run_pjsr', arguments: { code: '1;' } });
    assert.equal(pjsr.isError, true);
    assert.match(pjsr.content[0].text, /Could not find a PixInsight installation/);

    const viewTool = await client.callTool({ name: 'close_image', arguments: { view_id: 'M31' } });
    assert.equal(viewTool.isError, true, 'the view pre-check needs the bridge too, and must fail the same way');
    assert.match(viewTool.content[0].text, /Could not find a PixInsight installation/);

    const filters = await client.callTool({ name: 'find_filters', arguments: { query: 'Ha' } });
    assert.equal(filters.isError, true, 'find_filters reads the install and must report its absence');
    assert.match(filters.content[0].text, /^Could not find a PixInsight installation/);

    const info = await client.callTool({ name: 'pixinsight_info', arguments: {} });
    assert.equal(info.isError, true, 'pixinsight_info must not look like a healthy install');
    assert.match(info.content[0].text, /Could not find a PixInsight installation/);

    const ws = await client.callTool({ name: 'workspace_info', arguments: {} });
    assert.notEqual(ws.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

// --- M2: one bridge per server, and console errors belong to the call that produced them ---

function fakeBridgeDeps(pjsrFor) {
  const made = { materialized: 0, bridges: 0 };
  return {
    made,
    deps: {
      materializeWatcher: async () => { made.materialized++; return { path: '/fake/watcher.js', warnings: [] }; },
      machineId: () => 'test-machine',
      createBridge: async () => {
        made.bridges++;
        await delay(20);
        return { pjsr: pjsrFor, listImages: async () => [{ id: 'A' }, { id: 'B' }], log() {} };
      },
    },
  };
}

test('two concurrent first calls share one lazily built bridge', async () => {
  const { made, deps } = fakeBridgeDeps(async () => ({ status: 'ok', outputs: { consoleOutput: 'x' } }));
  const { api } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: { dir: '/w', scratchDir: '/w/s' }, log() {}, connectorVersion: '0', deps });
  await Promise.all([api.pjsr('1;'), api.pjsr('2;')]);
  assert.equal(made.bridges, 1);
  assert.equal(made.materialized, 0, 'the watcher is written by the bridge before a launch, not when it is built');
});

test('a failed bridge construction is forgotten, so the next call builds again and succeeds', async () => {
  let calls = 0;
  const deps = {
    machineId: () => 'test-machine',
    createBridge: () => {
      if (++calls === 1) throw new Error('bridge dir not writable');
      return { pjsr: async () => ({ status: 'ok', outputs: { consoleOutput: 'ok' } }), listImages: async () => [], log() {} };
    },
  };
  const { api } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: { dir: '/w', scratchDir: '/w/s' }, log() {}, connectorVersion: '0', deps });
  await assert.rejects(api.pjsr('1;'), /bridge dir not writable/);
  const r = await api.pjsr('2;');
  assert.equal(r.outputs.consoleOutput, 'ok');
  assert.equal(calls, 2);
});

test('a construction abandoned by resetBridge that fails later does not drop the newer bridge', async () => {
  const pending = [];
  const bridge = { pjsr: async () => ({ status: 'ok', outputs: { consoleOutput: 'ok' } }), listImages: async () => [], log() {} };
  const deps = {
    machineId: () => 'test-machine',
    createBridge: () => new Promise((resolve, reject) => pending.push({ resolve: () => resolve(bridge), reject })),
  };
  const { api, resetBridge } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: { dir: '/w', scratchDir: '/w/s' }, log() {}, connectorVersion: '0', deps });
  const first = api.pjsr('1;');
  await delay(5);
  resetBridge(); // resume_bridge while the first construction is still running
  const second = api.pjsr('2;');
  await delay(5);
  assert.equal(pending.length, 2);
  pending[0].reject(new Error('stale construction failed'));
  await assert.rejects(first, /stale construction failed/);
  pending[1].resolve();
  await second;
  const third = api.pjsr('3;');
  await delay(5);
  const built = pending.length;
  pending.slice(2).forEach((p) => p.resolve()); // never leave a call hanging
  await third;
  assert.equal(built, 2, 'the newer bridge must be reused, not rebuilt');
});

test('a PixInsight console error is reported on the call that produced it, not on a concurrent one', async () => {
  const { deps } = fakeBridgeDeps(async (code) => {
    if (code.includes('slow')) {
      await delay(30);
      return { status: 'ok', outputs: { consoleOutput: 'done', consoleErrors: ['*** Error: slow did not run'] } };
    }
    return { status: 'ok', outputs: { consoleOutput: 'done', consoleErrors: [] } };
  });
  const { api, takeConsoleErrors } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: { dir: '/w', scratchDir: '/w/s' }, log() {}, connectorVersion: '0', deps });
  const run = { name: 'run_code', description: 'test', inputSchema: { type: 'object', properties: { code: { type: 'string' } } }, handler: async (a, input) => ({ text: (await a.pjsr(input.code)).outputs.consoleOutput }) };
  const catalog = { definitions: [run], handlers: new Map([[run.name, run.handler]]) };
  const dispatch = captureDispatch(catalog, api, takeConsoleErrors);
  const extra = { sendNotification: async () => {} };
  const [slow, fast] = await Promise.all([
    dispatch({ params: { name: 'run_code', arguments: { code: 'slow' } } }, extra),
    (async () => { await delay(5); return dispatch({ params: { name: 'run_code', arguments: { code: 'fast' } } }, extra); })(),
  ]);
  assert.equal(slow.isError, true, 'the slow call printed the error');
  assert.notEqual(fast.isError, true, 'the fast call printed nothing');
  assert.ok(!fast.content.some((c) => /slow did not run/.test(c.text)));
});

// --- I8: the view pre-check covers only argument names core tools use ---

// Every string argument with one of these names must name an open view (CONTRIBUTING.md, "Arguments
// the server checks"). rgb_id ... pre_star_id came with the tools folded in from
// pixinsight-pack-astro@eee19b3; the server's check replaces the pack's own requireOpenViews.
const CHECKED_VIEW_ARGS = ['view_id', 'target_id', 'source_id', 'reference_id', 'r_view_id', 'g_view_id', 'b_view_id', 'size_from', 'old_id',
  'rgb_id', 'l_id', 'ha_id', 'oiii_id', 'stars_id', 'pre_star_id'];

// Checked names whose core tool has not been folded in yet. Each fold task deletes the names its tools
// take (the test below fails until it does); the list is empty when the fold is complete.
// Tools whose mask_id is an existing view (an input); for every other tool mask_id names a mask to create.
const MASK_INPUT_TOOLS = ['apply_mask', 'shell_detail_enhance'];

function probeTool(props, name = 'probe_tool') {
  const t = { name, description: 'test', inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) }, handler: async () => ({ text: 'ran' }) };
  return { definitions: [t], handlers: new Map([[t.name, t.handler]]) };
}

test('each checked view argument must name an open view, for any tool', async () => {
  const api = apiFrom(createFakeBridge().ctx, { listImages: async () => [{ id: 'Open' }] });
  for (const arg of CHECKED_VIEW_ARGS) {
    const dispatch = captureDispatch(probeTool([arg]), api);
    const r = await dispatch({ params: { name: 'probe_tool', arguments: { [arg]: 'Missing' } } }, { sendNotification: async () => {} });
    assert.equal(r.isError, true, arg);
    assert.match(r.content[0].text, new RegExp(`View not found: ${arg}="Missing"`));
  }
});

test('the view check names every missing input at once, before the handler runs', async () => {
  const api = apiFrom(createFakeBridge().ctx, { listImages: async () => [] });
  const dispatch = captureDispatch(probeTool(['target_id', 'ha_id', 'oiii_id']), api);
  const r = await dispatch({ params: { name: 'probe_tool', arguments: { target_id: 'RGB', ha_id: 'Ha', oiii_id: 'OIII' } } }, { sendNotification: async () => {} });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'View not found: target_id="RGB", ha_id="Ha", oiii_id="OIII". Open views: (none).');
});

test('an empty or absent checked argument is not looked up (optional view inputs such as pre_star_id)', async () => {
  const api = apiFrom(createFakeBridge().ctx, { listImages: async () => [{ id: 'RGB' }] });
  const dispatch = captureDispatch(probeTool(['target_id', 'pre_star_id']), api);
  const r = await dispatch({ params: { name: 'probe_tool', arguments: { target_id: 'RGB' } } }, { sendNotification: async () => {} });
  assert.equal(r.content[0].text, 'ran');
});

test('argument names no tool reads as an existing view are not checked, so a tool may name a view to create with them', async () => {
  const api = apiFrom(createFakeBridge().ctx, { listImages: async () => [] });
  const names = ['output_id', 'new_view', 'made_id'];
  const dispatch = captureDispatch(probeTool(names), api);
  const r = await dispatch({ params: { name: 'probe_tool', arguments: Object.fromEntries(names.map((n) => [n, 'new_view'])) } }, { sendNotification: async () => {} });
  assert.notEqual(r.isError, true, r.content[0].text);
  assert.equal(r.content[0].text, 'ran');
});

test('mask_id is checked for the tools that read an existing mask, and only for them', async () => {
  const api = apiFrom(createFakeBridge().ctx, { listImages: async () => [{ id: 'RGB' }] });
  for (const tool of MASK_INPUT_TOOLS) {
    const dispatch = captureDispatch(probeTool(['mask_id'], tool), api);
    const r = await dispatch({ params: { name: tool, arguments: { mask_id: 'NoMask' } } }, { sendNotification: async () => {} });
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0].text, /View not found: mask_id="NoMask"/, tool);
  }
  const dispatch = captureDispatch(probeTool(['mask_id'], 'create_zone_masks'), api);
  const r = await dispatch({ params: { name: 'create_zone_masks', arguments: { mask_id: 'NewMask' } } }, { sendNotification: async () => {} });
  assert.equal(r.content[0].text, 'ran', 'a mask-making tool names the mask it creates');
});

test('every checked view argument is an input of some core tool', async () => {
  const core = await buildCoreCatalog();
  const used = new Set(core.definitions.flatMap((d) => Object.keys(d.inputSchema.properties ?? {})));
  for (const arg of CHECKED_VIEW_ARGS) assert.ok(used.has(arg), `${arg} is checked but no core tool takes it`);
});

// --- The full serve()-shaped composition: core + loaded packs + resume_bridge + list_packs ---
//
// Everything above exercises createServer()/buildRuntimeApi() in isolation. This closes the last
// gap: that a real loadPacks() pass, composed by assembleCatalog() -- the same function serve()
// calls, not a copy of its composition -- actually reaches tools/list and tools/call.

test('a real loaded pack merges into tools/list alongside core tools, is callable, and list_packs reports it', async () => {
  const core = await buildCoreCatalog();
  const { packs, tools: packTools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-ok') }, log() {} });
  assert.equal(packs[0].status, 'loaded'); // sanity: this test is only meaningful if the pack actually loaded

  const catalog = assembleCatalog({ core, packs, packTools, resetBridge: () => {}, log() {} });

  // core + the four server-defined tools, plus the one pack tool -- proves the merge is additive,
  // not just "the pack tool is somewhere in there".
  assert.equal(catalog.definitions.length, core.definitions.length + 4 + packTools.length);

  const { ctx } = createFakeBridge();
  // fixture_stretch declares a `view_id` input, which server.mjs's missingViews pre-check (applied
  // uniformly to every tool, core or pack) validates against open views -- so the fake api needs
  // "RGB" to actually be open, or the pre-check would reject the call before the pack handler runs.
  const api = apiFrom(ctx, { listImages: async () => [{ id: 'RGB' }] });
  const server = createServer({ catalog, api });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'fixture_stretch'), 'the pack tool must be reachable via tools/list');
    assert.ok(tools.some((t) => t.name === 'list_packs'), 'list_packs itself must be reachable via tools/list');
    assert.equal(tools.length, catalog.definitions.length);

    const packResult = await client.callTool({ name: 'fixture_stretch', arguments: { view_id: 'RGB' } });
    assert.notEqual(packResult.isError, true);
    assert.match(packResult.content[0].text, /stretched RGB/, 'the pack handler, not a stub, must actually run');

    const listResult = await client.callTool({ name: 'list_packs', arguments: {} });
    const reported = JSON.parse(listResult.content[0].text);
    assert.equal(reported.packs.length, 1);
    assert.equal(reported.packs[0].name, 'ok');
    assert.equal(reported.packs[0].status, 'loaded');
    assert.equal(reported.packs[0].toolCount, 1);
    assert.deepEqual(reported.shadowed, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('list_packs reports which core tools a pack shadowed, and a reserved tool stays the server\'s', async () => {
  const core = await buildCoreCatalog();
  assert.ok(core.handlers.has('run_bxt'), 'precondition: run_bxt is a core tool');
  const { packs, tools: packTools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-collides') }, log() {} });
  let resets = 0;
  const catalog = assembleCatalog({ core, packs, packTools, resetBridge: () => { resets++; }, log() {} });
  assert.deepEqual(catalog.shadowed, ['run_bxt']);
  assert.equal(catalog.definitions.filter((d) => d.name === 'resume_bridge').length, 1);

  const { ctx } = createFakeBridge();
  const server = createServer({ catalog, api: apiFrom(ctx) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = JSON.parse((await client.callTool({ name: 'list_packs', arguments: {} })).content[0].text);
    assert.deepEqual(listed.shadowed, ['run_bxt']);
    assert.equal((await client.callTool({ name: 'run_bxt', arguments: {} })).content[0].text, 'mine');
    await client.callTool({ name: 'resume_bridge', arguments: {} });
    assert.equal(resets, 1, 'resume_bridge must still be the server\'s own, not the pack\'s');
  } finally {
    await client.close();
    await server.close();
  }
});

// --- Generic inputSchema `required` enforcement (e2e defect: rename_view without old_id reached
// PixInsight and failed there with "View not found: undefined") ---

test('a call missing a schema-required argument is rejected before the handler runs, naming the missing argument', async () => {
  const catalog = await catalogWithResumeBridge();
  let pjsrCalls = 0;
  let listCalls = 0;
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, {
    pjsr: async () => { pjsrCalls++; return { status: 'ok', result: '' }; },
    listImages: async () => { listCalls++; return [{ id: 'L' }]; },
  });
  const dispatch = captureDispatch(catalog, api);

  const result = await dispatch({ params: { name: 'rename_view', arguments: { view_id: 'L', new_id: 'Lum' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rename_view/);
  assert.match(result.content[0].text, /old_id/);
  assert.doesNotMatch(result.content[0].text, /missing[^.]*new_id/i, 'new_id was supplied, so it must not be reported missing');
  assert.equal(pjsrCalls, 0, 'the handler must not have run');
  assert.equal(listCalls, 0, 'nothing may reach PixInsight, not even the view pre-check');
});

test('every missing required argument is named, and null or empty-string values count as missing', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge();
  const dispatch = captureDispatch(catalog, apiFrom(ctx));

  const result = await dispatch({ params: { name: 'rename_view', arguments: { old_id: '', new_id: null } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /old_id/);
  assert.match(result.content[0].text, /new_id/);
});

test('a call with every required argument present is not affected by the required check', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge({ replies: ['42'] });
  const dispatch = captureDispatch(catalog, apiFrom(ctx));

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '6*7;' } } }, { sendNotification: async () => {} });
  assert.notEqual(result.isError, true);
});

// --- Unknown arguments: a tool whose inputSchema sets additionalProperties: false refuses an argument
// its schema does not list (the folded tools: a 1.1-shaped call such as multi_scale_enhance with
// do_hdrmt must not silently run without the step). A tool without it accepts extras, as before. ---

function closedCatalog(handler) {
  return {
    definitions: [{ name: 'closed_tool', description: 'd', inputSchema: { type: 'object', properties: { view_id: { type: 'string' }, amount: { type: 'number' } }, required: ['view_id'], additionalProperties: false } },
      { name: 'open_tool', description: 'd', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } }],
    handlers: new Map([['closed_tool', handler], ['open_tool', handler]]),
  };
}

test('a tool with additionalProperties: false refuses unknown arguments, naming them, before anything reaches PixInsight', async () => {
  let ran = 0;
  let listCalls = 0;
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { listImages: async () => { listCalls++; return [{ id: 'L' }]; } });
  const dispatch = captureDispatch(closedCatalog(async () => { ran++; return { text: 'ok' }; }), api);

  const result = await dispatch({ params: { name: 'closed_tool', arguments: { view_id: 'L', amount: 1, do_hdrmt: true, classification: 'x' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /closed_tool: unknown arguments: do_hdrmt, classification\./);
  assert.match(result.content[0].text, /Accepted: view_id, amount\./);
  assert.equal(ran, 0);
  assert.equal(listCalls, 0);
});

test('a tool with additionalProperties: false runs when every argument is listed; a tool without it accepts extras', async () => {
  let ran = 0;
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { listImages: async () => [{ id: 'L' }] });
  const dispatch = captureDispatch(closedCatalog(async () => { ran++; return { text: 'ok' }; }), api);
  const ok = await dispatch({ params: { name: 'closed_tool', arguments: { view_id: 'L', amount: 1 } } }, { sendNotification: async () => {} });
  assert.notEqual(ok.isError, true);
  const extra = await dispatch({ params: { name: 'open_tool', arguments: { amount: 1, anything: true } } }, { sendNotification: async () => {} });
  assert.notEqual(extra.isError, true);
  assert.equal(ran, 2);
});

test('no core tool outside the folded set changes: only the folded tools set additionalProperties: false', async () => {
  const catalog = await buildCoreCatalog();
  const closed = catalog.definitions.filter((d) => d.inputSchema?.additionalProperties === false).map((d) => d.name).sort();
  assert.equal(closed.length, 30, closed.join(', '));
  assert.ok(!closed.includes('run_process') && !closed.includes('get_image_stats'));
});

// --- Result contract: a handler may flag a non-throwing failure with `isError: true` ---

function catalogOf(tools) {
  return {
    definitions: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    handlers: new Map(tools.map((t) => [t.name, t.handler])),
  };
}
const noInput = { type: 'object', properties: {} };

test('a handler returning { text, isError: true } produces an isError result with that text', async () => {
  const catalog = catalogOf([{ name: 'refuser', description: 'd', inputSchema: noInput, handler: async () => ({ text: '[BLOCKED] no', isError: true }) }]);
  const { ctx } = createFakeBridge();
  const dispatch = captureDispatch(catalog, apiFrom(ctx));

  const result = await dispatch({ params: { name: 'refuser', arguments: {} } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, '[BLOCKED] no');
});

test('an array result is an error when any item carries isError: true', async () => {
  const catalog = catalogOf([{ name: 'mixed', description: 'd', inputSchema: noInput, handler: async () => [{ text: 'part one' }, { text: 'part two failed', isError: true }] }]);
  const { ctx } = createFakeBridge();
  const dispatch = captureDispatch(catalog, apiFrom(ctx));

  const result = await dispatch({ params: { name: 'mixed', arguments: {} } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content.map((c) => c.text), ['part one', 'part two failed']);
});

test('plain { text } and bare-string results stay non-errors (backward compatible)', async () => {
  const catalog = catalogOf([
    { name: 'plain', description: 'd', inputSchema: noInput, handler: async () => ({ text: 'fine' }) },
    { name: 'bare', description: 'd', inputSchema: noInput, handler: async () => 'also fine' },
    { name: 'falsy', description: 'd', inputSchema: noInput, handler: async () => ({ text: 'x', isError: false }) },
  ]);
  const { ctx } = createFakeBridge();
  const dispatch = captureDispatch(catalog, apiFrom(ctx));

  for (const name of ['plain', 'bare', 'falsy']) {
    const result = await dispatch({ params: { name, arguments: {} } }, { sendNotification: async () => {} });
    assert.notEqual(result.isError, true, `${name} must not be an error`);
    assert.equal('isError' in result, false, `${name} must not carry an isError field at all`);
  }
});

// --- run_plate_solve: ImageSolver's benign "No database files have been selected" line ---

const SOLVED = '@@SOLVE@@' + JSON.stringify({ solved: true, seconds: 30, summary: ['Control points: 715'] });
const NO_DB_LINE = '*** Error: No database files have been selected.';
const GAIA_WARNING = '** Warning: the Gaia process is not working, probably because of a wrong database configuration.';

function plateSolveDispatch(catalog, reply, consoleLines) {
  const { ctx } = createFakeBridge({ replies: [reply] });
  const api = apiFrom(ctx, { listImages: async () => [{ id: 'L' }] });
  return captureDispatch(catalog, api, () => consoleLines);
}
const solveArgs = { view_id: 'L', ra_deg: 80.58, dec_deg: 33.42, pixel_scale: 1.542 };

test('a successful plate solve is not promoted to an error by ImageSolver\'s benign "No database files" console line', async () => {
  const catalog = await catalogWithResumeBridge();
  const dispatch = plateSolveDispatch(catalog, SOLVED, [NO_DB_LINE, GAIA_WARNING]);

  const result = await dispatch({ params: { name: 'run_plate_solve', arguments: solveArgs } }, { sendNotification: async () => {} });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Plate solve OK/);
  assert.ok(result.content.some((c) => c.text.includes(NO_DB_LINE)), 'the console line is still reported, just not promoted');
});

test('a plate solve that failed is still an error, benign line or not', async () => {
  const catalog = await catalogWithResumeBridge();
  const failed = '@@SOLVE@@' + JSON.stringify({ solved: false, error: 'no solution' });
  const dispatch = plateSolveDispatch(catalog, failed, [NO_DB_LINE]);

  const result = await dispatch({ params: { name: 'run_plate_solve', arguments: solveArgs } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
});

test('any other "*** Error" line on a successful plate solve still promotes to isError', async () => {
  const catalog = await catalogWithResumeBridge();
  const dispatch = plateSolveDispatch(catalog, SOLVED, [NO_DB_LINE, '*** Error: something else went wrong']);

  const result = await dispatch({ params: { name: 'run_plate_solve', arguments: solveArgs } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
});

test('the "No database files" line is benign only for run_plate_solve, not for any other tool', async () => {
  const catalog = await catalogWithResumeBridge();
  const { ctx } = createFakeBridge({ replies: ['ok'] });
  const dispatch = captureDispatch(catalog, apiFrom(ctx), () => [NO_DB_LINE]);

  const result = await dispatch({ params: { name: 'run_pjsr', arguments: { code: '1;' } } }, { sendNotification: async () => {} });
  assert.equal(result.isError, true);
});

// The bridge's watcher is written into the workspace, per bridge dir, when the bridge asks for it
// (before a launch), through deps.materializeWatcher; each distinct warning is logged once.
test('the bridge gets a watcherFor that writes the watcher for the bridge dir it is asked about, logging each warning once', async () => {
  const seen = [];
  const logs = [];
  let made;
  const deps = {
    machineId: () => 'rig',
    materializeWatcher: async (o) => { seen.push(o); return { path: `${o.bridgeDir}/w.js`, warnings: ['ImageSolver not found'] }; },
    createBridge: (o) => { made = o; return { pjsr: async () => ({ status: 'ok', outputs: {} }), listImages: async () => [], log() {} }; },
  };
  const { api } = buildRuntimeApi({ platform: { piBin: '/fake', imageSolverPath: '/x' }, probe: {}, workspace: { dir: '/w', scratchDir: '/w/s' }, log: (m) => logs.push(m), connectorVersion: '9.9.9', deps });
  await api.pjsr('1;');
  assert.equal(typeof made.watcherFor, 'function');
  assert.equal(made.watcherPath, undefined);
  assert.equal(await made.watcherFor('/w/agentic/bridge/rig'), '/w/agentic/bridge/rig/w.js');
  await made.watcherFor('/w/agentic/bridge/rig');
  assert.equal(seen[0].bridgeDir, '/w/agentic/bridge/rig');
  assert.equal(seen[0].version, '9.9.9');
  assert.deepEqual(logs.filter((m) => /ImageSolver/.test(m)), ['watcher: ImageSolver not found']);
});
