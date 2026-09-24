// ============================================================================
// Plate solving and astrometric-solution transfer. Ported from
// v0-pipeline:agents/ops/astrometry.mjs and v0-pipeline:agents/llm/tools.mjs. ImageSolver is a script
// class the watcher already includes — there is no executeOn() for it.
// ============================================================================
import { toPixPath } from '../platform.mjs';

const q = (s) => JSON.stringify(String(s));
const SENTINEL = '@@SOLVE@@';

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// Models often fill optional numeric parameters with 0; for these fields 0 means "not given".
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };

function plateSolveScript(opts) {
  const o = {
    viewId: String(opts.viewId),
    ra: num(opts.raDeg),
    dec: num(opts.decDeg),
    scale: pos(opts.pixelScale),
    focal: pos(opts.focalMm),
    pixsz: pos(opts.pixelSizeUm),
    jd: pos(opts.jd),
    starsDir: opts.starsDir,
  };
  return `
    var __o = ${JSON.stringify(o)};
    var __res = { solved: false };
    try {
      var w = ImageWindow.windowById(__o.viewId);
      if (w.isNull) throw new Error('View not found: ' + __o.viewId);
      var t0 = Date.now();
      var e = new ImageSolver();
      e.initialize(w, false);
      // initialize() loads the settings last saved in the ImageSolver window. Its output options
      // would write <name>_model.csv beside the source file (or open a Save dialog for a view with
      // no file, which blocks the bridge) and open extra windows, so they are turned off here.
      var c = e.solverCfg;
      c.generateDistortModel = false;
      c.showStars = false;
      c.showStarMatches = false;
      c.showDistortion = false;
      c.showSimplifiedSurfaces = false;
      c.generateErrorImg = false;
      var m = e.metadata;
      if (__o.ra !== null) m.ra = __o.ra;
      if (__o.dec !== null) m.dec = __o.dec;
      if (__o.pixsz !== null) m.xpixsz = __o.pixsz;
      if (__o.focal !== null) { m.focal = __o.focal; m.useFocal = true; m.resolution = m.ResolutionFromFocal(__o.focal); }
      else if (__o.scale !== null) { m.useFocal = false; m.resolution = __o.scale / 3600; }
      // Assigned last and always: setting other metadata can clear it, and the XPSD server refuses to run without it.
      var jd = __o.jd;
      if (jd === null) {
        var kw = w.keywords;
        for (var i = 0; i < kw.length && jd === null; i++) {
          if (kw[i].name === 'DATE-OBS' || kw[i].name === 'DATE') {
            var ms = Date.parse(String(kw[i].value).replace(/'/g, '').trim());
            if (!isNaN(ms)) jd = ms / 86400000 + 2440587.5;
          }
        }
        if (jd === null) jd = Date.now() / 86400000 + 2440587.5;
      }
      m.observationTime = jd;
      if (m.ra === undefined || m.ra === null || isNaN(m.ra) || m.dec === undefined || m.dec === null || isNaN(m.dec))
        throw new Error('No RA/Dec seed: pass ra_deg and dec_deg (approximate is fine, within a fraction of the field).');
      if (!(m.resolution > 0)) throw new Error('No scale seed: pass pixel_scale (arcsec/px) or focal_length_mm + pixel_size_um.');
      e.solverCfg.catalogMode = CatalogMode.LocalXPSDServer;
      e.solverCfg.catalog = 'GaiaDR3SP_XPSD';
      // The star lists ImageSolver hands StarAlignment go under scratchDir instead of PixInsight's
      // temp folder; the library's own path function is put back afterwards.
      if (!File.directoryExists(__o.starsDir)) File.createDirectory(__o.starsDir, true);
      var __starsPath = ImageSolver.starsCSVFilePath;
      ImageSolver.starsCSVFilePath = function (isTarget) {
        return __o.starsDir + (isTarget ? '/stars-t.csv' : '/stars-r.csv');
      };
      try {
        e.solveImage(w);
      } finally {
        ImageSolver.starsCSVFilePath = __starsPath;
      }
      __res.solved = !!w.hasAstrometricSolution;
      __res.seconds = (Date.now() - t0) / 1000;
      if (__res.solved) {
        __res.summary = w.astrometricSolutionSummary().split('\\n').filter(function (l) {
          return /Reference catalog|Resolution|Rotation|Projection origin|Control points|Observation/.test(l);
        }).map(function (l) { return l.replace(/\\s*\\.{2,}\\s*/, ': ').trim(); });
      }
    } catch (err) {
      __res.error = (err && err.message) ? err.message : String(err);
    }
    '${SENTINEL}' + JSON.stringify(__res);
  `;
}

function parsePlateSolveResult(text) {
  const s = String(text || '');
  const i = s.lastIndexOf(SENTINEL);
  if (i < 0) return { solved: false, error: 'No result from the solver snippet: ' + s.slice(0, 200) };
  try {
    return JSON.parse(s.slice(i + SENTINEL.length));
  } catch (e) {
    return { solved: false, error: 'Unreadable solver result: ' + e.message };
  }
}

const runPlateSolve = {
  name: 'run_plate_solve',
  description: 'Plate solve an open image with ImageSolver against the local Gaia DR3/SP database (offline). Adds the astrometric solution needed by run_spfc, run_mgc and run_spcc. Needs an approximate position (ra_deg, dec_deg; within a fraction of the field is enough) and scale (pixel_scale in arcsec/px, or focal_length_mm + pixel_size_um) unless the image keywords already carry RA, DEC and FOCALLEN/XPIXSZ. The scale seed may be off by about 2x. Observation time is read from DATE-OBS/DATE, else today.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to plate solve' },
      ra_deg: { type: 'number', description: 'Approximate center RA in degrees' },
      dec_deg: { type: 'number', description: 'Approximate center Dec in degrees' },
      pixel_scale: { type: 'number', description: 'Approximate pixel scale in arcsec/pixel' },
      focal_length_mm: { type: 'number', description: 'Focal length in mm (use with pixel_size_um instead of pixel_scale)' },
      pixel_size_um: { type: 'number', description: 'Pixel size in microns' },
      observation_jd: { type: 'number', description: 'Julian date of the observation (only if no DATE-OBS/DATE keyword)' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const r = await api.pjsr(plateSolveScript({
      viewId: input.view_id,
      raDeg: input.ra_deg, decDeg: input.dec_deg,
      pixelScale: input.pixel_scale, focalMm: input.focal_length_mm, pixelSizeUm: input.pixel_size_um,
      jd: input.observation_jd,
      starsDir: toPixPath(api.workspace.scratchDir) + '/tmp_platesolve',
    }));
    const out = r.status === 'error' ? { solved: false, error: r.error?.message || JSON.stringify(r.error) } : parsePlateSolveResult(r.result);
    if (!out.solved) {
      return { isError: true, text: `Plate solve FAILED: ${(out.error || 'no solution found').replace(/\.$/, '')}.` };
    }
    return { text: `Plate solve OK in ${out.seconds}s.\n${(out.summary || []).join('\n')}` };
  },
};

const copyAstrometricSolution = {
  name: 'copy_astrometric_solution',
  description: 'Copy the astrometric solution (WCS) and observation keywords from a source image file to a target view. Source and target must have the same dimensions; the target\'s pixels are unchanged.',
  inputSchema: {
    type: 'object',
    properties: {
      source_file: { type: 'string', description: 'Absolute path to the source image file that carries the WCS' },
      target_id: { type: 'string', description: 'Target view ID to receive the WCS' },
    },
    required: ['source_file', 'target_id'],
  },
  async handler(api, input) {
    const r = await api.pjsr(`
      var srcPath = ${q(toPixPath(input.source_file))};
      var tgtW = ImageWindow.windowById(${q(input.target_id)});
      if (tgtW.isNull) throw new Error('Target not found: ' + ${q(input.target_id)});

      // Check file exists BEFORE opening (avoids modal popup on missing file)
      if (!File.exists(srcPath)) throw new Error('Source file not found: ' + srcPath);

      var before = {};
      var preW = ImageWindow.windows;
      for (var b = 0; b < preW.length; b++) before[preW[b].mainView.id] = true;

      var wins = ImageWindow.open(srcPath);
      if (!wins || wins.length === 0) throw new Error('Cannot open source: ' + srcPath);
      var srcW = wins[0];

      // Close the crop masks the source brought along, and only those
      var allW = ImageWindow.windows;
      for (var i = 0; i < allW.length; i++) {
        var cid = allW[i].mainView.id;
        if (!before[cid] && cid.indexOf('crop_mask') >= 0) allW[i].forceClose();
      }

      var info = '';
      if (!srcW.hasAstrometricSolution) {
        info = 'WARNING: source has no astrometric solution';
      } else {
        // Check dimension match — WCS is dimension-specific
        var sw = srcW.mainView.image.width, sh = srcW.mainView.image.height;
        var tw = tgtW.mainView.image.width, th = tgtW.mainView.image.height;
        if (sw !== tw || sh !== th) {
          info = 'WARNING: dimension mismatch (source ' + sw + 'x' + sh + ' vs target ' + tw + 'x' + th + '). WCS not copied.';
        } else {
          tgtW.copyAstrometricSolution(srcW);
          info = 'Astrometric solution copied (hasAstro=' + tgtW.hasAstrometricSolution + ')';
        }
      }

      // Copy observation keywords (BXT may have cleared them)
      var rKW = srcW.keywords, tKW = tgtW.keywords;
      var copyNames = ['DATE-OBS','DATE-END','OBSGEO-L','OBSGEO-B','OBSGEO-H',
                       'LONG-OBS','LAT-OBS','ALT-OBS','EXPTIME','TELESCOP','INSTRUME','OBJECT',
                       'FOCALLEN','XPIXSZ','YPIXSZ','RA','DEC','OBJCTRA','OBJCTDEC'];
      var copied = [];
      for (var k = 0; k < copyNames.length; k++) {
        var name = copyNames[k], exists = false;
        for (var j = 0; j < tKW.length; j++) { if (tKW[j].name === name) { exists = true; break; } }
        if (!exists) {
          for (var m = 0; m < rKW.length; m++) {
            if (rKW[m].name === name) { tKW.push(new FITSKeyword(rKW[m].name, rKW[m].value, rKW[m].comment)); copied.push(name); break; }
          }
        }
      }
      tgtW.keywords = tKW;

      // Copy XISF observation properties
      var obsProps = ['Observation:Time:Start','Observation:Time:End',
        'Observation:Location:Longitude','Observation:Location:Latitude','Observation:Location:Elevation'];
      for (var p = 0; p < obsProps.length; p++) {
        try { var v = srcW.mainView.propertyValue(obsProps[p]); var t = srcW.mainView.propertyType(obsProps[p]);
          if (v !== undefined && v !== null) tgtW.mainView.setPropertyValue(obsProps[p], v, t); } catch(e) {}
      }

      info += '. Keywords copied: ' + copied.join(',');
      srcW.forceClose();
      info;
    `);
    if (r.status === 'error') return { isError: true, text: `WCS not copied: ${r.error?.message ?? JSON.stringify(r.error)}` };
    const info = String(r.outputs?.consoleOutput ?? '');
    // The snippet reports a copy it declined (no solution in the source, a size mismatch) as a
    // WARNING line rather than throwing, so the observation keywords are still copied: the WCS
    // itself did not apply, which is a failure to report.
    if (/^WARNING/.test(info)) return { isError: true, text: info };
    return { text: info || 'Astrometric solution copied.' };
  },
};

export const tools = [runPlateSolve, copyAstrometricSolution];
