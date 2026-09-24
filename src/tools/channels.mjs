// ============================================================================
// Multi-view channel operations: combine 3 mono views into RGB, align a view
// to a reference, ABE per color channel, replace an RGB view's lightness.
// combine_channels and align_to_reference are ported from v0-pipeline:agents/llm/tools.mjs;
// run_per_channel_abe and lrgb_combine come from mxcoppell/pixinsight-pack-astro@eee19b3
// (tools/detail.mjs, tools/narrowband.mjs) with their tuned defaults, taxonomy input, hidden
// LinearFit and PixelMath fallback removed and their PixInsight parameter names fixed.
// Each runs more than one process or works on more than one view, outside defineProcessTool's
// "one process, one view" scope, so they are hand-written descriptors.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { toPixPath } from '../platform.mjs';
import { num, int, vid, fixed, newImages, closeViews } from './pjsr-args.mjs';

const q = (s) => JSON.stringify(String(s));

// A view id becomes a filename under tmpDir; reject anything that would let it escape that
// directory (a path separator, "..", or an absolute path) instead of silently resolving through it.
function safeFileStem(id) {
  const s = String(id);
  const base = path.basename(s);
  if (!s || base !== s || base === '.' || base === '..') {
    throw new Error(`view id must be a plain identifier with no path separators, got ${JSON.stringify(id)}`);
  }
  return base;
}

// Runs a snippet and throws PixInsight's error, so the server reports it (or, for Pause/Abort, the
// user's stop) instead of the tool claiming it worked.
async function run(api, code) {
  const r = await api.pjsr(code);
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return r;
}

const combineChannels = {
  name: 'combine_channels',
  description: 'Combine 3 mono views into a single RGB color image using ChannelCombination. All 3 views must have identical dimensions. Returns the view ID of the combined image.',
  inputSchema: {
    type: 'object',
    properties: {
      r_view_id: { type: 'string', description: 'Red channel view ID' },
      g_view_id: { type: 'string', description: 'Green channel view ID' },
      b_view_id: { type: 'string', description: 'Blue channel view ID' },
      output_id: { type: 'string', description: 'Desired output view ID (the combined image is renamed to this)' },
    },
    required: ['r_view_id', 'g_view_id', 'b_view_id', 'output_id'],
  },
  async handler(api, input) {
    const beforeIds = (await api.listImages()).map((i) => i.id);
    const r = await api.pjsr(`
      var P = new ChannelCombination;
      P.colorSpace = ChannelCombination.RGB;
      P.channels = [
        [true, ${q(input.r_view_id)}],
        [true, ${q(input.g_view_id)}],
        [true, ${q(input.b_view_id)}]
      ];
      var ok = P.executeGlobal();
      'CC_result=' + ok;
    `);
    if (r.status === 'error') return { isError: true, text: `ChannelCombination failed: ${r.error?.message ?? JSON.stringify(r.error)}` };
    const ccOk = (r.outputs?.consoleOutput || '').includes('true');
    if (!ccOk) return { isError: true, text: `ChannelCombination failed: ${r.outputs?.consoleOutput}.` };

    const afterImgs = await api.listImages();
    const newImg = afterImgs.find((i) => i.isColor && !beforeIds.includes(i.id));
    if (!newImg) {
      const anyColor = afterImgs.find((i) => i.isColor);
      if (anyColor) {
        if (anyColor.id !== input.output_id) {
          await run(api, `var w = ImageWindow.windowById(${q(anyColor.id)}); if (!w.isNull) w.mainView.id = ${q(input.output_id)};`);
        }
        return { text: `Combined into ${input.output_id} (${anyColor.width}x${anyColor.height})` };
      }
      return { isError: true, text: 'ChannelCombination returned true but no color image found' };
    }
    if (newImg.id !== input.output_id) {
      await run(api, `var w = ImageWindow.windowById(${q(newImg.id)}); if (!w.isNull) w.mainView.id = ${q(input.output_id)};`);
    }
    return { text: `Combined into ${input.output_id} (${newImg.width}x${newImg.height})` };
  },
};

const alignToReference = {
  name: 'align_to_reference',
  description: 'Align a target image to a reference image using StarAlignment. The target is replaced in place with the aligned version.',
  inputSchema: {
    type: 'object',
    properties: {
      reference_id: { type: 'string', description: 'Reference view ID (not modified)' },
      target_id: { type: 'string', description: 'Target view ID (replaced with the aligned version)' },
    },
    required: ['reference_id', 'target_id'],
  },
  async handler(api, input) {
    const tmpDir = path.join(api.workspace.scratchDir, 'tmp_align');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpRef = path.join(tmpDir, `${safeFileStem(input.reference_id)}.xisf`);
    const tmpTgt = path.join(tmpDir, `${safeFileStem(input.target_id)}.xisf`);

    for (const [viewId, filePath] of [[input.reference_id, tmpRef], [input.target_id, tmpTgt]]) {
      const saveR = await api.pjsr(`
        var w = ImageWindow.windowById(${q(viewId)});
        if (w.isNull) throw new Error('View not found: ' + ${q(viewId)});
        var p = ${q(toPixPath(filePath))};
        if (File.exists(p)) File.remove(p);
        w.saveAs(p, false, false, false, false);
        if (w.mainView.id !== ${q(viewId)}) w.mainView.id = ${q(viewId)};
      `);
      if (saveR.status === 'error') return { isError: true, text: `Failed to save ${viewId}: ${saveR.error?.message}` };
    }

    const saResult = await api.pjsr(`
      var P = new StarAlignment;
      P.referenceImage = ${q(toPixPath(tmpRef))};
      P.referenceIsFile = true;
      P.targets = [[true, true, ${q(toPixPath(tmpTgt))}]];
      P.outputDirectory = ${q(toPixPath(tmpDir))};
      P.outputPrefix = 'aligned_';
      P.outputPostfix = '';
      P.overwriteExistingFiles = true;
      P.onError = StarAlignment.Continue;
      P.useTriangles = true;
      P.polygonSides = 5;
      P.useBrightnessRelations = true;
      P.sensitivity = 0.50;
      P.noGUIMessages = true;
      P.distortionCorrection = false;
      P.generateDrizzleData = false;
      var ok = P.executeGlobal();
      'SA_result=' + ok;
    `);
    if (saResult.status === 'error') return { isError: true, text: `StarAlignment failed: ${saResult.error?.message ?? JSON.stringify(saResult.error)}` };
    const saOk = (saResult.outputs?.consoleOutput || '').includes('true');
    if (!saOk) return { isError: true, text: `StarAlignment failed: ${saResult.outputs?.consoleOutput}` };

    // The aligned output file must match THIS target specifically. If it doesn't, do NOT touch
    // target_id at all -- report what was found on disk and stop, exactly like the legacy tool
    // (v0-pipeline:agents/llm/tools.mjs:2464-2476). Silently substituting "whatever aligned_* file
    // is newest" would risk replacing a view's content with the wrong file's data.
    const expectedName = `aligned_${input.target_id}.xisf`;
    const alignedPath = path.join(tmpDir, expectedName);
    if (!fs.existsSync(alignedPath)) {
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('aligned_'));
      if (files.length === 0) return { isError: true, text: 'StarAlignment produced no output file' };
      files.sort((a, b) => fs.statSync(path.join(tmpDir, b)).mtimeMs - fs.statSync(path.join(tmpDir, a)).mtimeMs);
      return { isError: true, text: `Expected ${expectedName} not found; ${input.target_id} was not changed. Newest aligned file: ${path.join(tmpDir, files[0])}` };
    }

    const beforeIds = (await api.listImages()).map((i) => i.id);
    // Open the aligned image BEFORE closing the target, so the target is never closed without its
    // replacement in hand, and use the id ImageWindow.open gave it -- never a guess from whatever
    // other view appeared meanwhile.
    const openR = await api.pjsr(`
      if (!File.exists(${q(toPixPath(alignedPath))})) throw new Error('File not found: ' + ${q(toPixPath(alignedPath))});
      var __wins = ImageWindow.open(${q(toPixPath(alignedPath))});
      if (__wins.length === 0) throw new Error('Failed to open image: ' + ${q(toPixPath(alignedPath))});
      __wins[0].show();
      __wins[0].mainView.id;
    `);
    if (openR.status === 'error') {
      return { isError: true, text: `Aligned file written to ${alignedPath} but it could not be opened: ${openR.error?.message ?? JSON.stringify(openR.error)}. ${input.target_id} was not changed.` };
    }
    const alignedId = String(openR.result ?? '').trim();
    if (!alignedId) {
      return { isError: true, text: `Opened ${alignedPath} but PixInsight reported no view id. ${input.target_id} was not changed.` };
    }

    // Close the crop masks the aligned file brought along, and only those.
    const imgs = await api.listImages();
    for (const cm of imgs.filter((i) => !beforeIds.includes(i.id) && i.id.includes('crop_mask'))) {
      await run(api, `var w=ImageWindow.windowById(${q(cm.id)});if(!w.isNull)w.forceClose();`);
    }

    // Replace the target: close it and give the aligned view its id, in one snippet.
    const swapR = await api.pjsr(`
      var a = ImageWindow.windowById(${q(alignedId)});
      if (a.isNull) throw new Error('The aligned view ' + ${q(alignedId)} + ' is no longer open');
      var t = ImageWindow.windowById(${q(input.target_id)});
      if (!t.isNull) t.forceClose();
      a.mainView.id = ${q(input.target_id)};
    `);
    if (swapR.status === 'error') {
      return { isError: true, text: `Could not replace ${input.target_id} with the aligned view "${alignedId}": ${swapR.error?.message ?? JSON.stringify(swapR.error)}. Aligned file on disk: ${alignedPath}` };
    }

    const dimR = await run(api, `
      var r = ImageWindow.windowById(${q(input.reference_id)});
      var t = ImageWindow.windowById(${q(input.target_id)});
      JSON.stringify({ ref: { w: r.mainView.image.width, h: r.mainView.image.height }, tgt: { w: t.mainView.image.width, h: t.mainView.image.height } });
    `);
    return { text: `Aligned ${input.target_id} to ${input.reference_id}. Aligned file on disk: ${alignedPath}. Dimensions: ${dimR.outputs?.consoleOutput}` };
  },
};

// ---------------------------------------------------------------------------
// run_per_channel_abe
//
// ChannelExtraction and ChannelCombination take their channel images as `channels`, a list of
// [enabled, id] pairs, the form PixInsight's own scripts use (BatchChannelExtraction.js,
// NBRGBCombination.js, BatchPreprocessing/BPP-Processing.js). The pack assigned `channelEnabled` and
// `channelId`, which are not ChannelExtraction parameters: PixInsight ignored them and named the
// images <view>_R/_G/_B, so the ABE loop found no image and silently skipped every channel.
// ---------------------------------------------------------------------------

const PCA_CHANNELS = ['__pca_R', '__pca_G', '__pca_B'];
const pairs = (ids) => `[${ids.map((id) => `[true, ${q(id)}]`).join(', ')}]`;

const runPerChannelAbe = {
  name: 'run_per_channel_abe',
  description: 'Run AutomaticBackgroundExtractor (ABE) separately on the R, G and B channels of a color view, then recombine them into the view with ChannelCombination. ChannelExtraction writes the channels to the temporary views __pca_R, __pca_G and __pca_B; ABE subtracts its model from each in place and discards the model; the temporary views and any other view the call opened are closed afterwards. An ABE parameter that is not given is left at PixInsight\'s default, as run_abe does.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'RGB color view ID (modified in place)' },
      poly_degree: { type: 'integer', description: 'ABE polynomial degree for every channel (AutomaticBackgroundExtractor polyDegree); omitted = PixInsight default' },
      tolerance: { type: 'number', description: 'ABE sample rejection tolerance for every channel (AutomaticBackgroundExtractor tolerance); omitted = PixInsight default' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const polyDeg = input.poly_degree === undefined ? undefined : int(input.poly_degree, undefined, 'poly_degree');
    const tol = input.tolerance === undefined ? undefined : num(input.tolerance, undefined, 'tolerance');
    const beforeIds = (await api.listImages()).map((i) => i.id);
    const r = await api.pjsr(`
      var tgt = ImageWindow.windowById(${q(input.view_id)});
      if (tgt.isNull) throw new Error('View not found: ' + ${q(input.view_id)});
      var chans = ${JSON.stringify(PCA_CHANNELS)};
      for (var i = 0; i < chans.length; i++) {
        if (!ImageWindow.windowById(chans[i]).isNull) throw new Error('A view named ' + chans[i] + ' is already open');
      }

      var CE = new ChannelExtraction;
      CE.colorSpace = ChannelExtraction.RGB;
      CE.channels = ${pairs(PCA_CHANNELS)};
      CE.sampleFormat = ChannelExtraction.SameAsSource;
      if (!CE.executeOn(tgt.mainView)) throw new Error('ChannelExtraction did not run');
      processEvents();

      for (var i = 0; i < chans.length; i++) {
        var cw = ImageWindow.windowById(chans[i]);
        if (cw.isNull) throw new Error('ChannelExtraction did not create ' + chans[i]);
        var P = new AutomaticBackgroundExtractor;${tol === undefined ? '' : `
        P.tolerance = ${tol};`}${polyDeg === undefined ? '' : `
        P.polyDegree = ${polyDeg};`}
        P.targetCorrection = AutomaticBackgroundExtractor.Correction_Subtract;
        P.discardModel = true;
        P.replaceTarget = true;
        P.verbosity = 0;
        if (!P.executeOn(cw.mainView)) throw new Error('AutomaticBackgroundExtractor did not run on ' + chans[i]);
        processEvents();
      }

      var CC = new ChannelCombination;
      CC.colorSpace = ChannelCombination.RGB;
      CC.channels = ${pairs(PCA_CHANNELS)};
      if (!CC.executeOn(tgt.mainView)) throw new Error('ChannelCombination did not run');
      processEvents();

      for (var i = 0; i < chans.length; i++) {
        var w = ImageWindow.windowById(chans[i]);
        if (!w.isNull) w.forceClose();
      }
      'Per-channel ABE done';
    `);
    // Close whatever the call left open (the channel views after a failure, ABE model windows).
    const leftovers = await newImages(api, beforeIds);
    await closeViews(api, leftovers.map((i) => i.id));
    if (r.status === 'error') throw new Error(`Per-channel ABE failed: ${r.error?.message ?? JSON.stringify(r.error)}`);
    const stats = await api.stats(input.view_id);
    const shown = (v) => (v === undefined ? 'PixInsight default' : v);
    return { text: `Per-channel ABE applied to ${input.view_id} (poly_degree=${shown(polyDeg)}, tolerance=${shown(tol)}). median=${fixed(stats.median, 6)}, max=${fixed(stats.max, 4)}` };
  },
};

// ---------------------------------------------------------------------------
// lrgb_combine
//
// LRGBCombination's parameters, as PixInsight's own LocalFuzzyHistogramHyperbolization.js sets them:
// `channels` = four [enabled, id, k] entries in the order R, G, B, L; `mL` = the lightness transfer
// function's midtones balance; `mc` = the saturation transfer function's midtones balance. The pack
// assigned `channelL`/`channelR`/`channelG`/`channelB`, `lightness` and `saturation`, which are not
// LRGBCombination parameters (none is a string in the ColorSpaces module), so PixInsight ran with
// its default mL/mc and channel names. With R, G and B disabled, LRGBCombination keeps the target's
// own RGB and replaces its lightness with L, so no channel extraction is needed.
// k = 1 is PixInsight's default channel weight.
// ---------------------------------------------------------------------------

const lrgbCombine = {
  name: 'lrgb_combine',
  description: 'Replace the lightness of an RGB view with a grayscale L view using LRGBCombination, in place on the RGB view. Only the L channel is enabled, so the RGB view keeps its own color channels. lightness and saturation are LRGBCombination\'s transfer-function midtones balances mL and mc (0.5 leaves that component unchanged). When linear_fit_reject_high is given, the call also runs LinearFit on the L view (modified in place, ahead of the combination) against a temporary luminance image 0.2126 R + 0.7152 G + 0.0722 B of the RGB view; when it is omitted, no LinearFit runs. Chrominance noise reduction and highlight clipping are left at PixInsight\'s defaults.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rgb_id: { type: 'string', description: 'RGB color view ID (modified in place)' },
      l_id: { type: 'string', description: 'Grayscale luminance view ID with the same dimensions as rgb_id' },
      lightness: { type: 'number', description: 'Midtones balance of the lightness transfer function (LRGBCombination mL), 0 to 1' },
      saturation: { type: 'number', description: 'Midtones balance of the saturation transfer function (LRGBCombination mc), 0 to 1' },
      linear_fit_reject_high: { type: 'number', description: 'LinearFit rejectHigh for the fit of L to the RGB luminance; omitted = no LinearFit' },
    },
    required: ['rgb_id', 'l_id', 'lightness', 'saturation'],
  },
  async handler(api, input) {
    const tgt = vid(input.rgb_id, 'rgb_id');
    const lId = vid(input.l_id, 'l_id');
    const lightness = num(input.lightness, undefined, 'lightness');
    const saturation = num(input.saturation, undefined, 'saturation');
    const rejectHigh = input.linear_fit_reject_high === undefined ? undefined : num(input.linear_fit_reject_high, undefined, 'linear_fit_reject_high');

    if (rejectHigh !== undefined) {
      const fit = await api.pjsr(`
        var rgbW = ImageWindow.windowById(${q(tgt)});
        var lW = ImageWindow.windowById(${q(lId)});
        if (rgbW.isNull) throw new Error('RGB not found: ' + ${q(tgt)});
        if (lW.isNull) throw new Error('L not found: ' + ${q(lId)});
        var img = rgbW.mainView.image;
        var lumRef = new ImageWindow(img.width, img.height, 1, 32, true, false, 'lrgb_lum_ref');
        try {
          var PM = new PixelMath;
          PM.expression = ${q(`0.2126*${tgt}[0] + 0.7152*${tgt}[1] + 0.0722*${tgt}[2]`)};
          PM.useSingleExpression = true;
          PM.createNewImage = false;
          if (!PM.executeOn(lumRef.mainView)) throw new Error('PixelMath did not build the luminance reference');
          var LF = new LinearFit;
          LF.referenceViewId = lumRef.mainView.id;
          LF.rejectHigh = ${rejectHigh};
          if (!LF.executeOn(lW.mainView)) throw new Error('LinearFit did not run');
        } finally {
          lumRef.forceClose();
        }
        'LinearFit done';
      `);
      if (fit.status === 'error') throw new Error(`lrgb_combine LinearFit failed: ${fit.error?.message ?? JSON.stringify(fit.error)}`);
    }

    const r = await api.pjsr(`
      var rgbW = ImageWindow.windowById(${q(tgt)});
      if (rgbW.isNull) throw new Error('RGB not found: ' + ${q(tgt)});
      if (ImageWindow.windowById(${q(lId)}).isNull) throw new Error('L not found: ' + ${q(lId)});
      var P = new LRGBCombination;
      P.channels = [[false, "", 1], [false, "", 1], [false, "", 1], [true, ${q(lId)}, 1]];
      P.mL = ${lightness};
      P.mc = ${saturation};
      P.executeOn(rgbW.mainView) ? 'LRGB_OK' : 'LRGB_FAILED';
    `);
    if (r.status === 'error') throw new Error(`lrgb_combine failed: ${r.error?.message ?? JSON.stringify(r.error)}`);
    if (!(r.outputs?.consoleOutput || '').includes('LRGB_OK')) {
      return { isError: true, text: `LRGBCombination did not run on ${tgt}: ${r.outputs?.consoleOutput ?? ''}`.trim() };
    }
    const stats = await api.stats(tgt);
    const fitText = rejectHigh === undefined ? 'no LinearFit' : `LinearFit rejectHigh=${rejectHigh}`;
    return { text: `LRGBCombination applied ${lId} to ${tgt} (lightness=${lightness}, saturation=${saturation}, ${fitText}). median=${fixed(stats.median, 6)}, max=${fixed(stats.max, 4)}` };
  },
};

export const tools = [combineChannels, alignToReference, runPerChannelAbe, lrgbCombine];
