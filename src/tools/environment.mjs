// ============================================================================
// inspect_environment: what this PixInsight installation has, asked of PixInsight itself.
//
// Measured on PixInsight 1.9.5 (2026-09-25):
//   - Gaia answers `command = "get-info"` per data release with isValid, its database files, the
//     magnitude range and whether mean spectra are present. A small `search` proves the files read.
//   - MultiscaleGradientCorrection has no query command, and a script cannot select its default
//     MARS files, so they come from configuredMarsFiles(). Each file is proven by one MGC run on a
//     temporary synthetic image carrying a hand-built astrometric solution and placeholder SPFC
//     properties. Its console log names a missing or corrupt file, and the number of reference
//     images it found for the probe position.
//   - BXT, NXT and SXT print "<Name> <version>, ML version <n>" and "Using gpu|cpu" when they run.
// A script captures a process's console text with console.beginLog()/endLog(). That also ends the
// watcher's own log for this command, which is intended: the errors caught here are results, not
// failures of the call.
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import { toPixPath } from '../platform.mjs';
import { configuredMarsFiles } from './processes.mjs';

const GAIA_RELEASES = [['DR2', 1], ['EDR3', 2], ['DR3', 3], ['DR3/SP', 4]];
const XTERMINATORS = ['BlurXTerminator', 'NoiseXTerminator', 'StarXTerminator'];
const SECTIONS = ['gaia', 'mars', 'xterminators', 'system'];
const q = (s) => JSON.stringify(String(s));

function parseReply(r, what) {
  if (r.status === 'error') throw new Error(`${what}: ${r.error?.message || JSON.stringify(r.error)}`);
  const raw = r.outputs?.consoleOutput ?? r.result ?? '';
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${what}: could not parse PJSR result as JSON (${e.message}): ${JSON.stringify(raw)}`);
  }
}

// Console log text as plain lines: markup and timestamps removed, blank lines dropped.
const LOG_LINES_PJSR = `
  function logLines(t) {
    return String(t).replace(/<[^>]+>/g, " ").split(/\\r?\\n/).map(function (s) {
      return s.replace(/^\\s*\\[\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\]\\s?/, "").replace(/\\s+$/, "");
    }).filter(function (s) { return s.length > 0; });
  }
`;

export function gaiaPjsr(ra, dec) {
  return `(function () {
  ${LOG_LINES_PJSR}
  var out = { pixinsight: null, installed: typeof Gaia === "function", releases: [], search: null };
  try {
    out.pixinsight = CoreApplication.versionMajor + "." + CoreApplication.versionMinor + "." + CoreApplication.versionRelease;
  } catch (e) {}
  if (!out.installed) return JSON.stringify(out);
  var rels = ${JSON.stringify(GAIA_RELEASES)};
  var firstValid = null;
  for (var i = 0; i < rels.length; i++) {
    var g = new Gaia;
    g.command = "get-info";
    g.dataRelease = rels[i][1];
    var ok = false, err = null;
    // A release with no files prints "No database files have been selected" as a console error.
    console.beginLog();
    try { ok = g.executeGlobal(); } catch (e) { err = String(e && e.message ? e.message : e); }
    var errLines = logLines(console.endLog()).filter(function (s) { return /^\\*\\*\\* Error/.test(s); });
    if (err === null && errLines.length) err = errLines.join(" ; ");
    var files = [];
    for (var j = 0; j < g.databaseFilePaths.length; j++) {
      var f = g.databaseFilePaths[j];
      files.push(String(f && f.length !== undefined && typeof f !== "string" ? f[0] : f));
    }
    out.releases.push({ release: rels[i][0], ok: ok, error: err, valid: !!g.isValid, files: files,
      magnitudeLow: g.databaseMagnitudeLow, magnitudeHigh: g.databaseMagnitudeHigh,
      meanSpectra: !!g.databaseHasMeanSpectrumData, spectrumStartNm: g.databaseSpectrumStart,
      spectrumStepNm: g.databaseSpectrumStep, spectrumCount: g.databaseSpectrumCount });
    if (g.isValid && firstValid === null) firstValid = i;
  }
  if (firstValid !== null) {
    var s = new Gaia;
    s.command = "search"; s.dataRelease = rels[firstValid][1];
    s.centerRA = ${Number(ra)}; s.centerDec = ${Number(dec)}; s.radius = 0.1;
    s.magnitudeLow = -2; s.magnitudeHigh = 14; s.generateTextOutput = false; s.verbosity = 0;
    var t0 = Date.now(), sok = false, serr = null;
    console.beginLog();
    try { sok = s.executeGlobal(); } catch (e) { serr = String(e && e.message ? e.message : e); }
    var sErrLines = logLines(console.endLog()).filter(function (x) { return /^\\*\\*\\* Error/.test(x); });
    if (serr === null && sErrLines.length) serr = sErrLines.join(" ; ");
    out.search = { release: rels[firstValid][0], ok: sok, error: serr, sources: s.sources.length, ms: Date.now() - t0 };
  }
  return JSON.stringify(out);
})()`;
}

export function marsPjsr(files, ra, dec) {
  return `(function () {
  ${LOG_LINES_PJSR}
  if (typeof MultiscaleGradientCorrection !== "function") return JSON.stringify({ installed: false, runs: [] });
  var files = ${JSON.stringify(files.map((f) => toPixPath(f)))};
  var ids = function () { return ImageWindow.windows.map(function (x) { return x.mainView.id; }); };
  var before = ids();
  var w = new ImageWindow(512, 512, 3, 32, true, true, "inspect_environment_mars");
  var v = w.mainView, runs = [];
  try {
    var s = 10 / 3600, m = new Matrix(2, 2);
    m.at(0, 0, -s); m.at(0, 1, 0); m.at(1, 0, 0); m.at(1, 1, -s);
    v.setPropertyValue("PCL:AstrometricSolution:ProjectionSystem", "Gnomonic");
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceCelestialCoordinates", new Vector([${Number(ra)}, ${Number(dec)}]));
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceImageCoordinates", new Vector([256, 256]));
    v.setPropertyValue("PCL:AstrometricSolution:LinearTransformationMatrix", m);
    v.setPropertyValue("PCL:AstrometricSolution:ReferenceNativeCoordinates", new Vector([0, 90]));
    v.setPropertyValue("PCL:AstrometricSolution:CelestialPoleNativeCoordinates", new Vector([180, ${Number(dec)}]));
    v.setPropertyValue("Observation:CelestialReferenceSystem", "ICRS");
    v.setPropertyValue("Observation:Equinox", 2000.0);
    w.regenerateAstrometricSolution();
    var three = function (x) { return new Vector([x, x, x]); };
    for (var i = 0; i < files.length; i++) {
      v.beginProcess(); v.image.fill(0.01); v.endProcess();
      // MGC consumes the SPFC properties, so they are set again for every run.
      v.setPropertyValue("PCL:SPFC:ScaleFactors", three(1e-3));
      v.setPropertyValue("PCL:SPFC:FWHMx", three(3));
      v.setPropertyValue("PCL:SPFC:FWHMy", three(3));
      v.setPropertyValue("PCL:SPFC:Sigmas", three(1e-5));
      v.setPropertyValue("PCL:SPFC:Counts", three(100));
      v.setPropertyValue("PCL:SPFC:NormalizationFactor", 1.0);
      v.setPropertyValue("PCL:SPFC:Version", "1.0");
      var P = new MultiscaleGradientCorrection;
      P.useMARSDatabase = true;
      P.showGradientModel = false;
      P.marsDatabaseFiles = [[true, files[i]]];
      processEvents();
      console.beginLog();
      var ok = false, err = null;
      try { ok = P.executeOn(v); } catch (e) { err = String(e && e.message ? e.message : e); }
      var kept = logLines(console.endLog()).filter(function (s) {
        return /reference image\\(s\\) available|^Filter identifier|^Number of integrated images|^\\*\\*\\* Error/.test(s);
      });
      runs.push({ file: files[i], ok: ok, error: err, log: kept });
    }
  } finally {
    ImageWindow.windows.forEach(function (x) {
      if (before.indexOf(x.mainView.id) < 0) x.forceClose();
    });
  }
  return JSON.stringify({ installed: true, runs: runs });
})()`;
}

export function xterminatorsPjsr() {
  return `(function () {
  ${LOG_LINES_PJSR}
  var names = ${JSON.stringify(XTERMINATORS)}, out = [];
  var w = null;
  // StarXTerminator opens a <view>_stars window; every window this probe creates is closed.
  var ids = function () { return ImageWindow.windows.map(function (x) { return x.mainView.id; }); };
  var before = ids();
  try {
    for (var i = 0; i < names.length; i++) {
      var C = this[names[i]];
      if (typeof C !== "function") { out.push({ name: names[i], installed: false }); continue; }
      if (w === null) {
        w = new ImageWindow(64, 64, 3, 32, true, true, "inspect_environment_xt");
        w.mainView.beginProcess(); w.mainView.image.fill(0.01); w.mainView.endProcess();
      }
      processEvents();
      console.beginLog();
      var ok = false, err = null;
      try { ok = new C().executeOn(w.mainView); } catch (e) { err = String(e && e.message ? e.message : e); }
      var lines = logLines(console.endLog()).filter(function (s) {
        return s.indexOf(names[i]) >= 0 || /ML version|^Using /i.test(s) || /error/i.test(s);
      });
      out.push({ name: names[i], installed: true, ok: ok, error: err, log: lines });
    }
  } finally {
    ImageWindow.windows.forEach(function (x) {
      if (before.indexOf(x.mainView.id) < 0) x.forceClose();
    });
  }
  return JSON.stringify(out);
}).call(this)`;
}

// One MGC run's console lines -> status of that MARS file at the probe position.
export function interpretMarsRun(run) {
  const text = (run.log || []).join('\n');
  const count = [...text.matchAll(/(\d+) reference image\(s\) available/g)].map((m) => Number(m[1]));
  // One search per colour filter; the least-covered filter decides.
  const referenceImages = count.length ? Math.min(...count) : null;
  let status;
  if (/does not exist/i.test(text)) status = 'missing';
  else if (/Invalid or corrupted XMARS file/i.test(text)) status = 'corrupt';
  else if (referenceImages !== null) status = 'readable';
  else status = 'unknown';
  const errors = (run.log || []).filter((l) => /^\*\*\* Error/.test(l));
  if (run.error) errors.push(run.error);
  return { file: run.file, status, referenceImages, errors };
}

// One XTerminator probe -> version, ML model version and device, each null when not printed.
export function interpretXterminator(p) {
  if (!p.installed) return { name: p.name, installed: false };
  const text = (p.log || []).join('\n');
  const ver = text.match(new RegExp(`${p.name}\\s+v?([\\d.]+)`));
  const ml = text.match(/ML version\s+([\d.]+)/i);
  const dev = text.match(/Using\s+(gpu|cpu)/i);
  return {
    name: p.name,
    installed: true,
    ran: p.ok === true,
    version: ver ? ver[1] : null,
    mlVersion: ml ? ml[1] : null,
    device: dev ? dev[1].toLowerCase() : null,
    log: p.log || [],
    ...(p.error ? { error: p.error } : {}),
  };
}

function systemInfo(api) {
  let workspaceFreeBytes = null;
  try {
    const st = fs.statfsSync(api.workspace.dir);
    workspaceFreeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    // Degrade, never fail: an unusable workspace or an OS without statfs leaves this unknown.
  }
  return { freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(), workspaceFreeBytes };
}

function validatePosition(input) {
  const hasRa = input.ra_deg !== undefined, hasDec = input.dec_deg !== undefined;
  if (hasRa !== hasDec) throw new Error('inspect_environment: give both ra_deg and dec_deg, or neither');
  if (!hasRa) return null;
  const ra = Number(input.ra_deg), dec = Number(input.dec_deg);
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360) throw new Error('inspect_environment: ra_deg must be in [0, 360)');
  if (!Number.isFinite(dec) || dec < -90 || dec > 90) throw new Error('inspect_environment: dec_deg must be in [-90, 90]');
  return { ra, dec };
}

export async function inspectEnvironment(api, input = {}) {
  const position = validatePosition(input);
  const sections = input.sections?.length ? input.sections : SECTIONS;
  for (const s of sections) if (!SECTIONS.includes(s)) throw new Error(`inspect_environment: unknown section ${q(s)}`);
  const probe = position ?? { ra: 0, dec: 0 };
  const out = { connectorVersion: api.connectorVersion, position };

  if (sections.includes('gaia')) {
    const g = parseReply(await api.pjsr(gaiaPjsr(probe.ra, probe.dec)), 'inspect_environment (gaia)');
    out.pixinsightVersion = g.pixinsight;
    out.gaia = { installed: g.installed, releases: g.releases, search: g.search };
  }
  if (sections.includes('mars')) {
    const files = input.mars_files?.length ? input.mars_files : configuredMarsFiles(api);
    if (!files.length) {
      out.mars = { source: 'settings', files: [], status: 'none-configured', results: [] };
    } else {
      const m = parseReply(await api.pjsr(marsPjsr(files, probe.ra, probe.dec)), 'inspect_environment (mars)');
      const results = m.installed ? m.runs.map(interpretMarsRun) : [];
      out.mars = {
        source: input.mars_files?.length ? 'input' : 'settings',
        mgcInstalled: m.installed,
        files,
        results,
        covered: position ? results.some((r) => r.referenceImages > 0) : null,
      };
    }
  }
  if (sections.includes('xterminators')) {
    const x = parseReply(await api.pjsr(xterminatorsPjsr()), 'inspect_environment (xterminators)');
    out.xterminators = x.map(interpretXterminator);
  }
  if (sections.includes('system')) out.system = systemInfo(api);
  return out;
}

const inspectEnvironmentTool = {
  name: 'inspect_environment',
  description:
    'Report what this PixInsight installation has, by asking PixInsight. gaia: Gaia get-info for DR2, EDR3, DR3 and DR3/SP ' +
    '(valid, database files, magnitude range, mean spectra) and a 0.1-degree search on the lowest valid release. ' +
    'mars: one MultiscaleGradientCorrection run per MARS file (from PixInsight settings, or mars_files) on a temporary ' +
    'synthetic plate-solved image; per file: readable, missing or corrupt, and how many MARS reference images cover the ' +
    'probe position. xterminators: BlurXTerminator, NoiseXTerminator and StarXTerminator run once each on a temporary ' +
    '64x64 image; reports version, ML model version and gpu/cpu from their console banner (null when not printed). ' +
    'system: free and total memory, free space on the workspace volume. Temporary images are closed; open images are ' +
    'not touched. Without ra_deg/dec_deg the probe position is RA 0, Dec 0 and coverage is reported as null.',
  inputSchema: {
    type: 'object',
    properties: {
      ra_deg: { type: 'number', description: 'Probe position right ascension, degrees [0, 360). Given with dec_deg.' },
      dec_deg: { type: 'number', description: 'Probe position declination, degrees [-90, 90]. Given with ra_deg.' },
      mars_files: { type: 'array', items: { type: 'string' }, description: 'Absolute .xmars paths to test instead of the configured ones' },
      sections: { type: 'array', items: { type: 'string', enum: SECTIONS }, description: 'Sections to run (default: all)' },
    },
  },
  async handler(api, input) {
    return { text: JSON.stringify(await inspectEnvironment(api, input ?? {}), null, 2) };
  },
};

export const tools = [inspectEnvironmentTool];
