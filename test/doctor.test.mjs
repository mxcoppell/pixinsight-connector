import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDoctor as realRunDoctor } from '../src/doctor.mjs';
import { createLaunchMutex, DEFAULT_LAUNCH_PORT } from '../src/runtime.mjs';
import { fakeNet as sharedFakeNet, holdForeign } from './fake-net.mjs';

// Hermetic by default: runDoctor otherwise falls back to the host's os.homedir(), hostname,
// process.env (PIXINSIGHT_BIN/DIR change the platform line) and the real loopback port. A test that
// names its own homeDir gets the real filesystem under that (temporary) home; one that does not
// gets a home no call ever touches.
const NO_HOME = path.join(os.tmpdir(), 'doctor-test-home-never-written');
// The workspace check only reads (realpath, stat, access); by default it looks at a folder that does
// not exist, so no test depends on the directory the suite runs from.
const NO_CWD = path.join(os.tmpdir(), 'doctor-test-cwd-does-not-exist');
function runDoctor(opts = {}) {
  const home = 'homeDir' in opts ? {} : { homeDir: NO_HOME };
  return realRunDoctor({ env: {}, cwd: NO_CWD, machineId: () => 'rig', net: fakeNet(), ...home, ...opts });
}

// A node:net whose one port is free, bound by someone else (EADDRINUSE), or not bindable at all.
// 'free', 'busy' (another connector holds the port: it answers with the banner), 'foreign' (another
// program holds it: silent) or 'denied' (every bind fails with EPERM).
function fakeNet(state = 'free') {
  const n = sharedFakeNet(state === 'denied' ? { failWith: 'EPERM' } : {});
  if (state === 'busy') createLaunchMutex({ net: n, env: {}, log: () => {} }).acquire({ timeoutMs: 0 });
  if (state === 'foreign') { holdForeign(n, DEFAULT_LAUNCH_PORT); holdForeign(n, 40123); }
  return n;
}

const check = (r, name) => r.checks.find((c) => c.name === name);
const tilde = (home, ...p) => `~/${path.relative(home, path.join(home, ...p)).split(path.sep).join('/')}`;

async function tmpHome(t, prefix = 'doctor-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Brief's 3 required tests, verbatim.
// ---------------------------------------------------------------------------

test('reports every check and exits non-zero when any fails', async () => {
  const r = await runDoctor({ platform: null, probe: { isRunning: async () => false } });
  assert.equal(r.ok, false);
  const names = r.checks.map((c) => c.name);
  for (const n of ['platform', 'pixinsight-binary', 'watcher', 'workspace', 'call-logs', 'launch-mutex', 'packs', 'node'])
    assert.ok(names.includes(n), `missing check: ${n}`);
});

test('a failing check carries an actionable hint, not just a verdict', async () => {
  const r = await runDoctor({ platform: null });
  const failed = r.checks.filter((c) => !c.ok);
  assert.ok(failed.length > 0);
  for (const c of failed) assert.ok(c.hint?.length > 10, `${c.name} has no hint`);
});

test('an unresolved platform check carries the resolver\'s own reason (which path it looked for)', async () => {
  const r = await runDoctor({ platform: null, platformError: 'Could not find a PixInsight installation (looked for "/opt/PixInsight/bin/PixInsight").' });
  const p = r.checks.find((c) => c.name === 'platform');
  assert.equal(p.ok, false);
  assert.match(p.detail, /looked for "\/opt\/PixInsight\/bin\/PixInsight"/);
});

// The OS is what a bug report needs first, and an unresolved install is exactly when a bug report
// gets filed: the platform line names it either way. It comes from the injected `osName`, never
// the host's process.platform, so this holds on every CI leg.
test('the platform check names the OS whether or not an install resolved', async () => {
  const unresolved = await runDoctor({ platform: null, platformError: 'Could not find a PixInsight installation.', osName: 'win32' });
  assert.match(unresolved.checks.find((c) => c.name === 'platform').detail, /\bwin32\b/);
  const bare = await runDoctor({ platform: null, osName: 'linux' });
  assert.match(bare.checks.find((c) => c.name === 'platform').detail, /\blinux\b/);
  const resolved = await runDoctor({ platform: { piBin: '/opt/PixInsight/bin/PixInsight', verified: false }, osName: 'freebsd' });
  assert.match(resolved.checks.find((c) => c.name === 'platform').detail, /OS freebsd\b/);
});

test('names which candidate path matched, so a wrong guess is diagnosable', async () => {
  const r = await runDoctor({ platform: { piBin: '/opt/PixInsight/bin/PixInsight', verified: false } });
  const p = r.checks.find((c) => c.name === 'platform');
  assert.match(p.detail, /\/opt\/PixInsight/);
  assert.match(p.detail, /unverified/i);
});

// ---------------------------------------------------------------------------
// Additional coverage.
// ---------------------------------------------------------------------------

test('emits all 12 checks in the documented order', async () => {
  const r = await runDoctor({ platform: null, probe: { isRunning: async () => null }, packs: [] });
  assert.deepEqual(r.checks.map((c) => c.name), [
    'node',
    'platform',
    'pixinsight-binary',
    'pixinsight-running',
    'watcher',
    'workspace',
    'call-logs',
    'launch-mutex',
    'packs',
    'imagesolver',
    'filter-db',
    'settings',
  ]);
});

test('node check passes on the real, running Node version (this repo requires >=22)', async () => {
  const r = await runDoctor({ platform: null });
  const n = r.checks.find((c) => c.name === 'node');
  assert.equal(n.ok, true);
  assert.match(n.detail, /Node v/);
});

test('pixinsight-running never fails: true, false, and null (unknown) are all ok', async () => {
  for (const value of [true, false, null]) {
    const r = await runDoctor({ platform: null, probe: { isRunning: async () => value } });
    const c = r.checks.find((cc) => cc.name === 'pixinsight-running');
    assert.equal(c.ok, true, `isRunning()=${value} must not fail the check`);
  }
  const rNull = await runDoctor({ platform: null, probe: { isRunning: async () => null } });
  assert.match(rNull.checks.find((c) => c.name === 'pixinsight-running').detail, /unknown/i);
});

test('a resolved, verified platform passes the platform check with no hint', async () => {
  const platform = {
    piBin: '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight',
    imageSolverPath: '/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js',
    verified: true,
  };
  const r = await runDoctor({ platform });
  const p = r.checks.find((c) => c.name === 'platform');
  assert.equal(p.ok, true);
  assert.match(p.detail, /\/Applications\/PixInsight/);
  assert.doesNotMatch(p.detail, /unverified/i);
});

test('pixinsight-binary fails with an actionable hint when the candidate does not exist', async () => {
  const r = await runDoctor({ platform: { piBin: '/nonexistent/PixInsight', verified: true } });
  const c = r.checks.find((cc) => cc.name === 'pixinsight-binary');
  assert.equal(c.ok, false);
  assert.match(c.detail, /not found/i);
  assert.ok(c.hint.length > 10);
});

test('pixinsight-binary passes when the candidate exists and is executable', async (t) => {
  const dir = await tmpHome(t);
  const binPath = path.join(dir, 'fake-pixinsight');
  await fsp.writeFile(binPath, '#!/bin/sh\n', { mode: 0o755 });
  const r = await runDoctor({ platform: { piBin: binPath, verified: true } });
  const c = r.checks.find((cc) => cc.name === 'pixinsight-binary');
  assert.equal(c.ok, true);
});

const macPlatform = {
  piBin: '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight',
  imageSolverPath: '/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js',
  verified: true,
};

test('watcher check names where this workspace\'s watcher goes, in the target, and writes nothing anywhere', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'M31');
  await fsp.mkdir(ws);
  const r = await runDoctor({ platform: macPlatform, homeDir: home, cwd: ws });
  const c = r.checks.find((cc) => cc.name === 'watcher');
  assert.equal(c.ok, true, c.detail);
  assert.ok(c.detail.includes(tilde(home, 'M31', 'agentic', 'watcher')), c.detail);
  assert.match(c.detail, /\/rig\/watcher\.js/);
  assert.ok(c.detail.includes(tilde(home, 'M31', 'agentic', 'bridge', 'rig')), c.detail);
  assert.doesNotMatch(c.detail, /Note:/, 'no space, no note');
  assert.deepEqual(await fsp.readdir(home), ['M31']);
  assert.deepEqual(await fsp.readdir(ws), [], 'doctor renders the watcher in memory only');
});

test('a target path with a space: a note off macOS (unverified there), never a failure; nothing on macOS', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'My Target');
  await fsp.mkdir(ws);
  const onLinux = check(await runDoctor({ platform: macPlatform, homeDir: home, cwd: ws, osName: 'linux' }), 'watcher');
  assert.equal(onLinux.ok, true);
  assert.match(onLinux.detail, /Note: .*space.*unverified on linux/);
  const onMac = check(await runDoctor({ platform: macPlatform, homeDir: home, cwd: ws, osName: 'darwin' }), 'watcher');
  assert.doesNotMatch(onMac.detail, /Note:/);
});

test('with no usable workspace the watcher check still proves the template renders, and says where a session puts it', async () => {
  const c = check(await runDoctor({ platform: macPlatform }), 'watcher');
  assert.equal(c.ok, true);
  assert.match(c.detail, /renders/);
  assert.match(c.detail, /target folder/);
});

test('a watcher that cannot be rendered fails the watcher check with a hint', async () => {
  const watcherFs = { readFile: async () => { throw new Error('EIO: template unreadable'); }, writeFile: async () => {}, mkdir: async () => {}, rename: async () => {} };
  const c = check(await runDoctor({ platform: macPlatform, watcherFs }), 'watcher');
  assert.equal(c.ok, false);
  assert.match(c.detail, /EIO/);
  assert.ok(c.hint.length > 10);
});

test('a missing ImageSolver fails the imagesolver check with why it matters, not the watcher check', async (t) => {
  const dir = await tmpHome(t);
  const platform = {
    piBin: '/nonexistent/PixInsight/bin/PixInsight',
    imageSolverPath: path.join(dir, 'no-such-install', 'src', 'scripts', 'ImageSolver', 'ImageSolver.js'),
    verified: false,
  };
  const r = await runDoctor({ platform, homeDir: dir });
  const solver = r.checks.find((cc) => cc.name === 'imagesolver');
  assert.equal(solver.ok, false);
  assert.match(solver.hint, /will not compile/);
  assert.match(solver.hint, /PIXINSIGHT_DIR/);
  assert.equal(r.checks.find((cc) => cc.name === 'watcher').ok, true, 'the watcher itself renders fine');
});

test('packs check reports zero packs as ok, not a failure', async () => {
  const r = await runDoctor({ platform: null, packs: [] });
  const c = r.checks.find((cc) => cc.name === 'packs');
  assert.equal(c.ok, true);
  assert.match(c.detail, /no packs/i);
});

// PackInfo exactly as src/packs.mjs's loadPacks() produces it.
const loadedPack = { name: 'demo', version: '1.0.0', apiVersion: 1, source: '/packs/demo', toolCount: 26, status: 'loaded' };

test('packs check passes when every configured pack loaded, and lists each by name/version/apiVersion/tool count', async () => {
  const r = await runDoctor({ platform: null, packs: [loadedPack] });
  const c = r.checks.find((cc) => cc.name === 'packs');
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /demo@1\.0\.0 apiVersion=1 tools=26 — loaded/);
});

test('packs check fails on a skipped pack, naming a pack that failed to import by its source', async () => {
  const packs = [
    loadedPack,
    { name: 'from-the-future', version: '1.0.0', apiVersion: 99, source: '/packs/future', toolCount: 0,
      status: 'skipped', reason: 'apiVersion 99 is not supported (supported: 1)' },
    { name: undefined, version: undefined, apiVersion: undefined, source: '/packs/broken', toolCount: 0,
      status: 'skipped', reason: 'this pack is broken on purpose' },
  ];
  const r = await runDoctor({ platform: null, packs });
  const c = r.checks.find((cc) => cc.name === 'packs');
  assert.equal(c.ok, false);
  assert.match(c.detail, /demo@1\.0\.0 .* — loaded/);
  assert.match(c.detail, /from-the-future@1\.0\.0 .* — skipped \(apiVersion 99/);
  assert.match(c.detail, /\/packs\/broken@\? .* — skipped \(this pack is broken on purpose\)/);
  assert.doesNotMatch(c.detail, /undefined/);
  assert.match(c.hint, /from-the-future/);
  assert.match(c.hint, /\/packs\/broken/);
  assert.match(c.hint, /PIXINSIGHT_CONNECTOR_PACKS/);
});

test('packs check shows a nameless pack under the home directory as ~/..., not the full home path', async (t) => {
  const home = await tmpHome(t);
  const packs = [{ source: path.join(home, 'packs', 'broken'), toolCount: 0, status: 'skipped', reason: 'boom' }];
  const c = (await runDoctor({ platform: null, homeDir: home, packs })).checks.find((cc) => cc.name === 'packs');
  assert.match(c.detail, /~\/packs\/broken@\?/);
  assert.ok(!(c.detail + c.hint).includes(home), 'the full home path must not appear');
});

test('imagesolver/filter-db/settings pass when the resolved paths exist', async (t) => {
  const dir = await tmpHome(t);
  const imageSolverPath = path.join(dir, 'ImageSolver.js');
  const filterDbPath = path.join(dir, 'filters.xspd');
  const settingsPath = path.join(dir, 'core-001-pxi.settings');
  await Promise.all([imageSolverPath, filterDbPath, settingsPath].map((p) => fsp.writeFile(p, '')));
  const platform = { piBin: path.join(dir, 'PixInsight'), imageSolverPath, filterDbPath, settingsPath, verified: true };
  const r = await runDoctor({ platform });
  for (const name of ['imagesolver', 'filter-db', 'settings']) {
    const c = r.checks.find((cc) => cc.name === name);
    assert.equal(c.ok, true, `${name} should be ok when its path exists`);
  }
});

test('imagesolver/filter-db/settings fail with a hint when the resolved path is missing', async () => {
  const platform = {
    piBin: '/nonexistent/PixInsight',
    imageSolverPath: '/nonexistent/ImageSolver.js',
    filterDbPath: '/nonexistent/filters.xspd',
    settingsPath: '/nonexistent/core-001-pxi.settings',
    verified: true,
  };
  const r = await runDoctor({ platform });
  for (const name of ['imagesolver', 'filter-db', 'settings']) {
    const c = r.checks.find((cc) => cc.name === name);
    assert.equal(c.ok, false);
    assert.ok(c.hint.length > 10);
  }
});

test('a home-relative resolved path is redacted to ~ instead of the full home path', async (t) => {
  const dir = await tmpHome(t);
  const settingsPath = path.join(dir, 'Library', 'PixInsight', 'core-001-pxi.settings');
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, '');
  const platform = { piBin: '/nonexistent/PixInsight', settingsPath, verified: true };
  const r = await runDoctor({ platform, homeDir: dir });
  const c = r.checks.find((cc) => cc.name === 'settings');
  const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(c.detail, new RegExp(escapedDir), 'the full home path must not appear verbatim');
  assert.match(c.detail, /~\//, 'the redacted ~/... form should appear instead');
});

test('a missing/malformed probe never throws and is treated as unknown', async () => {
  const r = await runDoctor({ platform: null, probe: {} });
  const c = r.checks.find((cc) => cc.name === 'pixinsight-running');
  assert.equal(c.ok, true);
  assert.match(c.detail, /unknown/i);
});

// ---------------------------------------------------------------------------
// The workspace, the call logs and the launch mutex.
// ---------------------------------------------------------------------------

test('workspace check reports the resolved workspace and its state, bridge, logs and output dirs', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'My Target');
  await fsp.mkdir(ws);
  const r = await runDoctor({ platform: null, homeDir: home, cwd: ws });
  const c = check(r, 'workspace');
  assert.equal(c.ok, true);
  assert.match(c.detail, /usable/);
  assert.match(c.detail, /the launch folder/);
  for (const sub of [['agentic'], ['agentic', 'bridge'], ['agentic', 'logs'], ['output']]) {
    assert.ok(c.detail.includes(tilde(home, 'My Target', ...sub)), `${sub.join('/')} in ${c.detail}`);
  }
  assert.deepEqual(await fsp.readdir(ws), [], 'doctor only reads the workspace');
  assert.deepEqual(await fsp.readdir(home), ['My Target'], 'and writes nothing in the home directory');
});

test('workspace check names this machine\'s subdir of the bridge dir, from the hostname', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'Target');
  await fsp.mkdir(ws);
  const c = check(await runDoctor({ platform: null, homeDir: home, cwd: ws, machineId: () => 'studio-mac' }), 'workspace');
  assert.ok(c.detail.includes(tilde(home, 'Target', 'agentic', 'bridge', 'studio-mac')), c.detail);
});

test('an unusable launch folder is reported, not failed: a harness passes its own folder or calls set_workspace', async (t) => {
  const home = await tmpHome(t);
  const r = await runDoctor({ platform: null, homeDir: home, cwd: home });
  const c = check(r, 'workspace');
  assert.equal(c.ok, true);
  assert.match(c.detail, /not usable/);
  assert.match(c.detail, /home directory itself/);
  assert.match(c.detail, /set_workspace/);
});

test('an unusable PIXINSIGHT_CONNECTOR_WORKSPACE fails the workspace check with a hint', async (t) => {
  const home = await tmpHome(t);
  const r = await runDoctor({ platform: null, homeDir: home, cwd: home, env: { PIXINSIGHT_CONNECTOR_WORKSPACE: path.join(home, 'missing') } });
  const c = check(r, 'workspace');
  assert.equal(c.ok, false);
  assert.match(c.detail, /does not exist/);
  assert.match(c.hint, /PIXINSIGHT_CONNECTOR_WORKSPACE/);
});

test('call-logs check: on, with the log dir, how many files and the latest; only reads', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'My Target');
  await fsp.mkdir(ws);
  let c = check(await runDoctor({ platform: null, homeDir: home, cwd: ws }), 'call-logs');
  assert.equal(c.ok, true);
  assert.ok(c.detail.includes(tilde(home, 'My Target', 'agentic', 'logs')), c.detail);
  assert.match(c.detail, /on/);
  assert.match(c.detail, /none yet/);
  assert.match(c.detail, /paths and PJSR code/);
  assert.deepEqual(await fsp.readdir(ws), [], 'doctor only reads the workspace');
  const logs = path.join(ws, 'agentic', 'logs');
  await fsp.mkdir(logs, { recursive: true });
  await fsp.writeFile(path.join(logs, '20260922-080000-11.jsonl'), '');
  await fsp.writeFile(path.join(logs, '20260923-090000-12.jsonl'), '');
  c = check(await runDoctor({ platform: null, homeDir: home, cwd: ws }), 'call-logs');
  assert.match(c.detail, /2 log files, latest 20260923-090000-12\.jsonl/);
});

test('call-logs check: PIXINSIGHT_CONNECTOR_LOG=0 is reported as off', async (t) => {
  const home = await tmpHome(t);
  const ws = path.join(home, 'T');
  await fsp.mkdir(ws);
  const c = check(await runDoctor({ platform: null, homeDir: home, cwd: ws, env: { PIXINSIGHT_CONNECTOR_LOG: '0' } }), 'call-logs');
  assert.equal(c.ok, true);
  assert.match(c.detail, /off \(PIXINSIGHT_CONNECTOR_LOG=0\)/);
});

test('call-logs check: with no usable workspace, nothing is logged until one is set', async (t) => {
  const home = await tmpHome(t);
  const c = check(await runDoctor({ platform: null, homeDir: home, cwd: home }), 'call-logs');
  assert.equal(c.ok, true);
  assert.match(c.detail, /not logged/);
  assert.match(c.detail, /set_workspace/);
});

test('launch-mutex check: free, in use by a connector, held by another program, or not bindable, always informational; the port is named', async () => {
  const free = fakeNet('free');
  let c = check(await runDoctor({ platform: null, net: free }), 'launch-mutex');
  assert.equal(c.ok, true);
  assert.match(c.detail, /127\.0\.0\.1:\d+ is free/);
  assert.equal(free.binds.length, 1);
  c = check(await runDoctor({ platform: null, net: fakeNet('busy') }), 'launch-mutex');
  assert.equal(c.ok, true);
  assert.match(c.detail, /127\.0\.0\.1:\d+ is in use by a connector starting PixInsight/);
  c = check(await runDoctor({ platform: null, net: fakeNet('foreign'), env: { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: '40123' } }), 'launch-mutex');
  assert.equal(c.ok, true);
  assert.match(c.detail, /127\.0\.0\.1:40123 \(PIXINSIGHT_CONNECTOR_LAUNCH_PORT\) is held by another program/);
  assert.match(c.detail, /set PIXINSIGHT_CONNECTOR_LAUNCH_PORT to a free port/);
  c = check(await runDoctor({ platform: null, net: fakeNet('denied') }), 'launch-mutex');
  assert.equal(c.ok, true);
  assert.match(c.detail, /cannot be bound/);
});
