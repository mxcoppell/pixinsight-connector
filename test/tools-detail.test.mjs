// src/tools/detail.mjs: multi_scale_enhance and shell_detail_enhance, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/detail.mjs; its test/pack-astro-detail.test.mjs and
// the detail case of pack-astro-errors.test.mjs). Every look-shaping value is a required input, the
// HDRMT pass and the automatic shell mask are opt-in, and results report numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/tools/detail.mjs';
import { compilingApi } from './helpers.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const mse = byName.multi_scale_enhance;
const shell = byName.shell_detail_enhance;

const MSE_REQUIRED = {
  mask_clip_low: 0.06, mask_blur: 5, mask_gamma: 2.0,
  lhe_fine_radius: 24, lhe_fine_amount: 0.20, lhe_mid_radius: 48, lhe_mid_amount: 0.30,
  lhe_large_radius: 100, lhe_large_amount: 0.30, lhe_slope_limit: 1.5, lhe_fine_slope_limit: 1.3,
};
const mseInput = (extra = {}) => ({ view_id: 'L', ...MSE_REQUIRED, ...extra });
const mseReply = (improvement = 20) => JSON.stringify({
  before: { detailScore: 0.001, brightPixels: 10 },
  after: { detailScore: 0.0012, brightPixels: 11 },
  improvement,
  params: { lhe: { fine: { r: 24, a: 0.2 }, mid: { r: 48, a: 0.3 }, large: { r: 100, a: 0.3 } }, hdrmt: { applied: false, layers: null } },
});

const SHELL_REQUIRED = { medium_sigma: 18, medium_amount: 1.0, large_sigma: 55, large_amount: 0.5, protect_knee: 0.80, protect_softness: 4.0 };
const shellInput = (extra = {}) => ({ view_id: 'RGB', ...SHELL_REQUIRED, ...extra });
const shellData = (extra = {}) => JSON.stringify({ before: {}, after: {}, improvement: 0, stddevImprovement: 0, maxAfter: 0.5, protectionEngaged: 0, params: {}, ...extra });
const STATS = { median: 0.1, mad: 0.01, min: 0, max: 0.5 };

test('detail.mjs exports multi_scale_enhance and shell_detail_enhance only', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['multi_scale_enhance', 'shell_detail_enhance']);
});

// --- multi_scale_enhance ---

test('multi_scale_enhance requires every mask and LHE value, and has no classification input', () => {
  assert.deepEqual([...mse.inputSchema.required].sort(), ['view_id', ...Object.keys(MSE_REQUIRED)].sort());
  for (const p of Object.keys(MSE_REQUIRED)) assert.equal(mse.inputSchema.properties[p].default, undefined, p);
  assert.equal(mse.inputSchema.properties.classification, undefined);
  assert.equal(mse.inputSchema.properties.do_hdrmt, undefined, 'hdrmt_layers turns the HDRMT pass on');
});

test('multi_scale_enhance refuses a call missing any required value before sending PJSR', async () => {
  for (const p of Object.keys(MSE_REQUIRED)) {
    const { api, emitted } = compilingApi({ replies: [mseReply()] });
    const input = mseInput();
    delete input[p];
    await assert.rejects(mse.handler(api, input), new RegExp(p), p);
    assert.equal(emitted.length, 0, p);
  }
});

test('multi_scale_enhance runs the mask and three LHE scales with the given values, fine scale at its own slope limit', async () => {
  const { api, emitted } = compilingApi({ replies: [mseReply()] });
  const out = await mse.handler(api, mseInput({ lhe_large_radius: 120, lhe_fine_amount: 0.15, lhe_slope_limit: 1.8, lhe_fine_slope_limit: 1.6 }));
  assert.equal(emitted.length, 1);
  assert.match(emitted[0], /LHE1\.radius = 120;/);
  assert.match(emitted[0], /LHE1\.slopeLimit = 1\.8;/);
  assert.match(emitted[0], /LHE3\.amount = 0\.15;/);
  assert.match(emitted[0], /LHE3\.slopeLimit = 1\.6;/, 'no hidden 1.3 cap on the fine scale');
  assert.doesNotMatch(emitted[0], /circularKernel/, 'PixInsight\'s own default kernel shape');
  assert.match(emitted[0], /- 0\.06\) \/ \(1 - 0\.06\)/);
  assert.match(emitted[0], /blur\.sigma = 5;/);
  assert.match(emitted[0], /w\.mask = maskWin;/);
  assert.match(out.text, /Improvement: \+20\.0%/);
});

test('multi_scale_enhance runs no HDRMT unless hdrmt_layers is given', async () => {
  const { api, emitted } = compilingApi({ replies: [mseReply()] });
  await mse.handler(api, mseInput());
  assert.doesNotMatch(emitted[0], /HDRMultiscaleTransform/);
});

test('multi_scale_enhance HDRMT: hdrmt_layers turns it on, the other HDRMT values are PixInsight defaults unless given', async () => {
  const bare = compilingApi({ replies: [mseReply()] });
  await mse.handler(bare.api, mseInput({ hdrmt_layers: 5 }));
  assert.match(bare.emitted[0], /new HDRMultiscaleTransform/);
  assert.match(bare.emitted[0], /HDRMT\.numberOfLayers = 5;/);
  assert.doesNotMatch(bare.emitted[0], /HDRMT\.(?:numberOfIterations|invertedIterations|medianTransform|toLightness|lightnessMask)\b/);

  const full = compilingApi({ replies: [mseReply()] });
  await mse.handler(full.api, mseInput({ hdrmt_layers: 5, hdrmt_iterations: 1, hdrmt_inverted: true, hdrmt_median_transform: 'true', hdrmt_to_lightness: true }));
  assert.match(full.emitted[0], /HDRMT\.numberOfIterations = 1;/);
  assert.match(full.emitted[0], /HDRMT\.toLightness = true;/);
  assert.match(full.emitted[0], /HDRMT\.invertedIterations = true;/);
  assert.match(full.emitted[0], /HDRMT\.medianTransform = true;/);
});

test('multi_scale_enhance refuses an HDRMT value without hdrmt_layers before sending PJSR', async () => {
  for (const extra of [{ hdrmt_median_transform: true }, { hdrmt_inverted: false }, { hdrmt_iterations: 2 }, { hdrmt_to_lightness: true }]) {
    const { api, emitted } = compilingApi({ replies: [mseReply()] });
    await assert.rejects(mse.handler(api, mseInput(extra)), /hdrmt_layers/, JSON.stringify(extra));
    assert.equal(emitted.length, 0);
  }
});

test('multi_scale_enhance validates its numbers', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(mse.handler(api, mseInput({ mask_blur: '5; evil()' })), /finite number/);
  await assert.rejects(mse.handler(api, mseInput({ mask_gamma: 0 })), /mask_gamma/);
  await assert.rejects(mse.handler(api, mseInput({ hdrmt_layers: 4.5 })), /integer/);
  assert.equal(emitted.length, 0);
});

test('multi_scale_enhance reports the numbers and no judgement of them', async () => {
  for (const improvement of [2, 80]) {
    const { api } = compilingApi({ replies: [mseReply(improvement)] });
    const out = await mse.handler(api, mseInput());
    assert.doesNotMatch(out.text, /WARNING|Try |check for artifacts|Strong improvement/i, out.text);
    assert.match(out.text, /HDRMT=off/);
  }
});

test('multi_scale_enhance reports a failed run as an error result', async () => {
  const { api } = compilingApi({ replies: [{ status: 'error', error: { message: 'no mask' } }] });
  const out = await mse.handler(api, mseInput());
  assert.equal(out.isError, true);
  assert.match(out.text, /multi_scale_enhance failed: no mask/);
});

// --- shell_detail_enhance ---

test('shell_detail_enhance requires every scale and protection value; auto_zone defaults to off', () => {
  assert.deepEqual([...shell.inputSchema.required].sort(), ['view_id', ...Object.keys(SHELL_REQUIRED)].sort());
  for (const p of Object.keys(SHELL_REQUIRED)) assert.equal(shell.inputSchema.properties[p].default, undefined, p);
  assert.equal(shell.inputSchema.properties.auto_zone.default, false);
  assert.ok(shell.inputSchema.properties.mask_id);
});

test('shell_detail_enhance refuses a call missing any required value before sending PJSR', async () => {
  for (const p of Object.keys(SHELL_REQUIRED)) {
    const { api, emitted } = compilingApi({ replies: [JSON.stringify({ isColor: true }), shellData()], stats: STATS });
    const input = shellInput({ mask_id: 'shell_mask' });
    delete input[p];
    await assert.rejects(shell.handler(api, input), new RegExp(p), p);
    assert.equal(emitted.length, 0, p);
  }
});

test('shell_detail_enhance adds amount x high-pass detail x a brightness protection factor', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ isColor: true }), shellData()], stats: STATS });
  const out = await shell.handler(api, shellInput({ mask_id: 'shell_mask', medium_amount: 1.2 }));
  assert.equal(emitted.length, 2);
  assert.match(emitted[1], /windowById\("shell_mask"\)/);
  assert.match(emitted[1], /'\$T \+ 1\.2 \* \(\$T - ' \+ blurId1 \+ '\) \* ' \+ protExpr/);
  assert.match(emitted[1], /exp\(-4 \* max\(0, \(0\.2126\*\$T\[0\]/);
  assert.match(out.text, /\[SHELL DETAIL ENHANCE\]/);
  assert.match(out.text, /mask=shell_mask/);
});

test('shell_detail_enhance with no mask_id and no auto_zone runs unmasked and builds no zone mask', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ isColor: false }), shellData()], stats: STATS });
  const out = await shell.handler(api, shellInput({ view_id: 'L' }));
  assert.equal(emitted.length, 2);
  assert.doesNotMatch(emitted.join('\n'), /azone_/);
  assert.match(out.text, /mask=none/);
});

test('shell_detail_enhance with auto_zone builds the adaptive shell mask and closes it afterwards', async () => {
  const zones = JSON.stringify({ coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer', roi: {}, thresholds: {}, pixelCounts: {} });
  const { api, emitted } = compilingApi({ replies: [zones, JSON.stringify({ isColor: false }), shellData(), 'ok'], stats: STATS });
  const out = await shell.handler(api, shellInput({ view_id: 'L', auto_zone: true }));
  assert.match(emitted[0], /'azone_shell'/);
  assert.match(emitted[2], /windowById\("azone_shell"\)/);
  assert.match(emitted[3], /azone_core.*azone_shell.*azone_outer/s);
  assert.match(out.text, /mask=azone_shell/);
});

test('shell_detail_enhance with auto_zone fails, changing nothing, when the shell mask cannot be built', async () => {
  const { api, emitted } = compilingApi({ replies: [{ status: 'error', error: { message: 'too few' } }, JSON.stringify({ isColor: false }), shellData()], stats: STATS });
  await assert.rejects(shell.handler(api, shellInput({ view_id: 'L', auto_zone: true })), /auto_zone could not build the adaptive shell mask: .*too few; the view was not modified/);
  assert.equal(emitted.length, 1, 'only the mask attempt was sent');
});

test('shell_detail_enhance skips a scale whose amount is 0 and runs any positive amount', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ isColor: false }), shellData()], stats: STATS });
  await shell.handler(api, shellInput({ view_id: 'L', mask_id: 'm', medium_amount: 0.005, large_amount: 0 }));
  assert.match(emitted[1], /if \(0\.005 > 0\)/);
  assert.match(emitted[1], /if \(0 > 0\)/);
});

test('shell_detail_enhance rejects a negative protect_softness', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(shell.handler(api, shellInput({ view_id: 'L', mask_id: 'm', protect_softness: -1 })), /protect_softness must be >= 0/);
  assert.equal(emitted.length, 0);
});

// e2e defect carried over from the pack: the printed "max" was a strided luminance sample (0.4111)
// while the real image peak went 0.5475 -> 0.7835.
test('shell_detail_enhance reports the real image max before and after, and labels the sampled value', async () => {
  const data = shellData({ improvement: 46.1, stddevImprovement: 6.1, maxAfter: 0.4111, protectionEngaged: 3 });
  const { api } = compilingApi({
    replies: [JSON.stringify({ isColor: true }), data],
    stats: [{ median: 0.17, max: 0.5475 }, { median: 0.17, max: 0.7835 }],
  });
  const out = await shell.handler(api, shellInput({ mask_id: 'shell_mask' }));
  assert.match(out.text, /image max 0\.5475 -> 0\.7835/i);
  assert.match(out.text, /sampled luminance max[^\n]*0\.4111/i);
  assert.doesNotMatch(out.text, /(^|[^d] )max=0\.4111/);
});

test('the detail descriptions state what the tools do, not which tool to prefer', () => {
  assert.doesNotMatch(shell.description, /without increasing peak/i);
  assert.match(shell.description, /maximum before and after/i);
  for (const t of tools) {
    assert.doesNotMatch(t.description, /COMPOUND|INSTEAD|EMISSION|emission|faster|run_lhe|multi_scale_enhance.*shell|clamp→flatten|If improvement/, t.name);
  }
});

test('multi_scale_enhance refuses mask_clip_low outside [0, 1) before sending PJSR', async () => {
  for (const v of [1, 1.2, -0.1]) {
    const { api, emitted } = compilingApi({ replies: [mseReply()] });
    await assert.rejects(mse.handler(api, mseInput({ mask_clip_low: v })), /mask_clip_low/);
    assert.equal(emitted.length, 0);
  }
});

test('shell_detail_enhance describes the protect_knee floor it applies', () => {
  assert.match(shell.description, /max\(1 - protect_knee, 0\.01\)/);
});
