// src/cli.mjs must run main() when it is the process entry point, including when launched through
// an npm bin symlink (`npx pixinsight-connector`, a global install) and from a path containing a space.
// Comparing import.meta.url against "file://" + argv[1] fails all three: argv[1]
// is the symlink, not the resolved module; a space stays literal in argv but is %20 in the URL; and
// on Windows argv[1] is a backslashed drive path. isEntryPoint's realpath is injected so none of
// this depends on the host filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/cli.mjs';

const real = path.resolve('/opt/pixinsight mcp/src/cli.mjs');
const metaUrl = pathToFileURL(real).href;

test('isEntryPoint matches a path containing a space', () => {
  assert.equal(isEntryPoint(metaUrl, real, (p) => p), true);
});

test('isEntryPoint follows an npm bin symlink to the real module', () => {
  const bin = path.resolve('/usr/local/bin/pixinsight-connector');
  assert.equal(isEntryPoint(metaUrl, bin, (p) => (p === bin ? real : p)), true);
});

test('isEntryPoint is false when imported by something else, or with no argv[1]', () => {
  assert.equal(isEntryPoint(metaUrl, path.resolve('/somewhere/else.mjs'), (p) => p), false);
  assert.equal(isEntryPoint(metaUrl, undefined, (p) => p), false);
  assert.equal(isEntryPoint(metaUrl, path.resolve('/missing'), () => { throw new Error('ENOENT'); }), false);
});
