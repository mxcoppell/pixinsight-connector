// ============================================================================
// JPEG preview export. Ported from v0-pipeline:agents/llm/tools.mjs's save_and_show_preview,
// renamed to save_preview (old name kept as an alias for existing callers). The
// legacy image-content-block helper is gone: the server already downgrades an
// image block to a text pointer, so this returns the file path as text.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { toPixPath } from '../platform.mjs';

const q = (s) => JSON.stringify(String(s));

// A process that ran is still reported as run when the follow-up statistics read fails (the stats
// are informational); only a user abort or a crash is passed on, for the server to report.
function statsOrEmpty(api, viewId) {
  return api.stats(viewId).catch((e) => {
    if (e?.isCrash || /MCP_ABORTED/.test(String(e?.message))) throw e;
    return {};
  });
}

const inputSchema = {
  type: 'object',
  properties: {
    view_id: { type: 'string', description: 'PixInsight view ID' },
    label: { type: 'string', description: 'Short label for this preview (e.g. "after_stretch", "final")' },
  },
  required: ['view_id', 'label'],
};

// input.label becomes a filename; reject anything that would let it escape previewDir
// (a path separator, "..", or an absolute path) instead of silently resolving through it.
function safeLabel(label) {
  const s = String(label);
  const base = path.basename(s);
  if (!s || base !== s || base === '.' || base === '..') {
    throw new Error(`save_preview: "label" must be a plain filename with no path separators, got ${JSON.stringify(label)}`);
  }
  return base;
}

async function handler(api, input) {
  const previewDir = path.join(api.workspace.scratchDir, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const previewPath = path.join(previewDir, `${safeLabel(input.label)}.jpg`);
  // Removed here, before PixInsight runs anything: if the snippet then fails early, an older JPEG
  // with the same label must not be left for the existence check below to report as this preview.
  fs.rmSync(previewPath, { force: true });

  const r = await api.pjsr(`
    var srcW = ImageWindow.windowById(${q(input.view_id)});
    if (srcW.isNull) throw new Error('View not found: ' + ${q(input.view_id)});
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var scale = Math.min(1, 2048 / Math.max(w, h));
    var nw = Math.round(w * scale), nh = Math.round(h * scale);
    var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'preview_show_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    if (scale < 1) {
      var R = new Resample;
      R.mode = Resample.RelativeDimensions;
      R.xSize = scale; R.ySize = scale;
      R.absoluteMode = Resample.ForceWidthAndHeight;
      R.interpolation = Resample.MitchellNetravaliFilter;
      R.executeOn(tmp.mainView);
    }
    var p = ${q(toPixPath(previewPath))};
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
  `);
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));

  const stats = await statsOrEmpty(api, input.view_id);
  const textSummary = `Preview saved: ${input.label}\nFile: ${previewPath}\nStats: median=${stats.median?.toFixed?.(6) ?? '?'}, MAD=${stats.mad?.toFixed?.(6) ?? '?'}, max=${(stats.max ?? 0).toFixed?.(4) ?? '?'}`;

  if (fs.existsSync(previewPath)) return { text: textSummary };
  return { isError: true, text: `${textSummary}\n(Preview file not created)` };
}

const savePreview = {
  name: 'save_preview',
  description: 'Save a JPEG preview of a view and return the file path.',
  inputSchema,
  handler,
};

// Alias for existing callers of the legacy tool name.
const saveAndShowPreview = {
  name: 'save_and_show_preview',
  description: 'Alias for save_preview. Save a JPEG preview of a view and return the file path.',
  inputSchema,
  handler,
};

export const tools = [savePreview, saveAndShowPreview];
