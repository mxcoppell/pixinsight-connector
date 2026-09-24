// ============================================================================
// Measurement tools. measure_uniformity is the connector's own; the other eleven
// measure_* tools are folded in from mxcoppell/pixinsight-pack-astro@eee19b3
// (tools/gates.mjs: the check_* gates, scan_burnt_regions and
// measure_subject_detail), renamed and reduced to their numbers: each returns one
// JSON object, never a pass/fail verdict, a limit or advice. A threshold that
// decides what is counted is a required input. check_constraints was dropped
// (its numbers are get_image_stats'). The pixel code lives in ./image-metrics.mjs.
// ============================================================================
import { q, num } from './pjsr-args.mjs';
import {
  measureStars, measureStarLayer, measureRinging, measureSharpness, measureCoreClipping, measureClippedBlocks,
  measureHighlightTexture, measureSaturation, measureTonalPresence, measureBrightChroma, measureSubjectDetail,
  MonoImageError, TooFewPixelsError, CORE_WIDE_BOX, CORE_INNER_BOX,
} from './image-metrics.mjs';

/**
 * Measure background uniformity via 4-corner median stddev.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - PixInsight view ID
 * @param {number} sampleSize - Corner sample size in pixels (default 200)
 * @returns {object} { score, corners, perChannel, mean }
 */
export async function measureUniformity(ctx, viewId, sampleSize) {
  const sz = num(sampleSize, 200, 'sample_size');
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measureUniformity: not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var sz = ${sz};
    var corners = [
      [0, 0],
      [img.width - sz, 0],
      [0, img.height - sz],
      [img.width - sz, img.height - sz]
    ];
    var meds = [];
    var perCh = [];
    for (var i = 0; i < corners.length; i++) {
      var r = new Rect(corners[i][0], corners[i][1], corners[i][0] + sz, corners[i][1] + sz);
      img.selectedRect = r;
      if (img.isColor) {
        var chMeds = [];
        for (var c = 0; c < img.numberOfChannels; c++) {
          img.selectedChannel = c;
          chMeds.push(img.median());
        }
        img.resetChannelSelection();
        perCh.push(chMeds);
        meds.push((chMeds[0] + chMeds[1] + chMeds[2]) / 3);
      } else {
        var m = img.median();
        meds.push(m);
        perCh.push([m]);
      }
    }
    img.resetSelections();
    var mean = 0;
    for (var i = 0; i < meds.length; i++) mean += meds[i];
    mean /= meds.length;
    var variance = 0;
    for (var i = 0; i < meds.length; i++) variance += (meds[i] - mean) * (meds[i] - mean);
    var stddev = Math.sqrt(variance / meds.length);
    JSON.stringify({ score: stddev, corners: meds, perChannel: perCh, mean: mean });
  `);
  if (r.status === 'error') {
    throw new Error(r.error?.message || 'measureUniformity: unknown error');
  }
  const raw = r.outputs?.consoleOutput?.trim() ?? '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // Never a made-up score: no measurement is an error, not a number.
  if (!parsed || typeof parsed.score !== 'number') {
    throw new Error(`measure_uniformity: could not read a measurement from PixInsight's output: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  return parsed;
}

const measureUniformityTool = {
  name: 'measure_uniformity',
  description: 'Measure background uniformity via 4-corner median stddev. Lower score means more uniform.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'PixInsight view ID' },
      sample_size: { type: 'integer', description: 'Corner sample size in pixels (default 200)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const uni = await measureUniformity(api, input.view_id, input.sample_size);
    return { text: JSON.stringify(uni, null, 2) };
  },
};

// ---------------------------------------------------------------------------
// Folded measure_* tools
// ---------------------------------------------------------------------------

const json = (o) => ({ text: JSON.stringify(o, null, 2) });

// Runs a measurement; a mono image, or too few pixels to measure, is an error result carrying the
// reason (and the count), never a stand-in number.
async function reported(measure) {
  try {
    return json(await measure());
  } catch (e) {
    if (e instanceof MonoImageError || e instanceof TooFewPixelsError) return { isError: true, text: e.message };
    throw e;
  }
}

const viewSchema = (description, extra = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: { view_id: { type: 'string', description }, ...extra },
  required: ['view_id', ...required],
});

const LUMA = 'luminance is 0.2126R + 0.7152G + 0.0722B';

const measureStarsTool = {
  name: 'measure_stars',
  description: 'Measure the stars of a view by pixel sampling. Candidates are local maxima of luminance found by a 16 px grid scan above median + 5 x MAD, '
    + 'refined within 5x5, de-duplicated within 20 px (at most 100 kept); the 30 brightest are measured. FWHM of a star = 2 x the mean radius, over the four '
    + 'axis directions (up to 10 px), where luminance drops below half its peak, located to a fraction of a pixel by linear interpolation between the samples either side; colour diversity of a star = max - min of its peak RGB divided by the largest channel. '
    + `Returns JSON: median_fwhm_px, color_diversity (median), stars_found, stars_measured, median_peak, p25_peak, background_median, star_background_contrast `
    + `(median_peak / background_median, 0 when background_median <= 0.001), and up to 10 samples of each. ${LUMA}.`,
  inputSchema: viewSchema('View to measure'),
  async handler(api, input) {
    return json(await measureStars(api, input.view_id));
  },
};

const measureStarLayerTool = {
  name: 'measure_star_layer',
  description: 'Measure a star layer (a mostly black view holding stars). Over every 4th pixel whose largest channel is above 0.005 (nonzero_pixel_count), '
    + 'reports the fraction whose largest channel is above each of the given levels, the interquartile range of their HSV saturation (color_diversity), '
    + 'and the median (max - min) / max of the 20 brightest by R+G+B (bright_star_chroma). Also the largest channel value (max) and the '
    + 'image median (the mean of the channel medians for colour). Returns JSON: max, median, fraction_above {level: fraction}, color_diversity, '
    + 'bright_star_chroma, nonzero_pixel_count.',
  inputSchema: viewSchema('Star layer view to measure', {
    levels: { type: 'array', items: { type: 'number' }, minItems: 1, description: 'Pixel levels; for each, the fraction of star pixels whose largest channel is above it is reported' },
  }, ['levels']),
  async handler(api, input) {
    return json(await measureStarLayer(api, input.view_id, input.levels));
  },
};

const measureRingingTool = {
  name: 'measure_ringing',
  description: 'Measure concentric oscillation around the brightest region. The centre is the middle of the brightest 64 px block (mean luminance); the radial '
    + 'luminance profile is averaged over 36 angles for radii 1..150 px (held inside the image). Along the profile, derivatives within ±0.001 carry no sign; '
    + 'at each sign change the summed |derivative| of the run it ends is its amplitude, and it is counted when that amplitude is above min_amplitude. '
    + `Returns JSON: oscillations, max_amplitude (of the counted ones), center [x, y], profile_sample (the profile at radii 1..30). ${LUMA}.`,
  inputSchema: viewSchema('View to measure', {
    min_amplitude: { type: 'number', description: 'Amplitude (summed |derivative| of a run) above which a sign change is counted as an oscillation' },
  }, ['min_amplitude']),
  async handler(api, input) {
    return json(await measureRinging(api, input.view_id, input.min_amplitude));
  },
};

const measureSharpnessTool = {
  name: 'measure_sharpness',
  description: 'Measure sharpness as the mean Sobel gradient energy (gx² + gy²) of luminance over every 4th pixel of a region. The region is roi_x/roi_y/roi_w/roi_h '
    + `when all four are given (it must lie inside the image), else the central half of the image in each dimension. Returns JSON: sharpness, samples, roi {x, y, w, h}. ${LUMA}.`,
  inputSchema: viewSchema('View to measure', {
    roi_x: { type: 'number', description: 'Region left edge in pixels (all four ROI values together, or none: the central half)' },
    roi_y: { type: 'number', description: 'Region top edge in pixels' },
    roi_w: { type: 'number', description: 'Region width in pixels' },
    roi_h: { type: 'number', description: 'Region height in pixels' },
  }),
  async handler(api, input) {
    const keys = ['roi_x', 'roi_y', 'roi_w', 'roi_h'];
    const given = keys.filter((k) => input[k] != null);
    if (given.length && given.length < 4) throw new Error(`measure_sharpness: give all of roi_x, roi_y, roi_w and roi_h, or none (given: ${given.join(', ')})`);
    const roi = given.length ? { x: input.roi_x, y: input.roi_y, w: input.roi_w, h: input.roi_h } : undefined;
    return json(await measureSharpness(api, input.view_id, roi));
  },
};

const measureCoreClippingTool = {
  name: 'measure_core_clipping',
  description: `Measure how much of the brightest region is above a level. Around the brightest 64 px block (mean luminance), counts pixels with any channel above `
    + `level in a ${CORE_WIDE_BOX} px box (every 2nd pixel) and a ${CORE_INNER_BOX} px box (every pixel), both centred on that block and held inside the image. `
    + `Returns JSON: fraction_above_wide, fraction_above_inner, peak (largest luminance in the wide box), core_center [x, y], wide_box, inner_box. ${LUMA}.`,
  inputSchema: viewSchema('View to measure', {
    level: { type: 'number', description: 'Pixel level; a pixel with any channel above it is counted' },
  }, ['level']),
  async handler(api, input) {
    return json(await measureCoreClipping(api, input.view_id, input.level));
  },
};

const measureClippedBlocksTool = {
  name: 'measure_clipped_blocks',
  description: 'Count image blocks with pixels above a level. Tiles the image in block_size px blocks and samples every 3rd pixel; a sample counts when its '
    + 'luminance or any channel is above level, and a block counts when more than block_fraction of its samples do. '
    + `Returns JSON: blocks_over, total_blocks, locations (up to 10 counted blocks in descending fraction order: x, y, fraction). ${LUMA}.`,
  inputSchema: viewSchema('View to measure', {
    level: { type: 'number', description: 'Pixel level; a sample whose luminance or any channel is above it counts' },
    block_fraction: { type: 'number', description: 'Fraction of a block\'s samples (0-1) that must be above level for the block to count' },
    block_size: { type: 'integer', minimum: 1, description: 'Block edge in pixels (default 50)' },
  }, ['level', 'block_fraction']),
  async handler(api, input) {
    return json(await measureClippedBlocks(api, input.view_id, {
      level: input.level, blockFraction: input.block_fraction, blockSize: input.block_size ?? 50,
    }));
  },
};

const measureHighlightTextureTool = {
  name: 'measure_highlight_texture',
  description: 'Measure the texture of the bright subject zone. Subject pixels have luminance above median + 5 x (median |luminance - median| on a 32 px grid). '
    + 'The ROI is a circle around the luminance-weighted centroid of compact subject pixels (8 px grid, at least 2 of 4 neighbours 3 px away also subject), '
    + 'radius = their 90th-percentile distance held to [50 px, 0.45 x min(width, height)]. The shell zone is the P20..P92 band of the subject pixels in the ROI '
    + '(every 4th pixel). local_stddev = median luminance stddev of 16 px blocks in the ROI whose samples are at least 40% shell; tonal_span = P90 - P10 of the '
    + 'shell pixels; gradient_energy = mean Sobel energy on shell pixels. With reference_id, the reference is measured over the same ROI and retention is '
    + 'current / reference for each value (null where the reference value is at most 0.0001, or 0.001 for tonal_span). Returns JSON: current, reference, '
    + `retention, shell_zone, roi, shell_pixel_count, block_count. Fewer than 100 subject pixels in the ROI of either view is an error. ${LUMA}.`,
  inputSchema: viewSchema('View to measure', {
    reference_id: { type: 'string', description: 'Optional second view measured over the same ROI, for the retention ratios' },
  }),
  async handler(api, input) {
    return reported(() => measureHighlightTexture(api, input.view_id, input.reference_id || undefined));
  },
};

const measureSaturationTool = {
  name: 'measure_saturation',
  description: 'Measure HSV saturation, (max - min) / max, of subject pixels of a colour view: every 8th pixel whose luminance is above the luminance of the '
    + 'channel medians + 5 x (median |luminance - that| on a 32 px grid). Returns JSON: median, p90, p99, max, subject_pixel_count. '
    + `A mono view is an error. ${LUMA}.`,
  inputSchema: viewSchema('Colour view to measure'),
  async handler(api, input) {
    return reported(() => measureSaturation(api, input.view_id));
  },
};

const measureTonalPresenceTool = {
  name: 'measure_tonal_presence',
  description: 'Measure subject and background tones. Every 8th pixel is subject when its luminance is above the background (luminance of the channel medians) '
    + '+ 5 x (median |luminance - background| on a 32 px grid) and at least 2 of its 4 neighbours 3 px away are too; every other sample is background. '
    + 'separation = subject median / background median; core_brightness = mean of the brightest 5% of subject samples; core_to_disk = core_brightness / '
    + 'subject median; faint_structure_visibility = (subject P10 - background P90) / background P90; subject_fraction = subject samples / all samples; '
    + 'roi_mode is compound_roi when a second luminance-weighted cluster, outside 0.15 x width of the centroid and holding over 15% of the weight, lies more '
    + 'than 0.25 x width away, else single. Denominators are held to at least 0.001. Returns JSON: separation, subject_median, background_median, '
    + `core_brightness, faint_structure_visibility, core_to_disk, subject_fraction, roi_mode, subject_pixel_count. ${LUMA}.`,
  inputSchema: viewSchema('View to measure'),
  async handler(api, input) {
    return json(await measureTonalPresence(api, input.view_id));
  },
};

const measureBrightChromaTool = {
  name: 'measure_bright_chroma',
  description: 'Measure chroma, (max - min) / max, of the bright pixels of a colour view: every 8th pixel whose mean of R, G and B is above brightness_threshold. '
    + 'Returns JSON: median_chroma, mean_chroma, p25_chroma, p75_chroma, bright_pixel_count. A mono view is an error.',
  inputSchema: viewSchema('Colour view to measure', {
    brightness_threshold: { type: 'number', description: 'Mean of R, G and B above which a pixel is measured' },
  }, ['brightness_threshold']),
  async handler(api, input) {
    return reported(() => measureBrightChroma(api, input.view_id, input.brightness_threshold));
  },
};

const measureSubjectDetailTool = {
  name: 'measure_subject_detail',
  description: 'Measure subject brightness, detail and contrast. The image is split into 32 px blocks; a block is subject when its luminance median is above '
    + 'median + 8 x 1.4826 x MAD. subject_brightness = median of subject block medians; background_median = median of the other block medians; '
    + 'contrast_ratio = subject_brightness / background_median (0 when that is at most 0.001); detail_score = mean Sobel energy of luminance over every 4th '
    + 'pixel of up to 50 subject blocks; subject_count = subject blocks; subject_threshold = median + 3 x 1.4826 x MAD. '
    + `Returns JSON: subject_brightness, detail_score, contrast_ratio, subject_count, background_median, subject_threshold. ${LUMA}.`,
  inputSchema: viewSchema('View to measure'),
  async handler(api, input) {
    return json(await measureSubjectDetail(api, input.view_id));
  },
};

export const tools = [
  measureUniformityTool,
  measureStarsTool, measureStarLayerTool, measureRingingTool, measureSharpnessTool, measureCoreClippingTool,
  measureClippedBlocksTool, measureHighlightTextureTool, measureSaturationTool, measureTonalPresenceTool,
  measureBrightChromaTool, measureSubjectDetailTool,
];
