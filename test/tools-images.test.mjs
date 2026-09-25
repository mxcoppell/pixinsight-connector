import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools, resolveExportPath } from '../src/tools/images.mjs';
import { toPixPath } from '../src/platform.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const imageDir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-open-'));
function imageFile(name) {
  const file = path.join(imageDir, name);
  fs.writeFileSync(file, '');
  return file;
}

test('images.mjs exports the 10 image lifecycle tools', () => {
  assert.deepEqual(
    Object.keys(byName).sort(),
    ['clone_image', 'close_image', 'crop_image', 'export_image', 'get_image_dimensions',
      'get_image_stats', 'list_open_images', 'open_image', 'rename_view', 'restore_from_clone'].sort()
  );
});

test('open_image opens the file and reports the new view id', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['NGC891_L'] });
  ctx.listImages = async () => [{ id: 'NGC891_L', width: 100, height: 100, isColor: false }];
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: imageFile('NGC891_L.xisf') });
  assert.match(emitted[0], /ImageWindow\.open/);
  assert.match(out.text, /NGC891_L/);
});

test('close_image closes the window by id', async () => {
  const { ctx, emitted } = createFakeBridge();
  await byName.close_image.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(emitted[0], /windowById\("RGB"\)/);
  assert.match(emitted[0], /forceClose/);
});

test('list_open_images returns whatever listImages reports', async () => {
  const { ctx } = createFakeBridge();
  ctx.listImages = async () => [{ id: 'RGB', width: 10, height: 10 }];
  const out = await byName.list_open_images.handler(apiFrom(ctx), {});
  assert.match(out.text, /"id": "RGB"/);
});

test('rename_view emits a mainView.id assignment', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.rename_view.handler(apiFrom(ctx), { old_id: 'long_name', new_id: 'L' });
  assert.match(emitted[0], /mainView\.id = "L"/);
});

test('clone_image queries dimensions then creates the clone window', async () => {
  const { ctx, emitted } = createFakeBridge({
    replies: [JSON.stringify({ w: 100, h: 100, ch: 3, color: true }), 'OK'],
  });
  await byName.clone_image.handler(apiFrom(ctx), { source_id: 'RGB', clone_id: 'RGB_backup' });
  assert.match(emitted[1], /new ImageWindow\(100, 100, 3, 32, true, true, "RGB_backup"\)/);
});

test('restore_from_clone assigns the clone image back onto the target', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['OK'] });
  await byName.restore_from_clone.handler(apiFrom(ctx), { target_id: 'RGB', clone_id: 'RGB_backup' });
  assert.match(emitted[0], /image\.assign\(clone\.mainView\.image\)/);
});

test('crop_image emits a Crop with negated margins for the requested edges', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['100x100'] });
  await byName.crop_image.handler(apiFrom(ctx), { view_id: 'RGB', left: 10, top: 5 });
  assert.match(emitted[0], /new Crop/);
  assert.match(emitted[0], /leftMargin = -10/);
  assert.match(emitted[0], /topMargin = -5/);
});

test('get_image_dimensions reports one entry per requested view', async () => {
  const { ctx } = createFakeBridge({ replies: ['[{"id":"RGB","width":10,"height":10,"channels":3,"isColor":true}]'] });
  const out = await byName.get_image_dimensions.handler(apiFrom(ctx), { view_ids: ['RGB'] });
  assert.match(out.text, /"id":"RGB"/);
});

test('get_image_stats returns the parsed stats object', async () => {
  const { ctx } = createFakeBridge({ replies: [JSON.stringify({ median: 0.1, mad: 0.01 })] });
  const out = await byName.get_image_stats.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(out.text, /"median": 0.1/);
});

// A real temp workspace: export_image creates the parent folder on disk before PixInsight runs.
function tempWorkspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'agentic');
  return { dir, stateDir, outputDir: path.join(dir, 'output'), workspace: { dir, scratchDir: path.join(stateDir, 'scratch'), outputDir: path.join(dir, 'output') } };
}

test('export_image resolves a relative file_path under <workspace>/output and creates the folder', async (t) => {
  const ws = tempWorkspace(t);
  const { ctx, emitted } = createFakeBridge({ replies: ['1048576'] });
  const out = await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path: path.join('final', 'm31.tif') });
  const target = path.join(ws.outputDir, 'final', 'm31.tif');
  assert.equal(out.isError, undefined, out.text);
  assert.ok(existsSync(path.dirname(target)), 'the parent folder exists before PixInsight writes');
  assert.ok(emitted[0].includes(JSON.stringify(toPixPath(target))), emitted[0]);
  assert.ok(out.text.includes(target), out.text);
});

test('export_image carries keywords, the astrometric solution and view properties into the saved copy', async (t) => {
  const ws = tempWorkspace(t);
  const { ctx, emitted } = createFakeBridge({ replies: ['10'] });
  await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path: 'stage.xisf' });
  const js = emitted[0], save = js.indexOf('c.saveAs(');
  for (const step of ['c.keywords = __w.keywords', 'c.copyAstrometricSolution(__w)', 'c.mainView.setPropertyValue(']) {
    assert.ok(js.indexOf(step) > 0 && js.indexOf(step) < save, `${step} before saveAs`);
  }
});

test('export_image accepts an absolute path inside <workspace>/output or the state folder', async (t) => {
  const ws = tempWorkspace(t);
  for (const target of [path.join(ws.outputDir, 'a.png'), path.join(ws.stateDir, 'scratch', 'b.png')]) {
    const { ctx, emitted } = createFakeBridge({ replies: ['10'] });
    const out = await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path: target });
    assert.equal(out.isError, undefined, out.text);
    assert.ok(emitted[0].includes(JSON.stringify(toPixPath(target))), target);
  }
});

test('export_image refuses a path outside the two folders, names both, and writes nothing', async (t) => {
  const ws = tempWorkspace(t);
  const outside = [
    path.join(ws.dir, 'elsewhere.png'), // the workspace root itself
    path.join(ws.dir, 'output-old', 'x.png'), // a sibling sharing the prefix
    [ws.outputDir, '..', 'x.png'].join(path.sep), // an absolute path that climbs out (join() would normalize it away)
    path.join('..', 'x.png'), // a relative one
    path.join('..', '..', 'x.png'),
    path.resolve(tmpdir(), 'x.png'),
  ];
  for (const file_path of outside) {
    const { ctx, emitted } = createFakeBridge();
    const out = await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path });
    assert.equal(out.isError, true, file_path);
    assert.ok(out.text.includes(ws.outputDir) && out.text.includes(ws.stateDir), out.text);
    assert.equal(emitted.length, 0, `${file_path}: nothing reached PixInsight`);
  }
  assert.ok(!existsSync(path.join(ws.dir, 'output-old')));
});

// Case: folded on win32 only. On darwin (a volume may be case-sensitive) and linux the real paths
// decide: the native realpath gives a case-insensitive volume's on-disk case (injected here).
test('resolveExportPath folds case on win32, and elsewhere lets the real paths decide', () => {
  const posix = { outputDir: '/w/output', stateDir: '/w/agentic' };
  const exists = new Set(['/', '/w', '/w/output', '/w/agentic']);
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const insensitive = { realpathSync: (p) => (exists.has(p.toLowerCase()) ? p.toLowerCase() : enoent()) };
  const sensitive = { realpathSync: (p) => (exists.has(p) ? p : enoent()) };
  assert.equal(resolveExportPath('/W/Output/x.png', posix, 'darwin', insensitive).path, '/W/Output/x.png');
  assert.match(resolveExportPath('/W/Output/x.png', posix, 'darwin', sensitive).error, /must be inside/, 'OUTPUT beside output on a case-sensitive volume');
  assert.match(resolveExportPath('/W/Output/x.png', posix, 'linux', sensitive).error, /\/w\/output/);
  assert.equal(resolveExportPath('x.png', posix, 'linux').path, '/w/output/x.png');
  assert.match(resolveExportPath('/w/agentic-x/y.png', posix, 'linux').error, /must be inside/);

  const win = { outputDir: 'C:\\ws\\output', stateDir: 'C:\\ws\\agentic' };
  assert.equal(resolveExportPath('c:\\WS\\Output\\x.png', win, 'win32').path, 'c:\\WS\\Output\\x.png');
  assert.equal(resolveExportPath('C:/ws/agentic/scratch/x.png', win, 'win32').path, 'C:\\ws\\agentic\\scratch\\x.png');
  assert.equal(resolveExportPath('sub\\x.png', win, 'win32').path, 'C:\\ws\\output\\sub\\x.png');
  assert.match(resolveExportPath('D:\\ws\\output\\x.png', win, 'win32').error, /must be inside/);
  assert.match(resolveExportPath('..\\x.png', win, 'win32').error, /must be inside/);
});

// A link inside output/ that points outside the workspace: the lexical check passes, the real path
// does not. Nothing is created at the far end and nothing reaches PixInsight.
test('export_image refuses a path that leaves the two folders through a link, and creates nothing there', async (t) => {
  const ws = tempWorkspace(t);
  const far = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-far-'));
  t.after(() => rmSync(far, { recursive: true, force: true }));
  mkdirSync(ws.outputDir);
  symlinkSync(far, path.join(ws.outputDir, 'link'), 'junction'); // junction: no privilege needed on Windows
  for (const file_path of [path.join('link', 'x.tif'), path.join('link', 'sub', 'x.tif'), path.join(ws.outputDir, 'link', 'y.tif')]) {
    const { ctx, emitted } = createFakeBridge({ replies: ['10'] });
    const out = await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path });
    assert.equal(out.isError, true, `${file_path}: ${out.text}`);
    assert.match(out.text, /must be inside/);
    assert.ok(out.text.includes(realpathSync.native(far)), out.text);
    assert.equal(emitted.length, 0, `${file_path}: nothing reached PixInsight`);
  }
  assert.deepEqual(readdirSync(far), [], 'nothing created at the far end');
});

test('export_image refuses an unsupported extension', async () => {
  const { ctx } = createFakeBridge();
  const out = await byName.export_image.handler(apiFrom(ctx), { view_id: 'RGB', file_path: 'out.bmp' });
  assert.match(out.text, /Unsupported extension/);
});

test('export_image writes the file and reports size and bit depth', async (t) => {
  const ws = tempWorkspace(t);
  const { ctx, emitted } = createFakeBridge({ replies: ['1048576'] });
  const out = await byName.export_image.handler(apiFrom(ctx, { workspace: ws.workspace }), { view_id: 'RGB', file_path: 'out.tif' });
  assert.match(emitted[0], /SampleFormatConversion\.To16Bit/);
  assert.match(out.text, /1\.0 MB, 16-bit/);
});

test('open_image reports the id ImageWindow.open returned, not a guess from the view list', async () => {
  const { ctx } = createFakeBridge({ replies: ['NGC891_L'] });
  let call = 0;
  // Another view appears between the two listings too; it must not be reported as the one opened.
  ctx.listImages = async () => (call++ === 0 ? [] : [{ id: 'Other' }, { id: 'NGC891_L' }]);
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: imageFile('NGC891_L.xisf') });
  assert.match(out.text, /^Opened as view id "NGC891_L"\./);
});

test('open_image reports a failed open as an error', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'Failed to open image' } }] });
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: imageFile('x.xisf') });
  assert.equal(out.isError, true);
});

test('open_image answers a missing file itself, listing the image files in that folder', async () => {
  const { ctx, emitted } = createFakeBridge();
  const dir = path.dirname(imageFile('TargetA_Lum.xisf'));
  imageFile('TargetA_Red.xisf');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: path.join(dir, 'TargetA_Lum L.xisf') });
  assert.equal(out.isError, true);
  assert.match(out.text, /^File not found: .*TargetA_Lum L\.xisf\. Image files in .*: .*TargetA_Lum\.xisf, TargetA_Red\.xisf/);
  assert.doesNotMatch(out.text, /notes\.txt/);
  assert.equal(emitted.length, 0);
});

test('open_image refuses a relative path without calling PixInsight', async () => {
  const { ctx, emitted } = createFakeBridge();
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: 'TargetA_Lum.xisf' });
  assert.equal(out.isError, true);
  assert.match(out.text, /absolute path/);
  assert.equal(emitted.length, 0);
});

test('open_image names a folder that does not exist', async () => {
  const { ctx, emitted } = createFakeBridge();
  const out = await byName.open_image.handler(apiFrom(ctx), { file_path: path.join(os.tmpdir(), 'no-such-dir-pixinsight-connector', 'a.xisf') });
  assert.match(out.text, /does not exist or cannot be read/);
  assert.equal(emitted.length, 0);
});

test('export_image refusals are errors', async () => {
  const { ctx } = createFakeBridge();
  for (const input of [{ view_id: 'RGB', file_path: path.resolve('/elsewhere/x.png') }, { view_id: 'RGB', file_path: 'x.bmp' }, { view_id: 'RGB', file_path: 'x.png', bits: 12 }]) {
    const out = await byName.export_image.handler(apiFrom(ctx), input);
    assert.equal(out.isError, true, JSON.stringify(input));
  }
});

test('open_image closes only the crop_mask views that came with the file, never one the user had open', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['NGC891'] });
  let call = 0;
  ctx.listImages = async () => (call++ === 0
    ? [{ id: 'mine_crop_mask' }]
    : [{ id: 'mine_crop_mask' }, { id: 'NGC891' }, { id: 'NGC891_crop_mask' }]);
  await byName.open_image.handler(apiFrom(ctx), { file_path: imageFile('NGC891.xisf') });
  const closes = emitted.filter((c) => /forceClose/.test(c));
  assert.equal(closes.length, 1);
  assert.match(closes[0], /windowById\("NGC891_crop_mask"\)/);
});

test('open_image hands PixInsight the path as toPixPath writes it (forward slashes on Windows)', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['M31'] });
  const file = imageFile('M31.xisf');
  await byName.open_image.handler(apiFrom(ctx), { file_path: file });
  assert.ok(emitted[0].includes(JSON.stringify(toPixPath(file))), emitted[0]);
  assert.equal(toPixPath('C:\\data\\M31.xisf'), 'C:/data/M31.xisf');
});
