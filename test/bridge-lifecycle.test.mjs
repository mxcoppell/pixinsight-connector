// Watcher lifecycle and command-queue safety in src/bridge.mjs, driven entirely by injected
// clock/sleep/spawn/pid-liveness and a throwaway temp bridge directory -- no PixInsight.
//
// Two e2e defects are pinned here:
//  #1 stale command files (hours old, from dead clients -- one closed every window) sat in
//     bridge/commands/ and would have run on the next on-demand watcher launch;
//  #2 a false "Watcher did not start within 30s" on the first call, while bridge/last-stop showed a
//     watcher had started, idled out and exited during the wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, BridgeAbortError } from '../src/bridge.mjs';

const T0 = 1_800_000_000_000;
const SENDER_PID = 4242;

async function makeBridgeDir(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-life-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bridgeDir = path.join(root, 'bridge');
  const cmdDir = path.join(bridgeDir, 'commands');
  const resDir = path.join(bridgeDir, 'results');
  await fsp.mkdir(cmdDir, { recursive: true });
  await fsp.mkdir(resDir, { recursive: true });
  return { root, bridgeDir, cmdDir, resDir, quarantineDir: path.join(bridgeDir, 'quarantine') };
}

// A controllable clock: `now()` only moves when the bridge sleeps (or a test advances it), so a
// 30 s wait loop runs in microseconds and every age comparison is exact.
function fakeClock(start = T0) {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms) => { c.t += ms; await delay(0); },
  };
  return c;
}

const aliveProbe = () => ({ isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null });

function opts(dir, clock, extra = {}) {
  return {
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: aliveProbe(),
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir: dir.bridgeDir,
    autoLaunch: true,
    pollIntervalMs: 2,
    deadCheckIntervalMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
    pid: SENDER_PID,
    isPidAlive: () => true,
    ...extra,
  };
}

// A fake watcher launch: each call runs the next behaviour in `behaviours` (the last one repeats).
function fakeSpawner(dir, clock, behaviours) {
  const calls = [];
  const spawnWatcher = (bin, args) => {
    calls.push({ bin, args, commandsAtLaunch: fs.readdirSync(dir.cmdDir) });
    const b = behaviours[Math.min(calls.length - 1, behaviours.length - 1)];
    b({ dir, clock });
  };
  return { calls, spawnWatcher };
}
const startsAndStays = ({ dir, clock }) => fs.writeFileSync(path.join(dir.bridgeDir, 'heartbeat'), `idle ${clock.now()}`);
// The e2e failure: the watcher started, idled out and exited (writing last-stop and removing its
// heartbeat) before the bridge's liveness poll ever saw a heartbeat.
const comesAndGoes = ({ dir, clock }) => {
  fs.writeFileSync(path.join(dir.bridgeDir, 'last-stop'), `idle for 8s | ${clock.now()}`);
  fs.rmSync(path.join(dir.bridgeDir, 'heartbeat'), { force: true });
};
const neverStarts = () => {};

function writeForeignCommand(dir, name, cmd, mtimeMs) {
  const p = path.join(dir.cmdDir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(cmd));
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

// Answers the bridge's own command (the one file not in `foreign`) as a watcher would -- only once
// `ready()` holds (e.g. a watcher has been launched), since nothing consumes commands before that.
async function answerOwnCommand(dir, foreign = [], ready = () => true, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const own = ready() ? fs.readdirSync(dir.cmdDir).filter((f) => !foreign.includes(f)) : [];
    if (own.length) {
      const id = own[0].replace(/\.json$/, '');
      fs.writeFileSync(path.join(dir.resDir, `${id}.json`), JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'ok' } }));
      fs.rmSync(path.join(dir.cmdDir, own[0]), { force: true });
      return id;
    }
    await delay(2);
  }
  throw new Error('the bridge never wrote its own command');
}

// ---------------------------------------------------------------------------
// #1: stale commands never reach a newly launched watcher
// ---------------------------------------------------------------------------

test('#1 before launching a watcher, a foreign command older than the stale threshold is quarantined, not left to run', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const closeAll = { tool: 'run_script', id: 'old', parameters: { code: 'var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++)ws[i].forceClose();' } };
  // No timestamp, like the e2e file: its age comes from the file's mtime (2 h ago).
  writeForeignCommand(dir, 'old', closeAll, T0 - 2 * 3600_000);
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, ['old.json'], () => calls.length > 0);
  await p;

  assert.equal(calls.length, 1);
  assert.ok(!calls[0].commandsAtLaunch.includes('old.json'), 'the stale command must be gone before the watcher is launched');
  assert.ok(fs.existsSync(path.join(dir.quarantineDir, 'old.json')), 'moved aside for inspection, not silently deleted');
});

test('#1 a foreign command whose sender process is dead is quarantined however fresh it is', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  writeForeignCommand(dir, 'orphan', { id: 'orphan', tool: 'run_script', timestamp: new Date(T0 - 5000).toISOString(), senderPid: 999, parameters: { code: '1;' } });
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, isPidAlive: (pid) => pid !== 999 }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, ['orphan.json'], () => calls.length > 0);
  await p;

  assert.ok(!calls[0].commandsAtLaunch.includes('orphan.json'));
  assert.ok(fs.existsSync(path.join(dir.quarantineDir, 'orphan.json')));
});

test('#1 a fresh foreign command from a live sender is left alone (another session may be waiting on it)', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  writeForeignCommand(dir, 'peer', { id: 'peer', tool: 'list_open_images', timestamp: new Date(T0 - 10_000).toISOString(), senderPid: 777, parameters: {} });
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, ['peer.json'], () => calls.length > 0);
  await p;

  assert.ok(calls[0].commandsAtLaunch.includes('peer.json'));
  assert.ok(fs.existsSync(path.join(dir.cmdDir, 'peer.json')));
});

test('#1 an old foreign command is left alone while its sender process is alive (it may still be waiting behind a long launch)', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  writeForeignCommand(dir, 'slow', { id: 'slow', tool: 'run_script', timestamp: new Date(T0 - 20 * 60_000).toISOString(), senderPid: 777, parameters: {} });
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, isPidAlive: () => true }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, ['slow.json'], () => calls.length > 0);
  await p;

  assert.ok(fs.existsSync(path.join(dir.cmdDir, 'slow.json')), 'age alone must not quarantine a live sender\'s command');
});

test('#1 nothing is swept while a watcher is alive: queued commands may legitimately be waiting behind a long one', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(path.join(dir.bridgeDir, 'heartbeat'), `busy run_mgc ${T0 - 60_000}`);
  writeForeignCommand(dir, 'queued', { id: 'queued', tool: 'run_script', timestamp: new Date(T0 - 10 * 60_000).toISOString(), parameters: {} });
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, ['queued.json']);
  await p;

  assert.equal(calls.length, 0, 'a live watcher is not relaunched');
  assert.ok(fs.existsSync(path.join(dir.cmdDir, 'queued.json')));
});

test('#1 the bridge never quarantines its own pending command, however long it has waited', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  // First launch: the watcher starts, then "dies" without consuming anything.
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, pickupTimeoutMs: 4000, sendTimeoutMs: 24 * 3600_000 }));

  const p = ctx.pjsr('1;');
  while (calls.length < 1) await delay(2);
  const [own] = fs.readdirSync(dir.cmdDir);
  // Long past every stale threshold, and the heartbeat is now stale: the pickup check relaunches.
  clock.t += 60 * 60_000;
  while (calls.length < 2) await delay(2);
  assert.ok(calls[1].commandsAtLaunch.includes(own), 'its own command must still be there for the relaunched watcher');
  assert.ok(!fs.existsSync(path.join(dir.quarantineDir, own)));
  await answerOwnCommand(dir);
  await p;
});

test('#1 commands carry the sender pid and an ISO timestamp, so both sides can judge staleness', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, { autoLaunch: false }));

  const p = ctx.pjsr('1;');
  let files = [];
  while (!files.length) { files = fs.readdirSync(dir.cmdDir); await delay(2); }
  const cmd = JSON.parse(fs.readFileSync(path.join(dir.cmdDir, files[0]), 'utf8'));
  assert.equal(cmd.senderPid, SENDER_PID);
  assert.equal(cmd.timestamp, new Date(T0).toISOString());
  await answerOwnCommand(dir);
  await p;
});

test('#1 a send that times out removes its own command, so no later watcher runs what the caller gave up on', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, { autoLaunch: false, sendTimeoutMs: 1000 }));

  const p = ctx.pjsr('1;');
  while (!fs.readdirSync(dir.cmdDir).length) await delay(2);
  clock.t += 5000;
  await assert.rejects(p, /Timeout/);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

test('#1 a mid-command crash removes the command too, so the retry the error asks for cannot run it twice', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, {
    autoLaunch: false,
    deadCheckIntervalMs: 0,
    probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null },
  }));

  await assert.rejects(ctx.pjsr('1;'), /crashed/);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

// ---------------------------------------------------------------------------
// #2: the false "Watcher did not start within 30s"
// ---------------------------------------------------------------------------

test('#2 the command is on disk before the watcher is launched, so the watcher\'s first look (and its idle-exit last look) sees it', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, [], () => calls.length > 0);
  await p;
  assert.equal(calls[0].commandsAtLaunch.length, 1);
});

test('#2 a watcher that started and idled out before its heartbeat was seen is relaunched, not reported as "did not start"', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const logs = [];
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [comesAndGoes, startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, log: (m) => logs.push(m) }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, [], () => calls.length > 1);
  const r = await p;

  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 2);
  assert.ok(logs.some((l) => /exited .*idle for 8s.*relaunch/i.test(l)), logs.join('\n'));
});

test('#2 a Pause/Abort pressed while the launched watcher was starting is a deliberate stop, not a relaunch', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const aborts = ({ dir: d, clock: c }) => fs.writeFileSync(path.join(d.bridgeDir, 'last-stop'), `abort requested | ${c.now()}`);
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [aborts]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  await assert.rejects(ctx.pjsr('1;'), (e) => e instanceof BridgeAbortError);
  assert.equal(calls.length, 1);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), [], 'an aborted command must not be left for a later watcher');
});

test('#2 relaunching is bounded: a watcher that keeps exiting produces an error, not a loop', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [comesAndGoes]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  await assert.rejects(ctx.pjsr('1;'), /exited/i);
  assert.ok(calls.length >= 2 && calls.length <= 3, `expected a bounded number of launches, got ${calls.length}`);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

test('#2 a real "did not start" timeout says what was checked: launches, heartbeat, last-stop and whether PixInsight was running', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(path.join(dir.bridgeDir, 'last-stop'), `idle for 8s | ${T0 - 3600_000}`);
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [neverStarts]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  await assert.rejects(ctx.pjsr('1;'), (e) => {
    assert.match(e.message, /did not start within 30s/);
    assert.match(e.message, /heartbeat: never seen/i);
    assert.match(e.message, /last-stop: "idle for 8s", 3600s before the launch/i);
    assert.match(e.message, /PixInsight running: yes/i);
    assert.match(e.message, /launches: 1/i);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

// ---------------------------------------------------------------------------
// Fix round 1: a watcher stalled in its start-up UI work must not be launched twice
// ---------------------------------------------------------------------------

// Mirrors the reviewer's repro: the watcher writes its early heartbeat, then stalls ~6 s (showing
// the console, first event pump) without refreshing it, then consumes the command.
function stallingWatcher(dir, clock, state) {
  return ({ dir: d, clock: c }) => {
    fs.writeFileSync(path.join(d.bridgeDir, 'heartbeat'), `${state} ${c.now()}`);
    setTimeout(() => { c.t += 6000; }, 20);
  };
}

test('fix1 a watcher that writes its start-up heartbeat and stalls 6 s is launched exactly once', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [stallingWatcher(dir, clock, 'starting')]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await delay(120); // well past the stall; the bridge polls every 2 ms meanwhile
  await answerOwnCommand(dir, [], () => calls.length > 0);
  await p;
  assert.equal(calls.length, 1);
});

test('fix1 the pickup timeout counts from when the watcher was seen alive, not from the command write', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  // The launch takes 10 s (e.g. PixInsight autostart), and the bridge first sees the heartbeat
  // when it is already 3 s old.
  const slowLaunch = ({ dir: d, clock: c }) => {
    c.t += 10_000;
    fs.writeFileSync(path.join(d.bridgeDir, 'heartbeat'), `idle ${c.now()}`);
    c.t += 3000;
  };
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [slowLaunch]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  while (calls.length < 1) await delay(1);
  // 2.5 s after the bridge saw the watcher (15.5 s after the write) its heartbeat is 5.5 s old, a
  // single slow pump. Inside the pickup window counted from readiness, so no relaunch; counted from
  // the write, the window had long expired and a second watcher was launched.
  clock.t += 2500;
  await delay(30);
  assert.equal(calls.length, 1, 'no second launch while the watcher is alive');
  await answerOwnCommand(dir);
  await p;
});

test('fix1 a start-up heartbeat older than the start-up grace no longer counts as alive', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(path.join(dir.bridgeDir, 'heartbeat'), `starting ${T0 - 10 * 60_000}`);
  const { calls, spawnWatcher } = fakeSpawner(dir, clock, [startsAndStays]);
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir, [], () => calls.length > 0);
  await p;
  assert.equal(calls.length, 1, 'a leftover "starting" from a watcher that died while starting is not alive');
});

// A result file that cannot be deleted (EBUSY/EPERM on Windows) must not strand the caller.
test('fix1 a result whose file cannot be deleted still resolves the send', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, {
    autoLaunch: false,
    unlink: () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; },
  }));

  const p = ctx.pjsr('1;');
  await answerOwnCommand(dir);
  const r = await Promise.race([p, delay(1000).then(() => 'HUNG')]);
  assert.notEqual(r, 'HUNG');
  assert.equal(r.status, 'ok');
});
