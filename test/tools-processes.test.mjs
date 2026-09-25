import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/processes.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('processes.mjs exports the 15 process-wrapper tools', () => {
  assert.deepEqual(
    Object.keys(byName).sort(),
    ['find_filters', 'linear_fit', 'run_abe', 'run_background_neutralization', 'run_bxt', 'run_curves',
      'run_gradient_correction', 'run_hdrmt', 'run_lhe', 'run_mgc', 'run_nxt', 'run_scnr', 'run_spcc', 'run_spfc', 'run_sxt'].sort()
  );
});

// --- defineProcessTool declarations ---

test('run_scnr emits SCNR with amount and the V8 protection constant', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_scnr.handler(apiFrom(ctx), { view_id: 'RGB', amount: 0.6, protection: 'MaximumMask' });
  assert.match(emitted[0], /new SCNR/);
  assert.match(emitted[0], /P\.amount = 0\.6/);
  assert.match(emitted[0], /P\.protectionMethod = SCNR\.MaximumMask/);
});

test('run_gradient_correction emits a bare GradientCorrection with no params', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_gradient_correction.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(emitted[0], /new GradientCorrection/);
  assert.doesNotMatch(emitted[0], /P\.\w+\s*=/, 'no parameter assignments beyond the process instantiation');
});

test('run_background_neutralization emits BackgroundNeutralization with no params', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_background_neutralization.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(emitted[0], /new BackgroundNeutralization/);
});

test('run_nxt emits NoiseXTerminator with denoise/detail', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_nxt.handler(apiFrom(ctx), { view_id: 'RGB', denoise: 0.2 });
  assert.match(emitted[0], /new NoiseXTerminator/);
  assert.match(emitted[0], /P\.denoise = 0\.2/);
});

test('linear_fit emits LinearFit with referenceViewId and rejection thresholds', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.linear_fit.handler(apiFrom(ctx), { view_id: 'L', reference_id: 'RGB', reject_high: 0.9 });
  assert.match(emitted[0], /new LinearFit/);
  assert.match(emitted[0], /P\.referenceViewId = "RGB"/);
  assert.match(emitted[0], /P\.rejectHigh = 0\.9/);
});

test('linear_fit requires reference_id and run_nxt requires denoise, as the legacy tools did', () => {
  assert.deepEqual(byName.linear_fit.inputSchema.required, ['view_id', 'reference_id']);
  assert.deepEqual(byName.run_nxt.inputSchema.required, ['view_id', 'denoise']);
});

test('run_nxt and linear_fit report what they ran, not a bare "Script executed."', async () => {
  const nxt = createFakeBridge({ replies: ['Script executed.'] });
  const a = await byName.run_nxt.handler(apiFrom(nxt.ctx), { view_id: 'RGB', denoise: 0.35 });
  assert.equal(a.text, 'NoiseXTerminator ran on view "RGB" with denoise=0.35.');
  const fit = createFakeBridge({ replies: ['Script executed.'] });
  const b = await byName.linear_fit.handler(apiFrom(fit.ctx), { view_id: 'L', reference_id: 'RGBlum' });
  assert.equal(b.text, 'LinearFit ran on view "L" with reference_id=RGBlum.');
});

// --- Escape-hatch descriptors ---

test('run_bxt forces AI mode and only sets sharpen params outside correct_only', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_bxt.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(emitted[0], /new BlurXTerminator/);
  assert.match(emitted[0], /P\.AI = true/);
  assert.match(emitted[0], /P\.nonstellar_then_stellar = true/);
});

test('run_bxt correct_only mode skips the sharpen assignments', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_bxt.handler(apiFrom(ctx), { view_id: 'RGB', correct_only: true });
  assert.match(emitted[0], /P\.correct_only = true/);
  assert.doesNotMatch(emitted[0], /sharpen_nonstellar/);
});

test('run_sxt reports the starless and stars view ids on success', async () => {
  const { ctx } = createFakeBridge({ replies: ['ok'] });
  ctx.listImages = (() => {
    let n = 0;
    return async () => (n++ === 0 ? [{ id: 'RGB' }] : [{ id: 'RGB' }, { id: 'RGB_stars' }]);
  })();
  const out = await byName.run_sxt.handler(apiFrom(ctx), { view_id: 'RGB', is_linear: true });
  assert.match(out.text, /Stars: RGB_stars/);
  assert.match(out.text, /unscreen=false/);
});

test('run_sxt reports failure as text, not a throw', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'SXT declined' } }] });
  const out = await byName.run_sxt.handler(apiFrom(ctx), { view_id: 'RGB', is_linear: false });
  assert.match(out.text, /SXT failed: SXT declined/);
});

test('run_abe emits AutomaticBackgroundExtractor with the in-place correction constants', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_abe.handler(apiFrom(ctx), { view_id: 'RGB', poly_degree: 2 });
  assert.match(emitted[0], /new AutomaticBackgroundExtractor/);
  assert.match(emitted[0], /P\.polyDegree = 2/);
  assert.match(emitted[0], /AutomaticBackgroundExtractor\.Correction_Subtract/);
});

// run_lhe replaces pixinsight-pack-astro@eee19b3's policy stub (which ran nothing) with the process itself.
test('run_lhe emits LocalHistogramEqualization with only the values given', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  const out = await byName.run_lhe.handler(apiFrom(ctx), {
    view_id: 'L', radius: 64, slope_limit: 1.5, amount: 0.3, circular_kernel: false, histogram_resolution: 'Bit12',
  });
  assert.match(emitted[0], /new LocalHistogramEqualization/);
  assert.match(emitted[0], /P\.radius = 64;/);
  assert.match(emitted[0], /P\.slopeLimit = 1\.5;/);
  assert.match(emitted[0], /P\.amount = 0\.3;/);
  assert.match(emitted[0], /P\.circularKernel = false;/);
  assert.match(emitted[0], /P\.histogramBins = LocalHistogramEqualization\.Bit12;/);
  assert.doesNotMatch(emitted[0], /prototype/);
  assert.match(out.text, /LocalHistogramEqualization ran on view "L"/);
  assert.doesNotMatch(out.text, /POLICY|multi_scale_enhance/);
});

test('run_lhe needs only view_id; omitted values stay PixInsight defaults', async () => {
  assert.deepEqual(byName.run_lhe.inputSchema.required, ['view_id']);
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  const out = await byName.run_lhe.handler(apiFrom(ctx), { view_id: 'L' });
  assert.doesNotMatch(emitted[0], /P\.\w+\s*=/);
  assert.match(out.text, /PixInsight's default parameters/);
  await assert.rejects(byName.run_lhe.handler(apiFrom(ctx), { view_id: 'L', histogram_resolution: 'Bit16' }), /Bit8, Bit10, Bit12/);
});

test('run_hdrmt emits HDRMultiscaleTransform with the requested layer count', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_hdrmt.handler(apiFrom(ctx), { view_id: 'RGB', layers: 6, inverted: true });
  assert.match(emitted[0], /new HDRMultiscaleTransform/);
  assert.match(emitted[0], /P\.numberOfLayers = 6/);
  assert.match(emitted[0], /P\.invertedIterations = true/);
});

test('run_curves selects the K property for channel RGB and emits the control points', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_curves.handler(apiFrom(ctx), { view_id: 'RGB', channel: 'RGB', points: [[0, 0], [1, 1]] });
  assert.match(emitted[0], /new CurvesTransformation/);
  assert.match(emitted[0], /P\.K = \[\[0,0\],\[1,1\]\]/);
});

test('find_filters reads api.platform.filterDbPath, not a hardcoded path', async () => {
  const { ctx } = createFakeBridge();
  const dbPath = 'test/fixtures/filters.xspd';
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync(dbPath, '<Filter name="Astronomik Ha 6nm" channel="Ha" data="1,1"/>');
  try {
    const api = apiFrom(ctx, { platform: { ...apiFrom(ctx).platform, filterDbPath: dbPath } });
    const out = await byName.find_filters.handler(api, { query: 'Ha' });
    assert.match(out.text, /Astronomik Ha 6nm/);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('run_spfc routes through api.platform.filterDbPath for the QE curve lookup', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  const dbPath = 'test/fixtures/filters2.xspd';
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync(dbPath, '<Filter name="Ideal QE curve" channel="Q" data="1,1"/>');
  try {
    const api = apiFrom(ctx, { platform: { ...apiFrom(ctx).platform, filterDbPath: dbPath } });
    const out = await byName.run_spfc.handler(api, { view_id: 'L', filter: 'Ha' });
    assert.match(emitted[0], /new SpectrophotometricFluxCalibration/);
    assert.match(out.text, /Ideal QE curve/);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('run_spcc reports a friendly message instead of throwing when a curve name is unknown', async () => {
  const { ctx } = createFakeBridge();
  const dbPath = 'test/fixtures/filters3.xspd';
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync(dbPath, '<Filter name="Something" channel="R" data="1,1"/>');
  try {
    const api = apiFrom(ctx, { platform: { ...apiFrom(ctx).platform, filterDbPath: dbPath } });
    const out = await byName.run_spcc.handler(api, { view_id: 'RGB', red_filter_name: 'NoSuchFilter' });
    assert.match(out.text, /SPCC not run/);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('run_mgc fails clearly when no MARS files are configured or passed', async () => {
  const { ctx } = createFakeBridge();
  const settingsPath = 'test/fixtures/no-mars.settings';
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync(settingsPath, '<settings></settings>');
  try {
    const api = apiFrom(ctx, { platform: { ...apiFrom(ctx).platform, settingsPath } });
    const out = await byName.run_mgc.handler(api, { view_id: 'RGB' });
    assert.match(out.text, /no MARS database files configured/);
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test('run_mgc uses mars_files passed directly without touching the settings file', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ median: 0.1 }), 'ok', JSON.stringify({ median: 0.05 })] });
  const api = apiFrom(ctx, { platform: { ...apiFrom(ctx).platform, settingsPath: '/does/not/exist.settings' } });
  const out = await byName.run_mgc.handler(api, { view_id: 'RGB', mars_files: ['/tmp/fake.xmars'] });
  assert.match(emitted[1], /new MultiscaleGradientCorrection/);
  assert.match(out.text, /MGC done with 1 MARS file/);
});

// A process that ran is reported as run even if the follow-up statistics read fails (the tool's
// behaviour before stats moved to api.stats); only an abort gets through.
test('a failed statistics read after a successful process does not turn the result into an error', async () => {
  const { ctx } = createFakeBridge({ replies: ['ok', { status: 'error', error: { message: 'View not found: RGB' } }] });
  const out = await byName.run_curves.handler(apiFrom(ctx), { view_id: 'RGB', channel: 'RGB', points: [[0, 0], [1, 1]] });
  assert.notEqual(out.isError, true);
  assert.match(out.text, /Curves \(RGB\) applied/);
});

// --- find_filters: grouped curve names ---

async function findFilters(t, input, names = [['Sony IMX411/455/461/533/571', 'Q'], ['Sony IMX533 (test)', 'Q'], ['Sony IMX5330', 'Q'], ['Sony IMX585', 'Q'],
  ['Canon Full Spectrum B / Antlia ALP-T', 'B'], ['Astronomik Ha 6nm', 'L']]) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-filters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'filters.xspd');
  writeFileSync(db, `<xspd>${names.map(([n, c]) => `<Filter name="${n}" channel="${c}" data="400,1,700,1"/>`).join('')}</xspd>`);
  const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, {
    platform: { piBin: '/fake', imageSolverPath: '/fake', filterDbPath: db, whiteRefPath: '/fake', settingsPath: '/fake', verified: true },
  });
  const text = (await byName.find_filters.handler(api, input)).text;
  return { count: Number(text.match(/^(\d+) match/)[1]), names: text.split('\n').slice(1) };
}

test('find_filters: a sensor number matches the grouped curve "Sony IMX411/455/461/533/571"', async (t) => {
  for (const query of ['IMX533', 'imx461', 'Sony IMX571', 'IMX411']) {
    const r = await findFilters(t, { query, channel: 'Q' });
    assert.ok(r.names.includes('Sony IMX411/455/461/533/571 [Q]'), `${query}: ${JSON.stringify(r.names)}`);
  }
  assert.equal((await findFilters(t, { query: 'IMX46', channel: 'Q' })).names.includes('Sony IMX411/455/461/533/571 [Q]'), true, 'a prefix of an expanded name matches too');
  assert.equal((await findFilters(t, { query: 'IMX999', channel: 'Q' })).count, 0);
  assert.equal((await findFilters(t, { query: '455/461' })).count, 1, 'the name as written still matches');
});

test('find_filters: direct matches (exact, then substring) come before grouped-name matches', async (t) => {
  const r = await findFilters(t, { query: 'IMX533', channel: 'Q' });
  assert.deepEqual(r.names, ['Sony IMX533 (test) [Q]', 'Sony IMX5330 [Q]', 'Sony IMX411/455/461/533/571 [Q]']);
  const exact = await findFilters(t, { query: 'sony imx585' });
  assert.deepEqual(exact.names, ['Sony IMX585 [Q]']);
});

test('find_filters: the exact name comes first, even when the database lists a substring hit before it', async (t) => {
  const r = await findFilters(t, { query: 'ha' }, [['Astronomik Ha 6nm', 'L'], ['Baader Ha 3.5nm', 'L'], ['Ha', 'L']]);
  assert.deepEqual(r.names, ['Ha [L]', 'Astronomik Ha 6nm [L]', 'Baader Ha 3.5nm [L]']);
});

test('find_filters: a slash between two filter names is not a group to expand', async (t) => {
  assert.equal((await findFilters(t, { query: 'Canon Full Spectrum Antlia' })).count, 0);
  assert.equal((await findFilters(t, { query: 'Antlia ALP-T' })).count, 1);
});
