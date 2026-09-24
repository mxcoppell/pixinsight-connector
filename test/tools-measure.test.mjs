import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { compilingApi } from './helpers.mjs';
import { tools } from '../src/tools/measure.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const J = (o) => JSON.stringify(o);

// The measurement tools folded in from mxcoppell/pixinsight-pack-astro@eee19b3 (plan §1 rows 22-32).
const FOLDED_MEASURES = [
  'measure_stars', 'measure_star_layer', 'measure_ringing', 'measure_sharpness', 'measure_core_clipping',
  'measure_clipped_blocks', 'measure_highlight_texture', 'measure_saturation', 'measure_tonal_presence',
  'measure_bright_chroma', 'measure_subject_detail',
];

// Verdict and advice markers (§0 R6); the same pattern tools-capability.test.mjs holds every folded
// tool's result to, applied here to descriptions and parameter texts too.
const VERDICT = /\b(?:PASS(?:ED)?|FAIL(?:ED)?|ADVISORY|WARN(?:ING)?|BLOCKED|REFUSED|HARD GATE)\b|\b(?:limit|goal):|⚠️|⚡/;
const ADVICE = /\b(?:gate|verdict|too (?:dim|bright)|should|reduce|increase|restore|fix|use this|run this|before calling|after every|compare candidates)\b/i;

// ---------------------------------------------------------------------------
// A tiny PJSR image runtime: runs an emitted snippet in a vm against a synthetic image, so a test
// checks what the snippet actually computes, not only that it compiles. It implements just the
// Image members these snippets use.
// ---------------------------------------------------------------------------
class FakeImage {
  constructor(width, height, channels, pixel) {
    Object.assign(this, { width, height, numberOfChannels: channels, isColor: channels === 3, pixel });
    this.resetSelections();
  }
  sample(x, y, c = 0) {
    if (this.selectedChannel >= 0 && arguments.length < 3) c = this.selectedChannel;
    return this.pixel(x, y, c);
  }
  values() {
    const r = this.selectedRect ?? { x0: 0, y0: 0, x1: this.width, y1: this.height };
    const chans = this.selectedChannel >= 0 ? [this.selectedChannel] : [...Array(this.numberOfChannels).keys()];
    const out = [];
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) for (const c of chans) out.push(this.pixel(x, y, c));
    return out;
  }
  median() { const v = this.values().sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; }
  MAD() { const m = this.median(); const d = this.values().map((v) => Math.abs(v - m)).sort((a, b) => a - b); return d[Math.floor(d.length / 2)]; }
  mean() { const v = this.values(); return v.reduce((a, b) => a + b, 0) / v.length; }
  maximum() { return Math.max(...this.values()); }
  minimum() { return Math.min(...this.values()); }
  resetChannelSelection() { this.selectedChannel = -1; }
  resetSelections() { this.selectedRect = null; this.selectedChannel = -1; }
}

// An api whose pjsr runs every snippet against `views` ({ id: FakeImage }); `emitted` records them.
function runtimeApi(views) {
  const emitted = [];
  const context = vm.createContext({
    Rect: function Rect(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); },
    ImageWindow: {
      windowById: (id) => (views[id] ? { isNull: false, mainView: { image: views[id] } } : { isNull: true }),
    },
  });
  const ctx = {
    async pjsr(code) {
      emitted.push(code);
      try {
        const out = vm.runInContext(code, context);
        return { status: 'ok', outputs: { consoleOutput: String(out) } };
      } catch (e) {
        return { status: 'error', error: { message: e.message } };
      }
    },
    async listImages() { return Object.keys(views).map((id) => ({ id })); },
  };
  return { api: apiFrom(ctx), emitted };
}

const parse = (out) => JSON.parse(out.text);

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

test('measure.mjs exports measure_uniformity and the eleven folded measure_* tools', () => {
  assert.deepEqual(Object.keys(byName), ['measure_uniformity', ...FOLDED_MEASURES]);
  for (const t of tools) assert.equal(t.handler.length, 2, t.name);
});

test('the image-metrics helper module exports no tools array', async () => {
  const mod = await import('../src/tools/image-metrics.mjs');
  assert.equal(mod.tools, undefined);
});

test('the folded measure_* descriptions and parameters state what is measured, never a verdict or advice', () => {
  for (const name of FOLDED_MEASURES) {
    const t = byName[name];
    const texts = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description ?? '')];
    for (const s of texts) {
      assert.doesNotMatch(s, VERDICT, `${name}: ${s}`);
      assert.doesNotMatch(s, ADVICE, `${name}: ${s}`);
    }
  }
});

test('no folded measure_* takes a target taxonomy or a verdict limit', () => {
  for (const name of FOLDED_MEASURES) {
    const props = Object.keys(byName[name].inputSchema.properties);
    for (const p of ['classification', 'category', 'prominence', 'max_p90']) assert.ok(!props.includes(p), `${name}.${p}`);
  }
});

// R8: a threshold that defines what is counted is a required input with no default.
const COUNTING_THRESHOLDS = {
  measure_star_layer: ['levels'],
  measure_ringing: ['min_amplitude'],
  measure_core_clipping: ['level'],
  measure_clipped_blocks: ['level', 'block_fraction'],
  measure_bright_chroma: ['brightness_threshold'],
};

test('every counting threshold is required and refused when missing, before any PJSR is sent', async () => {
  const complete = {
    measure_star_layer: { view_id: 'stars', levels: [0.98, 0.995] },
    measure_ringing: { view_id: 'RGB', min_amplitude: 0.01 },
    measure_core_clipping: { view_id: 'RGB', level: 0.93 },
    measure_clipped_blocks: { view_id: 'RGB', level: 0.95, block_fraction: 0.03 },
    measure_bright_chroma: { view_id: 'RGB', brightness_threshold: 0.5 },
  };
  for (const [name, params] of Object.entries(COUNTING_THRESHOLDS)) {
    const schema = byName[name].inputSchema;
    for (const p of params) {
      assert.ok(schema.required.includes(p), `${name}.${p} required`);
      assert.equal(schema.properties[p].default, undefined, `${name}.${p} has no default`);
      assert.doesNotMatch(schema.properties[p].description, /default/i, `${name}.${p} names no default`);
      const input = { ...complete[name] };
      delete input[p];
      const { api, emitted } = compilingApi();
      await assert.rejects(() => byName[name].handler(api, input), new RegExp(p), `${name} without ${p}`);
      assert.equal(emitted.length, 0, `${name} sent PJSR without ${p}`);
    }
  }
});

test('measure_star_layer refuses an empty or non-numeric levels list before any PJSR is sent', async () => {
  for (const levels of [[], ['0.98'], [0.98, Number.NaN], 0.98]) {
    const { api, emitted } = compilingApi();
    await assert.rejects(() => byName.measure_star_layer.handler(api, { view_id: 'stars', levels }), /levels/);
    assert.equal(emitted.length, 0);
  }
});

test('every folded measure_* reports a PixInsight error as a thrown error, never a made-up number', async () => {
  const inputs = {
    measure_stars: { view_id: 'RGB' },
    measure_star_layer: { view_id: 'stars', levels: [0.98] },
    measure_ringing: { view_id: 'RGB', min_amplitude: 0.01 },
    measure_sharpness: { view_id: 'RGB' },
    measure_core_clipping: { view_id: 'RGB', level: 0.93 },
    measure_clipped_blocks: { view_id: 'RGB', level: 0.95, block_fraction: 0.03 },
    measure_highlight_texture: { view_id: 'RGB' },
    measure_saturation: { view_id: 'RGB' },
    measure_tonal_presence: { view_id: 'RGB' },
    measure_bright_chroma: { view_id: 'RGB', brightness_threshold: 0.5 },
    measure_subject_detail: { view_id: 'RGB' },
  };
  for (const name of FOLDED_MEASURES) {
    const { api } = compilingApi({ replies: [{ status: 'error', error: { message: 'MCP_ABORTED: boom' } }], stats: { median: 0.1, max: 0.5 } });
    await assert.rejects(() => byName[name].handler(api, inputs[name]), /MCP_ABORTED: boom/, name);
    const garbled = compilingApi({ replies: ['not json'], stats: { median: 0.1, max: 0.5 } });
    await assert.rejects(() => byName[name].handler(garbled.api, inputs[name]), /could not read a measurement/, `${name}: unparseable output`);
  }
});

// ---------------------------------------------------------------------------
// measure_stars (was check_star_quality)
// ---------------------------------------------------------------------------

test('measure_stars reports the star measurements as JSON numbers', async () => {
  const reply = J({ starsFound: 100, starsMeasured: 28, medianFWHM: 3.5, colorDiversity: 0.1, fwhms: [3, 4], colorDivs: [0.1], medianPeak: 0.5,
    p25Peak: 0.3, bgMedian: 0.1, starBgContrast: 5, starPeaks: [0.2, 0.5] });
  const { api, emitted } = compilingApi({ replies: [reply] });
  const out = parse(await byName.measure_stars.handler(api, { view_id: 'RGB' }));
  assert.match(emitted[0], /windowById\("RGB"\)/);
  assert.deepEqual(out, {
    median_fwhm_px: 3.5, color_diversity: 0.1, stars_found: 100, stars_measured: 28, median_peak: 0.5, p25_peak: 0.3,
    background_median: 0.1, star_background_contrast: 5, samples: { fwhm: [3, 4], color: [0.1], peak: [0.2, 0.5] },
  });
});

test('measure_stars keeps the pack FWHM computation: 16 px scan over median + 5 MAD, half-max radius in four directions, doubled', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ medianFWHM: 1, starsFound: 0, starsMeasured: 0 })] });
  await byName.measure_stars.handler(api, { view_id: 'RGB' });
  for (const line of [
    'var threshold = bgMedian + 5 * bgMAD;', 'var step = 16;', 'var halfBox = 10;', 'if (dist < 20) { isDupe = true; break; }',
    'if (stars.length >= 100) break;', 'var topStars = stars.slice(0, 30);', 'var halfMax = s.peak / 2;',
    'if (getLum(px, py) < halfMax) { radii.push(r); break; }', 'if (radii.length >= 2) {', 'fwhms.push(avgRadius * 2); // FWHM = 2 * half-max radius',
    'var medFWHM = fwhms.length > 0 ? fwhms[Math.floor(fwhms.length / 2)] : 0;',
  ]) assert.ok(emitted[0].includes(line), line);
});

test('measure_stars measured on a synthetic star field: disc stars of radius 2 give a 6 px FWHM', async () => {
  // Stars on the 16 px scan grid, 32 px apart (so the 20 px de-duplication keeps each), colour 0.9/0.6/0.3.
  const centers = [];
  for (let cy = 11; cy < 120; cy += 32) for (let cx = 11; cx < 120; cx += 32) centers.push([cx, cy]);
  const star = [0.9, 0.6, 0.3];
  const img = new FakeImage(128, 128, 3, (x, y, c) => (centers.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= 4) ? star[c] : 0.05));
  const { api } = runtimeApi({ RGB: img });
  const out = parse(await byName.measure_stars.handler(api, { view_id: 'RGB' }));
  assert.equal(out.stars_found, centers.length);
  assert.equal(out.stars_measured, centers.length);
  assert.equal(out.median_fwhm_px, 6);
  assert.ok(Math.abs(out.color_diversity - (1 - 0.3 / 0.9)) < 1e-9, String(out.color_diversity));
  assert.equal(out.background_median, 0.05);
});

// ---------------------------------------------------------------------------
// measure_star_layer (was check_star_layer_integrity)
// ---------------------------------------------------------------------------

test('measure_star_layer counts pixels above each requested level and reports the stats median, with no verdict or record', async () => {
  const reply = J({ max_value: 0.9, fractions_above: [0.02, 0], color_diversity: 0.1, bright_star_chroma: 0.2, nonzero_pixel_count: 50000 });
  const { api, emitted } = compilingApi({ replies: [reply], stats: { median: 0.02, max: 0.9 } });
  const out = await byName.measure_star_layer.handler(api, { view_id: 'stars', levels: [0.98, 0.995] });
  assert.match(emitted[0], /var levels = \[0\.98,0\.995\];/);
  assert.doesNotMatch(emitted[0], /0\.98 \|\||> 0\.995/);
  assert.deepEqual(parse(out), {
    max: 0.9, median: 0.02, fraction_above: { 0.98: 0.02, 0.995: 0 }, color_diversity: 0.1, bright_star_chroma: 0.2, nonzero_pixel_count: 50000,
  });
});

test('measure_star_layer measured on a synthetic star layer', async () => {
  // 64x64 mono: 16 lit pixels on the 4 px sample grid; 4 of them above 0.98, 2 above 0.995.
  const lit = new Map();
  let k = 0;
  for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x += 4) lit.set(`${x},${y}`, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.99, 0.99, 0.999, 0.999][k++]);
  const img = new FakeImage(64, 64, 1, (x, y) => lit.get(`${x},${y}`) ?? 0);
  const { api } = runtimeApi({ stars: img });
  const out = parse(await byName.measure_star_layer.handler(api, { view_id: 'stars', levels: [0.98, 0.995] }));
  assert.equal(out.nonzero_pixel_count, 16);
  assert.deepEqual(out.fraction_above, { 0.98: 4 / 16, 0.995: 2 / 16 });
  assert.equal(out.max, 0.999);
  assert.equal(out.median, 0);
});

// ---------------------------------------------------------------------------
// measure_ringing (was check_ringing)
// ---------------------------------------------------------------------------

test('measure_ringing counts oscillations above min_amplitude and takes no classification', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ oscillations: 4, maxAmplitude: 0.02, center: [10, 10], profileSample: [0.5, 0.4] })] });
  const out = parse(await byName.measure_ringing.handler(api, { view_id: 'RGB', min_amplitude: 0.02 }));
  assert.match(emitted[0], /if \(amp > 0\.02\) \{/);
  assert.deepEqual(out, { oscillations: 4, max_amplitude: 0.02, center: [10, 10], profile_sample: [0.5, 0.4] });
  assert.ok(!('classification' in byName.measure_ringing.inputSchema.properties));
});

test('measure_ringing measured on a synthetic ringed profile: the amplitude floor decides what is counted', async () => {
  // A bright centre at (96,96), the middle of the brightest 64 px block, whose radial profile rises and falls with period 10 px and amplitude 0.05.
  const img = new FakeImage(200, 200, 1, (x, y) => {
    const r = Math.hypot(x - 96, y - 96);
    return 0.3 + 0.05 * Math.cos((2 * Math.PI * r) / 10) + (r < 32 ? 0.3 : 0);
  });
  const small = parse(await byName.measure_ringing.handler(runtimeApi({ L: img }).api, { view_id: 'L', min_amplitude: 0.01 }));
  const large = parse(await byName.measure_ringing.handler(runtimeApi({ L: img }).api, { view_id: 'L', min_amplitude: 10 }));
  assert.ok(small.oscillations > 0, J(small));
  assert.equal(large.oscillations, 0);
  assert.equal(large.max_amplitude, 0);
});

// ---------------------------------------------------------------------------
// measure_sharpness (was check_sharpness)
// ---------------------------------------------------------------------------

test('measure_sharpness passes a number-checked ROI into PJSR and returns JSON', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ sharpness: 0.001, samplesUsed: 100, roi: { x: 10, y: 20, w: 30, h: 40 } })] });
  const out = parse(await byName.measure_sharpness.handler(api, { view_id: 'L', roi_x: 10, roi_y: 20, roi_w: 30, roi_h: 40 }));
  assert.match(emitted[0], /var rx=10,ry=20,rw=30,rh=40;/);
  assert.deepEqual(out, { sharpness: 0.001, samples: 100, roi: { x: 10, y: 20, w: 30, h: 40 } });
  await assert.rejects(byName.measure_sharpness.handler(api, { view_id: 'L', roi_x: '1;evil()', roi_y: 0, roi_w: 1, roi_h: 1 }), /finite number/);
});

test('measure_sharpness without an ROI measures the central half of the image', async () => {
  const img = new FakeImage(40, 40, 1, (x) => (x % 2 ? 0.2 : 0.1));
  const out = parse(await byName.measure_sharpness.handler(runtimeApi({ L: img }).api, { view_id: 'L' }));
  assert.deepEqual(out.roi, { x: 10, y: 10, w: 20, h: 20 });
  assert.ok(out.sharpness > 0 && out.samples > 0);
});

// ---------------------------------------------------------------------------
// measure_core_clipping (was check_core_burning)
// ---------------------------------------------------------------------------

test('measure_core_clipping counts pixels above the given level in the 128 px and 32 px boxes', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ burntFraction: 0.05, innerBurntFraction: 0.2, peakValue: 0.99, coreCenter: [64, 64] })] });
  const out = parse(await byName.measure_core_clipping.handler(api, { view_id: 'RGB', level: 0.9 }));
  assert.match(emitted[0], /var level = 0\.9;/);
  assert.doesNotMatch(emitted[0], /0\.93/);
  assert.deepEqual(out, { fraction_above_wide: 0.05, fraction_above_inner: 0.2, peak: 0.99, core_center: [64, 64], wide_box: 128, inner_box: 32 });
});

test('measure_core_clipping measured on a synthetic core', async () => {
  // 256x256 mono, a 32x32 block of 1.0 centred in the brightest 64 px block at (128,128).
  const img = new FakeImage(256, 256, 1, (x, y) => (x >= 144 && x < 176 && y >= 144 && y < 176 ? 1 : 0.1));
  const out = parse(await byName.measure_core_clipping.handler(runtimeApi({ L: img }).api, { view_id: 'L', level: 0.93 }));
  assert.equal(out.fraction_above_inner, 1);
  assert.ok(Math.abs(out.fraction_above_wide - (32 * 32) / (128 * 128)) < 1e-9, String(out.fraction_above_wide));
  assert.equal(out.peak, 1);
});

// ---------------------------------------------------------------------------
// measure_clipped_blocks (was scan_burnt_regions)
// ---------------------------------------------------------------------------

test('measure_clipped_blocks splices level, block_fraction and block_size and returns the counts', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ burntBlockCount: 2, totalBlocks: 100, worstBlocks: [{ x: 1, y: 2, fraction: 0.1 }] })] });
  const out = parse(await byName.measure_clipped_blocks.handler(api, { view_id: 'RGB', level: 0.95, block_fraction: 0.03 }));
  assert.match(emitted[0], /var blockSize = 50;[\s\S]*var level = 0\.95;[\s\S]*var blockFraction = 0\.03;/);
  assert.deepEqual(out, { blocks_over: 2, total_blocks: 100, locations: [{ x: 1, y: 2, fraction: 0.1 }] });
  const b = compilingApi({ replies: [J({ burntBlockCount: 0, totalBlocks: 4, worstBlocks: [] })] });
  await byName.measure_clipped_blocks.handler(b.api, { view_id: 'RGB', level: 0.9, block_fraction: 0.5, block_size: 20 });
  assert.match(b.emitted[0], /var blockSize = 20;/);
  await assert.rejects(byName.measure_clipped_blocks.handler(b.api, { view_id: 'RGB', level: 0.9, block_fraction: 0.5, block_size: 2.5 }), /block_size/);
});

test('measure_clipped_blocks measured on a synthetic image', async () => {
  // 101x101 mono (four 50 px blocks), one block entirely at 1.0.
  const img = new FakeImage(101, 101, 1, (x, y) => (x < 50 && y < 50 ? 1 : 0.1));
  const out = parse(await byName.measure_clipped_blocks.handler(runtimeApi({ L: img }).api, { view_id: 'L', level: 0.95, block_fraction: 0.03 }));
  assert.equal(out.total_blocks, 4);
  assert.equal(out.blocks_over, 1);
  assert.deepEqual(out.locations, [{ x: 0, y: 0, fraction: 1 }]);
});

// ---------------------------------------------------------------------------
// measure_highlight_texture (was check_highlight_texture)
// ---------------------------------------------------------------------------

const shell = (sd, extra = {}) => J({ shellLocalStdDev: sd, shellTonalSpan: 0.2, shellGradientEnergy: 0.001, shellZone: { low: 0.3, high: 0.8 },
  shellPixelCount: 100, blockCount: 10, roi: { cx: 1, cy: 2, radius: 50 }, ...extra });

test('measure_highlight_texture measures the reference over the current ROI and reports retention ratios', async () => {
  const { api, emitted } = compilingApi({ replies: [shell(0.01), shell(0.04, { shellTonalSpan: 0.4 })] });
  const out = parse(await byName.measure_highlight_texture.handler(api, { view_id: 'after', reference_id: 'before' }));
  assert.match(emitted[0], /windowById\("after"\)/);
  assert.match(emitted[0], /var roiCx = -1;/);
  assert.match(emitted[1], /windowById\("before"\)/);
  assert.match(emitted[1], /var roiCx = 1;\s*var roiCy = 2;\s*var roiR = 50;/);
  assert.deepEqual(out, {
    current: { local_stddev: 0.01, tonal_span: 0.2, gradient_energy: 0.001 },
    reference: { local_stddev: 0.04, tonal_span: 0.4, gradient_energy: 0.001 },
    retention: { texture: 0.25, span: 0.5, gradient: 1 },
    shell_zone: { low: 0.3, high: 0.8 }, roi: { cx: 1, cy: 2, radius: 50 }, shell_pixel_count: 100, block_count: 10,
  });
});

test('measure_highlight_texture without a reference reports null reference and retention', async () => {
  const { api, emitted } = compilingApi({ replies: [shell(0.01)] });
  const out = parse(await byName.measure_highlight_texture.handler(api, { view_id: 'after' }));
  assert.equal(emitted.length, 1);
  assert.equal(out.reference, null);
  assert.equal(out.retention, null);
});

test('measure_highlight_texture reports a null ratio, not 1, when the reference value is ~0', async () => {
  const { api } = compilingApi({ replies: [shell(0.01), shell(0, { shellTonalSpan: 0, shellGradientEnergy: 0 })] });
  const out = parse(await byName.measure_highlight_texture.handler(api, { view_id: 'after', reference_id: 'before' }));
  assert.deepEqual(out.retention, { texture: null, span: null, gradient: null });
});

test('measure_highlight_texture with too few subject pixels is an error carrying the count', async () => {
  for (const replies of [[J({ error: 'too_few_subject_pixels', count: 42 })], [shell(0.01), J({ error: 'too_few_subject_pixels', count: 7 })]]) {
    const { api } = compilingApi({ replies });
    const out = await byName.measure_highlight_texture.handler(api, { view_id: 'after', reference_id: 'before' });
    assert.equal(out.isError, true);
    assert.match(out.text, /too few subject pixels/);
    assert.match(out.text, replies.length === 1 ? /\b42\b/ : /\b7\b.*before/);
    assert.doesNotMatch(out.text, /"pass"/);
  }
});

// ---------------------------------------------------------------------------
// measure_saturation (was check_saturation)
// ---------------------------------------------------------------------------

test('measure_saturation returns the saturation percentiles with no limit', async () => {
  const { api } = compilingApi({ replies: [J({ mono: false, medianS: 0.3, p90S: 0.8, p99S: 0.9, maxS: 1, subjectPixelCount: 1000 })] });
  const out = parse(await byName.measure_saturation.handler(api, { view_id: 'RGB' }));
  assert.deepEqual(out, { median: 0.3, p90: 0.8, p99: 0.9, max: 1, subject_pixel_count: 1000 });
});

test('measure_saturation and measure_bright_chroma on a mono image are errors', async () => {
  for (const [name, input] of [['measure_saturation', { view_id: 'L' }], ['measure_bright_chroma', { view_id: 'L', brightness_threshold: 0.5 }]]) {
    const { api } = compilingApi({ replies: [J({ mono: true })] });
    const out = await byName[name].handler(api, input);
    assert.equal(out.isError, true, name);
    assert.match(out.text, /mono/);
  }
});

// ---------------------------------------------------------------------------
// measure_tonal_presence (was check_tonal_presence)
// ---------------------------------------------------------------------------

test('measure_tonal_presence reports the numbers only: separation, core_to_disk always, subject_fraction instead of a confidence label', async () => {
  const reply = J({ separation: 2, subject_median: 0.2, background_median: 0.1, background_p90: 0.12, core_brightness: 0.5, faint_structure_visibility: 0.1,
    subject_fraction: 0.04, roi_mode: 'single', subjectPixelCount: 100, core_to_disk: 2.5 });
  const { api, emitted } = compilingApi({ replies: [reply] });
  const out = parse(await byName.measure_tonal_presence.handler(api, { view_id: 'RGB' }));
  assert.doesNotMatch(emitted[0], /roi_confidence|roiConfidence/);
  assert.deepEqual(out, { separation: 2, subject_median: 0.2, background_median: 0.1, core_brightness: 0.5, faint_structure_visibility: 0.1,
    core_to_disk: 2.5, subject_fraction: 0.04, roi_mode: 'single', subject_pixel_count: 100 });
});

// ---------------------------------------------------------------------------
// measure_bright_chroma (was check_bright_chroma)
// ---------------------------------------------------------------------------

test('measure_bright_chroma splices the required brightness threshold and returns the chroma statistics', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ mono: false, medianChroma: 0.01, meanChroma: 0.02, brightPixelCount: 500, p25Chroma: 0, p75Chroma: 0.03 })] });
  const out = parse(await byName.measure_bright_chroma.handler(api, { view_id: 'RGB', brightness_threshold: 0.6 }));
  assert.match(emitted[0], /var threshold = 0\.6;/);
  assert.deepEqual(out, { median_chroma: 0.01, mean_chroma: 0.02, p25_chroma: 0, p75_chroma: 0.03, bright_pixel_count: 500 });
});

// ---------------------------------------------------------------------------
// measure_subject_detail
// ---------------------------------------------------------------------------

test('measure_subject_detail reports brightness, detail and contrast as numbers, with no gate or goal', async () => {
  const { api } = compilingApi({ replies: [J({ subjectBrightness: 0.1, detailScore: 0.0002, contrastRatio: 2, subjectCount: 3, backgroundMedian: 0.05, subjectThreshold: 0.06 })] });
  const out = parse(await byName.measure_subject_detail.handler(api, { view_id: 'RGB' }));
  assert.deepEqual(out, { subject_brightness: 0.1, detail_score: 0.0002, contrast_ratio: 2, subject_count: 3, background_median: 0.05, subject_threshold: 0.06 });
});

// ---------------------------------------------------------------------------
// measure_uniformity (unchanged)
// ---------------------------------------------------------------------------

test('measure_uniformity tool wraps measureUniformity over the Pack API v1 shape', async () => {
  const { ctx, emitted } = createFakeBridge({
    replies: [JSON.stringify({ score: 0.0012, corners: [1, 1, 1, 1], mean: 1 })],
  });
  const out = await byName.measure_uniformity.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(emitted[0], /windowById\("RGB"\)/);
  assert.match(out.text, /"score": 0\.0012/);
});

test('measure_uniformity tool surfaces a PixInsight error', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'not found' } }] });
  await assert.rejects(() => byName.measure_uniformity.handler(apiFrom(ctx), { view_id: 'NOPE' }), /not found/);
});

test('measure_sharpness refuses a partial ROI before sending PJSR', async () => {
  for (const roi of [{ roi_y: 5 }, { roi_x: 1, roi_w: 10 }, { roi_x: 1, roi_y: 1, roi_w: 10 }]) {
    const { api, emitted } = compilingApi();
    await assert.rejects(byName.measure_sharpness.handler(api, { view_id: 'L', ...roi }), /roi_x, roi_y, roi_w and roi_h/, JSON.stringify(roi));
    assert.equal(emitted.length, 0);
  }
});

test('measure_sharpness refuses, in PixInsight, an ROI that is not inside the image', async () => {
  const { api, emitted } = compilingApi({ replies: [J({ sharpness: 0, samples: 0, roi: {} })] });
  await byName.measure_sharpness.handler(api, { view_id: 'L', roi_x: 10, roi_y: 20, roi_w: 30, roi_h: 40 });
  assert.match(emitted[0], /rx < 0 \|\| ry < 0 \|\| rx \+ rw > img\.width \|\| ry \+ rh > img\.height/);
});
