// ============================================================================
// Narrowband tools: ha_inject_red, ha_inject_luminance, extract_pseudo_oiii,
// continuum_subtract_ha, dynamic_narrowband_blend, create_synthetic_luminance,
// folded in from mxcoppell/pixinsight-pack-astro@eee19b3 (tools/narrowband.mjs).
// Every value that shapes the result is a required input; the soft clamps and
// caps run only when their values are given. The pack's continuous_clamp lives
// in tone.mjs and its lrgb_combine in channels.mjs.
//
// Every view ID that ends up inside a PixelMath expression goes through vid():
// the expression is PixelMath code, so quoting the PJSR string around it is
// not enough.
// ============================================================================
import { q, num, vid, pjsrJson, fixed, lit } from './pjsr-args.mjs';

// Shared PixelMath settings for an in-place, 64-bit, [0,1]-truncated run.
const PM_INPLACE = 'PM.use64BitWorkingImage = true; PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1; PM.createNewImage = false;';

const given = (v) => v !== undefined && v !== null;

// Soft clamp: above `maxOut`, only `rolloff` of the excess is kept.
const softClamp = (raw, maxOut, rolloff) => `iif(${raw} > ${maxOut}, ${maxOut} + (${raw} - ${maxOut}) * ${rolloff}, ${raw})`;

const numbers = (s) => `median=${fixed(s.median, 6)}, max=${fixed(s.max, 4)}`;

// ---------------------------------------------------------------------------
// Ha injection
// ---------------------------------------------------------------------------

const haInjectRed = {
  name: 'ha_inject_red',
  description: 'Add Ha to the red channel of an RGB view in place, where Ha exceeds R by a given fraction. Where Ha > R * (1 + brightness_limit), R becomes R + strength * (Ha - R); elsewhere R, and G and B everywhere, are unchanged. ' +
    'With max_output and rolloff, R above max_output becomes max_output + (R - max_output) * rolloff. Runs as 64-bit PixelMath truncated to [0,1]; reports the new R maximum and the image median and max.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_id: { type: 'string', description: 'Target RGB view, modified in place' },
      ha_id: { type: 'string', description: 'Ha view (mono, same dimensions)' },
      strength: { type: 'number', description: 'Fraction of the Ha excess over R added to R' },
      brightness_limit: { type: 'number', description: 'Ha is added only where Ha > R * (1 + brightness_limit)' },
      max_output: { type: 'number', description: 'Optional: R level above which the soft clamp compresses; given together with rolloff. Omitted = no clamp' },
      rolloff: { type: 'number', description: 'Fraction of the excess above max_output that is kept; given together with max_output' },
    },
    required: ['target_id', 'ha_id', 'strength', 'brightness_limit'],
  },
  async handler(api, input) {
    const tgt = vid(input.target_id, 'target_id');
    const ha = vid(input.ha_id, 'ha_id');
    const str = num(input.strength, undefined, 'strength');
    const limit = num(input.brightness_limit, undefined, 'brightness_limit');
    if (given(input.max_output) !== given(input.rolloff)) {
      throw new Error('max_output and rolloff: give both to soft-clamp R, or neither');
    }
    const clamped = given(input.max_output);
    const maxOut = clamped ? num(input.max_output, undefined, 'max_output') : null;
    const rolloff = clamped ? num(input.rolloff, undefined, 'rolloff') : null;
    // PixelMath has no variables here, so the raw expression repeats inside the clamp.
    const rawExpr = `iif(${ha} > ${tgt}[0] * (1 + ${limit}), ${tgt}[0] + ${str} * (${ha} - ${tgt}[0]), ${tgt}[0])`;
    const expr = clamped ? softClamp(rawExpr, maxOut, rolloff) : rawExpr;
    const r = await api.pjsr(`
      var PM = new PixelMath;
      PM.expression = ${q(expr)};
      PM.expression1 = ${q(`${tgt}[1]`)};
      PM.expression2 = ${q(`${tgt}[2]`)};
      PM.useSingleExpression = false;
      ${PM_INPLACE}
      PM.executeOn(ImageWindow.windowById(${q(tgt)}).mainView);
    `);
    if (r.status === 'error') throw new Error(`ha_inject_red failed: ${r.error?.message}`);
    const stats = await api.stats(tgt);
    const chStats = await api.pjsr(`
      var w = ImageWindow.windowById(${q(tgt)});
      var img = w.mainView.image;
      img.selectedChannel = 0; var rMax = img.maximum();
      img.resetChannelSelection();
      JSON.stringify({ rMax: rMax });
    `);
    let rMaxInfo = '';
    try {
      const ch = JSON.parse(chStats.outputs?.consoleOutput || '{}');
      rMaxInfo = ` R_max=${fixed(ch.rMax, 4)},`;
    } catch { /* the per-channel max is informational only */ }
    const clampText = clamped ? `max_output=${maxOut}, rolloff=${rolloff}` : 'max_output=none';
    return { text: `Ha injected into red channel (strength=${str}, brightness_limit=${limit}, ${clampText}).${rMaxInfo} ${numbers(stats)}` };
  },
};

const haInjectLuminance = {
  name: 'ha_inject_luminance',
  description: 'Raise the luminance of an RGB view in place where Ha exceeds it, keeping colour ratios. With Y the Rec.709 luminance, each channel is multiplied by (Y + strength * max(Ha - Y, 0)) / Y. ' +
    'Runs as 64-bit PixelMath truncated to [0,1].',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_id: { type: 'string', description: 'Target RGB view, modified in place' },
      ha_id: { type: 'string', description: 'Ha view (mono, same dimensions)' },
      strength: { type: 'number', description: 'Fraction of the Ha excess over the luminance that is added' },
    },
    required: ['target_id', 'ha_id', 'strength'],
  },
  async handler(api, input) {
    const tgt = vid(input.target_id, 'target_id');
    const ha = vid(input.ha_id, 'ha_id');
    const str = num(input.strength, undefined, 'strength');
    // Y_new = Y_old + strength * max(Ha - Y_old, 0), applied as a ratio so colour is preserved.
    const Y = '(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2])';
    const expr = `$T + ${str} * max(${ha} - ${Y}, 0) * $T / max(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2], 0.00001)`;
    const r = await api.pjsr(`
      var PM = new PixelMath;
      PM.expression = ${q(expr)};
      PM.useSingleExpression = true;
      ${PM_INPLACE}
      PM.executeOn(ImageWindow.windowById(${q(tgt)}).mainView);
    `);
    if (r.status === 'error') throw new Error(`ha_inject_luminance failed: ${r.error?.message}`);
    return { text: `Ha luminance blended (strength=${str})` };
  },
};

// ---------------------------------------------------------------------------
// Emission extraction
// ---------------------------------------------------------------------------

const extractPseudoOiii = {
  name: 'extract_pseudo_oiii',
  description: 'Create a mono view from the B channel of an RGB view minus its scaled R channel. OIII = max(0, B - continuum_factor * R); any view of that name is replaced. ' +
    'Reports the new view\'s median and max.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rgb_id: { type: 'string', description: 'Source RGB view' },
      continuum_factor: { type: 'number', description: 'Multiplier on R subtracted from B' },
      output_id: { type: 'string', description: 'Name of the view to create; omitted = OIII_pseudo' },
    },
    required: ['rgb_id', 'continuum_factor'],
  },
  async handler(api, input) {
    const factor = num(input.continuum_factor, undefined, 'continuum_factor');
    const outputId = vid(input.output_id ?? 'OIII_pseudo', 'output_id');
    if (outputId === input.rgb_id) throw new Error(`output_id "${outputId}" is an input view (rgb_id); name a new view`);
    const result = await pjsrJson(api, `
      var src = ImageWindow.windowById(${q(input.rgb_id)});
      if (src.isNull) throw new Error('extractPseudoOIII: source not found: ' + ${q(input.rgb_id)});
      var img = src.mainView.image;
      if (!img.isColor) throw new Error('extractPseudoOIII: source must be color');

      var old = ImageWindow.windowById(${q(outputId)});
      if (!old.isNull) old.forceClose();

      var w = img.width;
      var h = img.height;
      var outW = new ImageWindow(w, h, 1, 32, true, false, ${q(outputId)});
      var outImg = outW.mainView.image;

      // OIII = max(0, B - factor * R)
      outW.mainView.beginProcess();
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var b = img.sample(x, y, 2);
          var r = img.sample(x, y, 0);
          outImg.setSample(Math.max(0, b - ${factor} * r), x, y);
        }
      }
      outW.mainView.endProcess();

      outW.show();
      outImg = outW.mainView.image;
      JSON.stringify({ viewId: ${q(outputId)}, median: outImg.median(), max: outImg.maximum(), width: w, height: h });
    `, 'extractPseudoOIII');
    return { text: `Pseudo-OIII extracted: ${result.viewId} (factor=${factor}, ${numbers(result)})` };
  },
};

const continuumSubtractHa = {
  name: 'continuum_subtract_ha',
  description: 'Subtract the scaled R channel of an RGB view from an Ha view, in place. Ha = max(0, Ha - continuum_factor * R). ' +
    'Runs as 64-bit PixelMath truncated to [0,1]; reports the new median and max.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ha_id: { type: 'string', description: 'Ha view (mono), modified in place' },
      rgb_id: { type: 'string', description: 'RGB view whose R channel is subtracted (same dimensions)' },
      continuum_factor: { type: 'number', description: 'Multiplier on R subtracted from Ha' },
    },
    required: ['ha_id', 'rgb_id', 'continuum_factor'],
  },
  async handler(api, input) {
    const ha = vid(input.ha_id, 'ha_id');
    const rgb = vid(input.rgb_id, 'rgb_id');
    const factor = num(input.continuum_factor, undefined, 'continuum_factor');
    const result = await pjsrJson(api, `
      var PM = new PixelMath;
      PM.expression = ${q(`max(0, ${ha} - ${factor} * ${rgb}[0])`)};
      PM.useSingleExpression = true;
      ${PM_INPLACE}
      PM.executeOn(ImageWindow.windowById(${q(ha)}).mainView);

      var img = ImageWindow.windowById(${q(ha)}).mainView.image;
      JSON.stringify({ median: img.median(), max: img.maximum() });
    `, 'continuumSubtractHa');
    return { text: `Ha continuum-subtracted (factor=${factor}). ${numbers(result)}` };
  },
};

// ---------------------------------------------------------------------------
// Blends
// ---------------------------------------------------------------------------

const DNB_VALUES = ['ha_strength', 'oiii_strength', 'g_strength', 'g_ha_fraction', 'max_output', 'rolloff', 'mask_clip', 'mask_blur'];

const dynamicNarrowbandBlend = {
  name: 'dynamic_narrowband_blend',
  description: 'Add Ha and OIII (mono views) to an RGB view in place, through a temporary luminance mask. ' +
    'R += ha_strength * Ha; B += oiii_strength * OIII; G += f * ha_strength * g_ha_fraction * Ha + (1 - f) * g_strength * OIII, with f = (OIII*Ha)^(1-OIII*Ha). ' +
    'Each channel above max_output becomes max_output + (x - max_output) * rolloff. ' +
    'The mask is the Rec.709 luminance of the target, Gaussian-blurred with sigma mask_blur, then 0 below mask_clip and (x - mask_clip) / (1 - mask_clip) above it; it is removed afterwards. ' +
    'Runs as 64-bit PixelMath truncated to [0,1]; reports the median and the R and B maxima.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_id: { type: 'string', description: 'Target RGB view, modified in place' },
      ha_id: { type: 'string', description: 'Ha view (mono, same dimensions)' },
      oiii_id: { type: 'string', description: 'OIII view (mono, same dimensions)' },
      ha_strength: { type: 'number', description: 'Multiplier on Ha added to R' },
      oiii_strength: { type: 'number', description: 'Multiplier on OIII added to B' },
      g_strength: { type: 'number', description: 'Multiplier on OIII in the G term' },
      g_ha_fraction: { type: 'number', description: 'Fraction of ha_strength applied to Ha in the G term' },
      max_output: { type: 'number', description: 'Per-channel level above which the soft clamp compresses' },
      rolloff: { type: 'number', description: 'Fraction of the excess above max_output that is kept' },
      mask_clip: { type: 'number', description: 'Mask level below which the blend does not apply; 0 = no clip' },
      mask_blur: { type: 'number', description: 'Gaussian sigma (pixels) of the luminance mask blur' },
    },
    required: ['target_id', 'ha_id', 'oiii_id', ...DNB_VALUES],
  },
  async handler(api, input) {
    const tgt = vid(input.target_id, 'target_id');
    const ha = vid(input.ha_id, 'ha_id');
    const oiii = vid(input.oiii_id, 'oiii_id');
    const haStr = num(input.ha_strength, undefined, 'ha_strength');
    const oiiiStr = num(input.oiii_strength, undefined, 'oiii_strength');
    const gStr = num(input.g_strength, undefined, 'g_strength');
    const gHaFraction = num(input.g_ha_fraction, undefined, 'g_ha_fraction');
    const maxOut = num(input.max_output, undefined, 'max_output');
    const rolloff = num(input.rolloff, undefined, 'rolloff');
    const maskClip = num(input.mask_clip, undefined, 'mask_clip');
    if (!(maskClip >= 0 && maskClip < 1)) throw new Error(`mask_clip: expected a number in [0, 1), got ${maskClip}`);
    const maskBlur = num(input.mask_blur, undefined, 'mask_blur');

    // f = (OIII*Ha)^(1-OIII*Ha) = exp((1-OIII*Ha)*ln(max(OIII*Ha, 0.00001))) (PixelMath has no pow):
    // where both are bright the Ha term dominates G; where OIII alone is bright, the OIII term does.
    const clamp = (raw) => softClamp(raw, maxOut, rolloff);
    const product = `${oiii} * ${ha}`;
    const dynWeight = `exp((1 - ${product}) * ln(max(${product}, 0.00001)))`;
    const rawR = `${tgt}[0] + ${haStr} * ${ha}`;
    const rawG = `${tgt}[1] + ${dynWeight} * ${haStr} * ${gHaFraction} * ${ha} + (1 - ${dynWeight}) * ${gStr} * ${oiii}`;
    const rawB = `${tgt}[2] + ${oiiiStr} * ${oiii}`;

    const result = await pjsrJson(api, `
      var tgtW = ImageWindow.windowById(${q(tgt)});
      if (tgtW.isNull) throw new Error('dynamicNarrowbandBlend: target not found: ' + ${q(tgt)});
      var img = tgtW.mainView.image;
      var w = img.width;
      var h = img.height;

      // Temporary luminance mask.
      var nbMaskId = '__nb_blend_mask';
      var oldMask = ImageWindow.windowById(nbMaskId);
      if (!oldMask.isNull) oldMask.forceClose();

      var maskW = new ImageWindow(w, h, 1, 32, true, false, nbMaskId);
      var maskImg = maskW.mainView.image;
      maskW.mainView.beginProcess();
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          maskImg.setSample(0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2), x, y);
        }
      }
      maskW.mainView.endProcess();

      var C = new Convolution;
      C.mode = Convolution.Parametric;
      C.sigma = ${maskBlur};
      C.shape = 2;
      C.aspectRatio = 1;
      C.rotationAngle = 0;
      C.executeOn(maskW.mainView);

      var clipVal = ${maskClip};
      if (clipVal > 0) {
        var PMclip = new PixelMath;
        PMclip.expression = 'iif($T<' + clipVal + ',0,($T-' + clipVal + ')/' + ${q(lit(1 - maskClip))} + ')';
        PMclip.useSingleExpression = true;
        PMclip.createNewImage = false;
        PMclip.use64BitWorkingImage = true;
        PMclip.truncate = true;
        PMclip.truncateLower = 0;
        PMclip.truncateUpper = 1;
        PMclip.executeOn(maskW.mainView);
      }

      maskW.show();
      tgtW.mask = maskW;
      tgtW.maskVisible = false;
      tgtW.maskInverted = false;

      var PM = new PixelMath;
      PM.expression = ${q(clamp(rawR))};
      PM.expression1 = ${q(clamp(rawG))};
      PM.expression2 = ${q(clamp(rawB))};
      PM.useSingleExpression = false;
      ${PM_INPLACE}
      PM.executeOn(tgtW.mainView);

      tgtW.removeMask();
      maskW.forceClose();

      var finalImg = tgtW.mainView.image;
      finalImg.selectedChannel = 0; var rMax = finalImg.maximum();
      finalImg.selectedChannel = 2; var bMax = finalImg.maximum();
      finalImg.resetChannelSelection();
      JSON.stringify({ median: finalImg.median(), max: finalImg.maximum(), rMax: rMax, bMax: bMax, maskClip: clipVal });
    `, 'dynamicNarrowbandBlend');

    return { text: `Narrowband blend applied. median=${fixed(result.median, 6)}, R_max=${fixed(result.rMax, 4)}, B_max=${fixed(result.bMax, 4)}` };
  },
};

const createSyntheticLuminance = {
  name: 'create_synthetic_luminance',
  description: 'Create a mono view from a weighted sum of Ha and OIII. It is ha_weight * Ha + oiii_weight * OIII, replacing any view of that name; with max_value the result is min(…, max_value); it is then truncated to [0,1]. ' +
    'Reports the new view\'s median and max.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ha_id: { type: 'string', description: 'Ha view (mono)' },
      oiii_id: { type: 'string', description: 'OIII view (mono, same dimensions)' },
      ha_weight: { type: 'number', description: 'Multiplier on Ha' },
      oiii_weight: { type: 'number', description: 'Multiplier on OIII' },
      max_value: { type: 'number', description: 'Optional: upper cap on the result. Omitted = truncation to [0,1] only' },
      output_id: { type: 'string', description: 'Name of the view to create; omitted = SYNTH_L' },
    },
    required: ['ha_id', 'oiii_id', 'ha_weight', 'oiii_weight'],
  },
  async handler(api, input) {
    const ha = vid(input.ha_id, 'ha_id');
    const oiii = vid(input.oiii_id, 'oiii_id');
    const haWeight = num(input.ha_weight, undefined, 'ha_weight');
    const oiiiWeight = num(input.oiii_weight, undefined, 'oiii_weight');
    const maxValue = given(input.max_value) ? num(input.max_value, undefined, 'max_value') : null;
    const outputId = vid(input.output_id ?? 'SYNTH_L', 'output_id');
    for (const [k, v] of [['ha_id', ha], ['oiii_id', oiii]]) {
      if (outputId === v) throw new Error(`output_id "${outputId}" is an input view (${k}); name a new view`);
    }
    const sum = `${haWeight} * ${ha} + ${oiiiWeight} * ${oiii}`;
    const expr = maxValue === null ? sum : `min(${sum}, ${maxValue})`;
    const result = await pjsrJson(api, `
      var old = ImageWindow.windowById(${q(outputId)});
      if (!old.isNull) old.forceClose();

      var PM = new PixelMath;
      PM.expression = ${q(expr)};
      PM.useSingleExpression = true;
      PM.use64BitWorkingImage = true;
      PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
      PM.createNewImage = true;
      PM.newImageId = ${q(outputId)};
      PM.newImageWidth = 0; PM.newImageHeight = 0;
      PM.newImageColorSpace = 0;
      PM.executeOn(ImageWindow.windowById(${q(ha)}).mainView);

      var img = ImageWindow.windowById(${q(outputId)}).mainView.image;
      JSON.stringify({ viewId: ${q(outputId)}, median: img.median(), max: img.maximum() });
    `, 'createSyntheticLuminance');
    return { text: `Synthetic luminance: ${result.viewId} (${numbers(result)})` };
  },
};

export const tools = [
  haInjectRed, haInjectLuminance, extractPseudoOiii, continuumSubtractHa,
  dynamicNarrowbandBlend, createSyntheticLuminance,
];
