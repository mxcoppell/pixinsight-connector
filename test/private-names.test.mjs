// The maintainer's processing skills live in a private repository. Nothing tracked here may name that
// repository or its skills, so the public connector never points at, or describes, private technique.
// The names are kept only as SHA-256 hashes of their lowercased letters and digits, so this file does
// not itself reveal them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
const PRIVATE = [
  { len: 12, sha256: '76a166d67e11cee148bcf1ae6e6366637d6731a89a335488a33141b1140bdf9f' },
  { len: 21, sha256: '332f831f97df5169f901766caff1450a311e7fbad49618aceb4adb6e32a689cb' },
  { len: 20, sha256: '9e8c2be4b9d538731fdcf998f6142fb4eed786d6fe55df6499f617f63697ec40' },
  { len: 12, sha256: '7de4d9215500c736405095de8a6424504c50e8b0a851a31c164d6dd95615133e' },
  { len: 16, sha256: '244face7e3ede5ee9ba5acf6bd211485237871dbc28194b48521a4ce878e4559' },
];
const sha = (s) => createHash('sha256').update(s).digest('hex');

// From the start of every word: the letters and digits that follow, with '-', '_', ' ' and '.' between
// them dropped (so "a-b", "a_b", "a b" and "ab" read the same), stopping at any other character.
function hits(text, list = PRIVATE) {
  const t = text.toLowerCase(), found = new Set(), max = Math.max(...list.map((p) => p.len));
  const alnum = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
  for (let i = 0; i < t.length; i++) {
    if (!alnum(t[i]) || (i > 0 && alnum(t[i - 1]))) continue;
    let s = '';
    for (let j = i; j < t.length && s.length < max; j++) {
      const c = t[j];
      if (alnum(c)) s += c;
      else if (!'-_ .'.includes(c)) break;
    }
    for (const p of list) if (s.length >= p.len && sha(s.slice(0, p.len)) === p.sha256) found.add(p.sha256.slice(0, 8));
  }
  return [...found];
}

test('the matcher finds a hashed name in any separator style, only from the start of a word', () => {
  const list = [{ len: 8, sha256: sha('alphabet') }];
  for (const s of ['alphabet', 'Alpha-Bet', 'alpha_bet soup', 'see alpha bet.', '(alpha.bet)']) assert.equal(hits(s, list).length, 1, s);
  for (const s of ['xalphabet', 'alpha/bet', 'alphab', 'alpha, bet']) assert.equal(hits(s, list).length, 0, s);
});

test('no tracked file names the private skills repository or its skills', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && f !== SELF);
  const found = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const h of hits(text)) found.push(`${f}: name ${h}`);
  }
  assert.deepEqual(found, []);
});
