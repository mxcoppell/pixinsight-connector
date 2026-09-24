import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessProbe } from '../src/process-probe.mjs';
import { concatSources } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Linux: plain /proc reads, no child process at all.
// ---------------------------------------------------------------------------

test('linux reads /proc without spawning anything', async () => {
  let spawned = false;
  const probe = createProcessProbe({
    platform: 'linux',
    exec: async () => { spawned = true; return ''; },
    readFile: async (p) => {
      if (p === '/proc') return null;
      if (p.endsWith('/comm')) return 'PixInsight\n';
      if (p.endsWith('/status')) return 'VmRSS:\t1474560 kB\n';
      return '';
    },
    listProc: async () => ['4242'],
  });
  assert.equal(await probe.isRunning(), true);
  assert.equal(await probe.memoryMB(), 1440);
  assert.equal(spawned, false, 'linux must not shell out');
});

test('linux: no /proc/*/comm matches PixInsight -> not running, not unknown', async () => {
  const probe = createProcessProbe({
    platform: 'linux',
    readFile: async (p) => (p.endsWith('/comm') ? 'bash\n' : null),
    listProc: async () => ['1', '2'],
  });
  assert.equal(await probe.isRunning(), false);
  assert.equal(await probe.memoryMB(), null);
});

test('linux: readFile returning null (missing file) degrades to null/false instead of throwing', async () => {
  const probe = createProcessProbe({
    platform: 'linux',
    readFile: async () => null,
    listProc: async () => ['1', '2'],
  });
  assert.equal(await probe.isRunning(), false);
  assert.equal(await probe.memoryMB(), null);
  assert.equal(await probe.startedAt(), null);
});

test('linux startedAt combines /proc/<pid>/stat field 22 with /proc/uptime boot time', async () => {
  // Build fields 3..52 of a stat line programmatically so "field 22" is
  // unambiguous (field 22 overall == index 19 once fields 1/2 are stripped).
  const rest = new Array(50).fill('0');
  rest[0] = 'S'; // field 3: state
  rest[19] = '500'; // field 22: starttime, in clock ticks since boot
  const statLine = `4242 (PixInsight) ${rest.join(' ')}`;

  const probe = createProcessProbe({
    platform: 'linux',
    listProc: async () => ['4242'],
    readFile: async (p) => {
      if (p.endsWith('/comm')) return 'PixInsight\n';
      if (p.endsWith('/stat')) return statLine;
      if (p === '/proc/uptime') return '1000.50 900.00\n';
      return null;
    },
  });
  const started = await probe.startedAt();
  const expectedBoot = Date.now() - 1000.5 * 1000;
  const expected = expectedBoot + (500 / 100) * 1000; // CLK_TCK assumed 100 (USER_HZ)
  assert.ok(Number.isFinite(started));
  assert.ok(Math.abs(started - expected) < 1000, `expected ~${expected}, got ${started}`);
});

test('linux startedAt returns null when /proc/uptime is unavailable', async () => {
  const probe = createProcessProbe({
    platform: 'linux',
    listProc: async () => ['4242'],
    readFile: async (p) => {
      if (p.endsWith('/comm')) return 'PixInsight\n';
      if (p.endsWith('/stat')) return `4242 (PixInsight) S ${new Array(49).fill('0').join(' ')}`;
      return null; // /proc/uptime missing
    },
  });
  assert.equal(await probe.startedAt(), null);
});

// ---------------------------------------------------------------------------
// macOS: pgrep -x (exact process name, no pipe) + ps -o lstart=/rss=
// ---------------------------------------------------------------------------

test('macOS uses pgrep -x (exact process name) then ps -o lstart=/rss=, no shell pipes', async () => {
  const calls = [];
  const probe = createProcessProbe({
    platform: 'darwin',
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'pgrep') return '4242\n';
      if (cmd === 'ps' && args.includes('lstart=')) return 'Sun Sep 20 10:27:23 2026\n';
      if (cmd === 'ps' && args.includes('rss=')) return '1474560\n';
      return '';
    },
  });
  assert.equal(await probe.isRunning(), true);
  assert.equal(await probe.memoryMB(), 1440);
  assert.equal(await probe.startedAt(), Date.parse('Sun Sep 20 10:27:23 2026'));
  assert.deepEqual(calls[0], { cmd: 'pgrep', args: ['-x', 'PixInsight'] });
  assert.ok(!calls.some((c) => c.cmd === 'ps' && c.args.join(' ').includes('aux')), 'must not use ps aux');
  assert.ok(!calls.some((c) => JSON.stringify(c.args).includes('|')), 'no shell pipe passed as an arg');
});

// A fake pgrep over a process table, honouring -x (exact process name) and -f (full argv match),
// so the probe's choice of flag is tested by what it would actually match.
function fakePgrep(table) {
  return (args) => {
    const [flag, pattern] = args;
    const hits = table.filter((p) => (flag === '-x' ? p.name === pattern : flag === '-f' ? p.argv.includes(pattern) : false));
    return hits.map((p) => `${p.pid}\n`).join('');
  };
}

test('macOS: a process whose argv merely mentions PixInsight is not PixInsight', async () => {
  const pgrep = fakePgrep([{ pid: 111, name: 'node', argv: 'node agent "summarize my PixInsight session"' }]);
  const probe = createProcessProbe({
    platform: 'darwin',
    exec: async (cmd, args) => {
      if (cmd === 'pgrep') return pgrep(args);
      if (cmd === 'ps' && args.includes('lstart=')) return 'Sun Sep 20 10:27:23 2026\n';
      if (cmd === 'ps' && args.includes('rss=')) return '1024\n';
      return '';
    },
  });
  assert.equal(await probe.isRunning(), false);
  assert.equal(await probe.startedAt(), null);
  assert.equal(await probe.memoryMB(), null);
});

test('macOS: startedAt and memoryMB read the PixInsight pid, not an earlier process mentioning it', async () => {
  const pgrep = fakePgrep([
    { pid: 111, name: 'node', argv: 'node agent "PixInsight"' },
    { pid: 4242, name: 'PixInsight', argv: '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight' },
  ]);
  const psPids = [];
  const probe = createProcessProbe({
    platform: 'darwin',
    exec: async (cmd, args) => {
      if (cmd === 'pgrep') return pgrep(args);
      if (cmd === 'ps') {
        psPids.push(args[args.length - 1]);
        return args.includes('lstart=') ? 'Sun Sep 20 10:27:23 2026\n' : '2048\n';
      }
      return '';
    },
  });
  assert.equal(await probe.isRunning(), true);
  await probe.startedAt();
  await probe.memoryMB();
  assert.deepEqual(psPids, ['4242', '4242']);
});

test('macOS: pgrep finding nothing means not running, not unknown', async () => {
  const probe = createProcessProbe({ platform: 'darwin', exec: async () => '' });
  assert.equal(await probe.isRunning(), false);
  assert.equal(await probe.memoryMB(), null);
  assert.equal(await probe.startedAt(), null);
});

test('macOS: exec failure after a successful pid lookup returns null, never throws', async () => {
  const probe = createProcessProbe({
    platform: 'darwin',
    exec: async (cmd) => {
      if (cmd === 'pgrep') return '4242\n';
      throw new Error('spawn ENOENT');
    },
  });
  assert.equal(await probe.isRunning(), true);
  assert.equal(await probe.memoryMB(), null);
});

// ---------------------------------------------------------------------------
// Windows: tasklist (not wmic) + PowerShell for start time / working set.
// ---------------------------------------------------------------------------

test('windows uses tasklist, not wmic', async () => {
  const calls = [];
  const probe = createProcessProbe({ platform: 'win32',
    exec: async (cmd) => { calls.push(cmd); return '"PixInsight.exe","4242","Console","1","1,440,000 K"'; } });
  assert.equal(await probe.isRunning(), true);
  assert.match(calls[0], /tasklist/);
  assert.ok(!calls.some((c) => /wmic/i.test(c)), 'wmic is deprecated and absent on current Windows');
});

test('windows: "no tasks" tasklist output means not running', async () => {
  const probe = createProcessProbe({
    platform: 'win32',
    exec: async () => 'INFO: No tasks are running which match the specified criteria.',
  });
  assert.equal(await probe.isRunning(), false);
});

test('windows startedAt/memoryMB go through PowerShell, never wmic', async () => {
  const calls = [];
  const probe = createProcessProbe({
    platform: 'win32',
    exec: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'tasklist') return '"PixInsight.exe","4242","Console","1","1,440,000 K"';
      if (cmd === 'powershell' && args.join(' ').includes('WorkingSet64')) return '1509949440\n';
      if (cmd === 'powershell' && args.join(' ').includes('StartTime')) return '2026-09-20T10:27:23.0000000-05:00\n';
      return '';
    },
  });
  assert.equal(await probe.memoryMB(), 1440);
  const started = await probe.startedAt();
  assert.ok(Number.isFinite(started));
  assert.ok(!calls.some((c) => /wmic/i.test(c)));
});

// ---------------------------------------------------------------------------
// Degradation: unsupported OS, or an OS whose tools fail outright.
// ---------------------------------------------------------------------------

test('an OS that cannot answer returns null rather than guessing', async () => {
  const probe = createProcessProbe({ platform: 'sunos', exec: async () => { throw new Error('nope'); } });
  assert.equal(await probe.isRunning(), null);
  assert.equal(await probe.memoryMB(), null);
  assert.equal(await probe.startedAt(), null);
});

test('a supported OS whose exec always throws degrades to null, never throws', async () => {
  const probe = createProcessProbe({
    platform: 'darwin',
    exec: async () => { throw new Error('pgrep: command not found'); },
  });
  assert.equal(await probe.isRunning(), null);
  assert.equal(await probe.memoryMB(), null);
  assert.equal(await probe.startedAt(), null);
});

// ---------------------------------------------------------------------------
// No shell pipelines anywhere in src/.
// ---------------------------------------------------------------------------

test('no src file contains a shell pipeline', async () => {
  const src = await concatSources('src/');
  for (const bad of [/\bps\s+aux/, /\|\s*grep\b/, /\|\s*awk\b/, /\|\s*wc\b/, /\bdf\s+-/]) {
    assert.doesNotMatch(src, bad, `shell pipeline ${bad} is banned`);
  }
});
