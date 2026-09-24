// ============================================================================
// Pixel measurements behind the measure_* tools in measure.mjs, folded in from
// mxcoppell/pixinsight-pack-astro@eee19b3 (lib/quality-gates.mjs and
// lib/subject-metrics.mjs). A helper module: it exports no `tools` array, so
// src/tools/index.mjs's scan passes over it.
//
// Each function runs one PJSR measurement snippet and returns its numbers under
// the names the tool reports. None of them judges a result: the pack's pass/fail
// verdicts, their limits and the advice text are gone; a threshold that decides
// what is counted is a caller input. A PixInsight error, or output that is not
// the measurement, throws; no function returns a stand-in number.
// ============================================================================
import { q, num } from './pjsr-args.mjs';

// Runs `code` and returns its parsed JSON; throws with PixInsight's error, or when the output is not
// JSON carrying the number `key` (or the snippet's own { mono: true } / too_few_subject_pixels report).
async function measureJson(api, code, what, key) {
  const r = await api.pjsr(code);
  if (r.status === 'error') throw new Error(`${what} failed: ${r.error?.message || JSON.stringify(r.error)}`);
  const raw = String(r.outputs?.consoleOutput ?? '').trim();
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  const reported = data && typeof data === 'object'
    && (typeof data[key] === 'number' || data.mono === true || data.error === 'too_few_subject_pixels');
  if (!reported) {
    throw new Error(`${what}: could not read a measurement from PixInsight's output: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  return data;
}

// A view that must have three channels; the snippet reports { mono: true } otherwise.
class MonoImageError extends Error {}
function requireColor(data, what, viewId) {
  if (data.mono) throw new MonoImageError(`${what}: ${viewId} is a mono image; this measurement needs three channels`);
  return data;
}
export { MonoImageError };

/**
 * Stars: bright local maxima found by a 16 px scan over median + 5 MAD, de-duplicated within 20 px,
 * the 30 brightest measured. FWHM = twice the mean half-maximum radius over four directions
 * (luminance, up to 10 px); colour diversity = max-min of the peak's max-normalised RGB.
 */
export async function measureStars(api, viewId) {
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_stars: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;

    // Find stars by scanning for bright local maxima (no StarDetector — it crashes on getIntensity)
    // Scan every 16th pixel, find peaks above background + 5*MAD, verify local maximum in 5x5
    var bgMedian = img.median();
    var bgMAD = img.MAD();
    var threshold = bgMedian + 5 * bgMAD;
    var step = 16;
    var halfBox = 10;
    var candidates = [];

    // Get luminance for color images
    function getLum(x, y) {
      if (isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    // Coarse scan for bright pixels
    for (var y = halfBox + 1; y < img.height - halfBox - 1; y += step) {
      for (var x = halfBox + 1; x < img.width - halfBox - 1; x += step) {
        var lum = getLum(x, y);
        if (lum > threshold) {
          // Refine: find local max in 5x5 around this point
          var bestX = x, bestY = y, bestLum = lum;
          for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
              var l = getLum(x + dx, y + dy);
              if (l > bestLum) { bestLum = l; bestX = x + dx; bestY = y + dy; }
            }
          }
          // Check it's actually a local max (not on a nebula edge)
          var isMax = true;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (getLum(bestX + dx, bestY + dy) > bestLum) { isMax = false; break; }
            }
            if (!isMax) break;
          }
          if (isMax && bestLum > threshold) {
            candidates.push({ x: bestX, y: bestY, peak: bestLum });
          }
        }
      }
    }

    // Deduplicate: merge candidates within 20px of each other
    candidates.sort(function(a, b) { return b.peak - a.peak; });
    var stars = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var isDupe = false;
      for (var j = 0; j < stars.length; j++) {
        var dist = Math.sqrt((c.x - stars[j].x) * (c.x - stars[j].x) + (c.y - stars[j].y) * (c.y - stars[j].y));
        if (dist < 20) { isDupe = true; break; }
      }
      if (!isDupe) stars.push(c);
      if (stars.length >= 100) break;
    }

    // Measure FWHM and color for top 30 stars
    var topStars = stars.slice(0, 30);
    var fwhms = [];
    var colorDivs = [];

    for (var i = 0; i < topStars.length; i++) {
      var s = topStars[i];
      var cx = s.x, cy = s.y;

      // FWHM: measure half-max radius in 4 directions
      var halfMax = s.peak / 2;
      var radii = [];
      var dirs = [[1,0],[0,1],[-1,0],[0,-1]];
      for (var d = 0; d < 4; d++) {
        for (var r = 1; r <= halfBox; r++) {
          var px = cx + dirs[d][0] * r;
          var py = cy + dirs[d][1] * r;
          if (px < 0 || px >= img.width || py < 0 || py >= img.height) break;
          if (getLum(px, py) < halfMax) { radii.push(r); break; }
        }
      }
      if (radii.length >= 2) {
        var avgRadius = 0;
        for (var ri = 0; ri < radii.length; ri++) avgRadius += radii[ri];
        avgRadius /= radii.length;
        fwhms.push(avgRadius * 2); // FWHM = 2 * half-max radius
      }

      // Color diversity
      if (isColor) {
        var chPeaks = [img.sample(cx, cy, 0), img.sample(cx, cy, 1), img.sample(cx, cy, 2)];
        var maxPeak = Math.max(chPeaks[0], chPeaks[1], chPeaks[2]);
        if (maxPeak > 0.01) {
          var normR = chPeaks[0] / maxPeak;
          var normG = chPeaks[1] / maxPeak;
          var normB = chPeaks[2] / maxPeak;
          var cdiv = Math.max(normR, normG, normB) - Math.min(normR, normG, normB);
          colorDivs.push(cdiv);
        }
      }
    }

    // Compute median FWHM
    fwhms.sort(function(a, b) { return a - b; });
    var medFWHM = fwhms.length > 0 ? fwhms[Math.floor(fwhms.length / 2)] : 0;

    // Compute median color diversity
    colorDivs.sort(function(a, b) { return a - b; });
    var medColorDiv = colorDivs.length > 0 ? colorDivs[Math.floor(colorDivs.length / 2)] : 0;

    // Star brightness: collect peak luminance values for all detected stars
    var starPeaks = [];
    for (var si = 0; si < topStars.length; si++) {
      starPeaks.push(topStars[si].peak);
    }
    starPeaks.sort(function(a, b) { return a - b; });
    var medianPeak = starPeaks.length > 0 ? starPeaks[Math.floor(starPeaks.length / 2)] : 0;
    var p25Peak = starPeaks.length >= 4 ? starPeaks[Math.floor(starPeaks.length * 0.25)] : medianPeak;
    var starBgContrast = bgMedian > 0.001 ? medianPeak / bgMedian : 0;

    JSON.stringify({
      starsFound: stars.length,
      starsMeasured: fwhms.length,
      medianFWHM: medFWHM,
      colorDiversity: medColorDiv,
      fwhms: fwhms.slice(0, 10),
      colorDivs: colorDivs.slice(0, 10),
      medianPeak: medianPeak,
      p25Peak: p25Peak,
      bgMedian: bgMedian,
      starBgContrast: starBgContrast,
      starPeaks: starPeaks.slice(0, 10)
    });
  `, 'measure_stars', 'medianFWHM');
  return {
    median_fwhm_px: data.medianFWHM,
    color_diversity: data.colorDiversity,
    stars_found: data.starsFound,
    stars_measured: data.starsMeasured,
    median_peak: data.medianPeak,
    p25_peak: data.p25Peak,
    background_median: data.bgMedian,
    star_background_contrast: data.starBgContrast,
    samples: { fwhm: data.fwhms, color: data.colorDivs, peak: data.starPeaks },
  };
}

/**
 * A star layer: overall max; over every 4th pixel whose max channel is above 0.005, the fraction whose
 * max channel is above each of `levels`, the IQR of HSV saturation, and the median chroma of the 20
 * brightest (R+G+B) of them. The median is api.stats' median (the mean of channel medians for colour).
 */
export async function measureStarLayer(api, viewId, levels) {
  if (!Array.isArray(levels) || levels.length === 0) throw new Error('levels: expected a non-empty array of numbers');
  const lv = levels.map((v, i) => num(v, undefined, `levels[${i}]`));
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_star_layer: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;
    var levels = ${JSON.stringify(lv)};

    // Per-channel max
    var maxVal = 0;
    if (isColor) {
      for (var c = 0; c < 3; c++) {
        img.selectedChannel = c;
        var chMax = img.maximum();
        if (chMax > maxVal) maxVal = chMax;
      }
      img.resetChannelSelection();
    } else {
      maxVal = img.maximum();
    }

    // Sample every 4th pixel, find non-zero pixels (> 0.005)
    var step = 4;
    var nonzeroCount = 0;
    var above = [];
    for (var li = 0; li < levels.length; li++) above.push(0);
    var hsvSatValues = [];
    var brightPixels = []; // top brightness pixels for chroma check

    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        var val;
        if (isColor) {
          var rv = img.sample(x, y, 0);
          var gv = img.sample(x, y, 1);
          var bv = img.sample(x, y, 2);
          val = Math.max(rv, gv, bv);
        } else {
          val = img.sample(x, y);
        }

        if (val > 0.005) {
          nonzeroCount++;

          // Level counts: any channel above the level (val is the max channel)
          for (var li = 0; li < levels.length; li++) {
            if (val > levels[li]) above[li]++;
          }

          if (isColor) {
            // HSV saturation for color diversity
            var maxC = Math.max(rv, gv, bv);
            var minC = Math.min(rv, gv, bv);
            var hsvS = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            hsvSatValues.push(hsvS);

            // Track bright pixels for chroma check
            var brightness = rv + gv + bv;
            if (brightPixels.length < 20 || brightness > brightPixels[brightPixels.length - 1].b) {
              brightPixels.push({ b: brightness, r: rv, g: gv, bv: bv });
              brightPixels.sort(function(a, b) { return b.b - a.b; });
              if (brightPixels.length > 20) brightPixels.length = 20;
            }
          }
        }
      }
    }

    var fractionsAbove = [];
    for (var li = 0; li < levels.length; li++) fractionsAbove.push(nonzeroCount > 0 ? above[li] / nonzeroCount : 0);

    // Color diversity: spread of HSV saturation values
    var colorDiv = 0;
    if (hsvSatValues.length > 10) {
      hsvSatValues.sort(function(a, b) { return a - b; });
      // IQR-based spread
      var q25 = hsvSatValues[Math.floor(hsvSatValues.length * 0.25)];
      var q75 = hsvSatValues[Math.floor(hsvSatValues.length * 0.75)];
      colorDiv = q75 - q25;
    }

    // Bright star chroma: top 20 brightest -> median of (max-min)/max per pixel
    var chromaValues = [];
    for (var i = 0; i < brightPixels.length; i++) {
      var p = brightPixels[i];
      var pMax = Math.max(p.r, p.g, p.bv);
      var pMin = Math.min(p.r, p.g, p.bv);
      chromaValues.push(pMax > 0.001 ? (pMax - pMin) / pMax : 0);
    }
    chromaValues.sort(function(a, b) { return a - b; });
    var brightStarChroma = chromaValues.length > 0 ? chromaValues[Math.floor(chromaValues.length / 2)] : 0;

    JSON.stringify({
      max_value: maxVal,
      fractions_above: fractionsAbove,
      color_diversity: colorDiv,
      bright_star_chroma: brightStarChroma,
      nonzero_pixel_count: nonzeroCount
    });
  `, 'measure_star_layer', 'max_value');
  const stats = await api.stats(viewId);
  const fractionAbove = {};
  lv.forEach((level, i) => { fractionAbove[String(level)] = data.fractions_above?.[i]; });
  return {
    max: data.max_value,
    median: stats.median,
    fraction_above: fractionAbove,
    color_diversity: data.color_diversity,
    bright_star_chroma: data.bright_star_chroma,
    nonzero_pixel_count: data.nonzero_pixel_count,
  };
}

/**
 * Ringing: the radial luminance profile (up to 150 radii x 36 angles) around the centre of the
 * brightest 64 px block; a derivative sign change (derivatives within ±0.001 carry no sign) is
 * counted when the summed |derivative| of the run it ends is above `minAmplitude`.
 */
export async function measureRinging(api, viewId, minAmplitude) {
  const amp = num(minAmplitude, undefined, 'min_amplitude');
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_ringing: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;

    // Find brightest region: scan 64x64 blocks, find block with highest mean
    var blockSize = 64;
    var bestMean = 0;
    var bestX = 0, bestY = 0;
    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        if (img.isColor) {
          // Use luminance approximation
          var chMeans = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeans.push(img.mean());
          }
          img.resetChannelSelection();
          var lum = 0.2126 * chMeans[0] + 0.7152 * chMeans[1] + 0.0722 * chMeans[2];
          if (lum > bestMean) {
            bestMean = lum;
            bestX = bx + Math.floor(blockSize / 2);
            bestY = by + Math.floor(blockSize / 2);
          }
        } else {
          var m = img.mean();
          if (m > bestMean) {
            bestMean = m;
            bestX = bx + Math.floor(blockSize / 2);
            bestY = by + Math.floor(blockSize / 2);
          }
        }
      }
    }
    img.resetSelections();

    // Now compute radial brightness profile from the brightest center
    var numRadii = 150;
    var numAngles = 36;
    var maxRadius = Math.min(numRadii, Math.min(
      Math.min(bestX, img.width - bestX - 1),
      Math.min(bestY, img.height - bestY - 1)
    ));

    // For each radius, average brightness across angles
    var profile = [];
    for (var ri = 1; ri <= maxRadius; ri++) {
      var sum = 0;
      var count = 0;
      for (var ai = 0; ai < numAngles; ai++) {
        var angle = ai * 2 * Math.PI / numAngles;
        var px = Math.round(bestX + ri * Math.cos(angle));
        var py = Math.round(bestY + ri * Math.sin(angle));
        if (px >= 0 && px < img.width && py >= 0 && py < img.height) {
          if (img.isColor) {
            // Luminance
            var lum = 0;
            for (var c = 0; c < 3; c++) {
              img.selectedChannel = c;
              var v = img.sample(px, py);
              lum += c === 0 ? v * 0.2126 : c === 1 ? v * 0.7152 : v * 0.0722;
            }
            img.resetChannelSelection();
            sum += lum;
          } else {
            sum += img.sample(px, py);
          }
          count++;
        }
      }
      profile.push(count > 0 ? sum / count : 0);
    }

    // Count derivative sign changes (oscillations) with amplitude threshold
    var derivatives = [];
    for (var i = 1; i < profile.length; i++) {
      derivatives.push(profile[i] - profile[i - 1]);
    }

    var signChanges = 0;
    var maxAmp = 0;
    var lastSign = 0;
    var runStart = 0;

    for (var i = 0; i < derivatives.length; i++) {
      var sign = derivatives[i] > 0.001 ? 1 : derivatives[i] < -0.001 ? -1 : 0;
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
        // Sign change — measure amplitude of the run
        var amp = 0;
        for (var j = runStart; j <= i; j++) {
          amp += Math.abs(derivatives[j]);
        }
        if (amp > ${amp}) {
          signChanges++;
          if (amp > maxAmp) maxAmp = amp;
        }
        runStart = i;
      }
      if (sign !== 0) lastSign = sign;
    }

    JSON.stringify({
      center: [bestX, bestY],
      oscillations: signChanges,
      maxAmplitude: maxAmp,
      profileSample: profile.slice(0, 30)
    });
  `, 'measure_ringing', 'oscillations');
  return { oscillations: data.oscillations, max_amplitude: data.maxAmplitude, center: data.center, profile_sample: data.profileSample };
}

/**
 * Sharpness: mean Sobel gradient energy of luminance over every 4th pixel of `roi` ({ x, y, w, h }),
 * or of the central half of the image when `roi` is omitted.
 */
export async function measureSharpness(api, viewId, roi) {
  const roiSpec = roi
    ? `var rx=${num(roi.x, undefined, 'roi_x')},ry=${num(roi.y, undefined, 'roi_y')},rw=${num(roi.w, undefined, 'roi_w')},rh=${num(roi.h, undefined, 'roi_h')};`
      + `if (rx < 0 || ry < 0 || rx + rw > img.width || ry + rh > img.height) throw new Error('measure_sharpness: roi ' + rx + ',' + ry + ' ' + rw + 'x' + rh + ' is not inside the image ' + img.width + 'x' + img.height);`
    : `var rw=Math.floor(img.width*0.5);var rh=Math.floor(img.height*0.5);var rx=Math.floor((img.width-rw)/2);var ry=Math.floor((img.height-rh)/2);`;

  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_sharpness: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;

    ${roiSpec}

    // Compute Sobel gradient energy on luminance
    // Sample every 4th pixel for speed
    var step = 4;
    var totalEnergy = 0;
    var count = 0;

    function getLum(px, py) {
      if (img.isColor) {
        var r = img.sample(px, py, 0);
        var g = img.sample(px, py, 1);
        var b = img.sample(px, py, 2);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      return img.sample(px, py);
    }

    for (var y = ry + 1; y < ry + rh - 1; y += step) {
      for (var x = rx + 1; x < rx + rw - 1; x += step) {
        // Sobel 3x3
        var tl = getLum(x-1, y-1), tc = getLum(x, y-1), tr = getLum(x+1, y-1);
        var ml = getLum(x-1, y),                          mr = getLum(x+1, y);
        var bl = getLum(x-1, y+1), bc = getLum(x, y+1), br = getLum(x+1, y+1);

        var gx = -tl + tr - 2*ml + 2*mr - bl + br;
        var gy = -tl - 2*tc - tr + bl + 2*bc + br;
        totalEnergy += gx * gx + gy * gy;
        count++;
      }
    }

    var avgEnergy = count > 0 ? totalEnergy / count : 0;

    JSON.stringify({
      sharpness: avgEnergy,
      samplesUsed: count,
      roi: { x: rx, y: ry, w: rw, h: rh }
    });
  `, 'measure_sharpness', 'sharpness');
  return { sharpness: data.sharpness, samples: data.samplesUsed, roi: data.roi };
}

export const CORE_WIDE_BOX = 128;
export const CORE_INNER_BOX = 32;

/**
 * Core clipping: around the brightest 64 px block (mean luminance), the fraction of pixels with any
 * channel above `level` in a 128 px box (every 2nd pixel) and a 32 px box (every pixel), and the
 * peak luminance in the 128 px box.
 */
export async function measureCoreClipping(api, viewId, level) {
  const lvl = num(level, undefined, 'level');
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_core_clipping: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var level = ${lvl};

    // Find brightest 64x64 block
    var blockSize = 64;
    var bestMean = 0;
    var bestX = 0, bestY = 0;
    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        if (img.isColor) {
          var chMeans = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeans.push(img.mean());
          }
          img.resetChannelSelection();
          var lum = 0.2126 * chMeans[0] + 0.7152 * chMeans[1] + 0.0722 * chMeans[2];
          if (lum > bestMean) { bestMean = lum; bestX = bx; bestY = by; }
        } else {
          var m = img.mean();
          if (m > bestMean) { bestMean = m; bestX = bx; bestY = by; }
        }
      }
    }
    img.resetSelections();

    // Measure the wide box around the brightest block
    var coreSize = ${CORE_WIDE_BOX};
    var cx = Math.max(0, Math.min(bestX + blockSize / 2 - coreSize / 2, img.width - coreSize));
    var cy = Math.max(0, Math.min(bestY + blockSize / 2 - coreSize / 2, img.height - coreSize));

    var aboveCount = 0;
    var totalCount = 0;
    var peakVal = 0;
    var step = 2; // sample every 2nd pixel for speed

    for (var y = cy; y < cy + coreSize; y += step) {
      for (var x = cx; x < cx + coreSize; x += step) {
        var lum;
        if (img.isColor) {
          var r = img.sample(x, y, 0);
          var g = img.sample(x, y, 1);
          var b = img.sample(x, y, 2);
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          // Any channel above the level counts
          if (r > level || g > level || b > level) aboveCount++;
        } else {
          lum = img.sample(x, y);
          if (lum > level) aboveCount++;
        }
        if (lum > peakVal) peakVal = lum;
        totalCount++;
      }
    }

    var fraction = totalCount > 0 ? aboveCount / totalCount : 0;

    // The inner box, every pixel
    var innerSize = ${CORE_INNER_BOX};
    var icx = Math.max(0, Math.min(bestX + blockSize / 2 - innerSize / 2, img.width - innerSize));
    var icy = Math.max(0, Math.min(bestY + blockSize / 2 - innerSize / 2, img.height - innerSize));
    var innerAbove = 0;
    var innerTotal = 0;
    for (var y = icy; y < icy + innerSize; y++) {
      for (var x = icx; x < icx + innerSize; x++) {
        if (img.isColor) {
          if (img.sample(x, y, 0) > level || img.sample(x, y, 1) > level || img.sample(x, y, 2) > level) innerAbove++;
        } else {
          if (img.sample(x, y) > level) innerAbove++;
        }
        innerTotal++;
      }
    }
    var innerFraction = innerTotal > 0 ? innerAbove / innerTotal : 0;

    JSON.stringify({
      burntFraction: fraction,
      innerBurntFraction: innerFraction,
      peakValue: peakVal,
      coreCenter: [Math.round(cx + coreSize / 2), Math.round(cy + coreSize / 2)]
    });
  `, 'measure_core_clipping', 'burntFraction');
  return {
    fraction_above_wide: data.burntFraction,
    fraction_above_inner: data.innerBurntFraction,
    peak: data.peakValue,
    core_center: data.coreCenter,
    wide_box: CORE_WIDE_BOX,
    inner_box: CORE_INNER_BOX,
  };
}

/**
 * Clipped blocks: the image tiled in `blockSize` px blocks, every 3rd pixel sampled; a pixel counts
 * when its luminance or any channel is above `level`; a block counts when more than `blockFraction`
 * of its samples count. Returns the counts and the 10 highest-fraction blocks.
 */
export async function measureClippedBlocks(api, viewId, { level, blockFraction, blockSize }) {
  const lvl = num(level, undefined, 'level');
  const frac = num(blockFraction, undefined, 'block_fraction');
  const size = num(blockSize, undefined, 'block_size');
  if (!Number.isInteger(size) || size < 1) throw new Error(`block_size: expected a positive integer, got ${JSON.stringify(blockSize)}`);

  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_clipped_blocks: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;

    var blockSize = ${size};
    var overBlocks = [];
    var totalBlocks = 0;
    var level = ${lvl};
    var blockFraction = ${frac};

    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        totalBlocks++;
        var aboveInBlock = 0;
        var pixelsInBlock = 0;

        // Sample every 3rd pixel
        for (var y = by; y < by + blockSize; y += 3) {
          for (var x = bx; x < bx + blockSize; x += 3) {
            pixelsInBlock++;
            // Luminance for color images (any single channel above the level also counts)
            if (img.isColor) {
              var lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
              if (lum > level || img.sample(x, y, 0) > level || img.sample(x, y, 1) > level || img.sample(x, y, 2) > level) {
                aboveInBlock++;
              }
            } else {
              if (img.sample(x, y) > level) aboveInBlock++;
            }
          }
        }

        var f = pixelsInBlock > 0 ? aboveInBlock / pixelsInBlock : 0;
        if (f > blockFraction) {
          overBlocks.push({ x: bx, y: by, fraction: f });
        }
      }
    }

    // Highest fraction first
    overBlocks.sort(function(a, b) { return b.fraction - a.fraction; });

    JSON.stringify({
      burntBlockCount: overBlocks.length,
      totalBlocks: totalBlocks,
      worstBlocks: overBlocks.slice(0, 10)
    });
  `, 'measure_clipped_blocks', 'burntBlockCount');
  return { blocks_over: data.burntBlockCount, total_blocks: data.totalBlocks, locations: data.worstBlocks };
}

/**
 * Saturation: HSV saturation (max-min)/max of every 8th pixel whose luminance is above the
 * luminance of the channel medians + 5 x (median |luminance - that| over a 32 px grid).
 * Throws MonoImageError on a mono image.
 */
export async function measureSaturation(api, viewId) {
  const data = requireColor(await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_saturation: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    if (!img.isColor) {
      JSON.stringify({ mono: true });
    } else {
      // Find background level (PJSR: must set selectedChannel before median())
      img.selectedChannel = 0; var bgR = img.median();
      img.selectedChannel = 1; var bgG = img.median();
      img.selectedChannel = 2; var bgB = img.median();
      img.resetChannelSelection();
      // Approximate MAD via sampling
      var sampleStep = 32;
      var diffs = [];
      for (var y = 0; y < img.height; y += sampleStep) {
        for (var x = 0; x < img.width; x += sampleStep) {
          var lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
          diffs.push(Math.abs(lum - (0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB)));
        }
      }
      diffs.sort(function(a, b) { return a - b; });
      var bgMAD = diffs[Math.floor(diffs.length / 2)];
      var bgLum = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
      var subjectThreshold = bgLum + 5 * bgMAD;

      // Sample subject pixels and compute HSV saturation
      var satValues = [];
      var step = 8; // sample every 8th pixel for speed
      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var r = img.sample(x, y, 0);
          var g = img.sample(x, y, 1);
          var b = img.sample(x, y, 2);
          var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (lum > subjectThreshold) {
            var maxC = Math.max(r, g, b);
            var minC = Math.min(r, g, b);
            var sat = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            satValues.push(sat);
          }
        }
      }

      // Sort for percentiles
      satValues.sort(function(a, b) { return a - b; });
      var n = satValues.length;
      JSON.stringify({
        mono: false,
        medianS: n > 0 ? satValues[Math.floor(n * 0.5)] : 0,
        p90S: n > 0 ? satValues[Math.floor(n * 0.9)] : 0,
        p99S: n > 0 ? satValues[Math.floor(n * 0.99)] : 0,
        maxS: n > 0 ? satValues[n - 1] : 0,
        subjectPixelCount: n
      });
    }
  `, 'measure_saturation', 'medianS'), 'measure_saturation', viewId);
  return { median: data.medianS, p90: data.p90S, p99: data.p99S, max: data.maxS, subject_pixel_count: data.subjectPixelCount };
}

/**
 * Tonal presence: every 8th pixel is subject when its luminance is above background + 5 x (sampled
 * median absolute deviation) and at least 2 of its 4 neighbours 3 px away are too; the rest is
 * background. Reports medians and percentiles of the two sets, the ratio of their medians, and
 * whether a second weighted cluster lies more than a quarter of the width away (roi_mode).
 */
export async function measureTonalPresence(api, viewId) {
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_tonal_presence: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;

    // Background: per-channel median -> luminance
    var bgR, bgG, bgB, bgLum;
    if (isColor) {
      img.selectedChannel = 0; bgR = img.median();
      img.selectedChannel = 1; bgG = img.median();
      img.selectedChannel = 2; bgB = img.median();
      img.resetChannelSelection();
      bgLum = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
    } else {
      bgLum = img.median();
    }

    // MAD from sampling
    var sampleStep = 32;
    var diffs = [];
    for (var y = 0; y < img.height; y += sampleStep) {
      for (var x = 0; x < img.width; x += sampleStep) {
        var lum;
        if (isColor) {
          lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        } else {
          lum = img.sample(x, y);
        }
        diffs.push(Math.abs(lum - bgLum));
      }
    }
    diffs.sort(function(a, b) { return a - b; });
    var bgMAD = diffs[Math.floor(diffs.length / 2)];
    var subjectThreshold = bgLum + 5 * bgMAD;

    // Separate subject/background pixels by sampling every 8th pixel
    // with spatial compactness filter to reject isolated star-like pixels
    var step = 8;
    var subjectPixels = [];
    var bgPixels = [];
    var sumWX = 0, sumWY = 0, sumW = 0;
    var probeD = 3;

    function getLumAt(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        var lum = getLumAt(x, y);
        if (lum > subjectThreshold) {
          // Spatial compactness check: probe 4 cardinal neighbors at distance probeD.
          var brightNeighbors = 0;
          if (x - probeD >= 0 && getLumAt(x - probeD, y) > subjectThreshold) brightNeighbors++;
          if (x + probeD < img.width && getLumAt(x + probeD, y) > subjectThreshold) brightNeighbors++;
          if (y - probeD >= 0 && getLumAt(x, y - probeD) > subjectThreshold) brightNeighbors++;
          if (y + probeD < img.height && getLumAt(x, y + probeD) > subjectThreshold) brightNeighbors++;

          if (brightNeighbors >= 2) {
            subjectPixels.push(lum);
            sumWX += x * lum;
            sumWY += y * lum;
            sumW += lum;
          } else {
            bgPixels.push(lum);
          }
        } else {
          bgPixels.push(lum);
        }
      }
    }

    // Subject centroid
    var centroidX = sumW > 0 ? sumWX / sumW : img.width / 2;
    var centroidY = sumW > 0 ? sumWY / sumW : img.height / 2;

    // Multi-subject detection: a second bright cluster > 25% image width away
    var roiMode = 'single';
    if (subjectPixels.length > 50) {
      var excludeRadius = img.width * 0.15;
      var sumWX2 = 0, sumWY2 = 0, sumW2 = 0;
      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var lum = getLumAt(x, y);
          if (lum > subjectThreshold) {
            var dx = x - centroidX;
            var dy = y - centroidY;
            if (Math.sqrt(dx * dx + dy * dy) > excludeRadius) {
              sumWX2 += x * lum;
              sumWY2 += y * lum;
              sumW2 += lum;
            }
          }
        }
      }
      if (sumW2 > sumW * 0.15) {
        var c2x = sumWX2 / sumW2;
        var c2y = sumWY2 / sumW2;
        var clusterDist = Math.sqrt((c2x - centroidX) * (c2x - centroidX) + (c2y - centroidY) * (c2y - centroidY));
        if (clusterDist > img.width * 0.25) {
          roiMode = 'compound_roi';
        }
      }
    }

    subjectPixels.sort(function(a, b) { return a - b; });
    bgPixels.sort(function(a, b) { return a - b; });

    var sn = subjectPixels.length;
    var bn = bgPixels.length;

    var bgMedian = bn > 0 ? bgPixels[Math.floor(bn * 0.5)] : bgLum;
    var bgP90 = bn > 0 ? bgPixels[Math.floor(bn * 0.9)] : bgLum;
    var subjMedian = sn > 0 ? subjectPixels[Math.floor(sn * 0.5)] : 0;
    var subjP10 = sn > 0 ? subjectPixels[Math.floor(sn * 0.1)] : 0;

    // Core brightness: mean of brightest 5% of subject pixels
    var top5start = Math.max(0, Math.floor(sn * 0.95));
    var coreBrightSum = 0;
    var coreBrightCount = 0;
    for (var i = top5start; i < sn; i++) {
      coreBrightSum += subjectPixels[i];
      coreBrightCount++;
    }
    var coreBrightness = coreBrightCount > 0 ? coreBrightSum / coreBrightCount : 0;

    var totalSampled = Math.floor((img.width / step) * (img.height / step));

    JSON.stringify({
      background_median: bgMedian,
      subject_median: subjMedian,
      core_brightness: coreBrightness,
      faint_structure_visibility: (subjP10 - bgP90) / Math.max(bgP90, 0.001),
      separation: subjMedian / Math.max(bgMedian, 0.001),
      core_to_disk: subjMedian > 0.001 ? coreBrightness / subjMedian : 0,
      subject_fraction: sn / Math.max(totalSampled, 1),
      roi_mode: roiMode,
      subjectPixelCount: sn
    });
  `, 'measure_tonal_presence', 'separation');
  return {
    separation: data.separation,
    subject_median: data.subject_median,
    background_median: data.background_median,
    core_brightness: data.core_brightness,
    faint_structure_visibility: data.faint_structure_visibility,
    core_to_disk: data.core_to_disk,
    subject_fraction: data.subject_fraction,
    roi_mode: data.roi_mode,
    subject_pixel_count: data.subjectPixelCount,
  };
}

/**
 * Bright chroma: (max-min)/max of every 8th pixel whose mean of R, G, B is above `threshold`.
 * Throws MonoImageError on a mono image.
 */
export async function measureBrightChroma(api, viewId, threshold) {
  const t = num(threshold, undefined, 'brightness_threshold');
  const data = requireColor(await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_bright_chroma: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    if (!img.isColor) {
      JSON.stringify({ mono: true });
    } else {
      var threshold = ${t};
      var step = 8;
      var chromaValues = [];

      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var rv = img.sample(x, y, 0);
          var gv = img.sample(x, y, 1);
          var bv = img.sample(x, y, 2);
          var lum = (rv + gv + bv) / 3;
          if (lum > threshold) {
            var maxC = Math.max(rv, gv, bv);
            var minC = Math.min(rv, gv, bv);
            var chroma = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            chromaValues.push(chroma);
          }
        }
      }

      chromaValues.sort(function(a, b) { return a - b; });
      var n = chromaValues.length;
      var meanC = 0;
      for (var i = 0; i < n; i++) meanC += chromaValues[i];

      JSON.stringify({
        mono: false,
        medianChroma: n > 0 ? chromaValues[Math.floor(n * 0.5)] : 0,
        meanChroma: n > 0 ? meanC / n : 0,
        brightPixelCount: n,
        p25Chroma: n > 0 ? chromaValues[Math.floor(n * 0.25)] : 0,
        p75Chroma: n > 0 ? chromaValues[Math.floor(n * 0.75)] : 0
      });
    }
  `, 'measure_bright_chroma', 'medianChroma'), 'measure_bright_chroma', viewId);
  return {
    median_chroma: data.medianChroma,
    mean_chroma: data.meanChroma,
    p25_chroma: data.p25Chroma,
    p75_chroma: data.p75Chroma,
    bright_pixel_count: data.brightPixelCount,
  };
}

// The shell-texture numbers of one view: over the subject pixels (luminance above median +
// 5 x sampled MAD, every 4th pixel) inside the ROI circle, the shell zone is their P20..P92 band.
// With `roi` omitted the ROI is computed: the luminance-weighted centroid of compact subject
// pixels and their 90th-percentile distance, held to [50 px, 0.45 x min(W, H)].
async function shellTexture(api, viewId, roi) {
  return measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_highlight_texture: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    // Background stats
    var bgMedian = img.median();
    var sampleStep = 32;
    var diffs = [];
    for (var y = 0; y < H; y += sampleStep) {
      for (var x = 0; x < W; x += sampleStep) {
        diffs.push(Math.abs(getLum(x, y) - bgMedian));
      }
    }
    diffs.sort(function(a, b) { return a - b; });
    var bgMAD = diffs[Math.floor(diffs.length / 2)];
    var subjectThreshold = bgMedian + 5 * bgMAD;

    // ROI: use provided or compute from subject centroid
    var roiCx = ${num(roi?.cx, -1, 'roi.cx')};
    var roiCy = ${num(roi?.cy, -1, 'roi.cy')};
    var roiR = ${num(roi?.radius, -1, 'roi.radius')};

    if (roiCx < 0) {
      // Compute ROI from subject centroid
      var step = 8, probeD = 3;
      var swx = 0, swy = 0, sw = 0;
      var coords = [];
      for (var y = step; y < H - step; y += step) {
        for (var x = step; x < W - step; x += step) {
          var lum = getLum(x, y);
          if (lum > subjectThreshold) {
            var bn = 0;
            if (x - probeD >= 0 && getLum(x - probeD, y) > subjectThreshold) bn++;
            if (x + probeD < W && getLum(x + probeD, y) > subjectThreshold) bn++;
            if (y - probeD >= 0 && getLum(x, y - probeD) > subjectThreshold) bn++;
            if (y + probeD < H && getLum(x, y + probeD) > subjectThreshold) bn++;
            if (bn >= 2) {
              swx += x * lum; swy += y * lum; sw += lum;
              coords.push(x * 65536 + y);
            }
          }
        }
      }
      roiCx = sw > 0 ? Math.round(swx / sw) : Math.round(W / 2);
      roiCy = sw > 0 ? Math.round(swy / sw) : Math.round(H / 2);
      // Compute 90th-percentile radius
      var dists = [];
      for (var i = 0; i < coords.length; i++) {
        var sx = Math.floor(coords[i] / 65536);
        var sy = coords[i] % 65536;
        var dx2 = sx - roiCx, dy2 = sy - roiCy;
        dists.push(Math.sqrt(dx2*dx2 + dy2*dy2));
      }
      dists.sort(function(a,b){return a-b;});
      roiR = dists.length > 0 ? dists[Math.floor(dists.length*0.90)] : Math.min(W,H)/4;
      roiR = Math.max(50, Math.min(roiR, Math.min(W,H)*0.45));
      roiR = Math.round(roiR);
    }

    // Collect subject pixels within ROI, identify bright shell zone
    var roiSubject = [];
    var step2 = 4;
    for (var y = Math.max(0, roiCy - roiR); y < Math.min(H, roiCy + roiR); y += step2) {
      for (var x = Math.max(0, roiCx - roiR); x < Math.min(W, roiCx + roiR); x += step2) {
        var dx = x - roiCx, dy = y - roiCy;
        if (dx*dx + dy*dy > roiR*roiR) continue;
        var lum = getLum(x, y);
        if (lum > subjectThreshold) {
          roiSubject.push(lum);
        }
      }
    }
    roiSubject.sort(function(a,b){return a-b;});

    if (roiSubject.length < 100) {
      JSON.stringify({ error: 'too_few_subject_pixels', count: roiSubject.length,
        roi: { cx: roiCx, cy: roiCy, radius: roiR } });
    } else {
      // Shell zone: P20 to P92 of subject pixels within ROI
      var shellLow = roiSubject[Math.floor(roiSubject.length * 0.20)];
      var shellHigh = roiSubject[Math.floor(roiSubject.length * 0.92)];

      // 1. Local stddev in 16x16 blocks within shell zone
      var blockSize = 16;
      var blockStdDevs = [];
      for (var by = Math.max(0, roiCy - roiR); by < Math.min(H - blockSize, roiCy + roiR); by += blockSize) {
        for (var bx = Math.max(0, roiCx - roiR); bx < Math.min(W - blockSize, roiCx + roiR); bx += blockSize) {
          // Check if block center is in ROI
          var bcx = bx + blockSize/2, bcy = by + blockSize/2;
          var ddx = bcx - roiCx, ddy = bcy - roiCy;
          if (ddx*ddx + ddy*ddy > roiR*roiR) continue;
          // Collect block luminances, count shell pixels
          var bVals = [];
          var shellCount = 0;
          for (var py = by; py < by + blockSize; py += 2) {
            for (var px = bx; px < bx + blockSize; px += 2) {
              if (px >= W || py >= H) continue;
              var l = getLum(px, py);
              bVals.push(l);
              if (l >= shellLow && l <= shellHigh) shellCount++;
            }
          }
          // Only use blocks with >= 40% shell pixels
          if (shellCount < bVals.length * 0.40) continue;
          // Compute stddev
          var sum = 0, sum2 = 0;
          for (var k = 0; k < bVals.length; k++) {
            sum += bVals[k];
            sum2 += bVals[k] * bVals[k];
          }
          var mean = sum / bVals.length;
          var variance = sum2 / bVals.length - mean * mean;
          if (variance > 0) {
            blockStdDevs.push(Math.sqrt(variance));
          }
        }
      }
      blockStdDevs.sort(function(a,b){return a-b;});
      var shellLocalStdDev = blockStdDevs.length > 0
        ? blockStdDevs[Math.floor(blockStdDevs.length / 2)] : 0;

      // 2. Tonal span: P90 - P10 of shell-zone pixels
      var shellPixels = [];
      for (var i = 0; i < roiSubject.length; i++) {
        if (roiSubject[i] >= shellLow && roiSubject[i] <= shellHigh) {
          shellPixels.push(roiSubject[i]);
        }
      }
      shellPixels.sort(function(a,b){return a-b;});
      var shellTonalSpan = shellPixels.length > 10
        ? shellPixels[Math.floor(shellPixels.length * 0.90)]
          - shellPixels[Math.floor(shellPixels.length * 0.10)]
        : 0;

      // 3. Gradient energy (Sobel) restricted to shell zone within ROI
      var gradEnergy = 0, gradCount = 0;
      var gStep = 4;
      for (var y = Math.max(1, roiCy - roiR); y < Math.min(H-1, roiCy + roiR); y += gStep) {
        for (var x = Math.max(1, roiCx - roiR); x < Math.min(W-1, roiCx + roiR); x += gStep) {
          var ddx2 = x - roiCx, ddy2 = y - roiCy;
          if (ddx2*ddx2 + ddy2*ddy2 > roiR*roiR) continue;
          var cl = getLum(x, y);
          if (cl < shellLow || cl > shellHigh) continue;
          var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
          var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
          var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
          var gx = -tl + tr - 2*ml + 2*mr - bl + br;
          var gy = -tl - 2*tc - tr + bl + 2*bc + br;
          gradEnergy += gx*gx + gy*gy;
          gradCount++;
        }
      }
      var shellGradientEnergy = gradCount > 0 ? gradEnergy / gradCount : 0;

      JSON.stringify({
        shellLocalStdDev: shellLocalStdDev,
        shellTonalSpan: shellTonalSpan,
        shellGradientEnergy: shellGradientEnergy,
        shellPixelCount: shellPixels.length,
        blockCount: blockStdDevs.length,
        shellZone: { low: shellLow, high: shellHigh },
        roi: { cx: roiCx, cy: roiCy, radius: roiR }
      });
    }
  `, 'measure_highlight_texture', 'shellLocalStdDev');
}

// A view with too few subject pixels in the ROI for the shell measurement (fewer than 100).
export class TooFewPixelsError extends Error {}

const textureOf = (m) => ({ local_stddev: m.shellLocalStdDev, tonal_span: m.shellTonalSpan, gradient_energy: m.shellGradientEnergy });
// A retention ratio current/reference, or null when the reference value is below its guard (no ratio).
const ratio = (cur, ref, guard) => (ref > guard ? cur / ref : null);

/**
 * Highlight texture of `viewId`'s shell zone, and, with `referenceId`, the same numbers of the
 * reference measured over the current view's ROI, and current/reference retention ratios.
 * Throws TooFewPixelsError when either view has fewer than 100 subject pixels in the ROI.
 */
export async function measureHighlightTexture(api, viewId, referenceId) {
  const current = await shellTexture(api, viewId);
  if (current.error) {
    throw new TooFewPixelsError(`measure_highlight_texture: too few subject pixels in the ROI of ${viewId}: ${current.count} (the measurement needs 100)`);
  }
  let reference = null;
  if (referenceId) {
    reference = await shellTexture(api, referenceId, current.roi);
    if (reference.error) {
      throw new TooFewPixelsError(`measure_highlight_texture: too few subject pixels in the ROI of the reference: ${reference.count} in ${referenceId} (the measurement needs 100)`);
    }
  }
  return {
    current: textureOf(current),
    reference: reference ? textureOf(reference) : null,
    retention: reference ? {
      texture: ratio(current.shellLocalStdDev, reference.shellLocalStdDev, 0.0001),
      span: ratio(current.shellTonalSpan, reference.shellTonalSpan, 0.001),
      gradient: ratio(current.shellGradientEnergy, reference.shellGradientEnergy, 0.0001),
    } : null,
    shell_zone: current.shellZone,
    roi: current.roi,
    shell_pixel_count: current.shellPixelCount,
    block_count: current.blockCount,
  };
}

/**
 * Subject detail: 32 px blocks whose luminance median is above median + 8 x 1.4826 x MAD are
 * subject. subject_brightness = median of their block medians; contrast_ratio = that / the median
 * of the other blocks' medians (0 when that is at most 0.001); detail_score = mean Sobel energy of
 * luminance over every 4th pixel of up to 50 subject blocks. subject_threshold = median +
 * 3 x 1.4826 x MAD, reported for reference.
 */
export async function measureSubjectDetail(api, viewId) {
  const data = await measureJson(api, `
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('measure_subject_detail: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;

    // Get luminance
    function getLum(x, y) {
      if (img.isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    // Background stats
    var bgMedian = img.median();
    var bgMAD = img.MAD();

    // Subject threshold: background + 3*MAD (anything significantly above background)
    var subjectThreshold = bgMedian + 3 * 1.4826 * bgMAD;
    // Strong subject threshold: for measuring bright objects specifically
    var strongThreshold = bgMedian + 8 * 1.4826 * bgMAD;

    // Scan in blocks of 32x32, classify as background or subject
    var blockSize = 32;
    var subjectBlocks = [];
    var bgSamples = [];
    var subjectSamples = [];

    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        var blockMed;
        if (img.isColor) {
          var chMeds = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeds.push(img.median());
          }
          img.resetChannelSelection();
          blockMed = 0.2126 * chMeds[0] + 0.7152 * chMeds[1] + 0.0722 * chMeds[2];
        } else {
          blockMed = img.median();
        }

        if (blockMed > strongThreshold) {
          subjectBlocks.push({ x: bx, y: by, med: blockMed });
          subjectSamples.push(blockMed);
        } else {
          bgSamples.push(blockMed);
        }
      }
    }
    img.resetSelections();

    // Subject brightness: median of subject block medians
    subjectSamples.sort(function(a, b) { return a - b; });
    var subjectBrightness = subjectSamples.length > 0 ? subjectSamples[Math.floor(subjectSamples.length / 2)] : 0;

    // Background median from non-subject blocks
    bgSamples.sort(function(a, b) { return a - b; });
    var bgMed = bgSamples.length > 0 ? bgSamples[Math.floor(bgSamples.length / 2)] : bgMedian;

    // Contrast ratio
    var contrastRatio = bgMed > 0.001 ? subjectBrightness / bgMed : 0;

    // Detail score: Sobel gradient energy within subject blocks
    var totalEnergy = 0;
    var detailCount = 0;
    var step = 4;

    for (var i = 0; i < subjectBlocks.length && i < 50; i++) {
      var sb = subjectBlocks[i];
      for (var y = sb.y + 1; y < sb.y + blockSize - 1; y += step) {
        for (var x = sb.x + 1; x < sb.x + blockSize - 1; x += step) {
          var tl = getLum(x-1, y-1), tc = getLum(x, y-1), tr = getLum(x+1, y-1);
          var ml = getLum(x-1, y),                          mr = getLum(x+1, y);
          var bl = getLum(x-1, y+1), bc = getLum(x, y+1), br = getLum(x+1, y+1);
          var gx = -tl + tr - 2*ml + 2*mr - bl + br;
          var gy = -tl - 2*tc - tr + bl + 2*bc + br;
          totalEnergy += gx * gx + gy * gy;
          detailCount++;
        }
      }
    }

    var detailScore = detailCount > 0 ? totalEnergy / detailCount : 0;

    JSON.stringify({
      subjectBrightness: subjectBrightness,
      detailScore: detailScore,
      contrastRatio: contrastRatio,
      subjectCount: subjectBlocks.length,
      backgroundMedian: bgMed,
      subjectThreshold: subjectThreshold
    });
  `, 'measure_subject_detail', 'subjectBrightness');
  return {
    subject_brightness: data.subjectBrightness,
    detail_score: data.detailScore,
    contrast_ratio: data.contrastRatio,
    subject_count: data.subjectCount,
    background_median: data.backgroundMedian,
    subject_threshold: data.subjectThreshold,
  };
}
