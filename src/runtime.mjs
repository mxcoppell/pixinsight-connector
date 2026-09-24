// Materializes the PJSR watcher template into the target folder, one script per target and machine:
// `<state>/watcher/<version>/<machine-id>/watcher.js`, beside the bridge dir it serves
// (`<state>/bridge/<machine-id>`). Two tokens are substituted: the running platform's ImageSolver
// path (`@@IMAGESOLVER@@`) and that bridge dir (`@@BRIDGEDIR@@`, as a JSON string literal), so the
// watcher serves only its own target. Nothing is written outside the target.
//
// Every filesystem operation is injected (readFile/writeFile/mkdir/rename/stat), so all three OS
// behaviors are testable from any single development machine -- this module never touches
// `process.platform`, the home directory, or the real filesystem directly.
//
// Also here: ensurePixInsight (start PixInsight on demand) and its machine-wide launch mutex.

import path from 'node:path';
import nodeNet from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { toPixPath } from './platform.mjs';

const TEMPLATE_URL = new URL('../pjsr/watcher.template.js', import.meta.url);

/**
 * Where the watcher script serving `bridgeDir` (`<state>/bridge/<machine-id>`) is written:
 * `<state>/watcher/<version>/<machine-id>/watcher.js`. Per machine, because two machines sharing a
 * target on network storage each bake in their own subdir.
 * @param {string} bridgeDir
 * @param {string} version
 */
export function watcherPathOf(bridgeDir, version) {
  const stateDir = path.dirname(path.dirname(bridgeDir));
  return path.join(stateDir, 'watcher', version, path.basename(bridgeDir), 'watcher.js');
}

/**
 * The note for a target path with a space in it: PixInsight's `-x=<path>` launch (the script lives in
 * the target) was verified with a space on macOS only. null when there is nothing to say.
 * @param {string} osPlatform - process.platform, or an injected fake.
 * @param {string} p - the target or state path.
 * @returns {string|null}
 */
export function spaceInPathNote(osPlatform, p) {
  if (osPlatform === 'darwin' || !/ /.test(String(p))) return null;
  return `The path "${p}" contains a space. PixInsight is launched with the watcher script from there (-x=<path>); ` +
    `a path with a space is verified on macOS and unverified on ${osPlatform}. If the watcher never starts, use a target folder without spaces.`;
}

/**
 * @param {object} params
 * @param {{ imageSolverPath: string }} params.platform - from resolvePlatform.
 * @param {string} params.version - pkgVersion, used to key the destination directory.
 * @param {string} params.bridgeDir - the bridge dir the watcher serves, `<state>/bridge/<machine-id>`.
 * @param {(url: URL|string) => Promise<string>} params.readFile
 * @param {(path: string, data: string) => Promise<void>} params.writeFile
 * @param {(path: string) => Promise<void>} params.mkdir
 * @param {(from: string, to: string) => Promise<void>} params.rename
 * @param {(path: string) => Promise<{ size: number }|null>} [params.stat]
 * @returns {Promise<{ path: string, action: 'created'|'reused', warnings: string[] }>}
 */
export async function materializeWatcher({ platform, version, bridgeDir, readFile, writeFile, mkdir, rename, stat }) {
  if (!bridgeDir) throw new Error('materializeWatcher requires bridgeDir');
  const warnings = [];

  // The watcher #includes ImageSolver, so a wrong path is a compile error in PixInsight and the
  // watcher never writes a heartbeat. Say so here, where the path is substituted, rather than
  // leaving it to a 30 s start-up timeout. No `stat` means the caller cannot check: no warning.
  if (stat && !(await stat(platform.imageSolverPath).catch(() => null))) {
    warnings.push(
      `ImageSolver not found at "${platform.imageSolverPath}"; the watcher includes it and will not compile. ` +
        'Set PIXINSIGHT_DIR to your PixInsight install root.'
    );
  }

  const destPath = watcherPathOf(bridgeDir, version);
  const destDir = path.dirname(destPath);
  const tmpPath = `${destPath}.tmp`;

  // A backslash inside a PJSR string literal is an escape, so both paths go in with forward slashes.
  // This depends on the injected paths' own separators, never on the host's `path.sep`, so a win32
  // path is converted correctly even when this runs (or is tested) on a Mac. The bridge dir is a
  // JSON string literal, which is a valid ES5 string literal whatever the path holds (quotes too).
  const imageSolverPath = toPixPath(platform.imageSolverPath);
  const bridgeLiteral = JSON.stringify(toPixPath(bridgeDir));

  const template = await readFile(TEMPLATE_URL);
  const content = template.split('@@IMAGESOLVER@@').join(imageSolverPath).split('@@BRIDGEDIR@@').join(bridgeLiteral);

  const existing = await readFile(destPath).catch(() => null);
  if (existing === content) {
    return { path: destPath, action: 'reused', warnings };
  }

  await mkdir(destDir);
  await writeFile(tmpPath, content);
  await rename(tmpPath, destPath);

  return { path: destPath, action: 'created', warnings };
}

// ---------------------------------------------------------------------------
// The launch mutex: at most one connector on this machine starts PixInsight at a time.
//
// Each target has its own watcher and its own launch lock (in its bridge dir), so two connectors
// working in two targets do not see each other's lock. Both may find PixInsight not running at the
// same moment; without this, both would start it. The mutex is an exclusive bind of one fixed
// loopback TCP port: file-free, released by the OS the moment its holder exits or crashes, and held
// only for the launch-and-wait in ensurePixInsight, which looks again whether PixInsight is running
// after every acquire. The holder answers every connection to the port with LAUNCH_MUTEX_BANNER and
// closes it. When the bind fails because the port is in use, the caller connects: the banner means
// another connector is starting PixInsight, so it waits (up to its timeout); anything else (no answer
// within a second, a reset, other bytes) means another program owns the port, so it starts
// PixInsight at once without the mutex and says so once; a refused connection means the holder has
// just released it, so it binds again. Any other bind failure (a sandbox that forbids sockets, say)
// also starts PixInsight without the mutex, logged once. The port is 127.0.0.1:DEFAULT_LAUNCH_PORT
// unless PIXINSIGHT_CONNECTOR_LAUNCH_PORT names another; it is below every OS's ephemeral range and not an
// IANA-assigned port.
// ---------------------------------------------------------------------------

export const DEFAULT_LAUNCH_PORT = 29467;
const LAUNCH_MUTEX_POLL_MS = 200;
// What a connector holding the launch mutex writes to every connection to its port.
export const LAUNCH_MUTEX_BANNER = 'pixinsight-connector launch mutex 1\n';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1000;

function launchPort(env) {
  const raw = env?.PIXINSIGHT_CONNECTOR_LAUNCH_PORT;
  const n = /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
  return n >= 1 && n <= 65535 ? n : DEFAULT_LAUNCH_PORT;
}

/**
 * @param {object} [params]
 * @param {typeof import('node:net')} [params.net] - node:net, or a fake.
 * @param {Record<string, string|undefined>} [params.env] - for PIXINSIGHT_CONNECTOR_LAUNCH_PORT.
 * @param {(msg: string) => void} [params.log]
 * @param {() => number} [params.now]
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @param {number} [params.handshakeTimeoutMs] - how long a holder has to answer with the banner.
 * @returns {{ port: number, acquire: (o: { timeoutMs: number }) => Promise<{ held: boolean, waited: boolean, foreign?: boolean, release: () => Promise<void> }> }}
 *   acquire() waits while another connector holds the port, up to timeoutMs, then gives up and
 *   proceeds without it (held: false). `waited` says whether another connector held it meanwhile;
 *   `foreign` that another program holds the port (not waited on).
 */
export function createLaunchMutex({ net = nodeNet, env = process.env, log = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS } = {}) {
  const port = launchPort(env);
  let warned = false;
  const warnOnce = (msg) => { if (!warned) { warned = true; log(msg); } };
  const noop = async () => {};

  // Resolves { server } once bound, or { code } when the bind failed.
  function tryBind() {
    return new Promise((resolve) => {
      let server;
      try {
        server = net.createServer();
      } catch (e) {
        resolve({ code: e?.code ?? e?.message ?? String(e) });
        return;
      }
      const onError = (e) => resolve({ code: e?.code ?? e?.message ?? String(e) });
      server.once('error', onError);
      try {
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener?.('error', onError);
          server.on('error', () => {}); // nothing after the bind may take the process down
          server.on('connection', (sock) => {
            sock.on?.('error', () => {});
            try { sock.end(LAUNCH_MUTEX_BANNER); } catch {}
          });
          server.unref?.(); // never keeps the process alive
          resolve({ server });
        });
      } catch (e) {
        onError(e);
      }
    });
  }

  // Who holds the port: 'launcher' (answered with the banner), 'gone' (connection refused: it was
  // just released) or 'foreign' (anything else, including a net that cannot connect).
  function identifyHolder() {
    return new Promise((resolve) => {
      let sock;
      let got = '';
      let done = false;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock?.destroy(); } catch {}
        resolve(v);
      };
      try {
        sock = net.connect({ host: '127.0.0.1', port });
      } catch {
        finish('foreign');
        return;
      }
      timer = setTimeout(() => finish('foreign'), handshakeTimeoutMs);
      sock.on('data', (d) => {
        got += String(d);
        if (got.startsWith(LAUNCH_MUTEX_BANNER)) finish('launcher');
        else if (!LAUNCH_MUTEX_BANNER.startsWith(got)) finish('foreign');
      });
      sock.on('end', () => finish(got.startsWith(LAUNCH_MUTEX_BANNER) ? 'launcher' : 'foreign'));
      sock.on('close', () => finish(got.startsWith(LAUNCH_MUTEX_BANNER) ? 'launcher' : 'foreign'));
      sock.on('error', (e) => finish(e?.code === 'ECONNREFUSED' ? 'gone' : 'foreign'));
    });
  }

  async function acquire({ timeoutMs }) {
    const t0 = now();
    let waited = false;
    for (;;) {
      const r = await tryBind();
      if (r.server) {
        const release = () => new Promise((resolve) => { try { r.server.close(() => resolve()); } catch { resolve(); } });
        return { held: true, waited, release };
      }
      if (r.code !== 'EADDRINUSE') {
        warnOnce(`launch mutex unavailable (${r.code} binding 127.0.0.1:${port}); starting PixInsight without it`);
        return { held: false, waited, release: noop };
      }
      const holder = await identifyHolder();
      if (holder === 'gone') {
        // Released between the bind and the handshake: bind again, after a pause, and never past
        // the timeout (a port that refuses connections yet cannot be bound must not spin forever).
        if (now() - t0 > timeoutMs) {
          warnOnce(`127.0.0.1:${port} can be neither bound nor connected to; starting PixInsight without the launch mutex`);
          return { held: false, waited, release: noop };
        }
        await sleep(LAUNCH_MUTEX_POLL_MS);
        continue;
      }
      if (holder === 'foreign') {
        warnOnce(`127.0.0.1:${port} is held by another program, not a pixinsight-connector connector (set PIXINSIGHT_CONNECTOR_LAUNCH_PORT to a free port); starting PixInsight without the launch mutex`);
        return { held: false, waited, foreign: true, release: noop };
      }
      waited = true;
      if (now() - t0 > timeoutMs) {
        warnOnce(`127.0.0.1:${port} stayed bound by another connector for ${Math.round(timeoutMs / 1000)}s; starting PixInsight without the launch mutex`);
        return { held: false, waited, release: noop };
      }
      await sleep(LAUNCH_MUTEX_POLL_MS);
    }
  }

  return { port, acquire };
}

const DEFAULT_AUTOSTART_POLL_MS = 500;

/**
 * The message for a PixInsight executable that could not be run at all (spawn emitted 'error'):
 * names the path, the OS error and the fix.
 * @param {string} bin
 * @param {Error & { code?: string }} err
 * @returns {string}
 */
export function spawnFailureMessage(bin, err) {
  return `The PixInsight executable "${bin}" could not be run (${err?.code ?? err?.message ?? err}). ` +
    'Set PIXINSIGHT_BIN to the PixInsight executable, or check `npx -y github:mxcoppell/pixinsight-connector doctor`.';
}
const DEFAULT_AUTOSTART_TIMEOUT_MS = 90_000;

/**
 * Starts PixInsight on demand when it is not already running, so the user
 * never has to launch it themselves before the connector can talk to it.
 *
 * `probe.isRunning()` returning `null` means the OS could not answer -- that
 * is "unknown", never "not running". Spawning on an unknown reading risks
 * starting a second PixInsight on top of a live one, so unknown is treated
 * like "assume running" (declines to spawn) and lets the caller's own
 * liveness check fail with a clear message if it really isn't running.
 *
 * @param {object} params
 * @param {{ piBin: string }} [params.platform] - only read when a spawn is actually needed.
 * @param {{ isRunning: () => Promise<boolean|null> }} params.probe
 * @param {(bin: string, args: string[], opts: object) => { unref(): void }} [params.spawn] - defaults to node:child_process spawn.
 * @param {(msg: string) => void} [params.log] - defaults to a single process.stderr write.
 * @param {Record<string, string|undefined>} [params.env] - defaults to process.env.
 * @param {number} [params.timeoutMs] - how long to wait for it to come up, default 90s.
 * @param {{ acquire: (o: { timeoutMs: number }) => Promise<{ waited: boolean, release: () => Promise<void> }> }} [params.mutex]
 *   createLaunchMutex(): held from the decision to start PixInsight until it is up (or the wait gives
 *   up), so two connectors never both start it. None: no mutex.
 * @returns {Promise<{ started: boolean, skipped?: string }>}
 */
export async function ensurePixInsight({ platform, probe, spawn, log, env, timeoutMs = DEFAULT_AUTOSTART_TIMEOUT_MS, mutex = null }) {
  const doSpawn = spawn ?? nodeSpawn;
  // No log passed at all -> this IS the top-level writer, so it must add the "[pixinsight-connector] "
  // tag itself (matching serve()'s own log format in src/server.mjs). When a log function IS
  // passed (bridge.mjs's logFn, which in production is that very same server.mjs `log`), it has
  // already added that prefix once -- so the message below is deliberately left unprefixed, the
  // same convention every other bridge.mjs logFn(...) call already follows, to avoid doubling it.
  const logFn = log ?? ((msg) => process.stderr.write(`[pixinsight-connector] ${msg}\n`));
  const environment = env ?? process.env;

  if (environment.PIXINSIGHT_CONNECTOR_AUTOSTART === '0') {
    return { started: false, skipped: 'PIXINSIGHT_CONNECTOR_AUTOSTART=0 disables autostart' };
  }

  const alive = await probe.isRunning();
  if (alive === true) {
    return { started: false };
  }
  if (alive === null) {
    // Unknown, not confirmed dead -- never spawn a second instance on a guess.
    return { started: false, skipped: 'could not determine whether PixInsight is already running; not starting a second instance' };
  }

  // Another connector may be starting it this very moment: take the machine-wide mutex, then look
  // again before starting one. Always, not only after a wait: the first look may have been taken
  // while another connector was still launching it, and answered (a slow probe, `tasklist` on
  // Windows) only after that connector had released the mutex, so the port was free at once.
  const lock = mutex ? await mutex.acquire({ timeoutMs: timeoutMs + MUTEX_WAIT_MARGIN_MS }) : null;
  try {
    if (lock) {
      const again = await probe.isRunning();
      if (again === true) return { started: false };
      if (again === null) {
        return { started: false, skipped: 'could not determine whether PixInsight is already running; not starting a second instance' };
      }
    }
    return await spawnAndWait({ platform, probe, doSpawn, logFn, timeoutMs });
  } finally {
    await lock?.release();
  }
}

// How much longer than one launch's own wait a connector waits for another's launch to finish.
const MUTEX_WAIT_MARGIN_MS = 30_000;

async function spawnAndWait({ platform, probe, doSpawn, logFn, timeoutMs }) {
  logFn('PixInsight is not running; starting it (set PIXINSIGHT_CONNECTOR_AUTOSTART=0 to disable)');
  // An executable that cannot be run (a missing PIXINSIGHT_BIN, no execute permission) makes spawn
  // emit 'error' after it returns. Unhandled, that event would kill the whole server; handled, it
  // ends the wait below at once with the path and the fix.
  let spawnError = null;
  const child = doSpawn(platform.piBin, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child?.on?.('error', (e) => { spawnError ??= e; });
  child?.unref?.();

  const t0 = Date.now();
  while (!(await probe.isRunning())) {
    if (spawnError) throw new Error(spawnFailureMessage(platform.piBin, spawnError));
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `PixInsight did not start within ${timeoutMs}ms. Check that PixInsight is installed, ` +
          'or set PIXINSIGHT_BIN if it is installed somewhere unusual.'
      );
    }
    await new Promise((r) => setTimeout(r, DEFAULT_AUTOSTART_POLL_MS));
  }
  return { started: true };
}
