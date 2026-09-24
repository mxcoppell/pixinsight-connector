// The original project's author is credited in exactly two places: LICENSE (the MIT notice his code
// still requires) and the README's credit section. No other tracked file names him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
const ALLOWED = new Set(['LICENSE', 'README.md']);
// Built from parts so this file does not itself contain the names it guards against.
const NAMES = [['Ala', 'in'], ['Escaf', 'fre'], ['aescaf', 'fre']].map((p) => new RegExp(`\\b${p.join('')}\\b`, 'i'));

test('the original author is named only in LICENSE and the README credit', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => f && f !== SELF && !ALLOWED.has(f));
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const re of NAMES) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('LICENSE keeps the original MIT notice alongside the current owner', () => {
  const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /^Copyright \(c\) \d{4} Min Xie$/m);
  assert.match(license, new RegExp(`^Portions copyright \\(c\\) \\d{4} ${NAMES[0].source.slice(2, -2)} ${NAMES[1].source.slice(2, -2)}`, 'm'));
});
