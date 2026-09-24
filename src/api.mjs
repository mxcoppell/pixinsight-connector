// ============================================================================
// The Pack API v1 object, built once. buildApi() is the ONLY constructor for
// the object every tool handler receives -- core tools and pack tools alike.
// If a core tool and a pack ever received differently-shaped objects, a pack
// that works today could become a core tool that silently doesn't tomorrow.
//
// Consumes createBridge()'s ctx (src/bridge.mjs, Task 3) and resolvePlatform()'s
// platform (src/platform.mjs, Task 2), both passed in already built -- this
// file does not construct either.
// ============================================================================
import { runProcess } from './tools/execute.mjs';

// Pack API v1 documented surface, exactly:
//   pjsr, runProcess, stats, listImages, workspace, platform, log, connectorVersion

const q = (s) => JSON.stringify(String(s));

// stats(viewId) -> { median, mad, min, max, perChannel? } via PJSR; throws when PixInsight reports
// an error. The one statistics implementation: core tools read statistics through api.stats too.
async function stats(api, viewId) {
  const r = await api.pjsr(`
    var v = ImageWindow.windowById(${q(viewId)}).mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [];
      for (var c = 0; c < img.numberOfChannels; c++) { img.selectedChannel = c; meds.push(img.median()); mads.push(img.MAD()); }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
      result.perChannel = { R: { median: meds[0], mad: mads[0] }, G: { median: meds[1], mad: mads[1] }, B: { median: meds[2], mad: mads[2] } };
    } else {
      result.median = img.median();
      result.mad = img.MAD();
    }
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

// The workspace can change during a session (set_workspace), but the api object is built once and
// frozen: so `api.workspace` is { dir, scratchDir, outputDir } (outputDir added in 1.1.0, additive,
// still Pack API v1) with getters that read the current workspace on every access. With a src/workspace.mjs workspace, a read while the workspace
// is unusable throws its WorkspaceError (the server returns its message, which names the fix), so
// any tool that needs the workspace fails the same way. A plain { dir, scratchDir, outputDir }
// object is read as is.
function liveWorkspace(workspace) {
  const current = () => (typeof workspace?.require === 'function' ? workspace.require() : workspace);
  return Object.freeze({
    get dir() { return current().dir; },
    get scratchDir() { return current().scratchDir; },
    get outputDir() { return current().outputDir; },
  });
}

// buildApi({ ctx, platform, workspace, log, version }) -> api
//
// `ctx` is createBridge()'s return value (send/pjsr/listImages/log); only pjsr
// and listImages are part of the documented v1 surface, so only
// those two are read from it here. The object and its `platform` are both frozen: every tool in the
// process shares this one object, so a pack reassigning `api.pjsr` or corrupting platform state
// must fail loudly and immediately (ESM is strict mode, so the assignment throws) rather than
// quietly poison every other tool call.
export function buildApi({ ctx, platform, workspace, log, version }) {
  const api = Object.freeze({
    pjsr: (code) => ctx.pjsr(code),
    runProcess: (name, params, viewId) => runProcess(api, name, params, viewId),
    stats: (viewId) => stats(api, viewId),
    listImages: () => ctx.listImages(),
    workspace: liveWorkspace(workspace),
    platform: Object.freeze({ ...platform }),
    log: (msg) => log(msg),
    connectorVersion: version,
  });
  return api;
}
