import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePixInsight } from '../src/runtime.mjs';

test('does nothing when PixInsight is already running', async () => {
  let spawned = 0;
  const r = await ensurePixInsight({ probe: { isRunning: async () => true }, spawn: () => spawned++ });
  assert.equal(r.started, false);
  assert.equal(spawned, 0);
});

test('spawns PixInsight detached when it is not running, then waits for it', async () => {
  let running = false;
  const args = [];
  const r = await ensurePixInsight({
    platform: { piBin: '/fake/PixInsight' },
    probe: { isRunning: async () => running },
    spawn: (bin, a, opts) => { args.push([bin, a, opts]); running = true; return { unref() {} }; },
  });
  assert.equal(r.started, true);
  assert.equal(args[0][0], '/fake/PixInsight');
  assert.equal(args[0][2].detached, true);
});

test('PIXINSIGHT_CONNECTOR_AUTOSTART=0 declines to start it and says so', async () => {
  const r = await ensurePixInsight({
    env: { PIXINSIGHT_CONNECTOR_AUTOSTART: '0' },
    probe: { isRunning: async () => false },
    spawn: () => assert.fail('must not spawn when autostart is disabled'),
  });
  assert.equal(r.started, false);
  assert.match(r.skipped, /PIXINSIGHT_CONNECTOR_AUTOSTART/);
});

test('a null probe result means unknown, so it does not spawn a second instance', async () => {
  const r = await ensurePixInsight({
    probe: { isRunning: async () => null },
    spawn: () => assert.fail('must not spawn when liveness is unknown'),
  });
  assert.equal(r.started, false);
  assert.match(r.skipped, /could not determine/i);
});

test('gives up with an actionable message rather than hanging forever', async () => {
  await assert.rejects(() => ensurePixInsight({
    platform: { piBin: '/fake/PixInsight' },
    probe: { isRunning: async () => false },
    spawn: () => ({ unref() {} }),   // never becomes alive
    timeoutMs: 50,
  }), /PIXINSIGHT_BIN|did not start/);
});
