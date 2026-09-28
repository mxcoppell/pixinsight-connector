// ============================================================================
// align_files: StarAlignment of image files onto a reference file, file to file, in batches.
//
// Batches: a StarAlignment over many full-size targets in one execution has crashed PixInsight, so
// targets go in batches of at most 20, one bridge command each.
// matrix_only: StarAlignment's OutputMatrix mode computes the registration without resampling the
// targets, but StarAlignment has still been seen to write registered files in a matrix-type mode.
// So in matrix_only the output directory is a fresh temporary folder under
// <workspace>/agentic/scratch/align_files; whatever lands there is listed in the result and deleted.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { toPixPath } from '../platform.mjs';
import { q, int, bool, oneOf, pjsrJson } from './pjsr-args.mjs';
import { resolveExportPath } from './images.mjs';

const MAX_BATCH = 20;
const INTERPOLATIONS = ['Auto', 'NearestNeighbor', 'Bilinear', 'BicubicSpline', 'BicubicBSpline', 'Lanczos3', 'Lanczos4', 'Lanczos5',
  'MitchellNetravaliFilter', 'CatmullRomSplineFilter', 'CubicBSplineFilter'];

export function alignBatchPjsr(o) {
  const SA = 'StarAlignment';
  return `(function () {
  var o = ${JSON.stringify(o)};
  var P = new ${SA};
  P.referenceImage = o.reference;
  P.referenceIsFile = true;
  P.targets = o.targets.map(function (t) { return [true, true, t]; });
  P.outputDirectory = o.outputDir;
  P.outputPrefix = '';
  P.outputPostfix = o.postfix;
  P.outputExtension = '.xisf';
  P.overwriteExistingFiles = o.overwrite;
  if (o.distortionCorrection !== null) P.distortionCorrection = o.distortionCorrection;
  if (o.interpolation !== null) {
    if (${SA}[o.interpolation] === undefined) throw new Error('${SA} has no interpolation ' + o.interpolation);
    P.pixelInterpolation = ${SA}[o.interpolation];
  }
  if (o.matrixOnly) {
    if (${SA}.OutputMatrix === undefined) throw new Error('${SA} has no OutputMatrix mode in this PixInsight');
    P.mode = ${SA}.OutputMatrix;
    P.writeKeywords = false;
  }
  if (P.noGUIMessages !== undefined) P.noGUIMessages = true;
  var ok = P.executeGlobal();
  // Column names of outputData, from the process's own outputData_* index constants.
  var names = [];
  try { names = Object.getOwnPropertyNames(${SA}).filter(function (n) { return /^outputData_/.test(n) && typeof ${SA}[n] === 'number'; }); } catch (e) {}
  var rows = (P.outputData || []).map(function (r, i) {
    var row = { target: o.targets[i] };
    if (names.length) {
      names.forEach(function (n) { var v = r[${SA}[n]], k = n.replace(/^outputData_/, '');
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') row[k] = v;
        else if (v && v.length !== undefined) row[k + 'Count'] = v.length; });
    } else {
      for (var c = 0; c < r.length; c++) { var v2 = r[c]; if (typeof v2 === 'number' || typeof v2 === 'string') row['c' + c] = v2; }
    }
    return row;
  });
  return JSON.stringify({ ok: !!ok, rows: rows, columns: names.map(function (n) { return n.replace(/^outputData_/, ''); }) });
})()`;
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath ?? e.path, e.name));
  return out;
}

const alignFiles = {
  name: 'align_files',
  description:
    'Register image files onto a reference image file with StarAlignment, file to file (no views are opened). Targets run in ' +
    'batches of at most batch_size (20 at most), one StarAlignment execution per batch. Registered files (<name><output_postfix>.xisf) ' +
    'go to output_dir, which must lie inside <workspace>/output (a relative path is resolved there) or the state folder. ' +
    'matrix_only: StarAlignment in OutputMatrix mode, reporting the registration per target without keeping any image file; its ' +
    'output directory is a temporary folder under <workspace>/agentic/scratch/align_files that is deleted afterwards, and any file ' +
    'written there is listed. Per target the result gives the outputData values StarAlignment reports (output file, star pair ' +
    'matches, errors, transformation elements, as this PixInsight names them). Runs without geometry confirmation dialogs.',
  inputSchema: {
    type: 'object',
    properties: {
      reference_file: { type: 'string', description: 'Absolute path of the reference image file' },
      target_files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to register' },
      output_dir: { type: 'string', description: 'Folder for registered files: relative to <workspace>/output, or absolute inside <workspace>/output or the state folder. Not used with matrix_only' },
      matrix_only: { type: 'boolean', description: 'Compute the registration only; keep no image files (default false)' },
      distortion_correction: { type: 'boolean', description: 'StarAlignment distortion correction; omitted, PixInsight\'s default' },
      interpolation: { type: 'string', enum: INTERPOLATIONS, description: 'StarAlignment pixel interpolation; omitted, PixInsight\'s default' },
      output_postfix: { type: 'string', description: 'Suffix of registered file names (default "_r")' },
      overwrite: { type: 'boolean', description: 'Overwrite existing registered files (default false)' },
      batch_size: { type: 'integer', description: 'Targets per StarAlignment execution, 1 to 20 (default 20)' },
    },
    required: ['reference_file', 'target_files'],
  },
  async handler(api, input) {
    const ref = String(input.reference_file);
    if (!path.isAbsolute(ref) || !fs.existsSync(ref)) throw new Error(`reference_file not found: ${ref}`);
    if (!Array.isArray(input.target_files) || !input.target_files.length) throw new Error('target_files: expected a non-empty array of paths');
    const targets = input.target_files.map(String);
    const missing = targets.filter((t) => !path.isAbsolute(t) || !fs.existsSync(t));
    if (missing.length) throw new Error(`target_files not found: ${missing.join(', ')}`);
    const matrixOnly = bool(input.matrix_only, false, 'matrix_only');
    const batch = int(input.batch_size, MAX_BATCH, 'batch_size');
    if (batch < 1 || batch > MAX_BATCH) throw new Error(`batch_size: 1 to ${MAX_BATCH}`);
    const postfix = input.output_postfix === undefined ? '_r' : String(input.output_postfix);
    if (/[\\/]/.test(postfix)) throw new Error('output_postfix: no path separators');

    let outDir;
    if (matrixOnly) {
      outDir = path.join(api.workspace.scratchDir, 'align_files', `matrix_${Date.now()}`);
    } else {
      if (!input.output_dir) throw new Error('output_dir: needed unless matrix_only is true');
      const resolved = resolveExportPath(String(input.output_dir), { outputDir: api.workspace.outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
      if (resolved.error) return { isError: true, text: resolved.error.replace('file_path', 'output_dir') };
      outDir = resolved.path;
    }
    fs.mkdirSync(outDir, { recursive: true });

    const rows = [];
    let columns = [];
    const failedBatches = [];
    let written = [];
    try {
      for (let i = 0; i < targets.length; i += batch) {
        const part = targets.slice(i, i + batch);
        const r = await pjsrJson(api, alignBatchPjsr({
          reference: toPixPath(ref), targets: part.map((t) => toPixPath(t)), outputDir: toPixPath(outDir), postfix,
          overwrite: bool(input.overwrite, false, 'overwrite'),
          distortionCorrection: input.distortion_correction === undefined ? null : bool(input.distortion_correction, undefined, 'distortion_correction'),
          interpolation: input.interpolation === undefined ? null : oneOf(input.interpolation, INTERPOLATIONS, undefined, 'interpolation'),
          matrixOnly,
        }), 'align_files');
        if (!r.ok) failedBatches.push(i / batch + 1);
        rows.push(...r.rows);
        if (r.columns.length) columns = r.columns;
      }
    } finally {
      if (matrixOnly) {
        written = listFiles(outDir);
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }
    const result = {
      reference: ref, targets: targets.length, batches: Math.ceil(targets.length / batch), failedBatches, columns, rows,
      ...(matrixOnly ? { matrixOnly: true, filesWrittenAndDeleted: written } : { outputDir: outDir }),
    };
    const text = JSON.stringify(result, null, 2);
    return failedBatches.length ? { isError: true, text: `StarAlignment reported failure in batch(es) ${failedBatches.join(', ')}.\n${text}` } : { text };
  },
};

export const tools = [alignFiles];
