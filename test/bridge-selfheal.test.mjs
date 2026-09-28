// Bridge recovery and job control, with the real watcher template (evaluated in a vm over the real
// filesystem, handlers stubbed) and real createBridge() instances. No PixInsight.
//
// Pinned e2e defects (2026-09-28, twice): after PixInsight was killed (a crash; a hidden dialog), its
// "busy" heartbeat was treated as a live watcher. With PixInsight not running, probe.startedAt() is
// null, so the old "started after the beat" check never fired: autostart never ran and every call
// failed with "crashed mid-command, retry" until the file was moved by hand. Then the first -x launch
// into the freshly started PixInsight never ran ("Watcher did not start within 30s"), while a retry
// seconds later started at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, JobCancelledError } from '../src/bridge.mjs';
import { toPixPath } from '../src/platform.mjs';
import { createLaunchMutex } from '../src/runtime.mjs';
import { fakeNet } from './fake-net.mjs';

const TEMPLATE = fs.readFileSync(new URL('../pjsr/watcher.template.js', import.meta.url), 'utf8');

async function tmpDir(t) {
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'pixi-selfheal-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'agentic', 'bridge', 'rig');
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  return dir;
}

function pjsrFile() {
  return {
    exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    directoryExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    createDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    readLines: (p) => fs.readFileSync(p, 'utf8').split('\n'),
    writeTextFile: (p, text) => fs.writeFileSync(p, text),
    remove: (p) => fs.rmSync(p),
    move: (from, to) => fs.renameSync(from, to),
    searchDirectory: (pattern) => {
      const cut = pattern.lastIndexOf('/');
      const dir = pattern.slice(0, cut);
      const ext = pattern.slice(pattern.lastIndexOf('.'));
      try { return fs.readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => `${dir}/${n}`); } catch { return []; }
    },
  };
}

// The real watcher for one dir; `dispatch(command, ctx)` stands in for dispatchCommand.
function realWatcher(bridgeDir, dispatch) {
  const src = TEMPLATE.split('@@BRIDGEDIR@@').join(JSON.stringify(toPixPath(bridgeDir)))
    .split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/\nrunWatcher\(\);\s*$/, '\n');
  const quiet = () => {};
  const ctx = vm.createContext({
    File: pjsrFile(), JSON, Date, Math, Object, String, Number, isNaN, parseInt, Error,
    console: { writeln: quiet, noteln: quiet, warningln: quiet, criticalln: quiet, abortRequested: false, abortEnabled: true },
    CoreApplication: { versionLE: false, versionMajor: 1, versionMinor: 9, versionRelease: 3, versionRevision: 0, versionBeta: 0, processEvents: () => {} },
  });
  vm.runInContext(src, ctx);
  ctx.WATCHER_START_MS = Date.now() - 1000;
  const ran = [];
  ctx.dispatchCommand = (command) => {
    ran.push(command.parameters.code);
    if (dispatch) return dispatch(command, ctx);
    return { status: 'success', outputs: { consoleOutput: `ran ${command.parameters.code}`, consoleErrors: [] }, message: '' };
  };
  return { tick: () => vm.runInContext('processNextCommand()', ctx), ran, ctx };
}

async function until(cond, what, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await delay(2);
  }
}

function connector(bridgeDir, extra = {}) {
  return createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null },
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir,
    autoLaunch: false,
    pollIntervalMs: 2,
    pid: 7001,
    isPidAlive: () => true,
    onExit: () => {},
    ...extra,
  });
}

const beat = (dir, text) => fs.writeFileSync(path.join(dir, 'heartbeat'), text);
const cmdFiles = (dir) => fs.readdirSync(path.join(dir, 'commands')).sort();

test('a "busy" heartbeat left by a PixInsight that is no longer running is cleared, and PixInsight is started again', async (t) => {
  const dir = await tmpDir(t);
  beat(dir, `busy run_script 0f0e-dead ${Date.now() - 60_000}`); // the crash: busy a minute ago
  let running = false;
  let starts = 0;
  const events = [];
  const a = connector(dir, {
    autoLaunch: true,
    probe: { isRunning: async () => running, startedAt: async () => (running ? Date.now() : null), memoryMB: async () => null },
    spawn: () => { starts++; setTimeout(() => { running = true; }, 10); return { unref() {}, on() {} }; },
    launchMutex: createLaunchMutex({ net: fakeNet(), env: {}, sleep: (ms) => delay(Math.min(ms, 5)) }),
    spawnWatcher: () => beat(dir, `idle ${Date.now()}`),
    trace: (r) => { if (r.kind === 'event') events.push(r); },
  });
  const p = a.pjsr('after-crash');
  const idle = () => { try { return fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8').startsWith('idle'); } catch { return false; } };
  await until(() => cmdFiles(dir).some((f) => f.endsWith('.json')) && idle(), 'a watcher launch');
  const w = realWatcher(dir);
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran after-crash');
  assert.equal(starts, 1, 'autostart ran instead of "crashed mid-command, retry"');
  const stale = events.find((e) => e.event === 'stale heartbeat');
  assert.ok(stale, 'the cleared beat is in the call log');
  assert.match(stale.reason, /not running/);
});

test('a "busy" beat whose command is finished or gone is cleared while PixInsight still runs (the watcher died after it)', async (t) => {
  const dir = await tmpDir(t);
  beat(dir, `busy run_script 1234-gone ${Date.now() - 30_000}`); // no commands/1234-gone.* anywhere
  let launches = 0;
  const events = [];
  const a = connector(dir, {
    autoLaunch: true,
    spawnWatcher: () => { launches++; beat(dir, `idle ${Date.now()}`); },
    trace: (r) => { if (r.kind === 'event') events.push(r); },
  });
  const p = a.pjsr('next');
  await until(() => launches === 1, 'a relaunch');
  const w = realWatcher(dir);
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran next');
  assert.match(events.find((e) => e.event === 'stale heartbeat').reason, /1234-gone.*finished or gone/);
});

test('a "busy" beat whose command is still claimed stays alive however old (a long native process), and nothing is launched', async (t) => {
  const dir = await tmpDir(t);
  fs.writeFileSync(path.join(dir, 'commands', 'long-1.running'), '{}');
  beat(dir, `busy run_script long-1 ${Date.now() - 10 * 60_000}`);
  let launches = 0;
  const a = connector(dir, { autoLaunch: true, spawnWatcher: () => { launches++; } });
  const p = a.pjsr('queued-behind');
  await delay(150);
  assert.equal(launches, 0, 'no second watcher while the first is busy');
  assert.ok(fs.existsSync(path.join(dir, 'heartbeat')), 'the beat was not cleared');
  // The long command ends: its claim goes and the watcher is back in its loop.
  fs.rmSync(path.join(dir, 'commands', 'long-1.running'));
  beat(dir, `idle ${Date.now()}`);
  const w = realWatcher(dir);
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran queued-behind');
});

test('into a PixInsight that was just started, a launch that never beats is sent again (bounded) instead of failing after 30 s', async (t) => {
  const dir = await tmpDir(t);
  let clock = 1_800_000_000_000;
  let running = false;
  const spawns = [];
  const a = connector(dir, {
    autoLaunch: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await delay(0); },
    probe: { isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null },
    spawn: () => { setTimeout(() => { running = true; }, 5); return { unref() {}, on() {} }; },
    launchMutex: createLaunchMutex({ net: fakeNet(), env: {}, sleep: (ms) => delay(Math.min(ms, 5)) }),
    // The first -x reaches a PixInsight still initializing and is lost; the second one runs.
    spawnWatcher: () => { spawns.push(clock); if (spawns.length >= 2) beat(dir, `idle ${clock}`); },
  });
  const p = a.pjsr('fresh');
  await until(() => spawns.length === 2, 'the second launch');
  assert.ok(spawns[1] - spawns[0] >= 10_000 && spawns[1] - spawns[0] < 30_000, `relaunched after ${spawns[1] - spawns[0]} ms, before the 30 s give-up`);
  const w = realWatcher(dir);
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran fresh');
});

test('cancel on a queued command takes it off the queue: the send fails with JobCancelledError and no watcher ever runs it', async (t) => {
  const dir = await tmpDir(t);
  const a = connector(dir);
  let cmdId = null;
  const p = a.pjsr('never', { job: true, onSent: (id) => { cmdId = id; } });
  await until(() => cmdId && cmdFiles(dir).includes(`${cmdId}.json`), 'the command on disk');
  assert.deepEqual(a.cancel(cmdId), { state: 'requested' });
  await assert.rejects(p, (e) => e instanceof JobCancelledError && /nothing ran/.test(e.message));
  const w = realWatcher(dir);
  while (w.tick()) { /* drain */ }
  assert.deepEqual(w.ran, [], 'the watcher never saw it');
  assert.deepEqual(cmdFiles(dir), []);
});

test('cancel on a running command writes cancel/<id>; the watcher stops the script at its next processEvents with MCP_CANCELLED and keeps serving', async (t) => {
  const dir = await tmpDir(t);
  const a = connector(dir);
  let cmdId = null;
  const p = a.pjsr('loop', { job: true, onSent: (id) => { cmdId = id; } });
  await until(() => cmdId && cmdFiles(dir).includes(`${cmdId}.json`), 'the command on disk');
  let status = null;
  // The stand-in script: reports progress, then the cancel arrives while it runs (as cancel_job
  // would, from the server, while PixInsight is busy), then it yields.
  const w = realWatcher(dir, (command, ctx) => {
    ctx.mcpProgress('round 3 of 12');
    status = a.status(cmdId);
    assert.deepEqual(a.cancel(cmdId), { state: 'signalled' });
    try {
      ctx.mcpAbortableProcessEvents();
    } catch (e) {
      throw new Error('Script error: ' + e.message);
    }
    return { status: 'success', outputs: { consoleOutput: 'not reached' }, message: '' };
  });
  w.tick();
  const r = await p;
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /MCP_CANCELLED/);
  assert.equal(status.progress.text, 'round 3 of 12');
  assert.match(status.heartbeat.cmdId, new RegExp(cmdId));
  assert.ok(!fs.existsSync(path.join(dir, 'cancel', cmdId)) && !fs.existsSync(path.join(dir, 'progress', cmdId)), 'cancel/ and progress/ cleaned up');
  // The watcher keeps serving (a cancel is not a Pause/Abort).
  const q = a.pjsr('after');
  await until(() => cmdFiles(dir).some((f) => f.endsWith('.json')), 'the next command');
  w.ctx.dispatchCommand = (command) => ({ status: 'success', outputs: { consoleOutput: `ran ${command.parameters.code}` }, message: '' });
  w.tick();
  assert.equal((await q).result, 'ran after');
});

test('processEvents refreshes the "busy" beat, naming the command, at most every 2 s', async (t) => {
  const dir = await tmpDir(t);
  const w = realWatcher(dir);
  w.ctx.MCP_CURRENT = { id: 'c-9', tool: 'run_script', lastBeat: Date.now() - 5000, lastCancelCheck: Date.now(), cancelled: false };
  w.ctx.mcpAbortableProcessEvents();
  const first = fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8');
  assert.match(first, /^busy run_script c-9 \d+$/);
  fs.writeFileSync(path.join(dir, 'heartbeat'), 'marker');
  w.ctx.mcpAbortableProcessEvents();
  assert.equal(fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8'), 'marker', 'not rewritten again within 2 s');
  assert.equal(w.ctx.mcpCancelRequested(), false);
});

test('a send timeout says PixInsight may be showing a dialog', async (t) => {
  const dir = await tmpDir(t);
  const a = connector(dir, { sendTimeoutMs: 30 });
  await assert.rejects(a.pjsr('stuck'), /Timeout: run_script .*showing a dialog/);
});

test('status() reports the heartbeat of a watcher before 0.8.0 ("busy <tool> <ms>") without a command id', async (t) => {
  const dir = await tmpDir(t);
  beat(dir, `busy run_script ${Date.now() - 3000}`);
  const s = connector(dir).status();
  assert.equal(s.heartbeat.state, 'busy');
  assert.equal(s.heartbeat.cmdId, null);
  assert.ok(s.heartbeat.ageMs >= 3000);
});
