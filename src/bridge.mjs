// ============================================================================
// Bridge communication with PixInsight via file-based IPC.
//
// This is a cross-platform port of v0-pipeline:agents/ops/bridge.mjs: liveness and
// memory readings now come from an injected `probe` (src/process-probe.mjs)
// instead of BSD-only `ps`/shell-pipeline one-liners, and `piBin` comes from
// injected platform config (src/platform.mjs's resolvePlatform()) instead of
// a macOS-only module constant.
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { ensurePixInsight, spawnFailureMessage, createLaunchMutex } from './runtime.mjs';
import { toPixPath } from './platform.mjs';
import { scriptPathProblem } from './workspace.mjs';
import { isPidAlive as defaultIsPidAlive, onProcessExit } from './process-probe.mjs';

const DEFAULT_LINGER_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 500;
// The existing safety property: two consecutive failed liveness checks
// roughly ten seconds apart before declaring a crash, because a liveness
// check can be starved while PixInsight pegs every core. Tracked by wall
// clock (not a poll-count multiple) so it's decoupled from pollIntervalMs.
const DEFAULT_DEAD_CHECK_INTERVAL_MS = 10000;
const DEFAULT_PICKUP_TIMEOUT_MS = 4000;
const DEFAULT_SEND_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_AUTOSTART_TIMEOUT_MS = 90_000; // mirrors ensurePixInsight's own default (src/runtime.mjs)
const STALE_RESULT_MS = 5 * 60_000;
// A command file in <bridge>/commands/ that no live watcher has consumed is only legitimate while its
// sender is still waiting for it. With no watcher running, the longest a live sender's command can
// sit there is the pickup timeout, a wait on the launch mutex while another connector starts
// PixInsight (at most that connector's own 90 s start), a PixInsight autostart and up to three 30 s
// watcher launches (4 s + 90 s + 90 s + 3 x 30 s, about 4.6 min; another program holding the mutex
// port is not waited on), so any command older than this (by its embedded timestamp, else its
// mtime) is an orphan. Commands whose
// recorded sender process is gone are orphans at any age. The watcher applies its own, independent
// age check (pjsr/watcher.template.js mcpStaleCommandReason) as a second line of defence.
const DEFAULT_STALE_COMMAND_MS = 5 * 60_000;
// A command that has none of its files (<id>.json, the claimed <id>.running, the result) for this
// long was removed by someone else -- a watcher quarantined it as unreadable, another server swept
// it -- and will never be answered. Long enough to span a claim rename that is not atomic.
const DEFAULT_VANISH_GRACE_MS = 3000;
const WATCHER_START_TIMEOUT_MS = 30_000;
const WATCHER_START_POLL_MS = 100;
// How many times one ensureWatcher() relaunches a watcher that started and exited (idle) before its
// heartbeat was ever seen. Bounded so a watcher that keeps exiting becomes an error, not a loop.
const MAX_WATCHER_RELAUNCHES = 2;
// A watcher writes `starting <ms>` the moment it starts, before showing the console and running its
// first UI event pump, which can take seconds and cannot refresh the heartbeat. Such a beat counts as
// alive for this long, so a stalled start is not mistaken for a dead watcher and launched again. An
// older one is a watcher that died while starting.
const STARTING_GRACE_MS = 60_000;
// The watcher rewrites `heartbeat` in place; on filesystems where its atomic replace is unavailable a
// read can land between truncate and write and see an empty file. An unparseable beat is therefore
// "unknown, read again shortly", and only counts as no watcher if it stays unparseable.
const TORN_BEAT_REREADS = 3;
const TORN_BEAT_REREAD_MS = 25;
const HEARTBEAT_STATES = new Set(['starting', 'idle', 'busy']);
// Cross-process launch lock (<bridge dir>/launch.lock, created with O_EXCL): at most one
// `PixInsight -x` of this target's watcher at a time across every server working in this target on
// this machine (servers in other targets are kept from starting PixInsight twice by the launch mutex,
// src/runtime.mjs createLaunchMutex). PixInsight queues a second -x until
// the running script returns, so two concurrent launches mean a second watcher starts later, after
// the first has exited. The lock is held from the decision to launch until the watcher is seen alive
// or the launch gives up, which takes at most a wait on the launch mutex while another connector
// starts PixInsight (its own 90 s start), a 90 s PixInsight autostart and three 30 s watcher
// launches (about 4.5 min); a lock older than this, or whose holder process is gone, is stale and
// taken over.
const LAUNCH_LOCK_STALE_MS = 5 * 60_000;
const LAUNCH_LOCK_POLL_MS = 100;
// A send whose watcher keeps disappearing before it picks the command up (e.g. dying during start-up)
// relaunches it at most this many times, then fails with the start-up diagnostics.
const MAX_PICKUP_RELAUNCHES = 2;

// Surfaced for every way autostart can fail to leave PixInsight reachable -- never started at
// all, or started but never became alive within autostartTimeoutMs -- and for the pre-existing
// "confirmed not running" case right after it, so callers see one consistent error type across
// this whole failure class rather than a different one depending on which branch was hit.
const AUTOSTART_FAILED_MESSAGE =
  'PixInsight could not be started. Check `npx -y github:mxcoppell/pixinsight-connector doctor`, or set `PIXINSIGHT_BIN` if it is installed somewhere unusual.';

// The other BridgeCrashError site: a crash detected mid-command (two consecutive failed liveness
// checks while a `send()` was already in flight), not the pre-flight check above. Unlike the old
// text this replaces, it must not point at `--resume --run-id <runId>` -- that flag belongs to
// the legacy batch-pipeline tooling (v0-pipeline:agents/llm/giga-run.mjs, v0-pipeline:scripts/run-pipeline.mjs), not this
// connector's CLI (src/cli.mjs only has serve/doctor/install). The accurate guidance here is
// simply to retry: ensureWatcher() runs again on the next send()/pjsr() call and, with autostart
// now wired in, will relaunch PixInsight itself.
const MID_COMMAND_CRASH_MESSAGE =
  'PixInsight appears to have crashed mid-command. It will be started again automatically on the next command — retry. If it keeps crashing, check `npx -y github:mxcoppell/pixinsight-connector doctor`.';

// A watcher that never beat while PixInsight runs: the connector cannot tell which of these it is, so
// it names both and claims neither.
const WATCHER_NEVER_STARTED =
  "PixInsight is running but this target's watcher never started. Possible causes: PixInsight is still running " +
  "another script (it runs one script at a time; another target's watcher exits a few seconds after its last " +
  'command), so retry once it is free; or PixInsight could not open the watcher script at the path below, ' +
  'in which case its Process Console says why.';

/**
 * Error thrown when PixInsight process is not found (crashed).
 * Callers should catch this specifically and handle crash recovery.
 */
export class BridgeCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeCrashError';
    this.isCrash = true;
  }
}

/**
 * The user stopped the watcher on purpose (Pause/Abort or the shutdown file).
 * Extends BridgeCrashError so every existing crash handler halts the run and
 * offers a resume, instead of the bridge quietly relaunching the watcher and
 * carrying on.
 */
export class BridgeAbortError extends BridgeCrashError {
  constructor(message) {
    super(message);
    this.name = 'BridgeAbortError';
    this.isAbort = true;
  }
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 *
 * On-demand watcher: PixInsight greys out view interaction (right-click, STF)
 * for as long as any script runs, and a script's timers die when it returns, so
 * a resident watcher cannot be non-modal. When autoLaunch is on (default) the
 * bridge starts the watcher with `PixInsight -x=` when none is running and the
 * watcher exits after `lingerMs` with no commands. Set PIXINSIGHT_CONNECTOR_AUTOLAUNCH=0
 * to keep the old behavior (a watcher you started by hand, resident).
 *
 * @param {object} opts
 * @param {{ piBin: string }} opts.platform - resolved platform config (resolvePlatform() from src/platform.mjs); only piBin is read here.
 * @param {{ isRunning: () => Promise<boolean|null>, startedAt: () => Promise<number|null>, memoryMB: () => Promise<number|null> }} opts.probe - createProcessProbe() from src/process-probe.mjs.
 * @param {string} [opts.watcherPath] - path to the PJSR watcher script passed as `-x=<path>`, for every bridge dir.
 * @param {(bridgeDir: string) => (string|Promise<string>)} [opts.watcherFor] - the watcher script serving `bridgeDir`
 *   (materialized into that target, src/runtime.mjs materializeWatcher); asked before every launch. One of the two is required.
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.now] - clock (ms since epoch); defaults to Date.now.
 * @param {(ms: number) => Promise<void>} [opts.sleep] - wait used while a launched watcher starts.
 * @param {(bin: string, args: string[]) => (import('node:events').EventEmitter|void)} [opts.spawnWatcher] - launches `PixInsight -x=<watcher>`;
 *   defaults to a detached child_process spawn. When it returns the child, an 'error' it emits (the executable could
 *   not be run) fails the launch with the path and the fix instead of going unhandled.
 * @param {number} [opts.pid] - this process's pid, recorded in each command as `senderPid`.
 * @param {(pid: number) => boolean|null} [opts.isPidAlive] - whether a command's sender is still running (null = unknown).
 * @param {object} [opts.fs] - the node:fs API (sync methods) the bridge uses; injectable for tests.
 * @param {(path: string) => void} [opts.unlink] - deletes a consumed result file; defaults to fs.unlinkSync.
 * @param {number} [opts.vanishGraceMs] - how long a command may have no command/claim/result file before the send fails (default 3 s).
 * @param {number} [opts.staleCommandMs] - age past which a foreign command file is quarantined before a launch (default 5 min).
 * @param {Record<string, string|undefined>} [opts.env] - environment (PIXINSIGHT_CONNECTOR_AUTOLAUNCH, _LINGER_MS, _AUTOSTART); defaults to process.env.
 * @param {string} opts.bridgeDir - this session's bridge dir (`<workspace>/agentic/bridge/<machine-id>`): commands/, results/,
 *   quarantine/, and this target's watcher state (heartbeat, last-stop, shutdown, launch.lock, launches/, watcher.json).
 *   setBridgeDir() re-points it when the workspace changes.
 * @param {(fn: () => void) => void} [opts.onExit] - runs fn when the process exits (drop queued commands);
 *   defaults to one process 'exit' listener.
 * @param {(p: string) => string} [opts.realpath] - the real path of an existing dir; defaults to fs.realpathSync.native.
 *   A bridge dir is used, and baked into its watcher, by its real path, so two spellings of one folder (a symlink, a
 *   case variant on a case-insensitive volume) are one dir. Falls back to path.resolve if it throws.
 * @param {object} [opts.launchMutex] - src/runtime.mjs createLaunchMutex(): held while PixInsight itself is started, so
 *   connectors in different targets never start it twice. Defaults to one over `opts.net` (node:net).
 * @param {typeof import('node:net')} [opts.net] - node:net for the default launch mutex; injectable for tests.
 * @param {(rec: object) => void} [opts.trace] - told about every command and bridge-level event, for the call
 *   log (src/call-log.mjs): `{ kind: 'sent', cmdId, tool, params, dir, sentAt }` once a command is on disk, then
 *   `{ kind: 'done', ..., ms, result }` with the result exactly as the watcher wrote it, or
 *   `{ kind: 'failed', ..., ms, failure: { kind, name, message } }` (kind: write, launch, abort, crash, vanished,
 *   watcher lost, timeout); and `{ kind: 'event', event, ... }` (launch, relaunch, pixinsight start, quarantine,
 *   watcher spawn failed, watcher start with the PixInsight version, and each failure but a write). Called synchronously; whatever it throws is ignored.
 */
export function createBridge(opts = {}) {
  const platform = opts.platform;
  const probe = opts.probe;
  const watcherFor = opts.watcherFor ?? (opts.watcherPath ? () => opts.watcherPath : null);
  if (!platform || !platform.piBin) {
    throw new Error('createBridge requires opts.platform with a piBin (see resolvePlatform in src/platform.mjs)');
  }
  if (!probe) {
    throw new Error('createBridge requires opts.probe (see createProcessProbe in src/process-probe.mjs)');
  }
  if (!watcherFor) {
    throw new Error('createBridge requires opts.watcherFor or opts.watcherPath');
  }

  const piBin = platform.piBin;
  // The filesystem, injectable so tests can intercept individual reads (e.g. a torn heartbeat).
  const bfs = opts.fs ?? fs;
  const logFn = opts.log || console.log;
  // The environment is injectable like every other OS-dependent input.
  const env = opts.env ?? process.env;
  if (!opts.bridgeDir) {
    throw new Error('createBridge requires opts.bridgeDir (the workspace bridge dir, see workspacePaths in src/workspace.mjs)');
  }
  // The session's own dir: commands/, results/, quarantine/ and the state of the one watcher that
  // serves it. Re-pointed by setBridgeDir(); each send keeps the dir it was written to until it settles.
  let bridgeDir = opts.bridgeDir;
  const cmdDirOf = (d) => path.join(d, 'commands');
  const resDirOf = (d) => path.join(d, 'results');
  const quarantineDirOf = (d) => path.join(d, 'quarantine');
  // Each bridge dir has its own watcher (a script materialized into that target, serving only that
  // dir) and so its own heartbeat, last-stop, launch lock and linger tickets. One "site" per real dir,
  // so a send in flight keeps talking to its own dir's watcher after a workspace switch.
  //  - linger tickets: one per launch (launches/<ms>-<uuid>.json, `{ lingerMs, at, pid }`). Each watcher
  //    consumes one at start-up, so a second, queued watcher still finds its own; a watcher that finds
  //    none was started by hand and stays resident.
  const sites = new Map();
  function siteOf(dir) {
    let site = sites.get(dir);
    if (!site) {
      site = {
        dir,
        heartbeatFile: path.join(dir, 'heartbeat'),
        lastStopFile: path.join(dir, 'last-stop'),
        launchesDir: path.join(dir, 'launches'),
        lockFile: path.join(dir, 'launch.lock'),
        watcherInfoFile: path.join(dir, 'watcher.json'),
        launching: null,
        lastLaunchAt: 0,
        watcherPath: null,
        notedWatcherStart: undefined,
      };
      sites.set(dir, site);
    }
    return site;
  }
  const autoLaunch = opts.autoLaunch ?? (env.PIXINSIGHT_CONNECTOR_AUTOLAUNCH !== '0');
  const lingerMs = opts.lingerMs ?? (Number(env.PIXINSIGHT_CONNECTOR_LINGER_MS) || DEFAULT_LINGER_MS);
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadCheckIntervalMs = opts.deadCheckIntervalMs ?? DEFAULT_DEAD_CHECK_INTERVAL_MS;
  const pickupTimeoutMs = opts.pickupTimeoutMs ?? DEFAULT_PICKUP_TIMEOUT_MS;
  const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const vanishGraceMs = opts.vanishGraceMs ?? DEFAULT_VANISH_GRACE_MS;
  // Injectable so tests can stub out the real "start PixInsight itself" step (ensurePixInsight,
  // src/runtime.mjs) the same way every other bridge dependency is injectable; opts.spawn defaults
  // to the real child_process spawn (the same one used for the watcher launch below, but a
  // distinct call site: this one launches PixInsight itself, not the watcher script), opts.env to
  // the real process.env, and opts.autostartTimeoutMs mirrors ensurePixInsight's own 90s default.
  const autostartSpawn = opts.spawn ?? spawn;
  const autostartEnv = env;
  const autostartTimeoutMs = opts.autostartTimeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS;
  // Clock, sleep, watcher launch, this process's pid and "is that sender pid alive" are injectable so
  // every lifecycle and staleness decision below is testable without PixInsight or real waiting.
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // windowsHide only applies on Windows (harmless elsewhere), so it's passed unconditionally rather
  // than branching on OS. detached + stdio:'ignore' + unref() lets Node exit without waiting on the
  // watcher on POSIX; per Node's docs the same holds on Windows as long as stdio isn't inherited.
  // The child is returned so the launch can listen for its 'error' (an executable that cannot be run).
  const spawnWatcher = opts.spawnWatcher ??
    ((bin, args) => {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return child;
    });
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const staleCommandMs = opts.staleCommandMs ?? DEFAULT_STALE_COMMAND_MS;
  const unlinkResult = opts.unlink ?? bfs.unlinkSync; // injectable: a result file may be undeletable (EBUSY on Windows)
  const createdAt = now();
  // IDs of commands this bridge wrote and is still waiting on: never swept as stale.
  const ownPending = new Map(); // id -> { cmdFile }
  const onExit = opts.onExit ?? onProcessExit;
  // Created here, bound only while PixInsight itself is being started: no I/O until then.
  const launchMutex = opts.launchMutex ?? createLaunchMutex({ net: opts.net, env, log: (m) => logFn(`  [bridge] ${m}`) });
  const realpath = opts.realpath ?? ((p) => (bfs.realpathSync.native ?? bfs.realpathSync)(p));
  const traceHook = opts.trace;
  function trace(rec) {
    if (!traceHook) return;
    try { traceHook(rec); } catch {}
  }
  // A send that gave up: the command's failure, and (unless it never reached the disk) an event.
  function traceFailure(base, e, kind) {
    const failure = { kind, name: e?.name ?? 'Error', message: e?.message ?? String(e) };
    trace({ kind: 'failed', ...base, ms: base.sentAt === null ? null : now() - base.sentAt, failure });
    if (kind !== 'write') trace({ kind: 'event', event: kind, cmdId: base.cmdId, tool: base.tool, message: failure.message });
  }
  const failureKind = (e) => (e?.name === 'BridgeAbortError' ? 'abort' : e?.name === 'BridgeCrashError' ? 'crash' : 'launch');
  // A bridge dir as it is used and registered: created, then named by its real path, once per spelling.
  const realDirs = new Map();
  function realDir(dir) {
    let real = realDirs.get(dir);
    if (real !== undefined) return real;
    bfs.mkdirSync(dir, { recursive: true });
    try { real = realpath(dir); } catch { real = path.resolve(dir); }
    realDirs.set(dir, real);
    return real;
  }

  // null: no heartbeat file. { unknown: true }: present but unparseable (possibly a torn read).
  function readBeat(site) {
    let raw;
    try { raw = bfs.readFileSync(site.heartbeatFile, 'utf-8'); } catch { return null; }
    const parts = String(raw).trim().split(' ');
    const beat = { state: parts[0], ts: Number(parts[parts.length - 1]) };
    if (!HEARTBEAT_STATES.has(beat.state) || !Number.isFinite(beat.ts) || beat.ts <= 0) return { unknown: true };
    return beat;
  }

  function readLastStop(site) {
    try {
      const [reason, ts] = bfs.readFileSync(site.lastStopFile, 'utf-8').split(' | ');
      return { reason: reason.trim(), ts: Number(ts) };
    } catch { return null; }
  }

  // Whether this dir's watcher is alive. "busy" counts as alive however old it is: a running command
  // blocks the watcher loop, so it cannot refresh the heartbeat.
  async function watcherAlive(site) {
    let beat = readBeat(site);
    for (let i = 0; beat?.unknown && i < TORN_BEAT_REREADS; i++) {
      await sleep(TORN_BEAT_REREAD_MS);
      beat = readBeat(site);
    }
    if (!beat || beat.unknown) return false;
    if (beat.state === 'starting') {
      if (now() - beat.ts >= STARTING_GRACE_MS) return false;
      // A start-up beat left behind by a PixInsight that quit or crashed while the watcher was
      // starting must not block autostart (same reasoning as the stale "busy" check below).
      if ((await probe.isRunning()) === false) return false;
      const start = await probe.startedAt();
      if (start && beat.ts < start) return false;
      return true;
    }
    if (beat.state !== 'busy') return now() - beat.ts < 5000;
    if (now() - beat.ts > 30_000) {
      // A "busy" left behind by a PixInsight that crashed must not count as
      // alive. probe.startedAt() returning null (unknown) is falsy, same as
      // the rest of this function treats an unresolvable start time: skip
      // the stale-heartbeat cleanup rather than guess.
      const start = await probe.startedAt();
      if (start && beat.ts < start) {
        bfs.rmSync(site.heartbeatFile, { force: true });
        return false;
      }
    }
    return true;
  }

  // The watcher's start-up record (watcher.json, written before its first heartbeat): which watcher
  // and which PixInsight answered. Reported once per watcher start, as a 'watcher start' event, when
  // a result shows that watcher at work. A missing, torn or corrupt record is skipped.
  function noteWatcherStart(site) {
    let info;
    try { info = JSON.parse(bfs.readFileSync(site.watcherInfoFile, 'utf-8')); } catch { return; }
    if (!info || typeof info !== 'object' || info.startedAt === site.notedWatcherStart) return;
    site.notedWatcherStart = info.startedAt;
    const startedAt = Number.isFinite(info.startedAt) ? new Date(info.startedAt).toISOString() : null;
    trace({ kind: 'event', event: 'watcher start', pixinsightVersion: info.pixinsightVersion ?? null, watcherVersion: info.watcherVersion ?? null, startedAt, dir: site.dir });
  }

  function readHeartbeatRaw(site) {
    try { return bfs.readFileSync(site.heartbeatFile, 'utf-8').trim(); } catch { return null; }
  }
  // Moves every orphaned command file out of <dir>/commands/ into <dir>/quarantine/ (kept for
  // inspection, never run). A file is orphaned when it is not one of this bridge's own pending
  // commands and either names a sender pid that is no longer running, or is older than
  // staleCommandMs (embedded `timestamp`, else file mtime) and has no sender known to be alive.
  // Unreadable or unparseable files are judged by mtime alone (a young one may still be mid-write).
  // The full sweep runs only while no watcher is alive (before a launch), when nothing can be
  // legitimately queued behind a running command. `senderGoneOnly` (on the first use of a dir, with
  // a watcher possibly alive) moves only commands whose sender is confirmed gone, and leaves claimed
  // files alone.
  function quarantineStaleCommands(dir, { senderGoneOnly = false } = {}) {
    const cmdDir = cmdDirOf(dir);
    const quarantineDir = quarantineDirOf(dir);
    let files;
    try { files = bfs.readdirSync(cmdDir); } catch { return; }
    const moved = [];
    for (const f of files) {
      // A claimed command (<id>.running) with no watcher alive was being run by a watcher that died:
      // never re-run it.
      if (f.endsWith('.running')) {
        if (senderGoneOnly) continue;
        try {
          bfs.mkdirSync(quarantineDir, { recursive: true });
          bfs.renameSync(path.join(cmdDir, f), path.join(quarantineDir, f));
        } catch {
          try { bfs.rmSync(path.join(cmdDir, f), { force: true }); } catch {}
        }
        moved.push(`${f} (claimed by a watcher that is gone)`);
        continue;
      }
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      if (ownPending.has(id)) continue;
      const fp = path.join(cmdDir, f);
      let mtimeMs;
      try { mtimeMs = bfs.statSync(fp).mtimeMs; } catch { continue; }
      let cmd = null;
      try { cmd = JSON.parse(bfs.readFileSync(fp, 'utf-8')); } catch {}
      const stamped = Date.parse(cmd?.timestamp);
      const writtenAt = Number.isFinite(stamped) ? stamped : mtimeMs;
      const age = now() - writtenAt;
      const foreignSender = Number.isInteger(cmd?.senderPid) && cmd.senderPid !== pid;
      const senderAlive = foreignSender ? isPidAlive(cmd.senderPid) : null;
      const senderGone = senderAlive === false;
      // A sender that is still running may still be waiting for this command (behind a launch lock
      // and a slow launch, say); if it gives up it removes the command itself. So age alone only
      // condemns a command whose sender is unknown.
      if (senderGoneOnly ? !senderGone : !senderGone && (senderAlive === true || age <= staleCommandMs)) continue;
      try {
        bfs.mkdirSync(quarantineDir, { recursive: true });
        bfs.renameSync(fp, path.join(quarantineDir, f));
      } catch {
        try { bfs.rmSync(fp, { force: true }); } catch {}
      }
      moved.push(`${f} (${cmd?.tool ?? 'unreadable'}, ${senderGone ? 'sender exited' : `${Math.round(age / 1000)}s old`})`);
    }
    if (moved.length) {
      trace({ kind: 'event', event: 'quarantine', dir, files: moved, beforeLaunch: !senderGoneOnly });
      logFn(`  [bridge] quarantined ${moved.length} stale command file(s) to ${quarantineDir}${senderGoneOnly ? '' : ' before launching the watcher'}: ${moved.join(', ')}`);
    }
  }

  function readLock(site) {
    let raw;
    try { raw = bfs.readFileSync(site.lockFile, 'utf-8'); } catch { return undefined; } // gone
    try { return JSON.parse(raw); } catch { return null; } // present but being written or corrupt
  }

  // Takes this dir's launch lock. Returns its token, or null when a watcher came up while waiting
  // (someone else launched it, so this server must not). Waits while another live server holds a
  // fresh lock; takes a stale one over (holder process gone, or older than any launch).
  async function acquireLaunchLock(site) {
    const token = crypto.randomUUID();
    for (;;) {
      try {
        bfs.mkdirSync(site.dir, { recursive: true });
        bfs.writeFileSync(site.lockFile, JSON.stringify({ pid, token, at: now() }), { flag: 'wx' });
        return token;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
      }
      const holder = readLock(site);
      if (holder !== undefined) {
        let at = Number(holder?.at);
        if (!Number.isFinite(at)) {
          try { at = bfs.statSync(site.lockFile).mtimeMs; } catch { at = now(); }
        }
        const holderGone = Number.isInteger(holder?.pid) && holder.pid !== pid && isPidAlive(holder.pid) === false;
        if (holderGone || now() - at > LAUNCH_LOCK_STALE_MS) {
          // Re-read before removing, so a lock another waiter has just re-taken is left alone.
          const again = readLock(site);
          if (again === undefined || again?.token === holder?.token) {
            logFn(`  [bridge] taking over a stale launch lock (${holderGone ? `holder pid ${holder.pid} exited` : `${Math.round((now() - at) / 1000)}s old`})`);
            try { bfs.rmSync(site.lockFile, { force: true }); } catch {}
          }
          continue;
        }
      }
      if (await watcherAlive(site)) return null;
      await sleep(LAUNCH_LOCK_POLL_MS);
    }
  }

  function releaseLaunchLock(site, token) {
    if (readLock(site)?.token === token) {
      try { bfs.rmSync(site.lockFile, { force: true }); } catch {}
    }
  }

  function assertLaunchable(watcherPath) {
    const problem = scriptPathProblem(toPixPath(watcherPath));
    if (problem) {
      trace({ kind: 'event', event: 'launch refused', watcherPath, message: problem });
      throw new Error(`Cannot launch the watcher script "${watcherPath}": ${problem}.`);
    }
  }

  // Launches this dir's watcher and waits for its heartbeat. The caller's command is already on disk
  // (send() writes it first), so the watcher's first look -- and the "last look" it takes before
  // an idle exit -- finds it. If last-stop shows a watcher started and exited after this launch
  // without its heartbeat ever being seen (e2e: a first -x launch whose first heartbeat and idle
  // exit landed in the same loop iteration), relaunch it, a bounded number of times. A deliberate
  // stop (Pause/Abort, shutdown file) during the start is honoured as such.
  async function launchAndAwaitWatcher(site) {
    const watcherPath = site.watcherPath;
    let launches = 0;
    let launchedAt = 0;
    let lastBeatSeen = null;
    let exitedAfterLaunch = null;
    // Set when spawn reports that PixInsight could not be run at all ('error', e.g. ENOENT for a
    // missing PIXINSIGHT_BIN): no watcher will ever beat, so the wait below stops at once.
    let spawnError = null;
    const tickets = []; // this call's tickets, removed on give-up when no watcher can take them
    const launch = (reason = null) => {
      assertLaunchable(watcherPath); // never hand PixInsight a path it would split or cut short
      launches++;
      launchedAt = now();
      site.lastLaunchAt = launchedAt;
      trace({ kind: 'event', event: launches === 1 ? 'launch' : 'relaunch', launch: launches, ...(reason ? { reason } : {}), watcherPath, lingerMs });
      bfs.mkdirSync(site.launchesDir, { recursive: true });
      // Written to a temp name and renamed, so a watcher (which lists only *.json) never reads half of one.
      const ticket = path.join(site.launchesDir, `${launchedAt}-${crypto.randomUUID()}`);
      bfs.writeFileSync(ticket + '.tmp', JSON.stringify({ lingerMs, at: launchedAt, pid }));
      bfs.renameSync(ticket + '.tmp', ticket + '.json');
      tickets.push(ticket + '.json');
      const child = spawnWatcher(piBin, ['-x=' + toPixPath(watcherPath)]);
      child?.on?.('error', (e) => {
        logFn(`  [bridge] watcher launch failed: ${spawnFailureMessage(piBin, e)}`);
        spawnError ??= e;
      });
    };
    try {
      launch();
      await awaitWatcherStart();
    } catch (e) {
      await dropTicketsOnGiveUp(tickets, spawnError);
      throw e;
    }

    async function awaitWatcherStart() {
      for (;;) {
        if (await watcherAlive(site)) return;
        if (spawnError) {
          trace({ kind: 'event', event: 'watcher spawn failed', piBin, code: spawnError.code ?? null, message: spawnError.message });
          throw new Error(`The watcher could not be launched. ${spawnFailureMessage(piBin, spawnError)}`);
        }
        const raw = readHeartbeatRaw(site);
        if (raw) lastBeatSeen = { raw, at: now() };
        const stop = readLastStop(site);
        if (stop && stop.ts >= launchedAt) {
          if (stop.reason === 'abort requested' || stop.reason === 'shutdown file') {
            throw new BridgeAbortError(`Watcher was stopped on purpose (${stop.reason}) while it was starting; not relaunching it. Call the resume_bridge tool once the user says to continue.`);
          }
          exitedAfterLaunch = stop;
          if (launches > MAX_WATCHER_RELAUNCHES) {
            throw new Error(`The watcher started and exited ("${stop.reason}") ${launches} time(s) without being seen alive. ${await watcherDiagnostics(site, launches, launchedAt, lastBeatSeen, stop)}`);
          }
          logFn(`  [bridge] watcher exited ("${stop.reason}") before its heartbeat was seen; relaunching (launch ${launches + 1})`);
          launch(stop.reason);
          continue;
        }
        if (now() - launchedAt > WATCHER_START_TIMEOUT_MS) {
          throw new Error(`Watcher did not start within 30s of the -x launch. ${await watcherDiagnostics(site, launches, launchedAt, lastBeatSeen, exitedAfterLaunch ?? readLastStop(site))}`);
        }
        await sleep(WATCHER_START_POLL_MS);
      }
    }
  }

  // A launch that gave up removes the tickets it wrote when no watcher can ever take them: the spawn
  // itself failed, or PixInsight is confirmed not running (a queued -x dies with its process). While
  // PixInsight runs, the -x may still be queued behind another script, and a watcher that starts to
  // find no ticket stays resident (UI locked), so the tickets stay: the next launch after PixInsight
  // restarts removes them (pruneLaunchTickets), and the watcher ignores them after 24 h.
  async function dropTicketsOnGiveUp(tickets, spawnError) {
    const left = tickets.filter((f) => bfs.existsSync(f));
    if (!left.length) return;
    let running = null;
    if (!spawnError) {
      try { running = await probe.isRunning(); } catch { running = null; }
    }
    if (!spawnError && running !== false) {
      trace({ kind: 'event', event: 'launch tickets kept', count: left.length, reason: 'PixInsight is running; the launch may still be queued' });
      return;
    }
    for (const f of left) { try { bfs.rmSync(f, { force: true }); } catch {} }
    trace({ kind: 'event', event: 'launch tickets removed', count: left.length, reason: spawnError ? 'spawn failed' : 'PixInsight not running' });
  }

  // What the start-up wait actually observed, so a timeout can be diagnosed from the error alone. A
  // watcher that never beat while PixInsight is running is either queued behind another script or was
  // never opened: both possibilities come first.
  async function watcherDiagnostics(site, launches, launchedAt, lastBeatSeen, stop) {
    const beat = lastBeatSeen ? `last seen "${lastBeatSeen.raw}" ${Math.round((now() - lastBeatSeen.at) / 1000)}s ago` : 'never seen';
    let stopText = 'none';
    if (stop) {
      const rel = stop.ts >= launchedAt ? `${Math.round((stop.ts - launchedAt) / 1000)}s after the launch` : `${Math.round((launchedAt - stop.ts) / 1000)}s before the launch`;
      stopText = `"${stop.reason}", ${rel}`;
    }
    let running;
    try {
      const r = await probe.isRunning();
      running = r === true ? 'yes' : r === false ? 'no' : 'unknown';
    } catch { running = 'unknown'; }
    // Only a beat written since this launch shows the watcher ran: a file left by a PixInsight that
    // has since quit (`idle <old ts>`) says nothing about this launch.
    const beatTs = lastBeatSeen ? Number(String(lastBeatSeen.raw).split(' ').at(-1)) : NaN;
    const beatSinceLaunch = Number.isFinite(beatTs) && beatTs >= launchedAt;
    const neverStarted = !beatSinceLaunch && running === 'yes' && !(stop && stop.ts >= launchedAt);
    return `${neverStarted ? `${WATCHER_NEVER_STARTED} ` : ''}Checked: launches: ${launches}; heartbeat: ${beat}; last-stop: ${stopText}; PixInsight running: ${running}; watcher: ${site.watcherPath}.`;
  }

  function throwIfStoppedOnPurpose(site) {
    const stop = readLastStop(site);
    if (stop && stop.ts >= createdAt && (stop.reason === 'abort requested' || stop.reason === 'shutdown file')) {
      throw new BridgeAbortError(`Watcher was stopped on purpose (${stop.reason}); not relaunching it. Call the resume_bridge tool once the user says to continue.`);
    }
  }

  // Removes this dir's linger tickets that can never be used by a watcher of the running PixInsight:
  // all of them when this bridge has just started a fresh PixInsight process (nothing can be queued in
  // a new process), otherwise those written before the running process started. Tickets are named
  // <ms>-<uuid>.json (or .tmp while being written), so their write time comes from the name.
  async function pruneLaunchTickets(site, freshProcess) {
    let files;
    try { files = bfs.readdirSync(site.launchesDir); } catch { return; }
    let startedAt = null;
    if (!freshProcess) {
      try { startedAt = await probe.startedAt(); } catch { startedAt = null; }
      if (!startedAt) return;
    }
    let removed = 0;
    for (const f of files) {
      const writtenAt = Number(f.split('-')[0]);
      if (freshProcess || (Number.isFinite(writtenAt) && writtenAt < startedAt)) {
        try { bfs.rmSync(path.join(site.launchesDir, f), { force: true }); removed++; } catch {}
      }
    }
    if (removed) {
      logFn(`  [bridge] removed ${removed} linger ticket(s) left from ${freshProcess ? 'before this PixInsight was started' : 'an earlier PixInsight process'}`);
    }
  }

  function ensureWatcher(site) {
    if (!autoLaunch) return Promise.resolve();
    if (site.launching) return site.launching;
    site.launching = (async () => {
      try {
        if (await watcherAlive(site)) return;
        throwIfStoppedOnPurpose(site);
        const token = await acquireLaunchLock(site);
        if (!token) return; // another server's launch came up while this one waited
        try {
          if (await watcherAlive(site)) return; // came up between the first check and the lock
          // The user may have aborted the watcher another server was starting while this one waited
          // for the lock: an abort is never silently undone.
          throwIfStoppedOnPurpose(site);
          await launchUnderLock(site);
        } finally {
          releaseLaunchLock(site, token);
        }
      } finally {
        site.launching = null;
      }
    })();
    return site.launching;
  }

  async function launchUnderLock(site) {
    // The script this launch runs, written into the target (re-written only if it changed): before
    // PixInsight is started, so a target that cannot be written fails without starting anything.
    site.watcherPath = await watcherFor(site.dir);
    // A path PixInsight cannot run (`-x=` splits at the first comma) fails here, before PixInsight is
    // started or a ticket written; the workspace check refuses such a target earlier still.
    assertLaunchable(site.watcherPath);
    // Start PixInsight itself on demand -- see src/runtime.mjs's ensurePixInsight for the
    // null ("OS couldn't answer" -> never spawn a second instance)/false/true semantics, and for the
    // launch mutex that keeps connectors in other targets from starting it a second time. Any
    // failure here (a spawn error, or a timeout waiting for it to become alive) is folded
    // into the same BridgeCrashError below rather than left as whatever error type
    // ensurePixInsight itself threw, so callers see one consistent error type whether
    // PixInsight was never started or started but never came up in time. A decline that
    // *doesn't* throw (already running, unknown liveness, or PIXINSIGHT_CONNECTOR_AUTOSTART=0)
    // falls through to the liveness check right below instead, which turns a confirmed
    // `false` into that same BridgeCrashError case.
    let freshProcess = false;
    try {
      const r = await ensurePixInsight({ platform, probe, spawn: autostartSpawn, log: logFn, env: autostartEnv, timeoutMs: autostartTimeoutMs, mutex: launchMutex });
      freshProcess = r?.started === true;
      if (freshProcess) trace({ kind: 'event', event: 'pixinsight start', piBin });
    } catch (e) {
      trace({ kind: 'event', event: 'pixinsight start failed', piBin, message: e?.message ?? String(e) });
      logFn(`  [bridge] autostart failed: ${e.message}`);
      throw new BridgeCrashError(e?.message ? `PixInsight could not be started: ${e.message}` : AUTOSTART_FAILED_MESSAGE);
    }
    // isRunning() === null means the OS could not answer at all -- never
    // treat that as a crash; only a confirmed `false` does.
    const alive = await probe.isRunning();
    if (alive === false) {
      throw new BridgeCrashError(AUTOSTART_FAILED_MESSAGE);
    }
    // No watcher of this dir is alive, so nothing is consuming its commands/: anything orphaned there
    // would run the moment the watcher below starts. Move it aside first.
    quarantineStaleCommands(site.dir);
    await pruneLaunchTickets(site, freshProcess);
    logFn(`  [bridge] no watcher running — launching on demand (linger ${lingerMs}ms)`);
    await launchAndAwaitWatcher(site);
  }
  // Clean up stale results from previous crashed sessions.
  function removeStaleResults(dir) {
    try {
      const resDir = resDirOf(dir);
      const cutoff = now() - STALE_RESULT_MS;
      for (const f of bfs.readdirSync(resDir)) {
        const fp = path.join(resDir, f);
        const stat = bfs.statSync(fp);
        if (stat.mtimeMs < cutoff) { try { bfs.unlinkSync(fp); } catch {} }
      }
    } catch {}
  }
  removeStaleResults(bridgeDir);

  // The first time this bridge writes into a dir (a workspace may have been used by an earlier
  // session): commands left there by a sender that is gone must never run, even if a watcher is alive.
  const usedDirs = new Set();
  function firstUse(dir) {
    if (usedDirs.has(dir)) return;
    usedDirs.add(dir);
    quarantineStaleCommands(dir, { senderGoneOnly: true });
  }

  // Queued commands of a process that exits are waited on by nobody: drop them.
  let exitHooked = false;
  function hookExit() {
    if (exitHooked) return;
    exitHooked = true;
    const dropQueued = () => {
      for (const { cmdFile } of ownPending.values()) { try { bfs.rmSync(cmdFile, { force: true }); } catch {} }
    };
    onExit(dropQueued);
  }

  // The workspace changed: later sends go to `dir` (and its own watcher). Sends already written keep
  // their own dir and its watcher until they settle, so none is lost or run twice. The new dir is
  // swept for orphans on its first send, before anything is written to it.
  function setBridgeDir(dir) {
    if (!dir || dir === bridgeDir) return;
    bridgeDir = dir;
    removeStaleResults(dir);
  }

  async function send(tool, proc, params, sendOpts) {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date(now()).toISOString(), senderPid: pid, tool, process: proc,
      parameters: params,
      executeMethod: sendOpts?.exec || 'executeGlobal',
      targetView: sendOpts?.view || null
    };
    // The dir this command lives in for its whole life, even if the workspace changes meanwhile, and
    // the watcher that serves it. Commands left in it by a sender that is gone are moved aside first.
    const dir = realDir(bridgeDir);
    const site = siteOf(dir);
    hookExit();
    firstUse(dir);
    const cmdDir = cmdDirOf(dir);
    const resDir = resDirOf(dir);
    const quarantineDir = quarantineDirOf(dir);
    const cmdFile = path.join(cmdDir, id + '.json');
    const runningFile = path.join(cmdDir, id + '.running'); // the name a watcher claims it under
    const traced = { cmdId: id, tool, params, dir, sentAt: null };
    const settle = () => {
      ownPending.delete(id);
    };
    // Every way this send gives up removes its own command file, so no later watcher runs a command
    // nobody is waiting for any more (a timeout, a crash the caller is told to retry, an abort).
    const abandon = () => {
      settle();
      try { bfs.rmSync(cmdFile, { force: true }); } catch {}
      try { bfs.rmSync(path.join(cmdDir, id + '.tmp'), { force: true }); } catch {}
      // A watcher claims a command by renaming it to <id>.running before running it.
      try { bfs.rmSync(runningFile, { force: true }); } catch {}
    };

    // Written BEFORE ensureWatcher(): a watcher launched on demand for this command then finds it
    // on its first look, and its idle-exit "last look" can never miss it (e2e: a watcher that
    // started and idled out while the bridge was still waiting to see its heartbeat).
    try {
      bfs.mkdirSync(cmdDir, { recursive: true });
      bfs.mkdirSync(resDir, { recursive: true });
    } catch (e) {
      settle();
      traceFailure(traced, e, 'write');
      throw e;
    }
    ownPending.set(id, { cmdFile });
    // Written to <id>.tmp and renamed, so the watcher (which lists only *.json) never reads a command
    // between its create and its write, finds it empty and quarantines it with no result.
    const tmpFile = path.join(cmdDir, id + '.tmp');
    try {
      bfs.writeFileSync(tmpFile, JSON.stringify(cmd, null, 2));
      bfs.renameSync(tmpFile, cmdFile);
    } catch (e) {
      abandon();
      traceFailure(traced, e, 'write');
      throw e;
    }
    const sentAt = now(); // the send timeout counts from the write
    traced.sentAt = sentAt;
    trace({ kind: 'sent', ...traced });
    try {
      await ensureWatcher(site);
    } catch (e) {
      abandon();
      traceFailure(traced, e, failureKind(e));
      throw e;
    }
    // The pickup timeout counts from when a watcher is known to be running. Counting it from the
    // write made it already expired after any slow launch, so a watcher still stalled in its
    // start-up UI work (heartbeat not yet refreshed) was taken for dead and a second one launched.
    const readyAt = now();

    return new Promise((resolve, reject) => {
      let lastDeadCheckAt = now();
      let consecutiveDeadChecks = 0;
      let checkingPickup = false;
      let pickupRelaunches = 0;
      let missingSince = null;
      let sawClaim = false; // a watcher renamed it to <id>.running at some point: it may have run
      let settled = false;
      const fail = (e, kind = failureKind(e)) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        abandon();
        traceFailure(traced, e, kind);
        reject(e);
      };
      const poll = setInterval(async () => {
        if (settled) return;
        const rp = path.join(resDir, id + '.json');
        if (bfs.existsSync(rp)) {
          let r;
          try {
            r = JSON.parse(bfs.readFileSync(rp, 'utf-8'));
          } catch {
            return; // not fully written yet: retry on the next poll
          }
          if (r.status === 'running') return;
          settled = true;
          clearInterval(poll);
          settle();
          // A result that cannot be deleted must not strand the caller; the stale-result cleanup
          // at the next bridge construction removes it later.
          try { unlinkResult(rp); } catch {}
          noteWatcherStart(site);
          trace({ kind: 'done', ...traced, ms: now() - sentAt, result: r });
          resolve(r);
          return;
        }
        // Neither queued, claimed nor answered: someone removed it (a watcher quarantined it, another
        // server swept it, or a watcher ran it and could not write the result). Checked over a grace
        // window, never on one look, so a claim rename that is not atomic is not mistaken for this.
        const claimedNow = bfs.existsSync(runningFile);
        if (claimedNow) sawClaim = true;
        if (!bfs.existsSync(cmdFile) && !claimedNow) {
          if (missingSince === null) missingSince = Date.now();
          else if (Date.now() - missingSince > vanishGraceMs && !bfs.existsSync(rp)) {
            fail(new Error(sawClaim
              // Claimed, so a watcher started it: it may have run in full and failed only to answer.
              ? `The command for ${tool} was claimed by a watcher and then vanished with no result; it was not re-run, and whether any of it was applied is unknown. Check the affected images before retrying.`
              : `The command for ${tool} vanished from the bridge before any watcher claimed it (quarantined? see ${quarantineDir}). It was not run by this server; retry.`), 'vanished');
            return;
          }
        } else {
          missingSince = null;
        }
        // Still unconsumed after pickupTimeoutMs and no live watcher: it
        // probably exited just as the command was written (idle exit).
        // Relaunch it, unless the user stopped it on purpose.
        const queued = !checkingPickup && now() - readyAt > pickupTimeoutMs && bfs.existsSync(cmdFile);
        const claimed = !checkingPickup && !queued && bfs.existsSync(runningFile);
        if (claimed) {
          // A watcher claimed this command (renamed it to <id>.running) and started running it. If it
          // is gone now, it died mid-command: fail at once rather than wait out the send timeout, and
          // never re-run it, since part of it may already have been applied.
          checkingPickup = true;
          try {
            if (!(await watcherAlive(site))) {
              fail(new Error(`The PixInsight watcher stopped while running this command (${tool}); it was not re-run, and whether any of it was applied is unknown. Check the affected images before retrying.`), 'watcher lost');
              return;
            }
          } finally {
            checkingPickup = false;
          }
        }
        if (autoLaunch && queued) {
          checkingPickup = true;
          try {
            if (!(await watcherAlive(site))) {
              trace({ kind: 'event', event: 'relaunch', reason: 'no watcher picked the command up', cmdId: id });
              if (++pickupRelaunches > MAX_PICKUP_RELAUNCHES) {
                const raw = readHeartbeatRaw(site);
                throw new Error(`The watcher was relaunched ${pickupRelaunches - 1} time(s) for this command and disappeared each time before picking it up. ` +
                  (await watcherDiagnostics(site, pickupRelaunches - 1, site.lastLaunchAt, raw ? { raw, at: now() } : null, readLastStop(site))));
              }
              await ensureWatcher(site);
            }
          } catch (e) {
            fail(e); // don't let a later watcher run a command the user aborted
            return;
          } finally {
            checkingPickup = false;
          }
        }
        // Every ~deadCheckIntervalMs, check if PixInsight is still alive.
        if (now() - lastDeadCheckAt >= deadCheckIntervalMs) {
          lastDeadCheckAt = now();
          const alive = await probe.isRunning();
          if (alive === false) {
            consecutiveDeadChecks++;
            // Require 2 consecutive failed checks (~deadCheckIntervalMs apart)
            // before declaring a crash -- a single miss is usually just the
            // liveness check getting starved while PixInsight's worker
            // threads peg all cores on a heavy process.
            if (consecutiveDeadChecks >= 2) {
              fail(new BridgeCrashError(MID_COMMAND_CRASH_MESSAGE));
              return;
            }
          } else {
            // `true`, or `null` (the OS couldn't answer): cannot confirm the
            // process is dead, so this never counts toward a crash.
            consecutiveDeadChecks = 0;
          }
        }
        if (now() - sentAt > sendTimeoutMs) fail(new Error('Timeout: ' + tool), 'timeout');
      }, pollIntervalMs);
    });
  }

  async function pjsr(code) {
    const r = await send('run_script', '__script__', { code });
    r.result = r.outputs?.consoleOutput;
    if (r.status !== 'error') r.status = 'ok';
    return r;
  }

  async function listImages() {
    const list = await send('list_open_images', '__internal__', {});
    return list.outputs?.images || [];
  }

  function log(msg) { logFn(msg); }

  // Each result carries its own Process Console lines (outputs.consoleErrors); the server reads
  // them per tool call, so the bridge keeps no shared buffer.
  return { send, pjsr, listImages, log, setBridgeDir };
}
