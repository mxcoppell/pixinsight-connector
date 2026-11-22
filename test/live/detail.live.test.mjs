// ============================================================================
// Live test: multi_scale_enhance (src/tools/detail.mjs) against a real, running PixInsight. Its mask
// is built two ways, ChannelExtraction (CIE L*) for a colour view and a grayscale copy for a mono one;
// the mono way once called a method PJSR does not have, which only a real PixInsight shows.
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
import { tools } from '../../src/tools/detail.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const mse = tools.find((t) => t.name === 'multi_scale_enhance');

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

test('multi_scale_enhance runs on a mono and a colour view and leaves no mask window open', live, async () => {
  const api = runtimeApi();
  const ids = ['mse_live_mono', 'mse_live_rgb'];
  const input = {
    mask_clip_low: 0.05, mask_blur: 2, mask_gamma: 1.5,
    lhe_fine_radius: 16, lhe_fine_amount: 0.2, lhe_mid_radius: 32, lhe_mid_amount: 0.2,
    lhe_large_radius: 64, lhe_large_amount: 0.2, lhe_slope_limit: 1.5, lhe_fine_slope_limit: 1.3,
  };
  try {
    for (const [id, channels] of [[ids[0], 1], [ids[1], 3]]) {
      await synthetic(api, id, channels);
      const out = await mse.handler(api, { view_id: id, ...input });
      assert.notEqual(out.isError, true, `${id}: ${out.text}`);
      assert.match(out.text, /\[MULTI-SCALE ENHANCE\]/);
      const open = (await api.listImages()).map((v) => v.id);
      assert.ok(!open.includes('__mse_mask'), `${id}: the mask window is closed afterwards (open: ${open.join(', ')})`);
      assert.equal(await hasMask(api, id), 'no', `${id}: the mask is removed from the view`);
    }
  } finally {
    await closeAll(api, [...ids, '__mse_mask']);
  }
});
