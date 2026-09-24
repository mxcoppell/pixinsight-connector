// AGENTS.md (Codex and most harnesses) and CLAUDE.md (Claude Code) carry the same instructions, so an
// agent on any harness gets every rule. Everything between the marker comments must be identical in
// both; only the opening line naming the harness may differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sharedBlock(file) {
  const text = (await readFile(path.join(ROOT, file), 'utf8')).replace(/\r\n/g, '\n');
  const m = text.match(/<!-- agent-instructions:start -->\n([\s\S]*?)<!-- agent-instructions:end -->/);
  assert.ok(m, `${file} is missing the agent-instructions block`);
  return { text, block: m[1].trim() };
}

test('AGENTS.md and CLAUDE.md carry the same agent instructions', async () => {
  const [agents, claude] = await Promise.all(['AGENTS.md', 'CLAUDE.md'].map(sharedBlock));
  assert.equal(claude.block, agents.block, 'the agent-instructions block drifted between AGENTS.md and CLAUDE.md');
  for (const { text, block } of [agents, claude]) {
    const outside = text.replace(block, '').split('\n').filter((l) => /^#{2,}\s/.test(l));
    assert.deepEqual(outside, [], 'every section heading belongs inside the shared block');
  }
});
