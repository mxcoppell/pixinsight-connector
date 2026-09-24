import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, BridgeAbortError, BridgeCrashError } from '../src/bridge.mjs';

// A probe that never confirms anything ("this OS can't answer").
function nullProbe() {
  return { isRunning: async () => null, startedAt: async () => null, memoryMB: async () => null };
}

async function makeBridgeDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-test-'));
  const bridgeDir = path.join(root, 'bridge');
  const cmdDir = path.join(bridgeDir, 'commands');
  const resDir = path.join(bridgeDir, 'results');
  await fs.mkdir(cmdDir, { recursive: true });
  await fs.mkdir(resDir, { recursive: true });
  return { root, bridgeDir, cmdDir, resDir };
}

function baseOpts(dir, extra = {}) {
  return {
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: nullProbe(),
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir: dir.bridgeDir,
    autoLaunch: false,
    pollIntervalMs: 5,
    deadCheckIntervalMs: 10,
    ...extra,
  };
}

async function waitForFile(dirPath, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const files = await fs.readdir(dirPath);
    if (files.length) return files;
    await delay(5);
  }
  throw new Error(`timed out waiting for a file in ${dirPath}`);
}

// ---------------------------------------------------------------------------
// Step 2 tests
// ---------------------------------------------------------------------------

test('send writes a command file and resolves with a planted result', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null } }));

  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [cmdFileName] = await waitForFile(dir.cmdDir);
  const cmdContent = JSON.parse(await fs.readFile(path.join(dir.cmdDir, cmdFileName), 'utf8'));
  assert.equal(cmdContent.tool, 'run_script');
  assert.equal(cmdContent.process, '__script__');

  const id = cmdFileName.replace(/\.json$/, '');
  await fs.writeFile(
    path.join(dir.resDir, `${id}.json`),
    JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'hi' } })
  );

  const result = await p;
  assert.equal(result.status, 'ok');
  assert.equal(result.outputs.consoleOutput, 'hi');
  // the result file is consumed
  assert.deepEqual(await fs.readdir(dir.resDir), []);
});

test('a last-stop of "abort requested" newer than context creation throws BridgeAbortError', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { autoLaunch: true }));
  // write it after ctx creation so its timestamp is >= createdAt
  await fs.writeFile(path.join(dir.bridgeDir, 'last-stop'), `abort requested | ${Date.now()}`);

  await assert.rejects(() => ctx.pjsr('1;'), (err) => err instanceof BridgeAbortError);
});

test('a last-stop of "shutdown file" newer than context creation throws BridgeAbortError', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { autoLaunch: true }));
  await fs.writeFile(path.join(dir.bridgeDir, 'last-stop'), `shutdown file | ${Date.now()}`);

  await assert.rejects(() => ctx.pjsr('1;'), (err) => err instanceof BridgeAbortError);
});

test('a last-stop of "idle for 8s" does not throw BridgeAbortError', async () => {
  const dir = await makeBridgeDir();
  // probe confirms the process is gone, so ensureWatcher takes the
  // BridgeCrashError branch (not spawn+wait) -- fast and deterministic,
  // and proves the idle reason was not mistaken for an abort. `env` declines
  // the new "start PixInsight itself" step so this stays a pure, fast
  // liveness-check test rather than exercising a real spawn attempt.
  const ctx = createBridge(
    baseOpts(dir, {
      autoLaunch: true,
      probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null },
      env: { PIXINSIGHT_CONNECTOR_AUTOSTART: '0' },
    })
  );
  await fs.writeFile(path.join(dir.bridgeDir, 'last-stop'), `idle for 8s | ${Date.now()}`);

  await assert.rejects(() => ctx.pjsr('1;'), (err) => err instanceof BridgeCrashError && !(err instanceof BridgeAbortError));
});

test('an ensurePixInsight timeout is folded into BridgeCrashError, not surfaced as a bare Error', async () => {
  const dir = await makeBridgeDir();
  // Autostart is enabled (no PIXINSIGHT_CONNECTOR_AUTOSTART=0) and the stub spawn never makes the
  // probe report alive, so ensurePixInsight itself times out and throws a plain Error. A tiny
  // autostartTimeoutMs keeps that fast instead of waiting the real 90s default.
  const ctx = createBridge(
    baseOpts(dir, {
      autoLaunch: true,
      platform: { piBin: '/fake/PixInsight' },
      probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null },
      spawn: () => ({ unref() {} }),
      autostartTimeoutMs: 10,
    })
  );

  await assert.rejects(() => ctx.pjsr('1;'), (err) => err instanceof BridgeCrashError && /PIXINSIGHT_BIN/.test(err.message));
});

test('a probe whose isRunning() returns null never produces BridgeCrashError', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir)); // nullProbe from baseOpts default

  const p = ctx.pjsr('1;');
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; }
  );

  // let several dead-check cycles elapse (deadCheckIntervalMs: 10, so this
  // is dozens of opportunities to (wrongly) declare a crash)
  await delay(150);
  assert.equal(settled, false, 'must not have rejected (with a crash error or otherwise) while the probe only returns null');

  // let it finish cleanly so no interval is left running
  const [cmdFileName] = await fs.readdir(dir.cmdDir);
  const id = cmdFileName.replace(/\.json$/, '');
  await fs.writeFile(
    path.join(dir.resDir, `${id}.json`),
    JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'done' } })
  );
  const result = await p;
  assert.equal(result.status, 'ok');
});

test('two consecutive failed liveness checks (safety property) reject with BridgeCrashError', async () => {
  const dir = await makeBridgeDir();
  let calls = 0;
  const ctx = createBridge(
    baseOpts(dir, { probe: { isRunning: async () => { calls++; return false; }, startedAt: async () => null, memoryMB: async () => null } })
  );

  await assert.rejects(() => ctx.pjsr('1;'), (err) => err instanceof BridgeCrashError);
  assert.ok(calls >= 2, 'expected at least two liveness checks before declaring a crash');
});

test('a mid-command crash tells the caller to retry (autostart covers it next time), not to run a nonexistent --resume --run-id flag', async () => {
  // Regression test: the old message here pointed at `--resume --run-id <runId>`, a flag that
  // belongs to the legacy batch-pipeline tooling (v0-pipeline:agents/llm/giga-run.mjs / v0-pipeline:scripts/run-pipeline.mjs), not
  // this connector's CLI (serve/doctor/install only). Now that server.mjs's dispatch surfaces
  // e.message verbatim to an MCP client, this text must be accurate: the next send()/pjsr() call
  // re-enters ensureWatcher(), which now autostarts PixInsight, so "retry" is the correct guidance.
  const dir = await makeBridgeDir();
  const ctx = createBridge(
    baseOpts(dir, { probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null } })
  );

  await assert.rejects(
    () => ctx.pjsr('1;'),
    (err) => {
      assert.ok(err instanceof BridgeCrashError);
      assert.match(err.message, /started again automatically/i);
      assert.match(err.message, /retry/i);
      assert.doesNotMatch(err.message, /--run-id/, 'the nonexistent legacy CLI flag must not be referenced');
      return true;
    }
  );
});

test('a single failed liveness check alone does not crash (needs two consecutive)', async () => {
  const dir = await makeBridgeDir();
  let n = 0;
  const ctx = createBridge(
    baseOpts(dir, {
      probe: {
        isRunning: async () => { n++; return n === 1 ? false : true; },
        startedAt: async () => null,
        memoryMB: async () => null,
      },
    })
  );

  const p = ctx.pjsr('1;');
  await delay(80);
  const [cmdFileName] = await fs.readdir(dir.cmdDir);
  const id = cmdFileName.replace(/\.json$/, '');
  await fs.writeFile(
    path.join(dir.resDir, `${id}.json`),
    JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'ok' } })
  );
  const result = await p;
  assert.equal(result.status, 'ok');
  assert.ok(n >= 2, 'expected the liveness check to run more than once');
});

test('the bridge exposes only what the server uses (no checkMemory, ping, detectNewImages or a shared console buffer)', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir));
  // setBridgeDir: the server re-points the bridge when the workspace changes.
  assert.deepEqual(Object.keys(ctx).sort(), ['listImages', 'log', 'pjsr', 'send', 'setBridgeDir']);
});

test('a deliberate stop points at resume_bridge, not the nonexistent --resume --run-id flag', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { autoLaunch: true }));
  await fs.writeFile(path.join(dir.bridgeDir, 'last-stop'), `abort requested | ${Date.now()}`);

  await assert.rejects(() => ctx.pjsr('1;'), (err) => {
    assert.ok(err instanceof BridgeAbortError);
    assert.match(err.message, /resume_bridge/);
    assert.doesNotMatch(err.message, /--run-id|--resume/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// M8: AUTOLAUNCH / LINGER_MS come from the injected env, never process.env, and everything the bridge
// reads or writes is inside the target's bridge dir. The fs is fenced to that dir, so a regression
// fails here instead of writing anywhere else (the home directory included).
// ---------------------------------------------------------------------------

function fencedFs(root) {
  const inside = (p) => path.resolve(String(p)).startsWith(path.resolve(root));
  const fence = (name) => (...args) => {
    if (!inside(args[0])) throw new Error(`${name} outside the test home: ${args[0]}`);
    return fsSync[name](...args);
  };
  return Object.fromEntries(['readFileSync', 'writeFileSync', 'mkdirSync', 'readdirSync', 'statSync', 'existsSync', 'rmSync', 'renameSync', 'unlinkSync']
    .map((n) => [n, fence(n)]));
}

test('PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0 comes from the injected env, and nothing is touched outside the bridge dir', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-home-'));
  let launched = 0;
  const bridgeDir = path.join(home, 'target', 'agentic', 'bridge', 'rig');
  const ctx = createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null },
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir,
    env: { PIXINSIGHT_CONNECTOR_AUTOLAUNCH: '0' },
    fs: fencedFs(bridgeDir),
    spawnWatcher: () => { launched++; throw new Error('watcher launched'); },
    pollIntervalMs: 5,
  });
  const cmdDir = path.join(bridgeDir, 'commands');
  const resDir = path.join(bridgeDir, 'results');
  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [name] = await waitForFile(cmdDir);
  await fs.writeFile(path.join(resDir, name), JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'hi' } }));
  const r = await p;
  assert.equal(r.outputs.consoleOutput, 'hi');
  assert.equal(launched, 0, 'autolaunch was disabled by the injected env');
  assert.deepEqual((await fs.readdir(home)).sort(), ['target']);
});

test('PIXINSIGHT_CONNECTOR_LINGER_MS comes from the injected env, and the ticket goes to the bridge dir', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-home-'));
  const bridgeDir = path.join(home, 'target', 'agentic', 'bridge', 'rig');
  const ctx = createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null },
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir,
    env: { PIXINSIGHT_CONNECTOR_LINGER_MS: '1234' },
    fs: fencedFs(bridgeDir),
    spawnWatcher: () => { throw new Error('stop after the ticket is written'); },
    pollIntervalMs: 5,
  });
  await assert.rejects(ctx.send('run_script', '__script__', { code: '1;' }), /stop after the ticket/);
  const launches = path.join(bridgeDir, 'launches');
  const [ticket] = await fs.readdir(launches);
  assert.equal(JSON.parse(await fs.readFile(path.join(launches, ticket), 'utf8')).lingerMs, 1234);
});

// ---------------------------------------------------------------------------
// I7: a command is written under a name the watcher's *.json scan cannot see, then renamed, and a
// command that disappears without a claim or a result fails the send fast instead of after 20 min.
// ---------------------------------------------------------------------------

function recordingFs(ops) {
  return {
    ...fsSync,
    writeFileSync: (p, ...rest) => { ops.push(['write', path.basename(String(p))]); return fsSync.writeFileSync(p, ...rest); },
    renameSync: (a, b) => { ops.push(['rename', path.basename(String(a)), path.basename(String(b))]); return fsSync.renameSync(a, b); },
  };
}

test('a command is written to a non-.json temp name and renamed to <id>.json, so a watcher never reads half of one', async () => {
  const dir = await makeBridgeDir();
  const ops = [];
  const ctx = createBridge(baseOpts(dir, { fs: recordingFs(ops) }));
  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [name] = await waitForFile(dir.cmdDir);
  await fs.writeFile(path.join(dir.resDir, name), JSON.stringify({ status: 'ok', outputs: {} }));
  await p;
  const id = name.replace(/\.json$/, '');
  const write = ops.find(([op, f]) => op === 'write' && f.startsWith(id));
  assert.ok(write, `no write of the command: ${JSON.stringify(ops)}`);
  assert.ok(!write[1].endsWith('.json'), `the first write must not be visible to a *.json scan, got ${write[1]}`);
  assert.deepEqual(ops.find(([op, from]) => op === 'rename' && from.startsWith(id)), ['rename', write[1], `${id}.json`]);
});

test('a command that vanishes (no command, no claim, no result) fails the send fast with a clear message', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { vanishGraceMs: 60, sendTimeoutMs: 3000 }));
  const t0 = Date.now();
  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [name] = await waitForFile(dir.cmdDir);
  await fs.rm(path.join(dir.cmdDir, name)); // what a quarantine looks like from the sender's side
  await assert.rejects(p, (e) => /vanished/.test(e.message) && /not run/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, 'must not wait for the send timeout');
});

test('a claimed command that vanishes with no result fails as a mid-command stop, never as "not run; retry"', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { vanishGraceMs: 60, sendTimeoutMs: 5000 }));
  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [name] = await waitForFile(dir.cmdDir);
  const id = name.replace(/\.json$/, '');
  await fs.writeFile(path.join(dir.bridgeDir, 'heartbeat'), `busy run_script ${Date.now()}`); // the claiming watcher
  await fs.rename(path.join(dir.cmdDir, name), path.join(dir.cmdDir, `${id}.running`));
  await delay(40); // the sender sees the claim
  // The watcher ran it, failed to write the result (disk full, a file lock) and removed its claim.
  await fs.rm(path.join(dir.cmdDir, `${id}.running`));
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, 'the send must fail');
  assert.doesNotMatch(err.message, /not run|retry\./);
  assert.match(err.message, /whether any of it was applied is unknown/);
  assert.match(err.message, /[Cc]heck the affected images before retrying/);
});

test('a command briefly absent while it is being claimed is not taken for vanished', async () => {
  const dir = await makeBridgeDir();
  const ctx = createBridge(baseOpts(dir, { vanishGraceMs: 300, sendTimeoutMs: 5000 }));
  const p = ctx.send('run_script', '__script__', { code: '1;' });
  const [name] = await waitForFile(dir.cmdDir);
  const id = name.replace(/\.json$/, '');
  const body = await fs.readFile(path.join(dir.cmdDir, name), 'utf8');
  await fs.rm(path.join(dir.cmdDir, name));
  await delay(40); // a claim rename that is not atomic on this filesystem
  await fs.writeFile(path.join(dir.bridgeDir, 'heartbeat'), `busy run_script ${Date.now()}`); // the claiming watcher
  await fs.writeFile(path.join(dir.cmdDir, `${id}.running`), body);
  await delay(400); // well past the grace: the claim keeps it alive
  await fs.writeFile(path.join(dir.resDir, `${id}.json`), JSON.stringify({ status: 'ok', outputs: { consoleOutput: 'done' } }));
  const r = await p;
  assert.equal(r.outputs.consoleOutput, 'done');
});

test('the watcher launch hands PixInsight -x= with forward slashes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-home-'));
  const launches = [];
  const ctx = createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null },
    log: () => {},
    watcherPath: 'C:\\Astro\\M31\\agentic\\watcher\\0.1.0\\rig\\watcher.js',
    bridgeDir: path.join(home, 'target', 'agentic', 'bridge', 'rig'),
    env: {},
    fs: fencedFs(home),
    spawnWatcher: (bin, args) => { launches.push(args); throw new Error('stop after the launch'); },
    pollIntervalMs: 5,
  });
  await assert.rejects(ctx.send('run_script', '__script__', { code: '1;' }), /stop after the launch/);
  assert.deepEqual(launches, [['-x=C:/Astro/M31/agentic/watcher/0.1.0/rig/watcher.js']]);
});

test('watcherFor is asked for the script serving the real bridge dir before each launch, and that script is launched', async () => {
  const home = fsSync.realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-home-')));
  const bridgeDir = path.join(home, 'My Target', 'agentic', 'bridge', 'rig');
  const asked = [];
  const launches = [];
  const ctx = createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null },
    log: () => {},
    watcherFor: async (dir) => { asked.push(dir); return path.join(home, 'My Target', 'agentic', 'watcher', '9', 'rig', 'watcher.js'); },
    bridgeDir,
    env: {},
    spawnWatcher: (bin, args) => { launches.push(args); throw new Error('stop after the launch'); },
    pollIntervalMs: 5,
  });
  await assert.rejects(ctx.send('run_script', '__script__', { code: '1;' }), /stop after the launch/);
  assert.deepEqual(asked, [bridgeDir]);
  assert.deepEqual(launches, [[`-x=${path.join(home, 'My Target', 'agentic', 'watcher', '9', 'rig', 'watcher.js').replace(/\\/g, '/')}`]], 'one argv element, space and all');
});

test('a watcher script that cannot be written fails the send before PixInsight is started, and leaves no command behind', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixinsight-bridge-home-'));
  const bridgeDir = path.join(home, 'target', 'agentic', 'bridge', 'rig');
  let started = 0;
  const ctx = createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: { isRunning: async () => false, startedAt: async () => null, memoryMB: async () => null },
    spawn: () => { started++; return { unref() {}, on() {} }; },
    log: () => {},
    watcherFor: async () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
    bridgeDir,
    env: {},
    spawnWatcher: () => assert.fail('no watcher launch'),
    pollIntervalMs: 5,
  });
  await assert.rejects(ctx.send('run_script', '__script__', { code: '1;' }), (e) => e.code === 'EACCES');
  assert.equal(started, 0);
  assert.deepEqual(await fs.readdir(path.join(bridgeDir, 'commands')), []);
});
