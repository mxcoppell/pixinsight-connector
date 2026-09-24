// ============================================================================
// Tone group: robust_median_stretch, stretch_stars, auto_stretch, continuous_clamp.
//
// stretch_stars, auto_stretch and continuous_clamp come from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/stretch.mjs, tools/narrowband.mjs), with
// their tuned defaults, target classification and refusals removed.
//
// robust_median_stretch is written from the clean-room specification
// local/plans/statistical-stretch-spec.md (public MTF / MAD mathematics only). It is not
// derived from the pack's seti_stretch, which is not ported.
// ============================================================================
import { q, num, int, bool, oneOf, pjsrJson, fixed, lit } from './pjsr-args.mjs';

// Shared PixelMath settings for an in-place, 64-bit, [0,1]-truncated run.
const PM_INPLACE = 'PM.use64BitWorkingImage = true; PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1; PM.createNewImage = false;';

// ---------------------------------------------------------------------------
// robust_median_stretch: the scalar mathematics (spec §3-§5), exported for the tests
// ---------------------------------------------------------------------------

// 1/Φ⁻¹(3/4): makes the MAD a consistent estimator of σ under normality (PJSR Math.k_MAD).
const K_MAD = 1.4826;

// MTF(m, x) = (m − 1)·x / ((2m − 1)·x − m). The denominator is < 0 for m in (0,1), x in [0,1].
export function mtf(m, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

// solveStretch({ median, mad, blackPointSigma, targetMedian }) -> { median, mad, sigma, c0, xbar, m }.
// Throws when no midtones balance can map the median to the target (spec §6).
export function solveStretch({ median, mad, blackPointSigma, targetMedian }) {
  const sigma = K_MAD * mad;
  const c0 = Math.max(0, median - blackPointSigma * sigma);
  if (1 - c0 <= 0) throw new Error(`no range above the black point (median=${median}, black point=${c0})`);
  const xbar = (median - c0) / (1 - c0);
  if (xbar <= 0) throw new Error(`the median sits on the black point (median=${median}, MAD=${mad}, black point=${c0})`);
  if (xbar >= 1) throw new Error(`the rescaled median is at or above 1 (median=${median})`);
  const m = mtf(targetMedian, xbar);
  if (!(Number.isFinite(m) && m > 0 && m < 1)) throw new Error(`no midtones balance in (0,1) for median=${median} (m=${m})`);
  return { median, mad, sigma, c0, xbar, m };
}

// The stretch of one sample: MTF(m, clamp((x − c0)/(1 − c0), 0, 1)).
export function stretchSample(x, { c0, m }) {
  return mtf(m, Math.min(Math.max((x - c0) / (1 - c0), 0), 1));
}

// Highlight compression above the knee h with balance mh (spec §5.6).
export function compressHighlight(y, h, mh) {
  return y <= h ? y : h + (1 - h) * mtf(mh, (y - h) / (1 - h));
}

// The rational MTF with the balance substituted as literals; `x` is a PixelMath sub-expression.
const mtfText = (m, x) => `((${lit(m - 1)}*${x})/(${lit(2 * m - 1)}*${x} - ${lit(m)}))`;

// stretchExpression({ c0, m }, src, highlight?) -> PixelMath text of the stretch of `src`
// ('$T' or an image reference), with highlight compression folded in when { knee, midtones }
// is given. No power function is used.
export function stretchExpression({ c0, m }, src, highlight) {
  const u = `min(max((${src} - ${lit(c0)})*${lit(1 / (1 - c0))}, 0), 1)`;
  const y = mtfText(m, u);
  if (!highlight) return y;
  const { knee: h, midtones: mh } = highlight;
  const t = `((${y} - ${lit(h)})*${lit(1 / (1 - h))})`;
  return `iif(${y} <= ${lit(h)}, ${y}, ${lit(h)} + ${lit(1 - h)}*${mtfText(mh, t)})`;
}

// ---------------------------------------------------------------------------
// robust_median_stretch: the tool
// ---------------------------------------------------------------------------

// Passes before the last run on this scratch copy, so the view is written once, by the last pass,
// and an error in any pass leaves it unmodified.
const WORK = '__rms_work';

function measureCode(id) {
  return `
    var w = ImageWindow.windowById(${q(id)});
    if (w.isNull) throw new Error('View not found: ' + ${q(id)});
    var img = w.mainView.image;
    var rc = img.rangeClippingEnabled;
    img.rangeClippingEnabled = false;
    var out;
    try {
      var n = img.numberOfNominalChannels;
      var r = img.bounds;
      var st = function (a, b) { var M = img.median(r, a, b); return { median: M, mad: img.MAD(M, r, a, b) }; };
      out = { channels: n, joint: st(0, n - 1), per: [] };
      if (n > 1) { for (var c = 0; c < n; c++) out.per.push(st(c, c)); } else out.per.push(out.joint);
    } finally {
      img.rangeClippingEnabled = rc;
    }
    JSON.stringify(out);`;
}

function applyCode(targetId, exprs, { createWork = false, closeWork = false } = {}) {
  return `
    ${createWork ? `var stale = ImageWindow.windowById(${q(WORK)}); if (!stale.isNull) stale.forceClose();` : ''}
    var P = new PixelMath;
    P.expression = ${q(exprs[0])};
    ${exprs.length === 3 ? `P.expression1 = ${q(exprs[1])}; P.expression2 = ${q(exprs[2])}; P.useSingleExpression = false;` : 'P.useSingleExpression = true;'}
    P.use64BitWorkingImage = true;
    P.rescale = false;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    ${createWork ? `P.createNewImage = true; P.newImageId = ${q(WORK)};` : 'P.createNewImage = false;'}
    if (!P.executeOn(ImageWindow.windowById(${q(targetId)}).mainView)) throw new Error('PixelMath did not run');
    ${closeWork ? `var wk = ImageWindow.windowById(${q(WORK)}); if (!wk.isNull) wk.forceClose();` : ''}
    'ok';`;
}

function checkInput(input) {
  const targetMedian = num(input.target_median, undefined, 'target_median');
  if (!(targetMedian > 0 && targetMedian < 1)) throw new Error(`target_median: expected a number in (0, 1), got ${targetMedian}`);
  const blackPointSigma = num(input.black_point_sigma, undefined, 'black_point_sigma');
  if (!(blackPointSigma >= 0)) throw new Error(`black_point_sigma: expected a number >= 0, got ${blackPointSigma}`);
  const passes = int(input.passes, 1, 'passes');
  if (passes < 1) throw new Error(`passes: expected an integer >= 1, got ${passes}`);
  const linked = input.linked === undefined || input.linked === null ? undefined : bool(input.linked, undefined, 'linked');
  const hasKnee = input.highlight_knee !== undefined && input.highlight_knee !== null;
  const hasMid = input.highlight_midtones !== undefined && input.highlight_midtones !== null;
  let highlight = null;
  if (hasKnee !== hasMid) throw new Error('highlight_knee and highlight_midtones: give both to compress highlights, or neither');
  if (hasKnee) {
    const knee = num(input.highlight_knee, undefined, 'highlight_knee');
    const midtones = num(input.highlight_midtones, undefined, 'highlight_midtones');
    if (!(knee > 0 && knee < 1)) throw new Error(`highlight_knee: expected a number in (0, 1), got ${knee}`);
    if (!(midtones > 0.5 && midtones < 1)) throw new Error(`highlight_midtones: expected a number in (0.5, 1), got ${midtones}`);
    highlight = { knee, midtones };
  }
  return { targetMedian, blackPointSigma, passes, linked, highlight };
}

const robustMedianStretch = {
  name: 'robust_median_stretch',
  description: 'Stretch a linear view in place so its median lands on target_median. Per pass: from the median M and the unnormalized median absolute deviation D of the image (range clipping off, alpha excluded), sigma = 1.4826·D and the black point c0 = max(0, M − black_point_sigma·sigma); samples are rescaled to u = clamp((x − c0)/(1 − c0), 0, 1), and the midtones transfer function MTF(m, u) = (m − 1)·u / ((2m − 1)·u − m) is applied with the balance m solved so that MTF(m, u(M)) = target_median exactly. linked true takes one set of statistics over all channels jointly; false takes them per channel. Each further pass repeats this on the previous output, re-measuring the statistics; passes before the last run on a scratch copy, so the view is written once and is left unmodified when any pass cannot be solved (a median on the black point, e.g. D = 0). With highlight_knee h and highlight_midtones mh, values y above h become h + (1 − h)·MTF(mh, (y − h)/(1 − h)) after the last pass. The result is JSON: per pass and per statistics group M, D, sigma, c0, the rescaled median xbar and m.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View to stretch (modified in place)' },
      target_median: { type: 'number', description: 'Median of the output, strictly between 0 and 1' },
      black_point_sigma: { type: 'number', description: 'Distance of the black point below the median, in units of 1.4826·MAD (>= 0)' },
      linked: { type: 'boolean', description: 'Colour images only, required for them: true = joint statistics over all channels and one transform for all; false = statistics and transform per channel. Ignored for a grayscale image.' },
      passes: { type: 'integer', description: 'Number of times the whole procedure runs, each on the previous output (>= 1; omitted = 1)' },
      highlight_knee: { type: 'number', description: 'Output level above which values are compressed, strictly between 0 and 1. Given together with highlight_midtones; omitted = no highlight compression.' },
      highlight_midtones: { type: 'number', description: 'MTF balance applied to the segment above highlight_knee, strictly between 0.5 and 1. Given together with highlight_knee.' },
    },
    required: ['view_id', 'target_median', 'black_point_sigma'],
  },
  async handler(api, input) {
    const { targetMedian, blackPointSigma, passes, linked, highlight } = checkInput(input);
    const viewId = input.view_id;
    const report = { view_id: viewId, channels: null, linked: null, target_median: targetMedian, black_point_sigma: blackPointSigma, passes: [], highlight };
    let src = viewId;
    for (let p = 1; p <= passes; p++) {
      const fail = async (msg) => {
        if (p > 1) await api.pjsr(`var wk = ImageWindow.windowById(${q(WORK)}); if (!wk.isNull) wk.forceClose(); 'ok';`);
        return { isError: true, text: `robust_median_stretch: ${msg}; the view was not modified` };
      };
      const st = await pjsrJson(api, measureCode(src), 'robust_median_stretch statistics');
      const n = st.channels;
      if (n !== 1 && n !== 3) return fail(`${n} nominal channels (expected 1 or 3)`);
      if (n === 3 && linked === undefined) return fail('linked is required for a colour image (true: joint statistics, false: per channel)');
      report.channels = n;
      report.linked = n === 3 ? linked : null;

      const groups = n === 1 ? [{ channel: 'K', stats: st.per[0] }]
        : linked ? [{ channel: 'RGB', stats: st.joint }]
          : ['R', 'G', 'B'].map((channel, c) => ({ channel, stats: st.per[c] }));
      const solved = [];
      for (const g of groups) {
        try {
          solved.push({ channel: g.channel, ...solveStretch({ median: g.stats.median, mad: g.stats.mad, blackPointSigma, targetMedian }) });
        } catch (e) {
          return fail(`pass ${p}, ${g.channel}: ${e.message}`);
        }
      }
      report.passes.push({ pass: p, groups: solved });

      const last = p === passes;
      const hl = last ? highlight ?? undefined : undefined;
      let exprs;
      if (p === 1 || !last) {
        // Reads the target itself ($T): the view on pass 1, the scratch copy in between.
        exprs = solved.length === 3 ? solved.map((s) => stretchExpression(s, '$T', hl)) : [stretchExpression(solved[0], '$T', hl)];
      } else {
        // The last pass of several reads the scratch copy and writes the view.
        exprs = n === 1 ? [stretchExpression(solved[0], WORK, hl)]
          : [0, 1, 2].map((c) => stretchExpression(solved.length === 3 ? solved[c] : solved[0], `${WORK}[${c}]`, hl));
      }
      const target = last ? viewId : p === 1 ? viewId : WORK;
      const r = await api.pjsr(applyCode(target, exprs, { createWork: !last && p === 1, closeWork: last && p > 1 }));
      if (r.status === 'error') {
        const msg = `robust_median_stretch pass ${p} failed: ${r.error?.message || JSON.stringify(r.error)}`;
        if (passes > 1) await api.pjsr(`var wk = ImageWindow.windowById(${q(WORK)}); if (!wk.isNull) wk.forceClose(); 'ok';`);
        throw new Error(msg);
      }
      src = WORK;
    }
    return { text: JSON.stringify(report) };
  },
};

// ---------------------------------------------------------------------------
// stretch_stars
// ---------------------------------------------------------------------------

const stretchStars = {
  name: 'stretch_stars',
  description: 'Stretch a linear star image in place with a pedestal subtraction and a repeated midtones transfer function. When the image median is above 1e-5 it is subtracted as a pedestal and the rest rescaled, max(0, (x − median)/(1 − median)); then the midtones transfer function MTF(m, x) = (1 − m)·x / ((1 − 2m)·x + m) is applied `iterations` times with m = midtone. Results are truncated to [0,1]. The result reports the pedestal, the final median and maximum, and high_fraction: among pixels sampled every 16 pixels whose value (the channel maximum) exceeds 0.005 before the stretch, the fraction above 0.5.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'Star image view ID' },
      midtone: { type: 'number', description: 'MTF midtones balance m, strictly between 0 and 1 (m < 0.5 brightens)' },
      iterations: { type: 'integer', description: 'Number of times the MTF is applied (>= 1)' },
    },
    required: ['view_id', 'midtone', 'iterations'],
  },
  async handler(api, input) {
    const midtone = num(input.midtone, undefined, 'midtone');
    if (!(midtone > 0 && midtone < 1)) throw new Error(`midtone: expected a number in (0, 1), got ${midtone}`);
    const iterations = int(input.iterations, undefined, 'iterations');
    if (iterations < 1) throw new Error(`iterations: expected an integer >= 1, got ${iterations}`);

    // 1. sample the fraction of star pixels above 0.5 (reported), 2. clip the background
    // pedestal, 3. N MTF iterations.
    const r = await api.pjsr(`
        var w = ImageWindow.windowById(${q(input.view_id)});
        if (w.isNull) throw new Error('View not found: ' + ${q(input.view_id)});
        var v = w.mainView;

        var med = v.image.median();
        var nonzeroAbove05 = 0;
        var nonzeroTotal = 0;
        var step = 16;
        for (var y = 0; y < v.image.height; y += step) {
          for (var x = 0; x < v.image.width; x += step) {
            var val = v.image.isColor ? Math.max(v.image.sample(x,y,0), v.image.sample(x,y,1), v.image.sample(x,y,2)) : v.image.sample(x,y);
            if (val > 0.005) {
              nonzeroTotal++;
              if (val > 0.5) nonzeroAbove05++;
            }
          }
        }
        var highFraction = nonzeroTotal > 0 ? nonzeroAbove05 / nonzeroTotal : 0;

        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }

        // MTF(m, x) = (1-m)*x / ((1-2*m)*x + m)
        var m = ${midtone};
        var a = (1 - m).toFixed(6);
        var b = (1 - 2*m).toFixed(6);
        var mtfExpr = '(' + a + '*$T)/((' + b + ')*$T+' + m.toFixed(6) + ')';
        for (var i = 0; i < ${iterations}; i++) {
          var P2 = new PixelMath;
          P2.expression = mtfExpr;
          P2.useSingleExpression = true;
          P2.createNewImage = false;
          P2.use64BitWorkingImage = true;
          P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
          P2.executeOn(v);
          processEvents();
        }

        JSON.stringify({ bgClip: med > 0.00001 ? med : 0, highFraction: highFraction, finalMedian: v.image.median(), finalMax: v.image.maximum() });
      `);
    if (r.status === 'error') throw new Error(`stretch_stars failed: ${r.error?.message}`);
    const result = JSON.parse(r.outputs?.consoleOutput || '{}');
    return { text: `Stars stretched: bgClip=${fixed(result.bgClip, 6)}, midtone=${midtone}, ${iterations} iterations, high_fraction=${fixed(result.highFraction, 4)}. Final: median=${fixed(result.finalMedian, 4)}, max=${fixed(result.finalMax, 4)}` };
  },
};

// ---------------------------------------------------------------------------
// auto_stretch
// ---------------------------------------------------------------------------

// PixInsight's auto-stretch (ScreenTransferFunction's Auto Stretch), computed from per-channel median and
// sigma = K_MAD x MAD. Returns one [c0, m, c1] triple per channel, or a single triple when linked.
// Throws when the clipping point leaves no range for a midtones balance.
export function autoStretchParams({ channels, shadowsClipping, targetBackground, linked }) {
  const n = channels.length;
  const sigma = channels.map((c) => K_MAD * c.mad);
  const nonzero = (s) => 1 + s !== 1;
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  const refuse = (what, v) => {
    throw new Error(`auto_stretch: no midtones balance for ${what} = ${v}; shadows_clipping ${shadowsClipping} puts the clipping point at or beyond the median`);
  };
  const balance = (m, x) => {
    if (!(m > 0 && m < 1)) refuse('the midtones argument', m);
    if (!(x > 0 && x < 1)) refuse('median − c0', x);
    return mtf(m, x);
  };
  if (linked) {
    const meanMedian = channels.reduce((a, c) => a + c.median, 0) / n;
    const inverted = channels.filter((c) => c.median > 0.5).length === n;
    if (!inverted) {
      let c = 0;
      channels.forEach((ch, i) => { if (nonzero(sigma[i])) c += ch.median + shadowsClipping * sigma[i]; });
      const c0 = clamp01(c / n);
      return [[c0, balance(targetBackground, meanMedian - c0), 1]];
    }
    let c = 0;
    channels.forEach((ch, i) => { c += nonzero(sigma[i]) ? ch.median - shadowsClipping * sigma[i] : 1; });
    const c1 = clamp01(c / n);
    return [[0, balance(c1 - meanMedian, targetBackground), c1]];
  }
  return channels.map((ch, i) => {
    if (ch.median < 0.5) {
      const c0 = nonzero(sigma[i]) ? clamp01(ch.median + shadowsClipping * sigma[i]) : 0;
      return [c0, balance(targetBackground, ch.median - c0), 1];
    }
    const c1 = nonzero(sigma[i]) ? clamp01(ch.median - shadowsClipping * sigma[i]) : 1;
    return [0, balance(c1 - ch.median, targetBackground), c1];
  });
}

const autoStretch = {
  name: 'auto_stretch',
  description: 'Stretch a view in place with PixInsight\'s auto-stretch (the ScreenTransferFunction Auto Stretch computation), applied as a HistogramTransformation. Per channel, sigma = 1.4826 × MAD (the median absolute deviation from the median). A channel whose median is below 0.5 gets shadows clipping c0 = median + shadows_clipping × sigma, clamped to [0,1] (0 when sigma is 0), and midtones balance m = MTF(target_bg, median − c0), where MTF(m, x) = (m − 1)·x / ((2m − 1)·x − m); a channel whose median is above 0.5 is treated as inverted: highlights clipping c1 = median − shadows_clipping × sigma (1 when sigma is 0) and m = MTF(c1 − median, target_bg). linked: one transform for R, G and B, with c0 (or c1) the mean over channels of the per-channel clipping points (a channel with sigma 0 adds 0, or 1 for c1) and the mean median in place of the median; the image is treated as inverted only when every channel median is above 0.5. The defaults of shadows_clipping, target_bg and linked are PixInsight\'s auto-stretch defaults. Fails, changing nothing, when the clipping point leaves no range for a midtones balance.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View ID to stretch' },
      target_bg: { type: 'number', default: 0.25, description: 'Target background level, strictly between 0 and 1' },
      shadows_clipping: { type: 'number', default: -2.8, description: 'Clipping point relative to the median, in units of sigma = 1.4826 × MAD' },
      linked: { type: 'boolean', default: false, description: 'Colour images: true computes one transform for R, G and B; false computes one per channel. Ignored for mono images' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const targetBg = num(input.target_bg, 0.25, 'target_bg');
    if (!(targetBg > 0 && targetBg < 1)) throw new Error(`target_bg: expected a number in (0, 1), got ${targetBg}`);
    const shadows = num(input.shadows_clipping, -2.8, 'shadows_clipping');
    const linked = bool(input.linked, false);
    const stats = await api.stats(input.view_id);
    const pc = stats.perChannel;
    const channels = pc
      ? ['R', 'G', 'B'].map((k) => ({ median: num(pc[k]?.median, undefined, `stats.${k}.median`), mad: num(pc[k]?.mad, undefined, `stats.${k}.mad`) }))
      : [{ median: num(stats.median, undefined, 'stats.median'), mad: num(stats.mad, undefined, 'stats.mad') }];
    const params = autoStretchParams({ channels, shadowsClipping: shadows, targetBackground: targetBg, linked });
    const row = ([c0, m, c1]) => [c0, m, c1, 0, 1];
    const H = [[0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1]];
    if (!pc) H[3] = row(params[0]);
    else if (params.length === 1) H[0] = H[1] = H[2] = row(params[0]);
    else params.forEach((p, i) => { H[i] = row(p); });
    const r = await api.pjsr(`
      var P = new HistogramTransformation;
      P.H = ${JSON.stringify(H)};
      P.executeOn(ImageWindow.windowById(${q(input.view_id)}).mainView);
    `);
    if (r.status === 'error') throw new Error(`auto_stretch failed: ${r.error?.message}`);
    const names = params.length === 1 ? [pc ? 'RGB' : 'K'] : ['R', 'G', 'B'];
    const parts = params.map(([c0, m, c1], i) => `${names[i]}: c0=${c0.toFixed(6)}, m=${m.toFixed(6)}, c1=${c1.toFixed(6)}`);
    return { text: `Auto-stretch complete (${pc ? (linked ? 'linked' : 'per channel') : 'mono'}). ${parts.join('; ')}. Before: median=${fixed(stats.median, 6)}, mad=${fixed(stats.mad, 6)}` };
  },
};

// ---------------------------------------------------------------------------
// continuous_clamp
// ---------------------------------------------------------------------------

const continuousClamp = {
  name: 'continuous_clamp',
  description: 'Compress bright values in place above a knee that varies per pixel. A luminance image (Rec.709 weights for colour) is blurred with a Gaussian of sigma blur_sigma and divided by its maximum, giving L in [0,1]; the knee is min_clamp + (max_clamp − min_clamp)·(1 − L), so it equals min_clamp where L = 1 and max_clamp where L = 0. mode soft: a value above the knee becomes knee + headroom·(1 − exp(−rate·(value − knee)/headroom)); mode hard: min(value, knee). The same expression is applied to every channel and the result is truncated to [0,1].',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'Target view to clamp (modified in place)' },
      min_clamp: { type: 'number', description: 'Knee where the blurred luminance is at its maximum' },
      max_clamp: { type: 'number', description: 'Knee where the blurred luminance is 0' },
      blur_sigma: { type: 'number', description: 'Gaussian blur sigma of the luminance mask, in pixels; omitted = max(60, round(image width / 100))' },
      mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft: exponential compression above the knee; hard: values above the knee are set to the knee' },
      headroom: { type: 'number', description: 'Soft mode, required there: the most the output can exceed the knee' },
      rate: { type: 'number', description: 'Soft mode, required there: steepness of the exponential compression' },
    },
    required: ['view_id', 'min_clamp', 'max_clamp', 'mode'],
  },
  async handler(api, input) {
    const minClamp = num(input.min_clamp, undefined, 'min_clamp');
    const maxClamp = num(input.max_clamp, undefined, 'max_clamp');
    const mode = oneOf(input.mode, ['soft', 'hard'], undefined, 'mode');
    const headroom = mode === 'soft' ? num(input.headroom, undefined, 'headroom') : null;
    const rate = mode === 'soft' ? num(input.rate, undefined, 'rate') : null;
    if (mode === 'soft' && !(headroom > 0)) throw new Error(`headroom: expected a number > 0 in soft mode, got ${headroom}`);
    const blurSigma = input.blur_sigma == null ? null : num(input.blur_sigma, undefined, 'blur_sigma');
    const range = maxClamp - minClamp;

    // knee = min_clamp + range * (1 - smooth_lum): bright core near min_clamp, background near
    // max_clamp. Soft: knee + headroom * (1 - exp(-rate * ($T - knee) / headroom)) above the knee.
    const result = await pjsrJson(api, `
      var src = ImageWindow.windowById(${q(input.view_id)});
      if (src.isNull) throw new Error('continuousClamp: view not found: ' + ${q(input.view_id)});
      var img = src.mainView.image;
      var w = img.width;
      var h = img.height;
      var mode = ${q(mode)};

      var blurSigma = ${blurSigma !== null ? blurSigma : 'Math.max(60, Math.round(w / 100))'};

      var tmpId = '__cont_clamp_lum';
      var old = ImageWindow.windowById(tmpId);
      if (!old.isNull) old.forceClose();

      var maskW = new ImageWindow(w, h, 1, 32, true, false, tmpId);
      var maskImg = maskW.mainView.image;
      var isColor = img.isColor;
      maskW.mainView.beginProcess();
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var lum = isColor
            ? 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2)
            : img.sample(x, y);
          maskImg.setSample(lum, x, y);
        }
      }
      maskW.mainView.endProcess();

      var conv = new Convolution;
      conv.mode = Convolution.Parametric;
      conv.sigma = blurSigma;
      conv.shape = 2;
      conv.aspectRatio = 1;
      conv.rotationAngle = 0;
      conv.executeOn(maskW.mainView);

      // Normalize the blurred mask to 0-1
      var mMax = maskImg.maximum();
      if (mMax > 0) {
        maskW.mainView.beginProcess();
        for (var y2 = 0; y2 < h; y2++) {
          for (var x2 = 0; x2 < w; x2++) {
            maskImg.setSample(maskImg.sample(x2, y2) / mMax, x2, y2);
          }
        }
        maskW.mainView.endProcess();
      }

      maskW.show();

      var knee = '${minClamp} + ${range} * (1 - ' + tmpId + ')';
      var clampExpr;
      if (mode === 'soft') {
        ${mode === 'soft' ? `var hd = '${headroom}';
        var rt = '${rate}';` : ''}
        clampExpr = 'iif($T > (' + knee + '), (' + knee + ') + ' + hd + ' * (1 - exp(-' + rt + ' * ($T - (' + knee + ')) / ' + hd + ')), $T)';
      } else {
        clampExpr = 'min($T, ' + knee + ')';
      }

      var PM = new PixelMath;
      PM.expression = clampExpr;
      PM.expression1 = clampExpr;
      PM.expression2 = clampExpr;
      PM.useSingleExpression = false;
      ${PM_INPLACE}
      PM.executeOn(src.mainView);

      maskW.forceClose();

      var finalImg = src.mainView.image;
      JSON.stringify({ median: finalImg.median(), max: finalImg.maximum(), blur_sigma: blurSigma });
    `, 'continuousClamp');
    return { text: `Continuous clamp applied (${mode} mode): median=${fixed(result.median, 6)}, max=${fixed(result.max, 4)}, knee range=[${minClamp}, ${maxClamp}], blur_sigma=${result.blur_sigma}${mode === 'soft' ? `, headroom=${headroom}, rate=${rate}` : ''}` };
  },
};

export const tools = [robustMedianStretch, stretchStars, autoStretch, continuousClamp];
