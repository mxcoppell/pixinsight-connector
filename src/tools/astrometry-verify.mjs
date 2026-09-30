// ============================================================================
// verify_astrometry: PixInsight's own AstrometricSolutionVerifier measurement, run on an open view
// without its dialog. The script's engine class (AstrometricSolutionVerifierEngine.js) and the
// residuals library it extends (include/pjsr/astrometry/AstrometricResiduals.js) are read from the
// install and sent as one snippet, because PixInsight's preprocessor (#include, #define) does not run
// on the code this connector evaluates. Only the directives those two files use are translated:
// include guards are dropped and an object-like `#define NAME value` becomes `var NAME = value;`.
// Any other directive stops the call with its text, so a newer script layout fails loudly.
//
// Measured on PixInsight 1.9.5 build 1706 (AstrometricSolutionVerifier 1.0.0): engine.measure() runs
// detection, PSF fits, catalogue matching and the deviation statistics, and closes its own working
// image; engine.computeGrid() is the cell table. The script's report printing, deviation map, graphs
// and CSV export are not called, so no window, file or console table is produced.
// ============================================================================
import fs from 'node:fs';
import { PlatformError, installDirs } from '../platform.mjs';

const SENTINEL = '@@VERIFY@@';
const ENGINE_FILE = 'AstrometricSolutionVerifier/AstrometricSolutionVerifierEngine.js';
const MAIN_FILE = 'AstrometricSolutionVerifier/AstrometricSolutionVerifier.js';
const RESIDUALS_FILE = 'pjsr/astrometry/AstrometricResiduals.js';
// A grid cell needs this many matched stars to be the worst cell: a cell with one or two stars is noise.
const MIN_CELL_STARS = 3;

// Script text without the directives PixInsight's preprocessor would handle, see the header.
export function stripDirectives(text, name) {
  const out = [];
  for (const line of String(text).replace(/^\/\*[\s\S]*?\*\//gm, '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#')) {
      if (/^#(?:ifndef|endif|undef)\b/.test(t)) continue;
      const m = /^#define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/.exec(t);
      if (!m) throw new Error(`${name}: unsupported preprocessor line ${JSON.stringify(t)}`);
      if (m[2]) out.push(`var ${m[1]} = ${m[2].replace(/\s*\/\/.*$/, '')};`);
      continue;
    }
    if (t.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

function macroValue(text, macro, name) {
  const m = new RegExp(`^#define\\s+${macro}\\s+(.+?)\\s*$`, 'm').exec(text);
  if (!m) throw new Error(`${name}: no #define ${macro}`);
  return m[1];
}

// The script asks Gaia for "the best available" release, which is DR3, EDR3 or DR2 and never DR3/SP, so on
// an install whose only database is DR3/SP it stops with "The Gaia process is not working". The two
// lines below make it use DR3/SP when no other release is valid. Both must match the script's text; one
// that does not leaves the script as it is.
const BEST_RELEASE = 'xpsd.dataRelease = Gaia.DataRelease_BestAvailable;';
const DEFAULT_CASE = /\bdefault:\s*case Gaia\.DataRelease_3:/;

export function allowDr3Sp(residuals) {
  if (!residuals.includes(BEST_RELEASE) || !DEFAULT_CASE.test(residuals)) return residuals;
  return residuals
    .replace(BEST_RELEASE, () => 'xpsd.dataRelease = __gaiaRelease();')
    .replace(DEFAULT_CASE, (m) => `case Gaia.DataRelease_3_SP: catalog = new GaiaDR3SPXPSDCatalog(); break;\n      ${m}`);
}

const GAIA_RELEASE_PJSR = `function __gaiaRelease() {
  var g = new Gaia;
  g.verbosity = 0; g.command = 'get-info'; g.dataRelease = Gaia.DataRelease_BestAvailable;
  try { g.executeGlobal(); } catch (e) {}
  if (g.isValid) return Gaia.DataRelease_BestAvailable;
  var s = new Gaia;
  s.verbosity = 0; s.command = 'get-info'; s.dataRelease = Gaia.DataRelease_3_SP;
  try { s.executeGlobal(); } catch (e) {}
  return s.isValid ? Gaia.DataRelease_3_SP : Gaia.DataRelease_BestAvailable;
}`;

// The three script files, read from the install the api points at.
export function readVerifierSources(api) {
  if (api.platform.error) throw new PlatformError(api.platform.error);
  const { scriptsDir, includeDir } = installDirs(api.platform.imageSolverPath);
  const files = {
    engine: `${scriptsDir}/${ENGINE_FILE}`,
    main: `${scriptsDir}/${MAIN_FILE}`,
    residuals: `${includeDir}/${RESIDUALS_FILE}`,
  };
  for (const f of Object.values(files)) {
    if (!fs.existsSync(f)) {
      throw new Error(`AstrometricSolutionVerifier is not installed: ${f} does not exist. The script ships with PixInsight 1.9.5 and later.`);
    }
  }
  const main = fs.readFileSync(files.main, 'utf8');
  return {
    version: macroValue(main, 'VERSION', MAIN_FILE),
    settingsModule: macroValue(main, 'SETTINGS_MODULE', MAIN_FILE),
    residuals: allowDr3Sp(stripDirectives(fs.readFileSync(files.residuals, 'utf8'), RESIDUALS_FILE)),
    engine: stripDirectives(fs.readFileSync(files.engine, 'utf8'), ENGINE_FILE),
  };
}

const CONFIG_KEYS = {
  matching_tolerance: 'matchingTolerance',
  rejection_sigma: 'rejectionSigma',
  grid_cells: 'gridCells',
  auto_magnitude: 'autoMagnitude',
  magnitude: 'magnitude',
};

export function verifyScript(sources, viewId, config) {
  const o = { viewId: String(viewId), config, minCellStars: MIN_CELL_STARS };
  return `(function () {
var VERSION = ${sources.version};
var SETTINGS_MODULE = ${sources.settingsModule};
${GAIA_RELEASE_PJSR}
${sources.residuals}
${sources.engine}
var __o = ${JSON.stringify(o)};
var __res = {};
try {
  CoreApplication.ensureMinimumVersion(1, 9, 5);
  var __w = ImageWindow.windowById(__o.viewId);
  if (__w.isNull) throw new Error('View not found: ' + __o.viewId);
  var cfg = new VerifierConfiguration(SETTINGS_MODULE);
  cfg.mapMode = MapMode.None;
  cfg.showGraphs = false;
  cfg.saveMap = false;
  cfg.saveGraphs = false;
  cfg.csvFilePath = '';
  for (var k in __o.config) cfg[k] = __o.config[k];
  var eng = new AstrometricSolutionVerifier(cfg);
  var M = eng.measure(__w);
  var grid = eng.computeGrid(M.metadata, M.retained);
  var R = M.result;
  var pick = function (d) { return { median: d.median, sigma: d.sigma, rms: d.rms, p90: d.p90, p99: d.p99, max: d.max }; };
  var stat = function (S) {
    return { n: S.n, px: pick(S.px), arcsec: pick(S.as),
      bias: { dxPx: S.bias.dx, dyPx: S.bias.dy, draArcsec: S.bias.dra, ddecArcsec: S.bias.ddec } };
  };
  var worst = -1, withStars = 0;
  for (var i = 0; i < grid.cells.length; i++) {
    var c = grid.cells[i];
    if (c.n > 0) withStars++;
    if (c.n >= __o.minCellStars && (worst < 0 || c.as.median > grid.cells[worst].as.median)) worst = i;
  }
  var worstCell = null;
  if (worst >= 0) {
    var wc = grid.cells[worst], col = worst % grid.nx, row = Math.floor(worst / grid.nx);
    var x0 = col * grid.cellSize, x1 = Math.min((col + 1) * grid.cellSize, M.metadata.width);
    var y0 = row * grid.cellSize, y1 = Math.min((row + 1) * grid.cellSize, M.metadata.height);
    worstCell = { column: col, row: row, centerXPx: (x0 + x1) / 2, centerYPx: (y0 + y1) / 2, stars: wc.n,
      medianPx: wc.px.median, medianArcsec: wc.as.median, rmsArcsec: wc.as.rms, maxArcsec: wc.as.max };
  }
  __res = {
    verifier: VERSION,
    view: __o.viewId,
    widthPx: M.metadata.width, heightPx: M.metadata.height,
    arcsecPerPx: M.metadata.resolution * 3600,
    hasObservationTime: !!M.metadata.hasObservationTime,
    stars: {
      detected: R.numberOfDetectedStars, validPsfFits: R.numberOfValidPSFFits, medianFwhmPx: R.medianFWHM,
      conflictingRemoved: R.numberOfConflictingSources, usable: R.numberOfUsableStars,
      catalogInImage: R.numberOfCatalogStars, matched: R.numberOfMatchedStars,
      catalogUnmatched: R.numberOfUnmatchedCatalogStars, ambiguous: R.numberOfAmbiguousCatalogStars,
      blended: R.numberOfBlendedCatalogStars, rejectedBySigma: R.numberOfRejectedStars
    },
    catalog: { name: R.catalogName, limitMagnitude: R.limitMagnitude },
    rejectionThresholdArcsec: R.rejectionThreshold,
    retained: stat(R.retained),
    allMatched: stat(R.all),
    grid: { columns: grid.nx, rows: grid.ny, cellSizePx: grid.cellSize, cellsWithStars: withStars, minStarsForWorstCell: __o.minCellStars, worstCell: worstCell }
  };
} catch (err) {
  __res = { error: (err && err.message) ? err.message : String(err) };
}
return '${SENTINEL}' + JSON.stringify(__res);
})()`;
}

export function parseVerifyReply(reply) {
  if (reply.status === 'error') return { error: reply.error?.message || JSON.stringify(reply.error) };
  const text = `${reply.result ?? ''}\n${reply.outputs?.consoleOutput ?? ''}`;
  const i = text.lastIndexOf(SENTINEL);
  if (i < 0) return { error: `No result from the verifier snippet: ${text.slice(0, 200)}` };
  const end = text.indexOf('\n', i);
  try {
    return JSON.parse(text.slice(i + SENTINEL.length, end < 0 ? undefined : end));
  } catch (e) {
    return { error: `Unreadable verifier result: ${e.message}` };
  }
}

function numberInput(input, key, { min, max, integer = false, exclusiveMin = false }) {
  const v = input[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || (exclusiveMin ? n <= min : n < min) || (max !== undefined && n > max);
  if (bad) throw new Error(`verify_astrometry: ${key} must be ${integer ? 'an integer' : 'a number'} ${exclusiveMin ? 'above' : 'from'} ${min}${max !== undefined ? ` to ${max}` : ''}; got ${JSON.stringify(v)}`);
  return n;
}

const verifyAstrometry = {
  name: 'verify_astrometry',
  description: 'Measure how well an open image\'s astrometric solution reproduces the sky, with the engine of PixInsight\'s AstrometricSolutionVerifier script (PixInsight 1.9.5 or later), run without its dialog: no deviation map, graphs, files or new windows, and the image is not modified. ' +
    'Every detected star is PSF-fitted, placed on the sky with the image\'s solution and compared with its Gaia DR3 star at the observation time. ' +
    'The result (JSON) gives the star counts (detected, PSF-fitted, matched, rejected by sigma clipping), the catalogue and its limit magnitude, the deviations (median, sigma, rms, 90th and 99th percentile, maximum) in pixels and arcseconds over the stars kept after sigma clipping and over all matched stars, the median bias, ' +
    'and the grid cell with the largest median deviation (cells with fewer than 3 matched stars are skipped) with its column, row and centre in image pixels. The view needs an astrometric solution.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to verify' },
      matching_tolerance: { type: 'number', description: 'Maximum distance in pixels between a detected star and its catalogue position for a match (script default 3)' },
      rejection_sigma: { type: 'number', description: 'Sigma-clipping factor on the deviations; matched stars beyond median + factor x sigma are left out of the retained statistics and the grid, 0 disables (script default 5)' },
      grid_cells: { type: 'integer', description: 'Number of grid cells along the largest image dimension, 1 to 255 (script default 8)' },
      auto_magnitude: { type: 'boolean', description: 'Choose the catalogue limit magnitude automatically (script default true)' },
      magnitude: { type: 'number', description: 'Catalogue limit magnitude used when auto_magnitude is false (script default 16)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    input = input || {};
    const config = {};
    const tolerance = numberInput(input, 'matching_tolerance', { min: 0, exclusiveMin: true });
    const sigma = numberInput(input, 'rejection_sigma', { min: 0 });
    const cells = numberInput(input, 'grid_cells', { min: 1, max: 255, integer: true });
    const magnitude = numberInput(input, 'magnitude', { min: -10, max: 40 });
    if (tolerance !== undefined) config[CONFIG_KEYS.matching_tolerance] = tolerance;
    if (sigma !== undefined) config[CONFIG_KEYS.rejection_sigma] = sigma;
    if (cells !== undefined) config[CONFIG_KEYS.grid_cells] = cells;
    if (magnitude !== undefined) config[CONFIG_KEYS.magnitude] = magnitude;
    if (input.auto_magnitude !== undefined) config[CONFIG_KEYS.auto_magnitude] = input.auto_magnitude === true || input.auto_magnitude === 'true';

    let sources;
    try {
      sources = readVerifierSources(api);
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      return { isError: true, text: `Astrometry verification FAILED: ${e.message}` };
    }
    const reply = await api.pjsr(verifyScript(sources, input.view_id, config));
    // A user's Pause/Abort is passed on for the server to report, not turned into a failed verification.
    if (reply.status === 'error' && /MCP_ABORTED/.test(String(reply.error?.message))) throw new Error(reply.error.message);
    const out = parseVerifyReply(reply);
    if (out.error) return { isError: true, text: `Astrometry verification FAILED: ${String(out.error).replace(/\.$/, '')}.` };
    return { text: JSON.stringify(out, null, 2) };
  },
};

export const tools = [verifyAstrometry];
