// ============================================================================
// `doctor`: one read-only pass over every assumption the connector makes about
// the machine it's running on, turning "it doesn't work" into a paste. Thirteen
// checks, each a single line of output: `{ name, ok, detail, hint? }`, run in a
// fixed order. It writes no file anywhere; its one side effect is binding the
// launch-mutex port for an instant to see whether it is free.
//
// Every OS-dependent DECISION this connector makes lives behind an injectable
// module elsewhere (resolvePlatform, createProcessProbe, materializeWatcher)
// and doctor receives their output already resolved, via its own signature --
// same testability convention as the rest of the restructure. What doctor
// itself does directly with `node:fs` (the imagesolver/filter-db/settings
// existence checks, and reading the call-log dir) is deliberate: unlike
// those other modules, doctor's whole job is inspecting the real, current
// machine -- there is nothing to fake, the real filesystem *is* the thing
// under test. See the individual check functions below for the reasoning
// behind each one's pass/fail semantics.
// ============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeWatcher, spaceInPathNote, createLaunchMutex } from './runtime.mjs';
import { createWorkspace, WORKSPACE_FIX } from './workspace.mjs';
import { machineId as realMachineId } from './machine-id.mjs';

const MIN_NODE_MAJOR = 22;

// A generic "this earlier check must be fixed first" hint, used by every
// check that depends on `platform` having actually resolved.
const FIX_PLATFORM_FIRST_HINT = "Fix the 'platform' check above first, then re-run doctor.";

// ---------------------------------------------------------------------------
// Small helpers shared by several checks.
// ---------------------------------------------------------------------------

// Never print a full home path in doctor output -- the ~/... form is exactly
// as actionable for the person reading it (it's still their own machine) but
// doesn't spell out their OS username or full home layout, e.g. in a pasted
// `doctor --json` bug report.
function redactHome(p, homeDir) {
  if (!p || !homeDir) return p;
  const norm = (s) => String(s).replace(/\\/g, '/');
  const np = norm(p);
  const nh = norm(homeDir).replace(/\/+$/, '');
  if (nh && np.toLowerCase().startsWith(nh.toLowerCase())) {
    return `~${np.slice(nh.length)}`;
  }
  return p;
}

// Longest common leading path segment of two paths from the same install,
// used only to *display* an install root -- resolvePlatform itself never
// returns one, since PIXINSIGHT_BIN alone (no PIXINSIGHT_DIR) can name a
// binary with no discoverable root at all.
function commonRoot(a, b) {
  if (!a || !b) return null;
  const as = String(a).split(/[\\/]/);
  const bs = String(b).split(/[\\/]/);
  const common = [];
  for (let i = 0; i < Math.min(as.length, bs.length) && as[i] === bs[i]; i++) common.push(as[i]);
  return common.length > 1 ? common.join('/') : null;
}

export function readConnectorVersion() {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

// materializeWatcher (src/runtime.mjs) over memory: doctor renders the watcher exactly as a session
// would, to prove the template and both substitutions work, but never writes it into the target.
function memoryFs() {
  const files = new Map();
  return {
    readFile: async (p) => (p instanceof URL ? fsp.readFile(p, 'utf8') : files.has(p) ? files.get(p) : Promise.reject(new Error('ENOENT'))),
    writeFile: async (p, data) => { files.set(p, data); },
    mkdir: async () => {},
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    stat: (p) => fsp.stat(p).catch(() => null),
  };
}

// ---------------------------------------------------------------------------
// The checks, in the documented order.
// ---------------------------------------------------------------------------

function nodeCheck() {
  const major = Number(process.version.slice(1).split('.')[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  const check = { name: 'node', ok, detail: `Node ${process.version} (>=${MIN_NODE_MAJOR} required)` };
  if (!ok) check.hint = `Install Node.js ${MIN_NODE_MAJOR} or newer, then re-run doctor.`;
  return check;
}

// pixinsight-mcp 1.x is this connector under its old name. Its command still on PATH usually means a
// harness entry still runs it, and two servers driving one PixInsight compete for its one script slot.
function legacyCommandCheck(env, osName, homeDir, existsSync) {
  const win = osName === 'win32';
  const p = win ? path.win32 : path.posix;
  const key = win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const dirs = (key && env[key] ? env[key] : '').split(win ? ';' : ':').filter(Boolean);
  const names = win ? ['pixinsight-mcp.cmd', 'pixinsight-mcp.ps1', 'pixinsight-mcp.exe', 'pixinsight-mcp'] : ['pixinsight-mcp'];
  for (const dir of dirs) {
    for (const n of names) {
      const found = p.join(dir, n);
      if (!existsSync(found)) continue;
      return {
        name: 'pixinsight-mcp',
        ok: false,
        detail: `pixinsight-mcp 1.x (this connector's old name) is still installed at ${redactHome(found, homeDir)}.`,
        hint: 'Run npm uninstall -g pixinsight-mcp, and make sure your harness registers one PixInsight server: pixinsight, with the command pixinsight-connector.',
      };
    }
  }
  return { name: 'pixinsight-mcp', ok: true, detail: 'No pixinsight-mcp 1.x command on PATH.' };
}

// `platform` is a soft check: an unresolved platform (null) is a hard
// failure (nothing downstream can be checked), but a *resolved-but-
// unverified* platform (the documented Windows/Linux layout guesses) is only
// a note, not a failure -- the real pass/fail signal for "is PixInsight
// actually there" is the pixinsight-binary check right after this one.
function platformCheck(platform, env, homeDir, platformError, osName) {
  if (!platform) {
    return {
      name: 'platform',
      ok: false,
      // The OS is named even here: an unresolved install is when a bug report is most likely.
      detail: `OS ${osName}: ${platformError ? redactHome(platformError, homeDir) : 'could not resolve a PixInsight install.'}`,
      hint:
        'Install PixInsight, or set PIXINSIGHT_BIN (to the executable) or PIXINSIGHT_DIR ' +
        '(to the install root), then re-run doctor.',
    };
  }
  const root = commonRoot(platform.piBin, platform.imageSolverPath);
  const rootText = root ? `install root ${redactHome(root, homeDir)}, ` : '';
  const verifiedText = platform.verified ? 'verified' : 'unverified';
  const overrideText = env?.PIXINSIGHT_BIN
    ? ' [PIXINSIGHT_BIN override]'
    : env?.PIXINSIGHT_DIR
      ? ' [PIXINSIGHT_DIR override]'
      : '';
  return {
    name: 'platform',
    ok: true,
    detail:
      `OS ${osName}, ${rootText}candidate ${redactHome(platform.piBin, homeDir)} ` +
      `(${verifiedText})${overrideText}`,
  };
}

function pixinsightBinaryCheck(platform, homeDir) {
  if (!platform || !platform.piBin) {
    return {
      name: 'pixinsight-binary',
      ok: false,
      detail: 'No PixInsight binary candidate to check (platform not resolved).',
      hint: FIX_PLATFORM_FIRST_HINT,
    };
  }
  const { piBin } = platform;
  const shown = redactHome(piBin, homeDir);
  if (!fs.existsSync(piBin)) {
    return {
      name: 'pixinsight-binary',
      ok: false,
      detail: `PixInsight binary not found at ${shown}.`,
      hint: 'Install PixInsight there, or set PIXINSIGHT_BIN / PIXINSIGHT_DIR to its real location.',
    };
  }
  let executable = true;
  try {
    fs.accessSync(piBin, fs.constants.X_OK);
  } catch {
    executable = false;
  }
  if (!executable) {
    return {
      name: 'pixinsight-binary',
      ok: false,
      detail: `PixInsight binary exists at ${shown} but is not executable.`,
      hint: `Run "chmod +x ${shown}" (or reinstall PixInsight), then re-run doctor.`,
    };
  }
  return { name: 'pixinsight-binary', ok: true, detail: `PixInsight binary found and executable at ${shown}.` };
}

// Liveness is informational, never a failure: `null` means the OS couldn't
// answer (unknown), and `false` just means PixInsight hasn't been launched
// yet -- ensurePixInsight (src/runtime.mjs) starts it automatically on the
// first real tool call, so "not running right now" is a normal resting
// state, not a problem to report as red.
async function pixinsightRunningCheck(probe, env) {
  let running = null;
  try {
    running = await probe.isRunning();
  } catch {
    running = null;
  }
  if (running === null) {
    return {
      name: 'pixinsight-running',
      ok: true,
      detail: 'PixInsight liveness could not be determined on this OS (unknown, not a failure).',
    };
  }
  if (running) {
    return { name: 'pixinsight-running', ok: true, detail: 'PixInsight is currently running.' };
  }
  const autostartOff = env?.PIXINSIGHT_CONNECTOR_AUTOSTART === '0';
  return {
    name: 'pixinsight-running',
    ok: true,
    detail: autostartOff
      ? 'PixInsight is not running, and PIXINSIGHT_CONNECTOR_AUTOSTART=0 disables starting it automatically.'
      : 'PixInsight is not running (it will be started automatically on the first tool call).',
  };
}

// Where this workspace's watcher script goes (written into the target before each launch) and that
// the template renders there. Nothing is written: the render is in memory. A state path with a
// space is launched as one `-x=` argument, verified on macOS only: a note elsewhere, never a failure.
async function watcherCheck(platform, workspace, id, homeDir, osName, watcherFs) {
  if (!platform || !platform.imageSolverPath) {
    return {
      name: 'watcher',
      ok: false,
      detail: 'Cannot render the watcher (platform not resolved).',
      hint: FIX_PLATFORM_FIRST_HINT,
    };
  }
  const s = workspace.snapshot();
  const bridgeDir = path.join(s.bridgeDir ?? path.join(s.dir, 'agentic', 'bridge'), id);
  try {
    const { path: watcherPath } = await materializeWatcher({ platform, version: readConnectorVersion(), bridgeDir, ...(watcherFs ?? memoryFs()) });
    const shown = redactHome(watcherPath, homeDir);
    if (!s.usable) {
      return { name: 'watcher', ok: true, detail: `The watcher renders; a session writes it into its target folder (here it would be ${shown}) before each launch.` };
    }
    const note = spaceInPathNote(osName, s.stateDir);
    return { name: 'watcher', ok: true, detail: `Watcher for this workspace: ${shown}, written before each launch, serving ${redactHome(bridgeDir, homeDir)}.${note ? ` Note: ${note}` : ''}` };
  } catch (e) {
    return {
      name: 'watcher',
      ok: false,
      detail: `The watcher could not be rendered: ${e?.message ?? e}`,
      hint: 'Reinstall the connector (npm install -g pixinsight-connector@latest), then re-run doctor.',
    };
  }
}

const SOURCE_TEXT = {
  cwd: 'the launch folder',
  PIXINSIGHT_CONNECTOR_WORKSPACE: 'from PIXINSIGHT_CONNECTOR_WORKSPACE',
  set_workspace: 'from set_workspace',
};

// The workspace this doctor run resolves (from ITS launch folder, or PIXINSIGHT_CONNECTOR_WORKSPACE): where
// a session's bridge, logs and scratch files go. Only reads. A harness may launch the server from a
// different folder, or call set_workspace, so an unusable launch folder is reported, not failed; an
// unusable PIXINSIGHT_CONNECTOR_WORKSPACE is a misconfiguration and fails.
// The bridge dir a session uses is this machine's subdir of it, named from the hostname
// (src/machine-id.mjs).
function workspaceCheck(workspace, homeDir, id) {
  const s = workspace.snapshot();
  const where = `${redactHome(s.dir, homeDir)} (${SOURCE_TEXT[s.source] ?? s.source})`;
  if (s.usable) {
    const r = (p) => redactHome(p, homeDir);
    const bridge = `bridge ${r(path.join(s.bridgeDir, id))} (this machine's subdir)`;
    return {
      name: 'workspace',
      ok: true,
      detail: `Workspace ${where} is usable: state ${r(s.stateDir)}, ${bridge}, logs ${r(s.logsDir)}, output ${r(s.outputDir)}.`,
    };
  }
  const check = { name: 'workspace', ok: s.source !== 'PIXINSIGHT_CONNECTOR_WORKSPACE', detail: `Workspace ${where} is not usable: it ${s.reason}.` };
  if (check.ok) check.detail += ` A session started here will ask to ${WORKSPACE_FIX}.`;
  else check.hint = 'Point PIXINSIGHT_CONNECTOR_WORKSPACE at an existing, writable folder other than the filesystem root or the home directory, or unset it.';
  return check;
}

// Where this workspace's call logs go (src/call-log.mjs) and whether they are on. Only reads the log dir.
function callLogsCheck(workspace, env, homeDir, fsImpl) {
  if (env.PIXINSIGHT_CONNECTOR_LOG === '0') return { name: 'call-logs', ok: true, detail: 'Call logs are off (PIXINSIGHT_CONNECTOR_LOG=0).' };
  const s = workspace.snapshot();
  if (!s.usable) {
    return { name: 'call-logs', ok: true, detail: `Calls are not logged while the workspace is not usable; a session logs once set_workspace (or PIXINSIGHT_CONNECTOR_WORKSPACE) names a usable folder.` };
  }
  let names = [];
  try { names = fsImpl.readdirSync(s.logsDir).filter((n) => n.endsWith('.jsonl')).sort(); } catch {}
  const found = names.length ? `${names.length} log file${names.length > 1 ? 's' : ''}, latest ${names.at(-1)}` : 'none yet';
  return {
    name: 'call-logs',
    ok: true,
    detail: `Call logs are on: one JSONL file per session in ${redactHome(s.logsDir, homeDir)} (${found}). They hold paths and PJSR code; check before sharing.`,
  };
}

// The launch mutex (src/runtime.mjs createLaunchMutex): the loopback port that keeps two connectors
// from starting PixInsight at once. Informational: bound for an instant and released at once, never
// waited on. When the port is in use, the holder's banner tells a connector starting PixInsight right
// now from another program owning the port.
async function launchMutexCheck(env, net) {
  const m = createLaunchMutex({ net, env, log: () => {} });
  const where = `127.0.0.1:${m.port}${env?.PIXINSIGHT_CONNECTOR_LAUNCH_PORT ? ' (PIXINSIGHT_CONNECTOR_LAUNCH_PORT)' : ''}`;
  let r;
  try { r = await m.acquire({ timeoutMs: -1 }); } catch (e) { r = { held: false, waited: false, error: e }; }
  await r.release?.();
  if (r.held) return { name: 'launch-mutex', ok: true, detail: `Launch mutex port ${where} is free.` };
  if (r.foreign) {
    return { name: 'launch-mutex', ok: true, detail: `Launch mutex port ${where} is held by another program, so PixInsight is started without the mutex (two sessions starting it at the same moment could start it twice); set PIXINSIGHT_CONNECTOR_LAUNCH_PORT to a free port.` };
  }
  if (r.waited) {
    return { name: 'launch-mutex', ok: true, detail: `Launch mutex port ${where} is in use by a connector starting PixInsight right now.` };
  }
  return { name: 'launch-mutex', ok: true, detail: `Launch mutex port ${where} cannot be bound here; PixInsight is started without it (two sessions starting it at the same moment could start it twice).` };
}

// `packs` is src/packs.mjs's loadPacks() PackInfo[]: { name, version, apiVersion, source,
// toolCount, status: 'loaded'|'skipped', reason? }. A pack that failed to import has no `name`, so
// it is shown by its `source`. Zero packs configured is a normal, ok state -- packs are optional.
// A skipped pack DOES fail this check: the user configured it (PIXINSIGHT_CONNECTOR_PACKS), so it not
// loading means tools they expect are missing
// from every session, which is exactly what doctor exists to surface.
function packsCheck(packs, homeDir) {
  const list = Array.isArray(packs) ? packs : [];
  if (list.length === 0) {
    return { name: 'packs', ok: true, detail: 'No packs configured.' };
  }
  const label = (p) => p.name ?? redactHome(p.source, homeDir) ?? 'unnamed pack';
  const isLoaded = (p) => p.status === 'loaded';
  const lines = list.map((p) => {
    const status = isLoaded(p) ? 'loaded' : `skipped (${p.reason || 'unknown reason'})`;
    return `${label(p)}@${p.version ?? '?'} apiVersion=${p.apiVersion ?? '?'} tools=${p.toolCount ?? 0} — ${status}`;
  });
  const skipped = list.filter((p) => !isLoaded(p));
  const ok = skipped.length === 0;
  const check = { name: 'packs', ok, detail: lines.join('; ') };
  if (!ok) {
    check.hint =
      `Fix or remove the skipped pack(s): ${skipped.map((p) => `${label(p)} (${p.reason || 'unknown reason'})`).join(', ')}. ` +
      'Packs come only from PIXINSIGHT_CONNECTOR_PACKS (pack folders and .mjs files).';
  }
  return check;
}

function pathExistsCheck(name, label, filePath, platform, homeDir, missingHint) {
  if (!platform || !filePath) {
    return {
      name,
      ok: false,
      detail: `No ${label} path to check (platform not resolved).`,
      hint: FIX_PLATFORM_FIRST_HINT,
    };
  }
  const shown = redactHome(filePath, homeDir);
  if (fs.existsSync(filePath)) {
    return { name, ok: true, detail: `${label} found at ${shown}.` };
  }
  return {
    name,
    ok: false,
    detail: `${label} not found at ${shown}.`,
    hint: missingHint ?? `Verify your PixInsight install includes the ${label.toLowerCase()}, or set PIXINSIGHT_DIR to your PixInsight install root.`,
  };
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {{piBin:string, imageSolverPath?:string, filterDbPath?:string, settingsPath?:string,
 *   verified?:boolean}|null} [opts.platform] - resolvePlatform's output (Task
 *   2), or `null` if resolution failed -- the caller (src/cli.mjs) is responsible for catching
 *   PlatformError and passing `null` rather than letting doctor throw.
 * @param {string} [opts.platformError] - that PlatformError's message, shown as the 'platform' check's detail.
 * @param {{isRunning: () => Promise<boolean|null>}} [opts.probe] - createProcessProbe's output
 *   (Task 3). Defaults to an "always unknown" stub so a missing/malformed probe never throws and
 *   is honestly reported as unknown rather than guessed at.
 * @param {Array<{name?:string, version?:string, apiVersion?:number, source:string, toolCount:number,
 *   status:'loaded'|'skipped', reason?:string}>} [opts.packs] - src/packs.mjs loadPacks()'s `packs`
 *   (src/cli.mjs loads them); defaults to none.
 * @param {string} [opts.homeDir] - defaults to os.homedir().
 * @param {string} [opts.osName] - the OS the platform check names; defaults to process.platform.
 * @param {Record<string,string|undefined>} [opts.env] - defaults to process.env.
 * @param {{readFile:Function, writeFile:Function, mkdir:Function, rename:Function, stat?:Function}} [opts.watcherFs]
 *   - the filesystem the 'watcher' check renders the watcher through; defaults to memory (nothing is written).
 * @param {string} [opts.cwd] - the folder the 'workspace' check resolves from; defaults to process.cwd().
 * @param {object} [opts.workspace] - a src/workspace.mjs workspace; defaults to one over cwd/env/homeDir/osName.
 * @param {() => string} [opts.machineId] - this machine's id; defaults to the one from its hostname.
 * @param {typeof import('node:net')} [opts.net] - for the 'launch-mutex' check; defaults to node:net.
 * @param {(p: string) => boolean} [opts.existsSync] - for the 'pixinsight-mcp' check; defaults to fs.existsSync.
 * @returns {Promise<{ok: boolean, checks: Array<{name:string, ok:boolean, detail:string, hint?:string}>}>}
 */
export async function runDoctor(opts = {}) {
  const platform = opts.platform ?? null;
  const packs = Array.isArray(opts.packs) ? opts.packs : [];
  const homeDir = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const osName = opts.osName ?? process.platform;
  const probe =
    opts.probe && typeof opts.probe.isRunning === 'function' ? opts.probe : { isRunning: async () => null };
  const workspace = opts.workspace ?? createWorkspace({ cwd: opts.cwd ?? process.cwd(), env, homeDir, platform: osName });
  const id = (opts.machineId ?? realMachineId)();

  const checks = [
    nodeCheck(),
    legacyCommandCheck(env, osName, homeDir, opts.existsSync ?? fs.existsSync),
    platformCheck(platform, env, homeDir, opts.platformError, osName),
    pixinsightBinaryCheck(platform, homeDir),
    await pixinsightRunningCheck(probe, env),
    await watcherCheck(platform, workspace, id, homeDir, osName, opts.watcherFs),
    workspaceCheck(workspace, homeDir, id),
    callLogsCheck(workspace, env, homeDir, fs),
    await launchMutexCheck(env, opts.net),
    packsCheck(packs, homeDir),
    pathExistsCheck('imagesolver', 'ImageSolver script', platform?.imageSolverPath, platform, homeDir,
      'The watcher includes it and will not compile without it. Set PIXINSIGHT_DIR to your PixInsight install root (the folder holding src/ and library/).'),
    pathExistsCheck('filter-db', 'Filter database', platform?.filterDbPath, platform, homeDir),
    pathExistsCheck('settings', 'Core settings file', platform?.settingsPath, platform, homeDir),
  ];

  // Safety net: whatever produced a failing check above must also have set a
  // hint, but this guarantees the invariant regardless of how that check's
  // own logic evolves later.
  for (const c of checks) {
    if (!c.ok && !c.hint) c.hint = `The '${c.name}' check failed; re-run doctor after addressing the detail above.`;
  }

  return { ok: checks.every((c) => c.ok), checks };
}
