// ============================================================================
// Live test: run_curves (src/tools/processes.mjs) against a real, running PixInsight. On a grayscale
// image CurvesTransformation applies only its K curve, so an L, S, R, G or B curve once ran, was
// reported as applied and left the pixels as they were; only a real PixInsight shows that.
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
import { tools } from '../../src/tools/processes.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const curves = tools.find((t) => t.name === 'run_curves');
const POINTS = [[0, 0], [0.4, 0.55], [1, 1]];

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

// A 201x201 synthetic image: a faint pedestal, a smooth pattern and a few bright spots; colour
// channels differ, so a saturation or single-channel curve has something to change.
async function synthetic(api, id, channels) {
  const r = await api.pjsr(`
    var old = ImageWindow.windowById(${JSON.stringify(id)}); if (!old.isNull) old.forceClose();
    var w = new ImageWindow(201, 201, ${channels}, 32, true, ${channels === 3}, ${JSON.stringify(id)});
    var img = w.mainView.image;
    w.mainView.beginProcess();
    for (var c = 0; c < ${channels}; c++)
      for (var y = 0; y < 201; y++)
        for (var x = 0; x < 201; x++) {
          var v = 0.1 + 0.05 * c + 0.05 * Math.sin(x * 0.37 + c) * Math.cos(y * 0.23) + 0.03 * ((x * 7 + y * 13) % 17) / 17;
          if ((x * 31 + y * 17) % 997 === 0) v = 0.9;
          img.setSample(v, x, y, c);
        }
    w.mainView.endProcess();
    w.show();
    'ok';`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
}

// A weighted sum of every third sample of every channel: equal before and after means unchanged pixels.
async function fingerprint(api, id) {
  const r = await api.pjsr(`(function () {
    var im = ImageWindow.windowById(${JSON.stringify(id)}).mainView.image, s = 0;
    for (var c = 0; c < im.numberOfChannels; c++) for (var y = 0; y < im.height; y += 3) for (var x = 0; x < im.width; x += 3)
      s += im.sample(x, y, c) * (1 + ((x * 7 + y * 13 + c) % 5));
    return s.toPrecision(15);
  })()`);
  return r.outputs.consoleOutput;
}

const closeAll = (api, ids) => api.pjsr(`var ids = ${JSON.stringify(ids)};
  for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); } 'ok';`);

test('run_curves refuses L, S, R, G and B on a mono view and leaves it unchanged; RGB on mono and every channel on colour change the view', live, async () => {
  const api = runtimeApi();
  const ids = ['curves_live_mono', 'curves_live_rgb'];
  try {
    await synthetic(api, ids[0], 1);
    const before = await fingerprint(api, ids[0]);
    for (const channel of ['L', 'S', 'R', 'G', 'B']) {
      const out = await curves.handler(api, { view_id: ids[0], channel, points: POINTS });
      assert.equal(out.isError, true, `mono ${channel}: ${out.text}`);
      assert.match(out.text, /grayscale image/);
      assert.equal(await fingerprint(api, ids[0]), before, `mono ${channel}: the view is unchanged`);
    }
    const k = await curves.handler(api, { view_id: ids[0], channel: 'RGB', points: POINTS });
    assert.notEqual(k.isError, true, k.text);
    assert.notEqual(await fingerprint(api, ids[0]), before, 'mono RGB: the view changed');

    for (const channel of ['RGB', 'L', 'S', 'R', 'G', 'B']) {
      await synthetic(api, ids[1], 3);
      const start = await fingerprint(api, ids[1]);
      const out = await curves.handler(api, { view_id: ids[1], channel, points: POINTS });
      assert.notEqual(out.isError, true, `colour ${channel}: ${out.text}`);
      assert.notEqual(await fingerprint(api, ids[1]), start, `colour ${channel}: the view changed`);
    }
  } finally {
    await closeAll(api, ids);
  }
});
