// Tests for the astrometry, catalogue, file-level and comparison tools: compare_images,
// get_image_stats' clamp fractions, resample_image, run_plate_solve's scale search, catalog_stars,
// align_files, run_wbpp and wbpp_status. Emitted PJSR is compiled (compilingApi) and, where the logic
// lives in the snippet, run in a vm sandbox against small fakes of the PixInsight objects it touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compilingApi } from './helpers.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools as compareTools, compareImagesPjsr, clampFractionsPjsr } from '../src/tools/compare.mjs';
import { tools as imageTools } from '../src/tools/images.mjs';
import { tools as resampleTools, resamplePjsr } from '../src/tools/resample.mjs';
import { tools as reprojectTools, reprojectPjsr } from '../src/tools/reproject.mjs';
import { tools as astrometryTools } from '../src/tools/astrometry.mjs';
import { tools as catalogTools, catalogStarsPjsr } from '../src/tools/catalog.mjs';
import { tools as alignTools, alignBatchPjsr } from '../src/tools/align.mjs';
import { makeWbppTools, wbppArgs, wbppScriptPath, pipelineBuilderScript } from '../src/tools/wbpp.mjs';

const tool = (list, name) => list.find((t) => t.name === name);

function tempWs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixinsight-astro-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, scratchDir: path.join(dir, 'agentic', 'scratch'), outputDir: path.join(dir, 'output') };
}

// A fake PJSR image over plain arrays: data[c][y * width + x].
function fakeImage(width, height, data) {
  return {
    width, height, numberOfChannels: data.length,
    getSamples(buf, r, c) { let k = 0; for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) buf[k++] = data[c][y * width + x]; },
    sample(x, y, c) { return data[c][y * width + x]; },
  };
}
function Rect(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); }
function sandboxWith(windows, extra = {}) {
  return {
    Rect, Float32Array, JSON, Math,
    ImageWindow: { windowById: (id) => windows[id] ?? { isNull: true } },
    ...extra,
  };
}

// --- compare_images ---------------------------------------------------------

test('compare_images: identical views report zero differences and identical true', async () => {
  const a = { isNull: false, mainView: { image: fakeImage(2, 2, [[0, 0.5, 1, 0.25]]) } };
  const out = JSON.parse(vm.runInNewContext(compareImagesPjsr('A', 'B', null), sandboxWith({ A: a, B: a })));
  assert.equal(out.identical, true);
  assert.equal(out.channels[0].maxAbsDiff, 0);
  assert.equal(out.channels[0].outsideUnitFractionA, 0);
});

test('compare_images: max, mean and out-of-range fractions per channel, within a rect', async () => {
  const a = { isNull: false, mainView: { image: fakeImage(2, 2, [[0, 0.5, 1.5, 0.25]]) } };
  const b = { isNull: false, mainView: { image: fakeImage(2, 2, [[0.1, 0.5, 1, -0.25]]) } };
  const all = JSON.parse(vm.runInNewContext(compareImagesPjsr('A', 'B', null), sandboxWith({ A: a, B: b })));
  assert.equal(all.identical, false);
  assert.ok(Math.abs(all.channels[0].maxAbsDiff - 0.5) < 1e-6);
  assert.ok(Math.abs(all.channels[0].meanAbsDiff - (0.1 + 0 + 0.5 + 0.5) / 4) < 1e-6);
  assert.equal(all.channels[0].outsideUnitFractionA, 0.25);
  assert.equal(all.channels[0].outsideUnitFractionB, 0.25);
  const top = JSON.parse(vm.runInNewContext(compareImagesPjsr('A', 'B', [0, 0, 2, 1]), sandboxWith({ A: a, B: b })));
  assert.equal(top.pixels, 2);
  assert.ok(Math.abs(top.channels[0].maxAbsDiff - 0.1) < 1e-6);
});

test('compare_images refuses different geometry and a rect outside the image', () => {
  const a = { isNull: false, mainView: { image: fakeImage(2, 2, [[0, 0, 0, 0]]) } };
  const b = { isNull: false, mainView: { image: fakeImage(1, 2, [[0, 0]]) } };
  assert.throws(() => vm.runInNewContext(compareImagesPjsr('A', 'B', null), sandboxWith({ A: a, B: b })), /Geometry differs/);
  assert.throws(() => vm.runInNewContext(compareImagesPjsr('A', 'A', [0, 0, 3, 2]), sandboxWith({ A: a })), /rect outside/);
});

test('compare_images handler sends a compiling snippet and returns its JSON', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ identical: true, channels: [] })] });
  const out = await tool(compareTools, 'compare_images').handler(api, { view_id: 'A', reference_id: 'B', rect: [0, 0, 10, 10] });
  assert.match(emitted[0], /getSamples/);
  assert.match(out.text, /"identical": true/);
  await assert.rejects(tool(compareTools, 'compare_images').handler(api, { view_id: 'A', reference_id: 'B', rect: [0, 0, 1] }), /rect/);
});

// --- get_image_stats clamp fractions ----------------------------------------

test('get_image_stats adds per-channel fractions of samples at exactly 0 and exactly 1', async () => {
  const { api, emitted } = compilingApi({
    stats: { median: 0.1, mad: 0.01 },
    replies: [JSON.stringify([{ channel: 0, atZeroFraction: 0.25, atOneFraction: 0.5 }])],
  });
  const out = JSON.parse((await tool(imageTools, 'get_image_stats').handler(api, { view_id: 'V' })).text);
  assert.equal(out.median, 0.1);
  assert.deepEqual(out.clampFractions, [{ channel: 0, atZeroFraction: 0.25, atOneFraction: 0.5 }]);
  const w = { isNull: false, mainView: { image: fakeImage(2, 2, [[0, 1, 1, 0.3]]) } };
  const counted = JSON.parse(vm.runInNewContext(clampFractionsPjsr('V'), sandboxWith({ V: w })));
  assert.deepEqual(counted, [{ channel: 0, atZeroFraction: 0.25, atOneFraction: 0.5 }]);
  assert.match(emitted[0], /atOneFraction/);
});

// --- resample_image ---------------------------------------------------------

function fakeGeometryProcess(name, log) {
  function P() { this.noGUIMessages = false; log.push({ proc: name, inst: this }); }
  P.prototype.executeOn = function (view) { log.at(-1).executedOn = view; log.at(-1).noGUI = this.noGUIMessages; view.image.width = 50; view.image.height = 40; view.window.hasAstrometricSolution = false; return true; };
  return P;
}
function solvedWindow(id) {
  const w = { isNull: false, hasAstrometricSolution: true, keywords: [1, 2, 3] };
  w.mainView = { id, image: { width: 100, height: 80 }, window: w };
  return w;
}

test('resample_image integer mode: IntegerResample with a negative zoom, noGUIMessages set, the solution loss reported', async () => {
  const code = resamplePjsr({ viewId: 'V', mode: 'integer', zoom: -2, downsampling: 'Average', outputId: null });
  const log = [];
  const IntegerResample = fakeGeometryProcess('IntegerResample', log);
  IntegerResample.Average = 0; IntegerResample.Median = 1;
  const out = JSON.parse(vm.runInNewContext(code, sandboxWith({ V: solvedWindow('V') }, { IntegerResample })));
  assert.equal(log[0].inst.zoomFactor, -2);
  assert.equal(log[0].inst.downsamplingMode, 0);
  assert.equal(log[0].noGUI, true);
  assert.deepEqual(out.before, { width: 100, height: 80, solution: true, keywords: 3 });
  assert.equal(out.after.solution, false);

  const { api } = compilingApi({ replies: [JSON.stringify(out)] });
  const res = await tool(resampleTools, 'resample_image').handler(api, { view_id: 'V', mode: 'integer', factor: 2 });
  assert.match(res.text, /100x80 -> 50x40/);
  assert.match(res.text, /removed by the process/);
});

test('resample_image scale and to_reference modes emit Resample with the right sizing', async () => {
  const { api, emitted } = compilingApi({ replies: ['{"view":"V","before":{"solution":false},"after":{"solution":false}}', '{"view":"V","before":{"solution":false},"after":{"solution":false}}'] });
  const t = tool(resampleTools, 'resample_image');
  await t.handler(api, { view_id: 'V', mode: 'scale', factor: 0.5, interpolation: 'Lanczos3' });
  assert.match(emitted[0], /RelativeDimensions; P\.xSize = 0\.5; P\.ySize = 0\.5/);
  assert.match(emitted[0], /Resample\["Lanczos3"\]/);
  await t.handler(api, { view_id: 'V', mode: 'to_reference', reference_id: 'REF' });
  assert.match(emitted[1], /AbsolutePixels; P\.absoluteMode = Resample\.ForceWidthAndHeight/);
  assert.match(emitted[1], /windowById\("REF"\)/);
});

test('resample_image refuses a bad factor or a missing reference before any PJSR', async () => {
  const { api, emitted } = compilingApi();
  const t = tool(resampleTools, 'resample_image');
  await assert.rejects(t.handler(api, { view_id: 'V', mode: 'integer', factor: 1 }), /factor/);
  await assert.rejects(t.handler(api, { view_id: 'V', mode: 'integer', factor: 1.5 }), /integer/);
  await assert.rejects(t.handler(api, { view_id: 'V', mode: 'scale', factor: 0 }), /factor/);
  await assert.rejects(t.handler(api, { view_id: 'V', mode: 'to_reference' }), /reference_id/);
  await assert.rejects(t.handler(api, { view_id: 'V', mode: 'scale', factor: 2, output_id: 'bad id' }), /output_id/);
  assert.equal(emitted.length, 0);
});

// --- run_plate_solve scale search -------------------------------------------

function runSolverSnippet(code, { solveAt, hadSolution = false }) {
  const tries = [];
  function ImageSolver() { this.solverCfg = {}; this.metadata = { ResolutionFromFocal: (f) => f }; }
  ImageSolver.starsCSVFilePath = () => '/tmp/x.csv';
  const w = {
    isNull: false, keywords: [], hasAstrometricSolution: hadSolution, astrometricSolutionSummary: () => 'Resolution ...... 2.9 arcsec/px',
    mainView: { image: { width: 4000, height: 3000 } },
    imageToCelestial: (p) => ({ x: 10 + (p.x - 2000) * (2.9 / 3600) / Math.cos(20 * Math.PI / 180), y: 20 }), // 2.9"/px along the row at Dec 20
  };
  ImageSolver.prototype.initialize = function () {};
  ImageSolver.prototype.solveImage = function () {
    tries.push(this.metadata.resolution * 3600);
    if (tries.length === solveAt) { w.hasAstrometricSolution = true; return true; }
    return false;
  };
  const out = vm.runInNewContext(code, {
    ImageSolver, CatalogMode: { LocalXPSDServer: 3 }, Point: function (x, y) { this.x = x; this.y = y; },
    ImageWindow: { windowById: () => w }, File: { directoryExists: () => true, createDirectory() {} }, JSON, Math, Date,
  });
  return { tries, res: JSON.parse(out.slice(out.lastIndexOf('@@SOLVE@@') + 9)) };
}

test('run_plate_solve retries with wider scale seeds and reports the solved/expected ratio', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['@@SOLVE@@{"solved":false}'] });
  await tool(astrometryTools, 'run_plate_solve').handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.5 });
  const { tries, res } = runSolverSnippet(emitted[0], { solveAt: 3 });
  assert.deepEqual(tries.map((s) => +s.toFixed(3)), [1.5, 0.75, 3]);
  assert.equal(res.solved, true);
  assert.equal(res.expectedScale, 1.5);
  assert.ok(Math.abs(res.solvedScale - 2.9) < 1e-3);
  assert.ok(Math.abs(res.scaleRatio - 2.9 / 1.5) < 1e-3);

  const ok = createFakeBridge({ replies: ['@@SOLVE@@' + JSON.stringify(res)] });
  const text = (await tool(astrometryTools, 'run_plate_solve').handler(apiFrom(ok.ctx), { view_id: 'L' })).text;
  assert.match(text, /Solved scale 2\.9000"\/px, expected 1\.5000"\/px, ratio 1\.933/);
  assert.match(text, /solved at scale seed 3 of 3/);
});

test('run_plate_solve re-solves an image that already carries a solution, and scale_search false tries one seed', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['x', 'x'] });
  const t = tool(astrometryTools, 'run_plate_solve');
  await t.handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.5 });
  await t.handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, pixel_scale: 1.5, scale_search: false });
  assert.equal(runSolverSnippet(emitted[0], { solveAt: 1, hadSolution: true }).tries.length, 1);
  const one = runSolverSnippet(emitted[1], { solveAt: 99 });
  assert.equal(one.tries.length, 1);
  assert.equal(one.res.solved, false);
});

test('run_plate_solve failure lists the scale seeds it tried', async () => {
  const res = { solved: false, error: 'no solution', attempts: [{ seedScale: 1.5 }, { seedScale: 0.75 }, { seedScale: 3 }] };
  const { ctx } = createFakeBridge({ replies: ['@@SOLVE@@' + JSON.stringify(res)] });
  const out = await tool(astrometryTools, 'run_plate_solve').handler(apiFrom(ctx), { view_id: 'L' });
  assert.equal(out.isError, true);
  assert.match(out.text, /Scale seeds tried: 1\.500"\/px, 0\.750"\/px, 3\.000"\/px\./);
});

// --- catalog_stars ----------------------------------------------------------

function gaiaSandbox({ valid, sources, searchThrows = false }) {
  const log = [];
  function Gaia() { this.sources = []; }
  Gaia.prototype.executeGlobal = function () {
    log.push({ command: this.command, release: this.dataRelease });
    if (this.command === 'get-info') { this.isValid = valid.includes(this.dataRelease); return true; }
    if (searchThrows) throw new Error('boom');
    this.sources = sources;
    return true;
  };
  const W = 100, H = 100;
  const w = {
    isNull: false, hasAstrometricSolution: true,
    mainView: { image: { width: W, height: H, numberOfChannels: 1, sample: (x, y) => (x === 50 && y === 50 ? 0.99 : 0.01) } },
    imageToCelestial: (p) => ({ x: p.x / 100, y: p.y / 100 }),
    celestialToImage: (p) => ({ x: p.x * 100, y: p.y * 100 }),
  };
  const sandbox = {
    Gaia, Point: function (x, y) { this.x = x; this.y = y; }, JSON, Math, isFinite,
    console: { beginLog() {}, endLog() { return ''; } },
    ImageWindow: { windowById: () => w },
  };
  return { log, sandbox };
}
const baseCatalogOpts = { viewId: 'V', magLimit: 14, magLow: -2, release: null, order: [['DR3/SP', 4], ['DR3', 3], ['EDR3', 2], ['DR2', 1]], marginFraction: 0.05, saturationLevel: 0.9, supplement: [], mergePx: 3 };

test('catalog_stars searches once, on the earliest valid release, with positions, colour and saturation', () => {
  const src = [[0.5, 0.5, 0, 0, 0, 8, 9, 7.5], [0.2, 0.3, 0, 0, 0, 12, 12.5, 11.5], [2, 2, 0, 0, 0, 10, null, null]];
  const { log, sandbox } = gaiaSandbox({ valid: [3], sources: src });
  const out = JSON.parse(vm.runInNewContext(catalogStarsPjsr(baseCatalogOpts), sandbox));
  assert.deepEqual(log.map((l) => `${l.command}:${l.release}`), ['get-info:4', 'get-info:3', 'search:3']);
  assert.equal(out.release, 'DR3');
  assert.equal(out.list[0].G, 8);
  assert.equal(out.list[0].BP_RP, 1.5);
  assert.equal(out.list[0].saturated, true);
  assert.equal(out.inFrame, 2);
  assert.equal(out.list.find((s) => s.G === 10).inFrame, false);
});

test('catalog_stars fails clearly when the named release is not installed, without searching', () => {
  const { log, sandbox } = gaiaSandbox({ valid: [], sources: [] });
  assert.throws(() => vm.runInNewContext(catalogStarsPjsr({ ...baseCatalogOpts, release: ['DR3/SP', 4] }), sandbox), /Gaia DR3\/SP is not installed or not valid/);
  assert.deepEqual(log.map((l) => l.command), ['get-info']);
  const none = gaiaSandbox({ valid: [], sources: [] });
  assert.throws(() => vm.runInNewContext(catalogStarsPjsr(baseCatalogOpts), none.sandbox), /No valid Gaia data release/);
  assert.equal(none.log.filter((l) => l.command === 'search').length, 0);
});

test('catalog_stars reports a failed search without trying another release', () => {
  const { log, sandbox } = gaiaSandbox({ valid: [4, 3], sources: [], searchThrows: true });
  assert.throws(() => vm.runInNewContext(catalogStarsPjsr(baseCatalogOpts), sandbox), /Gaia DR3\/SP search failed: boom/);
  assert.equal(log.filter((l) => l.command === 'search').length, 1);
});

test('catalog_stars merges supplement stars, replacing Gaia stars within merge_px', () => {
  const src = [[0.5, 0.5, 0, 0, 0, 8, 9, 7.5], [0.2, 0.3, 0, 0, 0, 12, 12.5, 11.5]];
  const { sandbox } = gaiaSandbox({ valid: [4], sources: src });
  const out = JSON.parse(vm.runInNewContext(catalogStarsPjsr({ ...baseCatalogOpts, supplement: [{ ra: 0.505, dec: 0.5, mag: 3.8, name: 'bright one' }] }), sandbox));
  assert.equal(out.mergedIntoSupplement, 1);
  assert.equal(out.list[0].supplement, 'bright one');
  assert.equal(out.list[0].G, 3.8);
  assert.equal(out.stars, 2);
});

test('catalog_stars handler writes the full list under scratchDir/catalog and inlines a short list', async (t) => {
  const ws = tempWs(t);
  const reply = { release: 'DR3/SP', stars: 2, list: [{ G: 8 }, { G: 9 }] };
  const { api, emitted } = compilingApi({ replies: [JSON.stringify(reply)], overrides: { workspace: ws } });
  const out = JSON.parse((await tool(catalogTools, 'catalog_stars').handler(api, { view_id: 'V', mag_limit: 12 })).text);
  assert.ok(out.file.startsWith(path.join(ws.scratchDir, 'catalog')));
  assert.deepEqual(JSON.parse(fs.readFileSync(out.file, 'utf8')).list, reply.list);
  assert.equal(out.list.length, 2);
  assert.match(emitted[0], /"magLimit":12/);
  await assert.rejects(tool(catalogTools, 'catalog_stars').handler(api, { view_id: 'V', mag_limit: 12, supplement: [{ ra: 1 }] }), /supplement\[0\]\.dec/);
});

// --- align_files ------------------------------------------------------------

function alignFixture(t, n) {
  const ws = tempWs(t);
  fs.mkdirSync(ws.outputDir, { recursive: true });
  const ref = path.join(ws.dir, 'ref.xisf');
  fs.writeFileSync(ref, '');
  const targets = Array.from({ length: n }, (_, i) => { const p = path.join(ws.dir, `t${i}.xisf`); fs.writeFileSync(p, ''); return p; });
  return { ws, ref, targets };
}

test('align_files runs targets in batches of at most batch_size into a folder inside output/', async (t) => {
  const { ws, ref, targets } = alignFixture(t, 45);
  const reply = (k) => JSON.stringify({ ok: true, columns: ['outputImage'], rows: Array.from({ length: k }, () => ({ outputImage: 'x_r.xisf' })) });
  const { api, emitted } = compilingApi({ replies: [reply(20), reply(20), reply(5)], overrides: { workspace: ws } });
  const out = JSON.parse((await tool(alignTools, 'align_files').handler(api, { reference_file: ref, target_files: targets, output_dir: 'registered' })).text);
  assert.equal(emitted.length, 3);
  assert.equal(out.batches, 3);
  assert.equal(out.rows.length, 45);
  assert.equal(out.outputDir, path.join(ws.outputDir, 'registered'));
  assert.ok(fs.existsSync(out.outputDir));
});

test('align_files refuses an output folder outside the workspace, a missing file and a batch over 20', async (t) => {
  const { ws, ref, targets } = alignFixture(t, 1);
  const { api, emitted } = compilingApi({ overrides: { workspace: ws } });
  const a = tool(alignTools, 'align_files');
  const outside = await a.handler(api, { reference_file: ref, target_files: targets, output_dir: path.join(os.tmpdir(), 'elsewhere') });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /output_dir must be inside/);
  await assert.rejects(a.handler(api, { reference_file: ref, target_files: [path.join(ws.dir, 'missing.xisf')], output_dir: 'r' }), /target_files not found/);
  await assert.rejects(a.handler(api, { reference_file: ref, target_files: targets, output_dir: 'r', batch_size: 21 }), /batch_size/);
  assert.equal(emitted.length, 0);
});

test('align_files matrix_only: OutputMatrix into a temporary scratch folder that is listed and removed', async (t) => {
  const { ws, ref, targets } = alignFixture(t, 2);
  const fb = createFakeBridge();
  const api = apiFrom({
    ...fb.ctx,
    pjsr: async (code) => {
      fb.emitted.push(code);
      const dir = JSON.parse(code.match(/var o = (\{.*\});/)[1]).outputDir;
      fs.writeFileSync(path.join(dir, 't0_r.xisf'), 'x'); // StarAlignment writing a file anyway
      return { status: 'ok', outputs: { consoleOutput: JSON.stringify({ ok: true, columns: [], rows: [{}, {}] }) } };
    },
  }, { workspace: ws });
  const out = JSON.parse((await tool(alignTools, 'align_files').handler(api, { reference_file: ref, target_files: targets, matrix_only: true })).text);
  assert.equal(out.matrixOnly, true);
  assert.equal(out.filesWrittenAndDeleted.length, 1);
  assert.ok(!fs.existsSync(path.dirname(out.filesWrittenAndDeleted[0])));
  assert.ok(path.dirname(out.filesWrittenAndDeleted[0]).startsWith(path.join(ws.scratchDir, 'align_files')));
});

test('align_files batch snippet sets OutputMatrix, noGUIMessages and reads outputData by its named columns', () => {
  const made = [];
  function StarAlignment() { made.push(this); this.noGUIMessages = false; }
  StarAlignment.OutputMatrix = 4; StarAlignment.Lanczos3 = 5;
  StarAlignment.outputData_outputImage = 0; StarAlignment.outputData_totalPairMatches = 1; StarAlignment.outputData_referenceStarX = 2;
  StarAlignment.prototype.executeGlobal = function () { this.outputData = [['a_r.xisf', 812, [1, 2, 3]]]; return true; };
  const code = alignBatchPjsr({ reference: '/r.xisf', targets: ['/a.xisf'], outputDir: '/o', postfix: '_r', overwrite: false, distortionCorrection: true, interpolation: 'Lanczos3', matrixOnly: true });
  const out = JSON.parse(vm.runInNewContext(code, { StarAlignment, JSON, Object }));
  assert.equal(made[0].mode, 4);
  assert.equal(made[0].noGUIMessages, true);
  assert.equal(made[0].pixelInterpolation, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(made[0].targets)), [[true, true, '/a.xisf']]);
  assert.deepEqual(out.rows[0], { target: '/a.xisf', outputImage: 'a_r.xisf', totalPairMatches: 812, referenceStarXCount: 3 });
});

// --- run_wbpp / wbpp_status -------------------------------------------------

function wbppFixture(t, { heartbeat, spawnPid = 4242, alive = () => false } = {}) {
  const ws = tempWs(t);
  const root = path.join(ws.dir, 'pi');
  const solver = path.join(root, 'src', 'scripts', 'ImageSolver', 'ImageSolver.js');
  const wbppJs = path.join(root, 'src', 'scripts', 'BatchPreprocessing', 'WBPP.js');
  fs.mkdirSync(path.dirname(wbppJs), { recursive: true });
  fs.writeFileSync(wbppJs, '');
  const input = path.join(ws.dir, 'raw');
  fs.mkdirSync(input);
  if (heartbeat) {
    const hb = path.join(ws.dir, 'agentic', 'bridge', 'rig', 'heartbeat');
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, `${heartbeat} ${Date.now()}`);
  }
  const spawned = [];
  const listeners = {};
  const spawn = (bin, argv, opts) => { spawned.push({ bin, argv, opts }); return { pid: spawnPid, on: (ev, fn) => { listeners[ev] = fn; }, unref() {} }; };
  const [runWbpp, wbppStatus] = makeWbppTools({ spawn, isPidAlive: alive, mid: () => 'rig', now: () => Date.UTC(2026, 8, 28, 12, 0, 0) });
  const api = apiFrom(createFakeBridge().ctx, { workspace: ws, platform: { piBin: '/fake/PixInsight', imageSolverPath: solver } });
  return { ws, input, spawned, listeners, runWbpp, wbppStatus, api, wbppJs };
}

test('run_wbpp starts a separate headless instance with only the given WBPP parameters', async (t) => {
  const f = wbppFixture(t);
  const out = JSON.parse((await f.runWbpp.handler(f.api, {
    input_dirs: [f.input], output_dir: 'wbpp', keywords: [{ name: 'SCOPE', mode: 'prepost' }], reference: 'auto_by_keyword', reference_keyword: 'SCOPE',
    local_normalization: true, autocrop: true, rejection: 'Auto', weights: 'PSFSignal',
  })).text);
  assert.equal(f.spawned.length, 1);
  const { bin, argv, opts } = f.spawned[0];
  assert.equal(bin, '/fake/PixInsight');
  assert.deepEqual([argv[0], argv[1], argv[3]], ['-n', '--automation-mode', '--force-exit']);
  const r = argv[2];
  assert.ok(r.startsWith(`-r=${f.wbppJs.replaceAll('\\', '/')},automationMode=true,dir=`));
  for (const p of ['keywords=SCOPE prepost', 'groupingKeywordsEnabled=true', 'bestFrameReferenceMethod=2', 'bestFrameReferenceKeyword=SCOPE',
    'localNormalization=true', 'localNormalizationInteractiveMode=false', 'autocrop=true', 'rejection_4=5', 'subframeWeightingEnabled=true', 'subframesWeightsMethod=0']) {
    assert.ok(r.includes(p), p);
  }
  assert.ok(!/integrate=|platesolve=|imageRegistration=/.test(r), 'no parameter the caller did not give');
  assert.equal(opts.detached, true);
  assert.equal(out.runId, 'wbpp_20260928T120000Z');
  assert.ok(fs.existsSync(path.join(f.ws.scratchDir, 'wbpp', out.runId, 'run.json')));
  assert.ok(fs.existsSync(path.join(f.ws.outputDir, 'wbpp')));
});

test('run_wbpp writes a pipeline-builder script for optimize_darks and drizzle_scale', async (t) => {
  const f = wbppFixture(t);
  const out = JSON.parse((await f.runWbpp.handler(f.api, { input_dirs: [f.input], output_dir: 'w', optimize_darks: true, drizzle_scale: 2 })).text);
  const builder = path.join(f.ws.scratchDir, 'wbpp', out.runId, 'pipeline_builder.js');
  const text = fs.readFileSync(builder, 'utf8');
  assert.match(text, /optimizeMasterDark = true/);
  assert.match(text, /setDrizzleData\(\{ enabled: true, scale: 2 \}\)/);
  assert.match(text, /buildPipelineForLight\(\)/);
  assert.ok(f.spawned[0].argv[2].includes('usePipelineBuilderScript=true,pipelineBuilderScriptFile='));
  assert.doesNotThrow(() => new vm.Script(pipelineBuilderScript({ optimizeDarks: true, drizzleScale: 1 })));
});

test('run_wbpp refuses while the GUI watcher is busy and while an earlier run is alive', async (t) => {
  const busy = wbppFixture(t, { heartbeat: 'busy' });
  const r1 = await busy.runWbpp.handler(busy.api, { input_dirs: [busy.input], output_dir: 'w' });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /watcher busy/);
  assert.equal(busy.spawned.length, 0);

  const f = wbppFixture(t, { alive: (pid) => pid === 4242 });
  await f.runWbpp.handler(f.api, { input_dirs: [f.input], output_dir: 'w' });
  const again = await f.runWbpp.handler(f.api, { input_dirs: [f.input], output_dir: 'w' });
  assert.equal(again.isError, true);
  assert.match(again.text, /still running/);
  assert.equal(f.spawned.length, 1);
});

test('run_wbpp refuses paths outside the workspace, commas, and a missing WBPP.js', async (t) => {
  const f = wbppFixture(t);
  const outside = await f.runWbpp.handler(f.api, { input_dirs: [f.input], output_dir: path.join(os.tmpdir(), 'x') });
  assert.equal(outside.isError, true);
  assert.throws(() => wbppArgs({ input_dirs: ['/a,b'] }, { scriptPath: '/s/WBPP.js', outputDir: '/o' }), /comma/);
  assert.throws(() => wbppArgs({ input_dirs: ['/a'], extra_params: { 'bad name': 1 } }, { scriptPath: '/s/WBPP.js', outputDir: '/o' }), /parameter name/);
  const noScript = makeWbppTools({ spawn: () => { throw new Error('must not spawn'); } })[0];
  const api = apiFrom(createFakeBridge().ctx, { workspace: f.ws, platform: { piBin: '/fake/PixInsight', imageSolverPath: '/nowhere/src/scripts/ImageSolver/ImageSolver.js' } });
  const r = await noScript.handler(api, { input_dirs: [f.input], output_dir: 'w' });
  assert.equal(r.isError, true);
  assert.match(r.text, /WBPP\.js not found/);
  assert.equal(wbppScriptPath({ imageSolverPath: 'C:\\PI\\src\\scripts\\ImageSolver\\ImageSolver.js' }), 'C:\\PI\\src\\scripts\\BatchPreprocessing\\WBPP.js');
});

test('wbpp_status reports running, then finished with masters, per-group counts and the console tail', async (t) => {
  let alive = true;
  const f = wbppFixture(t, { alive: () => alive });
  const { runId } = JSON.parse((await f.runWbpp.handler(f.api, { input_dirs: [f.input], output_dir: 'w' })).text);
  const running = JSON.parse((await f.wbppStatus.handler(f.api, {})).text);
  assert.equal(running.state, 'running');
  const out = path.join(f.ws.outputDir, 'w');
  fs.mkdirSync(path.join(out, 'master'), { recursive: true });
  fs.writeFileSync(path.join(out, 'master', 'masterLight_FILTER-L.xisf'), '');
  fs.mkdirSync(path.join(out, 'registered', 'L_300s'), { recursive: true });
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(out, 'registered', 'L_300s', `${n}_r.xisf`), '');
  fs.appendFileSync(path.join(f.ws.scratchDir, 'wbpp', runId, 'pixinsight.log'), 'line 1\nline 2\n');
  alive = false;
  f.listeners.exit(0, null);
  const done = JSON.parse((await f.wbppStatus.handler(f.api, { run_id: runId })).text);
  assert.equal(done.state, 'finished');
  assert.deepEqual(done.masters, ['masterLight_FILTER-L.xisf']);
  assert.deepEqual(done.registeredPerGroup, { L_300s: 3 });
  assert.deepEqual(done.consoleTail, ['line 1', 'line 2']);
  f.listeners.exit(1, null);
  const failed = await f.wbppStatus.handler(f.api, { run_id: runId });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /exited with code 1/);
  const bad = await f.wbppStatus.handler(f.api, { run_id: '../x' });
  assert.equal(bad.isError, true);
});

test('activeWbppRun: the run without an exit record whose pid is alive; null when none', async () => {
  const { activeWbppRun } = await import('../src/tools/wbpp.mjs');
  const files = { '/s/wbpp/a/run.json': '{"pid": 1}', '/s/wbpp/a/exit.json': '{"code": 0}', '/s/wbpp/b/run.json': '{"pid": 2}', '/s/wbpp/c/run.json': '{"pid": 3}' };
  const norm = (p) => p.split('\\').join('/');
  const fs = { readdirSync: (d) => { if (norm(d) !== '/s/wbpp') throw new Error('ENOENT'); return ['a', 'b', 'c']; },
    readFileSync: (f) => { const v = files[norm(f)]; if (v === undefined) throw new Error('ENOENT'); return v; } };
  assert.deepEqual(activeWbppRun({ scratchDir: '/s', fs, isPidAlive: (pid) => pid === 3 }), { runId: 'c', pid: 3 });
  assert.equal(activeWbppRun({ scratchDir: '/s', fs, isPidAlive: () => false }), null);
  assert.equal(activeWbppRun({ scratchDir: '/none', fs, isPidAlive: () => true }), null);
});

// --- reproject_to_reference -------------------------------------------------

function reprojectSandbox(log, { srcSolved = true, refSolved = true, failAt = null } = {}) {
  const windows = {};
  function fakeWin(id, w, h, solved) {
    const win = { isNull: false, hasAstrometricSolution: solved, keywords: ['K1', 'K2'] };
    win.mainView = {
      id,
      image: { width: w, height: h, numberOfChannels: 1, isColor: false, maximum: () => 1 },
      beginProcess: () => log.push('begin'),
      endProcess: () => log.push('end'),
    };
    win.copyAstrometricSolution = (r) => { log.push(`copy:${r.mainView.id}`); win.hasAstrometricSolution = true; };
    win.regenerateAstrometricSolution = () => log.push('regen');
    win.astrometricReprojection = (s) => { if (failAt === 'reproject') throw new Error('reprojection failed'); log.push(`reproject:${s.mainView.id}`); };
    win.forceClose = () => log.push('close');
    win.show = () => log.push('show');
    return win;
  }
  windows.SRC = fakeWin('SRC', 100, 80, srcSolved);
  windows.REF = fakeWin('REF', 200, 160, refSolved);
  function ImageWindow(w, h, ch, bits, isReal, isColor, id) {
    log.push(`new:${w}x${h}x${ch}:${bits}:${isReal}:${id}`);
    windows[id] = fakeWin(id, w, h, false);
    return windows[id];
  }
  ImageWindow.windowById = (id) => windows[id] ?? { isNull: true };
  const InterpolationAlgorithm = { Auto: 0, Lanczos3: 4 };
  return { ImageWindow, InterpolationAlgorithm, UndoFlag: { NoSwapFile: 1 }, JSON, Date, windows };
}

const REPROJECT_OPTS = { viewId: 'SRC', referenceId: 'REF', outputId: 'OUT', interpolation: 'Lanczos3', clamp: 0.3 };

test('reproject_to_reference: a reference-sized 32-bit float window takes the reference solution, then the source is reprojected once', () => {
  const log = [];
  const sb = reprojectSandbox(log);
  const out = JSON.parse(vm.runInNewContext(reprojectPjsr(REPROJECT_OPTS), sb));
  assert.deepEqual(log, ['new:200x160x1:32:true:OUT', 'begin', 'copy:REF', 'regen', 'reproject:SRC', 'end', 'show']);
  assert.equal(sb.windows.SRC.mainView.image.interpolation, 4, 'Lanczos3');
  assert.equal(sb.windows.SRC.mainView.image.interpolationClamping, 0.3);
  assert.equal(sb.windows.OUT.mainView.image.interpolationQuality, 1);
  assert.deepEqual(sb.windows.OUT.keywords, ['K1', 'K2']);
  assert.equal(out.view, 'OUT');
  assert.equal(out.width, 200);
  assert.equal(out.solution, true);
  assert.equal(out.empty, false);
});

test('reproject_to_reference refuses an unsolved image or an existing output before creating a window, and closes the window on failure', () => {
  for (const [opts, re] of [
    [{ srcSolved: false }, /SRC has no astrometric solution/],
    [{ refSolved: false }, /REF has no astrometric solution/],
  ]) {
    const log = [];
    assert.throws(() => vm.runInNewContext(reprojectPjsr(REPROJECT_OPTS), reprojectSandbox(log, opts)), re);
    assert.deepEqual(log, []);
  }
  const taken = reprojectSandbox([]);
  taken.windows.OUT = { isNull: false };
  assert.throws(() => vm.runInNewContext(reprojectPjsr(REPROJECT_OPTS), taken), /already open/);

  const log = [];
  assert.throws(() => vm.runInNewContext(reprojectPjsr(REPROJECT_OPTS), reprojectSandbox(log, { failAt: 'reproject' })), /reprojection failed/);
  assert.equal(log.at(-1), 'close');
  assert.ok(!log.includes('show'));
});

test('reproject_to_reference: default output id, default interpolation and clamp, warning on an empty result, and bad input refused before any PJSR', async () => {
  const { api, emitted } = compilingApi({
    replies: ['{"view":"SRC_reprojected","width":200,"height":160,"channels":1,"interpolation":"Lanczos3","clamp":0.3,"seconds":3.2,"solution":true,"empty":true}'],
  });
  const t = tool(reprojectTools, 'reproject_to_reference');
  const res = await t.handler(api, { view_id: 'SRC', reference_id: 'REF' });
  assert.match(emitted[0], /new ImageWindow\(ri\.width, ri\.height, si\.numberOfChannels, 32, true, si\.isColor, "SRC_reprojected"\)/);
  assert.match(emitted[0], /InterpolationAlgorithm\["Lanczos3"\]/);
  assert.match(emitted[0], /si\.interpolationClamping = 0\.3;/);
  assert.match(res.text, /Reprojected SRC onto REF's grid as SRC_reprojected: 200x160/);
  assert.match(res.text, /WARNING: the result is empty/);

  const before = emitted.length;
  await assert.rejects(t.handler(api, { view_id: 'SRC', reference_id: 'REF', interpolation: 'Sinc' }), /interpolation/);
  await assert.rejects(t.handler(api, { view_id: 'SRC', reference_id: 'REF', clamp: 2 }), /clamp/);
  await assert.rejects(t.handler(api, { view_id: 'SRC', reference_id: 'REF', output_id: 'bad id' }), /output_id/);
  await assert.rejects(t.handler(api, { view_id: '1x', reference_id: 'REF' }), /view_id/);
  assert.equal(emitted.length, before);
});
