// The call log as the server writes it: every tools/call (core, pack or server-defined) through the
// one dispatch, with the bridge commands each call caused attached to its seq. Built the way serve()
// builds it -- createCallLog() + buildRuntimeApi() + assembleCatalog() + createServer() -- over a real
// temp workspace, with a fake bridge construction that reports through opts.trace as the real one
// does (the real bridge's trace is tested in bridge-trace.test.mjs, end to end in
// bridge-workspaces.test.mjs). No PixInsight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildRuntimeApi, assembleCatalog } from '../src/server.mjs';
import { createCallLog } from '../src/call-log.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { loadPacks } from '../src/packs.mjs';
import { fixture } from './helpers.mjs';
import { tools as processTools } from '../src/tools/processes.mjs';

function tmpRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pixi-srv-log-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const tool = (name, handler, props = {}) => ({ name, description: 'test', inputSchema: { type: 'object', properties: props }, handler });

// Test tools, standing in for core tools: what each does to the bridge is what the log should show.
const TOOLS = [
  tool('two_cmds', async (api) => {
    const a = await api.pjsr('var a = 1;\nJSON.stringify(a);');
    const b = await api.pjsr('JSON.stringify("second");');
    return { text: `${a.outputs.consoleOutput} ${b.outputs.consoleOutput}` };
  }),
  tool('refuses', async () => ({ isError: true, text: 'nothing to do' })),
  tool('throws', async () => { throw new RangeError('out of range'); }),
  tool('prints_error', async (api) => ({ text: (await api.pjsr('PRINT_ERROR')).outputs.consoleOutput })),
  tool('run_code', async (api, input) => ({ text: (await api.pjsr(input.code)).outputs.consoleOutput }), { code: { type: 'string' } }),
  tool('views', async () => ({ text: 'checked' }), { view_id: { type: 'string' } }),
  tool('reads_workspace', async (api) => ({ text: api.workspace.scratchDir })),
  tool('reads_platform', async (api) => ({ text: api.platform.piBin })),
  // The real find_filters: it reads PixInsight's filter database (api.platform), never the workspace.
  processTools.find(({ name }) => name === 'find_filters'),
];

// A bridge construction that answers like a watcher and reports through opts.trace like the real one.
function fakeBridge(made) {
  return (opts) => {
    made.bridges++;
    let n = 0;
    let dir = opts.bridgeDir; // re-pointed by set_workspace, as the real bridge is
    const send = async (tool, params, result, waitMs = 0) => {
      const cmdId = `cmd-${made.bridges}-${++n}`;
      const sentAt = Date.now();
      const base = { cmdId, tool, params, dir, sentAt };
      opts.trace?.({ kind: 'sent', ...base });
      await delay(waitMs);
      opts.trace?.({ kind: 'done', ...base, ms: Date.now() - sentAt, result });
      return result;
    };
    return {
      pjsr: async (code) => {
        const errors = code === 'PRINT_ERROR' ? ['*** Error: the process did not run'] : [];
        const wait = code.startsWith('slow') ? 40 : 0;
        const r = await send('run_script', { code }, { status: 'success', outputs: { consoleOutput: `ran ${code}`, consoleErrors: errors } }, wait);
        return { ...r, status: 'ok', result: r.outputs.consoleOutput };
      },
      listImages: async () => (await send('list_open_images', {}, { status: 'success', outputs: { images: [{ id: 'RGB' }] } })).outputs.images,
      log() {},
      setBridgeDir: (d) => { dir = d; },
    };
  };
}

async function serveLogged(t, { env = {}, unusable = false, fs: logFs, packTools = [], packs = [] } = {}) {
  const root = tmpRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const dir = unusable ? home : path.join(root, 'IC 410');
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ cwd: dir, env, homeDir: home, platform: process.platform });
  const warnings = [];
  const log = (m) => warnings.push(m);
  const callLog = createCallLog({
    workspace, env, fs: logFs, pid: 777, log, onExit() {},
    sessionInfo: () => ({ connectorVersion: '0.0.0-test', node: process.version, os: { platform: process.platform }, machineId: 'mac-a', packs: packs.filter((p) => p.status === 'loaded').map((p) => `${p.name}@${p.version}`) }),
  });
  const made = { bridges: 0 };
  const deps = { materializeWatcher: async () => ({ path: '/fake/watcher.js', warnings: [] }), machineId: () => 'mac-a', createBridge: fakeBridge(made) };
  const filterDbPath = path.join(tmpRoot(t), 'filters.xspd'); // outside the root: tests assert what is written there
  fs.writeFileSync(filterDbPath, '<xspd><Filter name="Sony IMX411/455/461/533/571" channel="Q" data="400,1,700,1"/></xspd>');
  const { api, resetBridge } = buildRuntimeApi({ platform: { piBin: '/fake', filterDbPath }, probe: {}, workspace, homeDir: home, log, connectorVersion: '0.0.0-test', deps, callLog });
  const core = { definitions: TOOLS.map(({ handler: _h, ...d }) => d), handlers: new Map(TOOLS.map((x) => [x.name, x.handler])) };
  const catalog = assembleCatalog({ core, packs, packTools, resetBridge, workspace, callLog });
  const server = createServer({ catalog, api, callLog });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const logsDir = path.join(dir, 'agentic', 'logs');
  const records = (d = logsDir) => {
    const names = fs.existsSync(d) ? fs.readdirSync(d) : [];
    assert.equal(names.length, 1, `one log file in ${d}, got ${JSON.stringify(names)}`);
    return fs.readFileSync(path.join(d, names[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  };
  return { root, home, dir, workspace, call, records, logsDir, warnings, made };
}

// A bridge_sent record precedes each bridge record of a command that was sent; `types` folds the pair
// into one entry after checking it (same cmdId, seq and code), so the sequences below read per command.
const types = (recs) => {
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 'bridge_sent') {
      const b = recs.slice(i + 1).find((x) => x.type === 'bridge' && x.cmdId === r.cmdId);
      assert.ok(b, `bridge_sent ${r.cmdId} has its bridge record`);
      assert.equal(b.seq, r.seq);
      assert.equal(b.code, r.code);
      out.push(`sent:${r.tool}`);
      continue;
    }
    out.push(r.type === 'bridge' ? `bridge:${r.tool}` : r.type === 'event' ? `event:${r.event}` : r.type);
  }
  return out;
};

test('a call with two bridge commands: call_start, both bridge records on its seq with the exact code, call_end with the result', async (t) => {
  const s = await serveLogged(t);
  const r = await s.call('two_cmds', { note: 'kept verbatim' });
  const recs = s.records();
  assert.deepEqual(types(recs), ['session', 'call_start', 'sent:run_script', 'bridge:run_script', 'sent:run_script', 'bridge:run_script', 'call_end']);
  const [session, start, , b1, , b2, end] = recs;
  assert.equal(session.workspace, s.dir);
  assert.equal(session.machineId, 'mac-a');
  assert.deepEqual(start.input, { note: 'kept verbatim' });
  assert.equal(start.tool, 'two_cmds');
  assert.deepEqual([b1.seq, b2.seq, end.seq], [start.seq, start.seq, start.seq]);
  assert.equal(b1.code, 'var a = 1;\nJSON.stringify(a);');
  assert.equal(b2.code, 'JSON.stringify("second");');
  assert.equal(b1.dir, path.join(s.dir, 'agentic', 'bridge', 'mac-a'));
  assert.equal(b1.result.status, 'success', 'the raw watcher result, not what pjsr made of it');
  assert.deepEqual(end.result, r, 'call_end holds exactly what the client received');
  assert.equal(s.made.bridges, 1);
});

test('a failing call and a thrown error: call_end has isError, and the thrown error\'s name, message and stack', async (t) => {
  const s = await serveLogged(t);
  const refused = await s.call('refuses');
  const thrown = await s.call('throws');
  await s.call('two_cmds'); // neither used the workspace: they are written once a call opens the file
  const ends = s.records().filter((r) => r.type === 'call_end');
  assert.deepEqual(ends[0].result, refused);
  assert.equal(ends[0].result.isError, true);
  assert.equal('error' in ends[0], false);
  assert.deepEqual(ends[1].result, thrown);
  assert.equal(ends[1].result.isError, true);
  assert.equal(ends[1].error.name, 'RangeError');
  assert.equal(ends[1].error.message, 'out of range');
  assert.match(ends[1].error.stack, /RangeError: out of range/);
});

test('a PixInsight console error: the bridge record keeps the raw lines, call_end the promoted error result', async (t) => {
  const s = await serveLogged(t);
  const r = await s.call('prints_error');
  assert.equal(r.isError, true);
  const recs = s.records();
  assert.deepEqual(recs.find((x) => x.type === 'bridge').result.outputs.consoleErrors, ['*** Error: the process did not run']);
  assert.deepEqual(recs.find((x) => x.type === 'call_end').result, r);
});

test('the view pre-check\'s list_open_images belongs to the call that made it', async (t) => {
  const s = await serveLogged(t);
  await s.call('views', { view_id: 'RGB' });
  const recs = s.records();
  assert.deepEqual(types(recs), ['session', 'call_start', 'sent:list_open_images', 'bridge:list_open_images', 'call_end']);
  assert.equal(recs[3].seq, recs[1].seq);
  assert.deepEqual(recs[3].params, {});
});

test('a pack tool is logged exactly like a core tool', async (t) => {
  const { packs, tools: packTools } = await loadPacks({ env: { PIXINSIGHT_CONNECTOR_PACKS: fixture('pack-ok') }, log() {} });
  const s = await serveLogged(t, { packs, packTools });
  const r = await s.call('fixture_stretch', { view_id: 'RGB' });
  const recs = s.records();
  assert.deepEqual(recs[0].packs, ['ok@1.0.0']);
  assert.deepEqual(types(recs), ['session', 'call_start', 'sent:list_open_images', 'bridge:list_open_images', 'call_end']);
  assert.equal(recs[1].tool, 'fixture_stretch');
  assert.deepEqual(recs[1].input, { view_id: 'RGB' });
  assert.deepEqual(recs[4].result, r);
});

test('two overlapping calls keep their bridge records on their own seq', async (t) => {
  const s = await serveLogged(t);
  await Promise.all([
    s.call('run_code', { code: 'slow one' }),
    (async () => { await delay(5); return s.call('run_code', { code: 'fast one' }); })(),
  ]);
  const recs = s.records();
  const seqOf = Object.fromEntries(recs.filter((r) => r.type === 'call_start').map((r) => [r.input.code, r.seq]));
  const bridges = recs.filter((r) => r.type === 'bridge');
  assert.equal(bridges.length, 2);
  for (const b of bridges) assert.equal(b.seq, seqOf[b.code], `${b.code} logged on seq ${b.seq}`);
  const order = types(recs).slice(1).join(' ');
  assert.equal(order, 'call_start sent:run_script call_start sent:run_script bridge:run_script call_end bridge:run_script call_end', 'the fast call finished inside the slow one');
});

test('set_workspace: the old file closes with a log switch; set_workspace opens the new workspace\'s file, linking the old one', async (t) => {
  const s = await serveLogged(t);
  const next = path.join(s.root, 'IC 434');
  fs.mkdirSync(next);
  await s.call('two_cmds');
  const oldFile = path.join(s.logsDir, fs.readdirSync(s.logsDir)[0]);
  const sw = await s.call('set_workspace', { path: next });
  assert.notEqual(sw.isError, true, sw.content[0].text);
  await s.call('run_code', { code: 'after' });

  const old = s.records();
  assert.deepEqual(types(old).slice(-2), ['call_end', 'event:log switch']);
  assert.equal(old.at(-1).from, s.dir);
  assert.equal(old.at(-1).to, next);

  const recs = s.records(path.join(next, 'agentic', 'logs'));
  assert.deepEqual(types(recs), ['session', 'call_start', 'call_end', 'call_start', 'sent:run_script', 'bridge:run_script', 'call_end']);
  assert.equal(recs[0].previousLog, oldFile);
  assert.equal(recs[0].workspace, next);
  assert.equal(recs[1].tool, 'set_workspace');
  assert.equal(recs[1].previousWorkspace, s.dir);
  assert.deepEqual(recs[2].result, sw);
  assert.equal(recs[5].dir, path.join(next, 'agentic', 'bridge', 'mac-a'), 'the bridge moved with it');
});

// The IC410 run: a server launched in one folder whose first call is set_workspace wrote a log (and
// created agentic/) in the launch folder. Nothing may appear there.
test('launched in X, set_workspace(T) first: X gets nothing; T\'s log starts with session, then set_workspace', async (t) => {
  const s = await serveLogged(t);
  const target = path.join(s.root, 'IC 434');
  fs.mkdirSync(target);
  const info = await s.call('workspace_info');
  const packs = await s.call('list_packs');
  const sw = await s.call('set_workspace', { path: target });
  assert.notEqual(sw.isError, true, sw.content[0].text);
  await s.call('two_cmds');
  assert.deepEqual(fs.readdirSync(s.dir), [], 'the launch folder is untouched');
  const recs = s.records(path.join(target, 'agentic', 'logs'));
  assert.deepEqual(recs.filter((r) => r.type === 'call_start').map((r) => r.tool), ['workspace_info', 'list_packs', 'set_workspace', 'two_cmds']);
  assert.equal(recs[0].type, 'session');
  assert.equal(recs[0].previousLog, null);
  assert.deepEqual(recs[2].result, info);
  assert.deepEqual(recs[4].result, packs);
  assert.equal(recs[5].previousWorkspace, s.dir);
  assert.deepEqual(recs[6].result, sw);
});

// The IC410 symptom through another first call: a skill looking up the camera's QE curve before it
// names the workspace. Which calls may run before set_workspace is not a list: a call's log goes where
// the workspace is when the call first uses it (api.workspace, the bridge), and one that never does waits.
test('launched in X, find_filters then set_workspace(T): X gets nothing; T\'s log has both, in order', async (t) => {
  const s = await serveLogged(t);
  const target = path.join(s.root, 'IC 434');
  fs.mkdirSync(target);
  const found = await s.call('find_filters', { query: 'IMX455' });
  assert.notEqual(found.isError, true, found.content[0].text);
  assert.match(found.content[0].text, /Sony IMX411\/455\/461\/533\/571/);
  const other = await s.call('reads_platform');
  const sw = await s.call('set_workspace', { path: target });
  assert.notEqual(sw.isError, true, sw.content[0].text);
  assert.deepEqual(fs.readdirSync(s.dir), [], 'the launch folder is untouched');
  const recs = s.records(path.join(target, 'agentic', 'logs'));
  assert.deepEqual(recs.filter((r) => r.type === 'call_start').map((r) => [r.tool, r.deferred]), [['find_filters', true], ['reads_platform', true], ['set_workspace', true]]);
  assert.deepEqual(recs.find((r) => r.type === 'call_end' && r.tool === 'find_filters').result, found);
  assert.deepEqual(recs.find((r) => r.type === 'call_end' && r.tool === 'reads_platform').result, other);
});

test('a call that reads api.workspace opens the log where the workspace is; one that never does opens nothing', async (t) => {
  const s = await serveLogged(t);
  await s.call('reads_platform');
  await s.call('no_such_tool');
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false, 'nothing yet');
  await s.call('reads_workspace');
  const recs = s.records();
  assert.deepEqual(recs.filter((r) => r.type === 'call_start').map((r) => [r.tool, r.deferred]), [['reads_platform', true], ['no_such_tool', true], ['reads_workspace', undefined]]);
});

test('workspace_info reports the log file; resume_bridge is a bridge reset event', async (t) => {
  const s = await serveLogged(t);
  const before = JSON.parse((await s.call('workspace_info')).content[0].text);
  assert.deepEqual(before.log, { state: 'on', file: null, dir: s.logsDir }, 'no file yet: workspace_info does not need one');
  await s.call('resume_bridge');
  assert.equal(fs.existsSync(s.logsDir), false, 'resume_bridge does not use the workspace either');
  await s.call('two_cmds');
  const info = JSON.parse((await s.call('workspace_info')).content[0].text);
  assert.equal(info.log.state, 'on');
  assert.equal(path.dirname(info.log.file), s.logsDir);
  const recs = s.records();
  const i = recs.findIndex((r) => r.type === 'event');
  assert.equal(recs[i].event, 'bridge reset');
  assert.deepEqual([recs[i - 1].type, recs[i - 1].tool, recs[i + 1].type, recs[i + 1].tool], ['call_start', 'resume_bridge', 'call_end', 'resume_bridge'], 'written with its call');
  assert.equal(recs[i].seq, recs[i - 1].seq);
  assert.equal(recs[i].deferred, true);
});

test('PIXINSIGHT_CONNECTOR_LOG=0: calls are answered the same and nothing is logged; workspace_info says logging is off', async (t) => {
  const s = await serveLogged(t, { env: { PIXINSIGHT_CONNECTOR_LOG: '0' } });
  const r = await s.call('two_cmds');
  assert.equal(r.content[0].text, 'ran var a = 1;\nJSON.stringify(a); ran JSON.stringify("second");');
  const info = JSON.parse((await s.call('workspace_info')).content[0].text);
  assert.deepEqual(info.log, { state: 'off', reason: 'PIXINSIGHT_CONNECTOR_LOG=0' });
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
});

test('an unusable workspace: calls are answered, nothing is written anywhere, workspace_info says logging is skipped', async (t) => {
  const s = await serveLogged(t, { unusable: true });
  const refused = await s.call('two_cmds');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /set_workspace/);
  const info = JSON.parse((await s.call('workspace_info')).content[0].text);
  assert.equal(info.usable, false);
  assert.equal(info.log.state, 'skipped');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name + '/', ...walk(path.join(d, e.name)).map((x) => `${e.name}/${x}`)] : [e.name]));
  assert.deepEqual(walk(s.root), ['home/'], 'nothing written under the temp root');
});

// Claude Desktop starts the server with no usable workspace; the set_workspace that fixes it is the
// call most worth having in the log. Calls made while nothing could be logged are written, with their
// own times, into the first file that opens -- which the fixing set_workspace itself opens.
test('the set_workspace that fixes an unusable start opens the first log file and is in it, after the calls before it', async (t) => {
  const s = await serveLogged(t, { unusable: true });
  const target = path.join(s.root, 'IC 410');
  fs.mkdirSync(target);
  const refused = await s.call('two_cmds');
  const wrong = await s.call('set_workspace', { path: path.join(s.root, 'missing') });
  assert.equal(wrong.isError, true);
  const fixed = await s.call('set_workspace', { path: target });
  assert.notEqual(fixed.isError, true, fixed.content[0].text);

  const recs = s.records(path.join(target, 'agentic', 'logs'));
  assert.deepEqual(types(recs), ['session', 'call_start', 'call_end', 'call_start', 'call_end', 'call_start', 'call_end']);
  assert.equal(recs[0].workspaceSource, 'set_workspace');
  assert.deepEqual(recs.filter((r) => r.type === 'call_start').map((r) => r.tool), ['two_cmds', 'set_workspace', 'set_workspace']);
  assert.deepEqual(recs[2].result, refused);
  assert.deepEqual(recs[4].result, wrong);
  assert.deepEqual(recs[6].result, fixed, 'the fixing call, input and result');
  assert.deepEqual(recs[5].input, { path: target });
  for (const r of recs.slice(1)) assert.equal(r.deferred, true, 'marked: written after the fact');
  assert.ok(recs[1].ts <= recs[0].ts, 'each keeps the time it happened');
  assert.equal(fs.readdirSync(s.home).length, 0, 'nothing was written in the unusable folder');
});

test('a log that cannot be written never changes a call\'s result', async (t) => {
  const broken = { ...fs, writeSync: () => { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; } };
  const plain = await serveLogged(t, { env: { PIXINSIGHT_CONNECTOR_LOG: '0' } });
  const s = await serveLogged(t, { fs: broken });
  for (const name of ['two_cmds', 'refuses', 'throws', 'prints_error']) {
    assert.deepEqual(await s.call(name), await plain.call(name), name);
  }
  assert.equal(s.warnings.filter((w) => /call log/.test(w)).length, 1, 'one warning');
  const info = JSON.parse((await s.call('workspace_info')).content[0].text);
  assert.equal(info.log.state, 'failed');
  assert.match(info.log.reason, /EIO/);
});
