import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The denylist is local-only (gitignored): listing its terms in the repo would publish them.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const denyFile = path.join(root, '.denylist');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'agentic', 'output', 'local']);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github') ? [] : files(path.join(dir, e.name));
    return e.isFile() && e.name !== '.denylist' ? [path.join(dir, e.name)] : [];
  });
}

test('no file in the repo contains a term from the local .denylist', { skip: !fs.existsSync(denyFile) && 'no local .denylist' }, () => {
  const terms = fs.readFileSync(denyFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const hits = [];
  for (const f of files(root)) {
    const text = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const term of terms) if (text.includes(term.toLowerCase())) hits.push(`${path.relative(root, f)}: "${term}"`);
  }
  assert.deepEqual(hits, []);
});
