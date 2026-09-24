import { readdir, readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { catalogFrom } from '../src/define.mjs';

export async function concatSources(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith('.mjs')) {
      out.push(await readFile(path.join(e.parentPath, e.name), 'utf8'));
    }
  }
  return out.join('\n');
}

// In-memory fs for materializeWatcher. `ops` records the order of operations so a test can assert
// write-then-rename rather than trusting the implementation.
export function fakeFs({
  template = '#include "@@IMAGESOLVER@@"\nvar BRIDGE_DIR = @@BRIDGEDIR@@;',
  platform = {
    imageSolverPath: '/Applications/PixInsight/src/scripts/ImageSolver/ImageSolver.js',
  },
  bridgeDir = path.join(path.sep, 'astro', 'M31', 'agentic', 'bridge', 'rig'),
  version = '1.0.0',
  osPlatform = 'darwin',
  imageSolverExists = true,
} = {}) {
  const files = new Map();
  const ops = [];
  const h = {
    platform, bridgeDir, version, osPlatform, files, ops,
    get writeCount() { return ops.filter((o) => o.startsWith('write ')).length; },
    readFile: async (p) => (String(p).endsWith('watcher.template.js') ? template : files.get(p) ?? null),
    writeFile: async (p, data) => { ops.push(`write ${p}`); files.set(p, data); },
    rename: async (a, b) => { ops.push(`rename ${a} -> ${b}`); files.set(b, files.get(a)); files.delete(a); },
    mkdir: async (p) => { ops.push(`mkdir ${p}`); },
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : imageSolverExists && p === platform.imageSolverPath ? { size: 1 } : null),
  };
  return h;
}

// Content written to a path by the most recent fakeFs passed to `written.use(h)`.
written.use = (h) => { written._h = h; };
export function written(p) { return written._h.files.get(p); }

// Two materializeWatcher calls sharing one filesystem, for the version-bump test.
export function sharedFakeFs(opts) { return fakeFs(opts); }

// Trivial builders for src/api.mjs's buildApi({ ctx, platform, workspace, log, version }) tests
// (test/api.test.mjs) -- kept here rather than inlined so those tests read as assertions about
// the API, not about fake setup.
export const fakeCtx = () => createFakeBridge().ctx;
export const fakePlatform = () => ({
  piBin: '/fake/PixInsight', imageSolverPath: '/fake/ImageSolver.js',
  filterDbPath: '/fake/filters.xspd', whiteRefPath: '/fake/white-references.xspd',
  settingsPath: '/fake/core-001-pxi.settings', verified: true,
});
export const fakeWs = () => ({ dir: '/tmp/ws', scratchDir: '/tmp/ws/agentic/scratch', outputDir: '/tmp/ws/output' });

// ---------------------------------------------------------------------------
// Pack-fixture helpers for test/packs.test.mjs (Task 12, the pack loader).
// These are the last additions to this file; everything after this point
// reuses them.
// ---------------------------------------------------------------------------

// fileURLToPath, not URL#pathname: the latter is `/D:/a/...` on Windows and keeps spaces as %20.
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to a fixture pack directory. */
export const fixture = (name) => path.join(HERE, 'fixtures', name);

/** Source text of a fixture pack's index.mjs, for tests that plant a copy elsewhere. */
export const fixtureSource = (name) => readFile(path.join(fixture(name), 'index.mjs'), 'utf8');

/** A temp HOME with a fixture pack at <home>/.pixinsight-mcp/<relDir>, the pre-1.1 default pack folder (to show it is no longer read). */
export async function tmpHomeContaining(relDir, sourcePromise) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pixi-home-'));
  const dest = path.join(home, '.pixinsight-mcp', relDir);
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, 'index.mjs'), await sourcePromise, 'utf8');
  return home;
}

/** A minimal core catalog containing just the named tools, for merge tests. */
export function coreWith(names) {
  const tools = names.map((name) => ({
    name, description: `Core ${name}, present only so the merge test has something to shadow.`,
    inputSchema: { type: 'object', properties: {} },
    handler: coreHandlerFor(name),
  }));
  return catalogFrom(tools);
}

const coreHandlers = new Map();
export function coreHandlerFor(name) {
  if (!coreHandlers.has(name)) coreHandlers.set(name, async () => ({ text: `core:${name}` }));
  return coreHandlers.get(name);
}

/** The descriptors a named fixture pack exports, and a stable handle on each handler. */
export async function packToolsFrom(name) {
  // A file URL, not a bare path: Node rejects `import('D:\\...')` on Windows.
  const mod = await import(pathToFileURL(path.join(fixture(name), 'index.mjs')).href);
  for (const t of mod.tools) packHandlers.set(t.name, t.handler);
  return mod.tools;
}
const packHandlers = new Map();
export const packHandlerFor = (name) => packHandlers.get(name);

// ---------------------------------------------------------------------------
// compilingApi(): the api every test of a tool folded in from pixinsight-pack-astro uses
// (the pack's astroApi idea). Every snippet the handler sends is compiled -- not run -- with
// vm.Script before the fake bridge replies, so a template that emits invalid JavaScript fails
// the test here instead of inside PixInsight (PJSR runs on V8).
//
//   replies    fake-bridge replies, in order (string = consoleOutput, object = raw reply)
//   stats      omitted: the real api.stats over the same fake bridge (its snippet is compiled
//              and consumes a reply). An object: every api.stats() call returns it. An array:
//              one element per call, the last repeating.
//   images     view ids api.listImages() reports as open (default none)
//   overrides  any other api member, passed to apiFrom
//
// -> { api, emitted, logs }: emitted = every snippet sent; logs = every api.log() line.
// ---------------------------------------------------------------------------
export function compilingApi({ replies = [], stats, images = [], overrides = {} } = {}) {
  const fb = createFakeBridge({ replies });
  const send = fb.ctx.pjsr;
  fb.ctx.pjsr = async (code) => {
    try {
      new vm.Script(code);
    } catch (e) {
      throw new Error(`emitted PJSR does not parse: ${e.message}\n${code}`);
    }
    return send(code);
  };
  fb.ctx.listImages = async () => images.map((id) => ({ id }));
  const logs = [];
  const queue = Array.isArray(stats) ? [...stats] : null;
  const canned = stats === undefined ? {} : { stats: async () => (queue ? (queue.length > 1 ? queue.shift() : queue[0]) : stats) };
  const api = apiFrom(fb.ctx, { log: (m) => logs.push(m), ...canned, ...overrides });
  return { api, emitted: fb.emitted, logs };
}
