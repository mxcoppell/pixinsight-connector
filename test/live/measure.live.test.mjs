// ============================================================================
// Live test: measure_stars (src/tools/image-metrics.mjs) against a real, running PixInsight. Gaussian
// stars of known sigma are drawn into a new view and the reported FWHM is checked against
// 2 sqrt(2 ln 2) sigma. Opt-in only (PIXINSIGHT_CONNECTOR_LIVE=1); wiring as in test/live/tone.live.test.mjs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { tools } from '../../src/tools/measure.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const measureStars = tools.find((t) => t.name === 'measure_stars');

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

// Mono 256x256 view: a 0.001 pedestal and Gaussian stars of the given sigma on the 16 px scan grid, 32 px apart.
async function starField(api, id, sigma) {
  const r = await api.pjsr(`
    var old = ImageWindow.windowById(${JSON.stringify(id)}); if (!old.isNull) old.forceClose();
    var w = new ImageWindow(256, 256, 1, 32, true, false, ${JSON.stringify(id)});
    var img = w.mainView.image, s2 = 2 * ${sigma} * ${sigma};
    w.mainView.beginProcess();
    for (var y = 0; y < 256; y++)
      for (var x = 0; x < 256; x++) {
        var cx = 11 + 32 * Math.round((x - 11) / 32), cy = 11 + 32 * Math.round((y - 11) / 32);
        img.setSample(0.001 + 0.5 * Math.exp(-((x - cx) * (x - cx) + (y - cy) * (y - cy)) / s2), x, y);
      }
    w.mainView.endProcess();
    w.show();
    'ok';`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
}

test('measure_stars reports the FWHM of Gaussian stars to a fraction of a pixel', live, async () => {
  const api = runtimeApi();
  const K = 2 * Math.sqrt(2 * Math.log(2));
  const got = {};
  try {
    for (const sigma of [1.5, 1.6, 2.5]) {
      await starField(api, 'ms_live', sigma);
      const out = await measureStars.handler(api, { view_id: 'ms_live' });
      assert.notEqual(out.isError, true, out.text);
      got[sigma] = JSON.parse(out.text).median_fwhm_px;
      assert.ok(Math.abs(got[sigma] - K * sigma) < 0.15, `sigma ${sigma}: ${got[sigma]} vs ${K * sigma}`);
    }
    assert.ok(got[1.6] - got[1.5] > 0.15, `sigma 1.5 -> 1.6 must move the FWHM: ${got[1.5]} -> ${got[1.6]}`);
  } finally {
    await api.pjsr(`var w = ImageWindow.windowById('ms_live'); if (!w.isNull) w.forceClose(); 'ok';`);
  }
});
