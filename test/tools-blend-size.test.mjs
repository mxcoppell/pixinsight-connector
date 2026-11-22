// The tools that combine a second view with their target pixel by pixel through PixelMath
// (src/tools/narrowband.mjs, src/tools/stars.mjs) refuse views of different widths or heights before
// any PJSR is sent. PixelMath reads another view at the same coordinates whatever its size, so in
// PixInsight 1.9.5 each of them blended content shifted by the size difference and reported success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools as narrowband, sizeMismatch } from '../src/tools/narrowband.mjs';
import { tools as stars } from '../src/tools/stars.mjs';
import { compilingApi } from './helpers.mjs';

const byName = Object.fromEntries([...narrowband, ...stars].map((t) => [t.name, t]));
const DNB = { ha_strength: 0.3, oiii_strength: 0.3, g_strength: 0.2, g_ha_fraction: 0.3, max_output: 0.9, rolloff: 0.3, mask_clip: 0.05, mask_blur: 2 };
const SPB = { strength: 0.8, core_threshold_low: 0.6, core_threshold_high: 0.85, min_strength_fraction: 0.3, max_value: 0.98 };

// tool -> [input, the input name of the view that is given another size].
const CASES = {
  ha_inject_red: [{ target_id: 'RGB', ha_id: 'Ha', strength: 0.5, brightness_limit: 0.1 }, 'ha_id'],
  ha_inject_luminance: [{ target_id: 'RGB', ha_id: 'Ha', strength: 0.5 }, 'ha_id'],
  continuum_subtract_ha: [{ ha_id: 'Ha', rgb_id: 'RGB', continuum_factor: 0.3 }, 'rgb_id'],
  dynamic_narrowband_blend: [{ target_id: 'RGB', ha_id: 'Ha', oiii_id: 'OIII', ...DNB }, 'oiii_id'],
  create_synthetic_luminance: [{ ha_id: 'Ha', oiii_id: 'OIII', ha_weight: 0.6, oiii_weight: 0.4 }, 'oiii_id'],
  star_protected_blend: [{ target_id: 'RGB', stars_id: 'Stars', ...SPB }, 'stars_id'],
  'star_protected_blend (pre_star_id)': [{ target_id: 'RGB', stars_id: 'Stars', ...SPB, pre_star_id: 'Pre' }, 'pre_star_id'],
  restore_star_color: [{ target_id: 'RGB', pre_star_id: 'Pre', restore_start: 0.5, restore_end: 0.8, max_value: 0.98 }, 'pre_star_id'],
};

const IDS = ['RGB', 'Ha', 'OIII', 'Stars', 'Pre'];
const imagesWith = (odd) => IDS.map((id) => ({ id, width: 241, height: id === odd ? 199 : 201, isColor: ['RGB', 'Stars', 'Pre'].includes(id) }));

test('the seven blending tools refuse a view of another size before any PJSR, naming each size', async () => {
  for (const [name, [input, oddInput]] of Object.entries(CASES)) {
    const tool = byName[name.split(' ')[0]];
    const odd = input[oddInput];
    const { api, emitted } = compilingApi({ stats: { median: 0.1, max: 0.9 }, overrides: { listImages: async () => imagesWith(odd) } });
    const out = await tool.handler(api, input);
    assert.equal(out?.isError, true, `${name}: ${JSON.stringify(out)}`);
    assert.match(out.text, new RegExp(`^${tool.name} not run: the views must have the same width and height; `), name);
    assert.match(out.text, new RegExp(`${oddInput} ${odd} is 241x199`), name);
    assert.match(out.text, /is 241x201/, name);
    assert.equal(emitted.length, 0, `${name}: nothing is sent to PixInsight`);
  }
});

test('the seven blending tools run as before when every view has the same size', async () => {
  for (const [name, [input]] of Object.entries(CASES)) {
    const tool = byName[name.split(' ')[0]];
    const { api, emitted } = compilingApi({
      replies: Array(6).fill(JSON.stringify({ median: 0.1, max: 0.9, rMax: 0.9, bMax: 0.9, viewId: 'SYNTH_L' })),
      stats: { median: 0.1, max: 0.9 },
      overrides: { listImages: async () => imagesWith(null) },
    });
    const out = await tool.handler(api, input);
    assert.notEqual(out?.isError, true, `${name}: ${JSON.stringify(out)}`);
    assert.ok(emitted.some((c) => /new PixelMath/.test(c)), `${name}: PixelMath is sent`);
  }
});

test('sizeMismatch compares every listed view with the first and leaves out views it cannot see', async () => {
  const api = { listImages: async () => [{ id: 'A', width: 10, height: 8 }, { id: 'B', width: 10, height: 8 }, { id: 'C', width: 9, height: 8 }] };
  assert.equal(await sizeMismatch(api, 't', [['a', 'A'], ['b', 'B']]), null);
  assert.equal(await sizeMismatch(api, 't', [['a', 'A'], ['x', 'Missing']]), null, 'an unlisted view is left to the server\'s check');
  assert.equal(await sizeMismatch(api, 't', [['a', 'A'], ['c', 'C'], ['b', 'B']]),
    't not run: the views must have the same width and height; a A is 10x8, c C is 9x8, b B is 10x8. No view was changed.');
});
