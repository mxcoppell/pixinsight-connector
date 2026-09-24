// ============================================================================
// Cross-platform process inspection for the PixInsight process.
//
// Every OS-dependent decision (which command to run, how to parse it) lives
// behind one small per-OS strategy object, and every external dependency
// (`exec`, `readFile`, `listProc`) is a parameter with a real default — so
// all three OS strategies can be exercised and unit-tested from any single
// development machine by injecting fakes.
//
// Contract: isRunning() / startedAt() / memoryMB() NEVER throw and NEVER
// guess. Each resolves to `null` the moment the OS can't answer (unsupported
// platform, a command that isn't installed, a file that can't be read, output
// that doesn't parse) so callers can fall back to a heartbeat-only notion of
// liveness instead of mistaking "unknown" for "confirmed dead".
//
// No shell pipelines anywhere here: every external command is run via
// `exec(cmd, args)` (argv array, no shell), never a `cmd1 | cmd2` string.
// ============================================================================

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Real (default) implementations of the injectable I/O primitives.
// ---------------------------------------------------------------------------

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (error, stdout) => {
      // execFile reports a non-zero exit status as `error` too, but that
      // still means the OS answered (e.g. `pgrep` exits 1 for "no match",
      // not "pgrep is broken"). Only a genuine failure to run the command
      // at all -- ENOENT, a timeout, a kill signal -- has a non-numeric
      // `error.code`; that's the only case worth rejecting on.
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

async function defaultReadFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function defaultListProc() {
  try {
    const entries = await fs.readdir('/proc', { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Linux: read /proc directly. No child process at all -- faster and more
// reliable than shelling out, and the only strategy of the three that needs
// no `exec` at all.
// ---------------------------------------------------------------------------

// USER_HZ / SC_CLK_TCK. This is a stable kernel ABI constant (not a tunable)
// and has been 100 on every mainstream Linux distribution/architecture for
// well over a decade, so it's hardcoded rather than shelled out to `getconf`.
const LINUX_CLK_TCK = 100;

async function linuxFindPid({ readFile, listProc }) {
  for (const pid of await listProc()) {
    const comm = await readFile(`/proc/${pid}/comm`);
    if (comm !== null && comm.trim() === 'PixInsight') return pid;
  }
  return null;
}

const linuxStrategy = {
  async isRunning(io) {
    return (await linuxFindPid(io)) !== null;
  },

  async startedAt({ readFile, listProc }) {
    const pid = await linuxFindPid({ readFile, listProc });
    if (pid === null) return null;
    const stat = await readFile(`/proc/${pid}/stat`);
    const uptime = await readFile('/proc/uptime');
    if (stat === null || uptime === null) return null;

    // Fields 1/2 are "pid (comm)"; comm can itself contain spaces or ')', so
    // the only safe split point is after the LAST ')'. Field 3 onward starts
    // right after that, meaning field 22 (starttime) is at index 19 there.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const starttimeTicks = Number(afterComm[19]);
    const uptimeSeconds = Number(uptime.trim().split(/\s+/)[0]);
    if (!Number.isFinite(starttimeTicks) || !Number.isFinite(uptimeSeconds)) return null;

    const bootTimeMs = Date.now() - uptimeSeconds * 1000;
    return Math.round(bootTimeMs + (starttimeTicks / LINUX_CLK_TCK) * 1000);
  },

  async memoryMB({ readFile, listProc }) {
    const pid = await linuxFindPid({ readFile, listProc });
    if (pid === null) return null;
    const status = await readFile(`/proc/${pid}/status`);
    if (status === null) return null;
    const m = status.match(/^VmRSS:\s*(\d+)\s*kB/m);
    if (!m) return null;
    return Math.round(Number(m[1]) / 1024);
  },
};

// ---------------------------------------------------------------------------
// macOS: pgrep -x (exact process name, no pipe) to find the pid, then ps -o
// for the two readings BSD `ps` can report directly. Never -f: that matches
// every process whose argv merely mentions "PixInsight" (an agent CLI started
// with a prompt argument, say), which would keep isRunning() true after
// PixInsight quits. -x matches the process name, like Linux's comm check and
// Windows' IMAGENAME filter.
// ---------------------------------------------------------------------------

async function macFindPid({ exec }) {
  const out = await exec('pgrep', ['-x', 'PixInsight']);
  const pid = out
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return pid || null;
}

const macStrategy = {
  async isRunning({ exec }) {
    return (await macFindPid({ exec })) !== null;
  },

  async startedAt({ exec }) {
    const pid = await macFindPid({ exec });
    if (pid === null) return null;
    const out = await exec('ps', ['-o', 'lstart=', '-p', pid]);
    const line = out.trim();
    if (!line) return null;
    const t = Date.parse(line);
    return Number.isNaN(t) ? null : t;
  },

  async memoryMB({ exec }) {
    const pid = await macFindPid({ exec });
    if (pid === null) return null;
    const out = await exec('ps', ['-o', 'rss=', '-p', pid]);
    const kb = Number(out.trim());
    if (!Number.isFinite(kb)) return null;
    return Math.round(kb / 1024);
  },
};

// ---------------------------------------------------------------------------
// Windows: tasklist for presence/pid (never wmic -- deprecated and absent
// from current releases), PowerShell for start time and working set.
// ---------------------------------------------------------------------------

function parseCsvLine(line) {
  // tasklist's `/FO CSV` quotes every field, so a regex over quoted spans
  // safely handles commas embedded inside a field (e.g. "1,440,000 K").
  const matches = line.trim().match(/"([^"]*)"/g);
  return matches ? matches.map((s) => s.slice(1, -1)) : null;
}

async function winFindProcess({ exec }) {
  const out = await exec('tasklist', ['/FI', 'IMAGENAME eq PixInsight.exe', '/NH', '/FO', 'CSV']);
  const fields = parseCsvLine(out);
  if (!fields || !fields[0] || fields[0].toLowerCase() !== 'pixinsight.exe') return null;
  return { pid: fields[1] };
}

const WIN_PS_COMMON_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

const winStrategy = {
  async isRunning({ exec }) {
    return (await winFindProcess({ exec })) !== null;
  },

  async startedAt({ exec }) {
    const proc = await winFindProcess({ exec });
    if (!proc) return null;
    const out = await exec('powershell', [
      ...WIN_PS_COMMON_ARGS,
      "Get-Process -Name PixInsight -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty StartTime | ForEach-Object { $_.ToString('o') }",
    ]);
    const line = out.trim();
    if (!line) return null;
    const t = Date.parse(line);
    return Number.isNaN(t) ? null : t;
  },

  async memoryMB({ exec }) {
    const proc = await winFindProcess({ exec });
    if (!proc) return null;
    const out = await exec('powershell', [
      ...WIN_PS_COMMON_ARGS,
      'Get-Process -Name PixInsight -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty WorkingSet64',
    ]);
    const bytes = Number(out.trim());
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.round(bytes / (1024 * 1024));
  },
};

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

const STRATEGIES = { linux: linuxStrategy, darwin: macStrategy, win32: winStrategy };

async function safeNull(fn) {
  try {
    const v = await fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

// Whether a process with this pid exists, on every OS: process.kill(pid, 0) sends no signal, it only
// asks. ESRCH means no such process; EPERM means it exists but belongs to someone else, which still
// counts as alive. Anything else, or a value that is not a pid, is unknown (null), which callers must
// never read as "gone". `kill` is injectable for tests.
export function isPidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === 'ESRCH') return false;
    if (e?.code === 'EPERM') return true;
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.platform] - process.platform, or an injected fake ('linux'|'darwin'|'win32'|...).
 * @param {(cmd: string, args: string[]) => Promise<string>} [opts.exec] - runs a program with no shell.
 * @param {(path: string) => Promise<string|null>} [opts.readFile] - null instead of throwing on a missing file.
 * @param {() => Promise<string[]>} [opts.listProc] - numeric /proc entries (Linux only; unused elsewhere).
 * @returns {{ isRunning: () => Promise<boolean|null>, startedAt: () => Promise<number|null>, memoryMB: () => Promise<number|null> }}
 */
export function createProcessProbe(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const io = {
    exec: opts.exec ?? defaultExec,
    readFile: opts.readFile ?? defaultReadFile,
    listProc: opts.listProc ?? defaultListProc,
  };

  const strategy = STRATEGIES[platform];
  if (!strategy) {
    // An OS we have no strategy for at all: never guess.
    return {
      isRunning: async () => null,
      startedAt: async () => null,
      memoryMB: async () => null,
    };
  }

  return {
    isRunning: () => safeNull(() => strategy.isRunning(io)),
    startedAt: () => safeNull(() => strategy.startedAt(io)),
    memoryMB: () => safeNull(() => strategy.memoryMB(io)),
  };
}

// onProcessExit(fn): runs fn(code) when this process exits. One process-wide 'exit' listener, however
// many bridges (one per bridge built) and call logs add hooks. Used to drop this process's queued
// commands and to write the call log's exit event.
const exitHooks = new Set();
let exitListening = false;
export function onProcessExit(fn) {
  exitHooks.add(fn);
  if (!exitListening) {
    exitListening = true;
    process.once('exit', (code) => { for (const h of exitHooks) { try { h(code); } catch {} } });
  }
}
