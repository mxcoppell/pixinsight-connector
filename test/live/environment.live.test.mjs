// ============================================================================
// Live test: src/tools/environment.mjs against a real PixInsight, wired the way
// serve() wires it. Opt-in only (PIXINSIGHT_CONNECTOR_LIVE=1); skipped in CI.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { inspectEnvironment } from '../../src/tools/environment.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };

function liveApi() {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return buildRuntimeApi({
    platform: resolvePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() }),
    probe: createProcessProbe(),
    workspace: createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform }),
    log: () => {},
    connectorVersion: version,
  }).api;
}

test('inspect_environment reports every section from a real install and leaves no probe image open', live, async () => {
  const api = liveApi();
  const before = (await api.listImages()).map((i) => i.id ?? i);
  const out = await inspectEnvironment(api, { ra_deg: 150.1, dec_deg: 20.2 });
  assert.match(out.pixinsightVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(out.gaia.releases.length, 4);
  for (const r of out.gaia.releases) assert.equal(typeof r.valid, 'boolean');
  if (out.mars.results?.length) for (const r of out.mars.results) assert.notEqual(r.status, 'unknown', JSON.stringify(r));
  for (const x of out.xterminators) if (x.installed) assert.ok(x.version, JSON.stringify(x));
  const after = (await api.listImages()).map((i) => i.id ?? i);
  assert.deepEqual(after, before);
  console.log(JSON.stringify(out, null, 2));
});

test('inspect_environment reports a missing MARS file as missing', live, async () => {
  const out = await inspectEnvironment(liveApi(), { sections: ['mars'], mars_files: ['/nonexistent/none.xmars'] });
  assert.equal(out.mars.results[0].status, 'missing');
});
