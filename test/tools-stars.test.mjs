// src/tools/stars.mjs: star_protected_blend and restore_star_color, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/stars.mjs; its test/pack-astro-stars.test.mjs).
// Every look-shaping value is a required input, the hidden 0.98 colour cap is the required
// max_value, and the blend no longer depends on an integrity record left by another call (plan R7):
// the pack's precondition and refusal cases are gone, star_screen_blend is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/tools/stars.mjs';
import { compilingApi } from './helpers.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const blend = byName.star_protected_blend;
const restore = byName.restore_star_color;

const BLEND_REQUIRED = { strength: 0.95, core_threshold_low: 0.6, core_threshold_high: 0.82, min_strength_fraction: 0.1, max_value: 0.98 };
const blendInput = (extra = {}) => ({ target_id: 'RGB', stars_id: 'stars', ...BLEND_REQUIRED, ...extra });
const RESTORE_REQUIRED = { restore_start: 0.5, restore_end: 0.8, max_value: 0.98 };
const restoreInput = (extra = {}) => ({ target_id: 'RGB', pre_star_id: 'RGB_pre', ...RESTORE_REQUIRED, ...extra });
const STATS = { median: 0.1, max: 0.8 };
const VERDICT = /\b(?:PASS(?:ED)?|FAIL(?:ED)?|WARN(?:ING)?|REFUSED|BLOCKED)\b|⚠️/;

test('stars.mjs exports star_protected_blend and restore_star_color only (star_screen_blend is dropped)', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['restore_star_color', 'star_protected_blend']);
});

test('star_protected_blend requires every blend value and the colour cap, with no default', () => {
  assert.deepEqual([...blend.inputSchema.required].sort(), ['target_id', 'stars_id', ...Object.keys(BLEND_REQUIRED)].sort());
  for (const p of Object.keys(BLEND_REQUIRED)) {
    assert.equal(blend.inputSchema.properties[p].default, undefined, p);
    assert.doesNotMatch(blend.inputSchema.properties[p].description, /default/i, p);
  }
});

test('star_protected_blend refuses a call missing any required value before sending PJSR', async () => {
  for (const p of Object.keys(BLEND_REQUIRED)) {
    const { api, emitted } = compilingApi({ stats: STATS });
    const input = blendInput();
    delete input[p];
    await assert.rejects(blend.handler(api, input), new RegExp(p), p);
    assert.equal(emitted.length, 0, p);
  }
});

test('star_protected_blend refuses core_threshold_low >= core_threshold_high before sending PJSR', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  await assert.rejects(blend.handler(api, blendInput({ core_threshold_low: 0.8, core_threshold_high: 0.8 })), /core_threshold_low.*core_threshold_high/);
  assert.equal(emitted.length, 0);
});

test('star_protected_blend runs with no prior integrity check and reads no star-layer stats', async () => {
  const seen = [];
  const { api, emitted } = compilingApi({ overrides: { stats: async (id) => { seen.push(id); return STATS; } } });
  const out = await blend.handler(api, blendInput());
  assert.equal(emitted.length, 1);
  assert.equal(out.isError, undefined);
  assert.deepEqual(seen, ['RGB', 'RGB'], 'before/after stats of the target only');
});

test('star_protected_blend gates protection on the star brightness SL, not the target L', async () => {
  const { api, emitted } = compilingApi({ stats: [{ median: 0.1, max: 0.8 }, { median: 0.12, max: 0.9 }] });
  const out = await blend.handler(api, blendInput());
  assert.equal(emitted.length, 1);
  const pjsr = emitted[0];
  assert.ok(pjsr.includes('SL = (stars[0] + stars[1] + stars[2]) / 3'), pjsr);
  assert.ok(pjsr.includes('prot = iif(SL < 0.6, 1.0, iif(SL > 0.82, 0.1, 1.0 - 0.9000000000000000 * (SL - 0.6) / 0.2200000000000000))'), pjsr);
  assert.ok(pjsr.includes('w = iif(SL < 0.6, 0.0, iif(SL > 0.82, 1.0, (SL - 0.6) / 0.2200000000000000))'), pjsr);
  assert.doesNotMatch(pjsr, /iif\(L [<>]/, 'the ramps must not be gated on the starless target luminance');
  assert.ok(pjsr.includes('rgb = 1 - (1 - $T) * (1 - stars[0] * k)'), pjsr);
  assert.ok(pjsr.includes('k = 0.95 * prot'), pjsr);
  assert.match(out.text, /strength=0\.95/);
  assert.match(out.text, /median=0\.1200/);
});

test('star_protected_blend caps the colour-preserving branch at max_value, not a hidden 0.98', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  const out = await blend.handler(api, blendInput({ max_value: 0.9 }));
  assert.ok(emitted[0].includes('cp = min(RGB[0] * Lrgb / max(L, 0.001), 0.9)'), emitted[0]);
  assert.doesNotMatch(emitted[0], /0\.98/);
  assert.match(out.text, /max_value=0\.9/);
});

test('star_protected_blend restores bright-area colour from pre_star_id over the same ramp and cap', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  const out = await blend.handler(api, blendInput({ pre_star_id: 'RGB_pre', max_value: 0.97 }));
  assert.equal(emitted.length, 2);
  assert.ok(emitted[1].includes('restored = min(RGB_pre[0] * Lb / max(Lp, 0.001), 0.97)'), emitted[1]);
  assert.ok(emitted[1].includes('wr = iif(Lp < 0.6, 0.0, iif(Lp > 0.82, 1.0, (Lp - 0.6) / 0.2200000000000000))'), emitted[1]);
  assert.match(out.text, /colour restoration from RGB_pre/);
});

test('star_protected_blend treats an empty or null pre_star_id as "no restoration"', async () => {
  for (const pre of ['', null]) {
    const { api, emitted } = compilingApi({ stats: STATS });
    const out = await blend.handler(api, blendInput({ pre_star_id: pre }));
    assert.equal(emitted.length, 1);
    assert.doesNotMatch(out.text, /restoration/);
  }
});

test('star tools reject a non-identifier view id before sending anything', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  await assert.rejects(blend.handler(api, blendInput({ stars_id: 'x"+y' })), /view identifier/);
  await assert.rejects(restore.handler(api, restoreInput({ pre_star_id: 'a)*0+b(' })), /view identifier/);
  assert.equal(emitted.length, 0);
});

test('star_protected_blend surfaces a failed PixelMath', async () => {
  const { api } = compilingApi({ stats: STATS, replies: [{ status: 'error', error: { message: 'stars not found' } }] });
  await assert.rejects(blend.handler(api, blendInput()), /star blend failed: stars not found/);
});

test('restore_star_color requires the ramp and the colour cap, with no default', () => {
  assert.deepEqual([...restore.inputSchema.required].sort(), ['target_id', 'pre_star_id', ...Object.keys(RESTORE_REQUIRED)].sort());
  for (const p of Object.keys(RESTORE_REQUIRED)) assert.equal(restore.inputSchema.properties[p].default, undefined, p);
});

test('restore_star_color refuses a call missing any required value, or start >= end, before sending PJSR', async () => {
  for (const p of Object.keys(RESTORE_REQUIRED)) {
    const { api, emitted } = compilingApi({ stats: STATS });
    const input = restoreInput();
    delete input[p];
    await assert.rejects(restore.handler(api, input), new RegExp(p), p);
    assert.equal(emitted.length, 0, p);
  }
  const { api, emitted } = compilingApi({ stats: STATS });
  await assert.rejects(restore.handler(api, restoreInput({ restore_start: 0.8, restore_end: 0.5 })), /restore_start.*restore_end/);
  assert.equal(emitted.length, 0);
});

test('restore_star_color blends pre-star colour ratios in above restore_start, capped at max_value', async () => {
  const { api, emitted } = compilingApi({ stats: STATS });
  const out = await restore.handler(api, restoreInput({ max_value: 0.95 }));
  assert.ok(emitted[0].includes('wr = iif(Lp < 0.5, 0.0, iif(Lp > 0.8, 1.0, (Lp - 0.5) / 0.3000000000000000))'), emitted[0]);
  assert.ok(emitted[0].includes('restored = min(RGB_pre[1] * Lb / max(Lp, 0.001), 0.95)'), emitted[0]);
  assert.match(emitted[0], /P\.symbols = 'Lp, Lb, restored, wr';/);
  assert.match(out.text, /Colour restoration applied \(reference=RGB_pre, range=\[0\.5,0\.8\], max_value=0\.95\)/);
});

test('star tool results and descriptions carry no verdict, advice or precondition on another tool', async () => {
  const { api } = compilingApi({ stats: { median: 0.1, max: 0.999 } });
  const texts = [(await blend.handler(api, blendInput())).text, (await restore.handler(api, restoreInput())).text];
  for (const t of texts) assert.doesNotMatch(t, VERDICT, t);
  for (const t of tools) {
    const all = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)].join(' ');
    assert.doesNotMatch(all, /gorgeous|washout|washed out|PRECONDITION|check_star_layer_integrity|measure_star_layer|stretch_stars|\bUse when\b|default/i, t.name);
  }
});

test('the star ramps divide by the exact threshold range, however narrow', async () => {
  const b = compilingApi({ stats: STATS });
  await blend.handler(b.api, blendInput({ core_threshold_low: 0.6, core_threshold_high: 0.6000001 })).catch(() => {});
  assert.ok(b.emitted.length > 0);
  assert.doesNotMatch(b.emitted.join('\n'), /\/ 0\.000000\b/);
  const r = compilingApi({ stats: STATS });
  await restore.handler(r.api, restoreInput({ restore_start: 0.5, restore_end: 0.5000001 })).catch(() => {});
  assert.ok(r.emitted.length > 0);
  assert.doesNotMatch(r.emitted.join('\n'), /\/ 0\.000000\b/);
});
