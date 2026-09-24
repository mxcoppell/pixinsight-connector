// The PJSR watcher's own defences (pjsr/watcher.template.js), checked without PixInsight:
//  - mcpStaleCommandReason() is pure ES5, so it is lifted out of the template and run in a vm;
//  - the ordering facts that make those defences effective (refuse before dispatch, heartbeat
//    before the first UI pump, idle clock started after it) are checked against the source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const TEMPLATE = await readFile(new URL('../pjsr/watcher.template.js', import.meta.url), 'utf8');

// The source of one top-level `function name(...) { ... }` in the template (ends at the first line
// that is exactly "}").
function functionSource(name) {
  const start = TEMPLATE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `watcher template must define ${name}()`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return TEMPLATE.slice(start, end + 2);
}

function constant(name) {
  const m = TEMPLATE.match(new RegExp(`^var ${name} = ([^;]+);`, 'm'));
  assert.ok(m, `watcher template must define var ${name}`);
  return vm.runInNewContext(m[1]);
}

const MAX_PRESTART = constant('MAX_PRESTART_AGE_MS');
const MAX_AGE = constant('MAX_COMMAND_AGE_MS');
const reasonFn = vm.runInNewContext(
  `var MAX_PRESTART_AGE_MS = ${MAX_PRESTART}; var MAX_COMMAND_AGE_MS = ${MAX_AGE};\n` +
    `${functionSource('mcpStaleCommandReason')}\nmcpStaleCommandReason;`
);
const iso = (ms) => new Date(ms).toISOString();
const START = 1_800_000_000_000;

test('the watcher refuses a command with no timestamp (the e2e close-every-window file had none)', () => {
  assert.match(reasonFn({ id: 'x', tool: 'run_script' }, START, START), /timestamp/);
  assert.match(reasonFn({ id: 'x', timestamp: 'not a date' }, START, START), /timestamp/);
});

test('the watcher refuses a command written well before it started', () => {
  const r = reasonFn({ timestamp: iso(START - 2 * 3600_000) }, START, START + 1000);
  assert.match(r, /before this watcher started/);
});

test('the watcher accepts a command written shortly before it started (the bridge writes, then launches it)', () => {
  assert.equal(reasonFn({ timestamp: iso(START - 5000) }, START, START + 1000), null);
  assert.equal(reasonFn({ timestamp: iso(START - 2 * 60_000) }, START, START + 1000), null, 'a PixInsight autostart plus watcher start fits the grace');
});

test('the watcher accepts a command queued while it was running, even behind a long process', () => {
  assert.equal(reasonFn({ timestamp: iso(START + 60_000) }, START, START + 15 * 60_000), null);
});

test('the watcher refuses a command older than any sender waits for, even one queued after it started', () => {
  const r = reasonFn({ timestamp: iso(START + 1000) }, START, START + 1000 + MAX_AGE + 1);
  assert.match(r, /old/);
});

test('the grace and the maximum age are ordered sensibly and exceed the bridge\'s own waits', () => {
  assert.ok(MAX_PRESTART >= 3 * 60_000, 'must cover 4 s pickup + 90 s PixInsight autostart + 3 x 30 s watcher launches');
  assert.ok(MAX_AGE > 20 * 60_000, 'must exceed the bridge send timeout (20 min)');
  assert.ok(MAX_AGE > MAX_PRESTART);
});

test('processNextCommand checks staleness before dispatching, and quarantines plus answers a refused command', () => {
  const body = functionSource('processNextCommand');
  const check = body.indexOf('mcpStaleCommandReason(');
  const dispatch = body.indexOf('dispatchCommand(');
  assert.ok(check > 0 && dispatch > 0 && check < dispatch, 'the staleness check must come before dispatchCommand');
  assert.match(body, /mcpQuarantineCommand\(filePath\)/, 'quarantined');
  assert.match(body, /status: "error"/);
});

test('runWatcher writes its first heartbeat before the first UI pump, and starts the idle clock after it', () => {
  const body = functionSource('runWatcher');
  const firstBeat = body.indexOf('writeHeartbeat("starting")');
  const show = body.indexOf('console.show()');
  assert.ok(firstBeat > 0 && firstBeat < show, 'a heartbeat must be on disk before console.show()/processEvents can stall');
  const loop = body.indexOf('for (;;)');
  const lastIdleReset = body.lastIndexOf('lastActivity = Date.now()', loop);
  const firstPump = body.indexOf('pump();', show);
  assert.ok(firstPump > show && firstPump < lastIdleReset && lastIdleReset < loop,
    'the idle clock must start after the first pump, so a slow start cannot use up the idle linger');
  assert.match(body, /WATCHER_START_MS = Date\.now\(\)/);
});

// --- Fix round 1 ---

test('the watcher refuses a command file that is JSON but not a command object, instead of crashing on it', () => {
  for (const c of [null, 42, 'text', [1, 2]]) {
    assert.match(reasonFn(c, START, START), /not a command object/, JSON.stringify(c));
  }
});

// Runs the quarantine helpers against a fake PJSR File whose move silently does nothing and whose
// remove throws (a locked file on Windows). The baked-in bridge dir is /b.
function quarantineSandbox({ moveWorks = false, removeWorks = false } = {}) {
  const files = new Set(['/b/commands/a.json', '/b/commands/b.json']);
  const File = {
    exists: (p) => files.has(p),
    directoryExists: () => true,
    createDirectory: () => {},
    searchDirectory: (pattern) => {
      if (pattern !== '/b/commands/*.json') throw new Error(`unexpected search ${pattern}`);
      return [...files].filter((p) => p.startsWith('/b/commands/')).sort();
    },
    move: (from, to) => { if (moveWorks) { files.delete(from); files.add(to); } },
    remove: (p) => { if (!removeWorks) throw new Error('locked'); files.delete(p); },
  };
  const ctx = vm.createContext({ File, JSON, COMMANDS_DIR: '/b/commands', QUARANTINE_DIR: '/b/quarantine', MCP_REFUSED: {} });
  vm.runInContext(
    ['readTextFile', 'ensureDirectory', 'deleteFile', 'listJsonFiles', 'mcpRefusedKey', 'mcpQuarantineCommand', 'mcpPendingCommandFiles', 'mcpHasPendingCommand']
      .map(functionSource).join('\n'),
    ctx
  );
  return { ctx, files };
}

const pendingOf = (ctx) => JSON.parse(vm.runInContext('JSON.stringify(mcpPendingCommandFiles())', ctx));

test('a refused file that can be neither moved nor deleted is skipped from then on, not refused forever', () => {
  const { ctx, files } = quarantineSandbox();
  vm.runInContext('mcpQuarantineCommand("/b/commands/a.json")', ctx);
  assert.ok(files.has('/b/commands/a.json'), 'the fake really could not remove it');
  assert.deepEqual(pendingOf(ctx), ['/b/commands/b.json']);
});

test('a refused file whose move silently fails is deleted instead', () => {
  const { ctx, files } = quarantineSandbox({ removeWorks: true });
  vm.runInContext('mcpQuarantineCommand("/b/commands/a.json")', ctx);
  assert.ok(!files.has('/b/commands/a.json'));
});

test('a refused file that moves is quarantined in the bridge dir', () => {
  const { ctx, files } = quarantineSandbox({ moveWorks: true });
  vm.runInContext('mcpQuarantineCommand("/b/commands/a.json")', ctx);
  assert.ok(files.has('/b/quarantine/a.json'));
});

test('the idle-exit last look does not count a remembered unremovable file as a waiting command', () => {
  const { ctx } = quarantineSandbox();
  assert.equal(vm.runInContext('mcpHasPendingCommand()', ctx), true);
  vm.runInContext('mcpQuarantineCommand("/b/commands/a.json"); mcpQuarantineCommand("/b/commands/b.json")', ctx);
  assert.equal(vm.runInContext('mcpHasPendingCommand()', ctx), false);
});

test('both the command pickup and the idle-exit last look go through the refusal-aware pending list', () => {
  assert.match(functionSource('processNextCommand'), /mcpPendingCommandFiles\(\)/);
  const run = functionSource('runWatcher');
  assert.match(run, /mcpHasPendingCommand\(\)/, 'the idle-exit last look must not count a stuck file as a waiting command');
  assert.match(functionSource('mcpHasPendingCommand'), /mcpPendingCommandFiles\(\)/);
  assert.doesNotMatch(run, /listJsonFiles\(/);
  assert.doesNotMatch(functionSource('processNextCommand'), /listJsonFiles\(/);
});

// --- Fix round 2 ---

// A fake PJSR File over an in-memory map, for the round-2 helpers.
function fileSandbox(initial = {}, { moveOverwrites = true, moveThrowsIfExists = false } = {}) {
  const files = new Map(Object.entries(initial));
  const File = {
    exists: (p) => files.has(p),
    directoryExists: () => true,
    createDirectory: () => {},
    searchDirectory: (pattern) => {
      const dirPart = pattern.slice(0, pattern.lastIndexOf('/') + 1);
      const ext = pattern.slice(pattern.lastIndexOf('.'));
      return [...files.keys()].filter((p) => p.startsWith(dirPart) && !p.slice(dirPart.length).includes('/') && p.endsWith(ext));
    },
    readLines: (p) => String(files.get(p)).split('\n'),
    writeTextFile: (p, text) => { files.set(p, text); },
    remove: (p) => { if (!files.has(p)) throw new Error('no such file'); files.delete(p); },
    move: (from, to) => {
      if (!files.has(from)) throw new Error('no such file');
      if (files.has(to)) {
        if (moveThrowsIfExists) throw new Error('target exists');
        if (!moveOverwrites) return;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const ctx = vm.createContext({
    File, JSON, Date,
    BRIDGE_DIR: '/b', COMMANDS_DIR: '/b/commands', QUARANTINE_DIR: '/b/quarantine', LAUNCHES_DIR: '/b/launches',
    HEARTBEAT_FILE: '/b/heartbeat', HEARTBEAT_TMP: '/b/heartbeat.tmp', MCP_ATOMIC_BEAT: true,
    LAUNCH_TICKET_TTL_MS: constant('LAUNCH_TICKET_TTL_MS'), LAUNCH_TICKET_WRITE_GRACE_MS: constant('LAUNCH_TICKET_WRITE_GRACE_MS'), MCP_REFUSED: {},
  });
  vm.runInContext(
    ['readTextFile', 'ensureDirectory', 'deleteFile', 'listJsonFiles', 'writeHeartbeat', 'mcpTakeLaunchTicket', 'mcpRefusedKey', 'mcpClaimCommand']
      .map(functionSource).join('\n'),
    ctx
  );
  return { ctx, files };
}

const ticket = (lingerMs, at) => JSON.stringify({ lingerMs, at, pid: 1 });

test('a launched watcher takes the oldest fresh linger ticket and a queued second watcher still finds its own', () => {
  const { ctx, files } = fileSandbox({
    '/b/launches/1000-a.json': ticket(500, START),
    '/b/launches/1250-b.json': ticket(500, START + 250),
  });
  assert.equal(vm.runInContext(`mcpTakeLaunchTicket(${START + 1000})`, ctx), 500);
  assert.equal(files.has('/b/launches/1000-a.json'), false, 'the first watcher consumed the oldest ticket');
  assert.equal(files.has('/b/launches/1250-b.json'), true);
  // The queued second -x starts after the first watcher exits: it must not end up resident.
  assert.equal(vm.runInContext(`mcpTakeLaunchTicket(${START + 5000})`, ctx), 500);
  assert.equal(vm.runInContext(`mcpTakeLaunchTicket(${START + 6000})`, ctx), 0, 'no ticket left: a hand launch stays resident');
});

test('expired or unreadable linger tickets are removed and ignored, so a much later hand launch stays resident', () => {
  const ttl = constant('LAUNCH_TICKET_TTL_MS');
  const { ctx, files } = fileSandbox({
    '/b/launches/1-old.json': ticket(8000, START - ttl - 1),
    '/b/launches/2-bad.json': 'not json',
  });
  assert.equal(vm.runInContext(`mcpTakeLaunchTicket(${START})`, ctx), 0);
  assert.equal(files.size, 0);
});

test('the watcher no longer reads or consumes a shared idle_exit_ms, and takes its linger from a ticket', () => {
  assert.doesNotMatch(TEMPLATE, /idle_exit_ms/);
  assert.match(functionSource('runWatcher'), /IDLE_EXIT_MS = mcpTakeLaunchTicket\(/);
  assert.ok(constant('LAUNCH_TICKET_TTL_MS') >= 30 * 60_000, 'a queued launch must still find its ticket well after it was written');
});

test('the heartbeat is replaced atomically (temp file + move) where File.move can replace a file', () => {
  const { ctx, files } = fileSandbox({ '/b/heartbeat': 'idle 1' });
  vm.runInContext('writeHeartbeat("idle")', ctx);
  assert.match(files.get('/b/heartbeat'), /^idle \d+$/);
  assert.equal(files.has('/b/heartbeat.tmp'), false);
  assert.equal(vm.runInContext('MCP_ATOMIC_BEAT', ctx), true);
});

function checkHeartbeatFallback(behaviour) {
  const { ctx, files } = fileSandbox({ '/b/heartbeat': 'idle 1' }, behaviour);
  vm.runInContext('writeHeartbeat("busy run_mgc")', ctx);
  assert.match(files.get('/b/heartbeat'), /^busy run_mgc \d+$/);
  assert.equal(files.has('/b/heartbeat.tmp'), false, 'no temp file left behind');
  assert.equal(vm.runInContext('MCP_ATOMIC_BEAT', ctx), false, 'stops trying the move for the rest of the run');
  vm.runInContext('writeHeartbeat("idle")', ctx);
  assert.match(files.get('/b/heartbeat'), /^idle \d+$/);
}

test('the heartbeat falls back to an in-place write when File.move over an existing file throws', () => {
  checkHeartbeatFallback({ moveThrowsIfExists: true });
});

test('the heartbeat falls back to an in-place write when File.move over an existing file silently does nothing', () => {
  checkHeartbeatFallback({ moveOverwrites: false });
});

test('a command is claimed (renamed out of *.json) before it runs, so no other watcher can pick it up again', () => {
  const { ctx, files } = fileSandbox({ '/b/commands/x.json': '{}' });
  const claimed = vm.runInContext('mcpClaimCommand("/b/commands/x.json")', ctx);
  assert.equal(claimed, '/b/commands/x.running');
  assert.equal(files.has('/b/commands/x.json'), false);
  assert.deepEqual([...vm.runInContext('listJsonFiles(COMMANDS_DIR + "/*.json")', ctx)], []);
});

test('if a claim cannot rename the file, this watcher remembers it and never picks it up again', () => {
  const { ctx } = fileSandbox({ '/b/commands/x.json': '{}', '/b/commands/x.running': 'leftover' }, { moveThrowsIfExists: true });
  const claimed = vm.runInContext('mcpClaimCommand("/b/commands/x.json")', ctx);
  assert.equal(claimed, '/b/commands/x.json');
  assert.equal(vm.runInContext('MCP_REFUSED[mcpRefusedKey("/b/commands/x.json")]', ctx), true);
});

test('a refusal is keyed by the command file name, so one file seen under two spellings of its folder is skipped under both', () => {
  const { ctx } = fileSandbox({});
  const key = (p) => vm.runInContext(`mcpRefusedKey(${JSON.stringify(p)})`, ctx);
  assert.equal(key('/Volumes/NAS/Real Target/agentic/bridge/m/commands/1f0c.json'), '1f0c.json');
  assert.equal(key('/Volumes/NAS/link/agentic/bridge/m/commands/1f0c.json'), key('/Volumes/nas/real target/agentic/bridge/m/commands/1f0c.json'));
});

test('processNextCommand claims the command before dispatching it, and removes the claimed file afterwards', () => {
  const body = functionSource('processNextCommand');
  const claim = body.indexOf('mcpClaimCommand(');
  assert.ok(claim > body.indexOf('mcpStaleCommandReason(') && claim < body.indexOf('dispatchCommand('));
  assert.match(body.slice(body.indexOf('dispatchCommand(')), /deleteFile\(claimedPath\)/);
});

// --- Fix round 3 ---

test('the linger-ticket TTL is long enough for a launch PixInsight queued behind a long user script', () => {
  assert.ok(constant('LAUNCH_TICKET_TTL_MS') >= 12 * 3600_000);
});

test('an unparseable ticket written moments ago is skipped, not deleted; an old unparseable one is removed', () => {
  const { ctx, files } = fileSandbox({
    [`/b/launches/${START - 2000}-fresh.json`]: '{"lingerMs": 80',
    [`/b/launches/${START - 3600_000}-old.json`]: 'garbage',
  });
  assert.equal(vm.runInContext(`mcpTakeLaunchTicket(${START})`, ctx), 0);
  assert.equal(files.has(`/b/launches/${START - 2000}-fresh.json`), true, 'may belong to another launch still being written');
  assert.equal(files.has(`/b/launches/${START - 3600_000}-old.json`), false);
});

// ---------------------------------------------------------------------------
// The watcher runs only what the connector sends: run_script and list_open_images. Any legacy
// processing handler (with its own tuned values) is unreachable dead code and must not ship.
// ---------------------------------------------------------------------------

test('the watcher defines only the two command handlers the connector uses', () => {
  const handlers = [...TEMPLATE.matchAll(/^function (handle\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(handlers, ['handleListOpenImages', 'handleRunScript']);
});

test('dispatchCommand routes run_script and list_open_images, and answers anything else with "unknown command"', () => {
  const dispatch = vm.runInNewContext(
    'function handleRunScript() { return "script"; }\nfunction handleListOpenImages() { return "list"; }\n' +
      `${functionSource('dispatchCommand')}\ndispatchCommand;`
  );
  assert.equal(dispatch({ tool: 'run_script' }), 'script');
  assert.equal(dispatch({ tool: 'list_open_images' }), 'list');
  for (const legacy of ['denoise', 'sharpen', 'deconvolve', 'stretch_image', 'open_image', 'run_pixelmath', 'blend_narrowband']) {
    assert.throws(() => dispatch({ tool: legacy }), /unknown command/i, `${legacy} must be refused`);
  }
});

test('every top-level function in the watcher is referenced somewhere else in it (no dead helpers)', () => {
  const names = [...TEMPLATE.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]);
  const unused = names.filter((n) => TEMPLATE.split(new RegExp(`\\b${n}\\b`)).length - 1 < 2);
  assert.deepEqual(unused, []);
});

// ---------------------------------------------------------------------------
// One watcher per target: its bridge dir is baked in, and it reads and writes nothing else.
// ---------------------------------------------------------------------------

test('the bridge dir is baked in as a JSON string token, and every file the watcher uses is under it', () => {
  assert.match(TEMPLATE, /^var BRIDGE_DIR = @@BRIDGEDIR@@;$/m);
  for (const v of ['COMMANDS_DIR', 'RESULTS_DIR', 'QUARANTINE_DIR', 'LAUNCHES_DIR', 'HEARTBEAT_FILE', 'WATCHER_INFO_FILE', 'LAST_STOP_FILE', 'SHUTDOWN_FILE']) {
    assert.match(TEMPLATE, new RegExp(`^var ${v} = BRIDGE_DIR \\+ "/`, 'm'), v);
  }
  assert.doesNotMatch(TEMPLATE, /homeDirectory|\.pixinsight-mcp|REGISTRY|workspaces|MCP_HOME/, 'nothing outside the target');
  const run = functionSource('runWatcher');
  assert.match(run, /File\.exists\(SHUTDOWN_FILE\)/);
  assert.match(run, /File\.writeTextFile\(LAST_STOP_FILE, /);
});

test('processNextCommand takes the first pending command and answers into RESULTS_DIR', () => {
  const body = functionSource('processNextCommand');
  assert.match(body, /var pending = mcpPendingCommandFiles\(\);/);
  assert.match(body, /var filePath = pending\[0\];/);
  assert.match(body, /var resultsDir = RESULTS_DIR;/);
  assert.match(body, /var resultPath = resultsDir \+ "\/"/);
  assert.match(functionSource('mcpPendingCommandFiles'), /listJsonFiles\(COMMANDS_DIR \+ "\/\*\.json"\)/);
});

test('a missing commands dir (target deleted, volume unmounted) is no pending command, not an error', () => {
  const File = { searchDirectory: () => { throw new Error('no such directory'); } };
  const ctx = vm.createContext({ File, JSON, COMMANDS_DIR: '/gone/commands', MCP_REFUSED: {} });
  vm.runInContext(['listJsonFiles', 'mcpRefusedKey', 'mcpPendingCommandFiles', 'mcpHasPendingCommand'].map(functionSource).join('\n'), ctx);
  assert.equal(vm.runInContext('mcpHasPendingCommand()', ctx), false);
});

// --- PixInsight version in the watcher's start-up record ---

function versionOf(core) {
  const ctx = vm.createContext({ CoreApplication: core, Math });
  vm.runInContext(functionSource('mcpPixInsightVersion'), ctx);
  return vm.runInContext('mcpPixInsightVersion()', ctx);
}

test('mcpPixInsightVersion formats CoreApplication the way PixInsight\'s own scripts do (AdP/WCSmetadata.jsh)', () => {
  const base = { versionLE: false, versionMajor: 1, versionMinor: 9, versionRelease: 3, versionRevision: 0, versionBeta: 0 };
  assert.equal(versionOf(base), '1.9.3');
  assert.equal(versionOf({ ...base, versionRevision: 2 }), '1.9.3-2');
  assert.equal(versionOf({ ...base, versionBeta: 4 }), '1.9.3 beta 4');
  assert.equal(versionOf({ ...base, versionBeta: -1 }), '1.9.3 RC1');
  assert.equal(versionOf({ ...base, versionLE: true }), 'LE 1.9.3');
  assert.equal(versionOf({ get versionMajor() { throw new Error('no such property'); } }), null, 'never throws');
});

test('runWatcher writes its start-up record (watcher and PixInsight version) before its first heartbeat', () => {
  const body = functionSource('runWatcher');
  const info = body.indexOf('mcpWriteWatcherInfo(WATCHER_START_MS)');
  const firstBeat = body.indexOf('writeHeartbeat("starting")');
  assert.ok(info > 0 && info < firstBeat, 'a connector that sees the watcher alive can already read which PixInsight it runs in');
  assert.match(body, /mcpPixInsightVersion\(\)/, 'the version is shown in the start-up banner too');
});

test('mcpWriteWatcherInfo writes { watcherVersion, pixinsightVersion, startedAt } to watcher.json in the bridge dir', () => {
  const files = new Map();
  const ctx = vm.createContext({
    File: { writeTextFile: (p, text) => files.set(p, text) },
    JSON, Math, WATCHER_VERSION: '9.9.9', WATCHER_INFO_FILE: '/b/watcher.json',
    CoreApplication: { versionLE: false, versionMajor: 1, versionMinor: 9, versionRelease: 3, versionRevision: 2, versionBeta: 0 },
  });
  vm.runInContext(functionSource('mcpPixInsightVersion') + functionSource('mcpWriteWatcherInfo'), ctx);
  vm.runInContext('mcpWriteWatcherInfo(1234)', ctx);
  assert.deepEqual(JSON.parse(files.get('/b/watcher.json')), { watcherVersion: '9.9.9', pixinsightVersion: '1.9.3-2', startedAt: 1234 });
  assert.match(TEMPLATE, /var WATCHER_INFO_FILE = BRIDGE_DIR \+ "\/watcher\.json";/);
  ctx.File.writeTextFile = () => { throw new Error('read-only'); };
  vm.runInContext('mcpWriteWatcherInfo(1)', ctx); // a failed write never stops the watcher
});
