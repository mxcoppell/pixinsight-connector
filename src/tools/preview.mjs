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
    stf_from: { type: 'string', description: 'Bake this view\'s STF (its display stretch) into the JPEG; the view may be view_id itself. Several previews given the same stf_from are stretched identically' },
    stf_m: { type: 'number', description: 'Bake a linked STF with this midtones balance (0 < m < 1) into the JPEG; needs stf_c0' },
    stf_c0: { type: 'number', description: 'Shadows clipping point of the linked STF given with stf_m (0 <= c0 < 1)' },
    crop: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'Region [x0, y0, x1, y1] of the view in pixels (x1, y1 exclusive); the whole view when omitted' },
    downsample: { type: 'number', description: 'Divide width and height by this factor (>= 1). Omitted: the preview is scaled down to at most 2048 px on its longer side' },
  },
  required: ['view_id', 'label'],
};

// previewOptions(input) -> { stf: null | { from } | { m, c0 }, crop: null | [x0, y0, x1, y1], downsample: null | number }.
// Checked before anything reaches PixInsight.
export function previewOptions(input) {
  const given = (k) => input[k] !== undefined && input[k] !== null;
  let stf = null;
  if (given('stf_from') && (given('stf_m') || given('stf_c0'))) throw new Error('save_preview: give stf_from, or stf_m with stf_c0, not both');
  if (given('stf_from')) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(input.stf_from))) throw new Error(`save_preview: stf_from must be a view id, got ${JSON.stringify(input.stf_from)}`);
    stf = { from: String(input.stf_from) };
  } else if (given('stf_m') || given('stf_c0')) {
    const m = input.stf_m, c0 = input.stf_c0;
    if (!(typeof m === 'number' && m > 0 && m < 1)) throw new Error(`save_preview: stf_m must be a number in (0, 1), got ${JSON.stringify(m)}`);
    if (!(typeof c0 === 'number' && c0 >= 0 && c0 < 1)) throw new Error(`save_preview: stf_c0 must be a number in [0, 1), got ${JSON.stringify(c0)}`);
    stf = { m, c0 };
  }
  let crop = null;
  if (given('crop')) {
    const c = input.crop;
    if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => Number.isInteger(v) && v >= 0) || c[2] <= c[0] || c[3] <= c[1]) {
      throw new Error(`save_preview: crop must be [x0, y0, x1, y1], whole pixels with x1 > x0 and y1 > y0, got ${JSON.stringify(c)}`);
    }
    crop = c;
  }
  let downsample = null;
  if (given('downsample')) {
    if (!(typeof input.downsample === 'number' && Number.isFinite(input.downsample) && input.downsample >= 1)) throw new Error(`save_preview: downsample must be a number >= 1, got ${JSON.stringify(input.downsample)}`);
    downsample = input.downsample;
  }
  return { stf, crop, downsample };
}

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

  const opt = previewOptions(input);
  const stfRowsJs = !opt.stf ? 'null'
    : opt.stf.from ? `(function(){ var sw = ImageWindow.windowById(${q(opt.stf.from)}); if (sw.isNull) throw new Error('View not found: ' + ${q(opt.stf.from)}); return sw.mainView.stf; })()`
    : JSON.stringify([0, 1, 2].map(() => [opt.stf.m, opt.stf.c0, 1, 0, 1]));
  const r = await api.pjsr(`
    var srcW = ImageWindow.windowById(${q(input.view_id)});
    if (srcW.isNull) throw new Error('View not found: ' + ${q(input.view_id)});
    var img = srcW.mainView.image;
    var crop = ${JSON.stringify(opt.crop)};
    if (crop && (crop[2] > img.width || crop[3] > img.height)) throw new Error('crop ' + JSON.stringify(crop) + ' reaches outside the ' + img.width + 'x' + img.height + ' image');
    var stfRows = ${stfRowsJs};
    var w = crop ? crop[2] - crop[0] : img.width, h = crop ? crop[3] - crop[1] : img.height;
    var scale = ${opt.downsample ? `1 / ${opt.downsample}` : 'Math.min(1, 2048 / Math.max(w, h))'};
    var tmp = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, 'preview_show_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    if (crop) {
      var C = new Crop;
      C.mode = Crop.AbsolutePixels;
      C.leftMargin = -crop[0]; C.topMargin = -crop[1]; C.rightMargin = -(img.width - crop[2]); C.bottomMargin = -(img.height - crop[3]);
      if (C.noGUIMessages !== undefined) C.noGUIMessages = true;
      C.executeOn(tmp.mainView);
    }
    if (stfRows) {
      // An STF row is [m, c0, c1, r0, r1]; a HistogramTransformation row is [c0, m, c1, r0, r1].
      var ht = function (s) { return [s[1], s[0], s[2], s[3], s[4]]; }, id = [0, 0.5, 1, 0, 1];
      var HT = new HistogramTransformation;
      HT.H = img.isColor ? [ht(stfRows[0]), ht(stfRows[1]), ht(stfRows[2]), id, id] : [id, id, id, ht(stfRows[0]), id];
      HT.executeOn(tmp.mainView);
    }
    if (scale < 1) {
      var R = new Resample;
      R.mode = Resample.RelativeDimensions;
      R.xSize = scale; R.ySize = scale;
      R.absoluteMode = Resample.ForceWidthAndHeight;
      R.interpolation = Resample.MitchellNetravaliFilter;
      if (R.noGUIMessages !== undefined) R.noGUIMessages = true;
      R.executeOn(tmp.mainView);
    }
    var p = ${q(toPixPath(previewPath))};
    if (File.exists(p)) File.remove(p);
    var saved = tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    if (!saved) throw new Error('PixInsight did not write ' + p + ' (saveAs returned false)');
  `);
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));

  const stats = await statsOrEmpty(api, input.view_id);
  const how = [opt.crop ? `crop ${JSON.stringify(opt.crop)}` : null, opt.downsample ? `downsample ${opt.downsample}` : null,
    opt.stf ? (opt.stf.from ? `STF of ${opt.stf.from}` : `STF m=${opt.stf.m} c0=${opt.stf.c0}`) : null].filter(Boolean);
  const textSummary = `Preview saved: ${input.label}${how.length ? ` (${how.join(', ')})` : ''}\nFile: ${previewPath}\nStats: median=${stats.median?.toFixed?.(6) ?? '?'}, MAD=${stats.mad?.toFixed?.(6) ?? '?'}, max=${(stats.max ?? 0).toFixed?.(4) ?? '?'}`;

  if (fs.existsSync(previewPath)) return { text: textSummary };
  return { isError: true, text: `${textSummary}\n(Preview file not created)` };
}

const savePreview = {
  name: 'save_preview',
  description: 'Save a JPEG preview of a view and return the file path. Optionally a crop region, a downsample factor, and an STF (display stretch) baked into the pixels: the STF of a view (stf_from) or a linked one given as stf_m and stf_c0. Without an STF the JPEG holds the view\'s pixel values as they are. The view itself is not changed.',
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
