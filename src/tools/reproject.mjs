// ============================================================================
// reproject_to_reference: resample a plate-solved image onto the pixel grid of another plate-solved
// image through the two astrometric solutions, with one interpolation and no registration model.
//
// This is PixInsight's own astrometric reprojection (the ImageWindow method the ImageReprojection
// script class wraps): the output window takes the reference's size and solution, then the source is
// resampled into it. The tool calls those built-in methods directly, so it needs no script library
// from the installation. The result is a new 32-bit float window; the source is not modified.
// ============================================================================
import { q, num, oneOf, vid, pjsrJson } from './pjsr-args.mjs';

const INTERPOLATIONS = ['Auto', 'NearestNeighbor', 'Bilinear', 'BicubicSpline', 'BicubicBSpline', 'Lanczos3', 'Lanczos4', 'Lanczos5',
  'MitchellNetravaliFilter', 'CatmullRomSplineFilter', 'CubicBSplineFilter'];

export function reprojectPjsr(o) {
  return `(function () {
  var src = ImageWindow.windowById(${q(o.viewId)});
  if (src.isNull) throw new Error('View not found: ' + ${q(o.viewId)});
  var ref = ImageWindow.windowById(${q(o.referenceId)});
  if (ref.isNull) throw new Error('View not found: ' + ${q(o.referenceId)});
  if (!src.hasAstrometricSolution) throw new Error(${q(o.viewId)} + ' has no astrometric solution; run run_plate_solve on it first');
  if (!ref.hasAstrometricSolution) throw new Error(${q(o.referenceId)} + ' has no astrometric solution; run run_plate_solve on it first');
  if (!ImageWindow.windowById(${q(o.outputId)}).isNull) throw new Error('A view named ' + ${q(o.outputId)} + ' is already open');
  if (InterpolationAlgorithm[${q(o.interpolation)}] === undefined) throw new Error('No interpolation named ' + ${q(o.interpolation)});
  var t0 = Date.now();
  var si = src.mainView.image, ri = ref.mainView.image;
  si.interpolation = InterpolationAlgorithm[${q(o.interpolation)}];
  si.interpolationClamping = ${o.clamp};
  var out = new ImageWindow(ri.width, ri.height, si.numberOfChannels, 32, true, si.isColor, ${q(o.outputId)});
  try {
    out.mainView.beginProcess(UndoFlag.NoSwapFile);
    out.keywords = src.keywords;
    out.copyAstrometricSolution(ref);
    out.regenerateAstrometricSolution();
    out.mainView.image.interpolationQuality = 1;
    out.astrometricReprojection(src);
    out.mainView.endProcess();
  } catch (e) {
    out.forceClose();
    throw e;
  }
  out.show();
  return JSON.stringify({
    view: out.mainView.id, width: ri.width, height: ri.height, channels: si.numberOfChannels,
    interpolation: ${q(o.interpolation)}, clamp: ${o.clamp}, seconds: (Date.now() - t0) / 1000,
    solution: !!out.hasAstrometricSolution, empty: out.mainView.image.maximum() === 0,
  });
})()`;
}

const reprojectToReference = {
  name: 'reproject_to_reference',
  description:
    'Resample a plate-solved image onto the pixel grid of another plate-solved image, using the two astrometric solutions ' +
    '(PixInsight\'s astrometric reprojection): the result has the reference\'s size and solution and comes from a single ' +
    'interpolation of the source. Use it to bring a master from another telescope or session onto a reference grid; both ' +
    'views need a solution (run_plate_solve). The source is not changed; the result is a new 32-bit float view (output_id, ' +
    'default <view_id>_reprojected). It reports the size, the time and whether the result is empty (the two fields do not overlap). ' +
    'Registration accuracy is set by the two solutions, so check the star-centroid residual of the result against the reference.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'Source view to reproject (needs an astrometric solution)' },
      reference_id: { type: 'string', description: 'View whose size and astrometric solution the result takes (needs an astrometric solution)' },
      output_id: { type: 'string', description: 'View ID of the result (default <view_id>_reprojected)' },
      interpolation: { type: 'string', enum: INTERPOLATIONS, description: 'Pixel interpolation (default Lanczos3)' },
      clamp: { type: 'number', description: 'Clamping threshold of the Lanczos and bicubic interpolations, 0 to 1 (default 0.3)' },
    },
    required: ['view_id', 'reference_id'],
  },
  async handler(api, input) {
    const o = {
      viewId: vid(input.view_id, 'view_id'),
      referenceId: vid(input.reference_id, 'reference_id'),
      interpolation: oneOf(input.interpolation, INTERPOLATIONS, 'Lanczos3', 'interpolation'),
      clamp: num(input.clamp, 0.3, 'clamp'),
    };
    o.outputId = input.output_id === undefined ? vid(`${o.viewId}_reprojected`, 'output_id') : vid(input.output_id, 'output_id');
    if (!(o.clamp >= 0 && o.clamp <= 1)) throw new Error(`clamp: expected a number from 0 to 1, got ${o.clamp}`);
    const r = await pjsrJson(api, reprojectPjsr(o), 'reproject_to_reference');
    return {
      text: `Reprojected ${o.viewId} onto ${o.referenceId}'s grid as ${r.view}: ${r.width}x${r.height}, ${r.channels} channel(s), ` +
        `${r.interpolation} (clamp ${r.clamp}), ${r.seconds.toFixed(1)} s. Astrometric solution: ${r.solution ? 'copied from the reference' : 'MISSING'}.` +
        (r.empty ? ' WARNING: the result is empty; the two solutions do not overlap.' : ''),
    };
  },
};

export const tools = [reprojectToReference];
