// The helper modules in src/tools/ (pjsr-args.mjs, zones.mjs) that the tools folded in from
// pixinsight-pack-astro@eee19b3 share, and the compilingApi() test helper every folded tool's
// tests use. A helper module exports no `tools` array, so the catalog scan passes over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as args from '../src/tools/pjsr-args.mjs';
import * as zones from '../src/tools/zones.mjs';
import { compilingApi } from './helpers.mjs';

// --- compilingApi ------------------------------------------------------------------------------

test('compilingApi refuses a snippet that is not valid JavaScript before it reaches the bridge', async () => {
  const { api, emitted } = compilingApi();
  await assert.rejects(api.pjsr('var x = ;'), /emitted PJSR does not parse/);
  assert.equal(emitted.length, 0);
});

test('compilingApi sends a valid snippet and returns the queued replies in order', async () => {
  const { api, emitted } = compilingApi({ replies: ['{"a":1}', { status: 'error', error: { message: 'boom' } }] });
  assert.equal((await api.pjsr('JSON.stringify({a:1})')).outputs.consoleOutput, '{"a":1}');
  assert.equal((await api.pjsr('1')).status, 'error');
  assert.deepEqual(emitted, ['JSON.stringify({a:1})', '1']);
});

test('compilingApi: api.stats is the real one (its PJSR is compiled and sent), unless stats are given', async () => {
  const real = compilingApi({ replies: [JSON.stringify({ median: 0.2, mad: 0.01, min: 0, max: 0.9 })] });
  await real.api.stats('RGB');
  assert.equal(real.emitted.length, 1);

  const canned = compilingApi({ stats: [{ median: 0.1 }, { median: 0.3 }] });
  assert.equal((await canned.api.stats('RGB')).median, 0.1);
  assert.equal((await canned.api.stats('RGB')).median, 0.3);
  assert.equal((await canned.api.stats('RGB')).median, 0.3, 'the last element repeats');
  assert.equal(canned.emitted.length, 0);
});

test('compilingApi: images lists open views; log lines are collected; overrides win', async () => {
  const { api, logs } = compilingApi({ images: ['RGB', 'Ha'], overrides: { connectorVersion: '9.9.9' } });
  assert.deepEqual(await api.listImages(), [{ id: 'RGB' }, { id: 'Ha' }]);
  api.log('hello');
  assert.deepEqual(logs, ['hello']);
  assert.equal(api.connectorVersion, '9.9.9');
});

// --- pjsr-args.mjs -----------------------------------------------------------------------------

test('pjsr-args exports only neutral argument helpers: no burn advice, no view check, no tools', () => {
  assert.deepEqual(Object.keys(args).sort(), ['bool', 'closeViews', 'fixed', 'int', 'lit', 'newImages', 'num', 'oneOf', 'pjsrJson', 'q', 'vid']);
});

test('num/int/bool/oneOf use the fallback only when the value is absent, and throw when there is none', () => {
  assert.equal(args.num(0.3, undefined, 'x'), 0.3);
  assert.equal(args.num(undefined, 5, 'x'), 5);
  assert.throws(() => args.num(undefined, undefined, 'strength'), /strength: expected a finite number, got undefined/);
  assert.throws(() => args.num('0.3', undefined, 'x'), /expected a finite number/);
  assert.throws(() => args.num(Infinity, undefined, 'x'), /expected a finite number/);
  assert.equal(args.int(3, undefined, 'n'), 3);
  assert.throws(() => args.int(2.5, undefined, 'n'), /n: expected an integer/);
  assert.equal(args.bool('false', undefined, 'b'), false);
  assert.equal(args.bool(undefined, true, 'b'), true);
  assert.throws(() => args.bool('yes', undefined, 'b'), /b: expected a boolean/);
  assert.equal(args.oneOf('soft', ['soft', 'hard'], undefined, 'mode'), 'soft');
  assert.throws(() => args.oneOf(undefined, ['soft', 'hard'], undefined, 'mode'), /mode: expected one of soft, hard/);
});

test('q quotes, vid admits only PixInsight identifiers, fixed formats or prints "?"', () => {
  assert.equal(args.q('a"b'), '"a\\"b"');
  assert.equal(args.vid('RGB_2'), 'RGB_2');
  assert.throws(() => args.vid('2RGB', 'ha_id'), /ha_id must be a PixInsight view identifier/);
  assert.throws(() => args.vid('RGB)+1', 'ha_id'), /view identifier/);
  assert.equal(args.fixed(0.123456, 3), '0.123');
  assert.equal(args.fixed(undefined, 3), '?');
});

test('pjsrJson parses the snippet output and turns a PJSR error into a thrown message', async () => {
  const ok = compilingApi({ replies: ['{"n":2}'] });
  assert.deepEqual(await args.pjsrJson(ok.api, '1'), { n: 2 });
  const bad = compilingApi({ replies: [{ status: 'error', error: { message: 'nope' } }] });
  await assert.rejects(args.pjsrJson(bad.api, '1', 'measure'), /measure failed: nope/);
});

test('newImages lists what opened since; closeViews closes the named views and sends nothing for none', async () => {
  const { api, emitted } = compilingApi({ images: ['A', 'B', 'C'] });
  assert.deepEqual(await args.newImages(api, ['A']), [{ id: 'B' }, { id: 'C' }]);
  await args.closeViews(api, []);
  assert.equal(emitted.length, 0);
  await args.closeViews(api, ['B', 'C']);
  assert.match(emitted[0], /\["B","C"\]/);
  assert.match(emitted[0], /forceClose\(\)/);
});

// --- zones.mjs ---------------------------------------------------------------------------------

const ZONE_REPLY = JSON.stringify({ coreId: 'mask_core', shellId: 'mask_shell', haloId: 'mask_halo', thresholds: { core: 0.5, shell: 0.2, halo: 0.05 } });

test('createZoneMasks has no default clip levels: each of the three is required', async () => {
  for (const missing of ['core_clip', 'shell_clip', 'halo_clip']) {
    const clips = { core_clip: 0.5, shell_clip: 0.2, halo_clip: 0.05 };
    delete clips[missing];
    const { api, emitted } = compilingApi({ replies: [ZONE_REPLY] });
    await assert.rejects(zones.createZoneMasks(api, 'RGB', clips), new RegExp(`${missing}: expected a finite number, got undefined`));
    assert.equal(emitted.length, 0, `${missing}: nothing sent`);
  }
});

test('createZoneMasks writes the given clip levels into valid PJSR and checks their order', async () => {
  const { api, emitted } = compilingApi({ replies: [ZONE_REPLY] });
  const out = await zones.createZoneMasks(api, 'RGB', { core_clip: 0.5, shell_clip: 0.2, halo_clip: 0.05 });
  assert.equal(out.coreId, 'mask_core');
  assert.match(emitted[0], /lum > 0\.5 \?/);
  assert.match(emitted[0], /lum > 0\.2 && lum <= 0\.5/);
  assert.match(emitted[0], /lum > 0\.05 && lum <= 0\.2/);
  await assert.rejects(zones.createZoneMasks(compilingApi().api, 'RGB', { core_clip: 0.2, shell_clip: 0.3, halo_clip: 0.05 }), /shell_clip must be < core_clip/);
  await assert.rejects(zones.createZoneMasks(compilingApi().api, 'RGB', { core_clip: 1, shell_clip: 0.3, halo_clip: 0.05 }), /core_clip must be < 1/);
  await assert.rejects(zones.createZoneMasks(compilingApi().api, 'RGB', { core_clip: 0.5, shell_clip: 0.3, halo_clip: 0.3 }), /halo_clip must be < shell_clip/);
});

test('createAdaptiveZoneMasks emits valid PJSR with its core_bias and reports too few subject pixels', async () => {
  const good = JSON.stringify({ coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer', roi: {}, thresholds: {}, pixelCounts: {} });
  const { api, emitted } = compilingApi({ replies: [good] });
  const out = await zones.createAdaptiveZoneMasks(api, 'RGB', { coreBias: 0.8 });
  assert.equal(out.shellId, 'azone_shell');
  assert.match(emitted[0], /0\.85 \+ 0\.10 \* 0\.8/);
  assert.deepEqual(zones.ADAPTIVE_ZONE_IDS, ['azone_core', 'azone_shell', 'azone_outer']);

  const few = compilingApi({ replies: [JSON.stringify({ error: 'too_few_subject_pixels', count: 12 })] });
  await assert.rejects(zones.createAdaptiveZoneMasks(few.api, 'RGB'), /too_few_subject_pixels \(12 pixels\)/);
});

test('helper modules export no tools array, so the catalog scan contributes nothing from them', () => {
  assert.equal(args.tools, undefined);
  assert.equal(zones.tools, undefined);
});

test('lit writes a PixelMath literal at full precision and never in exponent form', () => {
  assert.equal(args.lit(0.22), '0.2200000000000000');
  assert.equal(args.lit(1e-7), '0.00000010000000000000');
  assert.equal(args.lit(-0.5), '(-0.5000000000000000)');
});
