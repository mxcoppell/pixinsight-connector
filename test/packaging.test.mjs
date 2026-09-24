// Packaging gate: the published package holds the connector and nothing else. `npm pack --dry-run`
// may list only the .mjs modules under src/, pjsr/watcher.template.js, README.md, LICENSE and
// package.json. No test, plan, stray script or local/ file may ever ship. And, the other direction,
// every module the connector needs (every .mjs under src/, the watcher template) must ship, so the
// `files` allowlist in package.json cannot silently drop one.
//
// npm is run without a shell: `node <npm-cli.js> pack`. On Windows `npm` is `npm.cmd`, which
// child_process cannot spawn without a shell, so the npm CLI script is located and run with the
// current Node instead. That works the same on every OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_FILES = new Set(['README.md', 'LICENSE', 'package.json']);
const WATCHER_TEMPLATE = 'pjsr/watcher.template.js';
const isShippable = (f) => ALLOWED_FILES.has(f) || f === WATCHER_TEMPLATE || /^src\/.+\.mjs$/.test(f);

// The npm CLI entry script, by existence rather than by branching on the OS:
//   1. the one running this test (`npm test` sets npm_execpath);
//   2. the npm bundled beside this Node: <node dir>/node_modules/npm (Windows) or
//      <prefix>/lib/node_modules/npm with prefix = parent of bin/ (elsewhere);
//   3. the npm on PATH: a `npm` symlink to npm-cli.js (POSIX), or the same two layouts relative to
//      each PATH directory (Homebrew keeps npm in <prefix>/lib even though node itself resolves
//      into its Cellar; Windows keeps npm.cmd beside node_modules/npm).
export function npmCliCandidates({ env = process.env, execPath = process.execPath, realpath = realpathSync } = {}) {
  const out = [];
  if (env.npm_execpath && /npm-cli\.c?js$/.test(env.npm_execpath)) out.push(env.npm_execpath);
  const layouts = (dir) => [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const bins = [execPath];
  try {
    bins.push(realpath(execPath));
  } catch {
    // keep the unresolved path only
  }
  for (const bin of bins) out.push(...layouts(path.dirname(bin)));
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      const target = realpath(path.join(dir, 'npm'));
      if (/npm-cli\.c?js$/.test(target)) out.push(target);
    } catch {
      // no `npm` here, or not a link
    }
    out.push(...layouts(dir));
  }
  return [...new Set(out)];
}

let packed; // memoized: one `npm pack` per test file
function packedFiles() {
  if (packed) return packed;
  const cli = npmCliCandidates().find((p) => existsSync(p));
  assert.ok(cli, `cannot find the npm CLI script; looked at:\n${npmCliCandidates().join('\n')}`);
  const r = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(r.status, 0, `npm pack --dry-run failed:\n${r.stderr}`);
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  packed = json[0].files.map((f) => f.path.split('\\').join('/')).sort();
  return packed;
}

test('npm pack ships only src/**/*.mjs, pjsr/watcher.template.js, README.md, LICENSE and package.json', () => {
  const stray = packedFiles().filter((f) => !isShippable(f));
  assert.deepEqual(stray, [], `files that must not ship: ${stray.join(', ')}`);
});

test('npm pack ships every .mjs module under src/, the watcher template and the three root files', async () => {
  const files = new Set(packedFiles());
  const entries = await readdir(path.join(ROOT, 'src'), { withFileTypes: true, recursive: true });
  const modules = entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  const missing = [...modules, WATCHER_TEMPLATE, ...ALLOWED_FILES].filter((f) => !files.has(f));
  assert.deepEqual(missing, [], `files the connector needs but the package leaves out: ${missing.join(', ')}`);
});

test('npmCliCandidates prefers npm_execpath, then the npm beside node, then the npm on PATH, for every install layout', () => {
  const win = npmCliCandidates({ env: {}, execPath: path.join('C:', 'node', 'node.exe'), realpath: (p) => p });
  assert.ok(win.includes(path.join('C:', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  const posix = npmCliCandidates({ env: {}, execPath: path.join('usr', 'local', 'bin', 'node'), realpath: (p) => p });
  assert.ok(posix.includes(path.join('usr', 'local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  const viaNpm = npmCliCandidates({ env: { npm_execpath: path.join('x', 'npm-cli.js') }, execPath: 'node', realpath: (p) => p });
  assert.equal(viaNpm[0], path.join('x', 'npm-cli.js'));
  const notNpm = npmCliCandidates({ env: { npm_execpath: path.join('x', 'pnpm.cjs') }, execPath: 'node', realpath: (p) => p });
  assert.notEqual(notNpm[0], path.join('x', 'pnpm.cjs'));
  const onPath = npmCliCandidates({
    env: { PATH: path.join('opt', 'brew', 'bin') },
    execPath: path.join('opt', 'brew', 'Cellar', 'node', 'bin', 'node'),
    realpath: (p) => (p === path.join('opt', 'brew', 'bin', 'npm') ? path.join('opt', 'brew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') : p),
  });
  assert.ok(onPath.includes(path.join('opt', 'brew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
});
