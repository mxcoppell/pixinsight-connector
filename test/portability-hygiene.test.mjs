// Source-level guards against the path/URL mistakes that only break on Windows (or on a path with
// a space in it), which the macOS/Linux legs of CI would otherwise never notice:
//
// - `new URL(import.meta.url).pathname` yields `/D:/a/...` on Windows (path.join turns that into
//   `D:\D:\a\...`) and keeps spaces percent-encoded (`%20`) on every OS. Use fileURLToPath().
// - `import(path.join(...))` hands Node a bare path; on Windows `D:\...` is parsed as a URL with
//   scheme `d:` and rejected. Dynamic imports of files go through pathToFileURL(...).href.
// - `` `file://${somePath}` `` is not a file URL on Windows (backslashes, no third slash) nor for a
//   path containing a space. Compare/convert with pathToFileURL()/fileURLToPath().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SELF = 'portability-hygiene.test.mjs';

async function sources(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs') || e.name === SELF) continue;
    const file = path.join(e.parentPath, e.name);
    try {
      out.push({ file, text: await readFile(file, 'utf8') });
    } catch (err) {
      // A concurrently-running test may create and remove a temp module under src/.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return out;
}

const BAD = [
  [/new URL\([^)]*\)\.pathname/, 'use fileURLToPath() instead of URL#pathname'],
  [/import\(\s*path\./, 'dynamic import() of a filesystem path needs pathToFileURL(...).href'],
  [/`file:\/\/\$\{/, 'build file URLs with pathToFileURL(), not string concatenation'],
];

test('no Windows-unsafe URL/path conversions in src/ or test/', async () => {
  const offenders = [];
  for (const { file, text } of [...(await sources('src')), ...(await sources('test'))]) {
    for (const [re, why] of BAD) if (re.test(text)) offenders.push(`${file}: ${why}`);
  }
  assert.deepEqual(offenders, []);
});
