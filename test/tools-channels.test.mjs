import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/channels.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('channels.mjs exports combine_channels, align_to_reference, run_per_channel_abe and lrgb_combine', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['align_to_reference', 'combine_channels', 'lrgb_combine', 'run_per_channel_abe']);
});

test('combine_channels emits ChannelCombination and renames the result', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['CC_result=true', 'ok'] });
  let call = 0;
  ctx.listImages = async () => (call++ === 0 ? [] : [{ id: 'combined_tmp', width: 100, height: 100, isColor: true }]);
  const out = await byName.combine_channels.handler(apiFrom(ctx), {
    r_view_id: 'R', g_view_id: 'G', b_view_id: 'B', output_id: 'RGB',
  });
  assert.match(emitted[0], /new ChannelCombination/);
  assert.match(emitted[1], /mainView\.id = "RGB"/);
  assert.match(out.text, /Combined into RGB/);
});

test('combine_channels reports failure without throwing', async () => {
  const { ctx } = createFakeBridge({ replies: ['CC_result=false'] });
  const out = await byName.combine_channels.handler(apiFrom(ctx), {
    r_view_id: 'R', g_view_id: 'G', b_view_id: 'B', output_id: 'RGB',
  });
  assert.match(out.text, /ChannelCombination failed/);
  assert.equal(out.isError, true);
});

test('align_to_reference saves both views, runs StarAlignment, and reports dimensions', async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  try {
    const { ctx, emitted } = createFakeBridge({
      replies: ['ok', 'ok', 'SA_result=true', 'aligned_G', 'ok', JSON.stringify({ ref: { w: 10, h: 10 }, tgt: { w: 10, h: 10 } })],
    });
    // The aligned file must exist on disk for the handler's fs.existsSync check.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(scratchDir, 'tmp_align'), { recursive: true });
    writeFileSync(path.join(scratchDir, 'tmp_align', 'aligned_G.xisf'), '');
    ctx.listImages = async () => [{ id: 'aligned_G', width: 10, height: 10, isColor: false }];
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    assert.match(emitted[2], /new StarAlignment/);
    assert.match(out.text, /Aligned G to R/);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference reports a StarAlignment failure without throwing', async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  try {
    const { ctx } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=false'] });
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    assert.match(out.text, /StarAlignment failed/);
    assert.equal(out.isError, true);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference does NOT touch target_id when StarAlignment\'s output name does not match — warns instead', async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true'] });
    // StarAlignment reported success, but the file on disk uses a different id than target_id
    // (e.g. PixInsight sanitized/changed it) — the expected "aligned_G.xisf" is absent.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const tmpAlignDir = path.join(scratchDir, 'tmp_align');
    mkdirSync(tmpAlignDir, { recursive: true });
    writeFileSync(path.join(tmpAlignDir, 'aligned_G_v2.xisf'), '');
    let listImagesCalled = false;
    ctx.listImages = async () => { listImagesCalled = true; return []; };
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });

    assert.match(out.text, /Expected aligned_G\.xisf not found; G was not changed\. Newest aligned file: .*aligned_G_v2\.xisf/);
    assert.equal(out.isError, true, 'the target was not aligned: that is not a success');
    // Only 3 pjsr calls happened (2 saves + StarAlignment) — nothing after the mismatch: no
    // forceClose of target_id, no ImageWindow.open of the fallback file, no rename, no dim query.
    assert.equal(emitted.length, 3);
    assert.equal(listImagesCalled, false, 'must not even query images once the mismatch is found');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference rejects a target_id that would escape the scratch directory', async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  try {
    const { ctx } = createFakeBridge();
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    await assert.rejects(
      () => byName.align_to_reference.handler(api, { reference_id: 'R', target_id: '../../../../etc/cron.d/evil' }),
      /no path separators/
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// M7 + I4: the target is never closed without its replacement, and the replacement is the view
// ImageWindow.open returned, not "any new non-colour view".
async function alignScratch() {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(path.join(scratchDir, 'tmp_align'), { recursive: true });
  writeFileSync(path.join(scratchDir, 'tmp_align', 'aligned_G.xisf'), '');
  return scratchDir;
}

test('align_to_reference leaves the target open when the aligned file cannot be opened, and says so as an error', async () => {
  const scratchDir = await alignScratch();
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true', { status: 'error', error: { message: 'Failed to open image' } }] });
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    assert.equal(out.isError, true);
    assert.match(out.text, /could not be opened/);
    assert.match(out.text, /G was not changed/);
    assert.ok(!emitted.some((c) => /windowById\("G"\)[\s\S]*forceClose/.test(c)), 'the target must not have been closed');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference renames the view ImageWindow.open returned, never another new view', async () => {
  const scratchDir = await alignScratch();
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true', 'aligned_G', 'ok', '{}'] });
    // An unrelated mono view the user opened meanwhile: the old heuristic could rename this one.
    ctx.listImages = async () => [{ id: 'Unrelated', isColor: false }, { id: 'aligned_G', isColor: false }];
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    assert.notEqual(out.isError, true);
    const swap = emitted.find((c) => /forceClose[\s\S]*mainView\.id = "G"/.test(c));
    assert.ok(swap, 'the aligned view is given the target id');
    assert.match(swap, /windowById\("aligned_G"\)/);
    assert.ok(!emitted.some((c) => /windowById\("Unrelated"\)/.test(c)), 'the unrelated view is never touched');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference reports a failed swap as an error that names where the aligned view is', async () => {
  const scratchDir = await alignScratch();
  try {
    const { ctx } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true', 'aligned_G', { status: 'error', error: { message: 'rename refused' } }] });
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    const out = await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    assert.equal(out.isError, true);
    assert.match(out.text, /aligned view "aligned_G"/);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference closes only the crop_mask views the aligned file brought, never one the user had open', async () => {
  const scratchDir = await alignScratch();
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true', 'aligned_G', 'ok', 'ok', '{}'] });
    let opened = false;
    ctx.listImages = async () => (opened
      ? [{ id: 'mine_crop_mask' }, { id: 'aligned_G' }, { id: 'aligned_G_crop_mask' }]
      : [{ id: 'mine_crop_mask' }]);
    const pjsr = ctx.pjsr;
    ctx.pjsr = async (code) => { if (/ImageWindow\.open/.test(code)) opened = true; return pjsr(code); };
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    const maskCloses = emitted.filter((c) => /crop_mask/.test(c));
    assert.equal(maskCloses.length, 1);
    assert.match(maskCloses[0], /aligned_G_crop_mask/);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('align_to_reference hands PixInsight every path as toPixPath makes it: a Windows path with forward slashes, a POSIX backslash kept', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-align-'));
  const scratchDir = `${base}${path.sep}a\\b`;
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(scratchDir, 'tmp_align'), { recursive: true });
    writeFileSync(path.join(scratchDir, 'tmp_align', 'aligned_G.xisf'), '');
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', 'ok', 'SA_result=true', 'aligned_G', 'ok', '{}'] });
    const api = apiFrom(ctx, { workspace: { dir: scratchDir, scratchDir } });
    await byName.align_to_reference.handler(api, { reference_id: 'R', target_id: 'G' });
    if (path.sep === '\\') {
      // Windows: `a\\b` is two folders; PJSR gets forward slashes.
      for (const code of emitted) assert.ok(!code.includes('a\\\\b'), `a backslash path reached PJSR: ${code.slice(0, 200)}`);
      assert.ok(emitted.some((c) => c.includes('a/b/tmp_align')));
    } else {
      // macOS/Linux: `a\\b` is one folder whose name holds a backslash; PJSR gets it unchanged.
      assert.ok(emitted.some((c) => c.includes(JSON.stringify(path.join(scratchDir, 'tmp_align')))), 'the real folder name reaches PJSR');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// run_per_channel_abe and lrgb_combine, folded in from mxcoppell/pixinsight-pack-astro@eee19b3.
// Every snippet is compiled (compilingApi) before the fake bridge answers.
// ---------------------------------------------------------------------------
import { compilingApi } from './helpers.mjs';

test('run_per_channel_abe and lrgb_combine take no target classification and document their inputs', () => {
  for (const name of ['run_per_channel_abe', 'lrgb_combine']) {
    const t = byName[name];
    assert.ok(t, `${name} is exported`);
    assert.equal(t.inputSchema.properties.classification, undefined, `${name}: classification`);
    for (const [k, p] of Object.entries(t.inputSchema.properties)) assert.ok(p.description, `${name}.${k}: no description`);
  }
});

test('run_per_channel_abe names its channel images through ChannelExtraction.channels (channelId is not a PixInsight parameter)', async () => {
  const { api, emitted } = compilingApi({ replies: ['ok'], stats: { median: 0.12, max: 0.9 }, images: ['RGB'] });
  await byName.run_per_channel_abe.handler(api, { view_id: 'RGB' });
  const code = emitted[0];
  assert.match(code, /new ChannelExtraction/);
  assert.match(code, /CE\.channels = \[\[true, "__pca_R"\], \[true, "__pca_G"\], \[true, "__pca_B"\]\];/);
  assert.doesNotMatch(code, /channelId|channelEnabled/);
  assert.match(code, /CC\.channels = \[\[true, "__pca_R"\], \[true, "__pca_G"\], \[true, "__pca_B"\]\];/);
  // A channel image that was not created under its name is an error, not a skipped channel.
  assert.match(code, /ChannelExtraction did not create/);
  assert.doesNotMatch(code, /continue;/);
});

test('run_per_channel_abe leaves every ABE parameter it is not given at PixInsight\'s default', async () => {
  const { api, emitted } = compilingApi({ replies: ['ok'], stats: { median: 0.12, max: 0.9 } });
  const out = await byName.run_per_channel_abe.handler(api, { view_id: 'RGB' });
  const code = emitted[0];
  for (const p of ['polyDegree', 'tolerance', 'deviation', 'boxSize', 'boxSeparation', 'normalize']) {
    assert.doesNotMatch(code, new RegExp(`P\\.${p} =`), `${p} is assigned`);
  }
  // What the tool does: subtract the model in place and discard it.
  assert.match(code, /P\.targetCorrection = AutomaticBackgroundExtractor\.Correction_Subtract;/);
  assert.match(code, /P\.replaceTarget = true;/);
  assert.match(code, /P\.discardModel = true;/);
  assert.match(out.text, /PixInsight default/);
  assert.doesNotMatch(out.text, /isError/);
});

test('run_per_channel_abe passes poly_degree and tolerance through when given', async () => {
  const { api, emitted } = compilingApi({ replies: ['ok'], stats: { median: 0.12, max: 0.9 } });
  const out = await byName.run_per_channel_abe.handler(api, { view_id: 'RGB', poly_degree: 2, tolerance: 1.5 });
  assert.match(emitted[0], /P\.polyDegree = 2;/);
  assert.match(emitted[0], /P\.tolerance = 1\.5;/);
  assert.match(out.text, /poly_degree=2/);
  assert.match(out.text, /tolerance=1\.5/);
  assert.match(out.text, /median=0\.120000/);
});

test('run_per_channel_abe rejects a non-integer poly_degree before sending anything', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(byName.run_per_channel_abe.handler(api, { view_id: 'RGB', poly_degree: 'x' }), /poly_degree/);
  assert.equal(emitted.length, 0);
});

test('run_per_channel_abe closes the images it left behind and reports a PixInsight failure as an error', async () => {
  let call = 0;
  const { api, emitted } = compilingApi({
    replies: [{ status: 'error', error: { message: 'ChannelExtraction did not create __pca_G' } }, 'closed'],
    overrides: { listImages: async () => (call++ === 0 ? [{ id: 'RGB' }] : [{ id: 'RGB' }, { id: '__pca_R' }]) },
  });
  await assert.rejects(byName.run_per_channel_abe.handler(api, { view_id: 'RGB' }), /ChannelExtraction did not create __pca_G/);
  assert.equal(emitted.length, 2);
  assert.match(emitted[1], /__pca_R/);
  assert.match(emitted[1], /forceClose/);
});

test('run_per_channel_abe describes what it does, not when to use it', () => {
  const t = byName.run_per_channel_abe;
  const text = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)].join(' ');
  assert.doesNotMatch(text, /NON-LINEAR|safest|Keep low|stretched|default 1\b|default 1\.2/i);
  assert.match(t.description, /AutomaticBackgroundExtractor/);
  assert.match(t.description, /ChannelCombination/);
});

test('lrgb_combine requires lightness and saturation, with no default', () => {
  const s = byName.lrgb_combine.inputSchema;
  for (const p of ['rgb_id', 'l_id', 'lightness', 'saturation']) assert.ok(s.required.includes(p), p);
  for (const p of ['lightness', 'saturation', 'linear_fit_reject_high']) assert.equal(s.properties[p].default, undefined, p);
  assert.ok(!s.required.includes('linear_fit_reject_high'));
});

test('lrgb_combine refuses a missing lightness or saturation before sending anything', async () => {
  for (const missing of ['lightness', 'saturation']) {
    const input = { rgb_id: 'RGB', l_id: 'L', lightness: 0.6, saturation: 0.85 };
    delete input[missing];
    const { api, emitted } = compilingApi();
    await assert.rejects(byName.lrgb_combine.handler(api, input), new RegExp(missing));
    assert.equal(emitted.length, 0);
  }
});

test('lrgb_combine sets LRGBCombination\'s own parameters: channels, mL and mc', async () => {
  const { api, emitted } = compilingApi({ replies: ['LRGB_OK'], stats: { median: 0.1, max: 0.7 } });
  const out = await byName.lrgb_combine.handler(api, { rgb_id: 'RGB', l_id: 'L', lightness: 0.6, saturation: 0.85 });
  assert.equal(emitted.length, 1, 'no LinearFit unless asked, no channel extraction');
  const code = emitted[0];
  assert.match(code, /new LRGBCombination/);
  assert.match(code, /P\.channels = \[\[false, "", 1\], \[false, "", 1\], \[false, "", 1\], \[true, "L", 1\]\];/);
  assert.match(code, /P\.mL = 0\.6;/);
  assert.match(code, /P\.mc = 0\.85;/);
  for (const p of ['channelL', 'channelR', 'lightness', 'saturation', 'noiseReduction']) {
    assert.doesNotMatch(code, new RegExp(`P\\.${p} =`), `${p} is assigned`);
  }
  assert.doesNotMatch(code, /new ChannelExtraction|new LinearFit/);
  assert.match(out.text, /lightness=0\.6/);
  assert.match(out.text, /saturation=0\.85/);
  assert.match(out.text, /no LinearFit/);
  assert.match(out.text, /median=0\.100000/);
});

test('lrgb_combine LinearFits L to the RGB luminance only when linear_fit_reject_high is given', async () => {
  const { api, emitted } = compilingApi({ replies: ['LinearFit done', 'LRGB_OK'], stats: { median: 0.1, max: 0.7 } });
  const out = await byName.lrgb_combine.handler(api, { rgb_id: 'RGB', l_id: 'L', lightness: 0.6, saturation: 0.85, linear_fit_reject_high: 0.92 });
  assert.equal(emitted.length, 2);
  assert.match(emitted[0], /new LinearFit/);
  assert.match(emitted[0], /0\.2126\*RGB\[0\] \+ 0\.7152\*RGB\[1\] \+ 0\.0722\*RGB\[2\]/);
  assert.match(emitted[0], /LF\.rejectHigh = 0\.92;/);
  assert.match(emitted[0], /LF\.referenceViewId = lumRef\.mainView\.id;/);
  assert.match(emitted[1], /new LRGBCombination/);
  assert.match(out.text, /LinearFit rejectHigh=0\.92/);
});

test('lrgb_combine reports an LRGBCombination failure as an error, with no PixelMath fallback', async () => {
  const failed = compilingApi({ replies: ['LRGB_FAILED'] });
  const out = await byName.lrgb_combine.handler(failed.api, { rgb_id: 'RGB', l_id: 'L', lightness: 0.6, saturation: 0.85 });
  assert.equal(out.isError, true);
  assert.match(out.text, /LRGBCombination/);
  assert.equal(failed.emitted.length, 1);
  assert.doesNotMatch(failed.emitted.join('\n'), /PixelMath/);

  const errored = compilingApi({ replies: [{ status: 'error', error: { message: 'Incompatible source image geometry' } }] });
  await assert.rejects(byName.lrgb_combine.handler(errored.api, { rgb_id: 'RGB', l_id: 'L', lightness: 0.6, saturation: 0.85 }), /Incompatible source image geometry/);
  assert.equal(errored.emitted.length, 1);
});

test('lrgb_combine refuses a view id that is not a PixInsight identifier', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(byName.lrgb_combine.handler(api, { rgb_id: 'RGB+1', l_id: 'L', lightness: 0.6, saturation: 0.85 }), /rgb_id/);
  assert.equal(emitted.length, 0);
});

test('lrgb_combine describes what it does, not what to pick', () => {
  const t = byName.lrgb_combine;
  const text = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)].join(' ');
  assert.doesNotMatch(text, /IFN|spiral|edge-on|veil|galaxy|dramatically|should be|default 0\.\d/i);
  assert.match(t.description, /LRGBCombination/);
  assert.match(text, /\bmL\b/);
  assert.match(text, /\bmc\b/);
});
