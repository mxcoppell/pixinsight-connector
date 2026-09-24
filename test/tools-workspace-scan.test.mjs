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
const image = (inner) => `<Image geometry="4814:3213:1" sampleFormat="Float32" colorSpace="Gray" location="attachment:4096:61873728">${inner}</Image>`;
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
  const wcs = kw('CTYPE1', "'RA---TAN'") + kw('CTYPE2', "'DEC--TAN'") + kw('CRVAL1', '80.6') + kw('CRVAL2', '33.4');
  const f = await scanFiles(t, {
    'cd.xisf': xisf(image(wcs + kw('CD1_1', '-4.2E-4') + kw('CD1_2', '0') + kw('CD2_1', '0') + kw('CD2_2', '4.2E-4'))),
    'cdelt.xisf': xisf(image(wcs + kw('CDELT1', '-4.2E-4') + kw('CDELT2', '4.2E-4'))),
    'pc.xisf': xisf(image(wcs + kw('PC1_1', '1') + kw('PC2_2', '1') + kw('CDELT1', '-4.2E-4') + kw('CDELT2', '4.2E-4'))),
    'nomatrix.xisf': xisf(image(wcs)),
    'crval.xisf': xisf(image(kw('CRVAL1', '80.6'))),
  });
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])),
    { 'cd.xisf': true, 'cdelt.xisf': true, 'pc.xisf': true, 'nomatrix.xisf': false, 'crval.xisf': false });
});

test('hasWCS: PixInsight\'s astrometric solution properties are a solution', async (t) => {
  const props = '<Property id="PCL:AstrometricSolution:ProjectionSystem" type="String" value="Gnomonic"/>' +
    '<Property id="PCL:AstrometricSolution:ReferenceCelestialCoordinates" type="F64Vector" length="2" location="inline:base64:AAAA"/>' +
    '<Property id="PCL:AstrometricSolution:LinearTransformationMatrix" type="F64Matrix" rows="2" columns="2" location="inline:base64:AAAA"/>';
  const f = await scanFiles(t, {
    'solved.xisf': xisf(image(props + HISTORY)),
    'partial.xisf': xisf(image('<Property id="PCL:AstrometricSolution:CreationTime" type="TimePoint" value="2026-09-23T00:00:00Z"/>')),
  });
  assert.equal(f['solved.xisf'].hasWCS, true);
  assert.equal(f['partial.xisf'].hasWCS, false, 'a creation time alone is not a solution');
});

test('hasWCS: one or two of the three solution properties are not a solution', async (t) => {
  const prop = (n) => `<Property id="PCL:AstrometricSolution:${n}" type="String" value="x"/>`;
  const f = await scanFiles(t, {
    'one.xisf': xisf(image(prop('ProjectionSystem'))),
    'two.xisf': xisf(image(prop('ProjectionSystem') + prop('ReferenceCelestialCoordinates'))),
    'other-two.xisf': xisf(image(prop('ReferenceCelestialCoordinates') + prop('LinearTransformationMatrix'))),
    'three.xisf': xisf(image(prop('ProjectionSystem') + prop('ReferenceCelestialCoordinates') + prop('LinearTransformationMatrix'))),
  });
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.hasWCS])),
    { 'one.xisf': false, 'two.xisf': false, 'other-two.xisf': false, 'three.xisf': true });
});

test('XISF: a keyword or property inside a comment or CDATA section is not read', async (t) => {
  const wcs = kw('CTYPE1', "'RA---TAN'") + kw('CTYPE2', "'DEC--TAN'") + kw('CRVAL1', '80.6') + kw('CRVAL2', '33.4') + kw('CD1_1', '-4.2E-4');
  const props = ['ProjectionSystem', 'ReferenceCelestialCoordinates', 'LinearTransformationMatrix'].map((n) => `<Property id="PCL:AstrometricSolution:${n}" type="String" value="x"/>`).join('');
  const f = await scanFiles(t, {
    'comment.xisf': xisf(image(`<!-- ${kw('FILTER', "'Red'")} ${wcs} ${props} -->` + kw('FILTER', "'Green'"))),
    'cdata.xisf': xisf(image(`<Property id="Note" type="String"><![CDATA[${kw('OBJECT', "'Fake'")}${wcs}${props}]]></Property>` + kw('OBJECT', "'IC 410'"))),
  });
  assert.equal(f['comment.xisf'].filter, 'Green');
  assert.equal(f['comment.xisf'].hasWCS, false);
  assert.equal(f['cdata.xisf'].object, 'IC 410');
  assert.equal(f['cdata.xisf'].hasWCS, false);
});

test('FITS: a card without the "= " value indicator is commentary, never a value', async (t) => {
  const f = await scanFiles(t, {
    'commentary.fits': fits([card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '0'),
      "OBJECT  was M42, reframed", "FILTER  'Red'", card('OBJECT', "'IC 410'"), card('FILTER', "'Ha'")]),
  });
  assert.equal(f['commentary.fits'].object, 'IC 410');
  assert.equal(f['commentary.fits'].filter, 'Ha');
});

test('scan_workspace reports INSTRUME, TELESCOP, FOCALLEN, XPIXSZ, YPIXSZ and XBINNING verbatim (quotes stripped), else null', async (t) => {
  const f = await scanFiles(t, {
    'full.xisf': xisf(image(kw('INSTRUME', "'ZWO ASI6200MM Pro'") + kw('TELESCOP', "'&lt;RC8&gt; &amp; reducer'") + kw('FOCALLEN', '1100.') +
      kw('XPIXSZ', '3.76') + kw('YPIXSZ', '3.76') + kw('XBINNING', '1'))),
    'bare.xisf': xisf(image(kw('FILTER', "'Red'"))),
    'frame.fits': fits([card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '0'), card('INSTRUME', "'QHY600M '"), card('FILTER', "'Ha'"),
      card('XPIXSZ', '3.76'), card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRVAL1', '80.6'), card('CRVAL2', '33.4'), card('CDELT1', '-4.2E-4'), card('CDELT2', '4.2E-4')]),
  });
  assert.deepEqual(f['full.xisf'].keywords, { INSTRUME: 'ZWO ASI6200MM Pro', TELESCOP: '<RC8> & reducer', FOCALLEN: '1100.', XPIXSZ: '3.76', YPIXSZ: '3.76', XBINNING: '1' });
  assert.deepEqual(f['bare.xisf'].keywords, { INSTRUME: null, TELESCOP: null, FOCALLEN: null, XPIXSZ: null, YPIXSZ: null, XBINNING: null });
  assert.equal(f['full.xisf'].geometry, '4814:3213:1');
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
