// ============================================================================
// The 15 "process wrapper" tools. Six are plain defineProcessTool declarations
// (no forced/hidden PixInsight parameters beyond what the legacy tool already
// exposed as input). The other nine need real logic — a filter/white-reference
// database lookup, dynamic PJSR property selection, or several forced parameter
// assignments that were never part of the legacy input schema — so they use the
// hand-written escape hatch (CONTRIBUTING.md). Every one of those nine still
// builds its `new <Process>` line through a local class-name variable (PROC)
// rather than a literal process-class name next to the `new` keyword, exactly
// like defineProcessTool itself does in src/define.mjs, so this file carries
// no hand-written PJSR process instantiation for the contract test to catch.
//
// Ported from v0-pipeline:agents/llm/tools.mjs and v0-pipeline:agents/llm/tools-essential.mjs. The dead
// duplicate run_scnr (v0-pipeline:agents/llm/tools.mjs:354, shadowed by the one at :814 and
// never run) is not ported — only the live :814 definition is.
// ============================================================================
import fs from 'node:fs';
import { defineProcessTool } from '../define.mjs';
import { toPixPath, PlatformError } from '../platform.mjs';

const q = (s) => JSON.stringify(String(s));

// A number interpolated bare into PJSR (P.prop = ${n}) cannot be quoted like a string, so its
// actual runtime type is validated instead of trusted from the JSON Schema alone — the same
// safeguard defineProcessTool's own literalFor() applies to every "number" param.
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

// A process that ran is still reported as run when the follow-up statistics read fails (the stats
// are informational); only a user abort or a crash is passed on, for the server to report.
function statsOrEmpty(api, viewId) {
  return api.stats(viewId).catch((e) => {
    if (e?.isCrash || /MCP_ABORTED/.test(String(e?.message))) throw e;
    return {};
  });
}

// ---------------------------------------------------------------------------
// Plain defineProcessTool declarations (6) — one process, one view, every
// PJSR assignment corresponds to a visible, optional input field.
// ---------------------------------------------------------------------------

const runScnr = defineProcessTool({
  name: 'run_scnr',
  process: 'SCNR',
  description: 'Run SCNR (Subtractive Chromatic Noise Reduction) to remove a green colour cast from a view.',
  target: 'view',
  params: {
    amount: { type: 'number', pjsr: 'amount', default: 0.8, description: 'Green removal amount, 0 to 1.' },
    protection: {
      type: 'string', pjsr: 'protectionMethod', constantsFrom: 'SCNR',
      enum: ['AverageNeutral', 'MaximumMask'], default: 'AverageNeutral',
      description: 'Protection method.',
    },
  },
});

const runGradientCorrection = defineProcessTool({
  name: 'run_gradient_correction',
  process: 'GradientCorrection',
  description: 'Run GradientCorrection on a view to remove a background gradient.',
  target: 'view',
  params: {},
});

const runBackgroundNeutralization = defineProcessTool({
  name: 'run_background_neutralization',
  process: 'BackgroundNeutralization',
  description: 'Run BackgroundNeutralization to equalize the background level across channels.',
  target: 'view',
  params: {},
});

const runNxt = defineProcessTool({
  name: 'run_nxt',
  process: 'NoiseXTerminator',
  description: 'Run NoiseXTerminator to reduce noise on a view.',
  target: 'view',
  params: {
    denoise: { type: 'number', pjsr: 'denoise', required: true, description: 'Denoise strength, 0 to 1.' },
    detail: { type: 'number', pjsr: 'detail', default: 0.15, description: 'Detail preservation, 0 to 1.' },
  },
});

const linearFit = defineProcessTool({
  name: 'linear_fit',
  process: 'LinearFit',
  description: 'Run LinearFit to scale a linear image to match a reference view. The reference is not modified.',
  target: 'view',
  params: {
    reference_id: { type: 'string', pjsr: 'referenceViewId', required: true, description: 'Reference view ID.' },
    reject_low: { type: 'number', pjsr: 'rejectLow', default: 0, description: 'Low rejection threshold.' },
    reject_high: { type: 'number', pjsr: 'rejectHigh', default: 0.92, description: 'High rejection threshold.' },
  },
});

// run_lhe replaces mxcoppell/pixinsight-pack-astro@eee19b3's run_lhe, a stub that ran nothing and
// pointed at multi_scale_enhance, with the process itself.
const runLhe = defineProcessTool({
  name: 'run_lhe',
  process: 'LocalHistogramEqualization',
  additionalProperties: false,
  description: 'Run LocalHistogramEqualization (contrast-limited local histogram equalization) on a view. Omitted parameters keep PixInsight\'s defaults.',
  target: 'view',
  params: {
    radius: { type: 'number', pjsr: 'radius', description: 'Kernel radius in pixels.' },
    slope_limit: { type: 'number', pjsr: 'slopeLimit', description: 'Contrast slope limit.' },
    amount: { type: 'number', pjsr: 'amount', description: 'Blend of the equalized result with the original, 0 to 1.' },
    circular_kernel: { type: 'boolean', pjsr: 'circularKernel', description: 'Circular kernel (true) or square kernel (false).' },
    histogram_resolution: {
      type: 'string', pjsr: 'histogramBins', constantsFrom: 'LocalHistogramEqualization',
      enum: ['Bit8', 'Bit10', 'Bit12'], description: 'Histogram resolution: 8, 10 or 12 bits.',
    },
  },
});

// ---------------------------------------------------------------------------
// Escape-hatch descriptors (9) — forced parameters outside the legacy input
// schema, dynamic PJSR property selection, or a filesystem/database lookup.
// ---------------------------------------------------------------------------

const runBxt = {
  name: 'run_bxt',
  description: 'Run BlurXTerminator on a view. correct_only applies PSF correction without sharpening; otherwise sharpen_nonstellar and sharpen_stellar control sharpening strength.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      correct_only: { type: 'boolean', description: 'Correct-only mode: PSF correction with no sharpening' },
      sharpen_nonstellar: { type: 'number', description: 'Non-stellar sharpening, 0 to 1 (default 0.50)' },
      sharpen_stellar: { type: 'number', description: 'Stellar sharpening, 0 to 1 (default 0.50)' },
      adjust_star_halos: { type: 'number', description: 'Star halo adjustment, -1 to 1 (default 0.0)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const PROC = 'BlurXTerminator';
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.AI = true;
      P.correct_only = ${input.correct_only ? 'true' : 'false'};
      ${!input.correct_only ? `P.nonstellar_then_stellar = true;
      P.sharpen_nonstellar = ${num(input.sharpen_nonstellar, 0.50)};
      P.sharpen_stellar = ${num(input.sharpen_stellar, 0.50)};` : ''}
      P.adjust_halos = ${num(input.adjust_star_halos, 0.0)};
      __run(P, __w.mainView);`);
    const stats = await statsOrEmpty(api, input.view_id);
    return { text: `BXT complete (${input.correct_only ? 'correct_only' : 'sharpen'}). median=${stats.median?.toFixed?.(6)}` };
  },
};

const runSxt = {
  name: 'run_sxt',
  description: 'Run StarXTerminator to separate stars from a view, replacing it in place with the starless result and producing a separate stars view. is_linear selects the unscreen mode: off for linear (pre-stretch) data, on for non-linear (stretched) data.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to extract stars from (modified in place to become starless)' },
      is_linear: { type: 'boolean', description: 'Whether the image is linear (pre-stretch)' },
      overlap: { type: 'number', description: 'Star overlap parameter (default 0.10)' },
    },
    required: ['view_id', 'is_linear'],
  },
  async handler(api, input) {
    const PROC = 'StarXTerminator';
    const beforeIds = (await api.listImages()).map((i) => i.id);
    const unscreen = input.is_linear ? 'false' : 'true';
    // Report failure as text rather than throwing (matching the legacy tool),
    // so this calls api.pjsr() directly instead of the run()/guard() helper.
    const r = await api.pjsr(`(function(){ try {
      var __w = ImageWindow.windowById(${q(input.view_id)});
      if (__w.isNull) throw new Error('View not found: ' + ${q(input.view_id)});
      var P = new ${PROC};
      P.stars = true;
      P.unscreen = ${unscreen};
      P.overlap = ${num(input.overlap, 0.10)};
      if (!P.executeOn(__w.mainView)) throw new Error('the process did not run (see console message)');
    } catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`);
    if (r.status === 'error') return { isError: true, text: `SXT failed: ${r.error?.message}` };
    const afterImgs = await api.listImages();
    const newImgs = afterImgs.filter((i) => !beforeIds.includes(i.id));
    const starsView = newImgs.find((i) => i.id.includes('stars') || i.id.includes('star'));
    const starsId = starsView?.id || `${input.view_id}_stars`;
    return { text: `SXT complete. Starless: ${input.view_id}, Stars: ${starsId} (unscreen=${unscreen})` };
  },
};

const runAbe = {
  name: 'run_abe',
  description: 'Run AutomaticBackgroundExtractor (ABE) on a view, replacing it in place with the corrected result.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      poly_degree: { type: 'integer', description: 'Polynomial degree, 1 to 6 (default 4)' },
      tolerance: { type: 'number', description: 'Sample rejection tolerance (default 1.0)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const PROC = 'AutomaticBackgroundExtractor';
    const polyDegree = num(input.poly_degree, 4);
    const tolerance = num(input.tolerance, 1.0);
    const beforeIds = (await api.listImages()).map((i) => i.id);
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.tolerance = ${tolerance};
      P.deviation = 0.8;
      P.unbalance = 1.800;
      P.minBoxFraction = 0.050;
      P.maxBackground = 1.0000;
      P.minBackground = 0.0000;
      P.useBezierSurface = false;
      P.polyDegree = ${polyDegree};
      P.boxSize = 5;
      P.boxSeparation = 5;
      P.modelImageSampleFormat = ${PROC}.ModelFormat_f32;
      P.abeDownsample = 2.00;
      P.writeSampleBoxes = false;
      P.justTrySamples = false;
      P.targetCorrection = ${PROC}.Correction_Subtract;
      P.normalize = true;
      P.discardModel = true;
      P.replaceTarget = true;
      P.correctedImageId = '';
      P.correctedImageSampleFormat = ${PROC}.CorrectedFormat_SameAsTarget;
      P.verbosity = 0;
      __run(P, __w.mainView);`);
    // ABE can leave a residual model window behind; close anything new.
    const afterImgs = await api.listImages();
    const newImgs = afterImgs.filter((i) => !beforeIds.includes(i.id));
    for (const img of newImgs) await run(api, `var w=ImageWindow.windowById(${q(img.id)});if(w&&!w.isNull)w.forceClose();`);
    const stats = await statsOrEmpty(api, input.view_id);
    return { text: `ABE complete (degree=${polyDegree}). median=${stats.median?.toFixed?.(6)}` };
  },
};

const runHdrmt = {
  name: 'run_hdrmt',
  description: 'Run HDRMultiscaleTransform on a view. Inverted mode enhances detail; normal mode compresses dynamic range.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      layers: { type: 'integer', description: 'Number of decomposition layers, 4 to 8 (default 6)' },
      iterations: { type: 'integer', description: 'Number of iterations (default 1)' },
      inverted: { type: 'boolean', description: 'Inverted mode (enhances detail instead of compressing)' },
      to_lightness: { type: 'boolean', description: 'Apply to lightness only for color images (default true)' },
      preserve_hue: { type: 'boolean', description: 'Preserve hue for color images (default true)' },
    },
    required: ['view_id', 'layers'],
  },
  async handler(api, input) {
    const PROC = 'HDRMultiscaleTransform';
    const inverted = input.inverted ? 'true' : 'false';
    const toLightness = input.to_lightness !== false ? 'true' : 'false';
    const preserveHue = input.preserve_hue !== false ? 'true' : 'false';
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.numberOfLayers = ${num(input.layers)};
      P.numberOfIterations = ${num(input.iterations, 1)};
      P.invertedIterations = ${inverted};
      P.overdrive = 0;
      P.medianTransform = false;
      P.scalingFunctionData = [
        0.003906,0.015625,0.023438,0.015625,0.003906,
        0.015625,0.0625,0.09375,0.0625,0.015625,
        0.023438,0.09375,0.140625,0.09375,0.023438,
        0.015625,0.0625,0.09375,0.0625,0.015625,
        0.003906,0.015625,0.023438,0.015625,0.003906
      ];
      P.scalingFunctionRowFilter = [0.0625,0.25,0.375,0.25,0.0625];
      P.scalingFunctionColFilter = [0.0625,0.25,0.375,0.25,0.0625];
      P.scalingFunctionNoiseLayers = 1;
      P.scalingFunctionName = "B3 Spline (5)";
      P.deringing = true;
      P.smallScaleDeringing = 0.000;
      P.largeScaleDeringing = 0.500;
      P.outputDeringingMaps = false;
      P.toLightness = ${toLightness};
      P.preserveHue = ${preserveHue};
      __run(P, __w.mainView);`);
    const stats = await statsOrEmpty(api, input.view_id);
    return { text: `HDRMT complete (layers=${input.layers}, inverted=${inverted}). median=${stats.median?.toFixed?.(6)}` };
  },
};

const runCurves = {
  name: 'run_curves',
  description: 'Apply a CurvesTransformation to a view. Provide control points as [[x,y], ...] for the desired channel: "RGB" (all), "L" (lightness), "S" (saturation), "R", "G", "B".',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      channel: { type: 'string', enum: ['RGB', 'L', 'S', 'R', 'G', 'B'], description: 'Channel to apply the curve to' },
      points: {
        type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        description: 'Control points [[x,y], ...] from (0,0) to (1,1). Include endpoints.',
      },
    },
    required: ['view_id', 'channel', 'points'],
  },
  async handler(api, input) {
    const PROC = 'CurvesTransformation';
    const channelProp = { R: 'R', G: 'G', B: 'B', RGB: 'K', L: 'L', S: 'S' };
    const prop = channelProp[input.channel] || 'K';
    const pts = input.points.map((p) => `[${num(p[0])},${num(p[1])}]`).join(',');
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.${prop} = [${pts}];
      __run(P, __w.mainView);`);
    const stats = await statsOrEmpty(api, input.view_id);
    return { text: `Curves (${input.channel}) applied. median=${stats.median?.toFixed?.(6)}` };
  },
};

// --- Filter / white-reference database lookups (SPFC, SPCC, MGC, find_filters) ---

// Filter band centers (nm) and typical bandwidths, and the MARS band name each maps to.
const BANDS = {
  L: { wl: 550, bw: 300, mars: 'L' },
  R: { wl: 640, bw: 100, mars: 'R' },
  G: { wl: 540, bw: 100, mars: 'G' },
  B: { wl: 460, bw: 100, mars: 'B' },
  Ha: { wl: 656.3, bw: 7, mars: 'Ha', nb: true },
  OIII: { wl: 500.7, bw: 7, mars: 'OIII', nb: true },
  SII: { wl: 671.6, bw: 7, mars: 'Ha', nb: true }, // the MARS database has no SII band; Ha is used
};
const bandNames = Object.keys(BANDS).join(', ');

// With no install, api.platform is { error } and has no paths: report that, not an undefined path.
function requireInstall(api) {
  if (api.platform.error) throw new PlatformError(api.platform.error);
}

// Keyed by path (not a single cached value) so a different api.platform.filterDbPath
// — a different install, or a test fixture — is never served another one's data.
const filterDbCache = new Map();
function loadFilterDb(api) {
  requireInstall(api);
  const dbPath = api.platform.filterDbPath;
  if (!filterDbCache.has(dbPath)) {
    const xml = fs.readFileSync(dbPath, 'utf-8');
    const dec = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    filterDbCache.set(dbPath, [...xml.matchAll(/<Filter name="([^"]+)" channel="([^"]+)"[^>]*? data="([^"]*)"/g)]
      .map((m) => ({ name: dec(m[1]), channel: m[2], data: m[3] })));
  }
  return filterDbCache.get(dbPath);
}

function findCurve(api, name, channel) {
  const all = loadFilterDb(api).filter((f) => !channel || f.channel === channel);
  const lower = name.toLowerCase();
  const exact = all.find((f) => f.name.toLowerCase() === lower);
  if (exact) return exact;
  const partial = all.filter((f) => f.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const hint = partial.slice(0, 8).map((f) => f.name).join(' | ');
  throw new Error(partial.length ? `"${name}" is ambiguous. Matches: ${hint}` : `No curve named "${name}" in PixInsight's filter database. Use find_filters.`);
}

function findWhiteReference(api, name) {
  requireInstall(api);
  const xml = fs.readFileSync(api.platform.whiteRefPath, 'utf-8');
  const all = [...xml.matchAll(/<WhiteRef name="([^"]+)"[^>]*? data="([^"]*)"/g)].map((m) => ({ name: m[1], data: m[2] }));
  const lower = name.toLowerCase();
  const hit = all.find((w) => w.name.toLowerCase() === lower) || all.find((w) => w.name.toLowerCase().includes(lower));
  if (!hit) throw new Error(`No white reference named "${name}". Available: ${all.map((w) => w.name).join(', ')}`);
  return hit;
}

// A flat passband, 1 nm steps, used when no measured filter curve is given.
function boxCurve(center, bandwidth) {
  const lo = Math.round(center - bandwidth / 2);
  const hi = Math.round(center + bandwidth / 2);
  const pts = [];
  for (let wl = lo - 2; wl <= hi + 2; wl++) pts.push(wl, wl >= lo && wl <= hi ? 1 : 0);
  return pts.join(',');
}

// MARS database files PixInsight is configured with (MultiscaleGradientCorrection preferences),
// whether or not they still exist. PJSR cannot read another module's settings, so the file is read here.
export function configuredMarsFiles(api) {
  requireInstall(api);
  try {
    const xml = fs.readFileSync(api.platform.settingsPath, 'utf-8');
    return [...xml.matchAll(/<v k="MARSDatabaseFilePath\d+" t="s">([^<]+)<\/v>/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

function marsFilesFromSettings(api) {
  return configuredMarsFiles(api).filter((p) => fs.existsSync(p));
}

// The names a grouped curve name stands for: "Sony IMX411/455/461/533/571" -> "Sony IMX411",
// "Sony IMX455", ... A token is a group when the parts after its first slash start with a digit;
// they take the first part's leading non-digit prefix ("IMX"). A slash between words
// ("Canon Full Spectrum B / Antlia ALP-T") is not a group. Lowercased.
function groupedNames(name) {
  const tokens = name.split(/(\s+)/);
  const out = [];
  tokens.forEach((tok, i) => {
    const parts = tok.split('/');
    if (parts.length < 2 || !/\d/.test(parts[0]) || !parts.slice(1).every((x) => /^\d/.test(x))) return;
    const prefix = parts[0].replace(/\d.*$/, '');
    for (const part of [parts[0], ...parts.slice(1).map((x) => prefix + x)]) {
      out.push([...tokens.slice(0, i), part, ...tokens.slice(i + 1)].join('').toLowerCase());
    }
  });
  return out;
}

const findFilters = {
  name: 'find_filters',
  description: "Search PixInsight's built-in filter and camera QE database by name (case-insensitive substring). " +
    'A grouped name also matches each name it stands for ("Sony IMX411/455/461/533/571" matches "IMX455"); results are ordered exact name, then substring, then grouped-name matches. ' +
    'Use it to pick exact names for run_spfc or run_spcc. Sensor QE curves have channel Q.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'e.g. "Astronomik", "Ha", "IMX533", "Chroma"' },
      channel: { type: 'string', description: 'Optional: R, G, B, L, PAN (multiband OSC) or Q (sensor QE)' },
    },
  },
  async handler(api, input) {
    const query = (input.query || '').toLowerCase();
    const inChannel = loadFilterDb(api).filter((f) => !input.channel || f.channel === input.channel);
    const rank = (f) => {
      const name = f.name.toLowerCase();
      if (name === query) return 0;
      if (name.includes(query)) return 1;
      return groupedNames(f.name).some((g) => g.includes(query)) ? 2 : -1;
    };
    const hits = inChannel.map((f) => [rank(f), f]).filter(([r]) => r >= 0).sort((x, y) => x[0] - y[0]).map(([, f]) => f);
    const lines = hits.slice(0, 60).map((f) => `${f.name} [${f.channel}]`);
    return { text: `${hits.length} match(es)${hits.length > 60 ? ', showing 60' : ''}:\n${lines.join('\n')}` };
  },
};

const runSpfc = {
  name: 'run_spfc',
  description: 'Run SpectrophotometricFluxCalibration: writes the flux metadata that run_mgc requires. The image must be plate-solved and linear. ' +
    'Needs the camera QE curve (default "Ideal QE curve"; pass qe_name for the real sensor, see find_filters) and the filter curve. ' +
    `MONO image: pass filter (${bandNames}) and optionally filter_name (a measured curve from the database; otherwise a flat passband from wavelength_nm/bandwidth_nm is used). ` +
    'COLOR image: omit filter and pass red_filter_name, green_filter_name, blue_filter_name (otherwise flat R/G/B passbands).',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to calibrate' },
      filter: { type: 'string', description: `Mono only. One of ${bandNames}` },
      filter_name: { type: 'string', description: 'Mono: measured filter curve name from find_filters' },
      wavelength_nm: { type: 'number', description: 'Mono: filter center wavelength in nm, if filter_name is not given' },
      bandwidth_nm: { type: 'number', description: 'Mono: filter bandwidth in nm, if filter_name is not given' },
      qe_name: { type: 'string', description: 'Camera QE curve name (default "Ideal QE curve")' },
      red_filter_name: { type: 'string', description: 'Color: measured R filter curve name from find_filters' },
      green_filter_name: { type: 'string', description: 'Color: measured G filter curve name from find_filters' },
      blue_filter_name: { type: 'string', description: 'Color: measured B filter curve name from find_filters' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const PROC = 'SpectrophotometricFluxCalibration';
    const qe = findCurve(api, input.qe_name || 'Ideal QE curve', 'Q');
    let setup;
    let described;
    if (input.filter) {
      const band = BANDS[input.filter];
      if (!band) return { isError: true, text: `Unknown filter "${input.filter}". Use one of: ${bandNames}.` };
      const wl = num(input.wavelength_nm, band.wl);
      const bw = num(input.bandwidth_nm, band.bw);
      const curve = input.filter_name ? findCurve(api, input.filter_name) : null;
      setup = `P.narrowbandMode = ${band.nb ? 'true' : 'false'};
        P.grayFilterWavelength = ${wl}; P.grayFilterBandwidth = ${bw};
        P.grayFilterTrCurve = ${q(curve ? curve.data : boxCurve(wl, bw))};
        P.grayFilterName = ${q(curve ? curve.name : `${input.filter} passband ${wl}/${bw} nm`)};`;
      described = `${input.filter}: ${curve ? curve.name : `flat passband ${wl} nm, ${bw} nm wide`}`;
    } else {
      const chans = [['red', 'red_filter_name', 640], ['green', 'green_filter_name', 540], ['blue', 'blue_filter_name', 460]];
      const parts = chans.map(([c, key, wl]) => ({ c, curve: input[key] ? findCurve(api, input[key]) : null, wl }));
      setup = 'P.narrowbandMode = false;\n' + parts.map(({ c, curve, wl }) =>
        `P.${c}FilterTrCurve = ${q(curve ? curve.data : boxCurve(wl, 100))}; P.${c}FilterName = ${q(curve ? curve.name : `${c} passband ${wl}/100 nm`)};`).join('\n');
      described = parts.map(({ c, curve }) => `${c}: ${curve ? curve.name : 'flat passband'}`).join(', ');
    }
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.catalogId = 'GaiaDR3SP';
      ${setup}
      P.deviceQECurve = ${q(qe.data)}; P.deviceQECurveName = ${q(qe.name)};
      P.generateGraphs = false; P.generateTextFiles = false; P.generateStarMaps = false;
      __run(P, __w.mainView);`);
    return { text: `SPFC done. ${described}; QE: ${qe.name}.` };
  },
};

const runSpcc = {
  name: 'run_spcc',
  description: 'Run SpectrophotometricColorCalibration (SPCC). Requires the image to have an astrometric solution (run_plate_solve adds one) and to be linear (not stretched).',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to calibrate (must be linear, must have a WCS/astrometric solution)' },
      white_reference: { type: 'string', description: 'White reference name from PixInsight\'s database, e.g. "Average Spiral Galaxy", "G2V Star"' },
      narrowband_mode: { type: 'boolean', description: 'Enable narrowband mode (default false)' },
      white_reference_name: { type: 'string', description: 'Same as white_reference' },
      red_filter_name: { type: 'string', description: 'Measured R filter curve name, as listed by find_filters. Set all three filters and qe_name together for a full calibration.' },
      green_filter_name: { type: 'string', description: 'Measured G filter curve name, as listed by find_filters' },
      blue_filter_name: { type: 'string', description: 'Measured B filter curve name, as listed by find_filters' },
      qe_name: { type: 'string', description: 'Camera QE curve name (find_filters channel Q)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const PROC = 'SpectrophotometricColorCalibration';
    const narrowband = input.narrowband_mode ? 'true' : 'false';
    let curves = '';
    try {
      const set = (prop, nameProp, c) => `P.${prop} = ${q(c.data)}; P.${nameProp} = ${q(c.name)};`;
      if (input.red_filter_name) curves += set('redFilterTrCurve', 'redFilterName', findCurve(api, input.red_filter_name));
      if (input.green_filter_name) curves += set('greenFilterTrCurve', 'greenFilterName', findCurve(api, input.green_filter_name));
      if (input.blue_filter_name) curves += set('blueFilterTrCurve', 'blueFilterName', findCurve(api, input.blue_filter_name));
      if (input.qe_name) curves += set('deviceQECurve', 'deviceQECurveName', findCurve(api, input.qe_name, 'Q'));
      const w = input.white_reference_name || input.white_reference;
      if (w) { const ref = findWhiteReference(api, w); curves += set('whiteReferenceSpectrum', 'whiteReferenceName', ref); }
    } catch (e) {
      return { isError: true, text: `SPCC not run: ${e.message}` };
    }
    const r = await api.pjsr(`
      var P = new ${PROC};
      P.applyCalibration = true;
      P.narrowbandMode = ${narrowband};
      P.generateGraphs = false;
      P.generateStarMaps = false;
      P.generateTextFiles = false;
      P.backgroundNeutralizationEnabled = true;
      P.psfStructureLayers = 5;
      P.psfMinSNR = 10;
      P.psfAllowClusteredSources = true;
      P.psfType = 4;
      P.psfGrowth = 1.25;
      P.psfMaxStars = 4096;
      P.psfChannelSearchTolerance = 2;
      ${curves}
      var ok = P.executeOn(ImageWindow.windowById(${q(input.view_id)}).mainView);
      'SPCC_result=' + ok;
    `);
    const ok = (r.outputs?.consoleOutput || '').includes('true');
    if (!ok) {
      return { isError: true, text: `SPCC failed: ${r.outputs?.consoleOutput || r.error?.message}.` };
    }
    const stats = await statsOrEmpty(api, input.view_id);
    return { text: `SPCC complete. R=${stats.perChannel?.R?.median?.toFixed?.(6)}, G=${stats.perChannel?.G?.median?.toFixed?.(6)}, B=${stats.perChannel?.B?.median?.toFixed?.(6)}` };
  },
};

const runMgc = {
  name: 'run_mgc',
  description: 'Run MultiscaleGradientCorrection using the MARS reference database. The image must be plate-solved and linear; a mono image also needs the flux metadata run_spfc writes. ' +
    `For a mono image pass filter (${bandNames}); for a color image leave it out (R, G, B bands are used). MARS files default to the ones configured in PixInsight.`,
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to process' },
      filter: { type: 'string', description: `Mono only. One of ${bandNames}` },
      mars_files: { type: 'array', items: { type: 'string' }, description: 'Absolute .xmars paths (default: from PixInsight settings)' },
      gradient_scale: { type: 'number', description: 'Gradient scale in pixels (default 1024)' },
      structure_separation: { type: 'number', description: 'Structure separation (default 3)' },
      model_smoothness: { type: 'number', description: 'Model smoothness (default 1)' },
      show_model: { type: 'boolean', description: 'Also create the gradient model window' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const PROC = 'MultiscaleGradientCorrection';
    const files = input.mars_files?.length ? input.mars_files : marsFilesFromSettings(api);
    if (!files.length) return { isError: true, text: 'MGC FAILED: no MARS database files configured. Pass mars_files, or set them in PixInsight (Process > Global > MARS).' };
    const band = input.filter ? BANDS[input.filter] : null;
    if (input.filter && !band) return { isError: true, text: `Unknown filter "${input.filter}". Use one of: ${bandNames}.` };
    const before = await statsOrEmpty(api, input.view_id);
    await run(api, `${need(input.view_id)}
      var P = new ${PROC};
      P.useMARSDatabase = true;
      P.marsDatabaseFiles = ${JSON.stringify(files.map((f) => [true, toPixPath(f)]))};
      ${band ? `P.grayMARSFilter = ${q(band.mars)};` : ''}
      ${input.gradient_scale !== undefined ? `P.gradientScale = ${num(input.gradient_scale)};` : ''}
      ${input.structure_separation !== undefined ? `P.structureSeparation = ${num(input.structure_separation)};` : ''}
      ${input.model_smoothness !== undefined ? `P.modelSmoothness = ${num(input.model_smoothness)};` : ''}
      P.showGradientModel = ${input.show_model ? 'true' : 'false'};
      __run(P, __w.mainView);`);
    const after = await statsOrEmpty(api, input.view_id);
    return { text: `MGC done with ${files.length} MARS file(s). Before: median=${before.median?.toFixed?.(6)} After: median=${after.median?.toFixed?.(6)}` };
  },
};

export const tools = [
  runScnr, runGradientCorrection, runBackgroundNeutralization, runNxt, linearFit, runLhe,
  runBxt, runSxt, runAbe, runHdrmt, runCurves,
  findFilters, runSpfc, runSpcc, runMgc,
];
