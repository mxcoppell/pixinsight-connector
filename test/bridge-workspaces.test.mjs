// The bridge in the target folder: everything a session's bridge uses lives in
// <target>/agentic/bridge/<machine-id>/ (commands, results, quarantine, heartbeat, last-stop, launch
// lock, linger tickets), and each target has its own watcher, a script written into the target with
// that dir baked in, serving only that dir. Nothing is read or written anywhere else.
//
// The watcher here is the real pjsr/watcher.template.js with its bridge dir substituted, evaluated
// in a vm with a PJSR `File` shim over the real filesystem (only the handlers are stubbed), and the
// connectors are real createBridge() instances. Paths contain a space on purpose. No PixInsight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../src/bridge.mjs';
import { toPixPath } from '../src/platform.mjs';
import { createLaunchMutex } from '../src/runtime.mjs';
import { fakeNet } from './fake-net.mjs';
import { buildRuntimeApi, assembleCatalog, createServer } from '../src/server.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { createCallLog } from '../src/call-log.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const TEMPLATE = fs.readFileSync(new URL('../pjsr/watcher.template.js', import.meta.url), 'utf8');

async function tmpRoot(t) {
  // The real path: the connector uses each bridge dir by its real path (macOS: /var -> /private/var).
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'pixi-ws-bridge-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return {
    root,
    ws: (name, id = 'rig') => path.join(root, name, 'agentic', 'bridge', id),
  };
}

// PJSR's File API over node:fs. Paths arrive with forward slashes, as PixInsight gives them.
function pjsrFile(locked = new Set()) {
  const isLocked = (p) => [...locked].some((n) => p.endsWith(`/${n}`));
  return {
    exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    directoryExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    createDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    readLines: (p) => fs.readFileSync(p, 'utf8').split('\n'),
    writeTextFile: (p, text) => fs.writeFileSync(p, text),
    remove: (p) => { if (isLocked(p)) throw new Error('EBUSY: locked'); fs.rmSync(p); },
    move: (from, to) => { if (isLocked(from)) throw new Error('EBUSY: locked'); fs.renameSync(from, to); },
    searchDirectory: (pattern) => {
      const cut = pattern.lastIndexOf('/');
      const dir = pattern.slice(0, cut);
      const ext = pattern.slice(pattern.lastIndexOf('.'));
      return fs.readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => `${dir}/${n}`);
    },
  };
}

// The real watcher for one bridge dir, baked in exactly as materializeWatcher bakes it, minus its
// preprocessor directives and its entry-point call. dispatchCommand is replaced by one that records
// which command ran and echoes its code.
function realWatcher(bridgeDir, locked) {
  const src = TEMPLATE.split('@@BRIDGEDIR@@').join(JSON.stringify(toPixPath(bridgeDir)))
    .split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/\nrunWatcher\(\);\s*$/, '\n');
  const quiet = () => {};
  const ctx = vm.createContext({
    File: pjsrFile(locked), JSON, Date, Math, Object, String, Number, isNaN, parseInt,
    console: { writeln: quiet, noteln: quiet, warningln: quiet, criticalln: quiet },
    CoreApplication: { versionLE: false, versionMajor: 1, versionMinor: 9, versionRelease: 3, versionRevision: 2, versionBeta: 0 },
  });
  vm.runInContext(src, ctx);
  ctx.WATCHER_START_MS = Date.now() - 1000;
  const ran = [];
  ctx.dispatchCommand = (command) => {
    ran.push(command.parameters.code);
    return { status: 'success', outputs: { consoleOutput: `ran ${command.parameters.code}`, consoleErrors: [] }, message: '' };
  };
  return { tick: () => vm.runInContext('processNextCommand()', ctx), ran, ctx };
}

const pending = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'commands')).filter((f) => f.endsWith('.json')); } catch { return []; }
};
const cmdsIn = (dir) => { try { return fs.readdirSync(path.join(dir, 'commands')).sort(); } catch { return []; } };

async function until(cond, what, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await delay(2);
  }
}

const probeAlive = { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null };

// A connector: a real bridge with no watcher launching (the test's watchers are the ones above).
function connector(bridgeDir, pid, extra = {}) {
  return createBridge({
    platform: { piBin: 'fake-pixinsight-bin' },
    probe: probeAlive,
    log: () => {},
    watcherPath: 'fake-watcher.js',
    bridgeDir,
    autoLaunch: false,
    pollIntervalMs: 2,
    pid,
    isPidAlive: () => true,
    onExit: () => {},
    ...extra,
  });
}

test('two targets, two watchers: each target\'s watcher serves only its own bridge dir', async (t) => {
  const h = await tmpRoot(t);
  const wsA = h.ws('Target A'); // a space in the path
  const wsB = h.ws('target-b');
  const a = connector(wsA, 1001);
  const b = connector(wsB, 1002);
  const sends = [...['A1', 'A2'].map((c) => a.pjsr(c)), ...['B1', 'B2'].map((c) => b.pjsr(c))];
  await until(() => pending(wsA).length === 2 && pending(wsB).length === 2, 'all four commands on disk');

  const wA = realWatcher(wsA);
  while (wA.tick()) { /* one command per tick */ }
  assert.deepEqual([...wA.ran].sort(), ['A1', 'A2'], 'A\'s watcher never sees B\'s commands');
  assert.equal(pending(wsB).length, 2);
  const wB = realWatcher(wsB);
  while (wB.tick()) { /* drain */ }
  assert.deepEqual([...wB.ran].sort(), ['B1', 'B2']);
  const results = await Promise.all(sends);
  assert.deepEqual(results.map((r) => r.result), ['ran A1', 'ran A2', 'ran B1', 'ran B2']);
  assert.equal(fs.readdirSync(path.join(wsA, 'results')).length, 0, 'results were written in, and consumed from, the sender\'s own dir');
  assert.match(fs.readFileSync(path.join(wsA, 'heartbeat'), 'utf8'), /^busy run_script \d+$/, 'each watcher beats in its own dir');
  assert.match(fs.readFileSync(path.join(wsB, 'heartbeat'), 'utf8'), /^busy run_script \d+$/);
});

test('two connectors sharing one target: one watcher, one dir, and no command runs twice', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('shared target');
  const one = connector(ws, 2001);
  const two = connector(ws, 2002);
  const sends = [one.pjsr('x1'), two.pjsr('y1'), one.pjsr('x2'), two.pjsr('y2')];
  await until(() => pending(ws).length === 4, 'four commands on disk');
  const w = realWatcher(ws);
  while (w.tick()) { /* drain */ }
  const results = await Promise.all(sends);
  assert.deepEqual(results.map((r) => r.result), ['ran x1', 'ran y1', 'ran x2', 'ran y2']);
  assert.deepEqual([...w.ran].sort(), ['x1', 'x2', 'y1', 'y2'], 'each command ran exactly once');
});

test('a workspace switch with a command in flight: the old target\'s watcher answers it in the old dir; the next goes to the new target', async (t) => {
  const h = await tmpRoot(t);
  const oldWs = h.ws('old target');
  const newWs = h.ws('new target');
  const a = connector(oldWs, 3001);
  const first = a.pjsr('before');
  await until(() => pending(oldWs).length === 1, 'the first command on disk');
  a.setBridgeDir(newWs); // set_workspace while `first` waits
  const second = a.pjsr('after');
  await until(() => pending(newWs).length === 1, 'the second command on disk');
  const wOld = realWatcher(oldWs);
  const wNew = realWatcher(newWs);
  while (wNew.tick()) { /* drain */ }
  while (wOld.tick()) { /* drain */ }
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.result), ['ran before', 'ran after']);
  assert.deepEqual(wOld.ran, ['before']);
  assert.deepEqual(wNew.ran, ['after']);
});

test('a switch with autolaunch: each dir launches its own watcher script and waits on its own heartbeat', async (t) => {
  const h = await tmpRoot(t);
  const oldWs = h.ws('old');
  const newWs = h.ws('new');
  const scriptOf = (dir) => `${dir}-watcher.js`;
  const asked = [];
  const launched = [];
  const a = connector(oldWs, 3101, {
    autoLaunch: true,
    watcherFor: async (dir) => { asked.push(dir); return scriptOf(dir); },
    // A launched script beats in the dir it serves, and nowhere else.
    spawnWatcher: (bin, [arg]) => {
      launched.push(arg);
      const dir = [oldWs, newWs].find((d) => arg === `-x=${toPixPath(scriptOf(d))}`);
      fs.writeFileSync(path.join(dir, 'heartbeat'), `idle ${Date.now()}`);
    },
  });
  const first = a.pjsr('before');
  await until(() => launched.length === 1, 'the old target\'s launch');
  a.setBridgeDir(newWs);
  const second = a.pjsr('after');
  await until(() => launched.length === 2, 'the new target\'s own launch (its heartbeat is its own)');
  assert.deepEqual(asked, [oldWs, newWs]);
  const wOld = realWatcher(oldWs);
  const wNew = realWatcher(newWs);
  while (wOld.tick() || wNew.tick()) { /* drain both */ }
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.result), ['ran before', 'ran after']);
});

test('a hand-started watcher whose bridge dir does not exist yet idles, then picks up the first command', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('late');
  const w = realWatcher(ws);
  assert.equal(w.tick(), false, 'nothing to do, and no dir is no error');
  const p = connector(ws, 5001).pjsr('late');
  await until(() => pending(ws).length === 1, 'the command on disk');
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran late');
});

test('the watcher refuses a stale command, answering it and quarantining it in its bridge dir', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('stale one');
  const p = connector(ws, 6001).pjsr('late');
  await until(() => pending(ws).length === 1, 'the command on disk');
  const w = realWatcher(ws);
  w.ctx.WATCHER_START_MS = Date.now() + 10 * 60_000; // started long after the command was written
  while (w.tick()) { /* drain */ }
  const r = await p;
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /Refused stale command/);
  assert.equal(fs.readdirSync(path.join(ws, 'quarantine')).length, 1);
  assert.deepEqual(w.ran, []);
});

test('creating a bridge writes nothing; the first send creates the bridge dir', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('lazy');
  const a = connector(ws, 7001);
  assert.deepEqual(fs.readdirSync(h.root), []);
  const p = a.pjsr('x');
  await until(() => pending(ws).length === 1, 'the command on disk');
  const w = realWatcher(ws);
  while (w.tick()) { /* drain */ }
  await p;
});

test('on first use of a dir (a send, or a send after a switch), commands there from a sender that is gone are quarantined, never run', async (t) => {
  const h = await tmpRoot(t);
  const orphan = { id: 'orphan', timestamp: new Date().toISOString(), senderPid: 999, tool: 'run_script', process: '__script__', parameters: { code: 'orphan' } };
  const withOrphan = (name) => {
    const ws = h.ws(name);
    fs.mkdirSync(path.join(ws, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'commands', 'orphan.json'), JSON.stringify(orphan));
    fs.writeFileSync(path.join(ws, 'commands', 'live.json'), JSON.stringify({ ...orphan, id: 'live', senderPid: 8002, parameters: { code: 'live' } }));
    return ws;
  };
  const ws = withOrphan('reused');
  const a = connector(ws, 8001, { isPidAlive: (pid) => pid !== 999 });
  const p = a.pjsr('mine');
  await until(() => pending(ws).length === 2, 'the orphan moved aside');
  assert.deepEqual(fs.readdirSync(path.join(ws, 'quarantine')), ['orphan.json']);
  const w = realWatcher(ws);
  while (w.tick()) { /* drain */ }
  await p;
  assert.deepEqual([...w.ran].sort(), ['live', 'mine']);

  const next = withOrphan('switched to');
  a.setBridgeDir(next);
  const q = a.pjsr('next');
  await until(() => pending(next).length === 2, 'the orphan in the new dir moved aside');
  assert.deepEqual(fs.readdirSync(path.join(next, 'quarantine')), ['orphan.json']);
  const w2 = realWatcher(next);
  while (w2.tick()) { /* drain */ }
  await q;
  assert.deepEqual([...w2.ran].sort(), ['live', 'next']);
});

test('before a launch, orphans in this target\'s dir are swept; another target\'s dir is never touched', async (t) => {
  const h = await tmpRoot(t);
  const mine = h.ws('mine');
  const other = h.ws('other');
  for (const d of [mine, other]) {
    fs.mkdirSync(path.join(d, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(d, 'commands', 'claimed.running'), '{}'); // claimed by a watcher that is gone
  }
  const launches = [];
  const a = connector(mine, 9001, {
    autoLaunch: true,
    spawnWatcher: () => { launches.push(1); fs.writeFileSync(path.join(mine, 'heartbeat'), `idle ${Date.now()}`); },
  });
  const p = a.pjsr('go');
  await until(() => launches.length === 1, 'the launch');
  assert.deepEqual(fs.readdirSync(path.join(mine, 'quarantine')), ['claimed.running']);
  assert.deepEqual(cmdsIn(other), ['claimed.running'], 'another target is another watcher\'s business');
  assert.deepEqual(fs.readdirSync(path.join(mine, 'launches')).length, 1, 'the linger ticket is in this target\'s dir');
  const w = realWatcher(mine);
  while (w.tick()) { /* drain */ }
  await p;
});

test('a watcher that never starts while PixInsight runs: the error gives the possible causes (busy, or a path it could not open) without claiming one', async (t) => {
  const h = await tmpRoot(t);
  let clock = 1_800_000_000_000;
  const a = connector(h.ws('queued'), 9101, {
    autoLaunch: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await delay(0); },
    spawnWatcher: () => {}, // PixInsight queues the -x behind the script it is running: no beat ever
  });
  await assert.rejects(a.pjsr('x'), (e) => {
    assert.match(e.message, /Watcher did not start within 30s/);
    assert.match(e.message, /runs one script at a time/);
    assert.match(e.message, /another target's watcher/);
    assert.match(e.message, /retry/i);
    assert.match(e.message, /could not open the watcher script/);
    assert.match(e.message, /Process Console/);
    assert.doesNotMatch(e.message, /most likely/, 'no cause is claimed without evidence');
    return true;
  });
});

test('a heartbeat left by a PixInsight that has since quit does not hide the busy/retry message', async (t) => {
  const h = await tmpRoot(t);
  let clock = 1_800_000_000_000;
  const ws = h.ws('queued-stale');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'heartbeat'), `idle ${clock - 3_600_000}`); // an hour old, before this launch
  const a = connector(ws, 9102, {
    autoLaunch: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await delay(0); },
    spawnWatcher: () => {},
  });
  await assert.rejects(a.pjsr('x'), (e) => {
    assert.match(e.message, /Watcher did not start within 30s/);
    assert.match(e.message, /another target's watcher/);
    assert.match(e.message, /Process Console/);
    assert.match(e.message, /heartbeat: last seen "idle \d+"/, 'the old beat is still reported');
    return true;
  });
});

test('two targets cold-starting at the same moment start PixInsight once (the launch mutex), each launching its own watcher', async (t) => {
  const h = await tmpRoot(t);
  const net = fakeNet(); // shared by both connectors: one table of bound ports
  let running = false;
  let starts = 0;
  const probe = { isRunning: async () => running, startedAt: async () => null, memoryMB: async () => null };
  const cold = (ws, pid) => connector(ws, pid, {
    autoLaunch: true,
    probe,
    spawn: () => { starts++; setTimeout(() => { running = true; }, 20); return { unref() {}, on() {} }; },
    launchMutex: createLaunchMutex({ net, env: {}, sleep: (ms) => delay(Math.min(ms, 5)) }),
    spawnWatcher: () => fs.writeFileSync(path.join(ws, 'heartbeat'), `idle ${Date.now()}`),
  });
  const wsA = h.ws('A');
  const wsB = h.ws('B');
  const pa = cold(wsA, 9201).pjsr('a');
  const pb = cold(wsB, 9202).pjsr('b');
  await until(() => fs.existsSync(path.join(wsA, 'heartbeat')) && fs.existsSync(path.join(wsB, 'heartbeat')), 'both watchers launched', 5000);
  assert.equal(starts, 1, 'PixInsight was started once');
  const wA = realWatcher(wsA);
  const wB = realWatcher(wsB);
  while (wA.tick() || wB.tick()) { /* drain */ }
  assert.deepEqual([(await pa).result, (await pb).result], ['ran a', 'ran b']);
});

test('two machines sharing one target (network storage): each machine\'s watcher sees only its own machine\'s subdir', async (t) => {
  const h = await tmpRoot(t);
  const target = path.join(h.root, 'nas', 'deep sky target');
  fs.mkdirSync(target, { recursive: true });
  // A machine: the real server wiring (buildRuntimeApi picks the bridge dir from the machine id) and
  // a real bridge. Only this machine's own pid is alive as far as it can tell.
  const machine = (id, pid, extra = () => ({})) => {
    const workspace = createWorkspace({ cwd: target, env: {}, homeDir: path.join(h.root, 'home'), platform: process.platform });
    const made = [];
    const { api } = buildRuntimeApi({
      platform: { piBin: 'fake-pixinsight-bin' }, probe: probeAlive, workspace, log() {}, connectorVersion: '0',
      deps: {
        machineId: () => id,
        materializeWatcher: async ({ bridgeDir }) => ({ path: path.join(bridgeDir, '..', '..', 'watcher', '0', id, 'watcher.js'), warnings: [] }),
        createBridge: (o) => { made.push(o); return createBridge({ ...o, autoLaunch: false, pollIntervalMs: 2, pid, isPidAlive: (p) => p === pid, onExit: () => {}, ...extra(o) }); },
      },
    });
    return { api, made };
  };
  const b = machine('machine-b', 500);
  const pb = b.api.pjsr('b-live');
  await until(() => b.made.length === 1 && pending(b.made[0].bridgeDir).length === 1, 'machine B\'s command on disk');
  const bDir = b.made[0].bridgeDir;
  fs.writeFileSync(path.join(bDir, 'commands', 'b-claimed.running'), '{}'); // B's watcher is running one of B's

  let launched = 0;
  const a = machine('machine-a', 600, (o) => ({
    autoLaunch: true,
    spawnWatcher: () => { launched++; fs.writeFileSync(path.join(o.bridgeDir, 'heartbeat'), `idle ${Date.now()}`); },
  }));
  const pa = a.api.pjsr('a-own');
  await until(() => launched === 1, 'machine A\'s launch (after its sweeps)');
  const aDir = a.made[0].bridgeDir;
  assert.equal(aDir, path.join(target, 'agentic', 'bridge', 'machine-a'));
  assert.equal(bDir, path.join(target, 'agentic', 'bridge', 'machine-b'));
  const wA = realWatcher(aDir);
  while (wA.tick()) { /* machine A's watcher */ }
  assert.equal((await pa).result, 'ran a-own');
  assert.deepEqual(wA.ran, ['a-own'], 'machine A ran only its own command');
  assert.deepEqual(cmdsIn(bDir), ['b-claimed.running', pending(bDir)[0]].sort(), 'machine B\'s queued and claimed commands untouched by A\'s sweeps');
  assert.equal(fs.existsSync(path.join(bDir, 'quarantine')), false);
  assert.equal(fs.existsSync(path.join(bDir, 'launches')), false, 'A\'s linger ticket is in A\'s subdir only');
  const wB = realWatcher(bDir);
  while (wB.tick()) { /* machine B's watcher */ }
  assert.equal((await pb).result, 'ran b-live');
});

test('one target under three spellings (real, symlinked, case variant) is one real dir, and its watcher is asked for by that dir', async (t) => {
  const h = await tmpRoot(t);
  const real = path.join(h.root, 'Real Target');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(h.root, 'link');
  fs.symlinkSync(real, link, 'junction'); // a junction on Windows (no privilege needed); a symlink elsewhere
  const bridgeOf = (ws) => path.join(ws, 'agentic', 'bridge', 'mac-a');
  // A case-insensitive volume, simulated on any OS: the real path of any case variant is the one on disk.
  const realpath = (p) => fs.realpathSync.native(p.split('REAL TARGET').join('Real Target'));
  const asked = new Set();
  const spellings = [bridgeOf(real), bridgeOf(link), bridgeOf(path.join(h.root, 'REAL TARGET'))];
  const conns = spellings.map((d, i) => connector(d, 7101 + i, { realpath, watcherFor: (dir) => { asked.add(dir); return 'w.js'; } }));
  const sends = conns.map((c, i) => c.pjsr(`c${i}`));
  const canon = bridgeOf(real);
  await until(() => pending(canon).length === 3, 'three commands in the one dir');
  const w = realWatcher(canon);
  while (w.tick()) { /* drain */ }
  assert.deepEqual((await Promise.all(sends)).map((r) => r.result), ['ran c0', 'ran c1', 'ran c2']);
  assert.deepEqual([...w.ran].sort(), ['c0', 'c1', 'c2']);
});

test('a command whose file can be neither claimed nor removed runs once, and does not keep the watcher from idling out', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('locked');
  const p = connector(ws, 7201).pjsr('once');
  await until(() => pending(ws).length === 1, 'the command on disk');
  const w = realWatcher(ws, new Set(pending(ws))); // locked: the claim rename and the delete both fail
  for (let i = 0; i < 6; i++) w.tick();
  assert.deepEqual(w.ran, ['once']);
  assert.equal((await p).result, 'ran once');
  assert.equal(vm.runInContext('mcpHasPendingCommand()', w.ctx), false);
});

test('the watcher recreates a results/ dir removed after the command was queued', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('results removed');
  const p = connector(ws, 7401).pjsr('x');
  await until(() => pending(ws).length === 1, 'the command on disk');
  fs.rmSync(path.join(ws, 'results'), { recursive: true, force: true });
  const w = realWatcher(ws);
  while (w.tick()) { /* drain */ }
  assert.equal((await p).result, 'ran x');
});

test('the exit hook drops this process\'s queued, unclaimed commands (and only those)', async (t) => {
  const h = await tmpRoot(t);
  const ws = h.ws('exiting');
  const hooks = [];
  const a = connector(ws, 7501, { onExit: (fn) => hooks.push(fn), vanishGraceMs: 20 });
  const queued = a.pjsr('queued');
  const claimed = a.pjsr('claimed');
  await until(() => pending(ws).length === 2, 'both commands on disk');
  const claimedFile = pending(ws).find((f) => JSON.parse(fs.readFileSync(path.join(ws, 'commands', f), 'utf8')).parameters.code === 'claimed');
  const running = path.join(ws, 'commands', claimedFile.replace(/\.json$/, '.running'));
  fs.writeFileSync(path.join(ws, 'heartbeat'), `busy run_script ${Date.now()}`);
  fs.renameSync(path.join(ws, 'commands', claimedFile), running); // a live watcher is running this one
  const foreign = path.join(ws, 'commands', 'foreign.json');
  fs.writeFileSync(foreign, '{}');
  assert.ok(hooks.length >= 1, 'an exit hook was installed on first use');
  for (const fn of hooks) fn(); // the process exits
  assert.deepEqual(cmdsIn(ws), [path.basename(running), 'foreign.json'].sort(), 'the queued command is gone; a claimed one and another sender\'s are not');
  await assert.rejects(queued, /vanished/);
  fs.rmSync(running);
  await assert.rejects(claimed, /vanished/);
});

// The call log end to end: the real server dispatch, the real lazy bridge in a real workspace (with
// a space in its path) and the real watcher template. What the log holds is what was sent and what
// the watcher wrote back.
test('the call log records a real call: the exact PJSR the watcher ran and the result it wrote, on the call\'s seq', async (t) => {
  const h = await tmpRoot(t);
  const dir = path.join(h.root, 'Target A');
  fs.mkdirSync(dir);
  const workspace = createWorkspace({ cwd: dir, env: {}, homeDir: path.join(h.root, 'home'), platform: process.platform });
  const callLog = createCallLog({ workspace, env: {}, log: () => {}, onExit: () => {}, sessionInfo: () => ({ connectorVersion: '0.0.0-test' }) });
  const deps = {
    machineId: () => 'mac-a',
    createBridge: (o) => createBridge({ ...o, autoLaunch: false, pollIntervalMs: 2, probe: { isRunning: async () => true, startedAt: async () => null, memoryMB: async () => null }, isPidAlive: () => true, onExit: () => {} }),
  };
  const { api, resetBridge } = buildRuntimeApi({ platform: { piBin: 'fake-pixinsight-bin' }, probe: {}, workspace, log: () => {}, connectorVersion: '0.0.0-test', deps, callLog });
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge, workspace, callLog });
  const server = createServer({ catalog, api, callLog });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => { await client.close(); await server.close(); });

  const bridgeDir = path.join(dir, 'agentic', 'bridge', 'mac-a');
  const w = realWatcher(bridgeDir);
  w.ctx.dispatchCommand = (command) => (command.tool === 'list_open_images'
    ? { status: 'success', outputs: { images: [{ id: 'RGB', width: 10, height: 10, channels: 3 }] }, message: '' }
    : { status: 'success', outputs: { consoleOutput: `ran ${command.parameters.code}`, consoleErrors: ['*** Warning: sample'] }, message: '' });
  fs.mkdirSync(bridgeDir, { recursive: true });
  vm.runInContext('mcpWriteWatcherInfo(Date.now())', w.ctx); // what runWatcher does at start-up, after ensureDirectory(BRIDGE_DIR)
  let serving = true;
  const watcherLoop = (async () => { while (serving) { w.tick(); await delay(2); } })();
  let r1;
  let r2;
  try {
    r1 = await client.callTool({ name: 'run_pjsr', arguments: { code: 'var x = "a b";\nx;' } });
    r2 = await client.callTool({ name: 'close_image', arguments: { view_id: 'Missing' } });
  } finally {
    serving = false;
    await watcherLoop;
  }
  assert.equal(r1.content[0].text, 'ran var x = "a b";\nx;');
  assert.equal(r2.isError, true);

  const logsDir = path.join(dir, 'agentic', 'logs');
  const [name] = fs.readdirSync(logsDir);
  assert.match(name, new RegExp(`^\\d{8}-\\d{6}-${process.pid}\\.jsonl$`));
  const recs = fs.readFileSync(path.join(logsDir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'bridge_sent', 'event', 'bridge', 'call_end', 'call_start', 'bridge_sent', 'bridge', 'call_end']);
  const [, s1, sent1, ev, b1, e1, s2, sent2, b2, e2] = recs;
  // The exact PJSR is on disk from the moment the command is sent.
  assert.equal(sent1.code, 'var x = "a b";\nx;');
  assert.equal(sent1.cmdId, b1.cmdId);
  assert.equal(sent2.cmdId, b2.cmdId);
  // The watcher's start-up record, once per watcher start, on the call whose command it answered first.
  assert.equal(ev.event, 'watcher start');
  assert.equal(ev.seq, s1.seq);
  assert.equal(ev.pixinsightVersion, '1.9.3-2');
  assert.match(ev.watcherVersion, /^\d+\.\d+\.\d+$/);
  assert.match(ev.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(b1.seq, s1.seq);
  assert.equal(b1.tool, 'run_script');
  assert.equal(b1.code, 'var x = "a b";\nx;');
  assert.equal(b1.dir, bridgeDir);
  assert.deepEqual(b1.result.outputs, { consoleOutput: 'ran var x = "a b";\nx;', consoleErrors: ['*** Warning: sample'] });
  assert.equal(b1.result.id, b1.cmdId, 'the watcher\'s own result, id and all');
  assert.deepEqual(e1.result, r1);
  assert.equal(b2.seq, s2.seq);
  assert.equal(b2.tool, 'list_open_images');
  assert.deepEqual(e2.result, r2);
});
