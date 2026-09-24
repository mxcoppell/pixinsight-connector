// src/call-log.mjs: one append-only JSONL file per server session and workspace, under
// <state>/logs, opened on the first tool call. Real temp folders; the clock, pid, exit hook and
// (for the failure cases) the fs are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCallLog, logFileName } from '../src/call-log.mjs';
import { createWorkspace } from '../src/workspace.mjs';

const T0 = Date.UTC(2026, 8, 23, 12, 34, 56);

function tmpRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pixi-calllog-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function setup(t, { env = {}, fs: fsImpl, cwdName = 'Target A', sessionInfo, unusable = false, workspaceFs } = {}) {
  const root = tmpRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const dir = unusable ? home : path.join(root, cwdName);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ cwd: dir, env, homeDir: home, platform: process.platform, ...(workspaceFs ? { fs: workspaceFs } : {}) });
  let ms = T0;
  const warnings = [];
  const exits = [];
  const callLog = createCallLog({
    workspace,
    env,
    fs: fsImpl,
    now: () => (ms += 7),
    pid: 4242,
    log: (m) => warnings.push(m),
    sessionInfo: sessionInfo ?? (() => ({ connectorVersion: '9.9.9', node: 'v0-test', os: { platform: 'testos' }, machineId: 'box-1234abcd', packs: ['p@1.0.0'] })),
    onExit: (fn) => exits.push(fn),
  });
  return { root, home, dir, workspace, callLog, warnings, exits, logsDir: path.join(dir, 'agentic', 'logs') };
}

const files = (logsDir) => (fs.existsSync(logsDir) ? fs.readdirSync(logsDir).sort() : []);
const read = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const only = (logsDir) => {
  const f = files(logsDir);
  assert.equal(f.length, 1, `one log file, got ${JSON.stringify(f)}`);
  return read(path.join(logsDir, f[0]));
};

function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(p + path.sep, ...allFiles(p)); else out.push(p);
  }
  return out;
}

async function call(callLog, tool, input, body) {
  const c = callLog.startCall(tool, input);
  let result;
  let error;
  try {
    result = await callLog.run(c, body);
  } catch (e) {
    error = e;
    result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
  callLog.endCall(c, result, error);
  return result;
}

// A call that uses the workspace (reads api.workspace, or reaches the bridge) says so through touch().
const work = (callLog, tool, input, body) => call(callLog, tool, input, async () => { callLog.touch(); return body(); });

test('the file name is <YYYYMMDD-HHMMSS>-<pid>.jsonl in UTC', () => {
  assert.equal(logFileName(T0, 4242), '20260923-123456-4242.jsonl');
  assert.equal(logFileName(Date.UTC(2027, 0, 2, 3, 4, 5), 7), '20270102-030405-7.jsonl');
});

test('creating the log and reading its status writes nothing; the first call creates the file', async (t) => {
  const s = setup(t);
  assert.deepEqual(s.callLog.status(), { state: 'on', file: null, dir: s.logsDir });
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false, 'nothing before the first call');
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  assert.deepEqual(files(s.logsDir), ['20260923-123456-4242.jsonl']);
  assert.deepEqual(s.callLog.status(), { state: 'on', file: path.join(s.logsDir, '20260923-123456-4242.jsonl') });
});

test('a successful call: session, call_start, call_end, every record with v:1, an ISO ts and a type', async (t) => {
  const s = setup(t);
  const input = { view_id: 'RGB', params: { a: [1, 2], s: 'x'.repeat(5000) } };
  await work(s.callLog, 'run_curves', input, async () => ({ content: [{ type: 'text', text: 'done' }] }));
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'call_end']);
  for (const r of recs) {
    assert.equal(r.v, 1);
    assert.equal(new Date(r.ts).toISOString(), r.ts);
  }
  const [session, start, end] = recs;
  assert.equal(session.connectorVersion, '9.9.9');
  assert.equal(session.pid, 4242);
  assert.equal(session.node, 'v0-test');
  assert.deepEqual(session.os, { platform: 'testos' });
  assert.equal(session.machineId, 'box-1234abcd');
  assert.deepEqual(session.packs, ['p@1.0.0']);
  assert.equal(session.workspace, s.dir);
  assert.equal(session.workspaceSource, 'cwd');
  assert.equal(session.stateDir, path.join(s.dir, 'agentic'));
  assert.equal(session.previousLog, null);
  assert.deepEqual(start, { v: 1, ts: start.ts, type: 'call_start', seq: 1, tool: 'run_curves', input });
  assert.equal(start.input.params.s.length, 5000, 'no truncation');
  assert.equal(end.seq, 1);
  assert.equal(end.tool, 'run_curves');
  assert.equal(typeof end.ms, 'number');
  assert.deepEqual(end.result, { content: [{ type: 'text', text: 'done' }] });
  assert.equal('error' in end, false);
});

test('call_start is on disk before the handler runs', async (t) => {
  const s = setup(t);
  let seen;
  await work(s.callLog, 'run_pjsr', { code: '1;' }, async () => {
    seen = only(s.logsDir).map((r) => r.type);
    return { content: [] };
  });
  assert.deepEqual(seen, ['session', 'call_start']);
});

test('a failing call keeps isError and the full content; a thrown error keeps name, message and stack', async (t) => {
  const s = setup(t);
  await work(s.callLog, 'close_image', { view_id: 'X' }, async () => ({ content: [{ type: 'text', text: 'no such view' }], isError: true }));
  await work(s.callLog, 'run_pjsr', { code: 'bad' }, async () => { throw new TypeError('boom'); });
  const ends = only(s.logsDir).filter((r) => r.type === 'call_end');
  assert.deepEqual(ends[0].result, { content: [{ type: 'text', text: 'no such view' }], isError: true });
  assert.equal(ends[1].seq, 2);
  assert.equal(ends[1].result.isError, true);
  assert.equal(ends[1].error.name, 'TypeError');
  assert.equal(ends[1].error.message, 'boom');
  assert.match(ends[1].error.stack, /TypeError: boom/);
});

// What src/bridge.mjs's opts.trace reports: sent, then done or failed; events.
const sent = (cmdId, code, sentAt = T0) => ({ kind: 'sent', cmdId, tool: 'run_script', params: { code }, dir: '/b', sentAt });
const done = (cmdId, code, result) => ({ kind: 'done', cmdId, tool: 'run_script', params: { code }, dir: '/b', sentAt: T0, ms: 12, result });

test('bridge records carry the seq of the call that sent them, the exact code and the raw result', async (t) => {
  const s = setup(t);
  const raw = { id: 'c1', status: 'success', outputs: { consoleOutput: 'out', consoleErrors: ['*** Error: x'] }, error: null };
  await work(s.callLog, 'run_pjsr', { code: 'A' }, async () => {
    s.callLog.bridge(sent('c1', 'var a = 1;\nJSON.stringify(a);'));
    s.callLog.bridge(done('c1', 'var a = 1;\nJSON.stringify(a);', raw));
    s.callLog.bridge({ kind: 'sent', cmdId: 'c2', tool: 'list_open_images', params: {}, dir: '/b', sentAt: T0 });
    s.callLog.bridge({ kind: 'done', cmdId: 'c2', tool: 'list_open_images', params: {}, dir: '/b', sentAt: T0, ms: 3, result: { status: 'success', outputs: { images: [{ id: 'A' }] } } });
    return { content: [] };
  });
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'bridge_sent', 'bridge', 'bridge_sent', 'bridge', 'call_end']);
  const [s1, s2] = recs.filter((r) => r.type === 'bridge_sent');
  assert.deepEqual(s1, {
    v: 1, ts: s1.ts, type: 'bridge_sent', seq: 1, cmdId: 'c1', tool: 'run_script', code: 'var a = 1;\nJSON.stringify(a);',
    dir: '/b', sentAt: new Date(T0).toISOString(),
  });
  assert.deepEqual(s2.params, {});
  assert.equal('code' in s2, false);
  const [b1, b2] = recs.filter((r) => r.type === 'bridge');
  assert.deepEqual(b1, {
    v: 1, ts: b1.ts, type: 'bridge', seq: 1, cmdId: 'c1', tool: 'run_script', code: 'var a = 1;\nJSON.stringify(a);',
    dir: '/b', sentAt: new Date(T0).toISOString(), ms: 12, result: raw,
  });
  assert.equal(b2.tool, 'list_open_images');
  assert.deepEqual(b2.params, {});
  assert.equal('code' in b2, false);
  assert.deepEqual(b2.result.outputs.images, [{ id: 'A' }]);
});

// A command that hangs, or a server killed outright (SIGKILL, no exit hook), must still show the
// exact PJSR that was running: it is written when the command is sent, not when it settles.
test('the PJSR of a command is on disk as soon as it is sent, before it settles', async (t) => {
  const s = setup(t);
  const c = s.callLog.startCall('run_pjsr', { code: 'x' });
  await s.callLog.run(c, async () => {
    s.callLog.bridge(sent('h1', 'while (true) {}'));
  });
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'bridge_sent']);
  assert.equal(recs[2].code, 'while (true) {}');
  assert.equal(recs[2].seq, 1);
  assert.equal(recs[2].cmdId, 'h1');
  s.callLog.endCall(c, { content: [] });
});

test('a command that failed before it was sent has no bridge_sent; its bridge record carries the code', async (t) => {
  const s = setup(t);
  await work(s.callLog, 'run_pjsr', { code: 'A' }, async () => {
    s.callLog.bridge({ kind: 'failed', cmdId: 'w1', tool: 'run_script', params: { code: 'A' }, dir: '/b', sentAt: null, ms: 0, failure: { kind: 'write', name: 'Error', message: 'EACCES' } });
    return { content: [], isError: true };
  });
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'bridge', 'call_end']);
  assert.equal(recs[2].code, 'A');
  assert.equal(recs[2].sentAt, null);
});

test('a failed bridge command is logged with its failure kind and message', async (t) => {
  const s = setup(t);
  await work(s.callLog, 'run_pjsr', { code: 'A' }, async () => {
    s.callLog.bridge(sent('c1', 'A'));
    s.callLog.bridge({ kind: 'failed', cmdId: 'c1', tool: 'run_script', params: { code: 'A' }, dir: '/b', sentAt: T0, ms: 20, failure: { kind: 'vanished', name: 'Error', message: 'The command vanished' } });
    s.callLog.bridge({ kind: 'event', event: 'vanished', cmdId: 'c1', message: 'The command vanished' });
    return { content: [], isError: true };
  });
  const recs = only(s.logsDir);
  const b = recs.find((r) => r.type === 'bridge');
  assert.deepEqual(b.failure, { kind: 'vanished', name: 'Error', message: 'The command vanished' });
  assert.equal('result' in b, false);
  const e = recs.find((r) => r.type === 'event');
  assert.deepEqual({ ...e, ts: 0 }, { v: 1, ts: 0, type: 'event', seq: 1, event: 'vanished', cmdId: 'c1', message: 'The command vanished' });
});

test('two overlapping calls keep their bridge records attached to their own seq', async (t) => {
  const s = setup(t);
  const gate = Promise.withResolvers();
  const tick = () => new Promise((r) => setTimeout(r, 2));
  const slow = work(s.callLog, 'run_pjsr', { code: 'slow' }, async () => {
    s.callLog.bridge(sent('s1', 'slow'));
    await gate.promise;
    await tick();
    s.callLog.bridge(done('s1', 'slow', { status: 'success' }));
    return { content: [] };
  });
  const fast = work(s.callLog, 'run_pjsr', { code: 'fast' }, async () => {
    s.callLog.bridge(sent('f1', 'fast'));
    await tick();
    s.callLog.bridge(done('f1', 'fast', { status: 'success' }));
    s.callLog.bridge({ kind: 'event', event: 'launch', launch: 1 });
    gate.resolve();
    return { content: [] };
  });
  await Promise.all([slow, fast]);
  const recs = only(s.logsDir);
  const bySeq = Object.fromEntries(recs.filter((r) => r.type === 'call_start').map((r) => [r.input.code, r.seq]));
  for (const b of recs.filter((r) => r.type === 'bridge')) assert.equal(b.seq, bySeq[b.code], `${b.code} -> seq ${b.seq}`);
  assert.equal(recs.find((r) => r.type === 'event').seq, bySeq.fast);
});

test('an event outside any call goes to the open file, and is dropped when there is none', async (t) => {
  const s = setup(t);
  s.callLog.event('launch', { launch: 1 });
  assert.equal(fs.existsSync(s.logsDir), false, 'no file is opened for an event');
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  s.callLog.event('bridge reset');
  const last = only(s.logsDir).at(-1);
  assert.equal(last.type, 'event');
  assert.equal(last.event, 'bridge reset');
  assert.equal('seq' in last, false);
});

test('startup events follow the session record of the first file only', async (t) => {
  const s = setup(t);
  s.callLog.startupEvent('platform error', { message: 'PixInsight not found' });
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'event', 'call_start', 'call_end']);
  assert.equal(recs[1].event, 'platform error');
  assert.equal(recs[1].message, 'PixInsight not found');
});

test('set_workspace: the old file gets only the log switch event; the call itself opens the new file, linking the old one', async (t) => {
  const s = setup(t);
  const other = path.join(s.root, 'Target B');
  fs.mkdirSync(other);
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  await call(s.callLog, 'set_workspace', { path: other }, async () => {
    await s.workspace.set(other);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  const oldFile = path.join(s.logsDir, files(s.logsDir)[0]);
  const newLogs = path.join(other, 'agentic', 'logs');
  assert.equal(s.callLog.status().state, 'on');
  assert.equal(path.dirname(s.callLog.status().file), newLogs);
  await work(s.callLog, 'scan_workspace', {}, async () => ({ content: [] }));

  const old = read(oldFile);
  assert.deepEqual(old.map((r) => r.type), ['session', 'call_start', 'call_end', 'event']);
  const sw = old[3];
  assert.equal(sw.event, 'log switch');
  assert.equal(sw.reason, 'workspace change');
  assert.equal(sw.from, s.dir);
  assert.equal(sw.to, other);

  const recs = only(newLogs);
  assert.deepEqual(recs.map((r) => r.type), ['session', 'call_start', 'call_end', 'call_start', 'call_end']);
  assert.equal(recs[0].workspace, other);
  assert.equal(recs[0].workspaceSource, 'set_workspace');
  assert.equal(recs[0].previousLog, oldFile);
  assert.deepEqual([recs[1].tool, recs[1].seq, recs[1].input, recs[1].previousWorkspace], ['set_workspace', 2, { path: other }, s.dir]);
  assert.deepEqual(recs[2].result, { content: [{ type: 'text', text: '{}' }] });
  assert.equal(recs[3].seq, 3, 'seq continues across files');
});

// A server launched in a folder it must not write to (a masters folder), whose first call names the
// real workspace: nothing may appear in the launch folder.
test('set_workspace as the first call: nothing in the launch folder; the new log starts with session, then set_workspace', async (t) => {
  const s = setup(t);
  const other = path.join(s.root, 'Target B');
  fs.mkdirSync(other);
  await call(s.callLog, 'set_workspace', { path: other }, async () => {
    await s.workspace.set(other);
    return { content: [{ type: 'text', text: 'switched' }] };
  });
  await work(s.callLog, 'scan_workspace', {}, async () => ({ content: [] }));
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false, 'the launch folder is untouched');
  assert.deepEqual(allFiles(s.dir), []);
  const recs = only(path.join(other, 'agentic', 'logs'));
  assert.deepEqual(recs.map((r) => [r.type, r.tool]), [['session', undefined], ['call_start', 'set_workspace'], ['call_end', 'set_workspace'], ['call_start', 'scan_workspace'], ['call_end', 'scan_workspace']]);
  assert.equal(recs[0].previousLog, null);
  assert.equal(recs[1].previousWorkspace, s.dir);
  assert.deepEqual(recs[1].input, { path: other });
  assert.deepEqual(recs[2].result, { content: [{ type: 'text', text: 'switched' }] });
  assert.equal(s.warnings.length, 0);
});

// No list of tools: any call that does not use the workspace waits, whatever its name.
test('calls that do not use the workspace open no file; they wait for the call that decides where the log goes', async (t) => {
  const s = setup(t);
  for (const tool of ['workspace_info', 'list_packs', 'pixinsight_info']) await call(s.callLog, tool, {}, async () => ({ content: [{ type: 'text', text: tool }] }));
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false, 'nothing written yet');
  assert.deepEqual(s.callLog.status(), { state: 'on', file: null, dir: s.logsDir });
  await work(s.callLog, 'run_pjsr', { code: '1;' }, async () => ({ content: [] }));
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => [r.type, r.tool, r.deferred]), [
    ['session', undefined, undefined],
    ['call_start', 'workspace_info', true], ['call_end', 'workspace_info', true],
    ['call_start', 'list_packs', true], ['call_end', 'list_packs', true],
    ['call_start', 'pixinsight_info', true], ['call_end', 'pixinsight_info', true],
    ['call_start', 'run_pjsr', undefined], ['call_end', 'run_pjsr', undefined],
  ]);
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(recs[2].result, { content: [{ type: 'text', text: 'workspace_info' }] });
  // Once a file is open, they are logged in it as they happen.
  await call(s.callLog, 'workspace_info', {}, async () => ({ content: [] }));
  assert.deepEqual(only(s.logsDir).slice(-2).map((r) => [r.type, r.tool, r.deferred]), [['call_start', 'workspace_info', undefined], ['call_end', 'workspace_info', undefined]]);
});

test('workspace_info, then set_workspace: nothing in the launch folder; both are in the new log, in order', async (t) => {
  const s = setup(t);
  const other = path.join(s.root, 'Target B');
  fs.mkdirSync(other);
  await call(s.callLog, 'workspace_info', {}, async () => ({ content: [] }));
  await call(s.callLog, 'set_workspace', { path: other }, async () => {
    await s.workspace.set(other);
    return { content: [] };
  });
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
  const recs = only(path.join(other, 'agentic', 'logs'));
  assert.deepEqual(recs.map((r) => [r.type, r.tool]), [['session', undefined], ['call_start', 'workspace_info'], ['call_end', 'workspace_info'], ['call_start', 'set_workspace'], ['call_end', 'set_workspace']]);
});

test('a set_workspace that fails decides nothing: no file opens in the launch folder until a call needs it', async (t) => {
  const s = setup(t);
  const r = await call(s.callLog, 'set_workspace', { path: '/nope' }, async () => ({ isError: true, content: [{ type: 'text', text: 'not a folder' }] }));
  assert.equal(r.isError, true);
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  assert.deepEqual(only(s.logsDir).map((x) => [x.type, x.tool, x.deferred]), [
    ['session', undefined, undefined], ['call_start', 'set_workspace', true], ['call_end', 'set_workspace', true],
    ['call_start', 'list_open_images', undefined], ['call_end', 'list_open_images', undefined],
  ]);
});

// A pack may shadow pixinsight_info with a tool that does use PixInsight: its first bridge command
// needs the workspace, so the file opens then, and the call is logged whole.
test('a waiting call that sends a bridge command opens the file then and is logged whole', async (t) => {
  const s = setup(t);
  await call(s.callLog, 'pixinsight_info', {}, async () => {
    assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
    s.callLog.bridge(sent('c1', 'x;'));
    s.callLog.bridge(done('c1', 'x;', { status: 'success' }));
    return { content: [] };
  });
  assert.deepEqual(only(s.logsDir).map((r) => r.type), ['session', 'call_start', 'bridge_sent', 'bridge', 'call_end']);
});

test('touch(): a waiting call that uses the workspace opens the file then and is logged whole', async (t) => {
  const s = setup(t);
  await call(s.callLog, 'find_filters', { query: 'x' }, async () => {
    assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
    s.callLog.touch();
    assert.deepEqual(only(s.logsDir).map((r) => [r.type, r.tool, r.deferred]), [['session', undefined, undefined], ['call_start', 'find_filters', undefined]]);
    return { content: [] };
  });
  s.callLog.touch(); // outside any call: nothing to decide
  assert.deepEqual(only(s.logsDir).map((r) => r.type), ['session', 'call_start', 'call_end']);
});

test('what a waiting call raised before it used the workspace is written after its call_start once it does', async (t) => {
  const s = setup(t);
  await call(s.callLog, 'my_pack_tool', {}, async () => {
    s.callLog.event('bridge reset');
    s.callLog.touch();
    s.callLog.event('after');
    return { content: [] };
  });
  assert.deepEqual(only(s.logsDir).map((r) => [r.type, r.tool ?? r.event, r.deferred]), [
    ['session', undefined, undefined], ['call_start', 'my_pack_tool', undefined],
    ['event', 'bridge reset', true], ['event', 'after', undefined], ['call_end', 'my_pack_tool', undefined],
  ]);
});

test('an event inside a waiting call opens no file; it is written with the call, between its call_start and call_end', async (t) => {
  const s = setup(t);
  await call(s.callLog, 'resume_bridge', {}, async () => {
    s.callLog.event('bridge reset');
    return { content: [] };
  });
  assert.equal(fs.existsSync(path.join(s.dir, 'agentic')), false);
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const recs = only(s.logsDir);
  assert.deepEqual(recs.map((r) => [r.type, r.tool ?? r.event, r.seq, r.deferred]), [
    ['session', undefined, undefined, undefined],
    ['call_start', 'resume_bridge', 1, true], ['event', 'bridge reset', 1, true], ['call_end', 'resume_bridge', 1, true],
    ['call_start', 'list_open_images', 2, undefined], ['call_end', 'list_open_images', 2, undefined],
  ]);
});

test('an event during set_workspace is written with it, in the new workspace\'s file', async (t) => {
  const s = setup(t);
  const other = path.join(s.root, 'Target B');
  fs.mkdirSync(other);
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  await call(s.callLog, 'set_workspace', { path: other }, async () => {
    await s.workspace.set(other);
    s.callLog.event('bridge moved', { to: other });
    return { content: [] };
  });
  const recs = only(path.join(other, 'agentic', 'logs'));
  assert.deepEqual(recs.map((r) => [r.type, r.tool ?? r.event, r.deferred]), [
    ['session', undefined, undefined], ['call_start', 'set_workspace', true], ['event', 'bridge moved', true], ['call_end', 'set_workspace', true],
  ]);
  assert.equal(recs[2].to, other);
  assert.equal(recs[2].seq, recs[1].seq);
});

test('PIXINSIGHT_CONNECTOR_LOG=0 writes nothing and says so', async (t) => {
  const s = setup(t, { env: { PIXINSIGHT_CONNECTOR_LOG: '0' } });
  await work(s.callLog, 'run_pjsr', { code: '1;' }, async () => {
    s.callLog.bridge(sent('c1', '1;'));
    s.callLog.bridge(done('c1', '1;', { status: 'success' }));
    return { content: [] };
  });
  s.callLog.event('launch');
  assert.deepEqual(allFiles(s.root).sort(), [s.home + path.sep, s.dir + path.sep].sort());
  assert.deepEqual(s.callLog.status(), { state: 'off', reason: 'PIXINSIGHT_CONNECTOR_LOG=0' });
});

test('an unusable workspace: the call is answered, nothing is written anywhere, and status says why', async (t) => {
  const s = setup(t, { unusable: true });
  const r = await call(s.callLog, 'workspace_info', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  assert.equal(r.content[0].text, 'ok');
  s.callLog.event('launch');
  assert.deepEqual(allFiles(s.root), [s.home + path.sep]);
  const st = s.callLog.status();
  assert.equal(st.state, 'skipped');
  assert.match(st.reason, /no usable workspace/);
});

test('calls made while the workspace was unusable are written into the first file that opens; beyond the cap, the oldest are counted', async (t) => {
  const s = setup(t, { unusable: true });
  const other = path.join(s.root, 'Target B');
  fs.mkdirSync(other);
  for (let i = 0; i < 52; i++) await work(s.callLog, 'run_pjsr', { code: `n${i}` }, async () => ({ content: [], isError: true }));
  assert.deepEqual(allFiles(s.root).sort(), [s.home + path.sep, other + path.sep].sort(), 'nothing written while unusable');
  await call(s.callLog, 'set_workspace', { path: other }, async () => {
    await s.workspace.set(other);
    return { content: [{ type: 'text', text: 'switched' }] };
  });
  const recs = only(path.join(other, 'agentic', 'logs'));
  assert.equal(recs[0].type, 'session');
  assert.deepEqual({ ...recs[1], ts: 0 }, { v: 1, ts: 0, type: 'event', event: 'unlogged calls dropped', count: 2, deferred: true });
  const starts = recs.filter((r) => r.type === 'call_start');
  assert.equal(starts.length, 51, 'the last 50 unlogged calls, then set_workspace itself');
  assert.equal(starts[0].input.code, 'n2', 'the oldest were dropped');
  assert.equal(starts.at(-1).tool, 'set_workspace');
  assert.deepEqual(recs.at(-1).result, { content: [{ type: 'text', text: 'switched' }] });
  assert.equal(s.warnings.length, 0);
});

test('a write failure never fails the call: one warning, and nothing more is written to that file', async (t) => {
  let writes = 0;
  const failing = { ...fs, writeSync: (...a) => { writes++; if (writes >= 2) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(...a); } };
  const s = setup(t, { fs: failing });
  const r1 = await work(s.callLog, 'run_pjsr', { code: '1;' }, async () => ({ content: [{ type: 'text', text: 'one' }] }));
  const r2 = await work(s.callLog, 'run_pjsr', { code: '2;' }, async () => {
    s.callLog.bridge(sent('c1', '2;'));
    s.callLog.bridge(done('c1', '2;', { status: 'success' }));
    return { content: [{ type: 'text', text: 'two' }] };
  });
  s.callLog.event('launch');
  assert.equal(r1.content[0].text, 'one');
  assert.equal(r2.content[0].text, 'two');
  assert.equal(writes, 2, 'no write after the failed one');
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /call log.*ENOSPC/i);
  const st = s.callLog.status();
  assert.equal(st.state, 'failed');
  assert.match(st.reason, /ENOSPC/);
});

// The workspace goes missing mid-session (deleted, or its volume unmounted). The workspace check sees
// it (the injected stat), so the log stops with one warning instead of writing into a file nobody will
// see, never re-creates the folder, and opens a new file once the workspace is back.
test('a workspace that goes missing: one warning, no folder re-created, a new file once it is back', async (t) => {
  let missing = false;
  const enoent = () => { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e; };
  const workspaceFs = {
    statSync: (p) => (missing ? enoent() : fs.statSync(p)),
    accessSync: (p, m) => (missing ? enoent() : fs.accessSync(p, m)),
    realpathSync: (p) => (missing ? enoent() : fs.realpathSync.native(p)),
  };
  let mkdirs = 0;
  const logFs = { ...fs, mkdirSync: (...a) => { mkdirs++; return fs.mkdirSync(...a); } };
  const s = setup(t, { workspaceFs, fs: logFs });
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const [first] = files(s.logsDir);
  assert.equal(mkdirs, 1);

  missing = true;
  const r = await work(s.callLog, 'run_pjsr', { code: 'lost' }, async () => ({ content: [{ type: 'text', text: 'answered' }] }));
  assert.equal(r.content[0].text, 'answered', 'the call is answered as before');
  s.callLog.event('launch');
  await work(s.callLog, 'run_pjsr', { code: 'lost too' }, async () => ({ content: [] }));
  assert.equal(s.warnings.length, 1, JSON.stringify(s.warnings));
  assert.match(s.warnings[0], /call log: stopped writing .*: the workspace .* does not exist/);
  assert.equal(mkdirs, 1, 'nothing re-created');
  assert.equal(s.callLog.status().state, 'skipped');
  assert.deepEqual(read(path.join(s.logsDir, first)).map((x) => x.type), ['session', 'call_start', 'call_end'], 'nothing written while it was gone');

  missing = false;
  await work(s.callLog, 'scan_workspace', {}, async () => ({ content: [] }));
  const now = files(s.logsDir);
  assert.equal(now.length, 2);
  const recs = read(path.join(s.logsDir, now.find((f) => f !== first)));
  assert.deepEqual(recs.map((x) => x.type), ['session', 'call_start', 'call_end', 'call_start', 'call_end', 'call_start', 'call_end']);
  assert.equal(recs[0].previousLog, path.join(s.logsDir, first));
  assert.deepEqual(recs.filter((x) => x.type === 'call_start').map((x) => [x.tool, x.input?.code, x.deferred]),
    [['run_pjsr', 'lost', true], ['run_pjsr', 'lost too', true], ['scan_workspace', undefined, undefined]],
    'the calls made while it was gone are written late, marked deferred');
  assert.equal(s.warnings.length, 1);
});

// The log file itself deleted while open (its folder cleaned up): writes to the open fd would succeed
// and go nowhere. fstat's link count says so (injected here, so this runs the same on every OS).
test('a log file deleted while open: one warning, and the next call opens a new file', async (t) => {
  const deleted = new Set();
  const fds = [];
  const logFs = {
    ...fs,
    openSync: (...a) => { const fd = fs.openSync(...a); fds.push(fd); return fd; },
    closeSync: (fd) => { deleted.delete(fd); return fs.closeSync(fd); }, // the OS reuses fd numbers
    fstatSync: (fd) => (deleted.has(fd) ? { nlink: 0 } : fs.fstatSync(fd)),
  };
  const s = setup(t, { fs: logFs });
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const [first] = files(s.logsDir);
  deleted.add(fds[0]);
  await work(s.callLog, 'run_pjsr', { code: 'after' }, async () => ({ content: [] }));
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /stopped writing .*: the log file was deleted/);
  const second = files(s.logsDir).find((f) => f !== first);
  assert.ok(second, 'a new file');
  const recs = read(path.join(s.logsDir, second));
  assert.deepEqual(recs.map((x) => x.type), ['session', 'call_start', 'call_end']);
  assert.equal(recs[1].input.code, 'after');
});

test('a log folder that cannot be created: one warning, the calls still run', async (t) => {
  const failing = { ...fs, mkdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
  const s = setup(t, { fs: failing });
  for (let i = 0; i < 3; i++) {
    const r = await work(s.callLog, 'list_open_images', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    assert.equal(r.content[0].text, 'ok');
  }
  assert.equal(s.warnings.length, 1);
  assert.equal(s.callLog.status().state, 'failed');
});

test('a session info getter that throws does not stop the log', async (t) => {
  const s = setup(t, { sessionInfo: () => { throw new Error('no packs yet'); } });
  await work(s.callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const [session] = only(s.logsDir);
  assert.equal(session.type, 'session');
  assert.equal(session.pid, 4242);
  assert.match(session.sessionInfoError, /no packs yet/);
});

test('a second file in the same second gets a suffix instead of appending to the first', async (t) => {
  const root = tmpRoot(t);
  const dir = path.join(root, 'ws');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'agentic', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agentic', 'logs', '20260923-123456-4242.jsonl'), 'earlier\n');
  const workspace = createWorkspace({ cwd: dir, env: {}, homeDir: path.join(root, 'home'), platform: process.platform });
  const callLog = createCallLog({ workspace, env: {}, now: () => T0, pid: 4242, log() {}, onExit() {} });
  await work(callLog, 'list_open_images', {}, async () => ({ content: [] }));
  const logs = path.join(dir, 'agentic', 'logs');
  assert.deepEqual(files(logs), ['20260923-123456-4242-2.jsonl', '20260923-123456-4242.jsonl']);
  assert.equal(fs.readFileSync(path.join(logs, '20260923-123456-4242.jsonl'), 'utf8'), 'earlier\n');
});

test('at process exit, the open file records the exit code, the calls still running and the bridge commands in flight', async (t) => {
  const s = setup(t);
  const c = s.callLog.startCall('run_bxt', { view_id: 'L' });
  await s.callLog.run(c, async () => {
    s.callLog.bridge(sent('c9', 'BlurXTerminator code'));
  });
  assert.equal(s.exits.length, 1, 'one exit hook, installed when the file opened');
  s.exits[0](143);
  const recs = only(s.logsDir);
  const exit = recs.at(-1);
  assert.equal(exit.type, 'event');
  assert.equal(exit.event, 'exit');
  assert.equal(exit.code, 143);
  assert.deepEqual(exit.inFlight.map((x) => [x.seq, x.tool]), [[1, 'run_bxt']]);
  assert.equal(exit.pendingBridge.length, 1);
  assert.equal(exit.pendingBridge[0].cmdId, 'c9');
  assert.equal(exit.pendingBridge[0].code, 'BlurXTerminator code');
  assert.equal(exit.pendingBridge[0].seq, 1);
  s.callLog.endCall(c, { content: [] });
  assert.equal(only(s.logsDir).length, recs.length, 'nothing is written after exit');
});

test('records are written synchronously, whole lines, one per record', async (t) => {
  const s = setup(t);
  const c = s.callLog.startCall('run_pjsr', { code: 'line1\nline2 "quoted" ☃' });
  s.callLog.run(c, () => s.callLog.touch());
  const text = fs.readFileSync(path.join(s.logsDir, files(s.logsDir)[0]), 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').length, 3, 'session + call_start, each on one line');
  assert.equal(JSON.parse(text.split('\n')[1]).input.code, 'line1\nline2 "quoted" ☃');
  s.callLog.endCall(c, { content: [] });
});
