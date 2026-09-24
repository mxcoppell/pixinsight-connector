// A file nobody imports is a bug, not a leftover. Walks the import graph from src/cli.mjs (the
// package's bin) and asserts every .mjs module under src/ is reachable.
//
// Edges are the relative specifiers of static `import ... from`, side-effect `import '...'`,
// `export ... from`, and literal dynamic `import('...')`. One edge is not visible in any import
// statement: src/tools/index.mjs imports every other src/tools/*.mjs by scanning its own directory
// (that scan is the catalog's "no registry" seam), so reaching index.mjs reaches all of them. A test
// below pins that premise, so this gate cannot silently go blind if the scan is ever removed.
// The graph only sees .mjs files, so a last test asserts src/ holds nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ENTRY = path.join(SRC, 'cli.mjs');
const TOOLS_INDEX = path.join(SRC, 'tools', 'index.mjs');
const DIRECTORY_SCANS = new Map([[TOOLS_INDEX, path.join(SRC, 'tools')]]);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

async function mjsUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

// Relative import specifiers in one module's source. Whole-line comments are dropped first so a
// commented-out import does not count as an edge.
export function importSpecifiers(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const patterns = [
    /\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const specs = new Set();
  for (const re of patterns) for (const m of code.matchAll(re)) specs.add(m[1]);
  return [...specs].filter((s) => s.startsWith('./') || s.startsWith('../'));
}

async function reachableFrom(entry) {
  const seen = new Set();
  const dangling = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const next = importSpecifiers(await readFile(file, 'utf8')).map((s) => path.resolve(path.dirname(file), s));
    if (DIRECTORY_SCANS.has(file)) next.push(...(await mjsUnder(DIRECTORY_SCANS.get(file))).filter((f) => path.dirname(f) === DIRECTORY_SCANS.get(file)));
    for (const target of next) {
      if (!target.endsWith('.mjs')) continue;
      if (!existsSync(target)) dangling.push(`${rel(file)} -> ${rel(target)}`);
      else if (target.startsWith(SRC + path.sep)) queue.push(target);
    }
  }
  return { seen, dangling };
}

test('every .mjs module under src/ is reachable from src/cli.mjs', async () => {
  const { seen } = await reachableFrom(ENTRY);
  const unreachable = (await mjsUnder(SRC)).filter((f) => !seen.has(f)).map(rel);
  assert.deepEqual(unreachable, [], `unreachable modules under src/ (import them, or delete them): ${unreachable.join(', ')}`);
});

test('no import under src/ points at a module that does not exist', async () => {
  const { dangling } = await reachableFrom(ENTRY);
  assert.deepEqual(dangling, []);
});

test('src/ holds only .mjs modules, so the import graph above sees every file in it', async () => {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  const other = entries.filter((e) => e.isFile() && !e.name.endsWith('.mjs')).map((e) => rel(path.join(e.parentPath, e.name)));
  assert.deepEqual(other, [], `files under src/ that are not .mjs modules: ${other.join(', ')}`);
});

test('the directory-scan edge is real: src/tools/index.mjs still imports its directory by scanning it', async () => {
  const source = await readFile(TOOLS_INDEX, 'utf8');
  assert.match(source, /readdir\(\s*TOOLS_DIR/, 'src/tools/index.mjs no longer scans its directory; update DIRECTORY_SCANS in this test');
  assert.match(source, /await import\(/, 'src/tools/index.mjs no longer imports the modules it scans');
});

test('importSpecifiers finds static, side-effect, re-export and dynamic imports and skips comments', () => {
  const src = [
    "import a from './a.mjs';",
    "import {\n  b,\n  c,\n} from '../b.mjs';",
    "import './side.mjs';",
    "export { d } from './d.mjs';",
    "export * from './e.mjs';",
    "const f = await import('./f.mjs');",
    "// import g from './g.mjs';",
    "/* import h from './h.mjs'; */",
    "import fs from 'node:fs';",
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(src).sort(), ['../b.mjs', './a.mjs', './d.mjs', './e.mjs', './f.mjs', './side.mjs']);
});
