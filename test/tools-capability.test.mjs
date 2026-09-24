// Capability gate for the tools folded in from mxcoppell/pixinsight-pack-astro@eee19b3 (plan
// local/plans/2026-09-23-fold-pack-into-core.md, §0 and §4). test/contract.test.mjs stays the arbiter
// for descriptions; this file pins what a description test cannot see:
//
//   - no tool takes a target taxonomy input (classification, category, prominence)            R5
//   - every value that shapes the look is in inputSchema.required (REQUIRED below), so a
//     default cannot creep back unnoticed                                                      R1, R8
//   - a step that is opt-in refuses a partial set of its params (REQUIRED_TOGETHER below)      R2
//   - a folded tool's result reports numbers, never a verdict or advice (CALLS below)         R6
//   - every folded measure_* returns parseable JSON                                            C
//
// The tables grow with each fold task: a task that adds a folded tool adds its REQUIRED entry (an
// empty array for a tool with no look-shaping value) and a CALLS entry, or the coverage test fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { compilingApi } from './helpers.mjs';

// Every tool the fold adds (plan §1 and §3). T1 adds the name of the statistical stretch that
// replaces seti_stretch.
const FOLDED = [
  'robust_median_stretch',
  'auto_stretch', 'stretch_stars', 'continuous_clamp',
  'create_zone_masks', 'create_adaptive_zone_masks',
  'star_protected_blend', 'restore_star_color',
  'multi_scale_enhance', 'shell_detail_enhance', 'run_lhe', 'run_per_channel_abe',
  'ha_inject_red', 'ha_inject_luminance', 'extract_pseudo_oiii', 'continuum_subtract_ha',
  'dynamic_narrowband_blend', 'create_synthetic_luminance', 'lrgb_combine',
  'measure_stars', 'measure_star_layer', 'measure_ringing', 'measure_sharpness', 'measure_core_clipping',
  'measure_clipped_blocks', 'measure_highlight_texture', 'measure_saturation', 'measure_tonal_presence',
  'measure_bright_chroma', 'measure_subject_detail',
];

// Pack names that must not come back: renamed without aliases (§3) or dropped (Q2).
const RETIRED = [
  'check_star_quality', 'check_star_layer_integrity', 'check_ringing', 'check_sharpness', 'check_core_burning',
  'scan_burnt_regions', 'check_highlight_texture', 'check_saturation', 'check_tonal_presence', 'check_bright_chroma',
  'check_constraints', 'star_screen_blend',
];

// tool -> the params that must be in inputSchema.required (§1 "→ required").
// e.g. create_zone_masks: ['core_clip', 'shell_clip', 'halo_clip']
const REQUIRED = {
  create_zone_masks: ['core_clip', 'shell_clip', 'halo_clip'],
  create_adaptive_zone_masks: [],
  multi_scale_enhance: ['mask_clip_low', 'mask_blur', 'mask_gamma', 'lhe_fine_radius', 'lhe_fine_amount', 'lhe_mid_radius',
    'lhe_mid_amount', 'lhe_large_radius', 'lhe_large_amount', 'lhe_slope_limit', 'lhe_fine_slope_limit'],
  shell_detail_enhance: ['medium_sigma', 'medium_amount', 'large_sigma', 'large_amount', 'protect_knee', 'protect_softness'],
  run_lhe: [],
  robust_median_stretch: ['target_median', 'black_point_sigma'],
  stretch_stars: ['midtone', 'iterations'],
  auto_stretch: [],
  continuous_clamp: ['min_clamp', 'max_clamp', 'mode'],
  run_per_channel_abe: [],
  lrgb_combine: ['lightness', 'saturation'],
  star_protected_blend: ['strength', 'core_threshold_low', 'core_threshold_high', 'min_strength_fraction', 'max_value'],
  restore_star_color: ['restore_start', 'restore_end', 'max_value'],
  ha_inject_red: ['strength', 'brightness_limit'],
  ha_inject_luminance: ['strength'],
  extract_pseudo_oiii: ['continuum_factor'],
  continuum_subtract_ha: ['continuum_factor'],
  dynamic_narrowband_blend: ['ha_strength', 'oiii_strength', 'g_strength', 'g_ha_fraction', 'max_output', 'rolloff', 'mask_clip', 'mask_blur'],
  create_synthetic_luminance: ['ha_weight', 'oiii_weight'],
  measure_stars: [],
  measure_star_layer: ['levels'],
  measure_ringing: ['min_amplitude'],
  measure_sharpness: [],
  measure_core_clipping: ['level'],
  measure_clipped_blocks: ['level', 'block_fraction'],
  measure_highlight_texture: [],
  measure_saturation: [],
  measure_tonal_presence: [],
  measure_bright_chroma: ['brightness_threshold'],
  measure_subject_detail: [],
};

// tool -> groups of params an opt-in step needs together (§0 R2): given one member of a group, the call
// with any other member missing is refused (isError or a throw) before any PJSR is sent. `base` is an
// otherwise complete input.
// e.g. seti-replacement: [{ base: {...}, group: { hdr_amount: 0.25, hdr_headroom: 0.05, hdr_knee: 0.35 } }]
const REQUIRED_TOGETHER = {
  robust_median_stretch: [{ base: { view_id: 'L', target_median: 0.25, black_point_sigma: 2.8 }, group: { highlight_knee: 0.8, highlight_midtones: 0.7 } }],
  continuous_clamp: [{ base: { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft' }, group: { headroom: 0.12, rate: 3 } }],
  ha_inject_red: [{ base: { target_id: 'RGB', ha_id: 'Ha', strength: 0.3, brightness_limit: 0.25 }, group: { max_output: 0.85, rolloff: 0.2 } }],
};

// tool -> one representative call: { input, replies?, stats?, images? } for compilingApi(). Its result
// must not carry a verdict or advice; a measure_* result must be JSON.
const CALLS = {
  create_zone_masks: {
    input: { view_id: 'RGB', core_clip: 0.4, shell_clip: 0.15, halo_clip: 0.04 },
    replies: [JSON.stringify({ coreId: 'mask_core', shellId: 'mask_shell', haloId: 'mask_halo', thresholds: { core: 0.4, shell: 0.15, halo: 0.04 } })],
  },
  create_adaptive_zone_masks: {
    input: { view_id: 'RGB' },
    replies: [JSON.stringify({ coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer', roi: { cx: 1, cy: 2, radius: 3 }, thresholds: { core: 0.8, shellLow: 0.3, outer: 0.1 }, pixelCounts: { core: 5, shell: 50, outer: 500 } })],
  },
  multi_scale_enhance: {
    input: { view_id: 'L', mask_clip_low: 0.06, mask_blur: 5, mask_gamma: 2, lhe_fine_radius: 24, lhe_fine_amount: 0.2, lhe_mid_radius: 48,
      lhe_mid_amount: 0.3, lhe_large_radius: 100, lhe_large_amount: 0.3, lhe_slope_limit: 1.5, lhe_fine_slope_limit: 1.3, hdrmt_layers: 5 },
    replies: [JSON.stringify({ before: { detailScore: 0.001, brightPixels: 10 }, after: { detailScore: 0.00101, brightPixels: 10 }, improvement: 1,
      params: { lhe: {}, hdrmt: { applied: true, layers: 5 } } })],
  },
  shell_detail_enhance: {
    input: { view_id: 'L', medium_sigma: 18, medium_amount: 1, large_sigma: 55, large_amount: 0.5, protect_knee: 0.8, protect_softness: 4 },
    replies: [JSON.stringify({ isColor: false }), JSON.stringify({ before: {}, after: {}, improvement: 60, stddevImprovement: 1, maxAfter: 0.9, protectionEngaged: 40, params: {} })],
    stats: [{ median: 0.1, max: 0.9 }, { median: 0.1, max: 0.99 }],
  },
  run_lhe: { input: { view_id: 'L', radius: 64, amount: 0.3 }, replies: ['ok'] },
  robust_median_stretch: { input: { view_id: 'L', target_median: 0.25, black_point_sigma: 2.8 }, replies: [JSON.stringify({ channels: 1, joint: { median: 0.02, mad: 0.002 }, per: [{ median: 0.02, mad: 0.002 }] }), 'ok'] },
  stretch_stars: { input: { view_id: 'stars', midtone: 0.2, iterations: 5 }, replies: [JSON.stringify({ bgClip: 0.001, highFraction: 0.6, finalMedian: 0.01, finalMax: 1 })] },
  auto_stretch: { input: { view_id: 'L' }, stats: { median: 0.01, mad: 0.001, min: 0, max: 1 } },
  continuous_clamp: { input: { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft', headroom: 0.12, rate: 3 }, replies: [JSON.stringify({ median: 0.1, max: 0.9, blur_sigma: 60 })] },
  run_per_channel_abe: { input: { view_id: 'RGB', poly_degree: 1 }, replies: ['ok'], stats: { median: 0.1, max: 0.9 } },
  lrgb_combine: {
    input: { rgb_id: 'RGB', l_id: 'L', lightness: 0.5, saturation: 0.5, linear_fit_reject_high: 0.92 },
    replies: ['LinearFit done', 'LRGB_OK'], stats: { median: 0.1, max: 0.9 },
  },
  star_protected_blend: {
    input: { target_id: 'RGB', stars_id: 'stars', pre_star_id: 'RGB_pre', strength: 0.95, core_threshold_low: 0.6, core_threshold_high: 0.82, min_strength_fraction: 0.1, max_value: 0.98 },
    stats: { median: 0.1, max: 0.999 },
  },
  restore_star_color: { input: { target_id: 'RGB', pre_star_id: 'RGB_pre', restore_start: 0.6, restore_end: 0.82, max_value: 0.98 }, stats: { median: 0.1, max: 0.999 } },
  ha_inject_red: {
    input: { target_id: 'RGB', ha_id: 'Ha', strength: 0.3, brightness_limit: 0.25, max_output: 0.85, rolloff: 0.2 },
    replies: ['ok', JSON.stringify({ rMax: 0.99 })], stats: { median: 0.1, max: 0.99 },
  },
  ha_inject_luminance: { input: { target_id: 'RGB', ha_id: 'Ha', strength: 0.2 }, replies: ['ok'] },
  extract_pseudo_oiii: { input: { rgb_id: 'RGB', continuum_factor: 0.25 }, replies: [JSON.stringify({ viewId: 'OIII_pseudo', median: 0.02, max: 0.5 })] },
  continuum_subtract_ha: { input: { ha_id: 'Ha', rgb_id: 'RGB', continuum_factor: 0.28 }, replies: [JSON.stringify({ median: 0.01, max: 0.7 })] },
  dynamic_narrowband_blend: {
    input: { target_id: 'RGB', ha_id: 'Ha', oiii_id: 'OIII', ha_strength: 0.35, oiii_strength: 0.4, g_strength: 0.3, g_ha_fraction: 0.3, max_output: 0.9, rolloff: 0.2, mask_clip: 0.04, mask_blur: 10 },
    replies: [JSON.stringify({ median: 0.1, max: 0.99, rMax: 0.99, bMax: 0.99 })],
  },
  create_synthetic_luminance: {
    input: { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.5, oiii_weight: 0.5, max_value: 0.96 },
    replies: [JSON.stringify({ viewId: 'SYNTH_L', median: 0.1, max: 0.96 })],
  },
  // The measure_* replies below are the readings that made the pack print FAIL, WARNING or advice.
  measure_stars: { input: { view_id: 'RGB' }, replies: [JSON.stringify({ starsFound: 10, starsMeasured: 8, medianFWHM: 12, colorDiversity: 0.01, medianPeak: 0.1, p25Peak: 0.1, bgMedian: 0.1, starBgContrast: 1, fwhms: [12], colorDivs: [0.01], starPeaks: [0.1] })] },
  measure_star_layer: { input: { view_id: 'stars', levels: [0.98, 0.995] }, replies: [JSON.stringify({ max_value: 0.999, fractions_above: [0.05, 0.01], color_diversity: 0.01, bright_star_chroma: 0, nonzero_pixel_count: 500 })], stats: { median: 0.0001, max: 0.999 } },
  measure_ringing: { input: { view_id: 'RGB', min_amplitude: 0.01 }, replies: [JSON.stringify({ oscillations: 4, maxAmplitude: 0.02, center: [10, 10], profileSample: [] })] },
  measure_sharpness: { input: { view_id: 'L' }, replies: [JSON.stringify({ sharpness: 0.001, samplesUsed: 100, roi: { x: 0, y: 0, w: 10, h: 10 } })] },
  measure_core_clipping: { input: { view_id: 'RGB', level: 0.93 }, replies: [JSON.stringify({ burntFraction: 0.5, innerBurntFraction: 0.9, peakValue: 1, coreCenter: [5, 5] })] },
  measure_clipped_blocks: { input: { view_id: 'RGB', level: 0.95, block_fraction: 0.03 }, replies: [JSON.stringify({ burntBlockCount: 3, totalBlocks: 100, worstBlocks: [{ x: 0, y: 0, fraction: 0.5 }] })] },
  measure_highlight_texture: {
    input: { view_id: 'after', reference_id: 'before' },
    replies: [0.001, 0.05].map((sd) => JSON.stringify({ shellLocalStdDev: sd, shellTonalSpan: 0.2, shellGradientEnergy: 0.001, shellZone: { low: 0.3, high: 0.8 }, shellPixelCount: 100, blockCount: 10, roi: { cx: 1, cy: 1, radius: 50 } })),
  },
  measure_saturation: { input: { view_id: 'RGB' }, replies: [JSON.stringify({ mono: false, medianS: 0.7, p90S: 0.95, p99S: 1, maxS: 1, subjectPixelCount: 1000 })] },
  measure_tonal_presence: { input: { view_id: 'RGB' }, replies: [JSON.stringify({ separation: 1.5, subject_median: 0.15, background_median: 0.1, core_brightness: 0.3, faint_structure_visibility: 0.1, core_to_disk: 2, subject_fraction: 0.05, roi_mode: 'single', subjectPixelCount: 100 })] },
  measure_bright_chroma: { input: { view_id: 'RGB', brightness_threshold: 0.5 }, replies: [JSON.stringify({ mono: false, medianChroma: 0.01, meanChroma: 0.01, brightPixelCount: 500, p25Chroma: 0, p75Chroma: 0.02 })] },
  measure_subject_detail: { input: { view_id: 'RGB' }, replies: [JSON.stringify({ subjectBrightness: 0.1, detailScore: 0.0001, contrastRatio: 1.5, subjectCount: 2, backgroundMedian: 0.07, subjectThreshold: 0.08 })] },
};

// Verdict and advice markers the pack's results carried (§0 R6).
const VERDICT = /\b(?:PASS(?:ED)?|FAIL(?:ED)?|ADVISORY|WARN(?:ING)?|BLOCKED|REFUSED|HARD GATE)\b|\b(?:limit|goal):|⚠️|⚡/;

const catalog = await buildCoreCatalog();
const defs = new Map(catalog.definitions.map((d) => [d.name, d]));
const present = FOLDED;

test('every folded tool is in the catalog', () => {
  assert.deepEqual(FOLDED.filter((n) => !defs.has(n)), []);
});

// A handler returns { text }, { content: [...] }, a string or an array of those (src/server.mjs normalize).
function resultText(out) {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map(resultText).join('\n');
  if (out?.content) return out.content.map((c) => c.text ?? '').join('\n');
  return out?.text ?? '';
}

test('the verdict pattern catches what the pack printed and passes plain numbers', () => {
  for (const s of ['[PASS] ok', 'FAIL: max', 'ADVISORY: x', 'WARNING hot', 'BLOCKED', 'REFUSED', 'HARD GATE', 'limit: 0.98', 'goal: > 0.35', '⚠️ reduce', '⚡ BRIGHT']) {
    assert.match(s, VERDICT, s);
  }
  for (const s of ['{"median":0.1,"max":0.9}', 'median=0.100000, max=0.9000', 'stars_measured: 42', 'Stretched RGB']) {
    assert.doesNotMatch(s, VERDICT, s);
  }
});

test('no tool takes a target taxonomy input', () => {
  const offenders = catalog.definitions.flatMap((d) => Object.keys(d.inputSchema.properties ?? {})
    .filter((p) => /^(?:classification|category|prominence)$/.test(p)).map((p) => `${d.name}.${p}`));
  assert.deepEqual(offenders, []);
});

test('no retired pack name is a tool', () => {
  assert.deepEqual(RETIRED.filter((n) => defs.has(n)), []);
});

test('every folded tool in the catalog has a REQUIRED and a CALLS entry, and every entry names a folded tool in the catalog', () => {
  for (const n of present) {
    assert.ok(n in REQUIRED, `${n}: add its REQUIRED entry ([] when it has no look-shaping value)`);
    assert.ok(n in CALLS, `${n}: add a CALLS entry`);
  }
  for (const n of new Set([...Object.keys(REQUIRED), ...Object.keys(REQUIRED_TOGETHER), ...Object.keys(CALLS)])) {
    assert.ok(present.includes(n), `${n}: in a table but not a folded tool in the catalog`);
  }
});

test('every look-shaping value is a required input, with no default', () => {
  for (const [name, params] of Object.entries(REQUIRED)) {
    const schema = defs.get(name).inputSchema;
    for (const p of params) {
      assert.ok(schema.properties?.[p], `${name}.${p}: not an input`);
      assert.ok(schema.required?.includes(p), `${name}.${p}: not in inputSchema.required`);
      assert.equal(schema.properties[p].default, undefined, `${name}.${p}: has a default`);
    }
  }
});

test('an opt-in step refuses a partial set of its params before any PJSR is sent', async () => {
  for (const [name, cases] of Object.entries(REQUIRED_TOGETHER)) {
    const handler = catalog.handlers.get(name);
    for (const { base, group } of cases) {
      for (const missing of Object.keys(group)) {
        const input = { ...base, ...group };
        delete input[missing];
        const { api, emitted } = compilingApi();
        let refused;
        try {
          refused = (await handler(api, input))?.isError === true;
        } catch {
          refused = true;
        }
        assert.ok(refused, `${name}: ran without ${missing}`);
        assert.equal(emitted.length, 0, `${name}: sent PJSR without ${missing}`);
      }
    }
  }
});

test('a folded tool reports numbers, never a verdict or advice; a folded measure_* returns JSON', async () => {
  for (const [name, call] of Object.entries(CALLS)) {
    const { api } = compilingApi(call);
    const out = await catalog.handlers.get(name)(api, call.input);
    const text = resultText(out);
    assert.doesNotMatch(text, VERDICT, `${name}: ${text}`);
    if (name.startsWith('measure_')) assert.doesNotThrow(() => JSON.parse(text), `${name}: result is not JSON: ${text}`);
  }
});

test('every folded tool refuses arguments its schema does not list (additionalProperties: false)', () => {
  const open = FOLDED.filter((n) => defs.get(n)?.inputSchema?.additionalProperties !== false);
  assert.deepEqual(open, []);
});

test('every representative call passes only arguments its tool lists', () => {
  const extra = Object.entries(CALLS).flatMap(([n, c]) => Object.keys(c.input)
    .filter((k) => !(k in (defs.get(n).inputSchema.properties ?? {}))).map((k) => `${n}.${k}`));
  assert.deepEqual(extra, []);
});
