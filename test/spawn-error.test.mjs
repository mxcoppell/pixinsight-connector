// A PixInsight executable that cannot be run (PIXINSIGHT_BIN names a missing file, a file that is not
// executable) makes child_process.spawn emit 'error' after it returns. Unhandled, that event killed
// the whole server process. Both spawn sites -- the watcher launch (`PixInsight -x=`) and the
// PixInsight autostart -- must turn it into a failed tool call that names the path and the fix, and
// report it through the bridge trace (so the call log shows it). No PixInsight: the spawns are
// injected emitters, or the real spawn over a path that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensurePixInsight } from '../src/runtime.mjs';
import { createBridge, BridgeCrashError } from '../src/bridge.mjs';
import { createServer, buildRuntimeApi, assembleCatalog } from '../src/server.mjs';
import { createCallLog } from '../src/call-log.mjs';
import { createWorkspace } from '../src/workspace.mjs';

function tmpRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pixi-spawn-err-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// What child_process.spawn returns for an executable that cannot be run: a child that emits
// 'error' (ENOENT) on a later tick.
function failingChild(bin) {
  const child = new EventEmitter();
  child.unref = () => {};
  process.nextTick(() => {
    const e = new Error(`spawn ${bin} ENOENT`);
    e.code = 'ENOENT';
    e.path = bin;
    child.emit('error', e);
  });
  return child;
}

const probe = (running) => ({ isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null });

function bridgeOpts(root, extra = {}) {
  const clock = { t: 1_800_000_000_000 };
  return {
    clock,
    opts: {
      platform: { piBin: path.join(root, 'no such dir', 'PixInsight') },
      probe: probe(true),
      log: () => {},
      watcherPath: path.join(root, 'watcher.js'),
      bridgeDir: path.join(root, 'ws', 'agentic', 'bridge', 'mac-a'),
      env: {},
      autoLaunch: true,
      pollIntervalMs: 2,
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; await delay(1); },
      pid: 4242,
      isPidAlive: () => true,
      onExit() {},
      ...extra,
    },
  };
}

test('ensurePixInsight: a spawn that emits error fails at once with the path and the fix, not after the timeout', async () => {
  const bin = '/nowhere/PixInsight';
  const t0 = Date.now();
  await assert.rejects(
    ensurePixInsight({ platform: { piBin: bin }, probe: { isRunning: async () => false }, spawn: (b) => failingChild(b), log() {}, env: {}, timeoutMs: 60_000 }),
    (e) => {
      assert.match(e.message, /\/nowhere\/PixInsight/);
      assert.match(e.message, /ENOENT/);
      assert.match(e.message, /PIXINSIGHT_BIN/);
      assert.match(e.message, /doctor/);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 5_000, 'did not wait for the 60 s start-up timeout');
});

test('watcher launch: a spawn that emits error fails the send with the path and the fix, and is traced', async (t) => {
  const root = tmpRoot(t);
  const traces = [];
  const { opts, clock } = bridgeOpts(root, { spawnWatcher: (bin) => failingChild(bin), trace: (r) => traces.push(r) });
  const t0 = clock.t;
  const ctx = createBridge(opts);
  await assert.rejects(ctx.pjsr('1;'), (e) => {
    assert.notEqual(e.name, 'BridgeCrashError');
    assert.ok(e.message.includes(opts.platform.piBin), e.message);
    assert.match(e.message, /ENOENT/);
    assert.match(e.message, /PIXINSIGHT_BIN/);
    assert.match(e.message, /doctor/);
    return true;
  });
  assert.ok(clock.t - t0 < 30_000, 'failed before the 30 s watcher start-up timeout');
  const ev = traces.find((r) => r.kind === 'event' && r.event === 'watcher spawn failed');
  assert.ok(ev, `a 'watcher spawn failed' event, got ${JSON.stringify(traces.map((r) => r.event ?? r.kind))}`);
  assert.equal(ev.piBin, opts.platform.piBin);
  assert.equal(ev.code, 'ENOENT');
  const failed = traces.find((r) => r.kind === 'failed');
  assert.equal(failed?.failure.kind, 'launch');
});

test('watcher launch with the real spawn over a missing executable: the send fails, the process lives on', async (t) => {
  const root = tmpRoot(t);
  const { opts } = bridgeOpts(root);
  const ctx = createBridge(opts); // default spawnWatcher: the real child_process spawn
  await assert.rejects(ctx.pjsr('1;'), (e) => {
    assert.ok(e.message.includes(opts.platform.piBin), e.message);
    assert.match(e.message, /PIXINSIGHT_BIN/);
    return true;
  });
});

test('autostart: a spawn that emits error fails the send as a crash naming the path and the fix, and is traced', async (t) => {
  const root = tmpRoot(t);
  const traces = [];
  const { opts } = bridgeOpts(root, {
    probe: probe(false),
    spawn: (bin) => failingChild(bin),
    spawnWatcher: () => assert.fail('no watcher launch without PixInsight'),
    trace: (r) => traces.push(r),
    autostartTimeoutMs: 60_000,
  });
  const t0 = Date.now();
  const ctx = createBridge(opts);
  await assert.rejects(ctx.pjsr('1;'), (e) => {
    assert.ok(e instanceof BridgeCrashError);
    assert.match(e.message, /PixInsight could not be started/);
    assert.ok(e.message.includes(opts.platform.piBin), e.message);
    assert.match(e.message, /PIXINSIGHT_BIN/);
    assert.match(e.message, /doctor/);
    return true;
  });
  assert.ok(Date.now() - t0 < 5_000, 'did not wait for the autostart timeout');
  const ev = traces.find((r) => r.kind === 'event' && r.event === 'pixinsight start failed');
  assert.ok(ev?.message.includes(opts.platform.piBin));
});

test('through the server: PIXINSIGHT_BIN missing while PixInsight runs gives an isError result naming it, logged as an event', async (t) => {
  const root = tmpRoot(t);
  const home = path.join(root, 'home');
  const dir = path.join(root, 'IC 410');
  fs.mkdirSync(home);
  fs.mkdirSync(dir);
  const piBin = path.join(root, 'missing', 'PixInsight');
  const workspace = createWorkspace({ cwd: dir, env: {}, homeDir: home, platform: process.platform });
  const log = () => {};
  const callLog = createCallLog({ workspace, env: {}, pid: 778, log, onExit() {}, sessionInfo: () => ({ connectorVersion: '0.0.0-test' }) });
  const deps = {
    materializeWatcher: async () => ({ path: path.join(root, 'watcher.js'), warnings: [] }),
    machineId: () => 'mac-a',
    // The real bridge, real spawn; only exit hooks are kept off the test process.
    createBridge: (o) => createBridge({ ...o, onExit() {}, env: {}, isPidAlive: () => true }),
  };
  const { api, resetBridge } = buildRuntimeApi({ platform: { piBin }, probe: probe(true), workspace, log, connectorVersion: '0.0.0-test', deps, callLog });
  const tools = [{ name: 'run_code', description: 'test', inputSchema: { type: 'object', properties: {} }, handler: async (a) => ({ text: (await a.pjsr('1;')).outputs.consoleOutput }) }];
  const core = { definitions: tools.map(({ handler: _h, ...d }) => d), handlers: new Map(tools.map((x) => [x.name, x.handler])) };
  const server = createServer({ catalog: assembleCatalog({ core, packs: [], packTools: [], resetBridge, workspace, callLog }), api, callLog });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => { await client.close(); await server.close(); });

  const r = await client.callTool({ name: 'run_code', arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes(piBin), r.content[0].text);
  assert.match(r.content[0].text, /PIXINSIGHT_BIN/);

  const logsDir = path.join(dir, 'agentic', 'logs');
  const [name] = fs.readdirSync(logsDir);
  const recs = fs.readFileSync(path.join(logsDir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = recs.find((x) => x.type === 'event' && x.event === 'watcher spawn failed');
  assert.ok(ev, `logged, got ${JSON.stringify(recs.map((x) => x.event ?? x.type))}`);
  assert.equal(ev.piBin, piBin);
  assert.equal(ev.seq, 1);
});
