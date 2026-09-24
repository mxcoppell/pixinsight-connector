// ============================================================================
// Detail tools: multi_scale_enhance and shell_detail_enhance, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/detail.mjs). Every value that
// shapes the result is a required input; the HDRMT pass and the automatic shell
// mask run only when asked for. The pack's run_lhe stub became a real process
// tool in processes.mjs; its run_per_channel_abe lives in channels.mjs.
// ============================================================================
import { q, num, int, bool, fixed, closeViews } from './pjsr-args.mjs';
import { createAdaptiveZoneMasks, ADAPTIVE_ZONE_IDS } from './zones.mjs';

// ---------------------------------------------------------------------------
// multi_scale_enhance
// ---------------------------------------------------------------------------

async function multiScaleEnhance(api, viewId, input) {
  const maskClipLow = num(input.mask_clip_low, undefined, 'mask_clip_low');
  if (!(maskClipLow >= 0 && maskClipLow < 1)) throw new Error(`mask_clip_low: expected a number in [0, 1), got ${maskClipLow}`);
  const maskBlur = num(input.mask_blur, undefined, 'mask_blur');
  const maskGamma = num(input.mask_gamma, undefined, 'mask_gamma');
  const invGamma = num(1.0 / maskGamma, undefined, 'mask_gamma (reciprocal)');
  const lheFineR = num(input.lhe_fine_radius, undefined, 'lhe_fine_radius');
  const lheFineA = num(input.lhe_fine_amount, undefined, 'lhe_fine_amount');
  const lheMidR = num(input.lhe_mid_radius, undefined, 'lhe_mid_radius');
  const lheMidA = num(input.lhe_mid_amount, undefined, 'lhe_mid_amount');
  const lheLargeR = num(input.lhe_large_radius, undefined, 'lhe_large_radius');
  const lheLargeA = num(input.lhe_large_amount, undefined, 'lhe_large_amount');
  const slopeLimit = num(input.lhe_slope_limit, undefined, 'lhe_slope_limit');
  const fineSlopeLimit = num(input.lhe_fine_slope_limit, undefined, 'lhe_fine_slope_limit');
  // The HDRMT pass runs only when hdrmt_layers is given; each other HDRMT value is assigned only
  // when given, so an omitted one is PixInsight's own HDRMultiscaleTransform default.
  const given = (v) => v !== undefined && v !== null;
  const doHDRMT = given(input.hdrmt_layers);
  const hdrmtOptional = ['hdrmt_iterations', 'hdrmt_inverted', 'hdrmt_median_transform', 'hdrmt_to_lightness'].filter((k) => given(input[k]));
  if (!doHDRMT && hdrmtOptional.length) {
    throw new Error(`${hdrmtOptional.join(', ')}: given without hdrmt_layers, which turns the HDRMT pass on`);
  }
  const hdrmtLayers = doHDRMT ? int(input.hdrmt_layers, undefined, 'hdrmt_layers') : null;
  const hdrmtAssign = [];
  if (given(input.hdrmt_iterations)) hdrmtAssign.push(`HDRMT.numberOfIterations = ${int(input.hdrmt_iterations, undefined, 'hdrmt_iterations')};`);
  if (given(input.hdrmt_inverted)) hdrmtAssign.push(`HDRMT.invertedIterations = ${bool(input.hdrmt_inverted, undefined, 'hdrmt_inverted')};`);
  if (given(input.hdrmt_median_transform)) hdrmtAssign.push(`HDRMT.medianTransform = ${bool(input.hdrmt_median_transform, undefined, 'hdrmt_median_transform')};`);
  if (given(input.hdrmt_to_lightness)) hdrmtAssign.push(`HDRMT.toLightness = ${bool(input.hdrmt_to_lightness, undefined, 'hdrmt_to_lightness')};`);

  const r = await api.pjsr(`
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('View not found: ' + ${q(viewId)});
    var img = w.mainView.image;

    function measureDetail() {
      var bgMed = img.median();
      var bgMAD = img.MAD();
      var threshold = bgMed + 8 * 1.4826 * bgMAD;
      var totalEnergy = 0;
      var count = 0;
      var brightCount = 0;
      var step = 8;

      function getLum(x, y) {
        if (img.isColor) {
          return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        }
        return img.sample(x, y);
      }

      for (var y = 1; y < img.height - 1; y += step) {
        for (var x = 1; x < img.width - 1; x += step) {
          var lum = getLum(x, y);
          if (lum > threshold) {
            brightCount++;
            var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
            var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
            var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
            var gx = -tl + tr - 2*ml + 2*mr - bl + br;
            var gy = -tl - 2*tc - tr + bl + 2*bc + br;
            totalEnergy += gx*gx + gy*gy;
            count++;
          }
        }
      }

      return { detailScore: count > 0 ? totalEnergy / count : 0, brightPixels: brightCount, bgMedian: bgMed, bgMAD: bgMAD };
    }

    var before = measureDetail();

    // Luminance mask: clip low, gamma, blur
    var maskId = '__mse_mask';
    var maskWin = ImageWindow.windowById(maskId);
    if (!maskWin.isNull) maskWin.forceClose();
    if (img.isColor) {
      var CE = new ChannelExtraction;
      CE.colorSpace = ChannelExtraction.CIELab;
      CE.channels = [[true, maskId], [false, ''], [false, '']];
      CE.executeOn(w.mainView);
    } else {
      w.mainView.window.cloneView(w.mainView, maskId);
    }
    processEvents();
    maskWin = ImageWindow.windowById(maskId);
    if (maskWin.isNull) throw new Error('Failed to create luminance mask');

    var PM = new PixelMath;
    PM.expression = 'max((' + maskId + ' - ${maskClipLow}) / (1 - ${maskClipLow}), 0)';
    PM.useSingleExpression = true;
    PM.createNewImage = false;
    PM.executeOn(maskWin.mainView);
    processEvents();

    if (${maskGamma} !== 1.0) {
      var PM2 = new PixelMath;
      PM2.expression = 'exp(${invGamma} * ln(max(' + maskId + ', 0.0001)))';
      PM2.useSingleExpression = true;
      PM2.createNewImage = false;
      PM2.executeOn(maskWin.mainView);
      processEvents();
    }

    if (${maskBlur} > 0) {
      var blur = new Convolution;
      blur.mode = Convolution.Parametric;
      blur.sigma = ${maskBlur};
      blur.shape = 2;
      blur.executeOn(maskWin.mainView);
      processEvents();
    }

    w.mask = maskWin;
    w.maskVisible = false;
    w.maskInverted = false;

    // LHE: large, mid, then fine scale
    var LHE1 = new LocalHistogramEqualization;
    LHE1.radius = ${lheLargeR};
    LHE1.slopeLimit = ${slopeLimit};
    LHE1.amount = ${lheLargeA};
    LHE1.executeOn(w.mainView);
    processEvents();

    var LHE2 = new LocalHistogramEqualization;
    LHE2.radius = ${lheMidR};
    LHE2.slopeLimit = ${slopeLimit};
    LHE2.amount = ${lheMidA};
    LHE2.executeOn(w.mainView);
    processEvents();

    var LHE3 = new LocalHistogramEqualization;
    LHE3.radius = ${lheFineR};
    LHE3.slopeLimit = ${fineSlopeLimit};
    LHE3.amount = ${lheFineA};
    LHE3.executeOn(w.mainView);
    processEvents();

    ${doHDRMT ? `
    var HDRMT = new HDRMultiscaleTransform;
    HDRMT.numberOfLayers = ${hdrmtLayers};
    ${hdrmtAssign.join('\n    ')}
    HDRMT.executeOn(w.mainView);
    processEvents();
    ` : ''}

    w.removeMask();
    maskWin.forceClose();
    processEvents();

    var after = measureDetail();
    var improvement = before.detailScore > 0 ? ((after.detailScore - before.detailScore) / before.detailScore * 100) : 0;

    JSON.stringify({
      before: before,
      after: after,
      improvement: improvement,
      params: {
        mask: { clipLow: ${maskClipLow}, blur: ${maskBlur}, gamma: ${maskGamma} },
        lhe: { fine: { r: ${lheFineR}, a: ${lheFineA}, slope: ${fineSlopeLimit} }, mid: { r: ${lheMidR}, a: ${lheMidA} }, large: { r: ${lheLargeR}, a: ${lheLargeA} }, slope: ${slopeLimit} },
        hdrmt: { layers: ${hdrmtLayers}, applied: ${doHDRMT} }
      }
    });
  `);

  if (r.status === 'error') return { error: r.error?.message || 'PJSR error' };
  let data;
  try { data = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { return { error: 'Failed to parse output' }; }

  const details = `Detail score: ${fixed(data.before?.detailScore, 6)} → ${fixed(data.after?.detailScore, 6)} (${data.improvement > 0 ? '+' : ''}${fixed(data.improvement, 1)}%)`;
  return { ...data, details };
}

const multiScaleEnhanceTool = {
  name: 'multi_scale_enhance',
  description: 'Masked three-scale LocalHistogramEqualization on a view, in one call, with an optional HDRMultiscaleTransform pass. ' +
    'The mask is the image lightness (CIE L* for colour, the image itself for mono) mapped as max((L - mask_clip_low) / (1 - mask_clip_low), 0), ' +
    'raised to the power 1/mask_gamma and blurred with a Gaussian of sigma mask_blur (0 = no blur). LHE then runs at the large, mid and fine radius in that order ' +
    'through the mask; the large and mid scales use lhe_slope_limit, the fine scale lhe_fine_slope_limit; other LHE parameters are PixInsight\'s defaults. ' +
    'Giving hdrmt_layers adds an HDRMultiscaleTransform pass through the same mask. The mask is closed afterwards. ' +
    'Reports a detail score before and after: the mean squared Sobel gradient of luminance (Rec.709 weights) over pixels brighter than median + 8 x 1.4826 x MAD, sampled every 8 pixels.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View ID to enhance (modified in place)' },
      mask_clip_low: { type: 'number', description: 'Lightness mapped to 0 in the mask; values above it are rescaled to 0-1' },
      mask_blur: { type: 'number', description: 'Gaussian blur sigma of the mask in pixels (0 = no blur)' },
      mask_gamma: { type: 'number', description: 'Mask gamma: the rescaled mask is raised to the power 1/mask_gamma (1 = unchanged)' },
      lhe_fine_radius: { type: 'number', description: 'Fine-scale LHE kernel radius in pixels' },
      lhe_fine_amount: { type: 'number', description: 'Fine-scale LHE amount, 0 to 1' },
      lhe_mid_radius: { type: 'number', description: 'Mid-scale LHE kernel radius in pixels' },
      lhe_mid_amount: { type: 'number', description: 'Mid-scale LHE amount, 0 to 1' },
      lhe_large_radius: { type: 'number', description: 'Large-scale LHE kernel radius in pixels' },
      lhe_large_amount: { type: 'number', description: 'Large-scale LHE amount, 0 to 1' },
      lhe_slope_limit: { type: 'number', description: 'LHE contrast slope limit of the large and mid scales' },
      lhe_fine_slope_limit: { type: 'number', description: 'LHE contrast slope limit of the fine scale' },
      hdrmt_layers: { type: 'integer', description: 'HDRMultiscaleTransform number of layers. Giving it runs the HDRMT pass; omitted, no HDRMT runs' },
      hdrmt_iterations: { type: 'integer', description: 'HDRMT number of iterations (needs hdrmt_layers; omitted = PixInsight default)' },
      hdrmt_inverted: { type: 'boolean', description: 'HDRMT inverted iterations (needs hdrmt_layers; omitted = PixInsight default)' },
      hdrmt_median_transform: { type: 'boolean', description: 'HDRMT median transform instead of the wavelet transform (needs hdrmt_layers; omitted = PixInsight default)' },
      hdrmt_to_lightness: { type: 'boolean', description: 'HDRMT toLightness: on a colour image, apply the transform to the lightness only (needs hdrmt_layers; omitted = PixInsight default)' },
    },
    required: ['view_id', 'mask_clip_low', 'mask_blur', 'mask_gamma', 'lhe_fine_radius', 'lhe_fine_amount', 'lhe_mid_radius',
      'lhe_mid_amount', 'lhe_large_radius', 'lhe_large_amount', 'lhe_slope_limit', 'lhe_fine_slope_limit'],
  },
  async handler(api, input) {
    const result = await multiScaleEnhance(api, input.view_id, input);
    if (result.error) return { isError: true, text: `multi_scale_enhance failed: ${result.error}` };
    const p = result.params || {};
    return {
      text: `[MULTI-SCALE ENHANCE] ${result.details}\n` +
        `  Before: detail=${fixed(result.before?.detailScore, 6)}, brightPx=${result.before?.brightPixels}\n` +
        `  After:  detail=${fixed(result.after?.detailScore, 6)}, brightPx=${result.after?.brightPixels}\n` +
        `  Improvement: ${result.improvement > 0 ? '+' : ''}${fixed(result.improvement, 1)}%\n` +
        `  Params: LHE fine=${p.lhe?.fine?.r}/${p.lhe?.fine?.a} mid=${p.lhe?.mid?.r}/${p.lhe?.mid?.a} large=${p.lhe?.large?.r}/${p.lhe?.large?.a} | HDRMT=${p.hdrmt?.applied ? p.hdrmt.layers + 'L' : 'off'}`,
    };
  },
};

// ---------------------------------------------------------------------------
// shell_detail_enhance
// ---------------------------------------------------------------------------

// Protected high-pass detail enhancement: for each scale, detail = original - blurred (locally
// zero-mean); result = original + amount x detail x protection, where
// protection = exp(-softness * max(0, lum - knee) / (1 - knee)) attenuates near bright peaks.
function highPassPass(n, { sigma, amount, softness, knee, oneMinusKnee, isColor }) {
  const blurId = `__shell_blur${n}`;
  const exprVar = `expr${n}`;
  return `
    if (${amount} > 0) {
      var blurId${n} = '${blurId}';
      var oldB${n} = ImageWindow.windowById(blurId${n});
      if (!oldB${n}.isNull) oldB${n}.forceClose();

      var blurW${n} = new ImageWindow(W, H, isColor ? 3 : 1, 32, true, isColor, blurId${n});
      blurW${n}.mainView.beginProcess();
      blurW${n}.mainView.image.assign(img);
      blurW${n}.mainView.endProcess();
      blurW${n}.show();

      var conv${n} = new Convolution;
      conv${n}.mode = Convolution.Parametric;
      conv${n}.sigma = ${sigma};
      conv${n}.shape = 2;
      conv${n}.aspectRatio = 1;
      conv${n}.rotationAngle = 0;
      conv${n}.executeOn(blurW${n}.mainView);

      var PM${n} = new PixelMath;
      ${isColor ? `
      var protExpr = 'exp(-${softness} * max(0, (0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]) - ${knee}) / ${oneMinusKnee})';
      var ${exprVar} = '$T + ${amount} * ($T - ' + blurId${n} + ') * ' + protExpr;
      PM${n}.expression = ${exprVar};
      PM${n}.expression1 = ${exprVar};
      PM${n}.expression2 = ${exprVar};
      PM${n}.useSingleExpression = false;` : `
      var protMono = 'exp(-${softness} * max(0, $T - ${knee}) / ${oneMinusKnee})';
      PM${n}.expression = '$T + ${amount} * ($T - ' + blurId${n} + ') * ' + protMono;
      PM${n}.useSingleExpression = true;`}
      PM${n}.use64BitWorkingImage = true;
      PM${n}.truncate = true;
      PM${n}.truncateLower = 0;
      PM${n}.truncateUpper = 1;
      PM${n}.createNewImage = false;
      PM${n}.executeOn(w.mainView);

      blurW${n}.forceClose();
    }`;
}

// Shell-texture measurement shared by the before/after passes: Sobel gradient energy over subject
// pixels, and the median local std-dev of 16px blocks that are at least 30% subject.
const MEASURE_SHELL = `
    function measureShell() {
      var energy = 0, count = 0, maxLum = 0, protEngaged = 0;
      for (var y = 1; y < H-1; y += step) {
        for (var x = 1; x < W-1; x += step) {
          var lum = getLum(x, y);
          if (lum > maxLum) maxLum = lum;
          if (lum > subTh && lum < 0.98) {
            var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
            var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
            var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
            var gx = -tl + tr - 2*ml + 2*mr - bl + br;
            var gy = -tl - 2*tc - tr + bl + 2*bc + br;
            energy += gx*gx + gy*gy;
            count++;
            if (Math.exp(-SOFTNESS * Math.max(0, lum - KNEE) / ONE_MINUS_KNEE) < 0.5) protEngaged++;
          }
        }
      }
      var sds = [];
      for (var by = 0; by < H - bs; by += bs) {
        for (var bx = 0; bx < W - bs; bx += bs) {
          var vals = [], shellN = 0;
          for (var py = by; py < by+bs; py += 2) {
            for (var px = bx; px < bx+bs; px += 2) {
              if (px >= W || py >= H) continue;
              var l = getLum(px, py);
              vals.push(l);
              if (l > subTh && l < 0.98) shellN++;
            }
          }
          if (shellN < vals.length * 0.3) continue;
          var s = 0, s2 = 0;
          for (var k = 0; k < vals.length; k++) { s += vals[k]; s2 += vals[k]*vals[k]; }
          var mn = s / vals.length;
          var v = s2 / vals.length - mn*mn;
          if (v > 0) sds.push(Math.sqrt(v));
        }
      }
      sds.sort(function(a,b){return a-b;});
      return {
        grad: count > 0 ? energy / count : 0,
        stddev: sds.length > 0 ? sds[Math.floor(sds.length/2)] : 0,
        maxLum: maxLum,
        protFrac: count > 0 ? protEngaged / count * 100 : 0
      };
    }`;

async function shellDetailEnhance(api, viewId, input) {
  const medSigma = num(input.medium_sigma, undefined, 'medium_sigma');
  const medAmount = num(input.medium_amount, undefined, 'medium_amount');
  const lgSigma = num(input.large_sigma, undefined, 'large_sigma');
  const lgAmount = num(input.large_amount, undefined, 'large_amount');
  const knee = num(input.protect_knee, undefined, 'protect_knee');
  const softness = num(input.protect_softness, undefined, 'protect_softness');
  // A negative softness turns the protection factor into an amplifier above the knee.
  if (softness < 0) throw new Error(`protect_softness must be >= 0, got ${softness}`);
  const autoZone = bool(input.auto_zone, false, 'auto_zone');

  let createdMask = false;
  let shellMaskId = input.mask_id || null;
  if (!shellMaskId && autoZone) {
    try {
      const zones = await createAdaptiveZoneMasks(api, viewId, {});
      shellMaskId = zones.shellId;
      createdMask = true;
    } catch (e) {
      throw new Error(`shell_detail_enhance: auto_zone could not build the adaptive shell mask: ${e.message}; the view was not modified`);
    }
  }
  const hasMask = !!shellMaskId;
  const oneMinusKnee = Math.max(0.01, 1.0 - knee);

  const probe = await api.pjsr(`
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('shellDetailEnhance: view not found: ' + ${q(viewId)});
    JSON.stringify({ isColor: w.mainView.image.isColor });
  `);
  if (probe.status === 'error') {
    if (createdMask) await closeViews(api, ADAPTIVE_ZONE_IDS);
    return { error: probe.error?.message || 'view lookup failed' };
  }
  const imageIsColor = JSON.parse(probe.outputs?.consoleOutput || '{}').isColor;
  const pass = { softness, knee, oneMinusKnee, isColor: imageIsColor };
  // The real image maximum (all channels), not measureShell's strided luminance sample.
  const statsBefore = await api.stats(viewId);

  const r = await api.pjsr(`
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('shellDetailEnhance: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;
    var SOFTNESS = ${softness}, KNEE = ${knee}, ONE_MINUS_KNEE = ${oneMinusKnee};

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    var bgMedian = img.median();
    var bgMAD = img.MAD();
    var subTh = bgMedian + 5 * 1.4826 * bgMAD;
    var step = 8, bs = 16;
    ${MEASURE_SHELL}
    var before = measureShell();

    ${hasMask ? `
    var maskW = ImageWindow.windowById(${q(shellMaskId)});
    if (!maskW.isNull) {
      w.mask = maskW;
      w.maskVisible = false;
      w.maskInverted = false;
    }` : '// no mask'}

    ${highPassPass(1, { sigma: medSigma, amount: medAmount, ...pass })}
    ${highPassPass(2, { sigma: lgSigma, amount: lgAmount, ...pass })}

    ${hasMask ? 'w.removeMask();' : ''}

    img = w.mainView.image;
    var after = measureShell();

    JSON.stringify({
      before: { gradientEnergy: before.grad, shellLocalStdDev: before.stddev },
      after: { gradientEnergy: after.grad, shellLocalStdDev: after.stddev },
      improvement: before.grad > 0 ? ((after.grad - before.grad) / before.grad) * 100 : 0,
      stddevImprovement: before.stddev > 0 ? ((after.stddev - before.stddev) / before.stddev) * 100 : 0,
      maxAfter: after.maxLum,
      protectionEngaged: after.protFrac,
      params: {
        mediumSigma: ${medSigma}, mediumAmount: ${medAmount},
        largeSigma: ${lgSigma}, largeAmount: ${lgAmount},
        protectKnee: ${knee}, protectSoftness: ${softness},
        hasMask: ${hasMask}
      }
    });
  `);

  if (createdMask) await closeViews(api, ADAPTIVE_ZONE_IDS);
  if (r.status === 'error') return { error: r.error?.message || 'unknown' };

  let data;
  try { data = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { return { error: 'Failed to parse output' }; }
  const statsAfter = await api.stats(viewId);
  return {
    ...data,
    imageMaxBefore: statsBefore.max,
    imageMaxAfter: statsAfter.max,
    mask: shellMaskId || 'none',
    details: `Shell detail: gradient ${data.improvement > 0 ? '+' : ''}${fixed(data.improvement, 1)}%, ` +
      `stddev ${data.stddevImprovement > 0 ? '+' : ''}${fixed(data.stddevImprovement, 1)}%, ` +
      `image max ${fixed(statsBefore.max, 4)} -> ${fixed(statsAfter.max, 4)}, ` +
      `protection engaged on ${fixed(data.protectionEngaged, 1)}% of sampled subject pixels`,
  };
}

const shellDetailEnhanceTool = {
  name: 'shell_detail_enhance',
  description: 'Protected high-pass detail enhancement at two scales, in place. For each scale, detail = image - Gaussian blur of sigma <scale>_sigma ' +
    '(locally zero-mean), and result = image + <scale>_amount x detail x protection, where protection = exp(-protect_softness x max(0, L - protect_knee) / max(1 - protect_knee, 0.01)) ' +
    'and L is Rec.709 luminance, so the boost attenuates above protect_knee. A scale with amount 0 is skipped. Output is truncated to [0, 1]. ' +
    'It does not hold the peak fixed: the added detail can raise the image maximum (the result reports the image maximum before and after, from full image statistics). ' +
    'With mask_id the enhancement runs through that mask; with auto_zone and no mask_id it builds the adaptive shell zone mask (as create_adaptive_zone_masks with its default core_bias), ' +
    'uses it and closes it, and fails without changing the view if that mask cannot be built; with neither it runs unmasked. Reports before/after texture metrics over pixels between median + 5 x 1.4826 x MAD and 0.98, sampled every 8 pixels: ' +
    'mean squared Sobel gradient, median local standard deviation of 16-pixel blocks that are at least 30% such pixels, and the share of them where protection is below 0.5.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View to enhance (modified in place)' },
      mask_id: { type: 'string', description: 'Mask view to enhance through (optional)' },
      medium_sigma: { type: 'number', description: 'Gaussian sigma of the medium-scale blur, in pixels' },
      medium_amount: { type: 'number', description: 'Medium-scale detail multiplier (0 skips the scale)' },
      large_sigma: { type: 'number', description: 'Gaussian sigma of the large-scale blur, in pixels' },
      large_amount: { type: 'number', description: 'Large-scale detail multiplier (0 skips the scale)' },
      protect_knee: { type: 'number', description: 'Luminance above which the boost attenuates' },
      protect_softness: { type: 'number', description: 'Attenuation rate above protect_knee (>= 0; higher = steeper)' },
      auto_zone: { type: 'boolean', default: false, description: 'With no mask_id: build the adaptive shell zone mask and enhance through it. If it cannot be built the call fails and the view is not modified' },
    },
    required: ['view_id', 'medium_sigma', 'medium_amount', 'large_sigma', 'large_amount', 'protect_knee', 'protect_softness'],
  },
  async handler(api, input) {
    const result = await shellDetailEnhance(api, input.view_id, input);
    if (result.error) return { isError: true, text: `shell_detail_enhance error: ${result.error}` };
    const p = result.params || {};
    return {
      text: `[SHELL DETAIL ENHANCE] ${result.details}\n` +
        `  Before: gradient=${fixed(result.before?.gradientEnergy, 6)}, localStdDev=${fixed(result.before?.shellLocalStdDev, 4)}\n` +
        `  After:  gradient=${fixed(result.after?.gradientEnergy, 6)}, localStdDev=${fixed(result.after?.shellLocalStdDev, 4)}\n` +
        `  Improvement: gradient=${fixed(result.improvement, 1)}%, stddev=${fixed(result.stddevImprovement, 1)}%\n` +
        `  Image max (all channels): ${fixed(result.imageMaxBefore, 4)} -> ${fixed(result.imageMaxAfter, 4)}\n` +
        `  Sampled luminance max (every 8th pixel, after): ${fixed(result.maxAfter, 4)}, protection engaged: ${fixed(result.protectionEngaged, 1)}%\n` +
        `  Params: medium=${p.mediumSigma}/${p.mediumAmount} large=${p.largeSigma}/${p.largeAmount} knee=${p.protectKnee} mask=${result.mask}`,
    };
  },
};

export const tools = [multiScaleEnhanceTool, shellDetailEnhanceTool];
