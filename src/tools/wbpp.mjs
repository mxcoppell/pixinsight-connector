// ============================================================================
// run_wbpp / wbpp_status: WeightedBatchPreprocessing (WBPP) run headless in a separate PixInsight
// instance, the documented way: `PixInsight -n --automation-mode -r="<WBPP.js>,param=value,..."
// --force-exit` (the help printed by BatchPreprocessing/BPP-Automation.js, printAutomationHelp).
//
// A WBPP run takes minutes to hours, longer than one tool call can wait, so run_wbpp starts the
// instance and returns a run id; wbpp_status reports it. Run records live in
// <workspace>/agentic/scratch/wbpp/<run id>/ (run.json, exit.json, the instance's console output,
// and the pipeline-builder script when one is generated). WBPP writes only into output_dir, which is
// held to <workspace>/output or the state folder.
//
// run_wbpp refuses while this workspace's watcher reports "busy" (a command running in the GUI
// instance) and while an earlier run_wbpp instance of this workspace is still running.
// The command line has no switch for per-group dark optimization or drizzle; when asked for, a
// pipeline-builder script sets them on the light groups and builds the standard light pipeline.
// ============================================================================
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { isPidAlive as nodeIsPidAlive } from '../process-probe.mjs';
import { machineId } from '../machine-id.mjs';
import { toPixPath } from '../platform.mjs';
import { resolveExportPath } from './images.mjs';

const KEYWORD_MODES = ['pre', 'post', 'prepost'];
const REJECTION = ['PercentileClip', 'WinsorizedSigma', 'LinearFit', 'ESD', 'RCR', 'Auto']; // rejection_N indices 0..5
const WEIGHTS = ['PSFSignal', 'PSFSNR', 'PSFScaleSNR', 'SNREstimate']; // subframesWeightsMethod 0..3
const REFERENCE = ['auto', 'auto_by_keyword'];
const FS_METRICS = ['FWHM', 'eccentricity', 'SNR', 'PSFSignalWeight', 'median', 'numberOfStars'];
const LIGHT = 4; // WBPP image type index for rejection_N / combination_N: 1 Bias, 2 Dark, 3 Flat, 4 Light
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;

// A WBPP -r value is split on commas by PixInsight, so no value may contain one.
function noComma(v, label) {
  const s = String(v);
  if (s.includes(',')) throw new Error(`${label}: WBPP's command line cannot carry a comma (${JSON.stringify(s)})`);
  return s;
}
const boolParam = (v, label) => {
  if (v === true || v === 'true') return 'true';
  if (v === false || v === 'false') return 'false';
  throw new Error(`${label}: expected a boolean`);
};

export function wbppScriptPath(platform) {
  if (!platform?.imageSolverPath) return null;
  const p = platform.imageSolverPath.includes('\\') ? path.win32 : path.posix;
  return p.join(p.dirname(p.dirname(platform.imageSolverPath)), 'BatchPreprocessing', 'WBPP.js');
}

export function pipelineBuilderScript({ optimizeDarks, drizzleScale }) {
  const lines = [
    'var __n = 0;',
    'engine.groupsManager.groups.forEach(function (g) {',
    '   if (g.imageType != ImageType.Light) return;',
    '   __n++;',
  ];
  if (optimizeDarks) lines.push('   g.optimizeMasterDark = true;');
  if (drizzleScale) lines.push(`   g.setDrizzleData({ enabled: true, scale: ${Number(drizzleScale)} });`);
  lines.push('});', 'console.noteln("*** run_wbpp pipeline builder: light groups set: ", __n);', 'engine.pipelineManager.buildPipelineForLight();');
  return lines.join('\n') + '\n';
}

// The -r value: WBPP.js path then param=value pairs (only the ones the caller gave, plus the
// automation and non-interactive switches a headless run needs).
export function wbppArgs(input, { scriptPath, outputDir, builderPath }) {
  const a = [noComma(toPixPath(scriptPath), 'WBPP.js path'), 'automationMode=true'];
  const dirs = input.input_dirs;
  if (!Array.isArray(dirs) || !dirs.length) throw new Error('input_dirs: expected a non-empty array of folders');
  for (const d of dirs) a.push(`dir=${noComma(toPixPath(d), 'input_dirs')}`);
  a.push(`outputDirectory=${noComma(toPixPath(outputDir), 'output_dir')}`);
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) throw new Error('keywords: expected [{name, mode}]');
    const ks = input.keywords.map((k, i) => {
      const name = String(k?.name ?? '');
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`keywords[${i}].name: a FITS/path keyword name`);
      const mode = k.mode === undefined ? 'pre' : k.mode;
      if (!KEYWORD_MODES.includes(mode)) throw new Error(`keywords[${i}].mode: one of ${KEYWORD_MODES.join(', ')}`);
      return `${name} ${mode}`;
    });
    a.push(`keywords=${ks.join(';')}`, `groupingKeywordsEnabled=${ks.length ? 'true' : 'false'}`);
  }
  if (input.reference_image !== undefined) {
    if (input.reference !== undefined) throw new Error('reference_image and reference: give one of them');
    a.push(`referenceImage=${noComma(toPixPath(input.reference_image), 'reference_image')}`, 'bestFrameReferenceMethod=0');
  } else if (input.reference !== undefined) {
    if (!REFERENCE.includes(input.reference)) throw new Error(`reference: one of ${REFERENCE.join(', ')}`);
    if (input.reference === 'auto') a.push('bestFrameReferenceMethod=1');
    else {
      if (!input.reference_keyword || !PARAM_NAME_RE.test(String(input.reference_keyword))) throw new Error('reference_keyword: needed with reference auto_by_keyword');
      a.push('bestFrameReferenceMethod=2', `bestFrameReferenceKeyword=${input.reference_keyword}`);
    }
  }
  const flags = [
    ['image_registration', 'imageRegistration'], ['distortion_correction', 'distortionCorrection'], ['plate_solve', 'platesolve'],
    ['local_normalization', 'localNormalization'], ['integrate', 'integrate'], ['autocrop', 'autocrop'],
    ['generate_rejection_maps', 'generateRejectionMaps'],
  ];
  for (const [key, param] of flags) if (input[key] !== undefined) a.push(`${param}=${boolParam(input[key], key)}`);
  if (input.local_normalization !== undefined) a.push('localNormalizationInteractiveMode=false');
  if (input.rejection !== undefined) {
    const i = REJECTION.indexOf(input.rejection);
    if (i < 0) throw new Error(`rejection: one of ${REJECTION.join(', ')}`);
    a.push(`rejection_${LIGHT}=${i}`);
  }
  if (input.weights !== undefined) {
    if (input.weights === 'none') a.push('subframeWeightingEnabled=false');
    else {
      const i = WEIGHTS.indexOf(input.weights);
      if (i < 0) throw new Error(`weights: one of none, ${WEIGHTS.join(', ')}`);
      a.push('subframeWeightingEnabled=true', `subframesWeightsMethod=${i}`);
    }
  }
  if (input.frame_selection !== undefined) {
    if (!Array.isArray(input.frame_selection)) throw new Error('frame_selection: expected [{metric, value, compare}]');
    a.push(`frameSelectionEnabled=${input.frame_selection.length ? 'true' : 'false'}`, 'frameSelectionInteractive=false');
    input.frame_selection.forEach((f, i) => {
      if (!FS_METRICS.includes(f?.metric)) throw new Error(`frame_selection[${i}].metric: one of ${FS_METRICS.join(', ')}`);
      if (typeof f.value !== 'number' || !Number.isFinite(f.value)) throw new Error(`frame_selection[${i}].value: a number`);
      if (!['less', 'greater'].includes(f.compare)) throw new Error(`frame_selection[${i}].compare: less or greater`);
      a.push(`frameSelection.${f.metric}.enabled=true`, `frameSelection.${f.metric}.value=${f.value}`,
        `frameSelection.${f.metric}.compareMode=${f.compare === 'less' ? 0 : 1}`);
    });
  }
  if (builderPath) a.push('usePipelineBuilderScript=true', `pipelineBuilderScriptFile=${noComma(toPixPath(builderPath), 'pipeline builder path')}`);
  if (input.extra_params !== undefined) {
    if (!input.extra_params || typeof input.extra_params !== 'object' || Array.isArray(input.extra_params)) throw new Error('extra_params: expected an object of WBPP automation parameters');
    for (const [k, v] of Object.entries(input.extra_params)) {
      if (!PARAM_NAME_RE.test(k)) throw new Error(`extra_params: ${JSON.stringify(k)} is not a WBPP parameter name`);
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error(`extra_params.${k}: a string, number or boolean`);
      a.push(`${k}=${noComma(v, `extra_params.${k}`)}`);
    }
  }
  return a.join(',');
}

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// This workspace's GUI watcher state from its heartbeat file ("<state> <ms>"), or null.
function watcherState(fs, stateDir, mid) {
  try { return String(fs.readFileSync(path.join(stateDir, 'bridge', mid, 'heartbeat'), 'utf8')).trim().split(/\s+/)[0] || null; } catch { return null; }
}

function runsDir(api) { return path.join(api.workspace.scratchDir, 'wbpp'); }

function runStatus(fs, isPidAlive, dir) {
  const run = readJson(fs, path.join(dir, 'run.json'));
  if (!run) return null;
  const exit = readJson(fs, path.join(dir, 'exit.json'));
  const alive = !exit && Number.isInteger(run.pid) && isPidAlive(run.pid);
  return { run, exit, state: exit ? 'finished' : alive ? 'running' : 'ended (no exit record)' };
}

// The run_wbpp run still alive in this workspace ({ runId, pid }), or null. The server refuses calls
// that use the GUI PixInsight while one runs, so two PixInsight jobs never run at once.
export function activeWbppRun({ scratchDir, fs = nodeFs, isPidAlive = nodeIsPidAlive }) {
  const dir = path.join(scratchDir, 'wbpp');
  let ids;
  try { ids = fs.readdirSync(dir); } catch { return null; }
  for (const id of ids) {
    const st = runStatus(fs, isPidAlive, path.join(dir, id));
    if (st?.state === 'running') return { runId: id, pid: st.run.pid };
  }
  return null;
}

function listXisf(fs, dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.xisf$/i.test(f)).sort(); } catch { return []; }
}
function subfolderCounts(fs, dir) {
  const out = {};
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isDirectory()) out[e.name] = listXisf(fs, path.join(dir, e.name)).length;
  return out;
}

export function makeWbppTools({ spawn = nodeSpawn, fs = nodeFs, isPidAlive = nodeIsPidAlive, now = Date.now, mid = () => machineId() } = {}) {
  const runWbpp = {
    name: 'run_wbpp',
    description:
      'Start WeightedBatchPreprocessing (WBPP) headless in a separate PixInsight instance (PixInsight -n --automation-mode ' +
      '--force-exit) over input_dirs, writing into output_dir, and return a run id at once; wbpp_status reports the run. ' +
      'output_dir must lie inside <workspace>/output (a relative path is resolved there) or the state folder. Only the WBPP ' +
      'parameters given are passed; WBPP\'s own settings apply to the rest. Interactive local normalization and frame selection are ' +
      'turned off so nothing waits for a click. optimize_darks and drizzle_scale are applied to every light group by a generated ' +
      'pipeline-builder script. extra_params passes further WBPP automation parameters by name (BPP-Automation.js lists them). ' +
      'Refuses while the GUI instance runs a command for this workspace, and while an earlier run_wbpp run of this workspace is running. ' +
      'Tools that use the GUI instance keep working while WBPP runs.',
    inputSchema: {
      type: 'object',
      properties: {
        input_dirs: { type: 'array', items: { type: 'string' }, description: 'Folders WBPP scans recursively for lights, darks, flats and bias (WBPP dir=)' },
        output_dir: { type: 'string', description: 'WBPP output folder: relative to <workspace>/output, or absolute inside <workspace>/output or the state folder' },
        keywords: {
          type: 'array', description: 'Grouping keywords [{name, mode}], mode pre (calibration groups), post (integration groups) or prepost',
          items: { type: 'object', properties: { name: { type: 'string' }, mode: { type: 'string', enum: KEYWORD_MODES } } },
        },
        reference_image: { type: 'string', description: 'Registration reference image file (WBPP referenceImage, manual reference)' },
        reference: { type: 'string', enum: REFERENCE, description: 'Automatic registration reference: one for all (auto) or one per value of reference_keyword' },
        reference_keyword: { type: 'string', description: 'Keyword for reference auto_by_keyword' },
        image_registration: { type: 'boolean', description: 'WBPP imageRegistration' },
        distortion_correction: { type: 'boolean', description: 'WBPP distortionCorrection' },
        plate_solve: { type: 'boolean', description: 'WBPP platesolve' },
        local_normalization: { type: 'boolean', description: 'WBPP localNormalization (run non-interactively)' },
        integrate: { type: 'boolean', description: 'WBPP integrate' },
        autocrop: { type: 'boolean', description: 'WBPP autocrop' },
        generate_rejection_maps: { type: 'boolean', description: 'WBPP generateRejectionMaps' },
        rejection: { type: 'string', enum: REJECTION, description: 'Pixel rejection for lights (WBPP rejection_4)' },
        weights: { type: 'string', enum: ['none', ...WEIGHTS], description: 'Subframe weighting method, or none' },
        frame_selection: {
          type: 'array', description: 'Frame selection filters [{metric, value, compare}], compare less or greater (non-interactive)',
          items: { type: 'object', properties: { metric: { type: 'string', enum: FS_METRICS }, value: { type: 'number' }, compare: { type: 'string', enum: ['less', 'greater'] } } },
        },
        optimize_darks: { type: 'boolean', description: 'Set dark optimization on every light group' },
        drizzle_scale: { type: 'number', description: 'Enable drizzle on every light group at this scale' },
        extra_params: { type: 'object', description: 'Further WBPP automation parameters, {name: value}' },
      },
      required: ['input_dirs', 'output_dir'],
    },
    async handler(api, input) {
      const scriptPath = wbppScriptPath(api.platform);
      if (!scriptPath || !fs.existsSync(scriptPath)) return { isError: true, text: `WBPP.js not found${scriptPath ? ` at ${scriptPath}` : ' (no PixInsight install resolved)'}.` };
      if (!api.platform.piBin) return { isError: true, text: 'No PixInsight executable resolved.' };
      for (const d of input.input_dirs ?? []) {
        if (!path.isAbsolute(String(d)) || !fs.existsSync(String(d))) return { isError: true, text: `input_dirs: folder not found: ${d}` };
      }
      const resolved = resolveExportPath(String(input.output_dir), { outputDir: api.workspace.outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
      if (resolved.error) return { isError: true, text: resolved.error.replace('file_path', 'output_dir') };
      if (input.reference_image !== undefined && !fs.existsSync(String(input.reference_image))) return { isError: true, text: `reference_image not found: ${input.reference_image}` };
      if (input.drizzle_scale !== undefined && !(typeof input.drizzle_scale === 'number' && input.drizzle_scale > 0)) throw new Error('drizzle_scale: a number > 0');

      const state = watcherState(fs, path.dirname(api.workspace.scratchDir), mid());
      if (state === 'busy') return { isError: true, text: 'Refused: the GUI PixInsight instance is running a command for this workspace (watcher busy).' };
      const root = runsDir(api);
      let earlier = [];
      try { earlier = fs.readdirSync(root); } catch {}
      for (const id of earlier) {
        const st = runStatus(fs, isPidAlive, path.join(root, id));
        if (st?.state === 'running') return { isError: true, text: `Refused: WBPP run ${id} (pid ${st.run.pid}) is still running.` };
      }

      const runId = `wbpp_${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      const dir = path.join(root, runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(resolved.path, { recursive: true });
      let builderPath = null;
      if (input.optimize_darks === true || input.optimize_darks === 'true' || input.drizzle_scale !== undefined) {
        builderPath = path.join(dir, 'pipeline_builder.js');
        fs.writeFileSync(builderPath, pipelineBuilderScript({ optimizeDarks: input.optimize_darks === true || input.optimize_darks === 'true', drizzleScale: input.drizzle_scale }));
      }
      const rArg = wbppArgs(input, { scriptPath, outputDir: resolved.path, builderPath });
      const logPath = path.join(dir, 'pixinsight.log');
      const fd = fs.openSync(logPath, 'a');
      const argv = ['-n', '--automation-mode', `-r=${rArg}`, '--force-exit'];
      let child;
      try {
        child = spawn(api.platform.piBin, argv, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      } finally {
        fs.closeSync(fd);
      }
      const record = { runId, pid: child.pid ?? null, started: new Date(now()).toISOString(), piBin: api.platform.piBin, argv, outputDir: resolved.path, log: logPath };
      fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record, null, 2));
      child.on?.('exit', (code, signal) => {
        try { fs.writeFileSync(path.join(dir, 'exit.json'), JSON.stringify({ code, signal, ended: new Date(now()).toISOString() })); } catch {}
      });
      child.on?.('error', (e) => {
        try { fs.writeFileSync(path.join(dir, 'exit.json'), JSON.stringify({ code: null, error: e.message, ended: new Date(now()).toISOString() })); } catch {}
      });
      child.unref?.();
      return { text: JSON.stringify({ runId, pid: record.pid, outputDir: resolved.path, log: logPath, argv }, null, 2) };
    },
  };

  const wbppStatus = {
    name: 'wbpp_status',
    description:
      'Report a run_wbpp run: running, finished (with the PixInsight exit code) or ended without an exit record; the master files ' +
      'in <output_dir>/master; the number of .xisf files in each subfolder of <output_dir>/registered and <output_dir>/calibrated; ' +
      'the WBPP log files in <output_dir>/logs; and the last lines of the instance\'s console output. run_id omitted: the latest run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id from run_wbpp (default: the latest run)' },
        tail_lines: { type: 'integer', description: 'Console-output lines to include (default 30)' },
      },
    },
    async handler(api, input) {
      const root = runsDir(api);
      let ids = [];
      try { ids = fs.readdirSync(root).filter((d) => d.startsWith('wbpp_')).sort(); } catch {}
      const id = input.run_id ?? ids[ids.length - 1];
      if (!id || !/^wbpp_[0-9TZ]+$/.test(String(id))) return { isError: true, text: id ? `Not a run id: ${id}` : 'No run_wbpp run in this workspace.' };
      const st = runStatus(fs, isPidAlive, path.join(root, id));
      if (!st) return { isError: true, text: `No record for run ${id}.` };
      const out = st.run.outputDir;
      const n = Number.isInteger(input.tail_lines) && input.tail_lines >= 0 ? input.tail_lines : 30;
      let tail = [];
      try { tail = fs.readFileSync(st.run.log, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n); } catch {}
      let logs = [];
      try { logs = fs.readdirSync(path.join(out, 'logs')).sort().map((f) => path.join(out, 'logs', f)); } catch {}
      const body = {
        runId: id, state: st.state, pid: st.run.pid, started: st.run.started, exit: st.exit, outputDir: out,
        masters: listXisf(fs, path.join(out, 'master')),
        registeredPerGroup: subfolderCounts(fs, path.join(out, 'registered')),
        calibratedPerGroup: subfolderCounts(fs, path.join(out, 'calibrated')),
        wbppLogs: logs, consoleLog: st.run.log, consoleTail: tail,
      };
      const failed = st.exit && st.exit.code !== 0;
      return failed ? { isError: true, text: `WBPP instance exited with code ${st.exit.code ?? st.exit.error}.\n${JSON.stringify(body, null, 2)}` } : { text: JSON.stringify(body, null, 2) };
    },
  };
  return [runWbpp, wbppStatus];
}

export const tools = makeWbppTools();
