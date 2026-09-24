// Tone tools: stretch_stars, auto_stretch, continuous_clamp (folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3, tests ported from pack-astro-stretch / pack-astro-narrowband)
// and robust_median_stretch (written from local/plans/statistical-stretch-spec.md; the test vectors
// V1-V7 below are that spec's §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { mtf, solveStretch, stretchSample, compressHighlight, stretchExpression } from '../src/tools/tone.mjs';
import { compilingApi } from './helpers.mjs';

const catalog = await buildCoreCatalog();
const def = (name) => catalog.definitions.find((d) => d.name === name);
const run = (name, api, input) => catalog.handlers.get(name)(api, input);

const TOL = 1e-6;
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= TOL, `${label}: ${actual} vs ${expected}`);

// ---------------------------------------------------------------------------
// robust_median_stretch: the scalar math (spec §3-§5)
// ---------------------------------------------------------------------------

function f(x, s) { return stretchSample(x, s); }

test('mtf identities: MTF(0.25, 0.25) = 0.5, MTF(0.75, MTF(0.25, 0.3)) = 0.3, MTF(0.5, x) = x', () => {
  close(mtf(0.25, 0.25), 0.5, 'MTF(m,m)');
  close(mtf(0.75, mtf(0.25, 0.3)), 0.3, 'inverse');
  for (const x of [0, 0.1, 0.37, 1]) close(mtf(0.5, x), x, `identity ${x}`);
  assert.equal(mtf(0.3, 0), 0);
  assert.equal(mtf(0.3, 1), 1);
});

test('V1 basic', () => {
  const s = solveStretch({ median: 0.02, mad: 0.002, blackPointSigma: 2.8, targetMedian: 0.25 });
  close(s.sigma, 0.0029652, 'sigma');
  close(s.c0, 0.01169744, 'c0');
  close(s.xbar, 0.008400828184, 'xbar');
  close(s.m, 0.02478603806, 'm');
  const want = [[0, 0], [0.01, 0], [0.01169744, 0], [0.02, 0.25], [0.05, 0.6133536255], [0.2, 0.9025438449], [1, 1]];
  for (const [x, y] of want) close(f(x, s), y, `f(${x})`);
});

test('V2 black point clamps at 0', () => {
  const s = solveStretch({ median: 0.001, mad: 0.001, blackPointSigma: 2.8, targetMedian: 0.2 });
  close(s.sigma, 0.0014826, 'sigma');
  assert.equal(s.c0, 0);
  close(s.xbar, 0.001, 'xbar');
  close(s.m, 0.003988035892, 'm');
  for (const [x, y] of [[0, 0], [0.001, 0.2], [0.01, 0.7161290323], [0.5, 0.9960119641], [1, 1]]) close(f(x, s), y, `f(${x})`);
});

test('V3 bright median, black point near it', () => {
  const s = solveStretch({ median: 0.5, mad: 0.01, blackPointSigma: 2.8, targetMedian: 0.25 });
  close(s.sigma, 0.014826, 'sigma');
  close(s.c0, 0.4584872, 'c0');
  close(s.xbar, 0.07666079177, 'xbar');
  close(s.m, 0.1994087153, 'm');
  for (const [x, y] of [[0.45, 0], [0.5, 0.25], [0.75, 0.8239899147], [1, 1]]) close(f(x, s), y, `f(${x})`);
});

test('V3b xbar > T darkens (m > 1/2), black point clamped', () => {
  const s = solveStretch({ median: 0.4, mad: 0.2, blackPointSigma: 2.0, targetMedian: 0.25 });
  close(s.sigma, 0.29652, 'sigma');
  assert.equal(s.c0, 0);
  close(s.xbar, 0.4, 'xbar');
  close(s.m, 0.6666666667, 'm');
  for (const [x, y] of [[0, 0], [0.2, 0.1111111111], [0.4, 0.25], [0.8, 0.6666666667], [1, 1]]) close(f(x, s), y, `f(${x})`);
});

test('V4 unlinked per-channel statistics', () => {
  const cases = [
    { median: 0.030, mad: 0.0020, c0: 0.0211044, xbar: 0.009087383782, m: 0.03538486752, at: [[0.03, 0.2], [0.1, 0.7049902641]] },
    { median: 0.025, mad: 0.0015, c0: 0.0183283, xbar: 0.006796263965, m: 0.02664186051, at: [[0.025, 0.2], [0.1, 0.7682722906]] },
    { median: 0.040, mad: 0.0030, c0: 0.0266566, xbar: 0.01370883082, m: 0.05266922288, at: [[0.04, 0.2], [0.1, 0.5944457480]] },
  ];
  for (const c of cases) {
    const s = solveStretch({ median: c.median, mad: c.mad, blackPointSigma: 3, targetMedian: 0.2 });
    close(s.c0, c.c0, 'c0');
    close(s.xbar, c.xbar, 'xbar');
    close(s.m, c.m, 'm');
    for (const [x, y] of c.at) close(f(x, s), y, `f(${x})`);
  }
});

test('V5 highlight compression alone', () => {
  for (const [y, want] of [[0.5, 0.5], [0.8, 0.8], [0.85, 0.825], [0.9, 0.86], [0.95, 0.9125], [1, 1]]) {
    close(compressHighlight(y, 0.8, 0.7), want, `y'(${y})`);
  }
});

// Plain median / MAD over a sample list (odd counts only, as the spec's vectors are).
const median = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) / 2];
const mad = (xs) => { const m = median(xs); return median(xs.map((x) => Math.abs(x - m))); };

test('V6 full pipeline on a 9-sample image, 2 passes', () => {
  let xs = [0.010, 0.012, 0.013, 0.014, 0.015, 0.016, 0.018, 0.050, 0.300];
  const expect = [
    { M: 0.015, D: 0.003, sigma: 0.0044478, c0: 0.0061044, xbar: 0.008950235820, m: 0.02637851952,
      out: [0.1268187055, 0.1804940556, 0.2050029667, 0.2281339387, 0.25, 0.2707021460, 0.3089676320, 0.6303747158, 0.9393812320] },
    { M: 0.25, D: 0.05896763197, sigma: 0.08742541116, c0: 0.07514917769, xbar: 0.1890584061, m: 0.4115581591,
      out: [0.07800641148, 0.1552591312, 0.1893250928, 0.2208112633, 0.25, 0.2771339052, 0.3260480761, 0.6823109484, 0.9532366991] },
  ];
  for (const e of expect) {
    close(median(xs), e.M, 'M');
    close(mad(xs), e.D, 'D');
    const s = solveStretch({ median: median(xs), mad: mad(xs), blackPointSigma: 2.0, targetMedian: 0.25 });
    close(s.sigma, e.sigma, 'sigma');
    close(s.c0, e.c0, 'c0');
    close(s.xbar, e.xbar, 'xbar');
    close(s.m, e.m, 'm');
    xs = xs.map((x) => f(x, s));
    xs.forEach((y, i) => close(y, e.out[i], `out[${i}]`));
  }
});

test('V7 linked vs unlinked on a 3-channel image', () => {
  const R = [0.020, 0.022, 0.024];
  const G = [0.018, 0.019, 0.021];
  const B = [0.030, 0.031, 0.035];
  const all = [...R, ...G, ...B];
  const joint = solveStretch({ median: median(all), mad: mad(all), blackPointSigma: 2.5, targetMedian: 0.2 });
  close(joint.median, 0.022, 'M');
  close(joint.mad, 0.003, 'D');
  close(joint.c0, 0.0108805, 'c0');
  close(joint.xbar, 0.01124181659, 'xbar');
  close(joint.m, 0.04350020245, 'm');
  const linked = [[0.1698596030, 0.2, 0.2281392573], [0.1374967277, 0.1539710608, 0.1851930527], [0.3023626410, 0.3134454949, 0.3546657795]];
  [R, G, B].forEach((ch, c) => ch.forEach((x, i) => close(f(x, joint), linked[c][i], `linked ${c}.${i}`)));

  const unlinked = [
    { c0: 0.014587, xbar: 0.007522734123, m: 0.02942682593, out: [0.1541039623, 0.2, 0.2413319825] },
    { c0: 0.0152935, xbar: 0.003764065739, m: 0.01488814311, out: [0.1542375010, 0.2, 0.2783349829] },
    { c0: 0.0272935, xbar: 0.003810501935, m: 0.01506973794, out: [0.1542358559, 0.2, 0.3429485800] },
  ];
  [R, G, B].forEach((ch, c) => {
    const s = solveStretch({ median: median(ch), mad: mad(ch), blackPointSigma: 2.5, targetMedian: 0.2 });
    close(s.c0, unlinked[c].c0, `c0 ${c}`);
    close(s.xbar, unlinked[c].xbar, `xbar ${c}`);
    close(s.m, unlinked[c].m, `m ${c}`);
    ch.forEach((x, i) => close(f(x, s), unlinked[c].out[i], `unlinked ${c}.${i}`));
  });
});

test('solveStretch refuses what no midtones balance can map (spec §6)', () => {
  assert.throws(() => solveStretch({ median: 0.02, mad: 0, blackPointSigma: 2.8, targetMedian: 0.25 }), /median sits on the black point/);
  assert.throws(() => solveStretch({ median: 0, mad: 0.01, blackPointSigma: 0, targetMedian: 0.25 }), /median sits on the black point/);
  assert.throws(() => solveStretch({ median: 1, mad: 0, blackPointSigma: 0, targetMedian: 0.25 }), /no range above the black point/);
});

// The PixelMath text is evaluated here with the PixelMath functions it uses, so the literal
// formulation is checked against the same vectors as the scalar math.
function evalPixelMath(expr, T) {
  const js = expr.replace(/\$T/g, `(${T})`);
  assert.doesNotMatch(js, /\bpow\b|\^/, 'no power in the expression');
  // eslint-disable-next-line no-new-func
  return new Function('min', 'max', 'iif', `return (${js});`)(Math.min, Math.max, (c, a, b) => (c ? a : b));
}

test('the PixelMath expression reproduces V1 and V2, and V5 when highlight compression is folded in', () => {
  const v1 = solveStretch({ median: 0.02, mad: 0.002, blackPointSigma: 2.8, targetMedian: 0.25 });
  for (const [x, y] of [[0, 0], [0.01, 0], [0.02, 0.25], [0.05, 0.6133536255], [0.2, 0.9025438449], [1, 1]]) {
    close(evalPixelMath(stretchExpression(v1, '$T'), x), y, `V1 ${x}`);
  }
  const v2 = solveStretch({ median: 0.001, mad: 0.001, blackPointSigma: 2.8, targetMedian: 0.2 });
  for (const [x, y] of [[0.001, 0.2], [0.01, 0.7161290323], [0.5, 0.9960119641]]) {
    close(evalPixelMath(stretchExpression(v2, '$T'), x), y, `V2 ${x}`);
  }
  // Identity stretch (c0 = 0, m = 1/2) isolates the highlight segment: V5.
  const identity = { c0: 0, m: 0.5 };
  for (const [y, want] of [[0.5, 0.5], [0.8, 0.8], [0.85, 0.825], [0.9, 0.86], [0.95, 0.9125], [1, 1]]) {
    close(evalPixelMath(stretchExpression(identity, '$T', { knee: 0.8, midtones: 0.7 }), y), want, `V5 ${y}`);
  }
});

test('the explicit rational MTF agrees with mtf() to 1e-6 across the range', () => {
  for (const m of [0.004, 0.0248, 0.2, 0.5, 0.67, 0.95]) {
    for (let x = 0; x <= 1; x += 0.05) {
      close(evalPixelMath(stretchExpression({ c0: 0, m }, '$T'), x), mtf(m, x), `m=${m} x=${x}`);
    }
  }
});

// ---------------------------------------------------------------------------
// robust_median_stretch: the tool
// ---------------------------------------------------------------------------

const measured = (channels, joint, per = [joint]) => JSON.stringify({ channels, joint, per });

test('robust_median_stretch: schema -- target_median and black_point_sigma required, no defaults', () => {
  const d = def('robust_median_stretch');
  assert.ok(d, 'tool exists');
  assert.deepEqual([...d.inputSchema.required].sort(), ['black_point_sigma', 'target_median', 'view_id']);
  for (const p of Object.values(d.inputSchema.properties)) assert.equal(p.default, undefined);
  for (const p of ['linked', 'passes', 'highlight_knee', 'highlight_midtones']) assert.ok(d.inputSchema.properties[p], p);
});

test('robust_median_stretch: one pass on a mono view measures, then applies one in-place PixelMath with literals', async () => {
  const { api, emitted } = compilingApi({ replies: [measured(1, { median: 0.02, mad: 0.002 }), 'ok'] });
  const out = await run('robust_median_stretch', api, { view_id: 'L_work', target_median: 0.25, black_point_sigma: 2.8 });
  assert.equal(out.isError, undefined, out.text);
  assert.equal(emitted.length, 2);
  assert.match(emitted[0], /windowById\("L_work"\)/);
  assert.match(emitted[0], /rangeClippingEnabled = false/);
  assert.match(emitted[0], /\.MAD\(/);
  assert.match(emitted[1], /new PixelMath/);
  assert.match(emitted[1], /useSingleExpression = true/);
  assert.match(emitted[1], /rescale = false/);
  assert.match(emitted[1], /truncate = true/);
  assert.match(emitted[1], /createNewImage = false/);
  assert.doesNotMatch(emitted[1], /\bpow\(|\^/);
  const r = JSON.parse(out.text);
  assert.equal(r.view_id, 'L_work');
  assert.equal(r.passes.length, 1);
  const g = r.passes[0].groups[0];
  close(g.c0, 0.01169744, 'c0');
  close(g.m, 0.02478603806, 'm');
  close(g.sigma, 0.0029652, 'sigma');
  close(g.xbar, 0.008400828184, 'xbar');
  assert.equal(r.highlight, null);
});

test('robust_median_stretch: a colour view needs linked; omitted, nothing is modified', async () => {
  const stats = { median: 0.03, mad: 0.002 };
  const { api, emitted } = compilingApi({ replies: [measured(3, stats, [stats, stats, stats])] });
  const out = await run('robust_median_stretch', api, { view_id: 'RGB', target_median: 0.2, black_point_sigma: 3 });
  assert.equal(out.isError, true);
  assert.match(out.text, /linked/);
  assert.equal(emitted.length, 1, 'only the measurement ran');
});

test('robust_median_stretch: unlinked colour writes one expression per channel with its own literals', async () => {
  const per = [{ median: 0.030, mad: 0.0020 }, { median: 0.025, mad: 0.0015 }, { median: 0.040, mad: 0.0030 }];
  const { api, emitted } = compilingApi({ replies: [measured(3, { median: 0.03, mad: 0.002 }, per), 'ok'] });
  const out = await run('robust_median_stretch', api, { view_id: 'RGB', target_median: 0.2, black_point_sigma: 3, linked: false });
  assert.equal(emitted.length, 2);
  assert.match(emitted[1], /useSingleExpression = false/);
  assert.match(emitted[1], /expression1 = /);
  assert.match(emitted[1], /expression2 = /);
  const groups = JSON.parse(out.text).passes[0].groups;
  assert.deepEqual(groups.map((g) => g.channel), ['R', 'G', 'B']);
  close(groups[0].m, 0.03538486752, 'R m');
  close(groups[1].m, 0.02664186051, 'G m');
  close(groups[2].m, 0.05266922288, 'B m');
});

test('robust_median_stretch: linked colour uses the joint statistics in one expression', async () => {
  const joint = { median: 0.022, mad: 0.003 };
  const { api, emitted } = compilingApi({ replies: [measured(3, joint, [joint, joint, joint]), 'ok'] });
  const out = await run('robust_median_stretch', api, { view_id: 'RGB', target_median: 0.2, black_point_sigma: 2.5, linked: 'true' });
  assert.match(emitted[1], /useSingleExpression = true/);
  const groups = JSON.parse(out.text).passes[0].groups;
  assert.deepEqual(groups.map((g) => g.channel), ['RGB']);
  close(groups[0].m, 0.04350020245, 'm');
});

test('robust_median_stretch: two passes work on a scratch copy and write the view once, at the end', async () => {
  const { api, emitted } = compilingApi({ replies: [
    measured(1, { median: 0.015, mad: 0.003 }), 'ok',
    measured(1, { median: 0.25, mad: 0.05896763197 }), 'ok',
  ] });
  const out = await run('robust_median_stretch', api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.0, passes: 2 });
  assert.equal(emitted.length, 4);
  assert.match(emitted[1], /createNewImage = true/);
  assert.match(emitted[1], /newImageId = "__rms_work"/);
  assert.match(emitted[2], /windowById\("__rms_work"\)/);
  assert.match(emitted[3], /__rms_work/, 'the last pass reads the scratch copy');
  assert.match(emitted[3], /windowById\("L"\)/, 'and writes the view');
  assert.match(emitted[3], /forceClose/);
  const r = JSON.parse(out.text);
  assert.equal(r.passes.length, 2);
  close(r.passes[1].groups[0].m, 0.4115581591, 'pass 2 m');
});

test('robust_median_stretch: a later pass that cannot be solved closes the scratch copy and leaves the view unmodified', async () => {
  const { api, emitted } = compilingApi({ replies: [
    measured(1, { median: 0.015, mad: 0.003 }), 'ok',
    measured(1, { median: 0.25, mad: 0 }), 'ok',
  ] });
  const out = await run('robust_median_stretch', api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.0, passes: 2 });
  assert.equal(out.isError, true);
  assert.match(out.text, /pass 2/);
  assert.match(out.text, /not modified/);
  assert.equal(emitted.length, 4);
  assert.match(emitted[3], /__rms_work/);
  assert.doesNotMatch(emitted[3], /PixelMath/);
});

test('robust_median_stretch: a zero MAD in pass 1 is an error and nothing is applied', async () => {
  const { api, emitted } = compilingApi({ replies: [measured(1, { median: 0.02, mad: 0 })] });
  const out = await run('robust_median_stretch', api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.8 });
  assert.equal(out.isError, true);
  assert.equal(emitted.length, 1);
});

test('robust_median_stretch: highlight compression folds into the last pass and is reported', async () => {
  const { api, emitted } = compilingApi({ replies: [measured(1, { median: 0.02, mad: 0.002 }), 'ok'] });
  const out = await run('robust_median_stretch', api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.8, highlight_knee: 0.8, highlight_midtones: 0.7 });
  assert.match(emitted[1], /iif\(/);
  assert.deepEqual(JSON.parse(out.text).highlight, { knee: 0.8, midtones: 0.7 });
});

test('robust_median_stretch: input errors are refused before any PJSR (spec §6)', async () => {
  const base = { view_id: 'L', target_median: 0.25, black_point_sigma: 2.8 };
  const bad = [
    { target_median: 0 }, { target_median: 1 }, { target_median: '0.2; evil()' },
    { black_point_sigma: -1 }, { black_point_sigma: Infinity },
    { passes: 0 }, { passes: 1.5 },
    { highlight_knee: 0.8 }, { highlight_midtones: 0.7 },
    { highlight_knee: 1, highlight_midtones: 0.7 }, { highlight_knee: 0.8, highlight_midtones: 0.5 },
    { linked: 'maybe' },
  ];
  for (const b of bad) {
    const { api, emitted } = compilingApi();
    const out = await run('robust_median_stretch', api, { ...base, ...b }).then((r) => r, (e) => ({ isError: true, text: e.message }));
    assert.equal(out.isError, true, JSON.stringify(b));
    assert.equal(emitted.length, 0, `${JSON.stringify(b)}: sent PJSR`);
  }
});

test('robust_median_stretch: the view id is quoted, never spliced', async () => {
  const { api, emitted } = compilingApi({ replies: [measured(1, { median: 0.02, mad: 0.002 }), 'ok'] });
  await run('robust_median_stretch', api, { view_id: "x'); evil(); ('", target_median: 0.25, black_point_sigma: 2.8 });
  assert.match(emitted[0], /windowById\("x'\); evil\(\); \('"\)/);
});

// ---------------------------------------------------------------------------
// stretch_stars (pack-astro-stretch, R1/R5/R6 applied)
// ---------------------------------------------------------------------------

test('stretch_stars: clips the pedestal then runs N MTF iterations at the midtone', async () => {
  const reply = JSON.stringify({ bgClip: 0.001, highFraction: 0.05, finalMedian: 0.01, finalMax: 0.9 });
  const { api, emitted } = compilingApi({ replies: [reply] });
  const out = await run('stretch_stars', api, { view_id: 'stars', midtone: 0.2, iterations: 5 });
  assert.match(emitted[0], /var m = 0\.2;/);
  assert.match(emitted[0], /for \(var i = 0; i < 5; i\+\+\)/);
  assert.match(out.text, /bgClip=0\.001000/);
  assert.match(out.text, /high_fraction=0\.0500/);
});

test('stretch_stars: midtone and iterations are required; no classification input', () => {
  const d = def('stretch_stars');
  assert.deepEqual([...d.inputSchema.required].sort(), ['iterations', 'midtone', 'view_id']);
  assert.equal(d.inputSchema.properties.classification, undefined);
  for (const p of Object.values(d.inputSchema.properties)) assert.equal(p.default, undefined);
});

test('stretch_stars: a layer with many bright pixels is stretched and its high fraction reported, not refused', async () => {
  const { api, emitted } = compilingApi({ replies: [JSON.stringify({ bgClip: 0, highFraction: 0.6, finalMedian: 0, finalMax: 1 })] });
  const out = await run('stretch_stars', api, { view_id: 'stars', midtone: 0.15, iterations: 7, classification: 'galaxy_spiral' });
  assert.notEqual(out.isError, true);
  assert.doesNotMatch(emitted[0], /alreadyStretched|highFraction > 0\.30/);
  assert.match(emitted[0], /var m = 0\.15;/, 'no galaxy floor');
  assert.match(emitted[0], /i < 7;/, 'no galaxy cap');
  assert.match(out.text, /high_fraction=0\.6000/);
});

test('stretch_stars: rejects a missing or non-numeric midtone before any PJSR', async () => {
  for (const input of [{ view_id: 's', iterations: 5 }, { view_id: 's', midtone: '0.2; evil()', iterations: 5 }, { view_id: 's', midtone: 0.2, iterations: 2.5 }]) {
    const { api, emitted } = compilingApi();
    await assert.rejects(run('stretch_stars', api, input), /midtone|iterations/);
    assert.equal(emitted.length, 0);
  }
});

test('stretch_stars: description gives no advice and names no other tool', () => {
  const d = def('stretch_stars').description;
  assert.doesNotMatch(d, /DO NOT|auto_stretch|seti|check_star_layer_integrity|star_protected_blend|galaxy|bloat/i);
});

// ---------------------------------------------------------------------------
// auto_stretch (pack-astro-stretch, class A)
// ---------------------------------------------------------------------------

// Expected values are computed by hand from PixInsight's DisplayFunction::ComputeAutoStretch
// (sigma = 1.4826 x MAD, linked c0 = mean over channels, m = MTF(target, mean median - c0)).
const H_OF = (code) => JSON.parse(code.match(/P\.H = (\[.*\]);/)[1]);
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-9, `${label}: ${a} vs ${b}`);
const IDENT = [0, 0.5, 1, 0, 1];

test('auto_stretch: mono, defaults: c0 = median - 2.8 x 1.4826 x MAD, m = MTF(0.25, median - c0)', async () => {
  const { api, emitted } = compilingApi({ stats: { median: 0.01, mad: 0.001 } });
  const out = await run('auto_stretch', api, { view_id: 'L' });
  assert.equal(emitted.length, 1);
  assert.match(emitted[0], /new HistogramTransformation/);
  const H = H_OF(emitted[0]);
  near(H[3][0], 0.00584872, 'c0');
  near(H[3][1], 0.01235129265168185, 'm');
  assert.deepEqual(H[3].slice(2), [1, 0, 1]);
  for (const i of [0, 1, 2, 4]) assert.deepEqual(H[i], IDENT);
  assert.match(out.text, /c0=0\.005849/);
  assert.doesNotMatch(out.text, /burn|reduce|apply/i);
});

test('auto_stretch: shadows_clipping and target_bg are applied; target_bg 0 is refused', async () => {
  const { api, emitted } = compilingApi({ stats: { median: 0.01, mad: 0.001 } });
  await run('auto_stretch', api, { view_id: 'L', shadows_clipping: -2, target_bg: 0.1 });
  const H = H_OF(emitted[0]);
  near(H[3][0], 0.0070348, 'c0');
  near(H[3][1], 0.026068415475457386, 'm');
  const bad = compilingApi({ stats: { median: 0.01, mad: 0.001 } });
  await assert.rejects(run('auto_stretch', bad.api, { view_id: 'L', target_bg: 0 }), /target_bg/);
  assert.equal(bad.emitted.length, 0);
});

const RGB_STATS = { median: 0.02, mad: 0.001, perChannel: { R: { median: 0.02, mad: 0.002 }, G: { median: 0.01, mad: 0.001 }, B: { median: 0.03, mad: 0 } } };

test('auto_stretch: colour, linked: c0 is the mean over channels (a zero-MAD channel adds 0), one transform on R, G, B', async () => {
  const { api, emitted } = compilingApi({ stats: RGB_STATS });
  await run('auto_stretch', api, { view_id: 'RGB', linked: true });
  const H = H_OF(emitted[0]);
  for (const i of [0, 1, 2]) {
    near(H[i][0], 0.00584872, `c0[${i}]`);
    near(H[i][1], 0.041285358659420235, `m[${i}]`);
    assert.deepEqual(H[i].slice(2), [1, 0, 1]);
  }
  assert.deepEqual(H[3], IDENT);
});

test('auto_stretch: colour, linked omitted = per-channel transforms (PixInsight default)', async () => {
  const { api, emitted } = compilingApi({ stats: RGB_STATS });
  await run('auto_stretch', api, { view_id: 'RGB' });
  const H = H_OF(emitted[0]);
  near(H[0][0], 0.01169744, 'c0 R'); near(H[0][1], 0.024500840601707766, 'm R');
  near(H[1][0], 0.00584872, 'c0 G'); near(H[1][1], 0.01235129265168185, 'm G');
  near(H[2][0], 0, 'c0 B'); near(H[2][1], 0.08490566037735849, 'm B');
  assert.deepEqual(H[3], IDENT);
});

test('auto_stretch: an inverted image (median above 0.5) clips highlights at median - shadows_clipping x sigma', async () => {
  const { api, emitted } = compilingApi({ stats: { median: 0.9, mad: 0.01 } });
  await run('auto_stretch', api, { view_id: 'L' });
  const H = H_OF(emitted[0]);
  near(H[3][0], 0, 'c0');
  near(H[3][1], 0.8850088123494033, 'm');
  near(H[3][2], 0.9415128, 'c1');
});

test('auto_stretch: a clipping point at or beyond the median is refused and nothing is sent', async () => {
  const { api, emitted } = compilingApi({ stats: { median: 0.01, mad: 0.001 } });
  await assert.rejects(run('auto_stretch', api, { view_id: 'L', shadows_clipping: 1 }), /no midtones balance/);
  assert.equal(emitted.length, 0);
});

test('auto_stretch: documents PixInsight\'s auto-stretch defaults and has no advice', () => {
  const d = def('auto_stretch');
  assert.equal(d.inputSchema.properties.target_bg.default, 0.25);
  assert.equal(d.inputSchema.properties.shadows_clipping.default, -2.8);
  assert.equal(d.inputSchema.properties.linked.default, false);
  assert.match(d.description, /1\.4826/);
  assert.doesNotMatch(d.description, /Seti|simpler|preview/i);
});

// ---------------------------------------------------------------------------
// continuous_clamp (pack-astro-narrowband, R1/R2 applied)
// ---------------------------------------------------------------------------

const clampReply = JSON.stringify({ median: 0.1, max: 0.9, blur_sigma: 60 });

test('continuous_clamp: soft-compresses above a per-pixel knee from a blurred luminance mask', async () => {
  const { api, emitted } = compilingApi({ replies: [clampReply] });
  const out = await run('continuous_clamp', api, { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft', headroom: 0.12, rate: 3 });
  assert.match(emitted[0], /var knee = '0\.8 \+ [\d.]+ \* \(1 - ' \+ tmpId \+ '\)';/);
  assert.match(emitted[0], /var mode = "soft";/);
  assert.match(emitted[0], /var hd = '0\.12';/);
  assert.match(emitted[0], /var rt = '3';/);
  assert.match(emitted[0], /Math\.max\(60, Math\.round\(w \/ 100\)\)/);
  assert.match(out.text, /soft mode/);
  assert.match(out.text, /headroom=0\.12, rate=3/);
});

test('continuous_clamp: hard mode needs no headroom or rate', async () => {
  const { api, emitted } = compilingApi({ replies: [clampReply] });
  const out = await run('continuous_clamp', api, { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'hard', blur_sigma: 30 });
  assert.match(emitted[0], /var mode = "hard";/);
  assert.match(emitted[0], /var blurSigma = 30;/);
  assert.match(out.text, /hard mode/);
  assert.doesNotMatch(out.text, /headroom/);
});

test('continuous_clamp: min_clamp, max_clamp and mode are required; soft mode needs headroom and rate', async () => {
  const d = def('continuous_clamp');
  assert.deepEqual([...d.inputSchema.required].sort(), ['max_clamp', 'min_clamp', 'mode', 'view_id']);
  for (const p of Object.values(d.inputSchema.properties)) assert.equal(p.default, undefined);
  for (const input of [
    { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft', rate: 3 },
    { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft', headroom: 0.12 },
    { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: "soft'; evil(); '", headroom: 0.12, rate: 3 },
    { view_id: 'RGB', max_clamp: 0.95, mode: 'hard' },
  ]) {
    const { api, emitted } = compilingApi();
    await assert.rejects(run('continuous_clamp', api, input), /headroom|rate|mode|min_clamp/);
    assert.equal(emitted.length, 0);
  }
});

test('continuous_clamp: description gives no advice', () => {
  const d = def('continuous_clamp');
  assert.doesNotMatch(d.description, /ZERO|legacy|destroy|default/i);
  for (const p of Object.values(d.inputSchema.properties)) assert.doesNotMatch(p.description, /default|Higher =|Lower =|gentle|aggressive/i);
});

test('continuous_clamp refuses a soft-mode headroom that is not positive before sending PJSR', async () => {
  for (const v of [0, -0.1]) {
    const { api, emitted } = compilingApi({ replies: [clampReply] });
    await assert.rejects(run('continuous_clamp', api, { view_id: 'RGB', min_clamp: 0.8, max_clamp: 0.95, mode: 'soft', headroom: v, rate: 3 }), /headroom/);
    assert.equal(emitted.length, 0);
  }
});

test('robust_median_stretch: a failed PixelMath in any pass of several closes the scratch copy', async () => {
  const err = { status: 'error', error: { message: 'boom' } };
  // last pass fails
  const a = compilingApi({ replies: [measured(1, { median: 0.015, mad: 0.003 }), 'ok', measured(1, { median: 0.25, mad: 0.05896763197 }), err, 'ok'] });
  await assert.rejects(run('robust_median_stretch', a.api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.0, passes: 2 }), /pass 2 failed/);
  assert.equal(a.emitted.length, 5);
  assert.match(a.emitted[4], /windowById\("__rms_work"\)[\s\S]*forceClose/);
  // first pass (the one that creates the copy) fails
  const b = compilingApi({ replies: [measured(1, { median: 0.015, mad: 0.003 }), err, 'ok'] });
  await assert.rejects(run('robust_median_stretch', b.api, { view_id: 'L', target_median: 0.25, black_point_sigma: 2.0, passes: 2 }), /pass 1 failed/);
  assert.equal(b.emitted.length, 3);
  assert.match(b.emitted[2], /forceClose/);
});
