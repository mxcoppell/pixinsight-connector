// ============================================================================
// Image lifecycle: open, close, list, rename, clone/restore, crop, dimensions,
// stats, export. Ported from v0-pipeline:agents/llm/tools.mjs and v0-pipeline:agents/llm/tools-essential.mjs.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { toPixPath } from '../platform.mjs';
import { isInside, realPathOf } from '../workspace.mjs';

const q = (s) => JSON.stringify(String(s));

// A number interpolated bare into PJSR cannot be quoted like a string, so its actual runtime
// type is validated instead of trusted from the JSON Schema alone.
function num(value, fallback) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

// Native PixInsight processes throw odd values under V8; rethrow a real Error with a message.
function guard(body) {
  return `(function(){ try {
  function __run(P, v) { if (!P.executeOn(v)) throw new Error('the process did not run (see console message)'); }
  ${body}
} catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`;
}

function need(id) {
  return `var __w = ImageWindow.windowById(${q(id)}); if (__w.isNull) throw new Error('View not found: ' + ${q(id)});`;
}

async function run(api, body) {
  const r = await api.pjsr(guard(body));
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return r.result;
}

const IMAGE_FILE_RE = /\.(xisf|fits?|fts|tiff?|png|jpe?g)$/i;

// Checked here rather than in PixInsight, so a wrong path is answered with what the folder does hold
// and never reaches the Process Console as a script error.
function missingImageFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return `file_path must be an absolute path: ${JSON.stringify(file)}`;
  if (fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => IMAGE_FILE_RE.test(n)).sort();
  } catch {
    return `File not found: ${file} (the folder ${dir} does not exist or cannot be read)`;
  }
  if (!names.length) return `File not found: ${file} (no image files in ${dir})`;
  const shown = names.slice(0, 40).join(', ') + (names.length > 40 ? `, and ${names.length - 40} more` : '');
  return `File not found: ${file}. Image files in ${dir}: ${shown}`;
}

const openImage = {
  name: 'open_image',
  description: 'Open an XISF/FITS image file in PixInsight. Returns the view ID assigned by PixInsight. Automatically closes any crop_mask windows that come with XISF files.',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Absolute path to the image file' } },
    required: ['file_path'],
  },
  async handler(api, input) {
    const missing = missingImageFile(input.file_path);
    if (missing) return { isError: true, text: missing };
    const beforeIds = (await api.listImages()).map((i) => i.id);
    const r = await api.pjsr(`
      var __p = ${q(toPixPath(input.file_path))};
      if (!File.exists(__p)) throw new Error('File not found: ' + __p);
      var __wins = ImageWindow.open(__p);
      if (__wins.length === 0) throw new Error('Failed to open image: ' + __p);
      __wins[0].show();
      __wins[0].mainView.id;
    `);
    if (r.status === 'error') return { isError: true, text: `Failed to open: ${r.error?.message ?? JSON.stringify(r.error)}` };
    // The id ImageWindow.open gave the image, as the snippet returned it -- not a guess from
    // whatever else appeared meanwhile.
    const openedId = String(r.result ?? '').trim();
    // Close the crop masks this file brought along, and only those: a crop_mask view the user
    // already had open is not ours to close.
    const imgs = await api.listImages();
    for (const cm of imgs.filter((i) => !beforeIds.includes(i.id) && i.id.includes('crop_mask'))) {
      await run(api, `var w=ImageWindow.windowById(${q(cm.id)});if(!w.isNull)w.forceClose();`);
    }
    const after = await api.listImages();
    const summary = after.map((i) => `${i.id}: ${i.width}x${i.height} color=${i.isColor}`).join('\n');
    if (!openedId) return { isError: true, text: `Opened ${input.file_path}, but PixInsight reported no view id.\nCurrent images:\n${summary}` };
    return { text: `Opened as view id "${openedId}".\nCurrent images:\n${summary}` };
  },
};

const closeImage = {
  name: 'close_image',
  description: 'Close an image window to free memory.',
  inputSchema: {
    type: 'object',
    properties: { view_id: { type: 'string', description: 'View ID to close' } },
    required: ['view_id'],
  },
  async handler(api, input) {
    await run(api, `var w = ImageWindow.windowById(${q(input.view_id)}); if (!w.isNull) w.forceClose();`);
    return { text: `Closed ${input.view_id}` };
  },
};

const listOpenImages = {
  name: 'list_open_images',
  description: 'List all currently open images in PixInsight with their dimensions and color status.',
  inputSchema: { type: 'object', properties: {} },
  async handler(api, _input) {
    const imgs = await api.listImages();
    return { text: JSON.stringify(imgs, null, 2) };
  },
};

const renameView = {
  name: 'rename_view',
  description: 'Rename an image view to a different view ID. Long XISF names can cause some PixInsight processes to fail.',
  inputSchema: {
    type: 'object',
    properties: {
      old_id: { type: 'string', description: 'Current view ID' },
      new_id: { type: 'string', description: 'New view ID (no spaces)' },
    },
    required: ['old_id', 'new_id'],
  },
  async handler(api, input) {
    const r = await api.pjsr(
      `var w = ImageWindow.windowById(${q(input.old_id)}); if (!w.isNull) w.mainView.id = ${q(input.new_id)}; else throw new Error('View not found: ' + ${q(input.old_id)});`
    );
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    return { text: `Renamed ${input.old_id} → ${input.new_id}` };
  },
};

const cloneImage = {
  name: 'clone_image',
  description: 'Clone an image to a backup view, which can be restored from later with restore_from_clone.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source view ID' },
      clone_id: { type: 'string', description: 'Name for the clone' },
    },
    required: ['source_id', 'clone_id'],
  },
  async handler(api, input) {
    const dimR = await api.pjsr(`
      var srcW = ImageWindow.windowById(${q(input.source_id)});
      if (srcW.isNull) throw new Error('Clone source not found: ' + ${q(input.source_id)});
      var img = srcW.mainView.image;
      JSON.stringify({ w: img.width, h: img.height, ch: img.numberOfChannels, color: img.isColor });
    `);
    if (dimR.status === 'error') throw new Error('clone_image: ' + dimR.error.message);
    const d = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
    const r = await api.pjsr(`
      var old = ImageWindow.windowById(${q(input.clone_id)});
      if (!old.isNull) old.forceClose();
      var srcW = ImageWindow.windowById(${q(input.source_id)});
      var clone = new ImageWindow(${d.w || 0}, ${d.h || 0}, ${d.ch || 3}, 32, true, ${d.color !== false}, ${q(input.clone_id)});
      clone.mainView.beginProcess();
      clone.mainView.image.assign(srcW.mainView.image);
      clone.mainView.endProcess();
      clone.hide();
      'OK';
    `);
    if (r.status === 'error') throw new Error('clone_image: ' + r.error.message);
    return { text: `Cloned ${input.source_id} → ${input.clone_id}` };
  },
};

const restoreFromClone = {
  name: 'restore_from_clone',
  description: 'Restore an image from a backup clone, replacing all changes since the clone was made.',
  inputSchema: {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'Target view ID to overwrite' },
      clone_id: { type: 'string', description: 'Clone view ID to restore from' },
    },
    required: ['target_id', 'clone_id'],
  },
  async handler(api, input) {
    const r = await api.pjsr(`
      var srcW = ImageWindow.windowById(${q(input.target_id)});
      var clone = ImageWindow.windowById(${q(input.clone_id)});
      if (srcW.isNull) throw new Error('Restore target not found: ' + ${q(input.target_id)});
      if (clone.isNull) throw new Error('Clone not found: ' + ${q(input.clone_id)});
      srcW.mainView.beginProcess();
      srcW.mainView.image.assign(clone.mainView.image);
      srcW.mainView.endProcess();
      'OK';
    `);
    if (r.status === 'error') throw new Error('restore_from_clone: ' + r.error.message);
    return { text: `Restored ${input.target_id} from ${input.clone_id}` };
  },
};

const cropImage = {
  name: 'crop_image',
  description: 'Crop pixels off the edges of an image, in place. Amounts are pixels to remove from each side.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to crop' },
      left: { type: 'number', description: 'Pixels to remove from the left edge' },
      top: { type: 'number', description: 'Pixels to remove from the top edge' },
      right: { type: 'number', description: 'Pixels to remove from the right edge' },
      bottom: { type: 'number', description: 'Pixels to remove from the bottom edge' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const m = { left: num(input.left, 0), top: num(input.top, 0), right: num(input.right, 0), bottom: num(input.bottom, 0) };
    const out = await run(api, `${need(input.view_id)}
      var P = new Crop;
      P.mode = Crop.AbsolutePixels;
      P.leftMargin = ${-m.left}; P.topMargin = ${-m.top}; P.rightMargin = ${-m.right}; P.bottomMargin = ${-m.bottom};
      __run(P, __w.mainView);
      var im = ImageWindow.windowById(${q(input.view_id)}).mainView.image;
      return im.width + 'x' + im.height;`);
    return { text: `Cropped ${input.view_id}. New size: ${out}` };
  },
};

const getImageDimensions = {
  name: 'get_image_dimensions',
  description: 'Get dimensions, channel count, and color status for one or more views. Every channel must have identical dimensions before ChannelCombination.',
  inputSchema: {
    type: 'object',
    properties: { view_ids: { type: 'array', items: { type: 'string' }, description: 'View IDs to check' } },
    required: ['view_ids'],
  },
  async handler(api, input) {
    const ids = input.view_ids.map((id) => q(id)).join(',');
    const r = await api.pjsr(`
      var ids = [${ids}];
      var res = [];
      for (var i = 0; i < ids.length; i++) {
        var w = ImageWindow.windowById(ids[i]);
        if (!w.isNull) {
          var img = w.mainView.image;
          res.push({ id: ids[i], width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor });
        } else {
          res.push({ id: ids[i], error: 'not found' });
        }
      }
      JSON.stringify(res);
    `);
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    return { text: r.outputs?.consoleOutput || '[]' };
  },
};

const getImageStats = {
  name: 'get_image_stats',
  description: 'Get image statistics: median, MAD, min, max, per-channel medians.',
  inputSchema: {
    type: 'object',
    properties: { view_id: { type: 'string', description: 'PixInsight view ID' } },
    required: ['view_id'],
  },
  async handler(api, input) {
    const stats = await api.stats(input.view_id);
    return { text: JSON.stringify(stats, null, 2) };
  },
};

// resolveExportPath(filePath, { outputDir, stateDir }, platform, { realpathSync }?) -> { path } | { error }
//
// export_image is the one core tool that writes where the caller says, so it is held to the two
// folders a session writes to: a relative file_path is resolved under outputDir, and the resolved
// path must lie inside outputDir or stateDir after following links (the real path of its deepest
// existing folder), so a link inside output/ cannot lead out of them. Every
// other core tool writes under scratchDir.
export function resolveExportPath(filePath, { outputDir, stateDir }, platform = process.platform, { realpathSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const target = p.resolve(outputDir, filePath);
  const refuse = (where) => ({ error: `file_path must be inside ${outputDir} or ${stateDir} (a relative path is resolved under ${outputDir}); "${filePath}" ${where}.` });
  // The real paths decide (they are resolved too, so `..` cannot climb out either); where nothing
  // resolves, realPathOf returns the path as resolved and this is the lexical check.
  const real = (x) => realPathOf(x, { platform, ...(realpathSync ? { realpathSync } : {}) });
  const realTarget = real(target);
  if (isInside(realTarget, real(outputDir), platform) || isInside(realTarget, real(stateDir), platform)) return { path: target };
  const lexicallyInside = isInside(target, outputDir, platform) || isInside(target, stateDir, platform);
  return refuse(lexicallyInside ? `leads to ${realTarget} through a link` : `resolves to ${target}`);
}

const exportImage = {
  name: 'export_image',
  description: 'Write an image to a file in the workspace\'s output or state folder. A relative file_path is resolved under <workspace>/output; an absolute one must lie inside <workspace>/output or the state folder (<workspace>/agentic by default), and a path anywhere else is refused. Format comes from the extension: .tif/.tiff, .png, .jpg/.jpeg, .xisf, .fits. TIFF and PNG default to 16-bit, JPEG to 8-bit; use 32 for float. The file keeps the image\'s FITS keywords, astrometric solution and view properties (formats that cannot store them drop them). The working image is not changed. Missing parent folders are created.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to export' },
      file_path: { type: 'string', description: 'Output file path: relative to <workspace>/output, or absolute inside <workspace>/output or the state folder' },
      bits: { type: 'number', enum: [8, 16, 32], description: 'Sample depth for tif/png/xisf/fits (default 16 for tif/png, 32 otherwise)' },
    },
    required: ['view_id', 'file_path'],
  },
  async handler(api, input) {
    const ext = path.extname(String(input.file_path)).toLowerCase();
    if (!['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.xisf', '.fits', '.fit'].includes(ext)) {
      return { isError: true, text: `Unsupported extension "${ext}".` };
    }
    const defaultBits = ['.jpg', '.jpeg'].includes(ext) ? 8 : ['.tif', '.tiff', '.png'].includes(ext) ? 16 : 32;
    const bits = input.bits ?? defaultBits;
    const conv = { 8: 'SampleFormatConversion.To8Bit', 16: 'SampleFormatConversion.To16Bit', 32: null }[bits];
    if (conv === undefined) return { isError: true, text: 'bits must be 8, 16 or 32.' };
    // The state folder is scratchDir's parent (src/workspace.mjs's workspacePaths).
    const outputDir = api.workspace.outputDir;
    const resolved = resolveExportPath(String(input.file_path), { outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
    if (resolved.error) return { isError: true, text: resolved.error };
    const file = resolved.path;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Checked again now that the parent exists: a link created in the meantime cannot lead out.
    const again = resolveExportPath(file, { outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
    if (again.error) return { isError: true, text: again.error };
    const out = await run(api, `${need(input.view_id)}
      var src = __w.mainView.image;
      var c = new ImageWindow(src.width, src.height, src.numberOfChannels, 32, true, src.isColor, 'export_tmp');
      try {
        c.mainView.beginProcess(); c.mainView.image.assign(src); c.mainView.endProcess();
        // The copy is a new window: carry over what the file should describe, not just the pixels.
        c.keywords = __w.keywords;
        if (__w.hasAstrometricSolution) c.copyAstrometricSolution(__w);
        var props = __w.mainView.properties;
        for (var i = 0; i < props.length; ++i) {
          try {
            c.mainView.setPropertyValue(props[i], __w.mainView.propertyValue(props[i]));
            c.mainView.setPropertyAttributes(props[i], __w.mainView.propertyAttributes(props[i]));
          } catch (e) {}
        }
        ${conv ? `var S = new SampleFormatConversion; S.format = ${conv}; S.executeOn(c.mainView);` : ''}
        if (File.exists(${q(toPixPath(file))})) File.remove(${q(toPixPath(file))});
        c.saveAs(${q(toPixPath(file))}, false, false, false, false);
      } finally { c.forceClose(); }
      if (!File.exists(${q(toPixPath(file))})) throw new Error('File was not written');
      return String(new FileInfo(${q(toPixPath(file))}).size);`);
    return { text: `Wrote ${file} (${(Number(out) / 1048576).toFixed(1)} MB, ${ext === '.jpg' || ext === '.jpeg' ? '8-bit' : bits + '-bit'}).` };
  },
};

export const tools = [
  openImage,
  closeImage,
  listOpenImages,
  renameView,
  cloneImage,
  restoreFromClone,
  cropImage,
  getImageDimensions,
  getImageStats,
  exportImage,
];
