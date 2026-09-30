import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { PlatformError } from '../src/platform.mjs';
import {
  tools, stripDirectives, allowDr3Sp, readVerifierSources, verifyScript, parseVerifyReply,
} from '../src/tools/astrometry-verify.mjs';

const verify = tools.find((t) => t.name === 'verify_astrometry');

// Stand-ins for the two files PixInsight 1.9.5 ships, with the same directives and the two lines
// allowDr3Sp looks for, and just enough behaviour to run the snippet the tool builds.
const RESIDUALS = `//
// license header
//
/*
 * A doc block at the start of a line.
 */
#ifndef __PJSR_AstrometricResiduals_js
#define __PJSR_AstrometricResiduals_js

#define ASTROMETRIC_RESIDUALS_MIN_STARS 6

var AstrometricResiduals = class
{
   constructor( config )
   {
      this.config = config;
   }

   selectCatalog( metadata, numberOfStars, result )
   {
      let xpsd = new Gaia;
      xpsd.command = "get-info";
      xpsd.dataRelease = Gaia.DataRelease_BestAvailable;
      xpsd.executeGlobal();
      if ( !xpsd.isValid )
         throw new Error( "The Gaia process is not working, probably because of a wrong database configuration." );
      let catalog;
      switch ( xpsd.outputDataRelease )
      {
      default:
      case Gaia.DataRelease_3:
         catalog = new GaiaDR3XPSDCatalog();
         break;
      }
      result.catalogName = catalog.name;
      result.limitMagnitude = 17.5;
      return catalog;
   }

   measure( targetWindow )
   {
      if ( !targetWindow.hasAstrometricSolution )
         throw new Error( "The image has no astrometric solution: " + targetWindow.mainView.id );
      let result = { numberOfMatchedStars: ASTROMETRIC_RESIDUALS_MIN_STARS * 100 };
      this.selectCatalog( {}, 0, result );
      Object.assign( result, { numberOfDetectedStars: 900, numberOfValidPSFFits: 850, medianFWHM: 3.1, numberOfConflictingSources: 5,
         numberOfUsableStars: 845, numberOfCatalogStars: 700, numberOfUnmatchedCatalogStars: 90, numberOfAmbiguousCatalogStars: 1,
         numberOfBlendedCatalogStars: 2, numberOfRejectedStars: 7, rejectionThreshold: 0.5 } );
      let S = ( n, med ) => ( { n: n, px: { median: med, sigma: 0.04, rms: 0.1, p90: 0.2, p99: 0.3, max: 0.4 },
                                as: { median: 1.5*med, sigma: 0.06, rms: 0.15, p90: 0.3, p99: 0.45, max: 0.6 },
                                bias: { dx: 0.001, dy: -0.002, dra: 0.003, ddec: -0.004 } } );
      result.all = S( 600, 0.08 );
      result.retained = S( 593, 0.07 );
      return { metadata: { width: 1000, height: 600, resolution: 2/3600, hasObservationTime: true }, result: result, matches: [], retained: [] };
   }
};

#endif   // __PJSR_AstrometricResiduals_js
`;

const ENGINE = `// engine
#define VERIFIER_MIN_STARS 6

var MapMode = class
{
   static None = 0;
   static FalseColor = 2;
};

var VerifierConfiguration = class extends PersistentObject
{
   constructor( module )
   {
      super( module );
      this.matchingTolerance = 3.0;
      this.rejectionSigma = 5.0;
      this.gridCells = 8;
      this.autoMagnitude = true;
      this.magnitude = 16;
      this.mapMode = MapMode.FalseColor;
      this.showGraphs = true;
      this.saveMap = true;
      this.saveGraphs = true;
      this.csvFilePath = "out.csv";
      this.version = VERSION;
   }
};

var AstrometricSolutionVerifier = class extends AstrometricResiduals
{
   computeGrid( metadata, matches )
   {
      let cell = ( n, med ) => ( { n: n, px: { median: med, rms: 0.1, max: 0.2 }, as: { median: 2*med, rms: 0.2, max: 0.4 } } );
      // The second cell is the largest median but has only two stars; the fourth is the largest with enough.
      return { nx: 2, ny: 2, cellSize: 500, cells: [ cell( 40, 0.05 ), cell( 2, 0.9 ), cell( 0, 0 ), cell( 12, 0.2 ) ] };
   }
};
`;

const MAIN = `#engine v8
#feature-id    AstrometricSolutionVerifier : Astrometry > AstrometricSolutionVerifier
CoreApplication.ensureMinimumVersion( 1, 9, 5 );
#define VERSION "1.0.0"
#define TITLE "AstrometricSolutionVerifier"
#define SETTINGS_MODULE "AstrometricSolutionVerifier"
#include <pjsr/astrometry/AstrometricResiduals.js>
`;

// An install folder holding those files in the layout of every OS, plus an ImageSolver path inside it.
function fixtureInstall(t, { files = { residuals: RESIDUALS, engine: ENGINE, main: MAIN } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixinsight-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  if (files.residuals !== undefined) put('include/pjsr/astrometry/AstrometricResiduals.js', files.residuals);
  if (files.engine !== undefined) put('src/scripts/AstrometricSolutionVerifier/AstrometricSolutionVerifierEngine.js', files.engine);
  if (files.main !== undefined) put('src/scripts/AstrometricSolutionVerifier/AstrometricSolutionVerifier.js', files.main);
  const imageSolverPath = path.join(root, 'src/scripts/ImageSolver/ImageSolver.js').replace(/\\/g, '/');
  return { root, imageSolverPath };
}

const apiWith = (ctx, imageSolverPath) => {
  const api = apiFrom(ctx);
  api.platform = { ...api.platform, imageSolverPath };
  return api;
};

// Runs the snippet against stand-in PixInsight globals; `releases` are the Gaia releases that are valid.
function runSnippet(code, { releases = [3], hasSolution = true, viewFound = true } = {}) {
  const Gaia = class {
    executeGlobal() { this.isValid = releases.includes(this.dataRelease === 0 ? 3 : this.dataRelease); this.outputDataRelease = this.dataRelease === 0 ? 3 : this.dataRelease; }
  };
  Object.assign(Gaia, { DataRelease_BestAvailable: 0, DataRelease_3: 3, DataRelease_3_SP: 4 });
  const catalog = (name) => class { get name() { return name; } };
  const sandbox = {
    Gaia,
    GaiaDR3XPSDCatalog: catalog('Gaia DR3 (XPSD)'),
    GaiaDR3SPXPSDCatalog: catalog('Gaia DR3/SP (XPSD)'),
    PersistentObject: class { constructor(module) { this.module = module; } },
    CoreApplication: { ensureMinimumVersion: () => {} },
    ImageWindow: { windowById: (id) => (viewFound ? { isNull: false, hasAstrometricSolution: hasSolution, mainView: { id } } : { isNull: true }) },
    captured: null,
  };
  const out = vm.runInNewContext(code, sandbox);
  return JSON.parse(out.slice(out.indexOf('@@VERIFY@@') + '@@VERIFY@@'.length));
}

// --- the directive translation ---

test('stripDirectives drops include guards, comments and start-of-line doc blocks, and turns #define into var', () => {
  const out = stripDirectives(RESIDUALS, 'r.js');
  assert.doesNotMatch(out, /^\s*#/m);
  assert.doesNotMatch(out, /license header|A doc block/);
  assert.match(out, /^var ASTROMETRIC_RESIDUALS_MIN_STARS = 6;$/m);
  assert.doesNotMatch(out, /__PJSR_AstrometricResiduals_js/, 'the value-less guard #define produces nothing');
  assert.match(stripDirectives('#define NAME "v" // note\n', 'x.js'), /^var NAME = "v";$/m);
});

test('stripDirectives stops on a directive it does not translate, naming it', () => {
  assert.throws(() => stripDirectives('#include <pjsr/x.js>\n', 'engine.js'), /engine\.js: unsupported preprocessor line "#include <pjsr\/x\.js>"/);
  assert.throws(() => stripDirectives('#ifdef FOO\n', 'engine.js'), /unsupported preprocessor line/);
  assert.throws(() => stripDirectives('#define SQUARE(x) ((x)*(x))\n', 'engine.js'), /unsupported preprocessor line/);
});

test('allowDr3Sp patches the release request and the catalogue switch, and leaves a changed script alone', () => {
  const patched = allowDr3Sp(stripDirectives(RESIDUALS, 'r.js'));
  assert.match(patched, /xpsd\.dataRelease = __gaiaRelease\(\);/);
  assert.doesNotMatch(patched, /DataRelease_BestAvailable/);
  assert.match(patched, /case Gaia\.DataRelease_3_SP: catalog = new GaiaDR3SPXPSDCatalog\(\); break;\s*default:\s*case Gaia\.DataRelease_3:/);
  const changed = 'xpsd.dataRelease = Gaia.DataRelease_Latest;\nswitch (x) { default: case Gaia.DataRelease_3: }';
  assert.equal(allowDr3Sp(changed), changed, 'an unrecognised script is not touched');
  const onlyOne = 'xpsd.dataRelease = Gaia.DataRelease_BestAvailable;\nswitch (x) { case 1: }';
  assert.equal(allowDr3Sp(onlyOne), onlyOne, 'both lines must match or neither is changed');
});

// --- reading the install ---

test('readVerifierSources reads the three files of the install the platform points at', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const src = readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath));
  assert.equal(src.version, '"1.0.0"');
  assert.equal(src.settingsModule, '"AstrometricSolutionVerifier"');
  assert.match(src.engine, /var VERIFIER_MIN_STARS = 6;/);
  assert.match(src.residuals, /__gaiaRelease\(\)/);
});

test('readVerifierSources says which file is missing, and that the script needs PixInsight 1.9.5', (t) => {
  const { imageSolverPath } = fixtureInstall(t, { files: { residuals: RESIDUALS, main: MAIN } });
  assert.throws(() => readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath)),
    /AstrometricSolutionVerifier is not installed: .*AstrometricSolutionVerifierEngine\.js does not exist\. The script ships with PixInsight 1\.9\.5 and later\./);
});

test('readVerifierSources reports a missing install as the held platform error', () => {
  const api = apiFrom(createFakeBridge().ctx, { platform: { error: 'Could not find a PixInsight installation' } });
  assert.throws(() => readVerifierSources(api), (e) => e instanceof PlatformError && /Could not find/.test(e.message));
});

// --- the snippet ---

test('the generated snippet parses, and is one expression whose value is the sentinel result', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const code = verifyScript(readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath)), 'V1', {});
  assert.doesNotThrow(() => new vm.Script(code));
  assert.ok(code.startsWith('(function () {') && code.endsWith('})()'));
  assert.doesNotMatch(code, /^\s*#/m, 'no preprocessor directive reaches PixInsight');
});

test('the snippet runs the measurement with the dialog outputs off and reports the result', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const src = readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath));
  const res = runSnippet(verifyScript(src, 'L', { matchingTolerance: 2, gridCells: 4 }));
  assert.equal(res.error, undefined);
  assert.equal(res.verifier, '1.0.0');
  assert.equal(res.view, 'L');
  assert.equal(res.arcsecPerPx, 2);
  assert.deepEqual([res.widthPx, res.heightPx, res.hasObservationTime], [1000, 600, true]);
  assert.deepEqual(res.stars, {
    detected: 900, validPsfFits: 850, medianFwhmPx: 3.1, conflictingRemoved: 5, usable: 845, catalogInImage: 700,
    matched: 600, catalogUnmatched: 90, ambiguous: 1, blended: 2, rejectedBySigma: 7,
  });
  assert.equal(res.rejectionThresholdArcsec, 0.5);
  assert.equal(res.retained.n, 593);
  assert.equal(res.retained.px.median, 0.07);
  assert.ok(Math.abs(res.retained.arcsec.median - 0.105) < 1e-12);
  assert.deepEqual(Object.keys(res.retained.px), ['median', 'sigma', 'rms', 'p90', 'p99', 'max']);
  assert.deepEqual(res.retained.bias, { dxPx: 0.001, dyPx: -0.002, draArcsec: 0.003, ddecArcsec: -0.004 });
  assert.equal(res.allMatched.n, 600);
});

test('the snippet turns the map, graphs, files and csv off, and applies only the configuration it is given', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const src = readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath));
  const code = verifyScript(src, 'L', { matchingTolerance: 2 });
  assert.match(code, /cfg\.mapMode = MapMode\.None;\s*cfg\.showGraphs = false;\s*cfg\.saveMap = false;\s*cfg\.saveGraphs = false;\s*cfg\.csvFilePath = '';/);
  assert.match(code, /"config":\{"matchingTolerance":2\}/);
  assert.doesNotMatch(code, /printReport|generateMap|generateGraphs|writeCSV/, 'none of the script\'s output steps is called');
});

test('the worst grid cell is the largest median among cells with at least 3 stars, located in image pixels', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const src = readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath));
  const { grid } = runSnippet(verifyScript(src, 'L', {}));
  assert.deepEqual(grid, {
    columns: 2, rows: 2, cellSizePx: 500, cellsWithStars: 3, minStarsForWorstCell: 3,
    worstCell: { column: 1, row: 1, centerXPx: 750, centerYPx: 550, stars: 12, medianPx: 0.2, medianArcsec: 0.4, rmsArcsec: 0.2, maxArcsec: 0.4 },
  });
});

test('an install whose only Gaia database is DR3/SP still verifies, with that catalogue; one with none says so', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const src = readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath));
  const code = verifyScript(src, 'L', {});
  assert.equal(runSnippet(code, { releases: [4] }).catalog.name, 'Gaia DR3/SP (XPSD)');
  assert.equal(runSnippet(code, { releases: [3, 4] }).catalog.name, 'Gaia DR3 (XPSD)', 'DR3 is kept when it is available');
  assert.match(runSnippet(code, { releases: [] }).error, /Gaia process is not working/);
});

test('the snippet reports a missing view and an image with no solution as errors, not a result', (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const code = verifyScript(readVerifierSources(apiWith(createFakeBridge().ctx, imageSolverPath)), 'L', {});
  assert.match(runSnippet(code, { viewFound: false }).error, /View not found: L/);
  assert.match(runSnippet(code, { hasSolution: false }).error, /The image has no astrometric solution: L/);
});

// --- the tool ---

const RESULT = { verifier: '1.0.0', view: 'L', retained: { n: 10 }, grid: { worstCell: null } };
const sentinel = (o) => '@@VERIFY@@' + JSON.stringify(o);

test('verify_astrometry sends one snippet and returns the result as JSON text', async (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const { ctx, emitted } = createFakeBridge({ replies: [sentinel(RESULT)] });
  const out = await verify.handler(apiWith(ctx, imageSolverPath), { view_id: 'L', rejection_sigma: 0, grid_cells: 6, auto_magnitude: false, magnitude: 18 });
  assert.equal(emitted.length, 1);
  assert.notEqual(out.isError, true);
  assert.deepEqual(JSON.parse(out.text), RESULT);
  assert.match(emitted[0], /"config":\{"rejectionSigma":0,"gridCells":6,"magnitude":18,"autoMagnitude":false\}/);
});

test('verify_astrometry reports a failed measurement as an error result', async (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const { ctx } = createFakeBridge({ replies: [sentinel({ error: 'The image has no astrometric solution: L' })] });
  const out = await verify.handler(apiWith(ctx, imageSolverPath), { view_id: 'L' });
  assert.equal(out.isError, true);
  assert.equal(out.text, 'Astrometry verification FAILED: The image has no astrometric solution: L.');
});

test('verify_astrometry reports a missing script before sending anything, and a missing install as the platform error', async (t) => {
  const { imageSolverPath } = fixtureInstall(t, { files: {} });
  const { ctx, emitted } = createFakeBridge();
  const out = await verify.handler(apiWith(ctx, imageSolverPath), { view_id: 'L' });
  assert.equal(out.isError, true);
  assert.match(out.text, /is not installed/);
  assert.equal(emitted.length, 0);
  await assert.rejects(verify.handler(apiFrom(createFakeBridge().ctx, { platform: { error: 'no install' } }), { view_id: 'L' }), PlatformError);
});

test('verify_astrometry passes a Pause/Abort on instead of reporting a failed verification', async (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'Script error: MCP_ABORTED: Pause/Abort was pressed' } }] });
  const out = await verify.handler(apiWith(ctx, imageSolverPath), { view_id: 'L' }).then((r) => r, (e) => e);
  const text = out instanceof Error ? out.message : out.text;
  assert.match(text, /MCP_ABORTED/);
  assert.ok(out instanceof Error, 'thrown, so the server maps it to STOPPED BY USER');
});

test('verify_astrometry refuses input that is out of range before anything is sent', async (t) => {
  const { imageSolverPath } = fixtureInstall(t);
  const { ctx, emitted } = createFakeBridge();
  const api = apiWith(ctx, imageSolverPath);
  await assert.rejects(verify.handler(api, { view_id: 'L', matching_tolerance: 0 }), /matching_tolerance must be a number above 0/);
  await assert.rejects(verify.handler(api, { view_id: 'L', rejection_sigma: -1 }), /rejection_sigma/);
  await assert.rejects(verify.handler(api, { view_id: 'L', grid_cells: 2.5 }), /grid_cells must be an integer/);
  await assert.rejects(verify.handler(api, { view_id: 'L', grid_cells: 300 }), /grid_cells/);
  assert.equal(emitted.length, 0);
});

test('parseVerifyReply takes the last sentinel, so console text before it does not matter', () => {
  const noisy = `Detecting stars...\n${sentinel({ a: 1 })}\nmore\n${sentinel({ a: 2 })}`;
  assert.deepEqual(parseVerifyReply({ status: 'ok', result: noisy }), { a: 2 });
  assert.match(parseVerifyReply({ status: 'ok', result: 'nothing' }).error, /No result from the verifier snippet/);
  assert.match(parseVerifyReply({ status: 'ok', result: '@@VERIFY@@{oops' }).error, /Unreadable verifier result/);
  assert.equal(parseVerifyReply({ status: 'error', error: { message: 'boom' } }).error, 'boom');
});

test('the tool states what it does and stays within the descriptor rules', () => {
  assert.deepEqual(verify.inputSchema.required, ['view_id']);
  assert.match(verify.description, /AstrometricSolutionVerifier/);
  assert.match(verify.description, /not modified/);
  for (const p of Object.values(verify.inputSchema.properties)) assert.ok(p.description.length > 10);
});

// --- against the files PixInsight really ships, when this machine has them ---

const realRoot = [process.env.PIXINSIGHT_DIR, '/Applications/PixInsight', 'C:/Program Files/PixInsight', '/opt/PixInsight']
  .find((r) => r && fs.existsSync(`${r}/src/scripts/AstrometricSolutionVerifier/AstrometricSolutionVerifierEngine.js`));

test('the real AstrometricSolutionVerifier files translate to a script that parses', { skip: realRoot ? false : 'no PixInsight 1.9.5 install here' }, () => {
  const api = apiFrom(createFakeBridge().ctx);
  api.platform = { ...api.platform, imageSolverPath: `${realRoot}/src/scripts/ImageSolver/ImageSolver.js` };
  const src = readVerifierSources(api);
  assert.match(src.residuals, /__gaiaRelease\(\)/, 'the release patch applies to the shipped script');
  assert.match(src.residuals, /GaiaDR3SPXPSDCatalog/);
  assert.doesNotThrow(() => new vm.Script(verifyScript(src, 'V', {})));
});
