import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// src/platform.mjs (Task 2, out of this task's scope) is excluded from both scans below:
// - it legitimately defines the `/Applications/PixInsight` default root — that line IS the
//   api.platform routing mechanism every tool must go through, not a tool bypassing it;
// - its own doc comment says "see task brief for the full rationale", an incidental English
//   use of the word "brief" that the first regex would otherwise false-positive on.
// Both tests scan every other .mjs under src/, which is where the actual coupling this guards
// against (a tool reading `brief`/`store`/scoring, or hand-writing a PixInsight install path)
// would appear.
async function concatSourcesExcept(dir, exceptBasenames) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith('.mjs') && !exceptBasenames.includes(e.name)) {
      out.push(await readFile(path.join(e.parentPath, e.name), 'utf8'));
    }
  }
  return out.join('\n');
}

test('no core tool reads a brief, a store or a score', async () => {
  const src = await concatSourcesExcept('src/', ['platform.mjs']);
  assert.doesNotMatch(src, /brief|ArtifactStore|statsToScores|checkHardConstraints|jpegToContentBlock/);
});

test('every tool that wraps a stock process is declared, not hand-written', async () => {
  const src = await readFile('src/tools/processes.mjs', 'utf8');
  assert.doesNotMatch(src, /new [A-Z][A-Za-z]+;/, 'processes.mjs should declare via defineProcessTool');
});

test('no hardcoded PixInsight install path survives in src', async () => {
  assert.doesNotMatch(await concatSourcesExcept('src/', ['platform.mjs']), /\/Applications\/PixInsight/);
});

// One stats implementation: the Pack API's api.stats (src/api.mjs). Private copies drifted in what
// they returned and in how they failed.
test('no tool module keeps a private getStats copy', async () => {
  for (const e of await readdir('src/tools', { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    assert.doesNotMatch(await readFile(path.join('src/tools', e.name), 'utf8'), /function getStats\b/, e.name);
  }
});

test('readXisfHeader lives once, in the module scan_workspace actually runs', async () => {
  assert.doesNotMatch(await readFile('src/workspace.mjs', 'utf8'), /readXisfHeader/);
  assert.match(await readFile('src/tools/workspace-scan.mjs', 'utf8'), /export function readXisfHeader/);
});

// Session output goes to two folders only: the state folder (<workspace>/agentic, via
// api.workspace.scratchDir) and <workspace>/output. This pins every write site in the core tools.
// A new one must write under api.workspace.scratchDir, or be held to the two folders the way
// export_image is (resolveExportPath); add it here only after checking which.
const WRITE_SITE = /\bsaveAs\(|\bwriteFile(?:Sync)?\(|\bwriteText\w*\(|\boutputDirectory\s*=|\bmkdir(?:Sync)?\(|\brmSync\(|\bunlinkSync\(|\bcopyFile(?:Sync)?\(|\brename(?:Sync)?\(|\bcreateWriteStream\(|\bappendFile(?:Sync)?\(|\bFile\.(?:write|create|copy|move|remove)\w*\(/g;
const EXPECTED_WRITE_SITES = {
  'astrometry.mjs': ['File.createDirectory('], // run_plate_solve: scratchDir/tmp_platesolve (ImageSolver's star lists)
  'channels.mjs': ['mkdirSync(', 'File.remove(', 'saveAs(', 'outputDirectory ='], // align_to_reference: scratchDir/tmp_align
  'images.mjs': ['mkdirSync(', 'File.remove(', 'saveAs('], // export_image: resolveExportPath's file
  'preview.mjs': ['mkdirSync(', 'rmSync(', 'File.remove(', 'saveAs('], // save_preview: scratchDir/previews
};

test('core tools write only under api.workspace.scratchDir, except export_image held to output/ and the state folder', async () => {
  const found = {};
  for (const e of await readdir('src/tools', { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const sites = (await readFile(path.join('src/tools', e.name), 'utf8')).match(WRITE_SITE);
    if (sites) found[e.name] = sites;
  }
  assert.deepEqual(found, EXPECTED_WRITE_SITES);

  const channels = await readFile('src/tools/channels.mjs', 'utf8');
  assert.match(channels, /const tmpDir = path\.join\(api\.workspace\.scratchDir, 'tmp_align'\);/);
  const astrometry = await readFile('src/tools/astrometry.mjs', 'utf8');
  assert.match(astrometry, /starsDir: toPixPath\(api\.workspace\.scratchDir\) \+ '\/tmp_platesolve',/);
  const preview = await readFile('src/tools/preview.mjs', 'utf8');
  assert.match(preview, /const previewDir = path\.join\(api\.workspace\.scratchDir, 'previews'\);/);
  const images = await readFile('src/tools/images.mjs', 'utf8');
  assert.match(images, /const file = resolved\.path;\n\s*fs\.mkdirSync\(path\.dirname\(file\), \{ recursive: true \}\);/);
  assert.equal(images.match(/saveAs\(\$\{q\(toPixPath\(file\)\)\}/g)?.length, 1, 'export_image saves to the resolved file');
});
