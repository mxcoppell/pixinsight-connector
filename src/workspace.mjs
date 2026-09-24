// ============================================================================
// The workspace: the folder a session's data belongs to, and the state dir
// under it (`<workspace>/agentic`, or $PIXINSIGHT_CONNECTOR_STATE resolved
// against the workspace) that holds `scratch/`, `bridge/` and `logs/`.
// Deliverables go to `<workspace>/output`, which $PIXINSIGHT_CONNECTOR_STATE does
// not move. Those two folders are the only places core tools write.
//
// Resolution, highest first: set_workspace (set() below, at runtime) >
// $PIXINSIGHT_CONNECTOR_WORKSPACE > the launch folder (cwd).
//
// A workspace is unusable when it is the filesystem root, the user's home
// directory itself, a folder that does not exist or cannot be written, or one
// whose state folder PixInsight cannot run the watcher script from (a comma
// or a double quote in its path; see scriptPathProblem). A
// harness may launch the server from a folder that means nothing (Claude
// Desktop, for one), so an unusable workspace never stops the server: the
// server starts and lists its tools, and every tool that needs the workspace
// fails with a WorkspaceError that names the fix (require() below).
//
// Every OS-dependent input (cwd, env, homeDir, platform, fs) is injectable.
// Checking a folder only reads (realpath, stat, access); nothing here writes.
// ============================================================================
import path from 'node:path';
import os from 'node:os';
import * as nodeFs from 'node:fs';

export const WORKSPACE_FIX = 'call set_workspace with the target folder, or set PIXINSIGHT_CONNECTOR_WORKSPACE';

// Thrown for a tool call that needs the workspace while it is unusable, and by set() for a folder
// it refuses. The server returns its message as the tool's error result.
export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

// scriptPathProblem(p) -> why PixInsight cannot run a script at `p` with `-x=<p>`, or null.
//
// PixInsight turns `-x=<arg>` into the console command `run -a="<after the first comma>" -x=auto
// "<before the first comma>"`: it splits at the first comma before anything else (no quoting or
// escaping protects it), so a comma in the path runs a different path. A double quote would end the
// quoted path early. Spaces are fine. Checked for a workspace's state folder (where the watcher
// script is written) and again at the launch itself.
export function scriptPathProblem(p) {
  const s = String(p);
  if (s.includes(',')) {
    return 'PixInsight cannot run a script from a path containing a comma; rename the folder or set PIXINSIGHT_CONNECTOR_STATE to a comma-free folder';
  }
  if (s.includes('"')) {
    return 'PixInsight cannot run a script from a path containing a double quote; rename the folder or set PIXINSIGHT_CONNECTOR_STATE to a folder without one';
  }
  return null;
}

const SOURCE_LABEL = {
  cwd: 'the launch folder',
  PIXINSIGHT_CONNECTOR_WORKSPACE: 'from PIXINSIGHT_CONNECTOR_WORKSPACE',
  set_workspace: 'from set_workspace',
};

// workspacePaths(dir, env) -> { dir, stateDir, scratchDir, bridgeDir, logsDir, outputDir }
//
// $PIXINSIGHT_CONNECTOR_STATE is resolved against the workspace: a relative path would otherwise mean one
// folder to Node (the server's cwd) and another to PixInsight (its own). An absolute value moves the
// whole state folder (bridge, watcher script, logs) outside the target: the one explicit override of
// "the connector writes only the target's agentic/ and output/" (README).
export function workspacePaths(dir, env = {}) {
  const stateDir = env.PIXINSIGHT_CONNECTOR_STATE ? path.resolve(dir, env.PIXINSIGHT_CONNECTOR_STATE) : path.join(dir, 'agentic');
  return {
    dir,
    stateDir,
    scratchDir: path.join(stateDir, 'scratch'),
    bridgeDir: path.join(stateDir, 'bridge'),
    logsDir: path.join(stateDir, 'logs'),
    outputDir: path.join(dir, 'output'),
  };
}

// The path module and the case rule of `platform`'s file systems. Windows is case-insensitive
// (C:\Users\Me is C:\users\me). A macOS volume may be either, so case is never folded there: the
// native realpath returns a case-insensitive volume's on-disk case (realPathOf below), which is what
// tells two spellings of one folder apart from two folders on a case-sensitive volume.
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const foldsCase = (platform) => platform === 'win32';

// isInside(child, parent, platform) -> true when `child`, resolved, is `parent` or lies under it.
// Lexical (path.resolve, no realpath): `..` segments are resolved before the comparison, so they
// cannot climb out, and a sibling that only shares a prefix (`output-old` next to `output`) is
// outside. Compare realPathOf() results to see through links and a volume's case rule.
export function isInside(child, parent, platform = process.platform) {
  const p = pathFor(platform);
  const canon = (s) => (foldsCase(platform) ? p.resolve(s).toLowerCase() : p.resolve(s));
  const rel = p.relative(canon(parent), canon(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel));
}

// realPathOf(p, { platform, realpathSync }) -> `p` resolved, with its deepest existing ancestor
// replaced by that ancestor's real path and the rest (not created yet) appended as given. Links
// are followed and, with the native realpath, a case-insensitive volume's on-disk case is used.
// When nothing on the way up resolves (or resolves to something `platform` would not call
// absolute), the path is returned as resolved.
export function realPathOf(p, { platform = process.platform, realpathSync = nodeFs.realpathSync.native } = {}) {
  const P = pathFor(platform);
  const resolved = P.resolve(p);
  const tail = [];
  for (let head = resolved; ;) {
    let real = null;
    try { real = realpathSync(head); } catch {}
    if (typeof real === 'string' && P.isAbsolute(real)) return tail.length ? P.join(real, ...tail) : real;
    const up = P.dirname(head);
    if (up === head) return resolved;
    tail.unshift(P.basename(head));
    head = up;
  }
}

// `~`, `~/x` and `~\x` against the home directory; anything else unchanged.
function expandHome(p, homeDir) {
  const m = /^~(?:[\\/](.*))?$/s.exec(p);
  if (!m) return p;
  return m[1] ? path.join(homeDir, m[1]) : homeDir;
}

function initialDir({ cwd, env, homeDir }) {
  const fromEnv = env.PIXINSIGHT_CONNECTOR_WORKSPACE;
  if (fromEnv) return { dir: path.resolve(cwd, expandHome(fromEnv, homeDir)), source: 'PIXINSIGHT_CONNECTOR_WORKSPACE' };
  return { dir: cwd, source: 'cwd' };
}

// Why `dir` cannot be the workspace, or null when it can.
function unusableReason(dir, { env, homeDir, platform, fs }) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  // Windows is case-insensitive: C:\Users\Me is C:\users\me. On macOS the realpaths decide
  // (a volume may be case-sensitive; see foldsCase).
  const canon = (p) => (foldsCase(platform) ? p.toLowerCase() : p);
  const dirReal = real(dir);
  const at = dirReal ?? dir;
  if (path.parse(at).root === at) return 'is the filesystem root';
  if (homeDir && canon(at) === canon(real(homeDir) ?? path.resolve(homeDir))) return 'is the home directory itself';
  let st;
  try { st = dirReal === null ? null : fs.statSync(dirReal); } catch { st = null; }
  if (!st) return 'does not exist';
  if (!st.isDirectory()) return 'is not a directory';
  try { fs.accessSync(dirReal, nodeFs.constants.W_OK); } catch { return 'is not writable'; }
  const { stateDir } = workspacePaths(dir, env);
  const problem = scriptPathProblem(stateDir);
  if (problem) return `has its state folder at "${stateDir}", where the watcher script would go: ${problem}`;
  return null;
}

const defaultFs = { statSync: nodeFs.statSync, accessSync: nodeFs.accessSync, realpathSync: nodeFs.realpathSync.native };

// createWorkspace({ cwd, env, homeDir, platform, fs, log }) -> workspace
//
//   snapshot()  -> { dir, source, usable, reason, stateDir, scratchDir, bridgeDir, logsDir, outputDir }
//                  `source` is 'set_workspace' | 'PIXINSIGHT_CONNECTOR_WORKSPACE' | 'cwd'; `reason` is null
//                  when usable. The folder is checked on each snapshot, so creating it (or making it
//                  writable) takes effect without a restart, and one deleted or unmounted
//                  mid-session is unusable from the next call on.
//   require()   -> the snapshot, or throws WorkspaceError naming the fix when unusable.
//   set(p)      -> Promise<{ previous, current, warnings }>: switches to `p` (absolute, or ~/...),
//                  or throws WorkspaceError and keeps the current workspace. Awaits every onChange
//                  listener in registration order when the folder changed (or the old one was
//                  unusable); a listener that throws is logged and reported in `warnings`, and the
//                  switch stands. Concurrent calls run one after another.
//   onChange(fn) -> unsubscribe. fn({ previous, current }) may be async.
export function createWorkspace({
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  fs = defaultFs,
  log = () => {},
} = {}) {
  const check = (dir) => unusableReason(dir, { env, homeDir, platform, fs });
  let state = initialDir({ cwd, env, homeDir });
  let reason = check(state.dir);
  const listeners = [];

  // Checked on every snapshot, not only while unusable: a workspace deleted or unmounted after it
  // was first used must fail the next call with the fix, not be re-created by whatever writes next.
  // The check is a few reads (realpath, stat, access).
  function snapshot() {
    reason = check(state.dir);
    return { ...workspacePaths(state.dir, env), source: state.source, usable: !reason, reason };
  }

  function describe(s) {
    return `No usable workspace: "${s.dir}" (${SOURCE_LABEL[s.source]}) ${s.reason}. To fix it, ${WORKSPACE_FIX}.`;
  }

  function require() {
    const s = snapshot();
    if (!s.usable) throw new WorkspaceError(describe(s));
    return s;
  }

  // Switches run one at a time, so each one's listeners finish before the next switch starts and
  // every switch sees the one before it as `previous`.
  let queue = Promise.resolve();
  function set(requested) {
    const run = queue.then(() => doSet(requested));
    queue = run.catch(() => {});
    return run;
  }

  async function doSet(requested) {
    if (typeof requested !== 'string' || !requested.trim()) throw new WorkspaceError('set_workspace needs a folder path.');
    const expanded = expandHome(requested.trim(), homeDir);
    if (!path.isAbsolute(expanded)) {
      throw new WorkspaceError(`Cannot use "${requested}" as the workspace: the path must be absolute or start with ~/.`);
    }
    const dir = path.resolve(expanded);
    const why = check(dir);
    if (why) throw new WorkspaceError(`Cannot use "${dir}" as the workspace: it ${why}.`);

    const previous = snapshot();
    state = { dir, source: 'set_workspace' };
    reason = null;
    const current = snapshot();
    const warnings = [];
    if (previous.dir !== current.dir || !previous.usable) {
      for (const fn of [...listeners]) {
        try {
          await fn({ previous, current });
        } catch (e) {
          const w = `workspace change: ${e?.message ?? e}`;
          warnings.push(w);
          log(w);
        }
      }
    }
    return { previous, current, warnings };
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  return Object.freeze({ snapshot, require, set, onChange });
}
