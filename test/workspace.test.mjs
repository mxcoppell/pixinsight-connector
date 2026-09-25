import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, realpathSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspace, workspacePaths, WorkspaceError } from '../src/workspace.mjs';
import { readXisfHeader } from '../src/tools/workspace-scan.mjs';

test('workspacePaths defaults scratchDir to <dir>/agentic/scratch', () => {
  const ws = workspacePaths('/tmp/ws', {});
  assert.equal(ws.dir, '/tmp/ws');
  assert.equal(ws.scratchDir, path.join('/tmp/ws', 'agentic', 'scratch'));
});

test('a relative $PIXINSIGHT_CONNECTOR_STATE is resolved against the workspace, so Node and PixInsight agree on it', () => {
  const ws = workspacePaths(path.resolve('/tmp/ws'), { PIXINSIGHT_CONNECTOR_STATE: path.join('rel', 'state') });
  assert.ok(path.isAbsolute(ws.scratchDir), ws.scratchDir);
  assert.equal(ws.scratchDir, path.join(path.resolve('/tmp/ws'), 'rel', 'state', 'scratch'));
});

test('workspacePaths honors $PIXINSIGHT_CONNECTOR_STATE as the state dir root', () => {
  const ws = workspacePaths('/tmp/ws', { PIXINSIGHT_CONNECTOR_STATE: '/custom/state' });
  // path.resolve, not path.join: on Windows a rooted path without a drive letter resolves onto the
  // current drive (D:\custom\state), which is the same folder Windows itself would open.
  assert.equal(ws.scratchDir, path.join(path.resolve('/custom/state'), 'scratch'));
});

test('readXisfHeader returns null for a file that is not a well-formed XISF header', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-ws-'));
  try {
    const file = path.join(dir, 'not-xisf.bin');
    writeFileSync(file, 'not an xisf file at all, just some bytes');
    assert.equal(readXisfHeader(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readXisfHeader returns null for a missing file instead of throwing', () => {
  assert.equal(readXisfHeader('/no/such/file.xisf'), null);
});

test('readXisfHeader parses geometry, colorSpace, FILTER and hasWCS from a minimal synthetic header', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-ws-'));
  try {
    const file = path.join(dir, 'synthetic.xisf');
    const xml = '<Image geometry="1920:1080:1" colorSpace="Gray"><FITSKeyword name="FILTER" value="Ha" /><FITSKeyword name="OBJECT" value="Target A" /><FITSKeyword name="EXPTIME" value="300" /></Image>';
    const xmlBuf = Buffer.from(xml, 'utf8');
    const header = Buffer.alloc(16);
    header.write('XISF0100', 0, 'latin1');
    header.writeUInt32LE(xmlBuf.length, 8);
    const fd = openSync(file, 'w');
    writeSync(fd, header, 0, 16, 0);
    writeSync(fd, xmlBuf, 0, xmlBuf.length, 16);
    closeSync(fd);

    const parsed = readXisfHeader(file);
    assert.equal(parsed.geometry, '1920:1080:1');
    assert.equal(parsed.colorSpace, 'Gray');
    assert.equal(parsed.filter, 'Ha');
    assert.equal(parsed.object, 'Target A');
    assert.equal(parsed.exposureS, 300);
    assert.equal(parsed.hasWCS, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The live workspace: resolution precedence, the state-dir layout, the unusable-workspace rule and
// switching with set(). Every OS-dependent input (cwd, env, homeDir, platform, fs) is injected;
// expected paths are built with path.resolve/path.join so they hold on Windows too.
// ---------------------------------------------------------------------------

const R = (...p) => path.resolve(...p);
// A filesystem where every path is an existing, writable directory and realpath is the identity.
const trustingFs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
const make = (o = {}) => createWorkspace({ cwd: R('/launch'), env: {}, homeDir: R('/home/u'), platform: 'linux', fs: trustingFs, ...o });

test('workspacePaths lays out <state>/scratch, <state>/bridge and <state>/logs under <dir>/agentic, and <dir>/output', () => {
  const p = workspacePaths(R('/w'), {});
  assert.deepEqual(p, {
    dir: R('/w'),
    stateDir: path.join(R('/w'), 'agentic'),
    scratchDir: path.join(R('/w'), 'agentic', 'scratch'),
    bridgeDir: path.join(R('/w'), 'agentic', 'bridge'),
    logsDir: path.join(R('/w'), 'agentic', 'logs'),
    outputDir: path.join(R('/w'), 'output'),
  });
});

test('workspacePaths resolves $PIXINSIGHT_CONNECTOR_STATE against the workspace', () => {
  const p = workspacePaths(R('/w'), { PIXINSIGHT_CONNECTOR_STATE: 'st' });
  assert.equal(p.stateDir, R('/w', 'st'));
  assert.equal(p.bridgeDir, path.join(R('/w', 'st'), 'bridge'));
  assert.equal(p.logsDir, path.join(R('/w', 'st'), 'logs'));
  assert.equal(p.outputDir, path.join(R('/w'), 'output'), '$PIXINSIGHT_CONNECTOR_STATE never moves the output folder');
});

test('snapshot() carries outputDir and it follows a switch', async () => {
  const ws = make();
  assert.equal(ws.snapshot().outputDir, path.join(R('/launch'), 'output'));
  await ws.set(R('/astro/m31'));
  assert.equal(ws.snapshot().outputDir, path.join(R('/astro/m31'), 'output'));
});

test('with no override the workspace is the launch folder', () => {
  const ws = make();
  assert.equal(ws.snapshot().dir, R('/launch'));
  assert.equal(ws.snapshot().source, 'cwd');
  assert.equal(ws.snapshot().usable, true);
});

test('$PIXINSIGHT_CONNECTOR_WORKSPACE outranks the launch folder; relative resolves against it, ~/ against home', () => {
  assert.equal(make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: R('/elsewhere') } }).snapshot().dir, R('/elsewhere'));
  assert.equal(make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: R('/elsewhere') } }).snapshot().source, 'PIXINSIGHT_CONNECTOR_WORKSPACE');
  assert.equal(make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: 'sub' } }).snapshot().dir, R('/launch', 'sub'));
  assert.equal(make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: `~${path.sep}astro` } }).snapshot().dir, path.join(R('/home/u'), 'astro'));
  assert.equal(make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: '' } }).snapshot().source, 'cwd', 'an empty value is unset');
});

test('set() outranks $PIXINSIGHT_CONNECTOR_WORKSPACE, and $PIXINSIGHT_CONNECTOR_STATE still names the state dir', async () => {
  const ws = make({ env: { PIXINSIGHT_CONNECTOR_WORKSPACE: R('/env-ws'), PIXINSIGHT_CONNECTOR_STATE: 'st' } });
  await ws.set(R('/picked'));
  const s = ws.snapshot();
  assert.equal(s.dir, R('/picked'));
  assert.equal(s.source, 'set_workspace');
  assert.equal(s.scratchDir, path.join(R('/picked', 'st'), 'scratch'));
});

test('the filesystem root is unusable', () => {
  const s = make({ cwd: path.parse(process.cwd()).root }).snapshot();
  assert.equal(s.usable, false);
  assert.match(s.reason, /filesystem root/);
});

test('the home directory itself is unusable, but a folder inside it is fine', () => {
  assert.match(make({ cwd: R('/home/u') }).snapshot().reason, /home directory/);
  assert.equal(make({ cwd: R('/home/u/astro') }).snapshot().usable, true);
});

// macOS volumes may be case-sensitive, so only realpath decides there: realpath (the native one)
// returns the on-disk case on a case-insensitive volume, and leaves a different folder different.
test('home is matched after realpath; case is folded only on Windows, macOS relies on realpath', () => {
  const fs = { ...trustingFs, realpathSync: (p) => (p === R('/link') ? R('/home/u') : p) };
  assert.equal(make({ cwd: R('/link'), fs }).snapshot().usable, false, 'a symlink to home is home');
  assert.equal(make({ cwd: R('/HOME/U'), platform: 'win32' }).snapshot().usable, false);
  assert.equal(make({ cwd: R('/HOME/U'), platform: 'linux' }).snapshot().usable, true);
  assert.equal(make({ cwd: R('/HOME/U'), platform: 'darwin' }).snapshot().usable, true, 'a case-sensitive volume: another folder');
  const insensitive = { ...trustingFs, realpathSync: (p) => p.toLowerCase() };
  assert.equal(make({ cwd: R('/HOME/U'), platform: 'darwin', fs: insensitive }).snapshot().usable, false, 'a case-insensitive volume: home');
});

test('a missing, non-directory or unwritable folder is unusable, each with its reason', () => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.match(make({ fs: { ...trustingFs, realpathSync: enoent, statSync: enoent } }).snapshot().reason, /does not exist/);
  assert.match(make({ fs: { ...trustingFs, statSync: () => ({ isDirectory: () => false }) } }).snapshot().reason, /not a directory/);
  assert.match(make({ fs: { ...trustingFs, accessSync: () => { throw new Error('EACCES'); } } }).snapshot().reason, /not writable/);
});

test('require() throws a WorkspaceError naming the fix when the workspace is unusable', () => {
  const ws = make({ cwd: R('/home/u') });
  assert.throws(() => ws.require(), (e) => {
    assert.ok(e instanceof WorkspaceError);
    assert.equal(e.name, 'WorkspaceError');
    assert.match(e.message, /call set_workspace with the target folder, or set PIXINSIGHT_CONNECTOR_WORKSPACE/);
    assert.ok(e.message.includes(R('/home/u')), e.message);
    return true;
  });
  assert.equal(make().require().dir, R('/launch'));
});

test('an unusable folder that later becomes usable is picked up without a restart', () => {
  let exists = false;
  const fs = { ...trustingFs, statSync: () => { if (!exists) throw new Error('ENOENT'); return { isDirectory: () => true }; } };
  const ws = make({ fs });
  assert.equal(ws.snapshot().usable, false);
  exists = true;
  assert.equal(ws.require().dir, R('/launch'));
});

// A workspace deleted, or a volume unmounted, after it was first used: every check sees it at once,
// so a call fails with the fix instead of the bridge or a tool silently re-creating the folder.
test('a usable workspace that goes missing is unusable at once, and usable again when it is back', () => {
  let exists = true;
  const fs = { ...trustingFs, statSync: () => { if (!exists) throw new Error('ENOENT'); return { isDirectory: () => true }; } };
  const ws = make({ fs });
  assert.equal(ws.require().dir, R('/launch'));
  exists = false;
  const s = ws.snapshot();
  assert.equal(s.usable, false);
  assert.match(s.reason, /does not exist/);
  assert.throws(() => ws.require(), (e) => e instanceof WorkspaceError && /call set_workspace with the target folder/.test(e.message));
  exists = true;
  assert.equal(ws.require().dir, R('/launch'));
});

test('the real filesystem: a workspace removed mid-session is unusable, and nothing re-creates it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-ws-'));
  const dir = path.join(root, 'Target');
  try {
    mkdirSync(dir);
    const ws = createWorkspace({ cwd: dir, env: {}, homeDir: R('/nobody-home'), platform: process.platform });
    assert.equal(ws.snapshot().usable, true);
    rmSync(dir, { recursive: true, force: true });
    assert.match(ws.snapshot().reason, /does not exist/);
    assert.throws(() => ws.require(), WorkspaceError);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real filesystem: a fresh temp dir is usable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-ws-'));
  try {
    const s = createWorkspace({ cwd: dir, env: {}, homeDir: R('/nobody-home'), platform: process.platform }).snapshot();
    assert.equal(s.usable, true, s.reason);
    assert.match(createWorkspace({ cwd: path.join(dir, 'nope'), env: {}, homeDir: R('/nobody-home'), platform: process.platform }).snapshot().reason, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set() refuses a relative path, root, home or a missing folder, and keeps the current workspace', async () => {
  const enoentFor = (bad) => ({ ...trustingFs, statSync: (p) => { if (p === bad) throw new Error('ENOENT'); return { isDirectory: () => true }; } });
  const ws = make({ fs: enoentFor(R('/missing')) });
  await assert.rejects(() => ws.set('relative/dir'), (e) => e instanceof WorkspaceError && /absolute/.test(e.message));
  await assert.rejects(() => ws.set(path.parse(process.cwd()).root), (e) => e instanceof WorkspaceError && /filesystem root/.test(e.message));
  await assert.rejects(() => ws.set(R('/home/u')), (e) => e instanceof WorkspaceError && /home directory/.test(e.message));
  await assert.rejects(() => ws.set(R('/missing')), (e) => e instanceof WorkspaceError && /does not exist/.test(e.message));
  await assert.rejects(() => ws.set(''), (e) => e instanceof WorkspaceError);
  assert.equal(ws.snapshot().dir, R('/launch'));
  assert.equal(ws.snapshot().source, 'cwd');
});

test('set() expands ~ and ~/ against the home directory', async () => {
  const ws = make();
  await ws.set(`~${path.sep}astro${path.sep}m31`);
  assert.equal(ws.snapshot().dir, path.join(R('/home/u'), 'astro', 'm31'));
  await ws.set('~/astro');
  assert.equal(ws.snapshot().dir, path.join(R('/home/u'), 'astro'));
  await assert.rejects(() => ws.set('~'), /home directory/);
});

test('onChange listeners run in order on a switch, with the previous and current snapshots, and may be async', async () => {
  const ws = make();
  const seen = [];
  ws.onChange(async ({ previous, current }) => { await new Promise((r) => setTimeout(r, 5)); seen.push(['a', previous.dir, current.dir]); });
  ws.onChange(({ current }) => { seen.push(['b', current.dir]); });
  const r = await ws.set(R('/next'));
  assert.deepEqual(seen, [['a', R('/launch'), R('/next')], ['b', R('/next')]]);
  assert.equal(r.previous.dir, R('/launch'));
  assert.equal(r.current.dir, R('/next'));
  assert.deepEqual(r.warnings, []);
});

test('a failing onChange listener is reported as a warning, not thrown; the switch still stands', async () => {
  const logged = [];
  const ws = make({ log: (m) => logged.push(m) });
  ws.onChange(() => { throw new Error('registry write failed'); });
  const after = [];
  ws.onChange(({ current }) => after.push(current.dir));
  const r = await ws.set(R('/next'));
  assert.equal(ws.snapshot().dir, R('/next'));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /registry write failed/);
  assert.deepEqual(after, [R('/next')], 'later listeners still run');
  assert.ok(logged.some((m) => /registry write failed/.test(m)));
});

test('onChange returns an unsubscribe; setting the same folder again does not fire listeners', async () => {
  const ws = make();
  let n = 0;
  const off = ws.onChange(() => { n++; });
  await ws.set(R('/launch'));
  assert.equal(n, 0, 'same folder, already usable: nothing changed');
  assert.equal(ws.snapshot().source, 'set_workspace');
  await ws.set(R('/a'));
  assert.equal(n, 1);
  off();
  await ws.set(R('/b'));
  assert.equal(n, 1);
});

test('creating a workspace writes nothing (checks are reads only)', () => {
  const calls = [];
  const fs = { statSync: (p) => { calls.push('stat'); return { isDirectory: () => true }; }, accessSync: () => { calls.push('access'); }, realpathSync: (p) => { calls.push('realpath'); return p; } };
  make({ fs }).snapshot();
  assert.ok(calls.every((c) => ['stat', 'access', 'realpath'].includes(c)));
});

test('concurrent set() calls are serialized: each switch sees the one before it as previous', async () => {
  const ws = make();
  const seen = [];
  // The first switch's listener is the slow one: unserialized, the second would finish first.
  ws.onChange(async ({ previous, current }) => {
    await new Promise((r) => setTimeout(r, current.dir === R('/a') ? 30 : 1));
    seen.push([previous.dir, current.dir]);
  });
  await Promise.all([ws.set(R('/a')), ws.set(R('/b'))]);
  assert.deepEqual(seen, [[R('/launch'), R('/a')], [R('/a'), R('/b')]]);
  assert.equal(ws.snapshot().dir, R('/b'));
});

test('isInside resolves `..` first, refuses a prefix-sharing sibling, and folds case only on win32', async () => {
  const { isInside } = await import('../src/workspace.mjs');
  assert.equal(isInside('/w/output/a/b.png', '/w/output', 'linux'), true);
  assert.equal(isInside('/w/output', '/w/output', 'linux'), true);
  assert.equal(isInside('/w/output/../x.png', '/w/output', 'linux'), false);
  assert.equal(isInside('/w/output-old/x.png', '/w/output', 'linux'), false);
  assert.equal(isInside('/w/output/..x.png', '/w/output', 'linux'), true, 'a name starting with two dots is not a climb');
  assert.equal(isInside('/W/Output/x.png', '/w/output', 'linux'), false);
  assert.equal(isInside('/W/Output/x.png', '/w/output', 'darwin'), false, 'a macOS volume may be case-sensitive; realPathOf decides');
  assert.equal(isInside('c:\\WS\\Output\\x.png', 'C:\\ws\\output', 'win32'), true);
  assert.equal(isInside('D:\\ws\\output\\x.png', 'C:\\ws\\output', 'win32'), false);
});

// realPathOf: the deepest existing ancestor's real path, with the rest (not created yet) appended.
test('realPathOf resolves the deepest existing ancestor and keeps the part that does not exist yet', async () => {
  const { realPathOf } = await import('../src/workspace.mjs');
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const links = { '/ws/output/link': '/elsewhere', '/ws/output': '/ws/output', '/ws': '/ws', '/': '/' };
  const realpathSync = (p) => links[p] ?? enoent();
  assert.equal(realPathOf('/ws/output/link/new/x.tif', { platform: 'linux', realpathSync }), '/elsewhere/new/x.tif');
  assert.equal(realPathOf('/ws/output/new/x.tif', { platform: 'linux', realpathSync }), '/ws/output/new/x.tif');
  assert.equal(realPathOf('/ws/output/../output/x.tif', { platform: 'linux', realpathSync }), '/ws/output/x.tif');
  assert.equal(realPathOf('/nothing/here', { platform: 'linux', realpathSync: enoent }), '/nothing/here', 'nothing exists: the path as resolved');
  assert.equal(realPathOf('C:\\ws\\output\\x.tif', { platform: 'win32', realpathSync: (p) => (p === 'C:\\ws' ? 'C:\\WS' : enoent()) }), 'C:\\WS\\output\\x.tif');
});

test('the real filesystem: realPathOf sees through a directory link', async (t) => {
  const { realPathOf } = await import('../src/workspace.mjs');
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-real-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'output'));
  mkdirSync(path.join(root, 'elsewhere'));
  symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'output', 'link'), 'junction'); // junction: no privilege needed on Windows
  assert.equal(realPathOf(path.join(root, 'output', 'link', 'x.tif')), path.join(root, 'elsewhere', 'x.tif'));
});

test('a workspace whose state folder has a comma in its path is unusable, naming why and the fix', async () => {
  const s = make({ cwd: R('/astro/T,two') }).snapshot();
  assert.equal(s.usable, false);
  assert.match(s.reason, /PixInsight cannot run a script from a path containing a comma; rename the folder or set PIXINSIGHT_CONNECTOR_STATE to a comma-free folder/);
  assert.throws(() => make({ cwd: R('/astro/T,two') }).require(), (e) => e instanceof WorkspaceError && /comma/.test(e.message));
  await assert.rejects(make().set(R('/astro/T,two')), (e) => e instanceof WorkspaceError && /comma/.test(e.message));
  // Only the state folder matters: the watcher script lives there, and an absolute PIXINSIGHT_CONNECTOR_STATE moves it.
  assert.equal(make({ cwd: R('/astro/T,two'), env: { PIXINSIGHT_CONNECTOR_STATE: R('/state') } }).snapshot().usable, true);
  assert.match(make({ env: { PIXINSIGHT_CONNECTOR_STATE: 'st,x' } }).snapshot().reason, /comma/);
});

test('a workspace whose state folder has a double quote in its path is unusable', async () => {
  const s = make({ cwd: R('/astro/T"q') }).snapshot();
  assert.equal(s.usable, false);
  assert.match(s.reason, /PixInsight cannot run a script from a path containing a double quote/);
  await assert.rejects(make().set(R('/astro/T"q')), (e) => e instanceof WorkspaceError && /double quote/.test(e.message));
});

test('a space in the path is fine', () => {
  assert.equal(make({ cwd: R('/astro/T one') }).snapshot().usable, true);
});
