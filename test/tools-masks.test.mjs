import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { compilingApi } from './helpers.mjs';
import { tools } from '../src/tools/masks.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('masks.mjs exports the 6 mask tools', () => {
  assert.deepEqual(Object.keys(byName).sort(), [
    'apply_mask', 'close_mask', 'create_adaptive_zone_masks', 'create_luminance_mask', 'create_zone_masks', 'remove_mask',
  ]);
});

test('create_luminance_mask queries dims then builds the luminance expression and blur', async () => {
  const { ctx, emitted } = createFakeBridge({
    replies: [JSON.stringify({ w: 100, h: 100, color: true, id: 'RGB' }), 'ok'],
  });
  const out = await byName.create_luminance_mask.handler(apiFrom(ctx), { source_id: 'RGB', mask_id: 'LMask' });
  assert.match(emitted[1], /0\.2126\*RGB\[0\]\+0\.7152\*RGB\[1\]\+0\.0722\*RGB\[2\]/);
  assert.match(emitted[1], /new Convolution/);
  assert.match(out.text, /LMask/);
});

test('create_luminance_mask surfaces a lookup failure as text, not a throw', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'not found' } }] });
  const out = await byName.create_luminance_mask.handler(apiFrom(ctx), { source_id: 'NOPE', mask_id: 'LMask' });
  assert.match(out.text, /Failed to create mask/);
  assert.equal(out.isError, true);
});

test('apply_mask sets mask/maskVisible/maskInverted on the target', async () => {
  const { ctx, emitted } = createFakeBridge();
  await byName.apply_mask.handler(apiFrom(ctx), { target_id: 'RGB', mask_id: 'LMask', inverted: true });
  assert.match(emitted[0], /tw\.maskInverted = true/);
  assert.match(emitted[0], /tw\.isNull/, 'a missing target is an error, not a silent no-op');
  assert.match(emitted[0], /mw\.isNull/, 'a missing mask is an error, not a silent no-op');
});

test('remove_mask calls removeMask on the target window', async () => {
  const { ctx, emitted } = createFakeBridge();
  await byName.remove_mask.handler(apiFrom(ctx), { target_id: 'RGB' });
  assert.match(emitted[0], /removeMask\(\)/);
});

test('close_mask force-closes the mask window', async () => {
  const { ctx, emitted } = createFakeBridge();
  await byName.close_mask.handler(apiFrom(ctx), { mask_id: 'LMask' });
  assert.match(emitted[0], /forceClose\(\)/);
});

// ---------------------------------------------------------------------------
// create_zone_masks / create_adaptive_zone_masks, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (test/pack-astro-masks.test.mjs).
// ---------------------------------------------------------------------------
const ZONE_CLIPS = { core_clip: 0.5, shell_clip: 0.15, halo_clip: 0.04 };

test('create_zone_masks builds core/shell/halo from the three thresholds, blurred 8/12/20', async () => {
  const reply = JSON.stringify({ coreId: 'mask_core', shellId: 'mask_shell', haloId: 'mask_halo', thresholds: { core: 0.5, shell: 0.15, halo: 0.04 } });
  const { api, emitted } = compilingApi({ replies: [reply] });
  const out = await byName.create_zone_masks.handler(api, { view_id: 'RGB', ...ZONE_CLIPS });
  assert.match(emitted[0], /windowById\("RGB"\)/);
  assert.match(emitted[0], /lum > 0\.5 \? Math\.min\(1, \(lum - 0\.5\) \/ \(1 - 0\.5\)\)/);
  assert.match(emitted[0], /lum > 0\.15 && lum <= 0\.5/);
  assert.match(emitted[0], /lum > 0\.04 && lum <= 0\.15/);
  assert.match(emitted[0], /conv\.sigma = 8;[\s\S]*conv\.sigma = 12;[\s\S]*conv\.sigma = 20;/);
  assert.match(out.text, /Zone masks created: mask_core \(>0\.5\), mask_shell \(0\.15-0\.5\), mask_halo \(0\.04-0\.15\)/);
});

test('create_zone_masks requires core_clip, shell_clip and halo_clip, with no default', () => {
  const schema = byName.create_zone_masks.inputSchema;
  for (const p of ['core_clip', 'shell_clip', 'halo_clip']) {
    assert.ok(schema.required.includes(p), `${p} is required`);
    assert.equal(schema.properties[p].default, undefined);
    assert.doesNotMatch(schema.properties[p].description, /default/i, `${p}: no default stated`);
  }
});

test('create_zone_masks refuses a missing threshold before any PJSR is sent', async () => {
  for (const missing of ['core_clip', 'shell_clip', 'halo_clip']) {
    const input = { view_id: 'RGB', ...ZONE_CLIPS };
    delete input[missing];
    const { api, emitted } = compilingApi();
    await assert.rejects(byName.create_zone_masks.handler(api, input), new RegExp(`${missing}: expected a finite number`));
    assert.equal(emitted.length, 0, `no PJSR without ${missing}`);
  }
});

test('create_zone_masks rejects a non-numeric threshold', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(byName.create_zone_masks.handler(api, { view_id: 'RGB', ...ZONE_CLIPS, halo_clip: '0.04); evil(' }), /finite number/);
  assert.equal(emitted.length, 0);
});

test('create_zone_masks rejects thresholds that would divide by zero', async () => {
  const { api, emitted } = compilingApi();
  const h = byName.create_zone_masks.handler;
  await assert.rejects(h(api, { view_id: 'RGB', ...ZONE_CLIPS, core_clip: 1 }), /core_clip must be < 1/);
  await assert.rejects(h(api, { view_id: 'RGB', ...ZONE_CLIPS, core_clip: 0.3, shell_clip: 0.3 }), /shell_clip must be < core_clip/);
  await assert.rejects(h(api, { view_id: 'RGB', ...ZONE_CLIPS, shell_clip: 0.1, halo_clip: 0.2 }), /halo_clip must be < shell_clip/);
  assert.equal(emitted.length, 0);
});

test('create_adaptive_zone_masks uses percentile thresholds biased by core_bias', async () => {
  const reply = JSON.stringify({
    coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer',
    roi: { cx: 10, cy: 20, radius: 30 }, thresholds: { core: 0.8, shellLow: 0.3, outer: 0.1 },
    pixelCounts: { core: 5, shell: 50, outer: 500 },
  });
  const { api, emitted } = compilingApi({ replies: [reply] });
  const out = await byName.create_adaptive_zone_masks.handler(api, { view_id: 'RGB', core_bias: 0.8 });
  assert.match(emitted[0], /var corePerc = 0\.85 \+ 0\.10 \* 0\.8;/);
  assert.match(emitted[0], /roiSubject\.length \* 0\.25/);
  assert.match(out.text, /Core: azone_core \(5 px, threshold=0\.800\)/);
  assert.match(out.text, /ROI: center=\(10,20\), radius=30/);
});

test('create_adaptive_zone_masks: core_bias omitted is 0.5, the middle of its own 0-1 scale', async () => {
  const reply = JSON.stringify({ coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer', roi: {}, thresholds: {}, pixelCounts: {} });
  const { api, emitted } = compilingApi({ replies: [reply] });
  await byName.create_adaptive_zone_masks.handler(api, { view_id: 'RGB' });
  assert.match(emitted[0], /var corePerc = 0\.85 \+ 0\.10 \* 0\.5;/);
  assert.deepEqual(byName.create_adaptive_zone_masks.inputSchema.required, ['view_id']);
});

test('create_adaptive_zone_masks reports too few subject pixels as an error', async () => {
  const { api } = compilingApi({ replies: [JSON.stringify({ error: 'too_few_subject_pixels', count: 3 })] });
  await assert.rejects(byName.create_adaptive_zone_masks.handler(api, { view_id: 'RGB' }), /too_few_subject_pixels \(3 pixels\)/);
});

test('create_adaptive_zone_masks guards the zero-width shell band', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ error: 'too_few_subject_pixels', count: 0 })] });
  await assert.rejects(byName.create_adaptive_zone_masks.handler(api, { view_id: 'RGB' }));
  assert.match(emitted[0], /if \(half > 0 && lum > shellLow && lum <= coreTh\)/);
});

test('the zone-mask descriptions state what the tool does, not what it is for', () => {
  const OPINION = /planetary|nebula|emission|best for|unlike|apply lhe|independent processing|enhance halo/i;
  for (const name of ['create_zone_masks', 'create_adaptive_zone_masks']) {
    const t = byName[name];
    assert.doesNotMatch(t.description, OPINION, `${name}: ${t.description.match(OPINION)?.[0]}`);
    for (const [p, s] of Object.entries(t.inputSchema.properties)) {
      assert.doesNotMatch(s.description, OPINION, `${name}.${p}`);
    }
  }
});

test('the zone-mask descriptions document the algorithm the masks are built with', () => {
  assert.match(byName.create_zone_masks.description, /sigma 8, 12 and 20/);
  assert.match(byName.create_zone_masks.description, /mask_core, mask_shell and mask_halo/);
  const a = byName.create_adaptive_zone_masks.description;
  for (const re of [/5 MAD/, /0\.35/, /20 px/, /85 \+ 10/, /25th percentile/, /sigma 5, 10 and 20/, /azone_core, azone_shell and azone_outer/]) {
    assert.match(a, re);
  }
});

test('create_adaptive_zone_masks refuses core_bias outside [0, 1] before sending PJSR', async () => {
  for (const v of [-0.1, 1.5]) {
    const { api, emitted } = compilingApi();
    await assert.rejects(byName.create_adaptive_zone_masks.handler(api, { view_id: 'RGB', core_bias: v }), /core_bias/);
    assert.equal(emitted.length, 0);
  }
});
