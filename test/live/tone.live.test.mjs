// ============================================================================
// Live test: robust_median_stretch (src/tools/tone.mjs) against a real, running PixInsight,
// as local/plans/statistical-stretch-spec.md §10 asks: stretch a synthetic image and check the
// measured output median equals target_median within 1e-5. Opt-in only (PIXINSIGHT_CONNECTOR_LIVE=1);
// CI has no PixInsight and `node --test test/` recurses into this directory.
// Wiring as in test/live/introspect.live.test.mjs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { tools } from '../../src/tools/tone.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const stretch = tools.find((t) => t.name === 'robust_median_stretch');

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

// A 201x201 (odd sample count) linear-looking synthetic image: a faint pedestal with a smooth
// deterministic pattern and a few bright spots. Channel c is offset so unlinked statistics differ.
async function synthetic(api, id, channels) {
  const r = await api.pjsr(`
    var old = ImageWindow.windowById(${JSON.stringify(id)}); if (!old.isNull) old.forceClose();
    var w = new ImageWindow(201, 201, ${channels}, 32, true, ${channels === 3}, ${JSON.stringify(id)});
    var img = w.mainView.image;
    w.mainView.beginProcess();
    for (var c = 0; c < ${channels}; c++)
      for (var y = 0; y < 201; y++)
        for (var x = 0; x < 201; x++) {
          var v = 0.01 + 0.004 * c + 0.003 * Math.sin(x * 0.37 + c) * Math.cos(y * 0.23) + 0.002 * ((x * 7 + y * 13) % 17) / 17;
          if ((x * 31 + y * 17) % 997 === 0) v = 0.6;
          img.setSample(v, x, y, c);
        }
    w.mainView.endProcess();
    w.show();
    'ok';`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
}

async function medians(api, id) {
  const r = await api.pjsr(`
    var img = ImageWindow.windowById(${JSON.stringify(id)}).mainView.image;
    var n = img.numberOfNominalChannels, out = [];
    for (var c = 0; c < n; c++) out.push(img.median(img.bounds, c, c));
    JSON.stringify({ joint: img.median(img.bounds, 0, n - 1), per: out });`);
  return JSON.parse(r.outputs.consoleOutput);
}

const closeAll = (api, ids) => api.pjsr(`var ids = ${JSON.stringify(ids)};
  for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); } 'ok';`);

test('robust_median_stretch puts the measured median on target_median (mono, 1 and 2 passes; colour unlinked and linked)', live, async () => {
  const api = runtimeApi();
  const ids = ['rms_live_mono', 'rms_live_rgb'];
  try {
    for (const passes of [1, 2]) {
      await synthetic(api, ids[0], 1);
      const out = await stretch.handler(api, { view_id: ids[0], target_median: 0.25, black_point_sigma: 2.8, passes });
      assert.notEqual(out.isError, true, out.text);
      const m = await medians(api, ids[0]);
      assert.ok(Math.abs(m.joint - 0.25) < 1e-5, `mono passes=${passes}: median ${m.joint}`);
    }

    await synthetic(api, ids[1], 3);
    let out = await stretch.handler(api, { view_id: ids[1], target_median: 0.2, black_point_sigma: 3, linked: false });
    assert.notEqual(out.isError, true, out.text);
    for (const [c, v] of (await medians(api, ids[1])).per.entries()) assert.ok(Math.abs(v - 0.2) < 1e-5, `unlinked channel ${c}: ${v}`);

    await synthetic(api, ids[1], 3);
    out = await stretch.handler(api, { view_id: ids[1], target_median: 0.2, black_point_sigma: 3, linked: true });
    assert.notEqual(out.isError, true, out.text);
    const joint = (await medians(api, ids[1])).joint;
    assert.ok(Math.abs(joint - 0.2) < 1e-5, `linked joint median: ${joint}`);
  } finally {
    await closeAll(api, [...ids, '__rms_work']);
  }
});
