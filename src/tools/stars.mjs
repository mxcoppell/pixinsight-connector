// ============================================================================
// Star tools: star_protected_blend and restore_star_color, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (tools/stars.mjs). Every value that
// shapes the result is a required input, including the colour cap the pack hid
// at 0.98. The blend depends on no record left by another call. The pack's
// star_screen_blend alias is not carried over.
// ============================================================================
import { q, num, vid, fixed, lit } from './pjsr-args.mjs';

// Three per-channel PixelMath expressions sharing `symbols` (a fixed list from this module, never
// input), run in place on `targetId`.
function perChannelPixelMath(targetId, exprs, symbols) {
  return `
        var P = new PixelMath;
        P.expression = ${q(exprs[0])};
        P.expression1 = ${q(exprs[1])};
        P.expression2 = ${q(exprs[2])};
        P.useSingleExpression = false;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.symbols = '${symbols}';
        var __w = ImageWindow.windowById(${q(targetId)});
        if (__w.isNull) throw new Error('View not found: ' + ${q(targetId)});
        P.executeOn(__w.mainView);`;
}

// Bright-area colour restoration: keep the current luminance, take the colour ratios of
// `preId`, weighted in from `start` to `end` of the reference luminance, capped at `maxValue`.
function restoreExprs(preId, start, end, maxValue) {
  const range = lit(end - start);
  return [0, 1, 2].map((c) => [
    `Lp = (${preId}[0] + ${preId}[1] + ${preId}[2]) / 3`,
    'Lb = ($T[0] + $T[1] + $T[2]) / 3',
    `restored = min(${preId}[${c}] * Lb / max(Lp, 0.001), ${maxValue})`,
    `wr = iif(Lp < ${start}, 0.0, iif(Lp > ${end}, 1.0, (Lp - ${start}) / ${range}))`,
    '$T * (1 - wr) + restored * wr',
  ].join('; '));
}

// A ramp from `low` to `high` divides by their difference.
function ordered(low, high, lowName, highName) {
  if (!(low < high)) throw new Error(`${lowName} (${low}) must be less than ${highName} (${high})`);
}

const before = (s) => `median=${fixed(s.median, 4)}, max=${fixed(s.max, 4)}`;

const starProtectedBlend = {
  name: 'star_protected_blend',
  description: 'Blend a stars-only image into a starless one in place, as a screen blend that turns colour-preserving in bright star cores. The mode follows, per pixel, the star layer\'s own luminance SL (the mean of its three channels). ' +
    'Below core_threshold_low: per-channel screen blend 1 - (1 - target) * (1 - stars * k). Above core_threshold_high: luminance-only screen blend, the target\'s colour scaled by the new over the old luminance and capped at max_value. ' +
    'Between them the two blend linearly. k = strength * prot, where prot falls linearly from 1 at core_threshold_low to min_strength_fraction at core_threshold_high. ' +
    'With pre_star_id, the bright-area colour ratios of that view are then restored over the same luminance ramp (see restore_star_color). Runs as 64-bit PixelMath truncated to [0,1]; reports the target\'s median and max before and after.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_id: { type: 'string', description: 'Starless RGB view, modified in place' },
      stars_id: { type: 'string', description: 'Stars-only RGB view' },
      strength: { type: 'number', description: 'Multiplier k on the star layer in the screen blend, before protection' },
      core_threshold_low: { type: 'number', description: 'Star luminance SL at and below which the pure screen blend applies and protection is 1' },
      core_threshold_high: { type: 'number', description: 'Star luminance SL at and above which the pure colour-preserving blend applies and protection is min_strength_fraction; greater than core_threshold_low' },
      min_strength_fraction: { type: 'number', description: 'Protection factor reached at core_threshold_high (strength is multiplied by it)' },
      max_value: { type: 'number', description: 'Upper cap on each channel of the colour-preserving blend, and of the colour restoration when pre_star_id is given' },
      pre_star_id: { type: 'string', description: 'Optional: RGB view whose colour ratios are restored in bright areas after the blend; empty or absent = no restoration' },
    },
    required: ['target_id', 'stars_id', 'strength', 'core_threshold_low', 'core_threshold_high', 'min_strength_fraction', 'max_value'],
  },
  async handler(api, input) {
    const targetId = vid(input.target_id, 'target_id');
    const starsId = vid(input.stars_id, 'stars_id');
    // Any falsy pre_star_id means "no restoration".
    const preId = input.pre_star_id ? vid(input.pre_star_id, 'pre_star_id') : undefined;
    const str = num(input.strength, undefined, 'strength');
    const low = num(input.core_threshold_low, undefined, 'core_threshold_low');
    const high = num(input.core_threshold_high, undefined, 'core_threshold_high');
    const minFrac = num(input.min_strength_fraction, undefined, 'min_strength_fraction');
    const maxValue = num(input.max_value, undefined, 'max_value');
    ordered(low, high, 'core_threshold_low', 'core_threshold_high');

    const preStat = await api.stats(targetId);

    // Hybrid blend: screen in dark areas, colour-preserving in bright ones.
    //   L    target luminance            SL   star luminance
    //   prot protection ramp (1 in dark, minFrac in the brightest star cores)
    //   rgb  normal screen blend          Lrgb luminance-only screen
    //   cp   target colour scaled by Lrgb/L (preserves colour ratios)
    //   w    0 = pure screen, 1 = pure colour-preserving
    // Both ramps are gated on the STAR's own brightness (SL), not the starless target's (L): a
    // bright isolated star sits on dark sky, so L stays low and gating on L would never switch
    // an isolated star core to the colour-preserving branch.
    const invRange = lit(1 - minFrac);
    const range = lit(high - low);
    const channelExprs = [0, 1, 2].map((c) => [
      `L = (${targetId}[0] + ${targetId}[1] + ${targetId}[2]) / 3`,
      `SL = (${starsId}[0] + ${starsId}[1] + ${starsId}[2]) / 3`,
      `prot = iif(SL < ${low}, 1.0, iif(SL > ${high}, ${minFrac}, 1.0 - ${invRange} * (SL - ${low}) / ${range}))`,
      `k = ${str} * prot`,
      `rgb = 1 - (1 - $T) * (1 - ${starsId}[${c}] * k)`,
      'Lrgb = 1 - (1 - L) * (1 - SL * k)',
      `cp = min(${targetId}[${c}] * Lrgb / max(L, 0.001), ${maxValue})`,
      `w = iif(SL < ${low}, 0.0, iif(SL > ${high}, 1.0, (SL - ${low}) / ${range}))`,
      'rgb * (1 - w) + cp * w',
    ].join('; '));

    const r = await api.pjsr(perChannelPixelMath(targetId, channelExprs, 'L, SL, prot, k, rgb, Lrgb, cp, w'));
    if (r.status === 'error') throw new Error(`star blend failed: ${r.error?.message}`);

    let restorationNote = '';
    if (preId) {
      const rr = await api.pjsr(perChannelPixelMath(targetId, restoreExprs(preId, low, high, maxValue), 'Lp, Lb, restored, wr'));
      if (rr.status === 'error') throw new Error(`star colour restoration failed: ${rr.error?.message}`);
      restorationNote = `, colour restoration from ${preId}`;
    }

    const postStat = await api.stats(targetId);
    return {
      text: `Stars blended (strength=${str}, core=[${low},${high}], min_strength_fraction=${minFrac}, max_value=${maxValue}${restorationNote}). ` +
        `Before: ${before(preStat)} -> After: ${before(postStat)}`,
    };
  },
};

const restoreStarColor = {
  name: 'restore_star_color',
  description: 'Restore the colour ratios of a reference view in the bright areas of a target, in place, keeping the target\'s luminance. ' +
    'Per channel: restored = min(reference[c] * Lt / max(Lr, 0.001), max_value), where Lt and Lr are the target\'s and the reference\'s channel means; ' +
    'it is weighted in linearly from 0 at reference luminance restore_start to 1 at restore_end. Runs as 64-bit PixelMath truncated to [0,1]; reports the target\'s median and max before and after.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_id: { type: 'string', description: 'RGB view to modify in place' },
      pre_star_id: { type: 'string', description: 'Reference RGB view whose colour ratios are restored (open, same dimensions)' },
      restore_start: { type: 'number', description: 'Reference luminance at and below which the target is unchanged' },
      restore_end: { type: 'number', description: 'Reference luminance at and above which the restored colour fully replaces the target; greater than restore_start' },
      max_value: { type: 'number', description: 'Upper cap on each restored channel' },
    },
    required: ['target_id', 'pre_star_id', 'restore_start', 'restore_end', 'max_value'],
  },
  async handler(api, input) {
    const targetId = vid(input.target_id, 'target_id');
    const preId = vid(input.pre_star_id, 'pre_star_id');
    const start = num(input.restore_start, undefined, 'restore_start');
    const end = num(input.restore_end, undefined, 'restore_end');
    const maxValue = num(input.max_value, undefined, 'max_value');
    ordered(start, end, 'restore_start', 'restore_end');
    const preStat = await api.stats(targetId);
    const r = await api.pjsr(perChannelPixelMath(targetId, restoreExprs(preId, start, end, maxValue), 'Lp, Lb, restored, wr'));
    if (r.status === 'error') throw new Error(`restore_star_color failed: ${r.error?.message}`);
    const postStat = await api.stats(targetId);
    return {
      text: `Colour restoration applied (reference=${preId}, range=[${start},${end}], max_value=${maxValue}). ` +
        `Before: ${before(preStat)} -> After: ${before(postStat)}`,
    };
  },
};

export const tools = [starProtectedBlend, restoreStarColor];
