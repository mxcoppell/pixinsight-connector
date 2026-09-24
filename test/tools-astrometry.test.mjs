import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/astrometry.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('astrometry.mjs exports run_plate_solve and copy_astrometric_solution', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['copy_astrometric_solution', 'run_plate_solve']);
});

test('run_plate_solve reports success with the solved summary', async () => {
  const sentinel = '@@SOLVE@@' + JSON.stringify({ solved: true, seconds: 1.2, summary: ['Resolution: 1.2"/px'] });
  const { ctx, emitted } = createFakeBridge({ replies: [sentinel] });
  const out = await byName.run_plate_solve.handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.2 });
  assert.match(emitted[0], /new ImageSolver/);
  assert.match(out.text, /Plate solve OK in 1\.2s/);
  assert.match(out.text, /Resolution: 1\.2"\/px/);
});

test('run_plate_solve reports failure with the solver error', async () => {
  const sentinel = '@@SOLVE@@' + JSON.stringify({ solved: false, error: 'No RA/Dec seed.' });
  const { ctx } = createFakeBridge({ replies: [sentinel] });
  const out = await byName.run_plate_solve.handler(apiFrom(ctx), { view_id: 'L' });
  assert.match(out.text, /Plate solve FAILED: No RA\/Dec seed/);
});

test('run_plate_solve surfaces a pjsr-level error as a failed solve', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'watcher timeout' } }] });
  const out = await byName.run_plate_solve.handler(apiFrom(ctx), { view_id: 'L' });
  assert.match(out.text, /Plate solve FAILED: watcher timeout/);
});

test('copy_astrometric_solution reports the console summary', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['Astrometric solution copied (hasAstro=true). Keywords copied: DATE-OBS'] });
  const out = await byName.copy_astrometric_solution.handler(apiFrom(ctx), { source_file: '/tmp/master.xisf', target_id: 'RGB' });
  assert.match(emitted[0], /copyAstrometricSolution/);
  assert.match(out.text, /Astrometric solution copied/);
});

test('run_plate_solve flags a failed solve with isError, and a successful one without', async () => {
  const failed = createFakeBridge({ replies: ['@@SOLVE@@' + JSON.stringify({ solved: false, error: 'no solution' })] });
  const bad = await byName.run_plate_solve.handler(apiFrom(failed.ctx), { view_id: 'L' });
  assert.equal(bad.isError, true);

  const ok = createFakeBridge({ replies: ['@@SOLVE@@' + JSON.stringify({ solved: true, seconds: 1, summary: [] })] });
  const good = await byName.run_plate_solve.handler(apiFrom(ok.ctx), { view_id: 'L' });
  assert.notEqual(good.isError, true);
});

test('copy_astrometric_solution reports a declined copy (WARNING) as an error', async () => {
  const { ctx } = createFakeBridge({ replies: ['WARNING: source has no astrometric solution. Keywords copied: '] });
  const out = await byName.copy_astrometric_solution.handler(apiFrom(ctx), { source_file: '/tmp/master.xisf', target_id: 'RGB' });
  assert.equal(out.isError, true);
  assert.match(out.text, /no astrometric solution/);
});

// The snippet itself, run against a tiny fake of the PJSR objects it touches: opening the source
// file brings a crop mask, and the user already has one of their own open.
test('copy_astrometric_solution closes only the crop_mask views the source file brought', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.copy_astrometric_solution.handler(apiFrom(ctx), { source_file: '/tmp/master.xisf', target_id: 'RGB' });
  const closed = [];
  const win = (id) => ({
    isNull: false, hasAstrometricSolution: true, keywords: [],
    mainView: { id, image: { width: 10, height: 10 }, propertyValue: () => undefined, propertyType: () => 0, setPropertyValue() {} },
    forceClose() { closed.push(id); }, copyAstrometricSolution() {},
  });
  const windows = [win('RGB'), win('mine_crop_mask')];
  const sandbox = {
    File: { exists: () => true },
    FITSKeyword: function () {},
    ImageWindow: {
      windowById: (id) => windows.find((w) => w.mainView.id === id) ?? { isNull: true },
      open: () => { const added = [win('master'), win('master_crop_mask')]; windows.push(...added); return [added[0]]; },
      get windows() { return windows.slice(); },
    },
  };
  vm.runInNewContext(emitted[0], sandbox);
  assert.ok(closed.includes('master_crop_mask'), 'the mask the source brought is closed');
  assert.ok(!closed.includes('mine_crop_mask'), 'the user\'s own crop_mask view is left open');
});

// The snippet itself, against a fake ImageSolver whose initialize() loads "saved GUI settings" with
// every output option ticked (ImageSolverEngine.js: SolverConfiguration.LoadSettings). The solve must
// run with them off, so it writes no <name>_model.csv beside the source, opens no SaveFileDialog and
// no extra window; the star lists ImageSolver hands to StarAlignment (ImageSolver.starsCSVFilePath,
// normally File.systemTempDirectory) go under scratchDir, and the library's own path is restored.
test('run_plate_solve turns off the saved output options and keeps the star lists under scratchDir', async () => {
  const sentinel = '@@SOLVE@@' + JSON.stringify({ solved: true, seconds: 1, summary: [] });
  const { ctx, emitted } = createFakeBridge({ replies: [sentinel] });
  const api = apiFrom(ctx, { workspace: { dir: '/w s', scratchDir: '/w s/agentic/scratch', outputDir: '/w s/output' } });
  await byName.run_plate_solve.handler(api, { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.2 });

  const OUTPUT_OPTIONS = ['generateDistortModel', 'showStars', 'showStarMatches', 'showDistortion', 'showSimplifiedSurfaces', 'generateErrorImg'];
  const seen = {};
  const created = [];
  const original = function (isTarget) { return '/sys/tmp/stars-' + (isTarget ? 't' : 'r') + '-001.csv'; };
  function ImageSolver() {
    this.solverCfg = {};
    this.metadata = { ResolutionFromFocal: (f) => f };
  }
  ImageSolver.starsCSVFilePath = original;
  ImageSolver.prototype.initialize = function () {
    for (const k of OUTPUT_OPTIONS) this.solverCfg[k] = true; // the user's saved settings
    this.solverCfg.distortionCorrection = true;
  };
  ImageSolver.prototype.solveImage = function () {
    for (const k of OUTPUT_OPTIONS) seen[k] = this.solverCfg[k];
    seen.reference = ImageSolver.starsCSVFilePath();
    seen.target = ImageSolver.starsCSVFilePath(true);
  };
  const w = { isNull: false, keywords: [], hasAstrometricSolution: true, astrometricSolutionSummary: () => '' };
  const sandbox = {
    ImageSolver,
    ImageWindow: { windowById: () => w },
    CatalogMode: { LocalXPSDServer: 3 },
    File: {
      directoryExists: (d) => created.includes(d),
      createDirectory: (d) => { created.push(d); },
    },
  };
  const out = vm.runInNewContext(emitted[0], sandbox);

  for (const k of OUTPUT_OPTIONS) assert.equal(seen[k], false, `${k} is off during the solve`);
  assert.deepEqual(created, ['/w s/agentic/scratch/tmp_platesolve']);
  assert.equal(seen.reference, '/w s/agentic/scratch/tmp_platesolve/stars-r.csv');
  assert.equal(seen.target, '/w s/agentic/scratch/tmp_platesolve/stars-t.csv');
  assert.equal(ImageSolver.starsCSVFilePath, original, 'the library\'s star-list path is restored');
  assert.match(out, /"solved":true/);
});

test('run_plate_solve restores the library\'s star-list path when the solve throws', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['@@SOLVE@@{"solved":false}'] });
  await byName.run_plate_solve.handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.2 });
  const original = () => '/sys/tmp/stars-r-001.csv';
  function ImageSolver() { this.solverCfg = {}; this.metadata = {}; }
  ImageSolver.starsCSVFilePath = original;
  ImageSolver.prototype.initialize = function () {};
  ImageSolver.prototype.solveImage = function () { throw new Error('no solution'); };
  const sandbox = {
    ImageSolver,
    ImageWindow: { windowById: () => ({ isNull: false, keywords: [] }) },
    CatalogMode: { LocalXPSDServer: 3 },
    File: { directoryExists: () => true, createDirectory() {} },
  };
  const out = vm.runInNewContext(emitted[0], sandbox);
  assert.equal(ImageSolver.starsCSVFilePath, original);
  assert.match(out, /no solution/);
});
