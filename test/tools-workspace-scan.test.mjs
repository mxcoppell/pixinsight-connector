import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/workspace-scan.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('workspace-scan.mjs exports scan_workspace only', () => {
  assert.deepEqual(Object.keys(byName), ['scan_workspace']);
});

test('scan_workspace finds files recursively and reports FILTER verbatim, no channel guess', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-scan-'));
  try {
    mkdirSync(path.join(dir, 'lights'), { recursive: true });
    writeFileSync(path.join(dir, 'lights', 'frame_R.fits'), 'not really fits, extension is enough for this test');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'skip_me.fits'), 'must be skipped');
    const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, { workspace: { dir, scratchDir: dir } });
    const out = await byName.scan_workspace.handler(api, {});
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].rel, path.join('lights', 'frame_R.fits'));
    assert.ok(!('channel' in parsed.files[0]), 'no channel guess field');
    assert.ok(!('channelSource' in parsed.files[0]), 'no channel guess field');
    assert.ok(!('byChannel' in parsed), 'no channel grouping');
    assert.ok(!('unresolved' in parsed), 'no channel grouping');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan_workspace tolerates an empty workspace', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-scan-'));
  try {
    const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, { workspace: { dir, scratchDir: dir } });
    const out = await byName.scan_workspace.handler(api, {});
    assert.deepEqual(JSON.parse(out.text).files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan_workspace skips the connector\'s own folders (agentic/, output/, a moved state folder, old .pixinsight/) but not a nested folder that happens to share a name', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (...p) => { mkdirSync(path.join(dir, ...p.slice(0, -1)), { recursive: true }); writeFileSync(path.join(dir, ...p), 'x'); };
  put('lights', 'frame_R.fits');
  put('WBPP', 'output', 'master', 'L.fits'); // a user's folder named output, below the root
  put('agentic', 'scratch', 'tmp_align', 'aligned_R.xisf');
  put('output', 'm31.fits');
  put('state', 'scratch', 'x.fits'); // PIXINSIGHT_CONNECTOR_STATE=state
  put('.pixinsight', 'scratch', 'old.fits');
  put('node_modules', 'skip_me.fits');
  const scan = async (workspace) => {
    const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, { workspace });
    return JSON.parse((await byName.scan_workspace.handler(api, {})).text).files.map((f) => f.rel).sort();
  };
  assert.deepEqual(await scan({ dir, scratchDir: path.join(dir, 'agentic', 'scratch'), outputDir: path.join(dir, 'output') }),
    [path.join('WBPP', 'output', 'master', 'L.fits'), path.join('lights', 'frame_R.fits'), path.join('state', 'scratch', 'x.fits')].sort());
  assert.deepEqual(await scan({ dir, scratchDir: path.join(dir, 'state', 'scratch'), outputDir: path.join(dir, 'output') }),
    [path.join('WBPP', 'output', 'master', 'L.fits'), path.join('agentic', 'scratch', 'tmp_align', 'aligned_R.xisf'), path.join('lights', 'frame_R.fits')].sort(),
    'a moved state folder is skipped where it is');
});

test('a state folder that is the workspace itself does not hide the whole workspace', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'lights'));
  writeFileSync(path.join(dir, 'lights', 'L.fits'), 'x');
  const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, { workspace: { dir, scratchDir: path.join(dir, 'scratch'), outputDir: path.join(dir, 'output') } });
  assert.deepEqual(JSON.parse((await byName.scan_workspace.handler(api, {})).text).files.map((f) => f.rel), [path.join('lights', 'L.fits')]);
});

// --- Header facts: a real astrometric solution only, and the instrument keywords verbatim ---

// An XISF file: signature, header length (LE), 4 reserved bytes, the XML header. No pixel data needed.
function xisf(body) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><xisf version="1.0" xmlns="http://www.pixinsight.com/xisf">${body}</xisf>`;
  const x = Buffer.from(xml, 'utf8');
  const head = Buffer.alloc(16);
  head.write('XISF0100', 0, 'latin1');
  head.writeUInt32LE(x.length, 8);
  return Buffer.concat([head, x]);
}
const kw = (name, value) => `<FITSKeyword name="${name}" value="${value}" comment=""/>`;
const image = (inner) => `<Image geometry="4000:3000:1" sampleFormat="Float32" colorSpace="Gray" location="attachment:4096:61873728">${inner}</Image>`;
// What an Astro Pixel Processor master carries: a processing history naming inheritAstrometricSolution, no solution.
const HISTORY = '<Property id="PixInsight:ProcessingHistory" type="String">&lt;?xml version="1.0"?&gt;&lt;parameter id="inheritAstrometricSolution" value="true"/&gt; CRVAL1 AstrometricSolution</Property>';
// A FITS file: 80-character cards padded to 2880 bytes.
function fits(cards) {
  const lines = [...cards, 'END'].map((c) => c.padEnd(80, ' ')).join('');
  return Buffer.from(lines.padEnd(Math.ceil(lines.length / 2880) * 2880, ' '), 'latin1');
}
const card = (name, value) => `${name.padEnd(8, ' ')}= ${value}`;

async function scanFiles(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(dir, name), data);
  const api = apiFrom({ async pjsr() {}, async listImages() { return []; } }, { workspace: { dir, scratchDir: path.join(dir, 'agentic', 'scratch') } });
  const out = JSON.parse((await byName.scan_workspace.handler(api, {})).text);
  return Object.fromEntries(out.files.map((f) => [f.rel, f]));
}

test('hasWCS: a processing history that only names an astrometric parameter is not a solution', async (t) => {
  const f = await scanFiles(t, { 'history.xisf': xisf(image(kw('FILT-1', "'Luminance'") + HISTORY)) });
  assert.equal(f['history.xisf'].hasWCS, false);
  assert.equal(f['history.xisf'].filter, 'Luminance');
});

test('hasWCS: WCS keywords (CTYPE, CRVAL and a CD/CDELT/PC matrix) are a solution; a lone CRVAL1 is not', async (t) => {
  const wcs = kw('CTYPE1', "'RA---TAN'") + kw('CTYPE2', "'DEC--TAN'") + kw('CRVAL1', '150.1') + kw('CRVAL2', '20.2');
  const f = await scanFiles(t, {
    'cd.xisf': xisf(image(wcs + kw('CD1_1', '-4.2E-4') + kw('CD1_2', '0') + kw('CD2_1', '0') + kw('CD2_2', '4.2E-4'))),
    'cdelt.xisf': xisf(image(wcs + kw('CDELT1', '-4.2E-4') + kw('CDELT2', '4.2E-4'))),
    'pc.xisf': xisf(image(wcs + kw('PC1_1', '1') + kw('PC2_2', '1') + kw('CDELT1', '-4.2E-4') + kw('CDELT2', '4.2E-4'))),
    'nomatrix.xisf': xisf(image(wcs)),
    'crval.xisf': xisf(image(kw('CRVAL1', '150.1'))),
  });
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])),
    { 'cd.xisf': true, 'cdelt.xisf': true, 'pc.xisf': true, 'nomatrix.xisf': false, 'crval.xisf': false });
});

// The solution PixInsight 1.8.9-2 to 1.9.4 wrote: the core properties as PCL:AstrometricSolution:*.
const LEGACY_SOLUTION =
  '<Property id="PCL:AstrometricSolution:ProjectionSystem" type="String" value="Gnomonic"/>' +
  '<Property id="PCL:AstrometricSolution:ReferenceCelestialCoordinates" type="F64Vector" length="2" location="inline:base64:AAAA"/>' +
  '<Property id="PCL:AstrometricSolution:ReferenceImageCoordinates" type="F64Vector" length="2" location="inline:base64:AAAA"/>' +
  '<Property id="PCL:AstrometricSolution:LinearTransformationMatrix" type="F64Matrix" rows="2" columns="2" location="inline:base64:AAAA"/>';

test('hasWCS: PixInsight\'s astrometric solution properties are a solution', async (t) => {
  const f = await scanFiles(t, {
    'solved.xisf': xisf(image(LEGACY_SOLUTION + HISTORY)),
    'partial.xisf': xisf(image('<Property id="PCL:AstrometricSolution:CreationTime" type="TimePoint" value="2026-09-23T00:00:00Z"/>')),
  });
  assert.equal(f['solved.xisf'].hasWCS, true);
  assert.equal(f['partial.xisf'].hasWCS, false, 'a creation time alone is not a solution');
});

// The solution as PixInsight 1.9.5 and later saves it (a real ImageSolver 6.5.0 solution, values shortened): the
// standard XISF namespace, no PCL: prefix, the value as element text. Only the Generation and Grid blocks keep PCL:.
const STANDARD_CORE =
  '<Property id="AstrometricSolution:LinearTransformationMatrix" type="F64Matrix" rows="2" columns="2" location="inline:base64">xyKxWQk0Qr9I3GkrVgkcvpGRqXn4Oie+O3nzZSo0Qr8=</Property>' +
  '<Property id="AstrometricSolution:ProjectionSystem" type="String">Gnomonic</Property>' +
  '<Property id="AstrometricSolution:ReferenceCelestialCoordinates" type="F64Vector" length="2" location="inline:base64">PN6lMYD0VECUX3I+GY8VwA==</Property>';
const STANDARD_REFERENCE_PIXEL =
  '<Property id="AstrometricSolution:ReferenceImageCoordinates" type="F64Vector" length="2" location="inline:base64">0cUry5o/j0C8MsVfKOCFQA==</Property>';
const standardVersion = (v) => `<Property id="AstrometricSolution:Version" type="String">${v}</Property>`;
const STANDARD_SOLUTION = STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('1.0');
const GENERATION_AND_GRID =
  '<Property id="PCL:AstrometricSolution:Generation:Engine" type="String">DDM</Property>' +
  '<Property id="PCL:AstrometricSolution:Grid:Fingerprint" type="String">bb571434e29e40aa</Property>';

test('hasWCS: the standard AstrometricSolution properties of PixInsight 1.9.5 and later are a solution', async (t) => {
  const f = await scanFiles(t, {
    'standard.xisf': xisf(image(STANDARD_SOLUTION + GENERATION_AND_GRID + HISTORY)),
    'generation-only.xisf': xisf(image(GENERATION_AND_GRID)),
  });
  assert.equal(f['standard.xisf'].hasWCS, true, 'the PCL:-prefixed Generation and Grid blocks beside the core properties are not needed');
  assert.equal(f['generation-only.xisf'].hasWCS, false, 'the PCL:-prefixed Generation and Grid blocks alone are not a solution');
});

test('hasWCS: a solution needs its projection, reference point, reference pixel and matrix, in either namespace', async (t) => {
  for (const prefix of ['PCL:AstrometricSolution:', 'AstrometricSolution:']) {
    const prop = (n) => `<Property id="${prefix}${n}" type="String" value="x"/>`;
    const three = prop('ProjectionSystem') + prop('ReferenceCelestialCoordinates') + prop('LinearTransformationMatrix');
    const f = await scanFiles(t, {
      'one.xisf': xisf(image(prop('ProjectionSystem'))),
      'two.xisf': xisf(image(prop('ProjectionSystem') + prop('ReferenceCelestialCoordinates'))),
      'other-two.xisf': xisf(image(prop('ReferenceCelestialCoordinates') + prop('LinearTransformationMatrix'))),
      'three.xisf': xisf(image(three)),
      'four.xisf': xisf(image(three + prop('ReferenceImageCoordinates'))),
    });
    assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])),
      { 'one.xisf': false, 'two.xisf': false, 'other-two.xisf': false, 'three.xisf': false, 'four.xisf': true }, prefix);
  }
});

test('hasWCS: the reference pixel comes from ReferenceImageCoordinates or from CRPIX1 and CRPIX2, as PixInsight reads it', async (t) => {
  // AstrometricMetadata::Build builds no solution without crpix; WCSKeywords takes it from the property or the keywords.
  const f = await scanFiles(t, {
    'none.xisf': xisf(image(STANDARD_CORE)),
    'cards.xisf': xisf(image(STANDARD_CORE + kw('CRPIX1', '2000.5') + kw('CRPIX2', '1500.5'))),
    'one-card.xisf': xisf(image(STANDARD_CORE + kw('CRPIX1', '2000.5'))),
    'legacy-cards.xisf': xisf(image(LEGACY_SOLUTION.replace(/<Property id="PCL:AstrometricSolution:ReferenceImageCoordinates"[^>]*\/>/, '') + kw('CRPIX1', '2000.5') + kw('CRPIX2', '1500.5'))),
  });
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])),
    { 'none.xisf': false, 'cards.xisf': true, 'one-card.xisf': false, 'legacy-cards.xisf': true });
});

test('hasWCS: a standard block of another major version is not a solution, since PixInsight builds none from it', async (t) => {
  // AstrometricMetadata::Build skips every AstrometricSolution:* property when the Version major is not 1 (a missing
  // Version is accepted); the legacy PCL: properties stay usable.
  const attr = '<Property id="AstrometricSolution:Version" type="String" value="1.3"/>';
  const f = await scanFiles(t, {
    'v1.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('1.0'))),
    'v1-minor.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion(' 1.7 '))),
    'v1-attribute.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + attr)),
    'no-version.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL)),
    'v2.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('2.0'))),
    'v10.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('10.0'))),
    'unreadable.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('one'))),
    'empty.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + '<Property id="AstrometricSolution:Version" type="String"></Property>')),
    'v2-with-legacy.xisf': xisf(image(STANDARD_CORE + STANDARD_REFERENCE_PIXEL + standardVersion('2.0') + LEGACY_SOLUTION)),
  });
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])), {
    'v1.xisf': true, 'v1-minor.xisf': true, 'v1-attribute.xisf': true, 'no-version.xisf': true,
    'v2.xisf': false, 'v10.xisf': false, 'unreadable.xisf': false, 'empty.xisf': false, 'v2-with-legacy.xisf': true,
  });
});

test('hasWCS: the three core properties come from one namespace, never one from each', async (t) => {
  // No PixInsight writer produces a mix: saving the standard block first deletes the legacy PCL: ids (AstrometricMetadata::Write).
  const std = (n) => `<Property id="AstrometricSolution:${n}" type="String" value="x"/>`;
  const old = (n) => `<Property id="PCL:AstrometricSolution:${n}" type="String" value="x"/>`;
  const f = await scanFiles(t, {
    'mixed.xisf': xisf(image(std('ProjectionSystem') + std('ReferenceCelestialCoordinates') + std('ReferenceImageCoordinates') + old('LinearTransformationMatrix'))),
  });
  assert.equal(f['mixed.xisf'].hasWCS, false);
});

test('XISF: a keyword or property inside a comment or CDATA section is not read', async (t) => {
  const wcs = kw('CTYPE1', "'RA---TAN'") + kw('CTYPE2', "'DEC--TAN'") + kw('CRVAL1', '150.1') + kw('CRVAL2', '20.2') + kw('CD1_1', '-4.2E-4');
  const props = ['ProjectionSystem', 'ReferenceCelestialCoordinates', 'LinearTransformationMatrix'].map((n) => `<Property id="PCL:AstrometricSolution:${n}" type="String" value="x"/>`).join('');
  const f = await scanFiles(t, {
    'comment.xisf': xisf(image(`<!-- ${kw('FILTER', "'Red'")} ${wcs} ${props} -->` + kw('FILTER', "'Green'"))),
    'cdata.xisf': xisf(image(`<Property id="Note" type="String"><![CDATA[${kw('OBJECT', "'Fake'")}${wcs}${props}]]></Property>` + kw('OBJECT', "'Target A'"))),
  });
  assert.equal(f['comment.xisf'].filter, 'Green');
  assert.equal(f['comment.xisf'].hasWCS, false);
  assert.equal(f['cdata.xisf'].object, 'Target A');
  assert.equal(f['cdata.xisf'].hasWCS, false);
});

test('FITS: a card without the "= " value indicator is commentary, never a value', async (t) => {
  const f = await scanFiles(t, {
    'commentary.fits': fits([card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '0'),
      "OBJECT  was M42, reframed", "FILTER  'Red'", card('OBJECT', "'Target A'"), card('FILTER', "'Ha'")]),
  });
  assert.equal(f['commentary.fits'].object, 'Target A');
  assert.equal(f['commentary.fits'].filter, 'Ha');
});

test('scan_workspace reports INSTRUME, TELESCOP, FOCALLEN, XPIXSZ, YPIXSZ and XBINNING verbatim (quotes stripped), else null', async (t) => {
  const f = await scanFiles(t, {
    'full.xisf': xisf(image(kw('INSTRUME', "'Example Mono Camera'") + kw('TELESCOP', "'&lt;RC8&gt; &amp; reducer'") + kw('FOCALLEN', '1100.') +
      kw('XPIXSZ', '3.76') + kw('YPIXSZ', '3.76') + kw('XBINNING', '1'))),
    'bare.xisf': xisf(image(kw('FILTER', "'Red'"))),
    'frame.fits': fits([card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '0'), card('INSTRUME', "'QHY600M '"), card('FILTER', "'Ha'"),
      card('XPIXSZ', '3.76'), card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRVAL1', '150.1'), card('CRVAL2', '20.2'), card('CDELT1', '-4.2E-4'), card('CDELT2', '4.2E-4')]),
  });
  assert.deepEqual(f['full.xisf'].keywords, { INSTRUME: 'Example Mono Camera', TELESCOP: '<RC8> & reducer', FOCALLEN: '1100.', XPIXSZ: '3.76', YPIXSZ: '3.76', XBINNING: '1' });
  assert.deepEqual(f['bare.xisf'].keywords, { INSTRUME: null, TELESCOP: null, FOCALLEN: null, XPIXSZ: null, YPIXSZ: null, XBINNING: null });
  assert.equal(f['full.xisf'].geometry, '4000:3000:1');
  assert.equal(f['full.xisf'].colorSpace, 'Gray');
  assert.deepEqual(f['frame.fits'].keywords, { INSTRUME: 'QHY600M', TELESCOP: null, FOCALLEN: null, XPIXSZ: '3.76', YPIXSZ: null, XBINNING: null });
  assert.equal(f['frame.fits'].filter, 'Ha');
  assert.equal(f['frame.fits'].hasWCS, true);
});

test('a file with a .fits name that is not FITS is listed with no header facts', async (t) => {
  const f = await scanFiles(t, { 'junk.fits': 'not really fits' });
  assert.equal(f['junk.fits'].filter, null);
  assert.equal('hasWCS' in f['junk.fits'], false);
});
