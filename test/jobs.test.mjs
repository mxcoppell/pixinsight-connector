// Jobs (run_pjsr / run_pjsr_file with `async`), job_status, cancel_job, the refusal of PixInsight
// calls while a job runs, and the hidden-dialog hint. Built the way serve() builds it --
// buildRuntimeApi() + assembleCatalog() + createServer() -- over a fake bridge. No PixInsight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildRuntimeApi, assembleCatalog, dialogHintMs } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { createJobs, PixInsightBusyError } from '../src/jobs.mjs';
import { JobCancelledError } from '../src/bridge.mjs';

const R = (...p) => path.resolve(...p);
const trustingFs = { statSync: () => ({ isDirectory: () => true }), accessSync: () => {}, realpathSync: (p) => p };
const workspaceAt = (cwd) => createWorkspace({ cwd, env: {}, homeDir: R('/home/u'), platform: 'linux', fs: trustingFs });

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// A fake bridge: each job send waits on `gates` (resolved by the test); plain sends answer at once.
function fakeBridge() {
  const b = {
    sent: [],
    cancels: [],
    beat: null,
    progress: null,
    gate: null,
    slowMs: 0,
    async pjsr(code, opts) {
      const id = `cmd-${b.sent.length + 1}`;
      b.sent.push({ code, job: !!opts?.job, id });
      if (opts?.job) {
        opts.onSent?.(id);
        b.beat = { state: 'busy', tool: 'run_script', cmdId: id, ts: Date.now(), ageMs: 1000 };
        b.gate = deferred();
        const r = await b.gate.promise;
        b.beat = null;
        return r;
      }
      if (b.slowMs) await delay(b.slowMs);
      return { status: 'ok', result: `ran ${code}`, outputs: { consoleOutput: `ran ${code}`, consoleErrors: [] } };
    },
    async listImages() { return [{ id: 'V1' }]; },
    status: (cmdId) => ({ heartbeat: b.beat, progress: cmdId && b.progress ? b.progress : null }),
    cancel: (cmdId) => { b.cancels.push(cmdId); return { state: 'signalled' }; },
    setBridgeDir() {},
    log() {},
  };
  return b;
}

async function serve({ env = {}, bridge = fakeBridge() } = {}) {
  const workspace = workspaceAt(R('/w'));
  const deps = { machineId: () => 'rig', materializeWatcher: async () => ({ path: '/w/watcher.js', warnings: [] }), createBridge: () => bridge };
  const runtime = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace, log() {}, connectorVersion: '0', deps, env });
  const catalog = assembleCatalog({ core: await buildCoreCatalog(), packs: [], packTools: [], resetBridge: runtime.resetBridge, workspace, control: runtime.control });
  const server = createServer({ catalog, api: runtime.api, control: runtime.control });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { client, call, bridge, runtime, close: async () => { await client.close(); await server.close(); } };
}

test('createJobs: while a job runs, enter() refuses naming the job; the job settles to done / failed / cancelled / stopped', async () => {
  const jobs = createJobs();
  const d = deferred();
  const job = jobs.start({ tool: 'run_pjsr', run: (h) => { h.onSent('c1'); return d.promise; } });
  assert.equal(jobs.active(), job);
  assert.throws(() => jobs.enter({ key: Symbol('x'), tool: 'run_scnr' }), (e) => e instanceof PixInsightBusyError && e.message.includes(job.id) && /job_status/.test(e.message));
  assert.throws(() => jobs.start({ tool: 'run_pjsr', run: async () => ({}) }), PixInsightBusyError);
  d.resolve({ status: 'ok', result: '42', outputs: { consoleErrors: ['** Warning: x'] } });
  await delay(0);
  assert.equal(job.state, 'done');
  assert.equal(job.result, '42');
  assert.deepEqual(job.consoleErrors, ['** Warning: x']);
  assert.equal(jobs.active(), null);
  jobs.enter({ key: Symbol('y'), tool: 'run_scnr' }); // free again

  const outcomes = [
    [{ status: 'error', error: { message: 'Script error: MCP_CANCELLED: the command was cancelled (cancel_job)' } }, 'cancelled'],
    [{ status: 'error', error: { message: 'Script error: MCP_ABORTED: Pause/Abort was pressed' } }, 'stopped'],
    [{ status: 'error', error: { message: 'Script error: boom' } }, 'failed'],
  ];
  for (const [r, state] of outcomes) {
    const j = jobs.start({ tool: 'run_pjsr', run: async () => r });
    await delay(0);
    assert.equal(j.state, state, r.error.message);
  }
  const thrown = jobs.start({ tool: 'run_pjsr', run: async () => { throw new JobCancelledError('cancelled before PixInsight started it'); } });
  await delay(0);
  assert.equal(thrown.state, 'cancelled');
});

test('createJobs: a cancel requested before the command is written reaches the bridge as soon as it is', async () => {
  const jobs = createJobs();
  const cancelled = [];
  let sent;
  const job = jobs.start({ tool: 'run_pjsr', run: (h) => new Promise((r) => { sent = () => { h.onSent('c7'); r({ status: 'ok', result: '' }); }; }), onCancel: (id) => cancelled.push(id) });
  job.cancelRequested = true;
  await delay(0);
  sent();
  assert.deepEqual(cancelled, ['c7']);
});

test('createJobs keeps the last 20 finished jobs', async () => {
  const jobs = createJobs();
  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(jobs.start({ tool: 'run_pjsr', run: async () => ({ status: 'ok', result: String(i) }) }).id);
    await delay(0);
  }
  assert.equal(jobs.get(ids[0]), null);
  assert.equal(jobs.get(ids[24]).result, '24');
  assert.equal(jobs.latest().id, ids[24]);
});

test('run_pjsr with async starts a job and returns at once; other PixInsight calls are refused until it ends; job_status and cancel_job answer meanwhile', async () => {
  const s = await serve();
  try {
    const started = await s.call('run_pjsr', { code: 'longWork()', async: true });
    assert.equal(started.isError, false, started.text);
    const id = started.text.match(/Started job (job-\S+)/)[1];
    assert.equal(s.bridge.sent[0].job, true);

    const refused = await s.call('run_pjsr', { code: '1' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, new RegExp(`busy with job ${id}`));
    assert.equal(s.bridge.sent.length, 1, 'nothing else was sent');
    const refusedView = await s.call('get_image_stats', { view_id: 'V1' });
    assert.match(refusedView.text, /busy with job/, 'the view pre-check is refused too');

    s.bridge.progress = { text: 'round 3 of 12', at: Date.now() - 2000 };
    const status = JSON.parse((await s.call('job_status', {})).text);
    assert.equal(status.job_id, id);
    assert.equal(status.state, 'running');
    assert.equal(status.progress.text, 'round 3 of 12');
    assert.equal(status.last_sign_of_progress_s, 1);

    const c = await s.call('cancel_job', { job_id: id });
    assert.match(c.text, /stops at its next processEvents\(\) call/);
    assert.deepEqual(s.bridge.cancels, ['cmd-1']);

    // The script has stopped in PixInsight (heartbeat idle) but its result is not collected yet.
    s.bridge.beat = { state: 'idle', ts: Date.now(), ageMs: 10 };
    const ending = JSON.parse((await s.call('job_status', { job_id: id })).text);
    assert.equal(ending.state, 'ending');
    assert.equal(ending.cancel_requested, true);

    s.bridge.gate.resolve({ status: 'error', error: { message: 'Script error: MCP_CANCELLED: the command was cancelled (cancel_job)' }, outputs: {} });
    await delay(5);
    const after = JSON.parse((await s.call('job_status', { job_id: id })).text);
    assert.equal(after.state, 'cancelled');
    assert.match(after.error, /MCP_CANCELLED/);

    const ok = await s.call('run_pjsr', { code: '2' });
    assert.equal(ok.isError, false, 'PixInsight is free again');
    assert.equal(ok.text, 'ran 2');
  } finally {
    await s.close();
  }
});

test('a finished job keeps its result for job_status; cancel_job on it cancels nothing', async () => {
  const s = await serve();
  try {
    const id = (await s.call('run_pjsr', { code: 'x', async: true })).text.match(/Started job (job-\S+)/)[1];
    s.bridge.gate.resolve({ status: 'ok', result: 'done: 12 rounds', outputs: { consoleErrors: [] } });
    await delay(5);
    const st = JSON.parse((await s.call('job_status', { job_id: id })).text);
    assert.equal(st.state, 'done');
    assert.equal(st.result, 'done: 12 rounds');
    assert.match((await s.call('cancel_job', { job_id: id })).text, /already ended: done/);
    assert.equal((await s.call('job_status', { job_id: 'job-nope' })).isError, true);
  } finally {
    await s.close();
  }
});

test('async code that does not parse is refused with its line, and no job starts', async () => {
  const s = await serve();
  try {
    const r = await s.call('run_pjsr', { code: 'var = ;', async: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /Syntax error.*Nothing was sent/);
    assert.equal(s.bridge.sent.length, 0);
    assert.equal((await s.call('job_status', {})).isError, true, 'no job exists');
  } finally {
    await s.close();
  }
});

test('job_status and cancel_job are listed; run_pjsr and run_pjsr_file take `async`', async () => {
  const s = await serve();
  try {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.ok(byName.has('job_status') && byName.has('cancel_job'));
    assert.equal(byName.get('run_pjsr').inputSchema.properties.async.type, 'boolean');
    assert.equal(byName.get('run_pjsr_file').inputSchema.properties.async.type, 'boolean');
  } finally {
    await s.close();
  }
});

test('a call that runs past the dialog-hint time with a quiet "busy" heartbeat says PixInsight may be showing a dialog', async () => {
  const bridge = fakeBridge();
  bridge.slowMs = 120;
  const s = await serve({ env: { PIXINSIGHT_CONNECTOR_DIALOG_HINT_MS: '30' }, bridge });
  s.runtime.control.dialogPollMs = 5;
  bridge.beat = { state: 'busy', tool: 'run_script', cmdId: 'cmd-x', ts: Date.now() - 60_000, ageMs: 60_000 };
  try {
    const r = await s.call('run_pjsr', { code: 'crop()' });
    assert.equal(r.isError, false);
    assert.match(r.text, /no sign of progress for 60 s.*dialog waiting for a click: ask the user to look at PixInsight/);
  } finally {
    await s.close();
  }
});

test('a quick call gets no dialog hint, and PIXINSIGHT_CONNECTOR_DIALOG_HINT_MS=0 turns it off', async () => {
  assert.equal(dialogHintMs({}), 90_000);
  assert.equal(dialogHintMs({ PIXINSIGHT_CONNECTOR_DIALOG_HINT_MS: '0' }), 0);
  assert.equal(dialogHintMs({ PIXINSIGHT_CONNECTOR_DIALOG_HINT_MS: 'soon' }), 90_000);
  const s = await serve();
  try {
    const r = await s.call('run_pjsr', { code: '1' });
    assert.doesNotMatch(r.text, /dialog/);
  } finally {
    await s.close();
  }
});

test('while a run_wbpp run is alive, calls that use PixInsight and new jobs are refused naming the run; other tools still answer', async () => {
  const bridge = fakeBridge();
  const workspace = workspaceAt(R('/w'));
  let run = { runId: 'wbpp-1', pid: 4242 };
  const deps = { machineId: () => 'rig', materializeWatcher: async () => ({ path: '/w/watcher.js', warnings: [] }), createBridge: () => bridge, activeWbppRun: () => run };
  const runtime = buildRuntimeApi({ platform: { piBin: '/fake' }, probe: {}, workspace, log() {}, connectorVersion: '0', deps, env: {} });
  await assert.rejects(runtime.api.pjsr('1'), (e) => e instanceof PixInsightBusyError && /wbpp-1/.test(e.message) && /wbpp_status/.test(e.message));
  await assert.rejects(runtime.api.listImages(), PixInsightBusyError);
  assert.throws(() => runtime.control.startPjsrJob('run_pjsr', '1'), PixInsightBusyError);
  assert.equal(bridge.sent.length, 0);
  run = null;
  const r = await runtime.api.pjsr('2');
  assert.match(String(r.result ?? JSON.stringify(r)), /ran 2/);
});
