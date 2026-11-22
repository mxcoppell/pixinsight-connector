// ============================================================================
// Live test: dynamic_narrowband_blend (src/tools/narrowband.mjs) against a real, running PixInsight. Its
// temporary __nb_blend_mask window once stayed open when the call failed (a grayscale target failed
// inside the mask loop); only a real PixInsight shows what is left open.
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
import { tools } from '../../src/tools/narrowband.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const dnb = tools.find((t) => t.name === 'dynamic_narrowband_blend');
const VALUES = { ha_strength: 0.3, oiii_strength: 0.3, g_strength: 0.2, g_ha_fraction: 0.3, max_output: 0.9, rolloff: 0.3, mask_clip: 0.05, mask_blur: 2 };

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

// A 201x201 synthetic image: a faint pedestal, a smooth pattern and a few bright spots.
async function synthetic(api, id, channels) {
  const r = await api.pjsr(`
    var old = ImageWindow.windowById(${JSON.stringify(id)}); if (!old.isNull) old.forceClose();
    var w = new ImageWindow(201, 201, ${channels}, 32, true, ${channels === 3}, ${JSON.stringify(id)});
    var img = w.mainView.image;
    w.mainView.beginProcess();
    for (var c = 0; c < ${channels}; c++)
      for (var y = 0; y < 201; y++)
        for (var x = 0; x < 201; x++) {
          var v = 0.1 + 0.02 * c + 0.05 * Math.sin(x * 0.37 + c) * Math.cos(y * 0.23) + 0.03 * ((x * 7 + y * 13) % 17) / 17;
          if ((x * 31 + y * 17) % 997 === 0) v = 0.9;
          img.setSample(v, x, y, c);
        }
    w.mainView.endProcess();
    w.show();
    'ok';`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
}

const hasMask = async (api, id) => (await api.pjsr(`ImageWindow.windowById(${JSON.stringify(id)}).mask.isNull ? 'no' : 'yes';`)).outputs.consoleOutput;

const closeAll = (api, ids) => api.pjsr(`var ids = ${JSON.stringify(ids)};
  for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); } 'ok';`);

test('dynamic_narrowband_blend leaves no mask window open or attached, whether it runs (colour target) or fails (mono target)', live, async () => {
  const api = runtimeApi();
  const ids = ['dnb_live_target', 'dnb_live_ha', 'dnb_live_oiii', '__nb_blend_mask'];
  try {
    for (const channels of [3, 1]) {
      await synthetic(api, ids[0], channels);
      await synthetic(api, ids[1], 1);
      await synthetic(api, ids[2], 1);
      const label = channels === 3 ? 'colour target' : 'mono target';
      let out;
      try {
        out = await dnb.handler(api, { target_id: ids[0], ha_id: ids[1], oiii_id: ids[2], ...VALUES });
      } catch (e) {
        out = { isError: true, text: e.message };
      }
      const open = (await api.listImages()).map((v) => v.id);
      assert.ok(!open.includes('__nb_blend_mask'), `${label}: the mask window is closed (open: ${open.join(', ')})`);
      assert.equal(await hasMask(api, ids[0]), 'no', `${label}: no mask is left on the target`);
      if (channels === 3) assert.notEqual(out.isError, true, `${label}: ${out.text}`);
      else assert.match(out.text, /target must be color/, label);
    }
  } finally {
    await closeAll(api, ids);
  }
});
