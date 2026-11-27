// ============================================================================
// Live test: scan_workspace's hasWCS (src/tools/workspace-scan.mjs) against XISF files a real, running
// PixInsight writes. The scanner once required the PCL:AstrometricSolution:* ids that PixInsight 1.8.9-2
// to 1.9.4 wrote, and reported hasWCS: false for every solution saved by 1.9.5 and later (the standard
// AstrometricSolution:* namespace); its unit tests built their fixtures by hand, so only a file PixInsight
// itself saves shows which ids are on disk. Nothing here names the namespace: whichever PixInsight writes,
// a saved solution must be reported and an image without one must not.
// Opt-in only (PIXINSIGHT_CONNECTOR_LIVE=1); wiring as in test/live/environment.live.test.mjs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform, toPixPath } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { tools } from '../../src/tools/workspace-scan.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const scan = tools.find((t) => t.name === 'scan_workspace');

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

test('scan_workspace reports hasWCS for a solved XISF that PixInsight saves, and false for an unsolved one', live, async (t) => {
  const api = runtimeApi();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pixinsight-connector-wcs-'));
  const ids = ['wcs_live_solved', 'wcs_live_plain'];
  const closeAll = () => api.pjsr(`var ids = ${JSON.stringify(ids)};
    for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); } 'ok';`);
  t.after(async () => { await closeAll(); rmSync(dir, { recursive: true, force: true }); });
  await closeAll();

  // Two small mono images; one gets a synthetic gnomonic solution (as inspect_environment builds one), and
  // PixInsight saves both. regenerateAstrometricSolution() is what turns the properties into a solution.
  const r = await api.pjsr(`
    function make(id) {
      var w = new ImageWindow(256, 256, 1, 32, true, false, id);
      w.mainView.beginProcess(); w.mainView.image.fill(0.1); w.mainView.endProcess();
      return w;
    }
    var solved = make(${JSON.stringify(ids[0])}), plain = make(${JSON.stringify(ids[1])});
    var v = solved.mainView, s = 10 / 3600, m = new Matrix(2, 2);
    m.at(0, 0, -s); m.at(0, 1, 0); m.at(1, 0, 0); m.at(1, 1, -s);
    v.setPropertyValue("PCL:AstrometricSolution:ProjectionSystem", "Gnomonic");
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceCelestialCoordinates", new Vector([150.1, 20.2]));
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceImageCoordinates", new Vector([128, 128]));
    v.setPropertyValue("PCL:AstrometricSolution:LinearTransformationMatrix", m);
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceNativeCoordinates", new Vector([0, 90]));
    v.setPropertyValue("PCL:AstrometricSolution:CelestialPoleNativeCoordinates", new Vector([180, 20.2]));
    v.setPropertyValue("Observation:CelestialReferenceSystem", "ICRS");
    v.setPropertyValue("Observation:Equinox", 2000.0);
    solved.regenerateAstrometricSolution();
    var out = { solvedInPixInsight: !!solved.hasAstrometricSolution, plainInPixInsight: !!plain.hasAstrometricSolution };
    solved.saveAs(${JSON.stringify(toPixPath(path.join(dir, 'solved.xisf')))}, false, false, false, false);
    plain.saveAs(${JSON.stringify(toPixPath(path.join(dir, 'plain.xisf')))}, false, false, false, false);
    JSON.stringify(out);`);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error));
  const inPixInsight = JSON.parse(r.outputs.consoleOutput);
  assert.deepEqual(inPixInsight, { solvedInPixInsight: true, plainInPixInsight: false }, 'the setup must give PixInsight a solution on one image only');

  const scanApi = { ...api, workspace: { dir, scratchDir: path.join(dir, 'agentic', 'scratch'), outputDir: path.join(dir, 'output') } };
  const files = Object.fromEntries(JSON.parse((await scan.handler(scanApi, {})).text).files.map((f) => [f.rel, f]));
  assert.equal(files['solved.xisf']?.hasWCS, true, 'PixInsight holds a solution for this file, so scan_workspace must report one');
  assert.equal(files['plain.xisf']?.hasWCS, false);
});
