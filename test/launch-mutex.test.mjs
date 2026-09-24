// The machine-wide launch mutex (src/runtime.mjs createLaunchMutex): an exclusive bind of one
// loopback TCP port, held only while ensurePixInsight starts PixInsight, so two connectors working in
// two targets never launch PixInsight twice. No file anywhere. Fake net for the decisions; one test
// binds real loopback ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLaunchMutex, ensurePixInsight, DEFAULT_LAUNCH_PORT, LAUNCH_MUTEX_BANNER } from '../src/runtime.mjs';
import { fakeNet, holdForeign } from './fake-net.mjs';

const quickSleep = () => new Promise((r) => setImmediate(r));

// A free loopback port, found by binding port 0.
async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen({ host: '127.0.0.1', port: 0 }, r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

test('the port is 127.0.0.1:DEFAULT_LAUNCH_PORT, or PIXINSIGHT_CONNECTOR_LAUNCH_PORT when that is a valid port', async () => {
  const n = fakeNet();
  const release = (await createLaunchMutex({ net: n, env: {} }).acquire({ timeoutMs: 1000 })).release;
  assert.deepEqual(n.binds[0], { host: '127.0.0.1', port: DEFAULT_LAUNCH_PORT, exclusive: true });
  release();
  assert.ok(DEFAULT_LAUNCH_PORT > 1024 && DEFAULT_LAUNCH_PORT < 32768, 'below every OS ephemeral range');
  await (await createLaunchMutex({ net: n, env: { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: '40111' } }).acquire({ timeoutMs: 1000 })).release();
  assert.equal(n.binds[1].port, 40111);
  for (const bad of ['0', '70000', 'abc', '']) {
    await (await createLaunchMutex({ net: n, env: { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: bad } }).acquire({ timeoutMs: 1000 })).release();
    assert.equal(n.binds.at(-1).port, DEFAULT_LAUNCH_PORT, bad);
  }
});

test('a second holder waits until the first releases, then gets it', async () => {
  const n = fakeNet();
  const a = await createLaunchMutex({ net: n, env: {} }).acquire({ timeoutMs: 5000 });
  assert.equal(a.held, true);
  let bGot = null;
  const bP = createLaunchMutex({ net: n, env: {}, sleep: quickSleep }).acquire({ timeoutMs: 5000 }).then((b) => { bGot = b; return b; });
  for (let i = 0; i < 20; i++) await quickSleep();
  assert.equal(bGot, null, 'still waiting while the first holds it');
  a.release();
  const b = await bP;
  assert.equal(b.held, true);
  assert.equal(b.waited, true);
  b.release();
  assert.equal(n.bound.size, 0);
});

test('a port held by another program (no pixinsight-connector banner) is not waited on: proceeds at once, logs once per mutex', async () => {
  for (const mode of ['silent', 'reset', 'garbage']) {
    const n = fakeNet();
    await holdForeign(n, DEFAULT_LAUNCH_PORT, mode);
    const logs = [];
    let slept = 0;
    const m = createLaunchMutex({ net: n, env: {}, log: (s) => logs.push(s), sleep: async () => { slept++; }, handshakeTimeoutMs: 20 });
    const r1 = await m.acquire({ timeoutMs: 120_000 });
    const r2 = await m.acquire({ timeoutMs: 120_000 });
    assert.equal(r1.held, false, mode);
    assert.equal(r1.foreign, true, mode);
    assert.equal(r2.foreign, true, mode);
    assert.equal(slept, 0, `${mode}: never waits`);
    assert.equal(logs.length, 1, mode);
    assert.match(logs[0], /another program/);
    assert.match(logs[0], /PIXINSIGHT_CONNECTOR_LAUNCH_PORT/);
    await r1.release(); // a no-op, never throws
    assert.ok(n.bound.has(DEFAULT_LAUNCH_PORT), 'the other program keeps its port');
  }
});

test('a holder that answers with the banner is another connector: waited on, and only up to the timeout', async () => {
  const n = fakeNet();
  const a = await createLaunchMutex({ net: n, env: {} }).acquire({ timeoutMs: 1000 });
  assert.equal(a.held, true);
  let t = 0;
  const logs = [];
  const m = createLaunchMutex({ net: n, env: {}, log: (s) => logs.push(s), now: () => t, sleep: async (ms) => { t += ms; } });
  const r = await m.acquire({ timeoutMs: 1000 });
  assert.equal(r.held, false);
  assert.equal(r.waited, true);
  assert.notEqual(r.foreign, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stayed bound/);
  await a.release();
});

test('a holder that releases between the failed bind and the handshake is retried at once', async () => {
  const n = fakeNet();
  const a = await createLaunchMutex({ net: n, env: {} }).acquire({ timeoutMs: 1000 });
  const origConnect = n.connect;
  n.connect = (o) => { a.release(); n.connect = origConnect; return origConnect(o); }; // gone before it answers
  const r = await createLaunchMutex({ net: n, env: {}, sleep: async () => {} }).acquire({ timeoutMs: 1000 });
  assert.equal(r.held, true);
  await r.release();
});

test('a net that cannot connect cannot identify the holder: treated as another program, never waited on', async () => {
  const n = fakeNet();
  await holdForeign(n, DEFAULT_LAUNCH_PORT, 'silent');
  n.connect = () => { throw new Error('no sockets'); };
  const r = await createLaunchMutex({ net: n, env: {}, log: () => {}, sleep: async () => assert.fail('no wait') }).acquire({ timeoutMs: 1000 });
  assert.equal(r.foreign, true);
});

test('real loopback sockets: the mutex of a connector answers with the banner; a silent program on the port is skipped quickly', async (t) => {
  const port = await freePort();
  const env = { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: String(port) };
  const a = await createLaunchMutex({ env }).acquire({ timeoutMs: 5000 });
  const banner = await new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port });
    let got = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { got += d; });
    c.on('end', () => resolve(got));
    c.on('error', reject);
  });
  assert.equal(banner, LAUNCH_MUTEX_BANNER);
  await a.release();

  const other = net.createServer(() => {}); // accepts, never answers
  await new Promise((r) => other.listen({ host: '127.0.0.1', port }, r));
  t.after(() => new Promise((r) => { other.close(() => r()); }));
  const t0 = Date.now();
  const r = await createLaunchMutex({ env, log: () => {}, handshakeTimeoutMs: 300 }).acquire({ timeoutMs: 120_000 });
  assert.equal(r.foreign, true);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('any other bind failure proceeds at once without the mutex and logs once per mutex', async () => {
  const logs = [];
  const m = createLaunchMutex({ net: fakeNet({ failWith: 'EACCES' }), env: {}, log: (s) => logs.push(s) });
  const r1 = await m.acquire({ timeoutMs: 1000 });
  const r2 = await m.acquire({ timeoutMs: 1000 });
  assert.equal(r1.held, false);
  assert.equal(r1.waited, false);
  assert.equal(r2.held, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EACCES/);
  const throwing = createLaunchMutex({ net: { createServer() { throw new Error('no sockets here'); } }, env: {}, log: () => {} });
  assert.equal((await throwing.acquire({ timeoutMs: 1000 })).held, false);
});

test('real loopback sockets: a second bind of a held port fails, and succeeds once released', async (t) => {
  // A free port, found by binding port 0.
  const probe = net.createServer();
  await new Promise((r) => probe.listen({ host: '127.0.0.1', port: 0 }, r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const env = { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: String(port) };
  const a = await createLaunchMutex({ env }).acquire({ timeoutMs: 5000 });
  t.after(() => a.release());
  assert.equal(a.held, true);
  let b = null;
  const bP = createLaunchMutex({ env }).acquire({ timeoutMs: 5000 }).then((x) => { b = x; return x; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b, null, 'the second connector waits');
  a.release();
  assert.equal((await bP).held, true);
  (await bP).release();
});

// --- ensurePixInsight under the mutex ---

test('two cold starts at once launch PixInsight once: the second waits, re-checks, and finds it running', async () => {
  const n = fakeNet();
  let running = false;
  let spawns = 0;
  const probe = { isRunning: async () => running };
  const spawn = () => { spawns++; setTimeout(() => { running = true; }, 30); return { unref() {}, on() {} }; };
  const opts = () => ({ platform: { piBin: '/fake/PixInsight' }, probe, spawn, log: () => {}, env: {}, mutex: createLaunchMutex({ net: n, env: {}, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }) });
  const [a, b] = await Promise.all([ensurePixInsight(opts()), ensurePixInsight(opts())]);
  assert.equal(spawns, 1);
  assert.deepEqual([a.started, b.started].sort(), [false, true]);
  assert.equal(n.bound.size, 0, 'released after the launch-and-wait');
});

test('the mutex is released when the launch fails, and never taken when PixInsight is already running', async () => {
  const n = fakeNet();
  const mutex = createLaunchMutex({ net: n, env: {} });
  await assert.rejects(ensurePixInsight({
    platform: { piBin: '/fake/PixInsight' }, probe: { isRunning: async () => false }, log: () => {}, env: {}, timeoutMs: 1, mutex,
    spawn: () => ({ unref() {}, on() {} }),
  }), /did not start/);
  assert.equal(n.bound.size, 0);
  await ensurePixInsight({ probe: { isRunning: async () => true }, spawn: () => assert.fail('no spawn'), mutex, env: {} });
  assert.equal(n.binds.length, 1, 'no bind when nothing needs launching');
});

test('a mutex that cannot be had still launches (degrade, never fail)', async () => {
  let running = false;
  const r = await ensurePixInsight({
    platform: { piBin: '/fake/PixInsight' }, probe: { isRunning: async () => running }, log: () => {}, env: {},
    mutex: createLaunchMutex({ net: fakeNet({ failWith: 'EPERM' }), env: {}, log: () => {} }),
    spawn: () => { running = true; return { unref() {}, on() {} }; },
  });
  assert.equal(r.started, true);
});

test('a slow first probe that saw PixInsight down while another connector launched it does not start a second one (re-check after every acquire)', async () => {
  // B's first isRunning() snapshots "not running" at call time and answers late. Meanwhile A takes
  // the mutex, starts PixInsight, sees it up and releases -- so B binds the port at its first try
  // (waited: false) and must still look again before spawning. A holds the mutex for about one
  // 500 ms autostart poll, so B's probe answers after A released it.
  const n = fakeNet();
  let running = false;
  let spawns = 0;
  const spawn = () => { spawns++; setTimeout(() => { running = true; }, 5); return { unref() {}, on() {} }; };
  const mutex = () => createLaunchMutex({ net: n, env: {}, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  let bFirst = true;
  const slowProbe = {
    isRunning: () => {
      const snap = running;
      if (bFirst) { bFirst = false; return new Promise((r) => setTimeout(() => r(snap), 800)); }
      return Promise.resolve(snap);
    },
  };
  const fastProbe = { isRunning: async () => running };
  const base = { platform: { piBin: '/fake/PixInsight' }, spawn, log: () => {}, env: {} };
  const bP = ensurePixInsight({ ...base, probe: slowProbe, mutex: mutex() });
  const a = await ensurePixInsight({ ...base, probe: fastProbe, mutex: mutex() });
  const b = await bP;
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal(spawns, 1);
  assert.equal(n.bound.size, 0);
});

test('a port that can be neither bound nor connected to is retried only up to the timeout', async () => {
  const n = fakeNet();
  n.createServer = () => {
    const s = new EventEmitter();
    s.listen = () => { queueMicrotask(() => s.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))); return s; };
    return s;
  }; // and nothing is bound, so connect() is refused
  let t = 0;
  const logs = [];
  const r = await createLaunchMutex({ net: n, env: {}, log: (s) => logs.push(s), now: () => t, sleep: async (ms) => { t += ms; } }).acquire({ timeoutMs: 1000 });
  assert.equal(r.held, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /neither bound nor connected/);
});

test('real processes: the OS frees the port when the holder crashes, and the next connector gets the mutex', async (t) => {
  const port = await freePort();
  const runtimeUrl = new URL('../src/runtime.mjs', import.meta.url).href;
  // The child takes the mutex through the real createLaunchMutex, says so, and then hangs until killed.
  const script = `
    const { createLaunchMutex } = await import(${JSON.stringify(runtimeUrl)});
    const m = createLaunchMutex({ env: { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: ${JSON.stringify(String(port))} } });
    const r = await m.acquire({ timeoutMs: 5000 });
    process.stdout.write(r.held ? 'held\\n' : 'not held\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const first = await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (d) => resolve(String(d).trim()));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
  assert.equal(first, 'held');
  const env = { PIXINSIGHT_CONNECTOR_LAUNCH_PORT: String(port) };
  const whileAlive = await createLaunchMutex({ env, log: () => {} }).acquire({ timeoutMs: -1 });
  assert.equal(whileAlive.held, false, 'held by the live child');
  assert.equal(whileAlive.waited, true, 'identified as a connector by its banner');
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL'); // no cleanup runs: only the OS can free the port
  await exited;
  const after = await createLaunchMutex({ env, log: () => {} }).acquire({ timeoutMs: 5000 });
  assert.equal(after.held, true);
  await after.release();
});
