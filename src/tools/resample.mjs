// ============================================================================
// resample_image: change an image's pixel dimensions with IntegerResample (whole-number binning or
// enlarging) or Resample (a scale factor, or the exact size of another open view).
// Both are geometry processes: PixInsight removes the astrometric solution when they run, and a
// solved image makes them ask for confirmation in a modal dialog unless noGUIMessages is set, which
// would block the bridge. The tool sets it, keeps the FITS keywords (the process leaves them), and
// reports whether a solution was present before and after.
// ============================================================================
import { q, int, num, oneOf, vid, pjsrJson } from './pjsr-args.mjs';

const MODES = ['integer', 'scale', 'to_reference'];
const DOWNSAMPLING = ['Average', 'Median', 'Maximum', 'Minimum'];
const INTERPOLATIONS = ['Auto', 'NearestNeighbor', 'Bilinear', 'BicubicSpline', 'BicubicBSpline', 'Lanczos3', 'Lanczos4', 'Lanczos5',
  'MitchellNetravaliFilter', 'CatmullRomSplineFilter', 'CubicBSplineFilter'];

// A copy that carries the keywords, the astrometric solution and the view properties, as export_image does.
const COPY_PJSR = `
  function __copyOf(src, id) {
    var s = src.mainView.image;
    var c = new ImageWindow(s.width, s.height, s.numberOfChannels, s.bitsPerSample, s.isReal, s.isColor, id);
    c.mainView.beginProcess(); c.mainView.image.assign(s); c.mainView.endProcess();
    c.keywords = src.keywords;
    if (src.hasAstrometricSolution) c.copyAstrometricSolution(src);
    var props = src.mainView.properties;
    for (var i = 0; i < props.length; ++i) {
      try { c.mainView.setPropertyValue(props[i], src.mainView.propertyValue(props[i])); c.mainView.setPropertyAttributes(props[i], src.mainView.propertyAttributes(props[i])); } catch (e) {}
    }
    c.show();
    return c;
  }`;

export function resamplePjsr(o) {
  const INT = 'IntegerResample', RES = 'Resample';
  let setup;
  if (o.mode === 'integer') {
    setup = `var P = new ${INT};
    if (${INT}[${q(o.downsampling)}] === undefined) throw new Error('${INT} has no downsampling mode ' + ${q(o.downsampling)});
    P.zoomFactor = ${o.zoom};
    P.downsamplingMode = ${INT}[${q(o.downsampling)}];`;
  } else {
    const size = o.mode === 'scale'
      ? `P.mode = ${RES}.RelativeDimensions; P.xSize = ${o.factor}; P.ySize = ${o.factor};`
      : `var __rw = ImageWindow.windowById(${q(o.referenceId)}); if (__rw.isNull) throw new Error('View not found: ' + ${q(o.referenceId)});
    P.mode = ${RES}.AbsolutePixels; P.absoluteMode = ${RES}.ForceWidthAndHeight;
    P.xSize = __rw.mainView.image.width; P.ySize = __rw.mainView.image.height;`;
    setup = `var P = new ${RES};
    ${size}
    ${o.interpolation ? `if (${RES}[${q(o.interpolation)}] === undefined) throw new Error('${RES} has no interpolation ' + ${q(o.interpolation)});
    P.interpolation = ${RES}[${q(o.interpolation)}];` : ''}`;
  }
  return `(function () {
  ${COPY_PJSR}
  var src = ImageWindow.windowById(${q(o.viewId)});
  if (src.isNull) throw new Error('View not found: ' + ${q(o.viewId)});
  var w = src;
  ${o.outputId ? `if (!ImageWindow.windowById(${q(o.outputId)}).isNull) throw new Error('A view named ' + ${q(o.outputId)} + ' is already open');
  w = __copyOf(src, ${q(o.outputId)});` : ''}
  var before = { width: w.mainView.image.width, height: w.mainView.image.height, solution: !!w.hasAstrometricSolution, keywords: w.keywords.length };
  ${setup}
  if (P.noGUIMessages !== undefined) P.noGUIMessages = true;
  if (!P.executeOn(w.mainView)) throw new Error('the process did not run (see console message)');
  var after = { width: w.mainView.image.width, height: w.mainView.image.height, solution: !!w.hasAstrometricSolution, keywords: w.keywords.length };
  return JSON.stringify({ view: w.mainView.id, before: before, after: after });
})()`;
}

const resampleImage = {
  name: 'resample_image',
  description:
    'Change an image\'s pixel dimensions. mode "integer": IntegerResample by a whole factor (factor 2 bins 2x2 into one pixel ' +
    'with the given downsampling combination; enlarge: true multiplies the size instead). mode "scale": Resample by a relative factor ' +
    '(0.5 halves each side). mode "to_reference": Resample to exactly the width and height of reference_id. Runs in place, or on a ' +
    'copy named output_id that carries the keywords, astrometric solution and view properties. FITS keywords are kept. PixInsight ' +
    'removes the astrometric solution in these processes; the result states whether a solution was present before and after. ' +
    'Runs without the geometry confirmation dialog (noGUIMessages).',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View to resample' },
      mode: { type: 'string', enum: MODES, description: 'integer (IntegerResample), scale (Resample by a factor) or to_reference (Resample to reference_id\'s size)' },
      factor: { type: 'number', description: 'integer: whole bin/zoom factor >= 2. scale: relative size factor > 0' },
      enlarge: { type: 'boolean', description: 'integer mode: multiply the size by factor instead of dividing it (default false)' },
      downsampling: { type: 'string', enum: DOWNSAMPLING, description: 'integer mode: how binned pixels combine (default Average)' },
      interpolation: { type: 'string', enum: INTERPOLATIONS, description: 'scale / to_reference: Resample interpolation; omitted, PixInsight\'s default' },
      reference_id: { type: 'string', description: 'to_reference: the view whose width and height the result takes' },
      output_id: { type: 'string', description: 'Resample a copy with this view id instead of the view itself' },
    },
    required: ['view_id', 'mode'],
  },
  async handler(api, input) {
    const mode = oneOf(input.mode, MODES, undefined, 'mode');
    const o = { viewId: input.view_id, mode, outputId: input.output_id === undefined ? null : vid(input.output_id, 'output_id') };
    if (mode === 'integer') {
      const f = int(input.factor, undefined, 'factor');
      if (f < 2) throw new Error('factor: integer mode needs a whole factor >= 2');
      o.zoom = input.enlarge === true || input.enlarge === 'true' ? f : -f;
      o.downsampling = oneOf(input.downsampling, DOWNSAMPLING, 'Average', 'downsampling');
    } else if (mode === 'scale') {
      o.factor = num(input.factor, undefined, 'factor');
      if (!(o.factor > 0)) throw new Error('factor: scale mode needs a factor > 0');
    } else {
      if (!input.reference_id) throw new Error('reference_id: to_reference mode needs a reference view');
      o.referenceId = input.reference_id;
    }
    if (mode !== 'integer' && input.interpolation !== undefined) o.interpolation = oneOf(input.interpolation, INTERPOLATIONS, undefined, 'interpolation');
    const r = await pjsrJson(api, resamplePjsr(o), 'resample_image');
    const lost = r.before.solution && !r.after.solution;
    return {
      text: `Resampled ${r.view}: ${r.before.width}x${r.before.height} -> ${r.after.width}x${r.after.height}. ` +
        `Keywords: ${r.after.keywords}. Astrometric solution: ${r.before.solution ? (lost ? 'present before, removed by the process' : 'present before and after') : 'none before'}.`,
    };
  },
};

export const tools = [resampleImage];
