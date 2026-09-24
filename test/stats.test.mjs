import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge } from './fake-bridge.mjs';
import { measureUniformity } from '../src/tools/measure.mjs';

test('measure_uniformity asks PixInsight for four corner medians and returns the stddev', async () => {
  const { ctx, emitted } = createFakeBridge({
    replies: [JSON.stringify({ score: 0.0012, corners: [1, 1, 1, 1], mean: 1 })],
  });
  const out = await measureUniformity(ctx, 'RGB', 200);
  assert.equal(out.score, 0.0012);
  assert.match(emitted[0], /selectedRect/);
  assert.match(emitted[0], /windowById\("RGB"\)/);
});

test('measure_uniformity surfaces a PixInsight error instead of returning a fake score', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'not found' } }] });
  await assert.rejects(() => measureUniformity(ctx, 'NOPE', 200), /not found/);
});

test('measure_uniformity quotes the view id instead of splicing it into PJSR', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ score: 0 })] });
  await measureUniformity(ctx, "x'); File.remove('/tmp/a", 200);
  assert.ok(emitted[0].includes(JSON.stringify("x'); File.remove('/tmp/a")), 'the id must arrive as one JSON string literal');
  assert.doesNotMatch(emitted[0], /windowById\('x'\)/);
});

test('measure_uniformity refuses a sample size that is not a finite number', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ score: 0 })] });
  await assert.rejects(() => measureUniformity(ctx, 'RGB', '200; File.remove("/x")'), /finite number/);
  assert.equal(emitted.length, 0, 'nothing reaches PixInsight');
});

test('measure_uniformity throws on output it cannot parse instead of inventing a score', async () => {
  for (const reply of ['', 'Script executed.']) {
    const { ctx } = createFakeBridge({ replies: [reply] });
    await assert.rejects(() => measureUniformity(ctx, 'RGB', 200), /could not read/i);
  }
});
