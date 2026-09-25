#!/usr/bin/env node
// ============================================================================
// pixinsight-connector bin entry: dispatches to a subcommand. `serve` (the default,
// so a bare `pixinsight-connector` — or `npx -y pixinsight-connector` —
// with no arguments works as an MCP stdio server) connects the real server
// over stdio. `doctor` runs the real diagnostics (src/doctor.mjs). `install`
// edits no harness config: every harness registers the same stdio command, in
// its own way, so it prints that command and points at the README's
// per-harness install table.
// ============================================================================
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from './server.mjs';
import { resolvePlatform } from './platform.mjs';
import { createProcessProbe } from './process-probe.mjs';
import { runDoctor, readConnectorVersion } from './doctor.mjs';
import { loadPacks } from './packs.mjs';

const KNOWN_COMMANDS = new Set(['serve', 'doctor', 'install']);

export function parseArgs(argv) {
  const [maybeCommand, ...rest] = argv;
  if (KNOWN_COMMANDS.has(maybeCommand)) return { command: maybeCommand, rest };
  // No subcommand (or an option like --help): default to serve, forwarding all args.
  return { command: 'serve', rest: maybeCommand === undefined ? [] : argv };
}

// `deps` is test-only dependency injection: every field defaults to the real
// thing (real `resolvePlatform`/`createProcessProbe` resolution, real
// `loadPacks()` against `env`/`homeDir`, `os.homedir()`, `process.env`), so
// `main()`'s real call site (`doctor(rest)`, no second argument) is unaffected.
// A test can pass `deps.platform`/`deps.probe`/`deps.packs`/`deps.homeDir`/
// `deps.env`/`deps.watcherFs`/`deps.log`/`deps.osName`/`deps.existsSync`/`deps.cwd`/`deps.net`/`deps.machineId` directly to drive a
// deterministic, fully-fake `runDoctor()` result -- e.g. to exercise the
// `--json` output shape and the `process.exitCode = ok ? 0 : 1` contract
// without depending on whatever machine happens to be running the suite.
export async function doctor(args = [], deps = {}) {
  const json = args.includes('--json');
  const homeDir = deps.homeDir ?? os.homedir();
  const env = deps.env ?? process.env;
  const osName = deps.osName ?? process.platform;

  let platform = deps.platform;
  let platformError;
  if (platform === undefined) {
    try {
      platform = resolvePlatform({ env, platform: osName, existsSync: deps.existsSync ?? existsSync, homeDir });
    } catch (e) {
      // Leave platform null -- runDoctor's own 'platform' check turns an
      // unresolved install into one actionable line (the resolver's own
      // reason) instead of a stack trace.
      platform = null;
      platformError = e?.message;
    }
  }

  const probe = deps.probe ?? createProcessProbe();
  // The same loadPacks() pass `serve` makes at startup, so doctor reports the
  // packs a real session would get. Its warnings go to stderr, keeping stdout
  // clean for --json; every skipped pack's reason is in the 'packs' check too.
  const log = deps.log ?? ((m) => process.stderr.write(`${m}\n`));
  const packs = deps.packs ?? (await loadPacks({ env, homeDir, log })).packs;

  const result = await runDoctor({
    platform, platformError, probe, packs, homeDir, env, osName,
    ...(deps.watcherFs ? { watcherFs: deps.watcherFs } : {}),
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.net ? { net: deps.net } : {}),
    ...(deps.machineId ? { machineId: deps.machineId } : {}),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write('pixinsight-connector doctor\n\n');
    for (const c of result.checks) {
      process.stdout.write(`${c.ok ? '[OK]  ' : '[FAIL]'} ${c.name}: ${c.detail}\n`);
      if (!c.ok && c.hint) process.stdout.write(`        hint: ${c.hint}\n`);
    }
    process.stdout.write(`\n${result.ok ? 'All checks passed.' : 'Some checks failed — see hints above.'}\n`);
    process.stdout.write(`\n${SKILLS_NOTE}\n`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

const PACKAGE = 'pixinsight-connector';
const SKILLS_NOTE =
  'Companion skills (environment preflight, dataset intake, a basic LRGB flow, troubleshooting):\n' +
  '  https://github.com/mxcoppell/pixinsight-connector-skills';

export async function install(_args, version = readConnectorVersion()) {
  const pinned = `${PACKAGE}@${version}`;
  process.stdout.write(
    'pixinsight-connector install: register this stdio MCP server with your agent harness.\n' +
    `Install it once:\n  npm install -g ${pinned}\n` +
    'then register the command:\n  pixinsight-connector\n' +
    `Or run it without installing (npx fetches it from npm):\n  npx -y ${pinned}\n` +
    'Each harness takes it in its own config; see the install table in the README:\n' +
    '  https://github.com/mxcoppell/pixinsight-connector#install\n' +
    'Then check the machine with: pixinsight-connector doctor\n' +
    `${SKILLS_NOTE}\n`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, rest } = parseArgs(argv);
  switch (command) {
    case 'doctor':
      await doctor(rest);
      return;
    case 'install':
      await install(rest);
      return;
    case 'serve':
    default:
      await serve();
      return;
  }
}

// True when `metaUrl` (this module's import.meta.url) is the module Node was launched with.
// argv[1] is resolved through `realpath` first because an npm bin (the npx cache, a global
// install) is a symlink to this file, and converted with pathToFileURL rather than string
// concatenation so a Windows drive path or a path containing a space compares correctly.
export function isEntryPoint(metaUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpath(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}

// Only run when this file is the process entry point (not when imported by a test).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`[pixinsight-connector] fatal: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
