import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/session.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// workspace_info, set_workspace, resume_bridge and list_packs are server-defined (src/server.mjs);
// test/server-workspace.test.mjs covers the first two.
test('session.mjs exports pixinsight_info only', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['pixinsight_info']);
});

test('pixinsight_info reports platform paths and connector version, read-only', async () => {
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { connectorVersion: '9.9.9' });
  const out = await byName.pixinsight_info.handler(api, {});
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.piBin, api.platform.piBin);
  assert.equal(parsed.imageSolverPath, api.platform.imageSolverPath);
  assert.equal(parsed.filterDbPath, api.platform.filterDbPath);
  assert.equal(parsed.whiteRefPath, api.platform.whiteRefPath);
  assert.equal(parsed.settingsPath, api.platform.settingsPath);
  assert.equal(parsed.verified, api.platform.verified);
  assert.equal(parsed.connectorVersion, '9.9.9');
});

test('pixinsight_info never reports live process status (that is doctor-only) — no probe access on the pure api object', async () => {
  const { ctx } = createFakeBridge();
  // No `probe` in the api at all -- the pure Pack API v1 object (src/api.mjs's buildApi()) never
  // has one, so a handler that still reached for api.probe would throw here.
  const api = apiFrom(ctx);
  const out = await byName.pixinsight_info.handler(api, {});
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.process, undefined, 'process/live-status fields must be gone entirely');
  assert.equal(parsed.running, undefined);
  assert.equal(parsed.startedAt, undefined);
  assert.equal(parsed.memoryMB, undefined);
});

test('pixinsight_info reports an unresolved install as an error, with the reason', async () => {
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { platform: { error: 'Could not find a PixInsight installation (looked for "/opt/PixInsight/bin/PixInsight").' } });
  const out = await byName.pixinsight_info.handler(api, {});
  assert.equal(out.isError, true);
  assert.match(out.text, /Could not find a PixInsight installation/);
  assert.match(out.text, /connectorVersion/);
});
