// src/tools/narrowband.mjs: ha_inject_red, ha_inject_luminance, extract_pseudo_oiii,
// continuum_subtract_ha, dynamic_narrowband_blend and create_synthetic_luminance, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/narrowband.mjs; its test/pack-astro-narrowband.test.mjs
// and the narrowband case of pack-astro-errors.test.mjs). continuous_clamp moved to tone.mjs and
// lrgb_combine to channels.mjs. Every look-shaping value is a required input, the soft clamps and
// caps are opt-in, the hidden NoiseXTerminator pass is gone, and results report numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/tools/narrowband.mjs';
import { compilingApi } from './helpers.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const STATS = { median: 0.1, max: 0.9 };
const VERDICT = /\b(?:PASS(?:ED)?|FAIL(?:ED)?|WARN(?:ING)?|REFUSED|BLOCKED)\b|⚠️|\bhot\b/i;

async function refusesWithout(tool, full, params, opts = {}) {
  for (const p of params) {
    const { api, emitted } = compilingApi({ stats: STATS, ...opts });
    const input = { ...full };
    delete input[p];
    await assert.rejects(tool.handler(api, input), new RegExp(p), `${tool.name} without ${p}`);
    assert.equal(emitted.length, 0, `${tool.name} sent PJSR without ${p}`);
  }
}

function assertRequired(tool, params) {
  for (const p of params) {
    assert.ok(tool.inputSchema.required.includes(p), `${tool.name}.${p} not required`);
    assert.equal(tool.inputSchema.properties[p].default, undefined, `${tool.name}.${p}`);
  }
}

test('narrowband.mjs exports the six narrowband tools; continuous_clamp and lrgb_combine live elsewhere', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['continuum_subtract_ha', 'create_synthetic_luminance', 'dynamic_narrowband_blend',
    'extract_pseudo_oiii', 'ha_inject_luminance', 'ha_inject_red']);
});

// --- ha_inject_red ---

const HIR = { target_id: 'RGB', ha_id: 'Ha', strength: 0.3, brightness_limit: 0.25 };

test('ha_inject_red requires strength and brightness_limit; max_output and rolloff are optional', async () => {
  const t = byName.ha_inject_red;
  assertRequired(t, ['strength', 'brightness_limit']);
  assert.ok(!t.inputSchema.required.includes('max_output'));
  assert.ok(!t.inputSchema.required.includes('rolloff'));
  await refusesWithout(t, HIR, ['strength', 'brightness_limit']);
});

test('ha_inject_red without max_output boosts R only where Ha exceeds it, with no soft clamp', async () => {
  const t = byName.ha_inject_red;
  const { api, emitted } = compilingApi({ replies: ['ok', JSON.stringify({ rMax: 0.95 })], stats: STATS });
  const out = await t.handler(api, HIR);
  assert.match(emitted[0], /PM\.expression = "iif\(Ha > RGB\[0\] \* \(1 \+ 0\.25\), RGB\[0\] \+ 0\.3 \* \(Ha - RGB\[0\]\), RGB\[0\]\)";/);
  assert.match(emitted[0], /PM\.expression1 = "RGB\[1\]"/);
  assert.doesNotMatch(emitted[0], /0\.85|0\.2\b/);
  assert.match(out.text, /R_max=0\.9500/);
  assert.match(out.text, /max_output=none/);
  assert.doesNotMatch(out.text, VERDICT, out.text);
});

test('ha_inject_red with max_output and rolloff soft-clamps R above max_output at the given roll-off', async () => {
  const t = byName.ha_inject_red;
  const { api, emitted } = compilingApi({ replies: ['ok', JSON.stringify({ rMax: 0.95 })], stats: STATS });
  const out = await t.handler(api, { ...HIR, max_output: 0.85, rolloff: 0.2 });
  assert.ok(emitted[0].includes('iif(Ha > RGB[0] * (1 + 0.25), RGB[0] + 0.3 * (Ha - RGB[0]), RGB[0])'), emitted[0]);
  assert.match(emitted[0], /> 0\.85, 0\.85 \+ \(.*\) \* 0\.2, /);
  assert.match(out.text, /max_output=0\.85, rolloff=0\.2/);
  assert.doesNotMatch(out.text, /near clipping|reduce/i);
});

test('ha_inject_red refuses max_output without rolloff and rolloff without max_output', async () => {
  const t = byName.ha_inject_red;
  for (const extra of [{ max_output: 0.85 }, { rolloff: 0.2 }]) {
    const { api, emitted } = compilingApi({ stats: STATS });
    await assert.rejects(t.handler(api, { ...HIR, ...extra }), /max_output.*rolloff|rolloff.*max_output/);
    assert.equal(emitted.length, 0);
  }
});

test('narrowband tools refuse a view id that is not a PixInsight identifier', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  await assert.rejects(byName.ha_inject_red.handler(api, { ...HIR, ha_id: 'Ha)*0+evil(' }), /view identifier/);
  assert.equal(emitted.length, 0);
});

test('ha_inject_red surfaces a failed PixelMath instead of reporting success', async () => {
  const { api } = compilingApi({ replies: [{ status: 'error', error: { message: 'Ha not found' } }], stats: STATS });
  await assert.rejects(byName.ha_inject_red.handler(api, HIR), /ha_inject_red failed: Ha not found/);
});

// --- ha_inject_luminance ---

test('ha_inject_luminance requires strength (no fallback) and adds strength x the Ha excess, colour-preserving', async () => {
  const t = byName.ha_inject_luminance;
  assertRequired(t, ['strength']);
  await refusesWithout(t, { target_id: 'RGB', ha_id: 'Ha', strength: 0.2 }, ['strength']);
  const { api, emitted } = compilingApi();
  await t.handler(api, { target_id: 'RGB', ha_id: 'Ha', strength: 0.2 });
  assert.ok(emitted[0].includes('$T + 0.2 * max(Ha - (0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]), 0) * $T /'), emitted[0]);
});

// --- continuum_subtract_ha ---

test('continuum_subtract_ha requires continuum_factor and removes factor x R from Ha', async () => {
  const t = byName.continuum_subtract_ha;
  assertRequired(t, ['continuum_factor']);
  await refusesWithout(t, { ha_id: 'Ha', rgb_id: 'RGB', continuum_factor: 0.1 }, ['continuum_factor']);
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ median: 0.01, max: 0.7 })] });
  const out = await t.handler(api, { ha_id: 'Ha', rgb_id: 'RGB', continuum_factor: 0.1 });
  assert.match(emitted[0], /"max\(0, Ha - 0\.1 \* RGB\[0\]\)"/);
  assert.match(out.text, /factor=0\.1\)/);
});

// --- extract_pseudo_oiii ---

test('extract_pseudo_oiii requires continuum_factor and runs no NoiseXTerminator pass', async () => {
  const t = byName.extract_pseudo_oiii;
  assertRequired(t, ['continuum_factor']);
  await refusesWithout(t, { rgb_id: 'RGB', continuum_factor: 0.3 }, ['continuum_factor']);
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ viewId: 'OIII_pseudo', median: 0.02, max: 0.5 })] });
  const out = await t.handler(api, { rgb_id: 'RGB', continuum_factor: 0.3 });
  assert.match(emitted[0], /Math\.max\(0, b - 0\.3 \* r\)/);
  assert.match(emitted[0], /new ImageWindow\(w, h, 1, 32, true, false, "OIII_pseudo"\)/);
  assert.doesNotMatch(emitted[0], /NoiseXTerminator|denoise/);
  assert.match(out.text, /Pseudo-OIII extracted: OIII_pseudo/);
});

test('extract_pseudo_oiii writes to output_id when given', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ viewId: 'O3', median: 0.02, max: 0.5 })] });
  await byName.extract_pseudo_oiii.handler(api, { rgb_id: 'RGB', continuum_factor: 0.3, output_id: 'O3' });
  assert.match(emitted[0], /new ImageWindow\(w, h, 1, 32, true, false, "O3"\)/);
});

// --- dynamic_narrowband_blend ---

const DNB_REQUIRED = { ha_strength: 0.35, oiii_strength: 0.4, g_strength: 0.3, max_output: 0.9, mask_clip: 0.04, mask_blur: 10, g_ha_fraction: 0.3, rolloff: 0.2 };
const DNB = { target_id: 'RGB', ha_id: 'Ha', oiii_id: 'OIII', ...DNB_REQUIRED };

test('dynamic_narrowband_blend requires every strength, the clamp, the mask values, the Ha->G fraction and the roll-off', async () => {
  const t = byName.dynamic_narrowband_blend;
  assertRequired(t, Object.keys(DNB_REQUIRED));
  await refusesWithout(t, DNB, Object.keys(DNB_REQUIRED));
});

test('dynamic_narrowband_blend weights G by (OIII*Ha)^(1-OIII*Ha) through a clipped luminance mask, all at the given values', async () => {
  const t = byName.dynamic_narrowband_blend;
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ median: 0.1, max: 0.97, rMax: 0.97, bMax: 0.95 })] });
  const out = await t.handler(api, { ...DNB, mask_blur: 14, g_ha_fraction: 0.25, rolloff: 0.15, mask_clip: 0.05 });
  const pjsr = emitted[0];
  assert.ok(pjsr.includes('exp((1 - OIII * Ha) * ln(max(OIII * Ha, 0.00001)))'), pjsr);
  assert.match(pjsr, /C\.sigma = 14;/);
  assert.match(pjsr, /var clipVal = 0\.05;/);
  assert.ok(pjsr.includes('* 0.35 * 0.25 * Ha'), 'Ha->G fraction is the given value');
  assert.ok(pjsr.includes('> 0.9, 0.9 + ('), pjsr);
  assert.ok(pjsr.includes(') * 0.15, '), 'roll-off is the given value');
  assert.doesNotMatch(pjsr, /C\.sigma = 10;|\* 0\.3 \* Ha|\* 0\.20,/);
  assert.match(pjsr, /tgtW\.mask = maskW;/);
  assert.match(out.text, /R_max=0\.9700, B_max=0\.9500/);
  assert.doesNotMatch(out.text, VERDICT, out.text);
});

// --- create_synthetic_luminance ---

test('create_synthetic_luminance requires both weights; without max_value it only truncates to [0,1]', async () => {
  const t = byName.create_synthetic_luminance;
  assertRequired(t, ['ha_weight', 'oiii_weight']);
  assert.ok(!t.inputSchema.required.includes('max_value'));
  await refusesWithout(t, { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.6, oiii_weight: 0.4 }, ['ha_weight', 'oiii_weight']);
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ viewId: 'SYNTH_L', median: 0.1, max: 1 })] });
  await t.handler(api, { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.6, oiii_weight: 0.4 });
  assert.match(emitted[0], /PM\.expression = "0\.6 \* Ha \+ 0\.4 \* OIII";/);
  assert.doesNotMatch(emitted[0], /0\.96/);
  assert.match(emitted[0], /PM\.newImageId = "SYNTH_L";/);
});

test('create_synthetic_luminance caps at max_value when given', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ viewId: 'SYNTH_L', median: 0.1, max: 0.96 })] });
  await byName.create_synthetic_luminance.handler(api, { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.6, oiii_weight: 0.4, max_value: 0.96 });
  assert.match(emitted[0], /"min\(0\.6 \* Ha \+ 0\.4 \* OIII, 0\.96\)"/);
});

// --- descriptions ---

test('narrowband descriptions carry no recommendation, target type or ordering advice', () => {
  for (const t of tools) {
    const all = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)].join(' ');
    assert.doesNotMatch(all, /recommend|default|community|natural|prevent|protects? background|for emission|emission objects|better|more subtle|Use with|Use as|BEFORE|increments|Range \d|\b0\.\d+-0\.\d+/i, `${t.name}: ${all}`);
  }
});

test('extract_pseudo_oiii and create_synthetic_luminance refuse an output_id that names an input view', async () => {
  const cases = [
    [byName.extract_pseudo_oiii, { rgb_id: 'RGB', continuum_factor: 0.25, output_id: 'RGB' }],
    [byName.create_synthetic_luminance, { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.5, oiii_weight: 0.5, output_id: 'Ha' }],
    [byName.create_synthetic_luminance, { ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.5, oiii_weight: 0.5, output_id: 'OIII' }],
  ];
  for (const [t, input] of cases) {
    const { api, emitted } = compilingApi({ stats: STATS });
    await assert.rejects(t.handler(api, input), /output_id .* is an input view/, t.name);
    assert.equal(emitted.length, 0, t.name);
  }
});

test('dynamic_narrowband_blend refuses mask_clip outside [0, 1) before sending PJSR', async () => {
  for (const v of [1, -0.01]) {
    const { api, emitted } = compilingApi({ stats: STATS });
    await assert.rejects(byName.dynamic_narrowband_blend.handler(api, { ...DNB, mask_clip: v }), /mask_clip/);
    assert.equal(emitted.length, 0);
  }
});

test('dynamic_narrowband_blend writes the mask rescale divisor at full precision', async () => {
  const { api, emitted } = compilingApi({ stats: STATS, replies: [JSON.stringify({})] });
  await byName.dynamic_narrowband_blend.handler(api, { ...DNB, mask_clip: 0.9999999 }).catch(() => {});
  assert.ok(emitted.length > 0);
  assert.doesNotMatch(emitted[0], /toFixed/);
  assert.match(emitted[0], /\/' \+ "0\.0000000999999999\d*" \+ '\)/);
});
