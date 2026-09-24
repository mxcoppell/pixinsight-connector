// The maintainer's processing skills live in a private repository. Nothing tracked here may name that
// repository or its skills, so the public connector never points at, or describes, private technique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
// Built from parts so this file does not itself contain the names it guards against.
const PRIVATE = [
  ['agentic', 'skill'], ['pixinsight', 'interactive'], ['pixinsight', 'lrgb', 'linear'], ['tool', 'values.md'], ['ic410', 'calibration'],
].map((parts) => new RegExp(parts.join('[-_ ]?').replace('.', '\\.'), 'i'));

test('no tracked file names the private skills repository or its skills', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && f !== SELF);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const re of PRIVATE) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
