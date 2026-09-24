// Duplicated prose rots; this test is the only reason three copies of the cross-platform rules are
// acceptable. README.md, AGENTS.md and CLAUDE.md each carry the block between the marker comments,
// and it must be identical in all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the cross-platform block is present and identical in all three files', async () => {
  const grab = async (f) => {
    const text = (await readFile(path.join(ROOT, f), 'utf8')).replace(/\r\n/g, '\n');
    const m = text.match(/<!-- crossplatform:start -->([\s\S]*?)<!-- crossplatform:end -->/);
    assert.ok(m, `${f} is missing the cross-platform block`);
    return m[1].trim();
  };
  const [readme, agents, claude] = await Promise.all(
    ['README.md', 'AGENTS.md', 'CLAUDE.md'].map(grab));
  assert.equal(agents, readme, 'AGENTS.md block drifted from README.md');
  assert.equal(claude, readme, 'CLAUDE.md block drifted from README.md');
});
