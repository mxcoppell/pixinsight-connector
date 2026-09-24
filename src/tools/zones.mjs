// ============================================================================
// Luminance zone masks, folded in from mxcoppell/pixinsight-pack-astro@eee19b3
// (lib/zones.mjs). A helper module: it exports no `tools` array, so
// src/tools/index.mjs's scan passes over it. Shared by masks.mjs (which exposes
// both functions as tools) and detail.mjs (shell_detail_enhance's adaptive zones).
// ============================================================================
import { q, num } from './pjsr-args.mjs';

export const ADAPTIVE_ZONE_IDS = ['azone_core', 'azone_shell', 'azone_outer'];

// createAdaptiveZoneMasks(api, viewId, { coreBias }) -> { coreId, shellId, outerId, roi, thresholds, pixelCounts }
//
// ROI-anchored, percentile-based zones computed from the pixels brighter than
// background median + 5 MAD inside a circle of radius 0.35 * min(W, H) around their
// brightness-weighted centroid (20 px feather outside it): core = above percentile
// 85 + 10 * core_bias, shell = percentile 25 up to the core level, outer = subject
// level up to percentile 25. Blurred with sigma 5, 10, 20. core_bias (0-1) defaults to 0.5,
// the middle of its own scale.
export async function createAdaptiveZoneMasks(api, viewId, opts = {}) {
  const coreBias = num(opts.coreBias, 0.5, 'core_bias');
  if (!(coreBias >= 0 && coreBias <= 1)) throw new Error(`core_bias: expected a number in [0, 1], got ${coreBias}`);

  const r = await api.pjsr(`
    var w = ImageWindow.windowById(${q(viewId)});
    if (w.isNull) throw new Error('createAdaptiveZoneMasks: view not found: ' + ${q(viewId)});
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    var cx = -1, cy = -1, rad = -1;
    if (cx < 0) {
      var bgM = img.median();
      var df = [];
      for (var y = 0; y < H; y += 32) for (var x = 0; x < W; x += 32) df.push(Math.abs(getLum(x,y) - bgM));
      df.sort(function(a,b){return a-b;});
      var bMAD = df[Math.floor(df.length/2)];
      var sTh = bgM + 5 * bMAD;
      var swx=0,swy=0,sw=0;
      for (var y=8;y<H-8;y+=8) for (var x=8;x<W-8;x+=8) {
        var l=getLum(x,y); if(l>sTh){swx+=x*l;swy+=y*l;sw+=l;}
      }
      cx = sw > 0 ? Math.round(swx/sw) : Math.round(W/2);
      cy = sw > 0 ? Math.round(swy/sw) : Math.round(H/2);
      rad = Math.round(Math.min(W,H)*0.35);
    }

    var bgMed = img.median();
    var df2 = [];
    for (var y = 0; y < H; y += 32) for (var x = 0; x < W; x += 32) df2.push(Math.abs(getLum(x,y) - bgMed));
    df2.sort(function(a,b){return a-b;});
    var bgMAD = df2[Math.floor(df2.length/2)];
    var subjectTh = bgMed + 5 * bgMAD;

    var roiSubject = [];
    for (var y = Math.max(0, cy-rad); y < Math.min(H, cy+rad); y += 4) {
      for (var x = Math.max(0, cx-rad); x < Math.min(W, cx+rad); x += 4) {
        var dx = x-cx, dy = y-cy;
        if (dx*dx + dy*dy > rad*rad) continue;
        var l = getLum(x, y);
        if (l > subjectTh) roiSubject.push(l);
      }
    }
    roiSubject.sort(function(a,b){return a-b;});

    if (roiSubject.length < 50) {
      JSON.stringify({ error: 'too_few_subject_pixels', count: roiSubject.length });
    } else {
      var corePerc = 0.85 + 0.10 * ${coreBias};
      var coreTh = roiSubject[Math.floor(roiSubject.length * corePerc)];
      var shellLow = roiSubject[Math.floor(roiSubject.length * 0.25)];
      // Shell band midpoint and half-width; a zero-width band (flat subject) gets no shell mask.
      var mid = (shellLow + coreTh) / 2;
      var half = (coreTh - shellLow) / 2;

      var ids = ${JSON.stringify(ADAPTIVE_ZONE_IDS)};
      for (var i = 0; i < 3; i++) {
        var old = ImageWindow.windowById(ids[i]);
        if (!old.isNull) old.forceClose();
      }

      var mC = new ImageWindow(W, H, 1, 32, true, false, 'azone_core');
      var mS = new ImageWindow(W, H, 1, 32, true, false, 'azone_shell');
      var mO = new ImageWindow(W, H, 1, 32, true, false, 'azone_outer');
      var iC = mC.mainView.image, iS = mS.mainView.image, iO = mO.mainView.image;
      var cc=0, sc=0, oc=0;

      mC.mainView.beginProcess(); mS.mainView.beginProcess(); mO.mainView.beginProcess();

      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var lum = getLum(x, y);
          var dx = x - cx, dy = y - cy;
          var dist = Math.sqrt(dx*dx + dy*dy);
          var roiW = dist < rad ? 1.0 : Math.max(0, 1.0 - (dist - rad) / 20.0);

          var cV = 0;
          if (lum > coreTh) {
            cV = Math.min(1.0, (lum - coreTh) / Math.max(0.01, 1.0 - coreTh));
            cc++;
          }
          var sV = 0;
          if (half > 0 && lum > shellLow && lum <= coreTh) {
            sV = Math.max(0, Math.min(1, 1.0 - Math.abs(lum - mid) / half));
            sc++;
          }
          var oV = 0;
          if (lum > subjectTh && lum <= shellLow) {
            oV = Math.min(1.0, (lum - subjectTh) / Math.max(0.01, shellLow - subjectTh));
            oc++;
          }
          iC.setSample(cV * roiW, x, y);
          iS.setSample(sV * roiW, x, y);
          iO.setSample(oV * roiW, x, y);
        }
      }
      mC.mainView.endProcess(); mS.mainView.endProcess(); mO.mainView.endProcess();

      var sigmas = [5, 10, 20];
      var ms = [mC, mS, mO];
      for (var m = 0; m < 3; m++) {
        var conv = new Convolution;
        conv.mode = Convolution.Parametric;
        conv.sigma = sigmas[m]; conv.shape = 2; conv.aspectRatio = 1; conv.rotationAngle = 0;
        conv.executeOn(ms[m].mainView);
        ms[m].show();
      }

      JSON.stringify({
        coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer',
        roi: { cx: cx, cy: cy, radius: rad },
        thresholds: { core: coreTh, shellLow: shellLow, outer: subjectTh },
        pixelCounts: { core: cc, shell: sc, outer: oc }
      });
    }
  `);

  if (r.status === 'error') {
    throw new Error('createAdaptiveZoneMasks failed: ' + (r.error?.message || 'unknown'));
  }
  const data = JSON.parse(r.outputs?.consoleOutput || '{}');
  if (data.error) throw new Error('createAdaptiveZoneMasks: ' + data.error + ' (' + data.count + ' pixels)');
  return data;
}

// createZoneMasks(api, viewId, { core_clip, shell_clip, halo_clip }) -> { coreId, shellId, haloId, thresholds }
//
// Three fixed-threshold masks from the Rec.709 luminance: core (above core_clip), shell
// (shell_clip to core_clip) and halo (halo_clip to shell_clip), each ramped linearly across its
// band and Gaussian-blurred (sigma 8, 12, 20). All three clip levels are required (no defaults):
// a missing one throws before any PJSR is sent.
export async function createZoneMasks(api, viewId, thresholds = {}) {
  const coreClip = num(thresholds.core_clip, undefined, 'core_clip');
  const shellClip = num(thresholds.shell_clip, undefined, 'shell_clip');
  const haloClip = num(thresholds.halo_clip, undefined, 'halo_clip');
  // Each band is ramped across its width, so every width must be positive.
  if (!(coreClip < 1)) throw new Error(`core_clip must be < 1, got ${coreClip}`);
  if (!(shellClip < coreClip)) throw new Error(`shell_clip must be < core_clip (${coreClip}), got ${shellClip}`);
  if (!(haloClip < shellClip)) throw new Error(`halo_clip must be < shell_clip (${shellClip}), got ${haloClip}`);

  const r = await api.pjsr(`
    var src = ImageWindow.windowById(${q(viewId)});
    if (src.isNull) throw new Error('createZoneMasks: view not found: ' + ${q(viewId)});
    var img = src.mainView.image;
    var isColor = img.isColor;

    function getLum(x, y) {
      if (isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    var w = img.width;
    var h = img.height;

    var ids = ['mask_core', 'mask_shell', 'mask_halo'];
    for (var i = 0; i < ids.length; i++) {
      var ow = ImageWindow.windowById(ids[i]);
      if (!ow.isNull) ow.forceClose();
    }

    var coreW = new ImageWindow(w, h, 1, 32, true, false, 'mask_core');
    var shellW = new ImageWindow(w, h, 1, 32, true, false, 'mask_shell');
    var haloW = new ImageWindow(w, h, 1, 32, true, false, 'mask_halo');

    var coreImg = coreW.mainView.image;
    var shellImg = shellW.mainView.image;
    var haloImg = haloW.mainView.image;

    coreW.mainView.beginProcess();
    shellW.mainView.beginProcess();
    haloW.mainView.beginProcess();

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var lum = getLum(x, y);
        coreImg.setSample(lum > ${coreClip} ? Math.min(1, (lum - ${coreClip}) / (1 - ${coreClip})) : 0, x, y);
        shellImg.setSample(lum > ${shellClip} && lum <= ${coreClip} ? Math.min(1, (lum - ${shellClip}) / (${coreClip} - ${shellClip})) : 0, x, y);
        haloImg.setSample(lum > ${haloClip} && lum <= ${shellClip} ? Math.min(1, (lum - ${haloClip}) / (${shellClip} - ${haloClip})) : 0, x, y);
      }
    }

    coreW.mainView.endProcess();
    shellW.mainView.endProcess();
    haloW.mainView.endProcess();

    var conv = new Convolution;
    conv.mode = Convolution.Parametric;
    conv.shape = 2;
    conv.aspectRatio = 1;
    conv.rotationAngle = 0;
    conv.sigma = 8;
    conv.executeOn(coreW.mainView);
    conv.sigma = 12;
    conv.executeOn(shellW.mainView);
    conv.sigma = 20;
    conv.executeOn(haloW.mainView);

    coreW.show();
    shellW.show();
    haloW.show();

    JSON.stringify({
      coreId: 'mask_core',
      shellId: 'mask_shell',
      haloId: 'mask_halo',
      thresholds: { core: ${coreClip}, shell: ${shellClip}, halo: ${haloClip} }
    });
  `);

  if (r.status === 'error') {
    throw new Error('createZoneMasks failed: ' + (r.error?.message || 'unknown'));
  }
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}
