// How the server stops (exitOnStop, src/server.mjs): a harness stops an MCP server by closing its
// stdin or by sending SIGTERM, SIGINT or SIGHUP. Each of these exits through process.exit(), so the
// 'exit' hooks run: queued commands are dropped (src/process-probe.mjs onProcessExit). The unit tests use fake process and stdin objects, so no real signal handler is
// installed in the test runner; one child process checks the real thing end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exitOnStop } from '../src/server.mjs';

function fakes() {
  const exits = [];
  const proc = Object.assign(new EventEmitter(), { exit: (code) => exits.push(code) });
  const stdin = new EventEmitter();
  exitOnStop({ proc, stdin });
  return { proc, stdin, exits };
}

test('stdin closing exits with 0', () => {
  const a = fakes();
  a.stdin.emit('end');
  assert.deepEqual(a.exits, [0]);
  const b = fakes();
  b.stdin.emit('error', new Error('EPIPE'));
  assert.deepEqual(b.exits, [0]);
});

test('SIGTERM, SIGINT and SIGHUP exit with the conventional 128 + signal number', () => {
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const f = fakes();
    assert.equal(f.proc.listenerCount(sig), 1, `${sig} is handled`);
    f.proc.emit(sig, sig);
    assert.deepEqual(f.exits, [code], sig);
  }
});

// A real process: the exit hooks run on stdin close, and on SIGTERM where a signal can be caught
// (Windows has no catchable SIGTERM: child.kill() terminates the process outright).
async function childWithHook(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pixi-exit-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'hook-ran');
  const src = new URL('../src/', import.meta.url);
  const script = `
    import { exitOnStop } from ${JSON.stringify(new URL('server.mjs', src).href)};
    import { onProcessExit } from ${JSON.stringify(new URL('process-probe.mjs', src).href)};
    import fs from 'node:fs';
    onProcessExit(() => fs.writeFileSync(${JSON.stringify(marker)}, 'yes'));
    exitOnStop({ proc: process, stdin: process.stdin });
    process.stdin.resume();
    process.stdout.write('ready\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (c) => reject(new Error(`child exited early (${c})`)));
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, marker, exited };
}

test('a real process runs its exit hooks when its stdin closes', async (t) => {
  const { child, marker, exited } = await childWithHook(t);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
});

test('a real process runs its exit hooks on SIGTERM and exits 143', { skip: process.platform === 'win32' && 'no catchable SIGTERM on Windows' }, async (t) => {
  const { child, marker, exited } = await childWithHook(t);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
});
