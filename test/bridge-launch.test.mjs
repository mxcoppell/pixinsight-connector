// Fix round 2 (live checks against real PixInsight), bridge side, with an injected clock, sleep,
// spawn, pid-liveness and (where a read must be intercepted) an injected fs wrapping the real one
// over a throwaway temp bridge directory. No PixInsight.
//
//  A  Two MCP servers made their first call ~250 ms apart with no watcher alive: both spawned
//     `PixInsight -x`, PixInsight queued the second until the first watcher exited, and the second
//     found the single shared idle_exit_ms already consumed and stayed resident (UI locked).
//  B  The watcher rewrites `heartbeat` by truncate-then-write; a read landing in between saw an empty
//     file, which counted as "no watcher" and could trigger a duplicate launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, BridgeCrashError } from '../src/bridge.mjs';

const T0 = 1_800_000_000_000;

async function makeBridgeDir(t) {
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-launch-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bridgeDir = path.join(root, 'bridge');
  const cmdDir = path.join(bridgeDir, 'commands');
  const resDir = path.join(bridgeDir, 'results');
  await fsp.mkdir(cmdDir, { recursive: true });
  await fsp.mkdir(resDir, { recursive: true });
  return {
    bridgeDir, cmdDir, resDir,
    heartbeat: path.join(bridgeDir, 'heartbeat'),
    lock: path.join(bridgeDir, 'launch.lock'),
    launches: path.join(bridgeDir, 'launches'),
  };
}

function fakeClock(start = T0) {
  const c = { t: start, now: () => c.t, sleep: async (ms) => { c.t += ms; await delay(0); } };
  return c;
}

const probe = (running = true) => ({ isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null });

function opts(dir, clock, extra = {}) {
  return {
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: probe(),
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir: dir.bridgeDir,
    autoLaunch: true,
    pollIntervalMs: 2,
    deadCheckIntervalMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
    pid: 4242,
    isPidAlive: () => true,
    ...extra,
  };
}

// Answers every command in commands/ as a watcher would, once `ready()` holds.
async function answerAll(dir, n, ready = () => true, timeoutMs = 3000) {
  const t0 = Date.now();
  let answered = 0;
  while (answered < n && Date.now() - t0 < timeoutMs) {
    if (ready()) {
      for (const f of fs.readdirSync(dir.cmdDir).filter((x) => x.endsWith('.json'))) {
        fs.writeFileSync(path.join(dir.resDir, f), JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'ok' } }));
        fs.rmSync(path.join(dir.cmdDir, f), { force: true });
        answered++;
      }
    }
    await delay(2);
  }
  if (answered < n) throw new Error(`answered ${answered} of ${n}`);
}

// ---------------------------------------------------------------------------
// A1: at most one `-x` launch across every server sharing the bridge directory
// ---------------------------------------------------------------------------

test('A two servers whose first calls race with no watcher alive launch exactly one watcher between them', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const spawns = [];
  // The launched watcher takes a moment to come up, as in the live run.
  const spawnWatcher = () => {
    spawns.push(clock.now());
    setTimeout(() => fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`), 15);
  };
  const a = createBridge(opts(dir, clock, { spawnWatcher, pid: 1001 }));
  const b = createBridge(opts(dir, clock, { spawnWatcher, pid: 1002 }));

  const pa = a.pjsr('1;');
  const pb = b.pjsr('2;');
  await answerAll(dir, 2, () => spawns.length > 0 && fs.existsSync(dir.heartbeat));
  await Promise.all([pa, pb]);

  assert.equal(spawns.length, 1, 'the second server must wait for the first launch, not spawn its own -x');
  assert.equal(fs.existsSync(dir.lock), false, 'the launch lock is released once the watcher is seen alive');
});

test('A a launch lock left by a dead process is taken over at once', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.lock, JSON.stringify({ pid: 999, token: 'x', at: clock.now() }));
  const spawns = [];
  const spawnWatcher = () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); };
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, isPidAlive: (pid) => pid !== 999 }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(spawns.length, 1);
  assert.equal(fs.existsSync(dir.lock), false);
});

test('A a launch lock held longer than any launch can take is taken over, even if its holder is alive', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.lock, JSON.stringify({ pid: 777, token: 'x', at: clock.now() - 10 * 60_000 }));
  const spawns = [];
  const spawnWatcher = () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); };
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(spawns.length, 1);
});

test('A while another live server holds a fresh lock, this one waits and launches nothing if a watcher comes up', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.lock, JSON.stringify({ pid: 777, token: 'theirs', at: clock.now() }));
  const spawns = [];
  const ctx = createBridge(opts(dir, clock, { spawnWatcher: () => spawns.push(1) }));

  const p = ctx.pjsr('1;');
  await delay(20);
  assert.equal(spawns.length, 0);
  // The other server's watcher comes up (and it releases its lock).
  fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`);
  fs.rmSync(dir.lock);
  await answerAll(dir, 1);
  await p;
  assert.equal(spawns.length, 0);
});

test('A the lock is released when a launch gives up, and never deletes a lock another server now holds', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, { spawnWatcher: () => {} })); // watcher never starts

  await assert.rejects(ctx.pjsr('1;'), /did not start/);
  assert.equal(fs.existsSync(dir.lock), false, 'released after the launch gave up');

  // Another server took the lock over meanwhile: this server's release must leave it alone.
  let taken = false;
  const spawnWatcher = () => {
    if (!taken) { taken = true; fs.writeFileSync(dir.lock, JSON.stringify({ pid: 5, token: 'someone-else', at: clock.now() })); }
    fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`);
  };
  const ctx2 = createBridge(opts(dir, clock, { spawnWatcher }));
  const p = ctx2.pjsr('1;');
  await answerAll(dir, 1, () => taken);
  await p;
  assert.equal(JSON.parse(fs.readFileSync(dir.lock, 'utf8')).token, 'someone-else');
});

// ---------------------------------------------------------------------------
// A2: every connector launch carries its own linger ticket; nothing shared is consumed
// ---------------------------------------------------------------------------

test('A each launch writes its own linger ticket in bridge/launches/ and no shared idle_exit_ms', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const seen = [];
  // First launch comes and goes (so a second is needed); the second stays.
  let n = 0;
  const spawnWatcher = () => {
    n++;
    seen.push(fs.readdirSync(dir.launches));
    if (n === 1) fs.writeFileSync(path.join(dir.bridgeDir, 'last-stop'), `idle for 8s | ${clock.now()}`);
    else fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`);
  };
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, lingerMs: 1234 }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => n > 1);
  await p;

  assert.equal(seen[0].length, 1, 'a ticket exists when the first -x is spawned');
  assert.equal(seen[1].length, 2, 'the relaunch adds its own ticket (the fake watcher consumed none)');
  const ticket = JSON.parse(fs.readFileSync(path.join(dir.launches, seen[0][0]), 'utf8'));
  assert.equal(ticket.lingerMs, 1234);
  assert.equal(typeof ticket.at, 'number');
  assert.equal(fs.existsSync(path.join(dir.bridgeDir, 'idle_exit_ms')), false);
});

// ---------------------------------------------------------------------------
// B: a torn (empty) heartbeat read is "unknown, read again", never "dead"
// ---------------------------------------------------------------------------

// Wraps the real fs; the first `tornReads` reads of the heartbeat return what a reader sees in the
// middle of the watcher's truncate-then-write.
function tornFs(heartbeat, tornReads, content = '') {
  let left = tornReads;
  return {
    ...fs,
    readFileSync(p, ...rest) {
      if (p === heartbeat && left > 0 && fs.existsSync(p)) { left--; return content; }
      return fs.readFileSync(p, ...rest);
    },
  };
}

test('B an empty heartbeat read while the watcher rewrites it does not launch a second watcher', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`);
  const spawns = [];
  // Two torn reads in a row: the first liveness check and the re-check made after taking the lock.
  const ctx = createBridge(opts(dir, clock, { fs: tornFs(dir.heartbeat, 2), spawnWatcher: () => spawns.push(1) }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1);
  await p;
  assert.equal(spawns.length, 0);
});

test('B a heartbeat that stays unreadable across the re-reads is treated as no watcher', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.heartbeat, 'garbage');
  const spawns = [];
  const spawnWatcher = () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); };
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(spawns.length, 1);
});

// ---------------------------------------------------------------------------
// Minors from the round-1 re-review
// ---------------------------------------------------------------------------

test('a leftover "starting" beat does not count as alive once PixInsight is confirmed not running', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.heartbeat, `starting ${clock.now() - 1000}`);
  let running = false;
  const autostarts = [];
  const spawns = [];
  const ctx = createBridge(opts(dir, clock, {
    probe: { isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null },
    spawn: () => { autostarts.push(1); running = true; return { unref() {} }; },
    spawnWatcher: () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(autostarts.length, 1, 'PixInsight is started instead of waiting on a dead start-up beat');
  assert.equal(spawns.length, 1);
});

test('a "starting" beat older than the running PixInsight process does not count as alive', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.heartbeat, `starting ${clock.now() - 2000}`);
  const spawns = [];
  const ctx = createBridge(opts(dir, clock, {
    probe: { isRunning: async () => true, startedAt: async () => clock.now() - 1000, memoryMB: async () => null },
    spawnWatcher: () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(spawns.length, 1);
});

test('a watcher that keeps dying during start-up is relaunched a bounded number of times per send, then a diagnosed error', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const spawns = [];
  // Each launch writes its start-up beat and then dies silently (no last-stop, no refresh).
  const spawnWatcher = () => { spawns.push(clock.now()); fs.writeFileSync(dir.heartbeat, `starting ${clock.now()}`); };
  const tick = setInterval(() => { clock.t += 1000; }, 1);
  t.after(() => clearInterval(tick));
  const ctx = createBridge(opts(dir, clock, { spawnWatcher, pollIntervalMs: 1 }));

  await assert.rejects(ctx.pjsr('1;'), (e) => {
    assert.match(e.message, /relaunched/i);
    assert.match(e.message, /Checked:/);
    assert.doesNotMatch(e.message, /^Timeout/);
    return true;
  });
  assert.ok(spawns.length >= 2 && spawns.length <= 5, `bounded launches per send, got ${spawns.length}`);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

test('a leftover start-up beat never makes a send fail with BridgeCrashError while PixInsight can be started', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(dir.heartbeat, `starting ${clock.now()}`);
  let running = false;
  const ctx = createBridge(opts(dir, clock, {
    probe: { isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null },
    spawn: () => { running = true; return { unref() {} }; },
    spawnWatcher: () => fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`),
  }));
  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => running);
  const r = await p.catch((e) => e);
  assert.ok(!(r instanceof BridgeCrashError), String(r?.message));
});

// A watcher claims a command by renaming it to <id>.running before running it. If PixInsight dies
// mid-command that file is left behind; with no watcher alive it is a leftover, never re-run.
test('before a launch, claimed .running leftovers are moved to quarantine with the other orphans', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.writeFileSync(path.join(dir.cmdDir, 'dead.running'), JSON.stringify({ id: 'dead', tool: 'run_script', timestamp: new Date(clock.now()).toISOString() }));
  const spawns = [];
  const spawnWatcher = () => { spawns.push(fs.readdirSync(dir.cmdDir)); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); };
  const ctx = createBridge(opts(dir, clock, { spawnWatcher }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.ok(!spawns[0].includes('dead.running'));
  assert.ok(fs.existsSync(path.join(dir.bridgeDir, 'quarantine', 'dead.running')));
});

test('a send that gives up also removes its command if a watcher had already claimed it', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ctx = createBridge(opts(dir, clock, { autoLaunch: false, sendTimeoutMs: 1000 }));

  const p = ctx.pjsr('1;');
  let files = [];
  while (!files.length) { files = fs.readdirSync(dir.cmdDir); await delay(2); }
  const id = files[0].replace(/\.json$/, '');
  fs.renameSync(path.join(dir.cmdDir, files[0]), path.join(dir.cmdDir, `${id}.running`)); // a watcher claimed it
  fs.writeFileSync(dir.heartbeat, `busy run_script ${clock.now()}`); // ...and is still running it
  clock.t += 5000;
  await assert.rejects(p, /Timeout/);
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

// ---------------------------------------------------------------------------
// Fix round 3
// ---------------------------------------------------------------------------

test('R3 a server that waited on the launch lock does not relaunch a watcher the user aborted while it was starting', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const spawns = [];
  const spawnWatcher = () => {
    spawns.push(clock.now());
    if (spawns.length === 1) setTimeout(() => fs.writeFileSync(path.join(dir.bridgeDir, 'last-stop'), `abort requested | ${clock.now()}`), 5);
  };
  const a = createBridge(opts(dir, clock, { spawnWatcher, pid: 1 }));
  const b = createBridge(opts(dir, clock, { spawnWatcher, pid: 2 }));

  const results = await Promise.allSettled([a.pjsr('1;'), b.pjsr('2;')]);
  assert.equal(spawns.length, 1, 'an abort is never silently undone by a second server');
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason?.name, 'BridgeAbortError');
  }
});

test('R3 autostarting a fresh PixInsight clears every leftover linger ticket (nothing can be queued in a new process)', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.mkdirSync(dir.launches, { recursive: true });
  fs.writeFileSync(path.join(dir.launches, `${clock.now() - 1000}-spare.json`), JSON.stringify({ lingerMs: 8000, at: clock.now() - 1000, pid: 1 }));
  let running = false;
  const seen = [];
  const ctx = createBridge(opts(dir, clock, {
    probe: { isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null },
    spawn: () => { running = true; return { unref() {} }; },
    spawnWatcher: () => { seen.push(fs.readdirSync(dir.launches)); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => seen.length > 0);
  await p;
  assert.equal(seen[0].length, 1, 'only this launch\'s own ticket is left');
  assert.ok(!seen[0].some((f) => f.includes('spare')));
});

test('R3 tickets written before the running PixInsight process started are removed; later ones are kept', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.mkdirSync(dir.launches, { recursive: true });
  fs.writeFileSync(path.join(dir.launches, `${clock.now() - 5000}-before.json`), JSON.stringify({ lingerMs: 8000, at: clock.now() - 5000, pid: 1 }));
  fs.writeFileSync(path.join(dir.launches, `${clock.now() - 500}-after.json`), JSON.stringify({ lingerMs: 8000, at: clock.now() - 500, pid: 1 }));
  const seen = [];
  const ctx = createBridge(opts(dir, clock, {
    probe: { isRunning: async () => true, startedAt: async () => clock.now() - 1000, memoryMB: async () => null },
    spawnWatcher: () => { seen.push(fs.readdirSync(dir.launches)); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => seen.length > 0);
  await p;
  assert.ok(!seen[0].some((f) => f.includes('before')), 'a ticket for a previous PixInsight process can never be used');
  assert.ok(seen[0].some((f) => f.includes('after')), 'a ticket for a launch this process may still run is kept');
});

test('R3 a ticket is written to a temp name and renamed into place, so a watcher never reads half of one', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const ops = [];
  const recordingFs = {
    ...fs,
    writeFileSync(p, ...rest) { if (String(p).startsWith(dir.launches)) ops.push(`write ${path.basename(p)}`); return fs.writeFileSync(p, ...rest); },
    renameSync(a, b) { if (String(a).startsWith(dir.launches)) ops.push(`rename ${path.basename(a)} -> ${path.basename(b)}`); return fs.renameSync(a, b); },
  };
  const spawns = [];
  const ctx = createBridge(opts(dir, clock, {
    fs: recordingFs,
    spawnWatcher: () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  await answerAll(dir, 1, () => spawns.length > 0);
  await p;
  assert.equal(ops.length, 2, ops.join('\n'));
  assert.match(ops[0], /^write .*\.tmp$/);
  assert.match(ops[1], /^rename .*\.tmp -> .*\.json$/);
});

test('R3 a claimed command whose watcher died fails the send fast with a clear error, and is never re-run', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const spawns = [];
  const ctx = createBridge(opts(dir, clock, {
    spawnWatcher: () => { spawns.push(1); fs.writeFileSync(dir.heartbeat, `idle ${clock.now()}`); },
  }));

  const p = ctx.pjsr('1;');
  while (spawns.length < 1) await delay(1);
  let files = [];
  while (!files.length) { files = fs.readdirSync(dir.cmdDir).filter((f) => f.endsWith('.json')); await delay(1); }
  const id = files[0].replace(/\.json$/, '');
  // The watcher claims it, starts running it, and dies (PixInsight itself keeps running).
  fs.renameSync(path.join(dir.cmdDir, files[0]), path.join(dir.cmdDir, `${id}.running`));
  fs.rmSync(dir.heartbeat);
  clock.t += 10_000;

  await assert.rejects(p, (e) => {
    assert.match(e.message, /stopped while running this command/i);
    assert.match(e.message, /not re-run/i);
    return true;
  });
  assert.equal(spawns.length, 1, 'a claimed command never triggers a relaunch');
  assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
});

// ---------------------------------------------------------------------------
// ws7: PixInsight splits `-x=<arg>` at the first comma; `"` would end its quoted path
// ---------------------------------------------------------------------------

for (const [label, bad, rx] of [['a comma', 'T,two', /containing a comma/], ['a double quote', 'T"q', /containing a double quote/]]) {
  test(`a watcher path with ${label} is never passed to -x: the send fails at once, before PixInsight is started or a ticket written`, async (t) => {
    const dir = await makeBridgeDir(t);
    const clock = fakeClock();
    const spawned = [];
    let autostarted = 0;
    const ctx = createBridge(opts(dir, clock, {
      watcherPath: path.join(path.dirname(dir.bridgeDir), bad, 'watcher.js'),
      probe: probe(false),
      spawn: () => { autostarted++; return { unref() {} }; },
      spawnWatcher: (bin, args) => { spawned.push(args); },
    }));
    const t0 = clock.now();
    await assert.rejects(ctx.pjsr('1;'), (e) => {
      assert.match(e.message, rx);
      assert.ok(e.message.includes(bad), 'names the path');
      return true;
    });
    assert.ok(clock.now() - t0 < 1000, 'no start-up wait');
    assert.deepEqual(spawned, []);
    assert.equal(autostarted, 0, 'PixInsight is not started for a launch that cannot work');
    assert.equal(fs.existsSync(dir.launches) ? fs.readdirSync(dir.launches).length : 0, 0);
    assert.deepEqual(fs.readdirSync(dir.cmdDir), []);
  });
}

// ---------------------------------------------------------------------------
// ws7: a launch that gives up leaves no ticket behind when nothing can still be queued
// ---------------------------------------------------------------------------

const ticketsIn = (dir) => (fs.existsSync(dir.launches) ? fs.readdirSync(dir.launches) : []);

test('a watcher that never starts, with PixInsight gone by the time the wait gives up: this launch\'s ticket is removed', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  let launchedAt = null;
  const ctx = createBridge(opts(dir, clock, {
    // Running for the launch; confirmed not running once the 30 s wait is over (it quit, or crashed).
    probe: { isRunning: async () => launchedAt === null || clock.now() - launchedAt < 30_000, startedAt: async () => null, memoryMB: async () => null },
    spawnWatcher: () => { launchedAt = clock.now(); assert.equal(ticketsIn(dir).length, 1, 'the ticket exists while the launch is pending'); },
  }));
  await assert.rejects(ctx.pjsr('1;'));
  assert.notEqual(launchedAt, null);
  assert.deepEqual(ticketsIn(dir), []);
});

test('a watcher launch whose spawn fails leaves no ticket behind', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  const { EventEmitter } = await import('node:events');
  const ctx = createBridge(opts(dir, clock, {
    spawnWatcher: () => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    },
  }));
  await assert.rejects(ctx.pjsr('1;'), /could not be launched/);
  assert.deepEqual(ticketsIn(dir), []);
});

test('a watcher that never starts while PixInsight keeps running: its ticket is kept for the watcher PixInsight may still have queued, and only this launch\'s', async (t) => {
  const dir = await makeBridgeDir(t);
  const clock = fakeClock();
  fs.mkdirSync(dir.launches, { recursive: true });
  const other = `${clock.now() - 100}-other.json`;
  fs.writeFileSync(path.join(dir.launches, other), JSON.stringify({ lingerMs: 8000, at: clock.now() - 100, pid: 1 }));
  const ctx = createBridge(opts(dir, clock, { spawnWatcher: () => {} }));
  await assert.rejects(ctx.pjsr('1;'), /did not start within 30s/);
  // Removing it would make a queued watcher that starts later find no ticket and stay resident.
  assert.equal(ticketsIn(dir).length, 2);
  assert.ok(ticketsIn(dir).includes(other));
});
