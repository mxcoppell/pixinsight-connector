// ============================================================================
// Mask creation, application and cleanup. Ported from v0-pipeline:agents/ops/masks.mjs
// via v0-pipeline:agents/llm/tools.mjs. create_zone_masks and create_adaptive_zone_masks
// are folded in from mxcoppell/pixinsight-pack-astro@eee19b3 (tools/masks.mjs); their
// mask builders live in ./zones.mjs.
// ============================================================================
import { fixed } from './pjsr-args.mjs';
import { createZoneMasks, createAdaptiveZoneMasks } from './zones.mjs';

const q = (s) => JSON.stringify(String(s));

// A number interpolated bare into PJSR cannot be quoted like a string, so its actual runtime
// type is validated instead of trusted from the JSON Schema alone.
function num(value, fallback) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

// Runs a snippet and throws PixInsight's error, so the server reports it (or, for Pause/Abort, the
// user's stop) instead of the tool claiming it worked.
async function run(api, code) {
  const r = await api.pjsr(code);
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return r;
}

const createLuminanceMask = {
  name: 'create_luminance_mask',
  description: 'Create a luminance mask from a color view: Y = 0.2126R + 0.7152G + 0.0722B, then an optional blur and shadow clip.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source color view ID' },
      mask_id: { type: 'string', description: 'Name for the mask' },
      blur: { type: 'number', description: 'Blur sigma applied to the mask (default 5)' },
      clip_low: { type: 'number', description: 'Shadow clip threshold, below which the mask is 0 (default 0.10)' },
      gamma: { type: 'number', description: 'Gamma curve applied to the mask (default 1.0)' },
    },
    required: ['source_id', 'mask_id'],
  },
  async handler(api, input) {
    const blur = num(input.blur, 5);
    const clipLow = num(input.clip_low, 0.10);
    const gamma = num(input.gamma, 1.0);
    const dimR = await api.pjsr(`
      var srcW = ImageWindow.windowById(${q(input.source_id)});
      if (srcW.isNull) throw new Error('Source not found: ' + ${q(input.source_id)} + '. Windows: ' + ImageWindow.windows.map(function(w){return w.mainView.id;}).join(','));
      var img = srcW.mainView.image;
      JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), color: img.isColor, id: srcW.mainView.id });
    `);
    if (dimR.status === 'error') return { isError: true, text: `Failed to create mask: ${dimR.error?.message}` };
    const dims = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
    if (!dims.w || !dims.h) return { isError: true, text: 'Failed to create mask: invalid source dimensions' };

    const lumExpr = dims.color
      ? `0.2126*${input.source_id}[0]+0.7152*${input.source_id}[1]+0.0722*${input.source_id}[2]`
      : input.source_id;
    const r = await api.pjsr(`
      var old = ImageWindow.windowById(${q(input.mask_id)});
      if (!old.isNull) old.forceClose();
      var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, ${q(input.mask_id)});
      mw.show();
      var PM = new PixelMath;
      PM.expression = ${q(lumExpr)};
      PM.useSingleExpression = true;
      PM.createNewImage = false;
      PM.executeOn(mw.mainView);
      ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(mw.mainView);` : ''}
      ${clipLow > 0 || gamma !== 1.0 ? `var PM2 = new PixelMath; PM2.expression = ${q(gamma !== 1.0 ? `iif($T<${clipLow},0,exp(${gamma.toFixed(4)}*ln(max(($T-${clipLow})/${(1 - clipLow).toFixed(4)},0.00001))))` : `iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(4)})`)}; PM2.useSingleExpression = true; PM2.createNewImage = false; PM2.use64BitWorkingImage = true; PM2.truncate = true; PM2.truncateLower = 0; PM2.truncateUpper = 1; PM2.executeOn(mw.mainView);` : ''}
    `);
    if (r.status === 'error') return { isError: true, text: `Failed to create mask: ${r.error?.message}` };
    return { text: `Luminance mask created: ${input.mask_id}` };
  },
};

const applyMask = {
  name: 'apply_mask',
  description: 'Apply a mask to a target view. The mask protects areas where it is black (0) and allows processing where it is white (1). Use inverted=true to flip this.',
  inputSchema: {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'Target view ID' },
      mask_id: { type: 'string', description: 'Mask view ID' },
      inverted: { type: 'boolean', description: 'Invert the mask (default false)' },
    },
    required: ['target_id', 'mask_id'],
  },
  async handler(api, input) {
    // windowById() returns a null window (isNull), never null itself, so check isNull: the old
    // `if (tw && mw)` was always true and a missing view silently did nothing.
    await run(api, `
      var tw = ImageWindow.windowById(${q(input.target_id)});
      var mw = ImageWindow.windowById(${q(input.mask_id)});
      if (tw.isNull) throw new Error('View not found: ' + ${q(input.target_id)});
      if (mw.isNull) throw new Error('Mask not found: ' + ${q(input.mask_id)});
      tw.mask = mw; tw.maskVisible = false; tw.maskInverted = ${input.inverted ? 'true' : 'false'};
    `);
    return { text: `Mask ${input.mask_id} applied to ${input.target_id}${input.inverted ? ' (inverted)' : ''}` };
  },
};

const removeMask = {
  name: 'remove_mask',
  description: 'Remove the current mask from a view.',
  inputSchema: {
    type: 'object',
    properties: { target_id: { type: 'string', description: 'Target view ID' } },
    required: ['target_id'],
  },
  async handler(api, input) {
    await run(api, `var tw = ImageWindow.windowById(${q(input.target_id)}); if (!tw.isNull) tw.removeMask();`);
    return { text: `Mask removed from ${input.target_id}` };
  },
};

const closeMask = {
  name: 'close_mask',
  description: 'Close and delete a mask window to free memory.',
  inputSchema: {
    type: 'object',
    properties: { mask_id: { type: 'string', description: 'Mask view ID to close' } },
    required: ['mask_id'],
  },
  async handler(api, input) {
    await run(api, `var mw = ImageWindow.windowById(${q(input.mask_id)}); if (!mw.isNull) mw.forceClose();`);
    return { text: `Mask ${input.mask_id} closed` };
  },
};

const createZoneMasksTool = {
  name: 'create_zone_masks',
  description: 'Create core, shell and halo masks from three fixed luminance thresholds. Luminance is the Rec.709 luma of a color view, the samples of a gray one: core = above core_clip, shell = shell_clip to core_clip, halo = halo_clip to shell_clip, each ramped linearly from 0 to 1 across its band and Gaussian-blurred with sigma 8, 12 and 20. Creates views mask_core, mask_shell and mask_halo, replacing views of those names. Requires halo_clip < shell_clip < core_clip < 1.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'Source view the masks are computed from' },
      core_clip: { type: 'number', description: 'Luminance above which a pixel is in the core mask (0-1)' },
      shell_clip: { type: 'number', description: 'Luminance above which a pixel, up to core_clip, is in the shell mask (0-1)' },
      halo_clip: { type: 'number', description: 'Luminance above which a pixel, up to shell_clip, is in the halo mask (0-1)' },
    },
    required: ['view_id', 'core_clip', 'shell_clip', 'halo_clip'],
  },
  async handler(api, input) {
    const result = await createZoneMasks(api, input.view_id, {
      core_clip: input.core_clip,
      shell_clip: input.shell_clip,
      halo_clip: input.halo_clip,
    });
    const th = result.thresholds || {};
    return { text: `Zone masks created: ${result.coreId} (>${th.core}), ${result.shellId} (${th.shell}-${th.core}), ${result.haloId} (${th.halo}-${th.shell})` };
  },
};

const createAdaptiveZoneMasksTool = {
  name: 'create_adaptive_zone_masks',
  description: 'Create three masks from percentiles of the image\'s own luminance. Subject pixels are those brighter than the background median + 5 MAD, sampled inside a circle of radius 0.35 * min(width, height) around their brightness-weighted centroid. Core = above the subject percentile 85 + 10 * core_bias; shell = a triangular ramp between the 25th percentile and the core level, peaking at their midpoint; outer = subject level up to the 25th percentile. Each is feathered over 20 px outside the circle and Gaussian-blurred with sigma 5, 10 and 20. Creates views azone_core, azone_shell and azone_outer, replacing views of those names; fewer than 50 sampled subject pixels is an error.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'Source view the masks are computed from' },
      core_bias: { type: 'number', description: 'Position of the core threshold on its 0-1 scale: 0 = percentile 85, 1 = percentile 95 (default 0.5, the middle of the scale)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const result = await createAdaptiveZoneMasks(api, input.view_id, { coreBias: input.core_bias });
    return {
      text: 'Adaptive zone masks created:\n' +
        `  Core: ${result.coreId} (${result.pixelCounts?.core} px, threshold=${fixed(result.thresholds?.core, 3)})\n` +
        `  Shell: ${result.shellId} (${result.pixelCounts?.shell} px, range=${fixed(result.thresholds?.shellLow, 3)}–${fixed(result.thresholds?.core, 3)})\n` +
        `  Outer: ${result.outerId} (${result.pixelCounts?.outer} px, threshold=${fixed(result.thresholds?.outer, 3)})\n` +
        `  ROI: center=(${result.roi?.cx},${result.roi?.cy}), radius=${result.roi?.radius}`,
    };
  },
};

export const tools = [createLuminanceMask, applyMask, removeMask, closeMask, createZoneMasksTool, createAdaptiveZoneMasksTool];
