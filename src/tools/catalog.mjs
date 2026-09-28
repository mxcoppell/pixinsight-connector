// ============================================================================
// catalog_stars: catalogue stars over a plate-solved view, from PixInsight's local Gaia database.
//
// One Gaia `search` per call, on one data release. When the caller names no release, the releases
// are asked `get-info` (the query inspect_environment runs) in the order DR3/SP, DR3, EDR3, DR2 and
// the earliest valid one is searched. A failed search is reported, never retried on another release:
// running search after search on different releases has crashed PixInsight's script engine.
// Gaia `sources` rows are read as [ra, dec, ..., G (5), BP (6), RP (7), ...], the layout of
// PixInsight's Gaia process.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { q, num, pjsrJson } from './pjsr-args.mjs';

const RELEASES = [['DR3/SP', 4], ['DR3', 3], ['EDR3', 2], ['DR2', 1]];
const INLINE_MAX = 200;

function sanitizeSupplement(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('supplement: expected an array of {ra, dec, mag, name}');
  return list.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`supplement[${i}]: expected {ra, dec, mag, name}`);
    return {
      ra: num(s.ra, undefined, `supplement[${i}].ra`),
      dec: num(s.dec, undefined, `supplement[${i}].dec`),
      mag: num(s.mag, undefined, `supplement[${i}].mag`),
      name: s.name === undefined ? `supplement ${i + 1}` : String(s.name),
    };
  });
}

export function catalogStarsPjsr(o) {
  return `(function () {
  var o = ${JSON.stringify(o)};
  var w = ImageWindow.windowById(o.viewId);
  if (w.isNull) throw new Error('View not found: ' + o.viewId);
  if (!w.hasAstrometricSolution) throw new Error('View ' + o.viewId + ' has no astrometric solution');
  if (typeof Gaia !== 'function') throw new Error('The Gaia process is not installed');
  function errorsOf(t) {
    return String(t).replace(/<[^>]+>/g, ' ').split(/\\r?\\n/).filter(function (s) { return /\\*\\*\\* Error/.test(s); }).map(function (s) { return s.trim(); });
  }
  // Pick the release: the one asked for, or the earliest valid one by get-info. get-info only; no searches.
  var rels = o.release ? [o.release] : o.order, rel = null, probed = [];
  for (var i = 0; i < rels.length && rel === null; i++) {
    var g = new Gaia; g.command = 'get-info'; g.dataRelease = rels[i][1];
    var err = null;
    console.beginLog();
    try { g.executeGlobal(); } catch (e) { err = String(e && e.message ? e.message : e); }
    var el = errorsOf(console.endLog()); if (err === null && el.length) err = el.join(' ; ');
    probed.push({ release: rels[i][0], valid: !!g.isValid, error: err });
    if (g.isValid) rel = rels[i];
  }
  if (rel === null) {
    throw new Error(o.release ? 'Gaia ' + o.release[0] + ' is not installed or not valid' + (probed[0].error ? ': ' + probed[0].error : '')
      : 'No valid Gaia data release is installed (tried ' + probed.map(function (p) { return p.release; }).join(', ') + ')');
  }
  var im = w.mainView.image, W = im.width, H = im.height;
  var c0 = w.imageToCelestial(new Point(W / 2, H / 2)), rad = 0, corners = [[0, 0], [W, 0], [0, H], [W, H]];
  for (var k = 0; k < 4; k++) {
    var cc = w.imageToCelestial(new Point(corners[k][0], corners[k][1])), d2r = Math.PI / 180;
    var cs = Math.sin(c0.y * d2r) * Math.sin(cc.y * d2r) + Math.cos(c0.y * d2r) * Math.cos(cc.y * d2r) * Math.cos((c0.x - cc.x) * d2r);
    rad = Math.max(rad, Math.acos(Math.min(1, cs)) / d2r);
  }
  var S = new Gaia; S.command = 'search'; S.dataRelease = rel[1];
  S.centerRA = c0.x; S.centerDec = c0.y; S.radius = rad * (1 + o.marginFraction);
  S.magnitudeLow = o.magLow; S.magnitudeHigh = o.magLimit; S.generateTextOutput = false; S.verbosity = 0;
  var serr = null;
  console.beginLog();
  try { S.executeGlobal(); } catch (e) { serr = String(e && e.message ? e.message : e); }
  var sl = errorsOf(console.endLog()); if (serr === null && sl.length) serr = sl.join(' ; ');
  if (serr !== null) throw new Error('Gaia ' + rel[0] + ' search failed: ' + serr);
  var src = S.sources || [], nch = im.numberOfChannels, lw = nch >= 3 ? [0.2126, 0.7152, 0.0722] : [1];
  function peakAt(x, y) {
    var m = 0, xi = Math.round(x), yi = Math.round(y);
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      var xx = xi + dx, yy = yi + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      var v = 0; for (var c = 0; c < lw.length; c++) v += lw[c] * im.sample(xx, yy, c); if (v > m) m = v;
    }
    return m;
  }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  var stars = [];
  function add(ra, dec, g, bp, rp, name) {
    var p = w.celestialToImage(new Point(ra, dec)); if (!p) return;
    var inFrame = p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
    var s = { x: p.x, y: p.y, ra: ra, dec: dec, G: g, BP_RP: (bp !== null && rp !== null) ? bp - rp : null, inFrame: inFrame };
    if (name !== null) s.supplement = name;
    if (inFrame) { s.peak = peakAt(p.x, p.y); if (o.saturationLevel !== null) s.saturated = s.peak >= o.saturationLevel; }
    stars.push(s);
  }
  for (var j = 0; j < src.length; j++) { var r = src[j]; add(r[0], r[1], num(r[5]), num(r[6]), num(r[7]), null); }
  var merged = 0;
  for (var u = 0; u < o.supplement.length; u++) {
    var sp = o.supplement[u], pp = w.celestialToImage(new Point(sp.ra, sp.dec));
    if (pp) {
      var keep = [];
      for (var t = 0; t < stars.length; t++) {
        var st = stars[t], dx2 = st.x - pp.x, dy2 = st.y - pp.y;
        if (!st.supplement && dx2 * dx2 + dy2 * dy2 <= o.mergePx * o.mergePx) merged++; else keep.push(st);
      }
      stars = keep;
    }
    add(sp.ra, sp.dec, sp.mag, null, null, sp.name);
  }
  stars.sort(function (a, b) { return (a.G === null ? 99 : a.G) - (b.G === null ? 99 : b.G); });
  var nIn = 0, nSat = 0; for (var z = 0; z < stars.length; z++) { if (stars[z].inFrame) nIn++; if (stars[z].saturated) nSat++; }
  return JSON.stringify({ release: rel[0], probed: probed, searchRadiusDeg: S.radius, magLimit: o.magLimit, sources: src.length,
    stars: stars.length, inFrame: nIn, saturated: o.saturationLevel !== null ? nSat : null, mergedIntoSupplement: merged, list: stars });
})()`;
}

const catalogStars = {
  name: 'catalog_stars',
  description:
    'List catalogue stars over a plate-solved view from PixInsight\'s local Gaia database: one Gaia search centred on the image, ' +
    'with a radius reaching its corners (plus margin_fraction), down to mag_limit. Per star: image x, y, RA, Dec, G, BP-RP where the ' +
    'catalogue has them, whether it falls inside the frame, and for in-frame stars the peak luminance in a 5x5 box (with saturated = ' +
    'peak >= saturation_level when that is given). data_release omitted: releases are asked get-info in the order DR3/SP, DR3, EDR3, ' +
    'DR2 and the earliest of them that reports valid is searched; a failed search is reported, not retried on another release. supplement adds stars the ' +
    'catalogue lacks (marked with their name); a Gaia star within merge_px of one is replaced by it. Sorted by G, brightest at the top. ' +
    'The full list is written to a JSON file under <workspace>/agentic/scratch/catalog; the reply carries it inline up to 200 stars.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'Plate-solved view' },
      mag_limit: { type: 'number', description: 'Faintest G magnitude listed' },
      data_release: { type: 'string', enum: RELEASES.map((r) => r[0]), description: 'Gaia data release to search; omitted, the earliest valid one in the order DR3/SP, DR3, EDR3, DR2' },
      margin_fraction: { type: 'number', description: 'Extra search radius as a fraction of the centre-to-corner radius (default 0.05)' },
      saturation_level: { type: 'number', description: 'Peak luminance at or above which an in-frame star is flagged saturated; omitted, no flag' },
      supplement: {
        type: 'array',
        description: 'Stars to add: [{ra, dec, mag, name}] in degrees and catalogue-band magnitude',
        items: { type: 'object', properties: { ra: { type: 'number' }, dec: { type: 'number' }, mag: { type: 'number' }, name: { type: 'string' } } },
      },
      merge_px: { type: 'number', description: 'Distance in pixels within which a Gaia star is replaced by a supplement star (default 3)' },
    },
    required: ['view_id', 'mag_limit'],
  },
  async handler(api, input) {
    const rel = input.data_release === undefined ? null : RELEASES.find((r) => r[0] === input.data_release);
    if (input.data_release !== undefined && !rel) throw new Error(`data_release: expected one of ${RELEASES.map((r) => r[0]).join(', ')}`);
    const o = {
      viewId: String(input.view_id),
      magLimit: num(input.mag_limit, undefined, 'mag_limit'),
      magLow: -2,
      release: rel,
      order: RELEASES,
      marginFraction: num(input.margin_fraction, 0.05, 'margin_fraction'),
      saturationLevel: input.saturation_level === undefined ? null : num(input.saturation_level, undefined, 'saturation_level'),
      supplement: sanitizeSupplement(input.supplement),
      mergePx: num(input.merge_px, 3, 'merge_px'),
    };
    const out = await pjsrJson(api, catalogStarsPjsr(o), 'catalog_stars');
    const dir = path.join(api.workspace.scratchDir, 'catalog');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${o.viewId.replace(/[^A-Za-z0-9_]/g, '_')}_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    const { list, ...summary } = out;
    const body = { ...summary, file, ...(list.length <= INLINE_MAX ? { list } : { brightest: list.slice(0, 20) }) };
    return { text: JSON.stringify(body, null, 2) };
  },
};

export const tools = [catalogStars];
