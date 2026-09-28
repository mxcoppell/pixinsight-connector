// ============================================================================
// compare_images: pixel differences between two views of the same geometry, and the per-channel
// fractions of samples at exactly 0 and exactly 1 that get_image_stats reports (PixInsight clamps
// image data to [0, 1] without an error, so a pile-up there is how a clipped value shows).
// Rows are read with Image.getSamples in blocks; nothing is written.
// ============================================================================
import { q, int, pjsrJson } from './pjsr-args.mjs';

// Samples kept for the p99 of |a - b|: every k-th difference, k chosen so at most this many are kept.
const P99_SAMPLES = 2000000;
const BLOCK_ROWS = 64;

export function compareImagesPjsr(aId, bId, rect) {
  return `(function () {
  var wa = ImageWindow.windowById(${q(aId)}), wb = ImageWindow.windowById(${q(bId)});
  if (wa.isNull) throw new Error('View not found: ' + ${q(aId)});
  if (wb.isNull) throw new Error('View not found: ' + ${q(bId)});
  var ia = wa.mainView.image, ib = wb.mainView.image;
  if (ia.width !== ib.width || ia.height !== ib.height || ia.numberOfChannels !== ib.numberOfChannels)
    throw new Error('Geometry differs: ' + ia.width + 'x' + ia.height + 'x' + ia.numberOfChannels + ' vs ' + ib.width + 'x' + ib.height + 'x' + ib.numberOfChannels);
  var r = ${JSON.stringify(rect ?? null)} || [0, 0, ia.width, ia.height];
  if (r[0] < 0 || r[1] < 0 || r[2] > ia.width || r[3] > ia.height || r[2] <= r[0] || r[3] <= r[1])
    throw new Error('rect outside the image: [' + r.join(', ') + '] on ' + ia.width + 'x' + ia.height);
  var W = r[2] - r[0], H = r[3] - r[1], n = W * H, step = Math.max(1, Math.ceil(n / ${P99_SAMPLES}));
  var out = { width: ia.width, height: ia.height, rect: r, pixels: n, identical: true, channels: [] };
  for (var c = 0; c < ia.numberOfChannels; c++) {
    var mx = 0, sum = 0, oa = 0, ob = 0, k = 0, samp = [];
    for (var y0 = r[1]; y0 < r[3]; y0 += ${BLOCK_ROWS}) {
      var y1 = Math.min(r[3], y0 + ${BLOCK_ROWS}), m = W * (y1 - y0), A = new Float32Array(m), B = new Float32Array(m), R = new Rect(r[0], y0, r[2], y1);
      ia.getSamples(A, R, c); ib.getSamples(B, R, c);
      for (var i = 0; i < m; i++) {
        var d = Math.abs(A[i] - B[i]);
        if (d > mx) mx = d;
        sum += d;
        if (A[i] < 0 || A[i] > 1) oa++;
        if (B[i] < 0 || B[i] > 1) ob++;
        if (k++ % step === 0) samp.push(d);
      }
    }
    if (mx !== 0) out.identical = false;
    samp.sort(function (p, q) { return p - q; });
    out.channels.push({ channel: c, maxAbsDiff: mx, meanAbsDiff: sum / n, p99AbsDiff: samp.length ? samp[Math.floor(0.99 * (samp.length - 1))] : 0,
      p99Samples: samp.length, outsideUnitFractionA: oa / n, outsideUnitFractionB: ob / n });
  }
  return JSON.stringify(out);
})()`;
}

export function clampFractionsPjsr(viewId) {
  return `(function () {
  var w = ImageWindow.windowById(${q(viewId)});
  if (w.isNull) throw new Error('View not found: ' + ${q(viewId)});
  var im = w.mainView.image, W = im.width, H = im.height, n = W * H, out = [];
  for (var c = 0; c < im.numberOfChannels; c++) {
    var z = 0, o = 0;
    for (var y0 = 0; y0 < H; y0 += ${BLOCK_ROWS}) {
      var y1 = Math.min(H, y0 + ${BLOCK_ROWS}), m = W * (y1 - y0), A = new Float32Array(m);
      im.getSamples(A, new Rect(0, y0, W, y1), c);
      for (var i = 0; i < m; i++) { if (A[i] === 0) z++; else if (A[i] === 1) o++; }
    }
    out.push({ channel: c, atZeroFraction: z / n, atOneFraction: o / n });
  }
  return JSON.stringify(out);
})()`;
}

// Per-channel fractions of samples at exactly 0 and exactly 1.
export async function clampFractions(api, viewId) {
  return pjsrJson(api, clampFractionsPjsr(viewId), 'clamp fractions');
}

function rectFrom(input) {
  if (input.rect === undefined || input.rect === null) return null;
  if (!Array.isArray(input.rect) || input.rect.length !== 4) throw new Error('rect: expected [x0, y0, x1, y1]');
  return input.rect.map((v, i) => int(v, undefined, `rect[${i}]`));
}

const compareImages = {
  name: 'compare_images',
  description:
    'Compare two open views of the same width, height and channel count, pixel by pixel, over the whole image or a rectangle. ' +
    'Per channel: maximum, mean and 99th-percentile absolute difference, and the fraction of samples outside [0, 1] in each view. ' +
    '"identical" is true when every absolute difference is 0. The 99th percentile is taken over at most 2,000,000 evenly spaced ' +
    'samples (p99Samples says how many); maximum and mean use every sample. Neither view is changed.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'First view (A)' },
      reference_id: { type: 'string', description: 'Second view (B), compared against A' },
      rect: { type: 'array', items: { type: 'integer' }, description: 'Optional region [x0, y0, x1, y1] in pixels, x1/y1 exclusive' },
    },
    required: ['view_id', 'reference_id'],
  },
  async handler(api, input) {
    const out = await pjsrJson(api, compareImagesPjsr(input.view_id, input.reference_id, rectFrom(input)), 'compare_images');
    return { text: JSON.stringify(out, null, 2) };
  },
};

export const tools = [compareImages];
