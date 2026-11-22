// ============================================================================
// Live test: the tools that blend a second view into their target through PixelMath
// (src/tools/narrowband.mjs, src/tools/stars.mjs) against a real, running PixInsight. PixelMath reads
// another view at the same coordinates whatever its size, so with a second view of another size each
// of them once blended shifted content and reported success; only a real PixInsight shows that.
// Opt-in only (PIXINSIGHT_CONNECTOR_LIVE=1); wiring as in test/live/tone.live.test.mjs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { tools as narrowband } from '../../src/tools/narrowband.mjs';
import { tools as stars } from '../../src/tools/stars.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const byName = Object.fromEntries([...narrowband, ...stars].map((t) => [t.name, t]));

function runtimeApi() {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return buildRuntimeApi({
    platform: resolvePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() }),
    probe: createProcessProbe(),
    workspace: createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform }),
    log: () => {},
    connectorVersion: version,
  }).api;
}

// A synthetic image: a faint pedestal (plus `lift`), a smooth pattern and a few bright spots, channels offset.
async function synthetic(api, id, channels, width = 201, height = 201, lift = 0) {
  const r = await api.pjsr(`
    var old = ImageWindow.windowById(${JSON.stringify(id)}); if (!old.isNull) old.forceClose();
    var w = new ImageWindow(${width}, ${height}, ${channels}, 32, true, ${channels === 3}, ${JSON.stringify(id)});
    var img = w.mainView.image;
    w.mainView.beginProcess();
    for (var c = 0; c < ${channels}; c++)
      for (var y = 0; y < ${height}; y++)
        for (var x = 0; x < ${width}; x++) {
          var v = ${0.1 + lift} + 0.05 * c + 0.05 * Math.sin(x * 0.37 + c) * Math.cos(y * 0.23) + 0.03 * ((x * 7 + y * 13) % 17) / 17;
          if ((x * 31 + y * 17) % 997 === 0) v = 0.9;
          img.setSample(v, x, y, c);
        }
    w.mainView.endProcess();
    w.show();
    'ok';`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
}

// A weighted sum of every third sample of every channel; 'closed' when the view is not open.
async function fingerprint(api, id) {
  const r = await api.pjsr(`(function () {
    var w = ImageWindow.windowById(${JSON.stringify(id)}); if (w.isNull) return 'closed';
    var im = w.mainView.image, s = 0;
    for (var c = 0; c < im.numberOfChannels; c++) for (var y = 0; y < im.height; y += 3) for (var x = 0; x < im.width; x += 3)
      s += im.sample(x, y, c) * (1 + ((x * 7 + y * 13 + c) % 5));
    return s.toPrecision(15);
  })()`);
  return r.outputs.consoleOutput;
}

const closeAll = (api, ids) => api.pjsr(`var ids = ${JSON.stringify(ids)};
  for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); } 'ok';`);

const DNB = { ha_strength: 0.3, oiii_strength: 0.3, g_strength: 0.2, g_ha_fraction: 0.3, max_output: 0.9, rolloff: 0.3, mask_clip: 0.05, mask_blur: 2 };
const SPB = { strength: 0.8, core_threshold_low: 0.6, core_threshold_high: 0.85, min_strength_fraction: 0.3, max_value: 0.98 };

// [tool, input, the view it changes or creates, the input given another size, that view's channels].
const CASES = [
  ['ha_inject_red', { target_id: 'bsz_rgb', ha_id: 'bsz_2', strength: 0.5, brightness_limit: 0.1 }, 'bsz_rgb', 'ha_id', 1],
  ['ha_inject_luminance', { target_id: 'bsz_rgb', ha_id: 'bsz_2', strength: 0.5 }, 'bsz_rgb', 'ha_id', 1],
  ['continuum_subtract_ha', { ha_id: 'bsz_ha', rgb_id: 'bsz_2', continuum_factor: 0.3 }, 'bsz_ha', 'rgb_id', 3],
  ['dynamic_narrowband_blend', { target_id: 'bsz_rgb', ha_id: 'bsz_ha', oiii_id: 'bsz_2', ...DNB }, 'bsz_rgb', 'oiii_id', 1],
  ['create_synthetic_luminance', { ha_id: 'bsz_ha', oiii_id: 'bsz_2', ha_weight: 0.6, oiii_weight: 0.4, output_id: 'bsz_out' }, 'bsz_out', 'oiii_id', 1],
  ['star_protected_blend', { target_id: 'bsz_rgb', stars_id: 'bsz_2', ...SPB }, 'bsz_rgb', 'stars_id', 3],
  ['star_protected_blend', { target_id: 'bsz_rgb', stars_id: 'bsz_st', ...SPB, pre_star_id: 'bsz_2' }, 'bsz_rgb', 'pre_star_id', 3],
  ['restore_star_color', { target_id: 'bsz_rgb', pre_star_id: 'bsz_2', restore_start: 0.3, restore_end: 0.6, max_value: 0.98 }, 'bsz_rgb', 'pre_star_id', 3],
];
const IDS = ['bsz_rgb', 'bsz_ha', 'bsz_st', 'bsz_2', 'bsz_out'];

test('the blending tools refuse a second view of another size and change nothing; with equal sizes they run', live, async () => {
  const api = runtimeApi();
  try {
    for (const [name, input, changed, oddInput, oddChannels] of CASES) {
      for (const sameSize of [false, true]) {
        const label = `${name} (${oddInput} ${sameSize ? 'same size' : 'of another size'})`;
        await closeAll(api, IDS);
        await synthetic(api, 'bsz_rgb', 3);
        await synthetic(api, 'bsz_ha', 1, 201, 201, 0.2);
        await synthetic(api, 'bsz_st', 3);
        // The second view is brighter than the target, so Ha exceeds R where ha_inject_red needs it to.
        await synthetic(api, 'bsz_2', oddChannels, sameSize ? 201 : 197, sameSize ? 201 : 199, 0.2);
        const openBefore = (await api.listImages()).map((v) => v.id);
        const before = await fingerprint(api, changed);
        const out = await byName[name].handler(api, input);
        if (sameSize) {
          assert.notEqual(out.isError, true, `${label}: ${out.text}`);
          assert.notEqual(await fingerprint(api, changed), before, `${label}: ${changed} changed`);
        } else {
          assert.equal(out.isError, true, `${label}: ${out.text}`);
          assert.match(out.text, new RegExp(`${oddInput} bsz_2 is 197x199`), label);
          assert.equal(await fingerprint(api, changed), before, `${label}: ${changed} is as it was`);
        }
        const left = (await api.listImages()).map((v) => v.id).filter((id) => !openBefore.includes(id) && id !== 'bsz_out');
        assert.deepEqual(left, [], `${label}: no other window is left open`);
      }
    }
  } finally {
    await closeAll(api, IDS);
  }
});
