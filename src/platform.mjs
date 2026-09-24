// Single source of truth for every filesystem path the connector needs.
//
// Every OS-dependent decision is driven entirely by the parameters passed
// in — never by reading `process.platform` / `os.homedir()` / the real
// filesystem directly — so all three OS layouts are exercisable from any
// single development machine.
//
// Candidate table (see task brief for the full rationale):
//
//                    | macOS (confirmed)                     | Windows                              | Linux
//   install root     | /Applications/PixInsight               | C:\Program Files\PixInsight          | /opt/PixInsight
//   executable        | <root>/PixInsight.app/Contents/MacOS/PixInsight | <root>\bin\PixInsight.exe    | <root>/bin/PixInsight
//   ImageSolver       | <root>/src/scripts/ImageSolver/ImageSolver.js  | same, under root              | same, under root
//   filters DB        | <root>/library/filters.xspd                    | same                          | same
//   white refs        | <root>/library/white-references.xspd           | same                          | same
//   core settings     | ~/Library/PixInsight/core-001-pxi.settings     | %APPDATA%\PixInsight\core-001-pxi.settings | ~/.PixInsight/core-001-pxi.settings
//
// Only the macOS column has been confirmed against a real install; the
// Windows and Linux columns come from PixInsight's documented layouts and
// are marked `verified: false` until `doctor` runs and confirms them there.
//
// The watcher script PixInsight is launched with (`-x=<path>`) is written into the target folder
// (src/runtime.mjs materializeWatcher), so no path here is needed for it.

// A path as PixInsight is handed it: forward slashes. PixInsight accepts them on every OS, a
// backslash inside a PJSR string literal is an escape, and whether every PJSR API and the `-x=`
// launch accept backslashes on Windows is unverified. Only a Windows path is converted: a POSIX
// absolute path (one leading `/`, which no absolute Windows path has: those start with a drive
// letter, `\\` or `\`) is returned unchanged, because a backslash there is a character of a file
// or folder name, not a separator. Decided by the path's own shape, never by the host OS, so both
// cases are testable from any OS.
export function toPixPath(p) {
  const s = String(p);
  if (/^\/(?![\\/])/.test(s)) return s;
  return s.replace(/\\/g, '/');
}

export class PlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformError';
  }
}

function win(p) {
  return p.split('/').join('\\');
}

function joinPosix(root, ...segments) {
  return [root, ...segments].join('/');
}

function joinWin(root, ...segments) {
  return [root, ...segments].join('\\');
}

// The install root above an executable at `<root>/<...binSegments>`, or null when `bin` does not
// end in that layout. Accepts either separator (a Windows path may arrive with forward slashes);
// joins the result with the OS's own separator.
function rootAbove(bin, binSegments, sep, sameName) {
  const parts = String(bin).split(/[\\/]/);
  const n = binSegments.length;
  if (parts.length <= n) return null;
  const tail = parts.slice(-n);
  // The executable's own file name is free (PixInsight, PixInsight.exe, a renamed copy); only the
  // directories above it have to match the layout.
  for (let i = 0; i < n - 1; i++) {
    if (!sameName(tail[i], binSegments[i])) return null;
  }
  const root = parts.slice(0, -n).join(sep);
  return root || null;
}

const exact = (a, b) => (b instanceof RegExp ? b.test(a) : a === b);
const caseless = (a, b) => (b instanceof RegExp ? b.test(a) : a.toLowerCase() === b.toLowerCase());

// Per-OS layout, expressed as functions of the install root so that
// PIXINSIGHT_DIR can override every derived path at once. `rootFromBin` inverts `piBin`: it is how
// PIXINSIGHT_BIN alone still finds ImageSolver, the filter database and the white references.
const LAYOUTS = {
  darwin: {
    defaultRoot: '/Applications/PixInsight',
    verified: true,
    piBin: (root) => joinPosix(root, 'PixInsight.app/Contents/MacOS/PixInsight'),
    rootFromBin: (bin) => rootAbove(bin, [/\.app$/i, 'Contents', 'MacOS', null], '/', exact),
    imageSolverPath: (root) => joinPosix(root, 'src/scripts/ImageSolver/ImageSolver.js'),
    filterDbPath: (root) => joinPosix(root, 'library/filters.xspd'),
    whiteRefPath: (root) => joinPosix(root, 'library/white-references.xspd'),
    settingsCandidates: (homeDir) => [joinPosix(homeDir, 'Library/PixInsight/core-001-pxi.settings')],
    settingsDefault: (homeDir) => joinPosix(homeDir, 'Library/PixInsight/core-001-pxi.settings'),
  },
  win32: {
    defaultRoot: win('C:/Program Files/PixInsight'),
    verified: false,
    piBin: (root) => joinWin(root, 'bin\\PixInsight.exe'),
    rootFromBin: (bin) => rootAbove(bin, ['bin', null], '\\', caseless),
    imageSolverPath: (root) => joinWin(root, 'src\\scripts\\ImageSolver\\ImageSolver.js'),
    filterDbPath: (root) => joinWin(root, 'library\\filters.xspd'),
    whiteRefPath: (root) => joinWin(root, 'library\\white-references.xspd'),
    settingsCandidates: (homeDir, env) => {
      const candidates = [];
      if (env.APPDATA) candidates.push(joinWin(env.APPDATA, 'PixInsight\\core-001-pxi.settings'));
      candidates.push(joinWin(homeDir, 'AppData\\Roaming\\PixInsight\\core-001-pxi.settings'));
      return candidates;
    },
    settingsDefault: (homeDir, env) =>
      env.APPDATA
        ? joinWin(env.APPDATA, 'PixInsight\\core-001-pxi.settings')
        : joinWin(homeDir, 'AppData\\Roaming\\PixInsight\\core-001-pxi.settings'),
  },
  linux: {
    defaultRoot: '/opt/PixInsight',
    verified: false,
    piBin: (root) => joinPosix(root, 'bin/PixInsight'),
    rootFromBin: (bin) => rootAbove(bin, ['bin', null], '/', exact),
    imageSolverPath: (root) => joinPosix(root, 'src/scripts/ImageSolver/ImageSolver.js'),
    filterDbPath: (root) => joinPosix(root, 'library/filters.xspd'),
    whiteRefPath: (root) => joinPosix(root, 'library/white-references.xspd'),
    settingsCandidates: (homeDir) => [joinPosix(homeDir, '.PixInsight/core-001-pxi.settings')],
    settingsDefault: (homeDir) => joinPosix(homeDir, '.PixInsight/core-001-pxi.settings'),
  },
};

/**
 * Resolve every filesystem path the connector needs, for one OS layout.
 *
 * @param {object} params
 * @param {Record<string, string|undefined>} params.env - process.env, or an injected fake.
 * @param {string} params.platform - process.platform, or an injected fake ('darwin'|'win32'|'linux'|...).
 * @param {(path: string) => boolean} params.existsSync - fs.existsSync, or an injected fake.
 * @param {string} params.homeDir - os.homedir(), or an injected fake.
 * @returns {{ piBin: string, imageSolverPath: string, filterDbPath: string, whiteRefPath: string, settingsPath: string, verified: boolean }}
 */
export function resolvePlatform({ env, platform, existsSync, homeDir }) {
  const layout = LAYOUTS[platform];
  if (!layout) {
    throw new PlatformError(
      `Unsupported platform "${platform}": the connector supports macOS (darwin), Windows (win32) and Linux.`
    );
  }

  // PIXINSIGHT_DIR names the root outright. Otherwise a PIXINSIGHT_BIN that follows the OS layout
  // implies it, but only when ImageSolver is really there: a PATH symlink (/usr/bin/PixInsight) or a
  // bare /Applications/PixInsight.app has the layout's shape with no install above it. Anything else
  // keeps the default root, and doctor's imagesolver/filter-db checks then say so.
  const derived = !env.PIXINSIGHT_DIR && env.PIXINSIGHT_BIN ? layout.rootFromBin(env.PIXINSIGHT_BIN) : null;
  const trusted = derived && existsSync(layout.imageSolverPath(derived)) ? derived : null;
  const root = env.PIXINSIGHT_DIR || trusted || layout.defaultRoot;
  const piBin = env.PIXINSIGHT_BIN || layout.piBin(root);

  if (!env.PIXINSIGHT_BIN && !env.PIXINSIGHT_DIR && !existsSync(piBin)) {
    throw new PlatformError(
      `Could not find a PixInsight installation (looked for "${piBin}"). ` +
        'Set the PIXINSIGHT_BIN environment variable to your PixInsight executable path, ' +
        'or PIXINSIGHT_DIR to your PixInsight install root.'
    );
  }

  const settingsCandidates = layout.settingsCandidates(homeDir, env);
  const settingsPath =
    settingsCandidates.find((candidate) => existsSync(candidate)) || layout.settingsDefault(homeDir, env);

  return {
    piBin,
    imageSolverPath: layout.imageSolverPath(root),
    filterDbPath: layout.filterDbPath(root),
    whiteRefPath: layout.whiteRefPath(root),
    settingsPath,
    verified: layout.verified,
  };
}
