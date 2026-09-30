import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import {
  tools, inspectEnvironment, gaiaPjsr, marsPjsr, xterminatorsPjsr, processesPjsr, scriptVersions, interpretMarsRun, interpretXterminator,
} from '../src/tools/environment.mjs';
import { PlatformError } from '../src/platform.mjs';

// Replies captured from PixInsight 1.9.5 on 2026-09-25 (logs trimmed the way marsPjsr trims them).
const GAIA_REPLY = {
  pixinsight: '1.9.5', installed: true, search: { release: 'DR3/SP', ok: true, error: null, sources: 12, ms: 156 },
  releases: [
    { release: 'DR2', ok: true, error: '*** Error: No database files have been selected.', valid: false, files: [], magnitudeLow: 0, magnitudeHigh: 0, meanSpectra: false, spectrumStartNm: 0, spectrumStepNm: 0, spectrumCount: 0 },
    { release: 'DR3/SP', ok: true, error: null, valid: true, files: ['/db/gdr3sp-1.0.0-s-01.xpsd'], magnitudeLow: -2, magnitudeHigh: 25.59, meanSpectra: true, spectrumStartNm: 336, spectrumStepNm: 2, spectrumCount: 343 },
  ],
};
const MARS_RUN_OK = {
  file: '/db/MARS-DR2-1.0.3-s08.xmars', ok: true, error: null,
  log: ['2 reference image(s) available', 'Filter identifier .............. R', 'Number of integrated images .... 2',
    '2 reference image(s) available', 'Filter identifier .............. G',
    '1 reference image(s) available', 'Filter identifier .............. B'],
};
const MARS_RUN_MISSING = {
  file: '/tmp/nope.xmars', ok: false, error: null,
  log: ['*** Error: The specified MARS database file does not exist: /tmp/nope.xmars'],
};
const MARS_RUN_UNCOVERED = {
  file: '/db/MARS-DR1-u01-1.0.1.xmars', ok: false, error: null,
  log: ['0 reference image(s) available', "*** Error: No reference data found for filter 'R'"],
};
const XT_REPLY = [
  { name: 'BlurXTerminator', installed: true, ok: true, error: null, log: ['BlurXTerminator: Processing view: x', 'BlurXTerminator 2.6.9, ML version 5', 'Using gpu'] },
  { name: 'NoiseXTerminator', installed: true, ok: true, error: null, log: ['NoiseXTerminator 2.6.9, ML version 3.1', 'Using gpu'] },
  { name: 'StarXTerminator', installed: false },
];

// Captured from PixInsight 1.9.5 build 1706 on 2026-09-30.
const PROCESSES_REPLY = {
  core: { version: '1.9.5', revision: 0, build: 1706, codename: 'Lockhart' },
  processes: [
    { name: 'MultiscaleAdaptiveStretch', installed: true }, { name: 'MultiscaleGradientCorrection', installed: true },
    { name: 'BlurXTerminator', installed: true }, { name: 'NoiseXTerminator', installed: true }, { name: 'StarXTerminator', installed: false },
  ],
};

// An install folder with a few scripts in it: name -> the text of <name>/<name>.js.
function installWith(scripts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pxenv-install-'));
  for (const [name, text] of Object.entries(scripts)) {
    mkdirSync(path.join(dir, 'src', 'scripts', name), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'scripts', name, `${name}.js`), text);
  }
  return { dir, imageSolverPath: path.join(dir, 'src/scripts/ImageSolver/ImageSolver.js').replace(/\\/g, '/') };
}

test('environment.mjs exports inspect_environment only', () => {
  assert.deepEqual(tools.map((t) => t.name), ['inspect_environment']);
});

test('every generated PJSR snippet parses as a script', () => {
  for (const code of [gaiaPjsr(0, 0), marsPjsr(['/a.xmars', 'C:\\b.xmars'], 83.8, -5.4), xterminatorsPjsr(), processesPjsr(['SCNR'])]) {
    assert.doesNotThrow(() => new vm.Script(code));
  }
});

test('gaia snippet asks every release with get-info and captures its console errors', () => {
  const code = gaiaPjsr(150.1, 20.2);
  assert.match(code, /command = "get-info"/);
  assert.match(code, /\["DR2",1\],\["EDR3",2\],\["DR3",3\],\["DR3\/SP",4\]/);
  assert.match(code, /console\.beginLog\(\)/);
  assert.match(code, /centerRA = 150\.1; s\.centerDec = 20\.2/);
});

test('mars and xterminator snippets close every window they create, in a finally block', () => {
  const code = marsPjsr(['C:\\db\\x.xmars'], 10, 20);
  assert.match(code, /"C:\/db\/x\.xmars"/, 'paths are handed to PixInsight with forward slashes');
  assert.match(code, /PCL:SPFC:ScaleFactors/);
  for (const c of [code, xterminatorsPjsr()]) {
    assert.match(c, /var before = ids\(\);/);
    assert.match(c, /finally \{\s*ImageWindow\.windows\.forEach\(function \(x\) \{\s*if \(before\.indexOf\(x\.mainView\.id\) < 0\) x\.forceClose\(\);/);
  }
});

test('interpretMarsRun: readable with the least-covered filter count', () => {
  assert.deepEqual(interpretMarsRun(MARS_RUN_OK), { file: MARS_RUN_OK.file, status: 'readable', referenceImages: 1, errors: [] });
});

test('interpretMarsRun: a missing file is reported as missing, not as an error of the call', () => {
  const r = interpretMarsRun(MARS_RUN_MISSING);
  assert.equal(r.status, 'missing');
  assert.equal(r.referenceImages, null);
  assert.equal(r.errors.length, 1);
});

test('interpretMarsRun: a readable file with no data at the position reports 0 reference images', () => {
  const r = interpretMarsRun(MARS_RUN_UNCOVERED);
  assert.equal(r.status, 'readable');
  assert.equal(r.referenceImages, 0);
});

test('interpretMarsRun: a corrupt file and an unrecognized log', () => {
  assert.equal(interpretMarsRun({ file: 'f', ok: false, log: ['*** Error: Invalid or corrupted XMARS file.'] }).status, 'corrupt');
  assert.equal(interpretMarsRun({ file: 'f', ok: false, log: [] }).status, 'unknown');
});

test('interpretXterminator: version, ML version (kept as text) and device from the banner', () => {
  assert.deepEqual(interpretXterminator(XT_REPLY[1]), {
    name: 'NoiseXTerminator', installed: true, ran: true, version: '2.6.9', mlVersion: '3.1', device: 'gpu', log: XT_REPLY[1].log,
  });
  assert.deepEqual(interpretXterminator(XT_REPLY[2]), { name: 'StarXTerminator', installed: false });
  const silent = interpretXterminator({ name: 'BlurXTerminator', installed: true, ok: true, log: [] });
  assert.equal(silent.version, null);
  assert.equal(silent.mlVersion, null);
  assert.equal(silent.device, null);
});

function settingsWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pxenv-'));
  const p = path.join(dir, 'core.settings');
  writeFileSync(p, `<xml>${files.map((f, i) => `<v k="MARSDatabaseFilePath${String(i + 1).padStart(3, '0')}" t="s">${f}</v>`).join('')}</xml>`);
  return { dir, p };
}

test('inspectEnvironment: all sections, MARS files from settings including one that no longer exists', async () => {
  const { dir, p } = settingsWith(['/db/MARS-DR2-1.0.3-s08.xmars', '/tmp/nope.xmars']);
  const install = installWith({ ImageSolver: '#define VERSION "6.5.0"\n' });
  try {
    const { ctx, emitted } = createFakeBridge({
      replies: [JSON.stringify(GAIA_REPLY), JSON.stringify({ installed: true, runs: [MARS_RUN_OK, MARS_RUN_MISSING] }), JSON.stringify(XT_REPLY), JSON.stringify(PROCESSES_REPLY)],
    });
    const api = apiFrom(ctx, { workspace: { dir: tmpdir() } });
    api.platform = { ...api.platform, settingsPath: p, imageSolverPath: install.imageSolverPath };
    const out = await inspectEnvironment(api, { ra_deg: 150.1, dec_deg: 20.2 });
    assert.equal(emitted.length, 4);
    assert.match(emitted[1], /\/tmp\/nope\.xmars/, 'a configured file that does not exist is still tested');
    assert.equal(out.pixinsightVersion, '1.9.5');
    assert.equal(out.gaia.releases.find((r) => r.release === 'DR3/SP').valid, true);
    assert.deepEqual(out.mars.results.map((r) => r.status), ['readable', 'missing']);
    assert.equal(out.mars.covered, true);
    assert.equal(out.mars.source, 'settings');
    assert.equal(out.xterminators[0].mlVersion, '5');
    assert.deepEqual(out.processes.pixinsight, { version: '1.9.5', revision: 0, build: 1706, codename: 'Lockhart' });
    assert.equal(out.processes.processes.find((x) => x.name === 'StarXTerminator').installed, false);
    assert.deepEqual(out.processes.scripts.find((x) => x.name === 'ImageSolver'), { name: 'ImageSolver', installed: true, version: '6.5.0' });
    assert.ok(out.system.totalMemoryBytes > 0);
    assert.equal(typeof out.system.workspaceFreeBytes, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(install.dir, { recursive: true, force: true });
  }
});

test('inspectEnvironment: the processes section is one read-only PJSR call plus a look at the scripts folder', async () => {
  const install = installWith({
    ImageSolver: '// header\n#define VERSION "6.5.0"\n', FFTRegistration: '#feature-id X\n#define VERSION "2.0.0"\n', MosaicByCoordinates: 'no version here\n',
  });
  try {
    const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify(PROCESSES_REPLY)] });
    const api = apiFrom(ctx);
    api.platform = { ...api.platform, imageSolverPath: install.imageSolverPath };
    const out = await inspectEnvironment(api, { sections: ['processes'] });
    assert.equal(emitted.length, 1);
    assert.doesNotMatch(emitted[0], /executeOn|executeGlobal|new ImageWindow/, 'nothing is run or created');
    assert.match(emitted[0], /"MultiscaleAdaptiveStretch","MultiscaleGradientCorrection","BlurXTerminator","NoiseXTerminator","StarXTerminator"/);
    assert.ok(!('gaia' in out) && !('mars' in out));
    assert.deepEqual(out.processes.scripts, [
      { name: 'ImageSolver', installed: true, version: '6.5.0' },
      { name: 'AstrometricSolutionVerifier', installed: false, version: null },
      { name: 'DistortionEvaluator', installed: false, version: null },
      { name: 'FFTRegistration', installed: true, version: '2.0.0' },
      { name: 'MosaicByCoordinates', installed: true, version: null },
    ]);
  } finally {
    rmSync(install.dir, { recursive: true, force: true });
  }
});

test('the processes snippet classifies a process the way list_processes does and never instantiates one', () => {
  const code = processesPjsr(['SCNR', 'Nope']);
  assert.match(code, /C\.prototype instanceof ProcessInstance/);
  assert.doesNotMatch(code, /new C\b|new this/);
  const sandbox = {
    CoreApplication: { versionMajor: 1, versionMinor: 9, versionRelease: 5, versionRevision: 0, versionBuild: 1706, versionCodename: 'Lockhart' },
    ProcessInstance: class {},
  };
  sandbox.SCNR = class extends sandbox.ProcessInstance {};
  sandbox.Helper = function () {};
  const out = JSON.parse(vm.runInNewContext(code.replace('["SCNR","Nope"]', '["SCNR","Nope","Helper"]'), sandbox, {}).toString());
  assert.deepEqual(out.core, { version: '1.9.5', revision: 0, build: 1706, codename: 'Lockhart' });
  assert.deepEqual(out.processes, [{ name: 'SCNR', installed: true }, { name: 'Nope', installed: false }, { name: 'Helper', installed: false }]);
});

test('scriptVersions: a platform that resolved no install reports the held error', () => {
  const api = apiFrom(createFakeBridge().ctx, { platform: { error: 'no install' } });
  assert.throws(() => scriptVersions(api), (e) => e instanceof PlatformError && e.message === 'no install');
});

test('inspectEnvironment: without a position, coverage is null and the probe is RA 0, Dec 0', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ installed: true, runs: [MARS_RUN_UNCOVERED] })] });
  const out = await inspectEnvironment(apiFrom(ctx), { sections: ['mars'], mars_files: ['/db/MARS-DR1-u01-1.0.1.xmars'] });
  assert.match(emitted[0], /new Vector\(\[0, 0\]\)/);
  assert.equal(out.mars.covered, null);
  assert.equal(out.mars.source, 'input');
  assert.equal(out.position, null);
});

test('inspectEnvironment: no configured MARS files runs nothing in PixInsight for that section', async () => {
  const { dir, p } = settingsWith([]);
  try {
    const { ctx, emitted } = createFakeBridge();
    const api = apiFrom(ctx);
    api.platform = { ...api.platform, settingsPath: p };
    const out = await inspectEnvironment(api, { sections: ['mars'] });
    assert.equal(emitted.length, 0);
    assert.equal(out.mars.status, 'none-configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectEnvironment: system section degrades when the workspace is unusable', async () => {
  const { ctx } = createFakeBridge();
  const api = apiFrom(ctx, { workspace: { get dir() { throw new Error('No usable workspace'); } } });
  const out = await inspectEnvironment(api, { sections: ['system'] });
  assert.equal(out.system.workspaceFreeBytes, null);
});

test('inspectEnvironment: input validation', async () => {
  const api = apiFrom(createFakeBridge().ctx);
  await assert.rejects(() => inspectEnvironment(api, { ra_deg: 10 }), /both ra_deg and dec_deg/);
  await assert.rejects(() => inspectEnvironment(api, { ra_deg: 360, dec_deg: 0 }), /ra_deg/);
  await assert.rejects(() => inspectEnvironment(api, { ra_deg: 0, dec_deg: 91 }), /dec_deg/);
  await assert.rejects(() => inspectEnvironment(api, { sections: ['disk'] }), /unknown section/);
});

test('inspectEnvironment: a PJSR error surfaces with the section name', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'boom' } }] });
  await assert.rejects(() => inspectEnvironment(apiFrom(ctx), { sections: ['xterminators'] }), /xterminators.*boom/);
});
