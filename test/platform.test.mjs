import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatform, PlatformError, toPixPath } from '../src/platform.mjs';

test('macOS default layout resolves', () => {
  const p = resolvePlatform({ env: {}, platform: 'darwin', existsSync: () => true, homeDir: '/Users/u' });
  assert.equal(p.piBin, '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight');
  assert.match(p.imageSolverPath, /ImageSolver\.js$/);
  assert.equal(p.verified, true);
});

test('Windows default layout resolves', () => {
  const p = resolvePlatform({
    env: {},
    platform: 'win32',
    existsSync: () => true,
    homeDir: 'C:\\Users\\u',
  });
  assert.equal(p.piBin, 'C:\\Program Files\\PixInsight\\bin\\PixInsight.exe');
  assert.match(p.imageSolverPath, /ImageSolver\.js$/);
  assert.equal(p.filterDbPath, 'C:\\Program Files\\PixInsight\\library\\filters.xspd');
  assert.equal(p.whiteRefPath, 'C:\\Program Files\\PixInsight\\library\\white-references.xspd');
  assert.equal(p.verified, false);
});

test('Linux default layout resolves', () => {
  const p = resolvePlatform({
    env: {},
    platform: 'linux',
    existsSync: () => true,
    homeDir: '/home/u',
  });
  assert.equal(p.piBin, '/opt/PixInsight/bin/PixInsight');
  assert.match(p.imageSolverPath, /ImageSolver\.js$/);
  assert.equal(p.filterDbPath, '/opt/PixInsight/library/filters.xspd');
  assert.equal(p.whiteRefPath, '/opt/PixInsight/library/white-references.xspd');
  assert.equal(p.verified, false);
});

test('PIXINSIGHT_BIN overrides discovery', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/opt/pi/PixInsight' },
    platform: 'linux',
    existsSync: () => false,
    homeDir: '/home/u',
  });
  assert.equal(p.piBin, '/opt/pi/PixInsight');
});

// An existsSync that knows exactly the given paths.
const only = (...paths) => (p) => paths.includes(p);

// PIXINSIGHT_BIN alone must not leave ImageSolver (the watcher #includes it), the filter database
// and the white references at the default root: the install root is derived from the executable
// by the OS's own layout.
test('PIXINSIGHT_BIN alone derives the install root on macOS (4 levels above the .app executable)', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/Volumes/Apps/PixInsight/PixInsight.app/Contents/MacOS/PixInsight' },
    platform: 'darwin', existsSync: only('/Volumes/Apps/PixInsight/src/scripts/ImageSolver/ImageSolver.js'), homeDir: '/Users/u',
  });
  assert.equal(p.piBin, '/Volumes/Apps/PixInsight/PixInsight.app/Contents/MacOS/PixInsight');
  assert.equal(p.imageSolverPath, '/Volumes/Apps/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  assert.equal(p.filterDbPath, '/Volumes/Apps/PixInsight/library/filters.xspd');
  assert.equal(p.whiteRefPath, '/Volumes/Apps/PixInsight/library/white-references.xspd');
});

test('PIXINSIGHT_BIN alone derives the install root on Windows (the folder above bin\\)', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: 'D:\\Apps\\PixInsight\\bin\\PixInsight.exe' },
    platform: 'win32', existsSync: only('D:\\Apps\\PixInsight\\src\\scripts\\ImageSolver\\ImageSolver.js'), homeDir: 'C:\\Users\\u',
  });
  assert.equal(p.imageSolverPath, 'D:\\Apps\\PixInsight\\src\\scripts\\ImageSolver\\ImageSolver.js');
  assert.equal(p.filterDbPath, 'D:\\Apps\\PixInsight\\library\\filters.xspd');
  assert.equal(p.whiteRefPath, 'D:\\Apps\\PixInsight\\library\\white-references.xspd');
});

test('PIXINSIGHT_BIN alone derives the install root on Linux (the folder above bin/)', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/home/u/apps/PixInsight/bin/PixInsight' },
    platform: 'linux', existsSync: only('/home/u/apps/PixInsight/src/scripts/ImageSolver/ImageSolver.js'), homeDir: '/home/u',
  });
  assert.equal(p.imageSolverPath, '/home/u/apps/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  assert.equal(p.filterDbPath, '/home/u/apps/PixInsight/library/filters.xspd');
  assert.equal(p.whiteRefPath, '/home/u/apps/PixInsight/library/white-references.xspd');
});

test('PIXINSIGHT_DIR still wins for resources when both overrides are set', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/elsewhere/bin/PixInsight', PIXINSIGHT_DIR: '/custom/PixInsight' },
    platform: 'linux', existsSync: () => false, homeDir: '/home/u',
  });
  assert.equal(p.piBin, '/elsewhere/bin/PixInsight');
  assert.equal(p.imageSolverPath, '/custom/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
});

test('a PIXINSIGHT_BIN outside the OS layout keeps the default root (doctor then flags the resources)', () => {
  const mac = resolvePlatform({ env: { PIXINSIGHT_BIN: '/usr/local/bin/pixinsight' }, platform: 'darwin', existsSync: () => false, homeDir: '/Users/u' });
  assert.equal(mac.imageSolverPath, '/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  const win = resolvePlatform({ env: { PIXINSIGHT_BIN: 'D:\\PixInsight.exe' }, platform: 'win32', existsSync: () => false, homeDir: 'C:\\Users\\u' });
  assert.equal(win.imageSolverPath, 'C:\\Program Files\\PixInsight\\src\\scripts\\ImageSolver\\ImageSolver.js');
});

// A root derived from PIXINSIGHT_BIN is only trusted when the install is really there: a PATH
// symlink (/usr/bin/PixInsight) or a bare /Applications/PixInsight.app has the layout's shape but
// not the install above it, and must keep the default root as before.
test('a PIXINSIGHT_BIN whose derived root holds no install keeps the default root', () => {
  const linux = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/usr/bin/PixInsight' },
    platform: 'linux', existsSync: only('/opt/PixInsight/src/scripts/ImageSolver/ImageSolver.js'), homeDir: '/home/u',
  });
  assert.equal(linux.piBin, '/usr/bin/PixInsight');
  assert.equal(linux.imageSolverPath, '/opt/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  assert.equal(linux.filterDbPath, '/opt/PixInsight/library/filters.xspd');
  const mac = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/Applications/PixInsight.app/Contents/MacOS/PixInsight' },
    platform: 'darwin', existsSync: () => false, homeDir: '/Users/u',
  });
  assert.equal(mac.imageSolverPath, '/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  const win = resolvePlatform({
    env: { PIXINSIGHT_BIN: 'D:\\Tools\\bin\\PixInsight.exe' },
    platform: 'win32', existsSync: () => false, homeDir: 'C:\\Users\\u',
  });
  assert.equal(win.imageSolverPath, 'C:\\Program Files\\PixInsight\\src\\scripts\\ImageSolver\\ImageSolver.js');
});

test('PIXINSIGHT_DIR overrides the whole install root', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_DIR: '/custom/PixInsight' },
    platform: 'darwin',
    existsSync: () => true,
    homeDir: '/Users/u',
  });
  assert.equal(p.piBin, '/custom/PixInsight/PixInsight.app/Contents/MacOS/PixInsight');
  assert.equal(p.imageSolverPath, '/custom/PixInsight/src/scripts/ImageSolver/ImageSolver.js');
  assert.equal(p.filterDbPath, '/custom/PixInsight/library/filters.xspd');
  assert.equal(p.whiteRefPath, '/custom/PixInsight/library/white-references.xspd');
});

test('nothing found tells the user which env var to set', () => {
  assert.throws(
    () =>
      resolvePlatform({
        env: {},
        platform: 'win32',
        existsSync: () => false,
        homeDir: 'C:\\Users\\u',
      }),
    /PIXINSIGHT_BIN/
  );
});

test('unresolved platform error is a PlatformError instance', () => {
  assert.throws(
    () =>
      resolvePlatform({ env: {}, platform: 'sunos', existsSync: () => false, homeDir: '/home/u' }),
    (err) => err instanceof PlatformError && /Unsupported platform "sunos"/.test(err.message) && !/PIXINSIGHT_BIN/.test(err.message)
  );
});

test('settings path on macOS is probed via existsSync, not assumed', () => {
  const probed = [];
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/pi' },
    platform: 'darwin',
    homeDir: '/Users/u',
    existsSync: (candidate) => {
      probed.push(candidate);
      return candidate === '/Users/u/Library/PixInsight/core-001-pxi.settings';
    },
  });
  assert.equal(p.settingsPath, '/Users/u/Library/PixInsight/core-001-pxi.settings');
  assert.ok(probed.includes('/Users/u/Library/PixInsight/core-001-pxi.settings'));
});

test('settings path falls back to the documented default when no candidate exists', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: '/pi' },
    platform: 'linux',
    homeDir: '/home/u',
    existsSync: () => false,
  });
  assert.equal(p.settingsPath, '/home/u/.PixInsight/core-001-pxi.settings');
});

test('windows settings path probes a real candidate list: falls through to the second candidate when the first misses', () => {
  const probed = [];
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: 'C:\\pi.exe', APPDATA: 'C:\\CustomAppData' },
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    existsSync: (candidate) => {
      probed.push(candidate);
      return candidate === 'C:\\Users\\u\\AppData\\Roaming\\PixInsight\\core-001-pxi.settings';
    },
  });
  assert.ok(probed.length > 1, 'expected more than one settings candidate to be probed');
  assert.ok(probed.includes('C:\\CustomAppData\\PixInsight\\core-001-pxi.settings'));
  assert.equal(p.settingsPath, 'C:\\Users\\u\\AppData\\Roaming\\PixInsight\\core-001-pxi.settings');
});

test('windows settings path falls back to a homeDir-derived candidate when APPDATA is unset', () => {
  const p = resolvePlatform({
    env: { PIXINSIGHT_BIN: 'C:\\pi.exe' },
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    existsSync: (candidate) => candidate === 'C:\\Users\\u\\AppData\\Roaming\\PixInsight\\core-001-pxi.settings',
  });
  assert.equal(p.settingsPath, 'C:\\Users\\u\\AppData\\Roaming\\PixInsight\\core-001-pxi.settings');
});

test('no OS resolves a watcher location: the watcher script is written into the target, never under home or %ProgramData%', () => {
  for (const [platform, homeDir, bin] of [['darwin', '/Users/u', '/pi'], ['linux', '/home/u', '/pi'], ['win32', 'C:\\Users\\u', 'C:\\pi.exe']]) {
    const p = resolvePlatform({ env: { PIXINSIGHT_BIN: bin, ProgramData: 'C:\\ProgramData' }, platform, homeDir, existsSync: () => true });
    assert.deepEqual(Object.keys(p).sort(), ['filterDbPath', 'imageSolverPath', 'piBin', 'settingsPath', 'verified', 'whiteRefPath'], platform);
    assert.ok(!Object.values(p).some((v) => /pixinsight-connector/.test(String(v))), platform);
  }
});

test('toPixPath hands PixInsight forward slashes whatever separators a path arrived with', () => {
  assert.equal(toPixPath('C:\\Users\\u\\ws\\agentic\\scratch\\previews\\a.jpg'), 'C:/Users/u/ws/agentic/scratch/previews/a.jpg');
  assert.equal(toPixPath('/Users/u/ws/a.jpg'), '/Users/u/ws/a.jpg');
  assert.equal(toPixPath('C:/mixed\\path'), 'C:/mixed/path');
  assert.equal(toPixPath('\\\\nas\\share\\T'), '//nas/share/T', 'UNC');
  assert.equal(toPixPath('\\Astro\\T'), '/Astro/T', 'a drive-relative Windows path (path.sep is \\ there)');
});

test('toPixPath leaves a POSIX path alone: a backslash there is part of a file name, not a separator', () => {
  assert.equal(toPixPath('/t/back\\slash/agentic/bridge/rig'), '/t/back\\slash/agentic/bridge/rig');
  assert.equal(toPixPath('/Users/u/M42\\Orion.xisf'), '/Users/u/M42\\Orion.xisf');
});
