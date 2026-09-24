// Split out of test/cli.test.mjs as a verified-working structural workaround
// for a confirmed `node:test` bug (reproduces identically on Node 22.13.1 and
// Node 26.8.2, with or without the directory-vs-glob `npm test` fix, in
// isolation or as part of the full suite): when these 3 tests lived alongside
// cli.test.mjs's other (async) tests, they executed -- confirmed via a
// console.error probe inside each test body -- but never appeared in the
// reporter's tally (not as passes, not as failures, not as skips; just
// silently absent from `tests`/`pass`/TAP output alike). Root cause not
// isolated (ruled out: sync-vs-async, duplicate test names, env/coverage
// config); moving these 3 into their own single-purpose file makes them count
// correctly, confirmed by running this file alone and as part of `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.mjs';

test('parseArgs defaults to serve with no arguments', () => {
  assert.deepEqual(parseArgs([]), { command: 'serve', rest: [] });
});

test('parseArgs recognizes doctor and install subcommands', () => {
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor', rest: [] });
  assert.deepEqual(parseArgs(['doctor', '--json']), { command: 'doctor', rest: ['--json'] });
  assert.deepEqual(parseArgs(['install']), { command: 'install', rest: [] });
});

test('parseArgs treats an unrecognized first argument (e.g. --help) as serve, forwarding it', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'serve', rest: ['--help'] });
});
