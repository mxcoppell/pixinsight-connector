// createBridge's opts.trace: what the call log records for each bridge command (sent, then done with
// the raw watcher result, or failed with a kind) and for bridge-level events (launch, relaunch,
// abort, crash, vanished, quarantine). Real temp dirs; the watcher is played by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../src/bridge.mjs';

async function dirs(t) {
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'pixi-bridge-trace-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  return { root, bridgeDir, cmdDir: path.join(bridgeDir, 'commands'), resDir: path.join(bridgeDir, 'results') };
}

const alive = { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null };

function bridgeWith(d, traces, extra = {}) {
  return createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: alive,
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir: d.bridgeDir,
    autoLaunch: false,
    pollIntervalMs: 3,
    deadCheckIntervalMs: 10,
    pid: 5151,
    isPidAlive: () => true,
    onExit: () => {},
    // A copy at the time of the call: that is what the call log serializes.
    trace: (rec) => traces.push(JSON.parse(JSON.stringify(rec))),
    ...extra,
  });
}

async function nextCommand(d, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    let names = [];
    try { names = fs.readdirSync(d.cmdDir).filter((f) => f.endsWith('.json')); } catch {}
    if (names.length) return { name: names[0], id: names[0].replace(/\.json$/, '') };
    if (Date.now() - t0 > ms) throw new Error('no command written');
    await delay(2);
  }
}

test('a command that is answered: sent, then done with the raw watcher result, before pjsr adds its own fields', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces);
  const code = 'var s = "two\\nlines";\nJSON.stringify(s);';
  const p = b.pjsr(code);
  const { id } = await nextCommand(d);
  const raw = { id, status: 'success', outputs: { consoleOutput: 'out', consoleErrors: ['*** Error: e'] }, message: '' };
  fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify(raw));
  const r = await p;
  assert.equal(r.status, 'ok', 'pjsr still normalizes the status for its caller');

  assert.deepEqual(traces.map((x) => x.kind), ['sent', 'done']);
  const [sent, done] = traces;
  assert.equal(sent.cmdId, id);
  assert.equal(sent.tool, 'run_script');
  assert.deepEqual(sent.params, { code });
  assert.equal(sent.dir, d.bridgeDir);
  assert.equal(typeof sent.sentAt, 'number');
  assert.equal(done.cmdId, id);
  assert.equal(done.sentAt, sent.sentAt);
  assert.equal(typeof done.ms, 'number');
  assert.deepEqual(done.result, raw, 'the result as the watcher wrote it');
});

test('list_open_images is traced with its tool name and parameters', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces);
  const p = b.listImages();
  const { id } = await nextCommand(d);
  fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify({ status: 'success', outputs: { images: [{ id: 'L' }] } }));
  assert.deepEqual(await p, [{ id: 'L' }]);
  assert.equal(traces[0].tool, 'list_open_images');
  assert.deepEqual(traces[0].params, {});
  assert.deepEqual(traces[1].result.outputs.images, [{ id: 'L' }]);
});

test('a vanished command: failed with kind vanished, and a vanished event', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces, { vanishGraceMs: 30, sendTimeoutMs: 5000 });
  const p = b.pjsr('1;');
  const { name, id } = await nextCommand(d);
  fs.rmSync(path.join(d.cmdDir, name));
  await assert.rejects(p, /vanished/);
  assert.deepEqual(traces.map((x) => x.kind), ['sent', 'failed', 'event']);
  assert.equal(traces[1].cmdId, id);
  assert.equal(traces[1].failure.kind, 'vanished');
  assert.match(traces[1].failure.message, /vanished/);
  assert.equal(typeof traces[1].ms, 'number');
  assert.deepEqual({ ...traces[2], message: 'm' }, { kind: 'event', event: 'vanished', cmdId: id, tool: 'run_script', message: 'm' });
});

test('a mid-command crash: failed with kind crash, and a crash event', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces, { probe: { ...alive, isRunning: async () => false } });
  await assert.rejects(b.pjsr('1;'), (e) => e.name === 'BridgeCrashError');
  const failed = traces.find((x) => x.kind === 'failed');
  assert.equal(failed.failure.kind, 'crash');
  assert.equal(failed.failure.name, 'BridgeCrashError');
  assert.ok(traces.some((x) => x.kind === 'event' && x.event === 'crash'));
});

test('a timeout: failed with kind timeout', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces, { sendTimeoutMs: 20 });
  await assert.rejects(b.pjsr('1;'), /Timeout/);
  assert.equal(traces.find((x) => x.kind === 'failed').failure.kind, 'timeout');
});

test('an abort (Pause/Abort before the send): failed with kind abort, and an abort event', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces, { autoLaunch: true, probe: { ...alive, isRunning: async () => false } });
  fs.writeFileSync(path.join(d.bridgeDir, 'last-stop'), `abort requested | ${Date.now()}`);
  await assert.rejects(b.pjsr('1;'), (e) => e.name === 'BridgeAbortError');
  assert.deepEqual(traces.map((x) => x.kind), ['sent', 'failed', 'event']);
  assert.equal(traces[1].failure.kind, 'abort');
  assert.equal(traces[2].event, 'abort');
});

test('a command that cannot be written: failed with kind write and no sentAt; nothing was sent', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const failing = { ...fs, writeFileSync: (p, ...a) => { if (String(p).endsWith('.tmp')) { const e = new Error('ENOSPC: no space'); e.code = 'ENOSPC'; throw e; } return fs.writeFileSync(p, ...a); } };
  const b = bridgeWith(d, traces, { fs: failing });
  await assert.rejects(b.pjsr('1;'), /ENOSPC/);
  assert.deepEqual(traces.map((x) => x.kind), ['failed']);
  assert.equal(traces[0].failure.kind, 'write');
  assert.equal(traces[0].sentAt, null);
  assert.deepEqual(traces[0].params, { code: '1;' });
});

test('a watcher launch is an event; a relaunch after an early exit is a relaunch event with the reason', async (t) => {
  const d = await dirs(t);
  const traces = [];
  let spawns = 0;
  const heartbeat = path.join(d.bridgeDir, 'heartbeat');
  const b = bridgeWith(d, traces, {
    autoLaunch: true,
    spawnWatcher: () => {
      spawns++;
      // The first watcher starts and exits before its heartbeat is seen; the second comes up.
      if (spawns === 1) fs.writeFileSync(path.join(d.bridgeDir, 'last-stop'), `idle for 8s | ${Date.now() + 1}`);
      else fs.writeFileSync(heartbeat, `idle ${Date.now()}`);
    },
  });
  const p = b.pjsr('1;');
  const { id } = await nextCommand(d);
  await delay(50);
  fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify({ status: 'success', outputs: { consoleOutput: '' } }));
  await p;
  const events = traces.filter((x) => x.kind === 'event');
  assert.deepEqual(events.map((e) => e.event), ['launch', 'relaunch']);
  assert.equal(events[0].launch, 1);
  assert.equal(events[0].watcherPath, 'fake-watcher.js');
  assert.equal(events[1].launch, 2);
  assert.equal(events[1].reason, 'idle for 8s');
});

test('commands moved aside before a dir is used are a quarantine event', async (t) => {
  const d = await dirs(t);
  fs.mkdirSync(d.cmdDir, { recursive: true });
  fs.writeFileSync(path.join(d.cmdDir, 'old.json'), JSON.stringify({ id: 'old', tool: 'run_script', senderPid: 99, timestamp: new Date().toISOString() }));
  const traces = [];
  const b = bridgeWith(d, traces, { isPidAlive: (pid) => pid !== 99 });
  const p = b.pjsr('1;');
  const { id } = await nextCommand(d);
  fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify({ status: 'success', outputs: {} }));
  await p;
  const q = traces.find((x) => x.kind === 'event' && x.event === 'quarantine');
  assert.ok(q, JSON.stringify(traces));
  assert.equal(q.dir, d.bridgeDir);
  assert.equal(q.files.length, 1);
  assert.match(q.files[0], /^old\.json/);
});

test('a trace hook that throws never breaks a send', async (t) => {
  const d = await dirs(t);
  const b = bridgeWith(d, [], { trace: () => { throw new Error('logger bug'); } });
  const p = b.pjsr('1;');
  const { id } = await nextCommand(d);
  fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify({ status: 'success', outputs: { consoleOutput: 'fine' } }));
  assert.equal((await p).outputs.consoleOutput, 'fine');
});

test('the watcher start-up record (PixInsight version) is an event once per watcher start, before the first result it answers', async (t) => {
  const d = await dirs(t);
  const traces = [];
  const b = bridgeWith(d, traces);
  const info = path.join(d.bridgeDir, 'watcher.json');
  const answer = async (code) => {
    const p = b.pjsr(code);
    const { name, id } = await nextCommand(d);
    fs.rmSync(path.join(d.cmdDir, name)); // taken, as a watcher takes it
    fs.writeFileSync(path.join(d.resDir, `${id}.json`), JSON.stringify({ id, status: 'success', outputs: { consoleOutput: code }, message: '' }));
    await p;
  };
  const kinds = () => traces.map((x) => (x.kind === 'event' ? `event:${x.event}` : x.kind));

  await answer('no record yet');
  assert.deepEqual(kinds(), ['sent', 'done'], 'no start-up record: no event');

  const started = Date.UTC(2026, 8, 23, 12, 0, 0);
  fs.writeFileSync(info, JSON.stringify({ watcherVersion: '0.6.0', pixinsightVersion: '1.9.3-2', startedAt: started }));
  traces.length = 0;
  await answer('first');
  await answer('second');
  assert.deepEqual(kinds(), ['sent', 'event:watcher start', 'done', 'sent', 'done'], 'once per watcher start');
  const ev = traces[1];
  assert.equal(ev.pixinsightVersion, '1.9.3-2');
  assert.equal(ev.watcherVersion, '0.6.0');
  assert.equal(ev.startedAt, new Date(started).toISOString());

  fs.writeFileSync(info, JSON.stringify({ watcherVersion: '0.6.0', pixinsightVersion: '1.9.4', startedAt: started + 60_000 }));
  traces.length = 0;
  await answer('after a new watcher started');
  assert.deepEqual(kinds(), ['sent', 'event:watcher start', 'done']);
  assert.equal(traces[1].pixinsightVersion, '1.9.4');

  fs.writeFileSync(info, '{"watcherVers'); // torn or corrupt: skipped, never a failed call
  traces.length = 0;
  await answer('corrupt record');
  assert.deepEqual(kinds(), ['sent', 'done']);
});
