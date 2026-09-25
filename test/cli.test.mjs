// parseArgs tests live in test/cli-parse-args.test.mjs, not here -- see that
// file's header comment for why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { doctor, install } from '../src/cli.mjs';
import { fixture } from './helpers.mjs';

// Captures process.stdout.write output and restores it afterward, alongside
// process.exitCode (which node --test itself respects at the END of the
// whole run -- a test that sets it and never restores it would silently fail
// the entire suite, even with every assertion passing).
async function captureDoctorRun(args, deps) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await doctor(args, deps);
    return { stdout: chunks.join(''), exitCode: process.exitCode };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

// No PixInsight is found (existsSync says nothing exists), which is what every CI runner sees:
// the summary still names the injected OS, so the result does not depend on the host machine.
test('doctor prints a short platform/node summary and does not throw', async (t) => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-doctor-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const { stdout } = await captureDoctorRun([], {
    osName: 'linux',
    existsSync: () => false,
    env: {},
    homeDir,
    probe: { isRunning: async () => null },
    packs: [],
    log: () => {},
  });
  assert.match(stdout, /doctor/);
  assert.match(stdout, /platform: .*\blinux\b/);
  assert.match(stdout, /Node v/);
});

test('install prints guidance without throwing', async () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    await install([], '9.8.7');
  } finally {
    process.stdout.write = original;
  }
  const out = chunks.join('');
  assert.match(out, /install/);
  assert.match(out, /npm install -g pixinsight-connector@9\.8\.7\n/, 'prints the pinned install command');
  assert.match(out, /^  pixinsight-connector$/m, 'prints the harness-neutral server command');
  assert.match(out, /npx -y pixinsight-connector@9\.8\.7\n/, 'prints the pinned npx alternative');
  assert.match(out, /README/, 'points at the README install table');
  assert.match(out, /github\.com\/mxcoppell\/pixinsight-connector-skills/, 'points at the companion skills');
  assert.doesNotMatch(out, /\b(claude|codex|opencode|cursor)\b/i, 'names no particular harness');
  assert.doesNotMatch(out, /later phase/i, 'no stale "lands in a later phase" text');
});

// The connector is published on npm; the github: form skips npm and needs GitHub at every start.
test('src/ tells people to run the npm package, not the github: form', async () => {
  const offenders = [];
  for (const e of await readdir('src', { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const file = path.join(e.parentPath, e.name);
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/github:mxcoppell\/pixinsight-connector/g)) offenders.push(`${file}: ${m[0]}`);
    if (/\bclaude mcp add\b/.test(text)) offenders.push(`${file}: harness-specific "claude mcp add"`);
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// doctor --json and the `process.exitCode = ok ? 0 : 1` contract. Both are
// explicit brief requirements the original test above never exercised (it
// only regex-matches text-mode stdout). Driven entirely through `doctor`'s
// injectable `deps` param (see src/cli.mjs) so both the healthy and failing
// cases are deterministic regardless of which machine/OS runs the suite --
// not dependent on whatever this machine's real PixInsight install happens
// to look like today.
// ---------------------------------------------------------------------------

test('doctor --json exits 0 and prints valid, parseable JSON matching runDoctor\'s shape when every check passes', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const piBin = path.join(dir, 'PixInsight');
  const imageSolverPath = path.join(dir, 'ImageSolver.js');
  const filterDbPath = path.join(dir, 'filters.xspd');
  const settingsPath = path.join(dir, 'core-001-pxi.settings');
  await Promise.all([piBin, imageSolverPath, filterDbPath, settingsPath].map((p) => fsp.writeFile(p, '')));
  await fsp.chmod(piBin, 0o755);

  const platform = {
    piBin,
    imageSolverPath,
    filterDbPath,
    settingsPath,
    verified: true,
  };

  const { stdout, exitCode } = await captureDoctorRun(['--json'], {
    platform,
    probe: { isRunning: async () => false },
    packs: [],
    homeDir: dir,
    env: {},
    cwd: dir,
    // The launch-mutex port, free: never the real loopback port, which a running connector may hold.
    net: { createServer: () => { const s = new EventEmitter(); s.listen = (o, cb) => { queueMicrotask(cb); return s; }; s.close = (cb) => { cb?.(); return s; }; s.unref = () => s; return s; } },
  });

  const parsed = JSON.parse(stdout); // throws if this isn't valid JSON
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.checks));
  assert.equal(parsed.checks.length, 13);
  for (const c of parsed.checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.detail, 'string');
  }
  assert.equal(exitCode, 0);
});

test('doctor exits 1 when runDoctor reports any check as failing', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const { stdout, exitCode } = await captureDoctorRun([], {
    platform: null, // forces the 'platform' check (and its dependents) to fail
    probe: { isRunning: async () => null },
    packs: [],
    homeDir: dir,
    env: {},
  });

  assert.match(stdout, /\[FAIL\]/);
  assert.equal(exitCode, 1);
});

test('doctor --json still exits 1 and reports ok:false when a check fails', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const { stdout, exitCode } = await captureDoctorRun(['--json'], {
    platform: null,
    probe: { isRunning: async () => null },
    packs: [],
    homeDir: dir,
    env: {},
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// doctor loads packs for real (src/packs.mjs loadPacks) unless deps.packs is
// injected. PIXINSIGHT_CONNECTOR_PACKS in the injected env points at the fixture
// packs, and with it unset no pack loads at all, so nothing on this machine
// leaks in.
// ---------------------------------------------------------------------------

async function doctorPacksCheck(t, env, extraDeps = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { stdout, exitCode } = await captureDoctorRun(['--json'], {
    platform: null, probe: { isRunning: async () => null }, homeDir: dir, env, log() {}, ...extraDeps,
  });
  return { check: JSON.parse(stdout).checks.find((c) => c.name === 'packs'), exitCode };
}

test('doctor reports a really-loaded pack from PIXINSIGHT_CONNECTOR_PACKS as loaded', async (t) => {
  const { check } = await doctorPacksCheck(t, { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-ok') });
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /ok@1\.0\.0 apiVersion=1 tools=1 — loaded/);
});

test('doctor fails the packs check, and exits 1, when a configured pack is skipped', async (t) => {
  const { check, exitCode } = await doctorPacksCheck(t, { PIXINSIGHT_CONNECTOR_PACKS: `${fixture('pack-ok')},${fixture('pack-badversion')},${fixture('pack-throws')}` });
  assert.equal(check.ok, false);
  assert.match(check.detail, /from-the-future@1\.0\.0 .*skipped \(apiVersion 99/);
  assert.match(check.detail, /pack-throws.*skipped \(this pack is broken on purpose\)/);
  assert.equal(exitCode, 1);
});

test('an injected deps.packs still wins over real pack loading', async (t) => {
  const { check } = await doctorPacksCheck(t, { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-badversion') }, { packs: [] });
  assert.equal(check.ok, true);
  assert.match(check.detail, /no packs/i);
});
