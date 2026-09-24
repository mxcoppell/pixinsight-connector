// ============================================================================
// Runtime tool pack loader: discovers and imports third-party "packs" — `tools`
// arrays that live outside src/tools/, loaded once at server startup (see
// AGENTS.md's "packs are read at startup, not lazily" note — that read is
// deliberate and required, not a Global Constraint violation).
//
// One bad pack, or one malformed tool inside an otherwise-good pack, must
// never take the others down with it: the user's astro session should
// degrade, not die. Every pack import and every individual tool descriptor is
// therefore validated and rejected independently.
// ============================================================================
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Pack API v1 is the only version this loader currently understands (see
// src/api.mjs's buildApi()). A pack declaring anything else is skipped, not
// coerced — a v2 pack expecting v2-only surface would silently misbehave
// against a v1 api object instead of failing loudly.
export const SUPPORTED_PACK_API = [1];

// Bridge and session control — a pack may replace any core PROCESSING tool it
// disagrees with (that's the whole point of packs), but never these five:
// they are the connector's own lifecycle/session surface, not a PixInsight
// process a pack author would have a legitimate opinion about.
export const RESERVED_TOOLS = new Set(['resume_bridge', 'run_pjsr', 'workspace_info', 'set_workspace', 'list_packs']);

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function expandTilde(spec, homeDir) {
  if (spec === '~') return homeDir;
  if (spec.startsWith('~/') || spec.startsWith('~\\')) return path.join(homeDir, spec.slice(2));
  return spec;
}

// isFilesystemSpec(spec, platform) -> boolean
//
// A PIXINSIGHT_CONNECTOR_PACKS entry names a filesystem path (a pack directory, or a .mjs/.js file) only
// if it is absolute for `platform`, starts with `.` (./x, ../x) or `~`, or — on win32 — is a drive
// (`C:\x`, `C:/x`) or UNC (`\\server\share`) path. Everything else, including `@scope/name` and
// `name/sub`, is a module specifier: containing a `/` does not make something a path. `platform`
// is injected so the win32 rules are testable from any host.
export function isFilesystemSpec(spec, platform = process.platform) {
  if (spec.startsWith('.') || spec.startsWith('~')) return true;
  if (platform === 'win32') return path.win32.isAbsolute(spec) || /^[A-Za-z]:/.test(spec);
  return path.posix.isAbsolute(spec);
}

// Resolve one spec to the file URL `import()` needs: a pack directory (its index.mjs) or a .mjs/.js
// file, resolved against `cwd` if relative. Only filesystem paths: a bare package name would need a
// node_modules folder to resolve from, and the connector keeps none outside the target folder, so
// it is refused with the fix (install the package anywhere and give the path to its folder). The
// result goes through pathToFileURL: a bare `import('C:\\...')` fails on Windows, where the drive
// letter parses as a URL scheme.
function toImportTarget(spec, { cwd, platform }) {
  if (!isFilesystemSpec(spec, platform)) {
    throw new Error(`"${spec}" is not a path. PIXINSIGHT_CONNECTOR_PACKS takes pack folders and .mjs files; ` +
      `for an npm package, install it (for example npm install --prefix <folder> ${spec}) and give the path to its folder ` +
      `(<folder>/node_modules/${spec}).`);
  }
  const abs = path.resolve(cwd, spec);
  const file = /\.m?js$/.test(abs) ? abs : path.join(abs, 'index.mjs');
  return pathToFileURL(file).href;
}

// PIXINSIGHT_CONNECTOR_PACKS: comma-separated pack folders and .mjs files (`~` expanded). Unset or empty:
// no packs. There is no default folder: packs are entirely optional, and nothing is read from a
// per-user connector folder.
function discoverSpecs({ env, homeDir }) {
  const raw = env?.PIXINSIGHT_CONNECTOR_PACKS;
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => expandTilde(s, homeDir));
}

// The same descriptor contract test/contract.test.mjs enforces on the core
// catalog (name shape, a real description, an object-typed schema), minus the
// handler-arity check — a pack handler is free to declare `(api, input)`,
// `(api)`, or no parameters at all; JS doesn't enforce arity at the call site
// either way, so it isn't part of what makes a descriptor well-formed.
function validateTool(t) {
  const problems = [];
  if (typeof t?.name !== 'string' || !NAME_RE.test(t.name)) {
    problems.push(`invalid tool name ${JSON.stringify(t?.name)} (must be snake_case)`);
  }
  if (typeof t?.description !== 'string' || t.description.length <= 20) {
    problems.push(`tool "${t?.name}" needs a real description (>20 characters)`);
  }
  if (!t?.inputSchema || t.inputSchema.type !== 'object') {
    problems.push(`tool "${t?.name}" inputSchema.type must be "object"`);
  }
  if (typeof t?.handler !== 'function') {
    problems.push(`tool "${t?.name}" handler must be a function`);
  }
  return problems;
}

// loadPacks({ env, homeDir, log, importer, packSpecs, cwd, platform }) -> Promise<{ packs, tools }>
//
// PackInfo = { name, version, apiVersion, source, toolCount, status: 'loaded'|'skipped', reason? }.
// `name`/`version` are whatever the pack declared (undefined if it didn't, or failed to import);
// `source` is always set, so a display name is `name ?? source`.
//
// A pack is skipped (never partially trusted) when it fails to import, declares an unsupported
// apiVersion, or exports no `tools` array with at least one valid tool. Individual malformed
// tools inside an otherwise-good pack are dropped one by one. When two packs provide the same tool
// name, the later pack (discovery order) wins and the collision is logged.
//
// Injection seams, all defaulting to the real thing: `packSpecs` replaces discovery; `importer`
// replaces resolution + import() entirely and receives the raw spec (so a test can hand back a
// synthetic module without touching the module loader); `homeDir` expands `~`; `cwd` anchors
// relative paths; `platform` picks the path rules isFilesystemSpec uses.
export async function loadPacks({
  env = {}, homeDir = os.homedir(), log = () => {}, importer, packSpecs,
  cwd = process.cwd(), platform = process.platform,
} = {}) {
  const specs = packSpecs ?? discoverSpecs({ env, homeDir });
  const doImport = importer ?? ((target) => import(target));

  const packs = [];
  const byName = new Map(); // tool name -> { tool, pack display name }

  for (const spec of specs) {
    let mod;
    try {
      const target = importer ? spec : toImportTarget(spec, { cwd, platform });
      mod = await doImport(target);
    } catch (e) {
      const reason = e?.message || String(e);
      log(`[packs] failed to load pack at ${spec}: ${reason}`);
      packs.push({ name: undefined, version: undefined, apiVersion: undefined, source: spec, toolCount: 0, status: 'skipped', reason });
      continue;
    }

    const { name, version, apiVersion, tools: packToolsList } = mod;
    const display = name ?? spec;
    const skip = (reason) => {
      log(`[packs] skipping pack "${display}": ${reason}`);
      packs.push({ name, version, apiVersion, source: spec, toolCount: 0, status: 'skipped', reason });
    };

    if (!SUPPORTED_PACK_API.includes(apiVersion)) {
      skip(`apiVersion ${JSON.stringify(apiVersion)} is not supported (supported: ${SUPPORTED_PACK_API.join(', ')})`);
      continue;
    }
    if (!Array.isArray(packToolsList)) {
      skip('it does not export a `tools` array');
      continue;
    }

    const accepted = [];
    for (const t of packToolsList) {
      const problems = validateTool(t);
      if (problems.length) {
        log(`[packs] rejecting a tool from pack "${display}": ${problems.join('; ')}`);
        continue;
      }
      accepted.push(t);
    }
    if (accepted.length === 0) {
      skip(packToolsList.length ? 'none of its `tools` passed validation' : 'its `tools` array is empty');
      continue;
    }

    const missing = [name ? null : 'name', version ? null : 'version'].filter(Boolean);
    if (missing.length) log(`[packs] pack at ${spec} does not export ${missing.join(' or ')}; loading it anyway, shown as "${spec}".`);

    for (const t of accepted) {
      const prior = byName.get(t.name);
      if (prior) {
        log(`[packs] tool "${t.name}" is provided by both pack "${prior.pack}" and pack "${display}"; the later one, "${display}", wins.`);
        byName.delete(t.name); // re-insert so the winner takes the later position
      }
      byName.set(t.name, { tool: t, pack: display });
    }
    packs.push({ name, version, apiVersion, source: spec, toolCount: accepted.length, status: 'loaded' });
  }

  return { packs, tools: [...byName.values()].map((v) => v.tool) };
}

// mergeCatalogs({ core, packTools, log }) -> { definitions, handlers, shadowed }
//
// `core` is a { definitions, handlers } catalog (src/define.mjs's catalogFrom shape — the core
// catalog, already including any server-defined tools like resume_bridge/list_packs). `packTools`
// is a flat array of tool descriptors (loadPacks()'s `tools`, or any equivalent array).
//
// A pack tool whose name matches an EXISTING core definition replaces it (the pack wins) and is
// reported in `shadowed` — that's what lets a pack replace a core tool the user disagrees with. A
// pack tool named after a RESERVED_TOOLS entry is rejected outright, with a warning; the core tool
// (if any) survives completely untouched, since bridge/session control is never a pack's to give.
export function mergeCatalogs({ core, packTools, log = () => {} }) {
  const definitions = [...core.definitions];
  const defIndex = new Map(definitions.map((d, i) => [d.name, i]));
  const originalCoreNames = new Set(definitions.map((d) => d.name));
  const handlers = new Map(core.handlers);
  const shadowed = new Set();
  const fromPacks = new Set();

  for (const t of packTools) {
    if (RESERVED_TOOLS.has(t.name)) {
      log(`[packs] tool "${t.name}" is reserved and cannot be provided by a pack; the core tool survives.`);
      continue;
    }

    const descriptor = { name: t.name, description: t.description, inputSchema: t.inputSchema };
    if (fromPacks.has(t.name)) {
      log(`[packs] tool "${t.name}" is provided by more than one pack; the later one wins.`);
    } else if (originalCoreNames.has(t.name)) {
      log(`[packs] pack tool "${t.name}" shadows a core tool; using the pack's version.`);
    }
    if (originalCoreNames.has(t.name)) shadowed.add(t.name);
    fromPacks.add(t.name);

    if (defIndex.has(t.name)) {
      definitions[defIndex.get(t.name)] = descriptor;
    } else {
      defIndex.set(t.name, definitions.length);
      definitions.push(descriptor);
    }
    handlers.set(t.name, t.handler);
  }

  return { definitions, handlers, shadowed: [...shadowed] };
}
