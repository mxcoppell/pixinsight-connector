// ============================================================================
// MCP server: tools/list, tools/call dispatch, error mapping. Ported from
// v0-pipeline:agents/llm/mcp-interactive.mjs, generalized to one dispatch path for every
// tool (core, pack, or server-defined) instead of a hand-maintained OWN_TOOLS
// split — the server-defined tools are workspace_info, set_workspace,
// resume_bridge and list_packs (see assembleCatalog/serve below), and none
// takes view-shaped input, so the view-existence pre-check is a harmless no-op
// for all four.
//
// Preserved verbatim from the legacy server (see its own line references,
// noted below, for anyone diffing): the missingViews pre-check, the 10s
// progress-notification keepalive, PixInsight console-error promotion to
// isError, and the abort/crash message texts.
//
// createServer({ catalog, api, takeConsoleErrors? }) is intentionally generic:
// it knows nothing about how `api` was built or how the tool catalog was
// assembled. The real assembly -- resolving the platform, building a lazy
// PixInsight bridge, loading packs and merging the server-defined tools into
// the auto-discovered catalog -- lives in buildRuntimeApi()/assembleCatalog()/
// serve() below; serve() is what src/cli.mjs's `serve` command calls.
// ============================================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBridge as realCreateBridge, BridgeAbortError, BridgeCrashError } from './bridge.mjs';
import { createProcessProbe } from './process-probe.mjs';
import { resolvePlatform, PlatformError } from './platform.mjs';
import { createWorkspace, workspacePaths, isInside, WorkspaceError, WORKSPACE_FIX } from './workspace.mjs';
import { machineId as realMachineId } from './machine-id.mjs';
import { createCallLog, NO_CALL_LOG } from './call-log.mjs';
import { materializeWatcher as realMaterializeWatcher, spaceInPathNote } from './runtime.mjs';
import { buildCoreCatalog } from './tools/index.mjs';
import { buildApi } from './api.mjs';
import { loadPacks, mergeCatalogs } from './packs.mjs';

// Real filesystem primitives for materializeWatcher (src/runtime.mjs), adapted to the shape it
// expects (readFile returning a string, not a Buffer; mkdir recursive so a fresh version
// directory doesn't need its parent to already exist; stat swallowing ENOENT to null rather than
// throwing). Kept separate from the injectable-fake versions test/helpers.mjs's fakeFs() provides
// -- those are for runtime.test.mjs; this is the real production wiring buildRuntimeApi() uses.
const realFs = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, data) => fsp.writeFile(p, data, 'utf8'),
  mkdir: (p) => fsp.mkdir(p, { recursive: true }),
  rename: (from, to) => fsp.rename(from, to),
  stat: (p) => fsp.stat(p).catch(() => null),
};

const KEEPALIVE_MS = 10_000;

// The PixInsight console errors of the tool call in progress. Each call's handler runs inside its
// own store, and buildRuntimeApi()'s pjsr appends that pjsr result's consoleErrors to it, so
// concurrent calls never see (or drain) each other's lines.
const callConsole = new AsyncLocalStorage();

// Arguments that name an existing view, checked up front for every tool (core and pack) so a
// mistyped id is refused with the list of open views instead of failing inside PixInsight. Only
// names core tools actually use as "an open view" (a test holds this list to that; rgb_id through
// pre_star_id are the inputs of the tools folded in from pixinsight-pack-astro), documented for
// pack authors in CONTRIBUTING.md ("Arguments the server checks"): any other name, e.g. one a pack
// uses for a view it creates, is left alone.
const VIEW_ARGS = ['view_id', 'target_id', 'source_id', 'reference_id', 'r_view_id', 'g_view_id', 'b_view_id', 'size_from', 'old_id',
  'rgb_id', 'l_id', 'ha_id', 'oiii_id', 'stars_id', 'pre_star_id'];
// mask_id is an input for these tools but the name to create for mask-making tools.
const MASK_INPUT_TOOLS = new Set(['apply_mask', 'shell_detail_enhance']);

// legacy mcp-interactive.mjs:268-274, verbatim logic.
async function missingViews(api, args, tool) {
  const wanted = [...VIEW_ARGS, ...(MASK_INPUT_TOOLS.has(tool) ? ['mask_id'] : [])].filter((k) => typeof args[k] === 'string' && args[k]);
  if (!wanted.length) return null;
  const open = (await api.listImages()).map((i) => i.id);
  const missing = wanted.filter((k) => !open.includes(args[k])).map((k) => `${k}="${args[k]}"`);
  return missing.length ? `View not found: ${missing.join(', ')}. Open views: ${open.join(', ') || '(none)'}.` : null;
}

// legacy mcp-interactive.mjs:276.
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// Pause/Abort pressed while a command ran (the watcher's MCP_ABORTED), whether the tool threw it or
// returned it inside an error result.
const stoppedByUser = () => text('STOPPED BY USER: Pause/Abort interrupted the running command. Do not retry. Tell the user and wait.', true);

// The handler result contract (Pack API v1): a handler returns `{ text }`, a bare string, or an
// array of those. Any item may also carry `isError: true` to report a failure without throwing
// (a refusal, a precondition that was not met, an operation that did not apply); the whole result
// is then an MCP error result. Absent or any other value means success, so older handlers are
// unaffected. Adapted from legacy mcp-interactive.mjs:278-286, which kept only the text.
function normalize(result) {
  const items = Array.isArray(result) ? result : [result];
  const out = {
    content: items.map((r) => {
      if (r?.type === 'image') return { type: 'text', text: '[Image saved to disk; read the preview file path above to view it]' };
      return { type: 'text', text: r?.text ?? String(r) };
    }),
  };
  if (items.some((r) => r?.isError === true)) out.isError = true;
  return out;
}

// Arguments the tool's inputSchema lists as `required` but the call left out. null and '' count as
// missing: neither can name a view, a file or a value, and letting them through only moves the
// failure into PixInsight with a less useful message ("View not found: undefined").
function missingRequired(definition, args) {
  const required = Array.isArray(definition?.inputSchema?.required) ? definition.inputSchema.required : [];
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

// Arguments a tool whose inputSchema sets `additionalProperties: false` does not list. Such a tool
// takes only what its schema names, so an unlisted argument (a renamed or removed input, a typo) is
// refused instead of being dropped without a word. A schema without it accepts any extra argument.
function unknownArguments(definition, args) {
  const schema = definition?.inputSchema;
  if (schema?.additionalProperties !== false) return [];
  const known = new Set(Object.keys(schema.properties ?? {}));
  return Object.keys(args).filter((k) => !known.has(k));
}

// Console lines PixInsight prints that are known not to mean the tool failed, per tool. They are
// still reported in the result; they just never promote it to an error, and only when the tool's
// own result is not already an error. Facts about PixInsight, not processing advice:
// - run_plate_solve: ImageSolver touches the stock Gaia process while it configures the local
//   XPSD server the tool actually solves against, and on a machine with no Gaia database files
//   selected for that process PixInsight prints this line although the solve succeeds.
const BENIGN_CONSOLE_ERRORS = {
  run_plate_solve: [/^\*{3}\s*Error:\s*No database files have been selected/i],
};

// The instructions' workspace sentence: the workspace and the two folders session output goes to (the
// state dir is scratchDir's parent, src/workspace.mjs's workspacePaths). run_pjsr code is not
// policed, so the folders are stated here. Reading api.workspace while the workspace is unusable
// throws its WorkspaceError, whose message (why, and the fix) is then the sentence.
function workspaceSentence(api) {
  try {
    const { dir, scratchDir, outputDir } = api.workspace;
    return `The workspace is ${dir} (set_workspace changes it). Session files go under two folders: ` +
      `${path.dirname(scratchDir)} (the connector's working files: scratch files and previews under ${scratchDir}, the bridge, logs) ` +
      `and ${outputDir} (results; export_image writes only under these two). `;
  } catch (e) {
    if (e?.name !== 'WorkspaceError') throw e;
    return `${e.message} `;
  }
}

// createServer({ catalog, api, takeConsoleErrors, callLog }) -> Server
//
// Call log: every tools/call is logged through `callLog` (src/call-log.mjs): call_start before
// anything runs (or, before any call has used the workspace, once this call does), the bridge records of everything the call does (the view pre-check included) on its
// seq, and call_end with exactly the result returned (and a thrown error, before it was mapped).
// Without one, nothing is logged.
//
// Console errors: the api built by buildRuntimeApi() reports each pjsr result's console errors to
// the call that made it (see callConsole). `takeConsoleErrors`, optional, is an extra source for an
// api built some other way (the tests' fakes); it is read once, after the handler.
//
// `catalog` is `{ definitions, handlers }` (see src/define.mjs's catalogFrom / src/packs.mjs's
// mergeCatalogs), already merged with any server-defined tools by the caller. `api` is the Pack
// API v1 object every handler receives -- core, pack, or server-defined -- built by exactly one
// src/api.mjs buildApi() call (see buildRuntimeApi() below); it carries no dispatch-internal
// fields.
export function createServer({ catalog, api, takeConsoleErrors, callLog = NO_CALL_LOG }) {
  const { definitions, handlers } = catalog;
  const definitionsByName = new Map(definitions.map((d) => [d.name, d]));
  const getConsoleErrors = takeConsoleErrors ?? (() => []);

  const server = new Server(
    { name: 'pixinsight', version: api.connectorVersion },
    {
      capabilities: { tools: {} },
      instructions:
        'PixInsight tools. ' +
        workspaceSentence(api) +
        'View previews by reading the JPEG path that save_preview returns. ' +
        'PixInsight is launched on demand and is locked while a command runs. ' +
        'If a call reports that the user stopped PixInsight (Pause/Abort), stop, tell the user, and only call resume_bridge when they say to continue.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
  }));

  // legacy mcp-interactive.mjs:288-337, verbatim logic (the isOwn/getStore/getBrief branching is
  // gone: every handler now takes the same (api, input) shape, core, pack or server-defined).
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const call = callLog.startCall(request.params.name, request.params.arguments);
    const thrown = { error: undefined };
    let result;
    try {
      result = await callLog.run(call, () => dispatch(request, extra, thrown));
      return result;
    } finally {
      callLog.endCall(call, result, thrown.error);
    }
  });

  // `thrown.error` is set to an error the tool threw, which is then mapped to an error result.
  async function dispatch(request, extra, thrown) {
    const { name, arguments: args = {} } = request.params;
    const handler = handlers.get(name);
    if (!handler) return text(`Unknown tool: ${name}`, true);

    // Hosts such as OpenCode drop a call after ~60s of silence; progress notifications keep it open.
    const token = request.params._meta?.progressToken;
    let ticks = 0;
    const keepalive = token === undefined ? null : setInterval(() => {
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: `${name} running` } }).catch(() => {});
    }, KEEPALIVE_MS);

    try {
      const unknown = unknownArguments(definitionsByName.get(name), args);
      if (unknown.length) {
        const accepted = Object.keys(definitionsByName.get(name).inputSchema.properties ?? {});
        return text(
          `${name}: unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
            `Accepted: ${accepted.join(', ') || '(none)'}.`,
          true
        );
      }

      const absent = missingRequired(definitionsByName.get(name), args);
      if (absent.length) {
        const required = definitionsByName.get(name).inputSchema.required;
        return text(
          `${name}: missing required argument${absent.length > 1 ? 's' : ''}: ${absent.join(', ')}. ` +
            `Required: ${required.join(', ')}. Received: ${Object.keys(args).join(', ') || '(none)'}.`,
          true
        );
      }

      const missing = await missingViews(api, args, name);
      if (missing) return text(missing, true);

      const callErrors = [];
      const out = normalize(await callConsole.run(callErrors, () => handler(api, args)));
      // A tool that reported its failure as a result rather than throwing still reports a
      // Pause/Abort the same way every other tool does, so the agent stops instead of retrying.
      if (out.isError && out.content.some((c) => /MCP_ABORTED/.test(c.text))) return stoppedByUser();
      // A process that declines to run (executeOn returns false) reports why only in the Process Console.
      const consoleErrors = [...callErrors, ...getConsoleErrors()];
      if (consoleErrors.length) {
        const unique = [...new Set(consoleErrors)];
        out.content.push({ type: 'text', text: `[PixInsight console reported: ${unique.join(' ; ')}]` });
        const benign = out.isError ? [] : BENIGN_CONSOLE_ERRORS[name] ?? [];
        const counted = unique.filter((l) => !benign.some((re) => re.test(l)));
        if (counted.some((l) => /^\*{3}\s*Error/i.test(l))) {
          out.content.unshift({ type: 'text', text: 'PIXINSIGHT REPORTED AN ERROR while running this tool, so the operation may not have been applied (details at the end of this result).' });
          out.isError = true;
        }
      }
      return out;
    } catch (e) {
      thrown.error = e;
      if (e instanceof BridgeAbortError || e?.name === 'BridgeAbortError') {
        return text('STOPPED BY USER: Pause/Abort was pressed in PixInsight. Do not retry or continue the plan. Tell the user, and call resume_bridge only after they tell you to continue.', true);
      }
      if (e instanceof BridgeCrashError || e?.name === 'BridgeCrashError') {
        // Surface what the bridge actually says (e.g. bridge.mjs's ensureWatcher()), not a
        // hardcoded "ask the user to start PixInsight themselves" string -- stale now that
        // PixInsight is started on demand (see src/runtime.mjs's ensurePixInsight).
        return text(e.message, true);
      }
      // PixInsight not found, or no usable workspace: the message already says why and what fixes it.
      if (e instanceof PlatformError || e?.name === 'PlatformError' || e?.name === 'WorkspaceError') {
        return text(e.message, true);
      }
      if (/MCP_ABORTED/.test(String(e?.message))) return stoppedByUser();
      api.log(`tool error (${name}): ${e?.message}`);
      return text(`Error: ${e?.message ?? e}`, true);
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
  }

  return server;
}

function readConnectorVersion() {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

// buildRuntimeApi({ platform, platformError?, probe, workspace, log, connectorVersion, callLog?, deps? })
//   -> { api, resetBridge, machineId }
//
// Builds the Pack API v1 object via exactly one src/api.mjs buildApi() call, so core tools, pack
// tools and resume_bridge/list_packs all receive the identical object. buildApi() expects a
// resolved `ctx` (createBridge()'s return shape), but the real PixInsight bridge must stay lazy:
// nothing may construct it -- a real filesystem write, via createBridge()'s stale-results cleanup,
// on top of materializeWatcher()'s read+write -- before a genuine tool call needs it. So this
// function builds a small lazy-ctx adapter shaped like createBridge()'s return value (pjsr,
// listImages, log) whose methods reach the bridge through getBridge(). Constructing the adapter,
// and the buildApi() call that wraps it, does zero I/O.
//
// `resetBridge` is exposed for resume_bridge's server-defined descriptor (see resumeBridgeTool()
// below) to close over directly; it is deliberately NOT part of the api object handed to tool
// handlers. `deps` (materializeWatcher, createBridge, machineId) is injectable for tests.
//
// `workspace` is a src/workspace.mjs workspace (serve() passes one) or, in tests, a plain
// { dir, scratchDir }. With a workspace object, the bridge is part of the workspace: while the
// workspace is unusable, every call that needs the bridge fails with its WorkspaceError, and no
// bridge is built.
//
// Everything the bridge writes is in the workspace, in this machine's subdir of its bridge dir,
// `<state>/bridge/<machine-id>` (src/machine-id.mjs): commands, results, quarantine, and the state of
// the one watcher serving it (heartbeat, last-stop, launch lock, linger tickets). That watcher's
// script is written into the workspace too, `<state>/watcher/<version>/<machine-id>/watcher.js`, with
// the bridge dir baked in (src/runtime.mjs materializeWatcher), before each launch. Nothing is
// written outside the workspace. When the workspace changes, a built bridge is re-pointed at the new
// dir and its watcher (commands already sent finish in the old one); an unbuilt one is left alone
// and is built over whatever the workspace is at its first use.
//
// `callLog` (src/call-log.mjs) receives every bridge command and bridge event (createBridge's trace)
// and a `bridge reset` event from resetBridge. `machineId()` is this machine's id (from its
// hostname) for the call log's session record and workspace_info, null if it cannot be had.
export function buildRuntimeApi({ platform, platformError = null, probe, workspace, log, connectorVersion, callLog = NO_CALL_LOG, deps = {} }) {
  const materializeWatcher = deps.materializeWatcher ?? realMaterializeWatcher;
  const createBridge = deps.createBridge ?? realCreateBridge;
  // This machine's subdir of the workspace bridge dir: a workspace on network storage may be used
  // from two machines at once, and each machine's watcher must see only its own machine's commands.
  const resolveMachineId = deps.machineId ?? (() => realMachineId());
  // Every use of the workspace by a tool -- api.workspace's getters, the bridge -- goes through
  // require(), so this is where the call log learns that the running call uses the workspace
  // (callLog.touch()): a call's log goes where the workspace is when it first does, with no list of
  // tools to keep. The server's own reads (instructions, workspace_info, set_workspace) use `workspace`.
  const used = typeof workspace?.require === 'function'
    ? Object.freeze({ ...workspace, require: () => { callLog.touch(); return workspace.require(); } })
    : workspace;
  let machineIdCache = null;
  const machineSubdir = (bridgeDir) => path.join(bridgeDir, machineIdCache ??= resolveMachineId());
  const bridgeDirNow = () => machineSubdir((used.require ? used.require() : workspacePaths(used.dir)).bridgeDir);
  // The promise, not the bridge, is cached: two concurrent first calls await the same
  // construction instead of each building (and one discarding) a bridge. A failed construction is
  // forgotten, so the next call tries again, but only while it is still the cached one: a
  // construction that resetBridge() already replaced must not drop its successor when it fails.
  let bridgePromise = null;
  function getBridge() {
    // PixInsight was not found at startup (see resolveServePlatform): every tool that needs it
    // fails with that reason, while the rest of the server keeps working.
    if (platformError) return Promise.reject(platformError);
    try {
      used.require?.();
    } catch (e) {
      return Promise.reject(e);
    }
    if (!bridgePromise) {
      const p = (async () => createBridge({ platform, probe, watcherFor, log, bridgeDir: bridgeDirNow(), trace: (t) => callLog.bridge(t) }))();
      bridgePromise = p;
      p.catch(() => { if (bridgePromise === p) bridgePromise = null; });
    }
    return bridgePromise;
  }
  // The watcher script serving a bridge dir, written into that workspace before each launch (reused
  // when unchanged). Each distinct warning is logged once.
  const warned = new Set();
  async function watcherFor(bridgeDir) {
    const { path: watcherPath, warnings } = await materializeWatcher({ platform, version: connectorVersion, bridgeDir, ...realFs });
    for (const w of warnings) {
      if (!warned.has(w)) { warned.add(w); log(`watcher: ${w}`); }
    }
    return watcherPath;
  }
  function resetBridge() {
    bridgePromise = null; // a fresh bridge only honors abort requests made after this point
    callLog.event('bridge reset');
  }
  // Subscribing does no I/O; the listener only re-points a bridge that already exists.
  workspace.onChange?.(async ({ current }) => {
    const p = bridgePromise;
    if (!p) return;
    const bridge = await p.catch(() => null);
    if (bridge?.setBridgeDir) bridge.setBridgeDir(machineSubdir(current.bridgeDir));
  });

  // A write into the workspace refused for permissions is an unusable workspace the up-front check
  // could not see (on Windows, fs.accessSync ignores ACLs): it is reported as one, with the fix.
  const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);
  function asWorkspaceError(e) {
    if (!DENIED.has(e?.code) || typeof e.path !== 'string' || !workspace.snapshot) return e;
    const { dir } = workspace.snapshot();
    if (!isInside(e.path, dir)) return e;
    return new WorkspaceError(`The workspace "${dir}" cannot be written (${e.code} on ${e.path}). To fix it, ${WORKSPACE_FIX}.`);
  }
  const viaBridge = async (fn) => {
    try {
      return await fn(await getBridge());
    } catch (e) {
      throw asWorkspaceError(e);
    }
  };

  // The lazy-ctx adapter: shaped like createBridge()'s real return value, but every method goes
  // through getBridge() first, so nothing is built before a tool call needs PixInsight. pjsr also
  // hands the result's console errors to the tool call in progress (callConsole above).
  const lazyCtx = {
    pjsr: async (code) => {
      const r = await viaBridge((b) => b.pjsr(code));
      const lines = r?.outputs?.consoleErrors;
      if (Array.isArray(lines) && lines.length) callConsole.getStore()?.push(...lines);
      return r;
    },
    listImages: async () => viaBridge((b) => b.listImages()),
    log,
  };

  // An unresolved install has no paths to report; `error` says why, for pixinsight_info.
  const apiPlatform = platformError ? { error: platformError.message } : platform;
  const api = buildApi({ ctx: lazyCtx, platform: apiPlatform, workspace: used, log, version: connectorVersion });

  // From the hostname, resolved when first asked, then kept.
  const machineId = () => {
    try { return (machineIdCache ??= resolveMachineId()); } catch { return null; }
  };
  return { api, resetBridge, machineId };
}

// resume_bridge: server-lifecycle behavior, not a PixInsight capability, so it is defined here
// rather than as a src/tools/*.mjs module -- it needs closure access to this server's own lazy
// bridge instance (via `resetBridge`), not the generic api abstraction every other tool goes
// through. Same descriptor shape as every other tool, so it appears in tools/list identically.
// Exported so tests can exercise the merge createServer's caller performs without going through
// the real serve() assembly (real platform/bridge resolution).
// legacy mcp-interactive.mjs:200-204,234-237.
export function resumeBridgeTool(resetBridge) {
  return {
    name: 'resume_bridge',
    description: 'Allow PixInsight commands again after the user pressed Pause/Abort. Call ONLY when the user explicitly tells you to continue.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_api, _input) {
      resetBridge();
      return { text: 'Bridge reset. The next PixInsight command may launch the watcher again.' };
    },
  };
}

// list_packs: reports the packs loaded (or skipped, with why) at server startup, and which core
// tools they shadowed. Server-defined for the same reason resume_bridge is: it needs closure access
// to server-owned state (loadPacks()'s `packs`, mergeCatalogs()'s `shadowed`) rather than the
// generic api abstraction. `getShadowed` is a getter because list_packs is itself part of the
// catalog being merged, so `shadowed` is only known after its descriptor exists. Read-only, and
// reserved (src/packs.mjs's RESERVED_TOOLS) so a pack can never redefine it to hide its own load
// failure.
export function listPacksTool(packs, getShadowed = () => []) {
  return {
    name: 'list_packs',
    description: 'List the runtime tool packs discovered at server startup, with load status, tool counts, why any pack was skipped, and which core tools packs replaced. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_api, _input) {
      return { text: JSON.stringify({ packs, shadowed: getShadowed() }, null, 2) };
    },
  };
}

// workspace_info: the workspace, where it came from (set_workspace, PIXINSIGHT_CONNECTOR_WORKSPACE or the
// launch folder), the state dirs under it and, when it cannot be used, why. Server-defined: the
// Pack API's api.workspace is only { dir, scratchDir, outputDir }, and reading it while the workspace is
// unusable throws, which is right for every other tool but not for the one that reports the state.
// An unusable workspace is reported, not failed: the call itself succeeded.
// `log` is the call log's state (src/call-log.mjs status()): on (and its file), off
// (PIXINSIGHT_CONNECTOR_LOG=0), skipped (no usable workspace) or failed (and why).
// `machineBridgeDir` is where this machine's commands and watcher state go: `<bridgeDir>/<machine-id>`.
// `note` (only off macOS, for a state path with a space): the watcher script is launched from there,
// which is verified on macOS only (src/runtime.mjs spaceInPathNote).
function workspaceInfoText(workspace, callLog, machineId, osPlatform) {
  const s = workspace.snapshot();
  const id = s.usable ? machineId() : null;
  const info = s.usable
    ? { workspace: s.dir, source: s.source, usable: true, stateDir: s.stateDir, scratchDir: s.scratchDir, bridgeDir: s.bridgeDir,
      ...(id ? { machineBridgeDir: path.join(s.bridgeDir, id) } : {}), logsDir: s.logsDir, outputDir: s.outputDir }
    : { workspace: s.dir, source: s.source, usable: false, reason: s.reason, fix: WORKSPACE_FIX };
  const note = s.usable && osPlatform ? spaceInPathNote(osPlatform, s.stateDir) : null;
  if (note) info.note = note;
  info.log = callLog.status();
  return JSON.stringify(info, null, 2);
}

export function workspaceInfoTool(workspace, callLog = NO_CALL_LOG, machineId = () => null, osPlatform = null) {
  return {
    name: 'workspace_info',
    description:
      'Report the workspace folder, the state directories under it (scratch, bridge, logs) and the output folder. ' +
      'Also reports where the folder came from (set_workspace, PIXINSIGHT_CONNECTOR_WORKSPACE or the launch folder) and, ' +
      'when it cannot be used, why. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_api, _input) {
      return { text: workspaceInfoText(workspace, callLog, machineId, osPlatform) };
    },
  };
}

// set_workspace: switches the session's workspace at runtime (the highest-precedence source). The
// workspace's onChange hooks run before this returns; one that fails is reported after the new
// workspace_info, and the switch stands.
export function setWorkspaceTool(workspace, callLog = NO_CALL_LOG, machineId = () => null, osPlatform = null) {
  return {
    name: 'set_workspace',
    description:
      "Set the workspace folder this session's files go under (scratch files, the bridge, call logs). " +
      '`path` must name an existing, writable folder, absolute or starting with ~/, other than the filesystem root ' +
      'or the home directory itself. Returns the new workspace_info.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The folder: an absolute path, or one starting with ~/.' } },
      required: ['path'],
    },
    async handler(_api, input) {
      let warnings;
      try {
        ({ warnings } = await workspace.set(input.path));
      } catch (e) {
        if (e?.name === 'WorkspaceError') return { isError: true, text: e.message };
        throw e;
      }
      return [{ text: workspaceInfoText(workspace, callLog, machineId, osPlatform) }, ...warnings.map((w) => ({ text: `Warning: ${w}` }))];
    },
  };
}

// assembleCatalog({ core, packs, packTools, resetBridge, workspace, callLog?, machineId?, osPlatform?, log }) -> { definitions, handlers, shadowed }
//
// The one composition of the served catalog: the auto-discovered core catalog, plus the
// server-defined tools (workspace_info, set_workspace, resume_bridge, list_packs), with loaded pack
// tools merged over it by
// src/packs.mjs's mergeCatalogs() (packs may shadow core tools, never reserved ones). serve() and
// the server integration tests both call this, so the tests exercise the real composition.
export function assembleCatalog({ core, packs, packTools, resetBridge, workspace, callLog = NO_CALL_LOG, machineId = () => null, osPlatform = null, log = () => {} }) {
  let shadowed = [];
  const serverTools = [
    workspaceInfoTool(workspace, callLog, machineId, osPlatform),
    setWorkspaceTool(workspace, callLog, machineId, osPlatform),
    resumeBridgeTool(resetBridge),
    listPacksTool(packs, () => shadowed),
  ];
  const withServerTools = {
    definitions: [
      ...core.definitions,
      ...serverTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ],
    handlers: new Map([...core.handlers, ...serverTools.map((t) => [t.name, t.handler])]),
  };
  const catalog = mergeCatalogs({ core: withServerTools, packTools, log });
  shadowed = catalog.shadowed;
  return catalog;
}

// resolveServePlatform({ env, platform, existsSync, homeDir }) -> { platform, platformError }
//
// resolvePlatform(), but a PlatformError (PixInsight not at the default path, no override set, or an
// unsupported OS) is held instead of thrown: the server must still start, list its tools and run
// the ones that never touch PixInsight, and say why the others cannot run. Any other error is a
// bug and propagates.
export function resolveServePlatform({ env, platform, existsSync, homeDir }) {
  try {
    return { platform: resolvePlatform({ env, platform, existsSync, homeDir }), platformError: null };
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
    return { platform: null, platformError: e };
  }
}

// serve() — the real assembly: resolves the platform, builds a lazy PixInsight bridge and the one
// Pack API v1 object every handler receives, loads any configured packs, merges resume_bridge/
// list_packs + the pack catalog into the auto-discovered core catalog, and connects the MCP
// server over stdio. This is what src/cli.mjs's `serve` command calls.
export async function serve() {
  const log = (m) => process.stderr.write(`[pixinsight-connector] ${m}\n`);

  const { platform, platformError } = resolveServePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() });
  if (platformError) log(`${platformError.message} Starting anyway; tools that need PixInsight will report this.`);
  const probe = createProcessProbe();
  const workspace = createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform, log });
  const initial = workspace.snapshot();
  if (!initial.usable) log(`No usable workspace: "${initial.dir}" ${initial.reason}. Starting anyway; tools that need it will say so.`);
  const connectorVersion = readConnectorVersion();

  // The call log opens its file on the first tool call; until then it holds the start-up events.
  // Its session record is read when that file opens, by which time the packs below are loaded.
  let runtime = null;
  let loadedPacks = [];
  const callLog = createCallLog({
    workspace,
    env: process.env,
    log,
    sessionInfo: () => ({
      connectorVersion,
      node: process.version,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      machineId: runtime?.machineId() ?? null,
      packs: loadedPacks.filter((p) => p.status === 'loaded').map((p) => `${p.name}@${p.version}`),
    }),
  });
  if (platformError) callLog.startupEvent('platform error', { message: platformError.message });
  if (!initial.usable) callLog.startupEvent('workspace unusable', { workspace: initial.dir, reason: initial.reason });

  runtime = buildRuntimeApi({
    platform,
    platformError,
    probe,
    workspace,
    log,
    connectorVersion,
    callLog,
  });
  const { api, resetBridge, machineId } = runtime;

  // Reading pack modules (readdir + dynamic import) here is real disk I/O, but it is READ-ONLY and
  // happens once, before server.connect() below even starts accepting requests -- never a write,
  // never a PixInsight launch. See AGENTS.md: this is a deliberate, required exception to "nothing
  // touches disk during initialize/tools/list", not a bug to "fix" by making it lazy.
  const [core, { packs, tools: packTools }] = await Promise.all([
    buildCoreCatalog(),
    loadPacks({ env: process.env, homeDir: os.homedir(), log }),
  ]);
  loadedPacks = packs;

  const catalog = assembleCatalog({ core, packs, packTools, resetBridge, workspace, callLog, machineId, osPlatform: process.platform, log });

  const server = createServer({ catalog, api, callLog });
  await server.connect(new StdioServerTransport());

  exitOnStop({ proc: process, stdin: process.stdin });
  return server;
}

// exitOnStop({ proc, stdin }): how a harness stops this server -- closing its stdin, or sending
// SIGTERM, SIGINT or SIGHUP -- becomes proc.exit(), so the process 'exit' hooks run (queued commands
// are dropped and the call log's exit event written, src/process-probe.mjs onProcessExit). Signals
// exit with the conventional 128 + signal number. SIGKILL or a crash skips the hooks; the next send
// into that workspace quarantines the dead sender's queued commands. `proc` and `stdin` are injectable so tests install no real signal handler.
const STOP_SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
export function exitOnStop({ proc, stdin }) {
  stdin.on('end', () => proc.exit(0));
  stdin.on('error', () => proc.exit(0));
  for (const [sig, n] of Object.entries(STOP_SIGNALS)) proc.once(sig, () => proc.exit(128 + n));
}
