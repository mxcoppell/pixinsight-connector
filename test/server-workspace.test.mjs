// The workspace as the server serves it: workspace_info and set_workspace (server-defined, reserved),
// the unusable-workspace rule (the server starts and lists tools; every tool that needs the
// workspace fails with the fix), and a switch reaching api.workspace. Built the way serve() builds
// it -- buildRuntimeApi() + assembleCatalog() + createServer() -- with a fake bridge construction
// and an injected filesystem, so nothing here needs PixInsight or a particular home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildRuntimeApi, assembleCatalog } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { tools as sessionTools } from '../src/tools/session.mjs';
import { RESERVED_TOOLS } from '../src/packs.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { machineId } from '../src/machine-id.mjs';

const R = (...p) => path.resolve(...p);
const HOME = R('/home/u');
const trustingFs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
const FIX = /call set_workspace with the target folder, or set PIXINSIGHT_CONNECTOR_WORKSPACE/;

function workspaceAt(cwd, o = {}) {
  return createWorkspace({ cwd, env: {}, homeDir: HOME, platform: 'linux', fs: trustingFs, ...o });
}

async function serveWith(workspace, { packTools = [], pjsr } = {}) {
  const made = { bridges: 0, sends: 0 };
  const deps = {
    materializeWatcher: async () => ({ path: '/fake/watcher.js', warnings: [] }),
    machineId: () => 'mac-a',
    createBridge: () => {
      made.bridges++;
      return {
        pjsr: async (code) => { made.sends++; return pjsr ? pjsr(code) : { status: 'ok', outputs: { consoleOutput: 'ran' } }; },
        listImages: async () => { made.sends++; return [{ id: 'V1' }]; },
        log() {},
      };
    },
  };
  const { api, resetBridge, takeConsoleErrors, machineId } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace, log() {}, connectorVersion: '0', deps });
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools, resetBridge, workspace, machineId });
  const server = createServer({ catalog, api, takeConsoleErrors });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { client, call, api, made, close: async () => { await client.close(); await server.close(); } };
}

test('workspace_info and set_workspace are server-defined, reserved and listed', async () => {
  assert.ok(!sessionTools.some((t) => t.name === 'workspace_info'), 'workspace_info needs server state, so it is not a src/tools module');
  assert.ok(RESERVED_TOOLS.has('workspace_info'));
  assert.ok(RESERVED_TOOLS.has('set_workspace'));
  const s = await serveWith(workspaceAt(R('/w')));
  try {
    const { tools } = await s.client.listTools();
    const set = tools.find((t) => t.name === 'set_workspace');
    assert.ok(tools.some((t) => t.name === 'workspace_info'));
    assert.ok(set);
    assert.deepEqual(set.inputSchema.required, ['path']);
  } finally {
    await s.close();
  }
});

test('a pack cannot provide set_workspace or workspace_info', async () => {
  const fake = (name) => ({ name, description: 'A pack tool trying to take a reserved name.', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: 'pack' }) });
  const s = await serveWith(workspaceAt(R('/w')), { packTools: [fake('set_workspace'), fake('workspace_info')] });
  try {
    assert.notEqual((await s.call('set_workspace', { path: R('/x') })).text, 'pack');
    assert.notEqual((await s.call('workspace_info')).text, 'pack');
  } finally {
    await s.close();
  }
});

test('workspace_info reports the workspace, where it came from and its state dirs', async () => {
  const s = await serveWith(workspaceAt(R('/w')));
  try {
    const r = await s.call('workspace_info');
    assert.equal(r.isError, false);
    const state = path.join(R('/w'), 'agentic');
    assert.deepEqual(JSON.parse(r.text), {
      workspace: R('/w'), source: 'cwd', usable: true, stateDir: state,
      scratchDir: path.join(state, 'scratch'), bridgeDir: path.join(state, 'bridge'), machineBridgeDir: path.join(state, 'bridge', 'mac-a'),
      logsDir: path.join(state, 'logs'),
      outputDir: path.join(R('/w'), 'output'),
      log: { state: 'off', reason: 'no call log' }, // this server was built without one (server-call-log.test.mjs has it)
    });
    assert.equal(s.made.bridges, 0, 'workspace_info never builds the bridge');
  } finally {
    await s.close();
  }
});

test('with an unusable workspace the server lists every tool, and each tool that needs the workspace fails with the fix', async () => {
  const pack = { name: 'pack_scratch', description: 'A pack tool that reads the scratch directory.', inputSchema: { type: 'object', properties: {} },
    handler: async (api) => ({ text: api.workspace.scratchDir }) };
  const s = await serveWith(workspaceAt(HOME), { packTools: [pack] });
  try {
    const { tools } = await s.client.listTools();
    assert.ok(tools.length >= 45, `expected the full catalog, got ${tools.length}`);

    for (const [name, args] of [['run_pjsr', { code: '1;' }], ['list_open_images', {}], ['save_preview', { view_id: 'V1', label: 'p' }], ['scan_workspace', {}], ['pack_scratch', {}]]) {
      const r = await s.call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, FIX, `${name}: ${r.text}`);
      assert.match(r.text, /home directory/, name);
      assert.doesNotMatch(r.text, /^Error:/, `${name}: returned as is, not as a generic error`);
    }
    assert.equal(s.made.bridges, 0, 'no bridge is built for an unusable workspace');

    const info = await s.call('workspace_info');
    assert.equal(info.isError, false, 'workspace_info reports the state; it is not itself failing');
    const parsed = JSON.parse(info.text);
    assert.equal(parsed.usable, false);
    assert.equal(parsed.workspace, HOME);
    assert.match(parsed.reason, /home directory/);
    assert.match(parsed.fix, FIX);

    const ok = await s.call('pixinsight_info');
    assert.equal(ok.isError, false, 'a tool that does not need the workspace still works');
  } finally {
    await s.close();
  }
});

test('a workspace that goes missing mid-session fails every call that needs it with the fix, and nothing is sent', async () => {
  let missing = false;
  const fs = { ...trustingFs, statSync: () => { if (missing) throw new Error('ENOENT'); return { isDirectory: () => true }; } };
  const s = await serveWith(workspaceAt(R('/w'), { fs }));
  try {
    assert.equal((await s.call('run_pjsr', { code: '1;' })).isError, false);
    assert.equal(s.made.sends, 1);
    missing = true;
    for (const [name, args] of [['run_pjsr', { code: '2;' }], ['list_open_images', {}], ['save_preview', { view_id: 'V1', label: 'p' }]]) {
      const r = await s.call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, FIX, `${name}: ${r.text}`);
      assert.match(r.text, /does not exist/, name);
    }
    assert.equal(s.made.sends, 1, 'nothing reached the bridge while the workspace was missing');
    assert.equal(JSON.parse((await s.call('workspace_info')).text).usable, false);
    missing = false;
    assert.equal((await s.call('run_pjsr', { code: '3;' })).isError, false, 'usable again once it is back');
    assert.equal(s.made.sends, 2);
  } finally {
    await s.close();
  }
});

// Windows ACLs are invisible to the up-front writability check (fs.accessSync W_OK), so a folder
// that only its permissions make read-only passes as usable; the first write into it then fails.
// That failure names the workspace and the fix, like any unusable workspace, instead of a raw EPERM.
test('a write into the workspace refused for permissions fails the call with the workspace fix; one elsewhere is left as it is', async () => {
  const denied = (p) => Object.assign(new Error(`EPERM: operation not permitted, mkdir '${p}'`), { code: 'EPERM', path: p });
  const inside = path.join(R('/w'), 'agentic', 'bridge', 'mac-a', 'commands');
  const s = await serveWith(workspaceAt(R('/w')), { pjsr: () => { throw denied(inside); } });
  try {
    const r = await s.call('run_pjsr', { code: '1;' });
    assert.equal(r.isError, true);
    assert.match(r.text, FIX);
    assert.ok(r.text.includes(R('/w')), r.text);
    assert.match(r.text, /cannot be written/);
    assert.match(r.text, /EPERM/);
    assert.doesNotMatch(r.text, /^Error:/);
  } finally {
    await s.close();
  }
  const elsewhere = await serveWith(workspaceAt(R('/w')), { pjsr: () => { throw denied(R('/other/place')); } });
  try {
    const r = await elsewhere.call('run_pjsr', { code: '1;' });
    assert.match(r.text, /^Error: EPERM/);
    assert.doesNotMatch(r.text, FIX);
  } finally {
    await elsewhere.close();
  }
});

test('set_workspace switches the workspace: workspace_info, api.workspace and the bridge follow', async () => {
  const s = await serveWith(workspaceAt(HOME));
  try {
    const r = await s.call('set_workspace', { path: R('/astro/m31') });
    assert.equal(r.isError, false, r.text);
    const info = JSON.parse(r.text);
    assert.equal(info.workspace, R('/astro/m31'));
    assert.equal(info.source, 'set_workspace');
    assert.equal(info.usable, true);
    assert.deepEqual(JSON.parse((await s.call('workspace_info')).text), info, 'set_workspace returns the new workspace_info');
    assert.equal(s.api.workspace.scratchDir, path.join(R('/astro/m31'), 'agentic', 'scratch'));
    const pjsr = await s.call('run_pjsr', { code: '1;' });
    assert.equal(pjsr.isError, false, pjsr.text);
  } finally {
    await s.close();
  }
});

test('set_workspace refuses an unusable folder with the reason and keeps the current workspace', async () => {
  const s = await serveWith(workspaceAt(R('/w')));
  try {
    for (const [p, why] of [[HOME, /home directory/], [path.parse(process.cwd()).root, /filesystem root/], ['relative/dir', /absolute/]]) {
      const r = await s.call('set_workspace', { path: p });
      assert.equal(r.isError, true, p);
      assert.match(r.text, why, p);
    }
    assert.equal(JSON.parse((await s.call('workspace_info')).text).workspace, R('/w'));
    const missing = await s.call('set_workspace', {});
    assert.equal(missing.isError, true);
    assert.match(missing.text, /missing required argument: path/);
  } finally {
    await s.close();
  }
});

test('set_workspace reports a failing workspace-change hook as a warning, after the new workspace_info', async () => {
  const workspace = workspaceAt(R('/w'));
  workspace.onChange(() => { throw new Error('could not register the bridge'); });
  const s = await serveWith(workspace);
  try {
    const r = await s.call('set_workspace', { path: R('/next') });
    assert.equal(r.isError, false);
    assert.match(r.text, /could not register the bridge/);
    assert.equal(JSON.parse((await s.call('workspace_info')).text).workspace, R('/next'));
  } finally {
    await s.close();
  }
});

test('set_workspace on the real filesystem: a temp folder is accepted, a missing one refused', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-setws-'));
  const s = await serveWith(createWorkspace({ cwd: HOME, env: {}, homeDir: HOME, platform: process.platform }));
  try {
    const ok = await s.call('set_workspace', { path: dir });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(JSON.parse(ok.text).usable, true);
    const bad = await s.call('set_workspace', { path: path.join(dir, 'missing') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /does not exist/);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server instructions name the two output folders, or an unusable workspace and the fix', async () => {
  const s = await serveWith(workspaceAt(HOME));
  try {
    const text = s.client.getInstructions();
    assert.match(text, FIX);
    assert.doesNotMatch(text, /everything the tools write goes to/);
  } finally {
    await s.close();
  }
  const good = await serveWith(workspaceAt(R('/w')));
  try {
    const text = good.client.getInstructions();
    assert.ok(text.includes(R('/w')));
    assert.ok(text.includes(path.join(R('/w'), 'agentic')), 'names the state folder');
    assert.ok(text.includes(path.join(R('/w'), 'output')), 'names the output folder');
  } finally {
    await good.close();
  }
});

// --- The bridge in the workspace (Task 2) ---

// A fake bridge construction that records what the real createBridge() would be given, and every
// re-point the server asks for.
function recordingBridgeDeps() {
  const made = [];
  return {
    made,
    deps: {
      materializeWatcher: async () => ({ path: '/fake/watcher.js', warnings: [] }),
      machineId: () => 'mac-a',
      createBridge: (opts) => {
        const b = { opts, repointed: [], pjsr: async () => ({ status: 'ok', outputs: { consoleOutput: 'ran' } }), listImages: async () => [], log() {} };
        b.setBridgeDir = (d) => b.repointed.push(d);
        made.push(b);
        return b;
      },
    },
  };
}

test('the bridge is built over this machine\'s subdir of the workspace bridge dir, and nothing outside the workspace', async () => {
  const { made, deps } = recordingBridgeDeps();
  const workspace = workspaceAt(R('/w'));
  const { api } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace, log() {}, connectorVersion: '0', deps });
  assert.equal(made.length, 0, 'nothing built before the first call');
  await api.pjsr('1;');
  assert.equal(made[0].opts.bridgeDir, path.join(R('/w'), 'agentic', 'bridge', 'mac-a'));
  assert.deepEqual(Object.keys(made[0].opts).sort(), ['bridgeDir', 'log', 'platform', 'probe', 'trace', 'watcherFor'],
    'no machine-wide dir, no registry: the bridge dir and its watcher are all it has');
});

test('set_workspace re-points a built bridge at this machine\'s subdir of the new workspace bridge dir; an unbuilt one stays unbuilt', async () => {
  const { made, deps } = recordingBridgeDeps();
  const workspace = workspaceAt(R('/w'));
  const { api } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace, log() {}, connectorVersion: '0', deps });
  await workspace.set(R('/elsewhere'));
  assert.equal(made.length, 0, 'a switch before any call builds nothing');
  await api.pjsr('1;');
  assert.equal(made[0].opts.bridgeDir, path.join(R('/elsewhere'), 'agentic', 'bridge', 'mac-a'));
  await workspace.set(R('/third'));
  assert.deepEqual(made[0].repointed, [path.join(R('/third'), 'agentic', 'bridge', 'mac-a')]);
});

test('the machine id comes from the hostname, and names the bridge subdir', async () => {
  const { made, deps } = recordingBridgeDeps();
  delete deps.machineId; // the real one: the hostname
  const runtime = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: workspaceAt(R('/w')), log() {}, connectorVersion: '0', deps });
  const id = runtime.machineId();
  assert.equal(id, machineId());
  await runtime.api.pjsr('1;');
  assert.equal(path.basename(made[0].opts.bridgeDir), id);
});

test('workspace_info adds a note for a state path with a space off macOS (the -x= launch from there is unverified), and none on macOS', async () => {
  const EMPTY = { definitions: [], handlers: new Map() };
  const info = async (ws, osPlatform) => {
    const catalog = assembleCatalog({ core: EMPTY, packs: [], packTools: [], resetBridge() {}, workspace: ws, osPlatform });
    return JSON.parse((await catalog.handlers.get('workspace_info')({}, {})).text);
  };
  for (const [osPlatform, noted] of [['win32', true], ['linux', true], ['darwin', false]]) {
    const i = await info(workspaceAt(R('/data/My Target')), osPlatform);
    if (noted) assert.match(i.note, new RegExp(`space.*unverified on ${osPlatform}`), osPlatform);
    else assert.equal(i.note, undefined);
  }
  assert.equal((await info(workspaceAt(R('/data/M31')), 'win32')).note, undefined);
});

test('machineId() is null, not a throw, when the id cannot be resolved', () => {
  const { deps } = recordingBridgeDeps();
  deps.machineId = () => { throw new Error('EACCES'); };
  const runtime = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: workspaceAt(R('/w')), log() {}, connectorVersion: '0', deps });
  assert.equal(runtime.machineId(), null);
});

// workspace_info names the folder this machine's commands actually go to, <bridge>/<machine-id>.
test('workspace_info names this machine\'s bridge subdir', async () => {
  const s = await serveWith(workspaceAt(R('/w')));
  try {
    const info = JSON.parse((await s.call('workspace_info')).text);
    assert.equal(info.machineBridgeDir, path.join(R('/w'), 'agentic', 'bridge', 'mac-a'));
    assert.equal(s.made.bridges, 0, 'naming it builds no bridge');
  } finally {
    await s.close();
  }
});

test('two machines sharing one workspace get disjoint bridge dirs', async () => {
  const on = async (mid) => {
    const { made, deps } = recordingBridgeDeps();
    deps.machineId = () => mid;
    const { api } = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace: workspaceAt(R('/nas/target')), log() {}, connectorVersion: '0', deps });
    await api.pjsr('1;');
    return made[0].opts.bridgeDir;
  };
  const a = await on('studio-mac-1a2b3c4d');
  const b = await on('observatory-pc-5e6f7a8b');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.dirname(b), 'both under the one workspace bridge dir');
});
