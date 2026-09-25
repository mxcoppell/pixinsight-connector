// ============================================================================
// Live test: exercises src/tools/introspect.mjs against a real, running
// PixInsight install instead of the fake bridge. Opt-in only — CI has no
// PixInsight, and `node --test test/` recurses into this directory, so this
// file must skip itself rather than fail there.
//
// Wiring: the same assembly serve() performs (src/server.mjs): resolvePlatform,
// createProcessProbe, createWorkspace and buildRuntimeApi, so the first
// api.pjsr() call materializes the watcher and launches PixInsight on demand.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { listProcesses, describeProcess } from '../../src/tools/introspect.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };

test('enumerates the real installed process table', live, async () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const { api } = buildRuntimeApi({
    platform: resolvePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() }),
    probe: createProcessProbe(),
    workspace: createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform }),
    log: () => {},
    connectorVersion: version,
  });
  const { processes } = await listProcesses(api);
  assert.ok(processes.length > 100, `expected the full table, got ${processes.length}`);
  assert.ok(processes.includes('SCNR') && processes.includes('PixelMath'));
});

test('describe_process names an unknown process and still describes a real one', live, async () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const { api } = buildRuntimeApi({
    platform: resolvePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() }),
    probe: createProcessProbe(),
    workspace: createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform }),
    log: () => {},
    connectorVersion: version,
  });
  await assert.rejects(() => describeProcess(api, 'SPCC'), /No PixInsight process named SPCC/);
  await assert.rejects(() => describeProcess(api, 'CheckBox'), /No PixInsight process named CheckBox/);
  const d = await describeProcess(api, 'SpectrophotometricColorCalibration');
  assert.equal(d.process, 'SpectrophotometricColorCalibration');
});
