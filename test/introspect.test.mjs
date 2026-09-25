import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools as introspectTools, listProcesses, describeProcess } from '../src/tools/introspect.mjs';
import { tools as executeTools, runProcess } from '../src/tools/execute.mjs';

const byName = Object.fromEntries([...introspectTools, ...executeTools].map((t) => [t.name, t]));

test('introspect.mjs exports list_processes and describe_process only', () => {
  assert.deepEqual(Object.keys(Object.fromEntries(introspectTools.map((t) => [t.name, t]))).sort(), ['describe_process', 'list_processes']);
});

test('execute.mjs now exports run_process and run_pjsr_file alongside Task 5\'s three', () => {
  assert.deepEqual(
    Object.keys(Object.fromEntries(executeTools.map((t) => [t.name, t]))).sort(),
    ['pixelmath_new_image', 'run_pixelmath', 'run_pjsr', 'run_pjsr_file', 'run_process']
  );
});

// --- list_processes ---

test('list_processes emits the verified enumeration shape: prototype-chain check, deprecated-global skip, never instantiates', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify(['PixelMath', 'SCNR'])] });
  await listProcesses(apiFrom(ctx));
  const snippet = emitted[0];
  assert.match(snippet, /C\.prototype instanceof ProcessInstance/);
  for (const deprecated of ['coreDocDirPath', 'coreDirPath', 'coreColorDirPath', 'coreBinDirPath', 'coreBaseDirPath', 'coreAppDirPath']) {
    assert.ok(snippet.includes(deprecated), `expected the deprecated-skip list to include ${deprecated}`);
  }
  assert.doesNotMatch(snippet, /new\s+[A-Z]/, 'must never instantiate a global to classify it');
});

test('list_processes returns the parsed process table', async () => {
  // 115 names on the real 1.9.5 install per the spike; this canned reply only needs to be valid JSON
  // exercising the real parse path, with the two names the live test also checks for.
  const { ctx } = createFakeBridge({ replies: [JSON.stringify(['BlurXTerminator', 'PixelMath', 'SCNR'])] });
  const { processes } = await listProcesses(apiFrom(ctx));
  assert.deepEqual(processes, ['BlurXTerminator', 'PixelMath', 'SCNR']);
});

test('list_processes surfaces a PJSR error instead of returning a partial list', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'globalThis unavailable' } }] });
  await assert.rejects(() => listProcesses(apiFrom(ctx)), /globalThis unavailable/);
});

// --- describe_process ---

// The spike's real Object.getOwnPropertyNames(SCNR) output:
// ['length','name','prototype','AdditiveMask','AverageNeutral','Blue','Green',
//  'MaximumMask','MaximumNeutral','MinimumNeutral','Red'] with SCNR.AverageNeutral === 2.
// This canned reply is what a real bridge would hand back after running the generated
// PJSR against that install, so the assertions below exercise the actual parser against
// the spike's genuine shape rather than a shape this test invents.
const SCNR_DESCRIBE_REPLY = JSON.stringify({
  process: 'SCNR',
  category: 'NoiseReduction',
  canProcessViews: true,
  canProcessGlobal: true,
  parameters: [
    { name: 'protectionMethod', value: 0, type: 'number' },
    { name: 'preserveLuminance', value: true, type: 'boolean' },
    { name: 'preserveLightness', value: false, type: 'boolean' },
    { name: 'colorToRemove', value: 1, type: 'number' },
    { name: 'amount', value: 0.8, type: 'number' },
  ],
  constants: [
    { name: 'AdditiveMask', value: 4 },
    { name: 'AverageNeutral', value: 2 },
    { name: 'Blue', value: 1 },
    { name: 'Green', value: 0 },
    { name: 'MaximumMask', value: 3 },
    { name: 'MaximumNeutral', value: 5 },
    { name: 'MinimumNeutral', value: 6 },
    { name: 'Red', value: 2 },
  ],
});

test('describe_process emits Object.keys + typeof-function filter for parameters, Object.getOwnPropertyNames + typeof-number filter for constants', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [SCNR_DESCRIBE_REPLY] });
  await describeProcess(apiFrom(ctx), 'SCNR');
  const snippet = emitted[0];
  assert.match(snippet, /new SCNR/);
  assert.match(snippet, /Object\.keys\(P\)/);
  assert.match(snippet, /typeof v !== 'function'/);
  assert.match(snippet, /Object\.getOwnPropertyNames\(SCNR\)/);
  assert.match(snippet, /typeof cv === 'number'/);
  assert.match(snippet, /P\.processCategory\(\)/);
  assert.match(snippet, /P\.canProcessViews\(\)/);
  assert.match(snippet, /P\.canProcessGlobal\(\)/);
  assert.doesNotMatch(snippet, /\.prototype\./, 'constants must come off the constructor, never .prototype.');
});

test('describe_process extracts SCNR\'s 5 real parameters and 8 real constants from the genuine spike shape', async () => {
  const { ctx } = createFakeBridge({ replies: [SCNR_DESCRIBE_REPLY] });
  const result = await describeProcess(apiFrom(ctx), 'SCNR');
  assert.equal(result.process, 'SCNR');
  assert.equal(result.category, 'NoiseReduction');
  assert.equal(result.canProcessViews, true);
  assert.equal(result.canProcessGlobal, true);
  assert.deepEqual(
    result.parameters.map((p) => p.name).sort(),
    ['amount', 'colorToRemove', 'preserveLightness', 'preserveLuminance', 'protectionMethod']
  );
  const constantNames = result.constants.map((c) => c.name).sort();
  assert.deepEqual(constantNames, ['AdditiveMask', 'AverageNeutral', 'Blue', 'Green', 'MaximumMask', 'MaximumNeutral', 'MinimumNeutral', 'Red']);
  const avgNeutral = result.constants.find((c) => c.name === 'AverageNeutral');
  assert.equal(avgNeutral.value, 2);
});

// Regression: the fake bridge hands back a hand-authored canned reply regardless of what the
// generated PJSR would actually produce when eval-ed as real JS, so it cannot catch a guard()-wrapped
// body whose last statement is a bare expression instead of a `return` (the IIFE then always
// evaluates to undefined, no matter what JSON.stringify computed). This test captures the real
// generated snippet and actually eval()s it against a minimal stand-in process, to prove the
// guard()-wrapped body's return value genuinely survives the (function(){ try { ... } catch... })()
// wrapping — not just that a pre-baked JSON string round-trips through JSON.parse.
test('the guard()-wrapped PJSR body actually returns its value when eval-ed as real JS (not just undefined)', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['{}'] });
  await describeProcess(apiFrom(ctx), 'FakeProcess');
  const snippet = emitted[0];

  // A minimal stand-in process: some function-valued own properties (like PJSR's own
  // "inherited-looking" instance methods), some real parameters, and a constructor with an own
  // numeric constant alongside the ever-present, non-constant `length`.
  function ProcessInstance() {}
  function FakeProcess() {
    this.amount = 0.8;
    this.ownMethod = function () {};
  }
  FakeProcess.prototype = Object.create(ProcessInstance.prototype);
  FakeProcess.prototype.processId = function () { return 'FakeProcess'; };
  FakeProcess.prototype.processCategory = function () { return 'Test'; };
  FakeProcess.prototype.canProcessViews = function () { return true; };
  FakeProcess.prototype.canProcessGlobal = function () { return false; };
  FakeProcess.SomeConstant = 42;

  // eslint-disable-next-line no-eval -- deliberately eval-ing generated PJSR as real JS, see comment above
  const raw = eval(snippet);
  assert.equal(typeof raw, 'string', 'guard()-wrapped body must actually return its JSON.stringify(...) value, not fall through to undefined');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.process, 'FakeProcess');
  assert.equal(parsed.canProcessViews, true);
  assert.equal(parsed.canProcessGlobal, false);
  assert.deepEqual(parsed.parameters.map((p) => p.name), ['amount']);
  assert.deepEqual(parsed.constants, [{ name: 'SomeConstant', value: 42 }]);
  assert.ok(!parsed.constants.some((c) => c.name === 'length'), "Function.prototype.length must not leak in as a fake constant");
});

test('describe_process rejects a process name that is not a bare identifier, before any PJSR is sent', async () => {
  const { ctx, emitted } = createFakeBridge();
  await assert.rejects(() => describeProcess(apiFrom(ctx), 'SCNR; evil()'), /process name/);
  assert.equal(emitted.length, 0);
});

test('describe_process surfaces a PJSR error (e.g. the name is not really a process) as a real Error', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'No PixInsight process named CheckBox. The name is a PJSR process constructor name; list_processes lists the ones installed.' } }] });
  await assert.rejects(() => describeProcess(apiFrom(ctx), 'CheckBox'), /No PixInsight process named CheckBox/);
});

// The unknown-name check, eval-ed as real JS the way PixInsight evals it: an undeclared name, a
// non-process global and a real process, for both tools that build `new <name>`.
function evalWithGlobals(snippet, globals) {
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func -- deliberately eval-ing generated PJSR with stand-in globals
  return new Function(...names, `return eval(${JSON.stringify(snippet)});`)(...names.map((n) => globals[n]));
}

function processGlobals() {
  function ProcessInstance() {}
  function Real() { this.amount = 1; }
  Real.prototype = Object.create(ProcessInstance.prototype);
  Real.prototype.processId = () => 'Real';
  Real.prototype.processCategory = () => 'Test';
  Real.prototype.canProcessViews = () => true;
  Real.prototype.canProcessGlobal = () => true;
  Real.prototype.executeGlobal = () => true;
  function CheckBox() {}
  return { ProcessInstance, Real, CheckBox };
}

for (const [tool, emit] of [
  ['describe_process', (api, n) => describeProcess(api, n)],
  ['run_process', (api, n) => runProcess(api, n, {}, undefined)],
]) {
  test(`${tool} checks that the name is a process before instantiating it`, async () => {
    const { ctx, emitted } = createFakeBridge({ replies: ['{}'] });
    await emit(apiFrom(ctx), 'SPCC').catch(() => {});
    const snippet = emitted[0];
    assert.ok(snippet.indexOf('SPCC.prototype instanceof ProcessInstance') < snippet.indexOf('new SPCC'));
    assert.throws(() => evalWithGlobals(snippet, processGlobals()),
      /^Error: No PixInsight process named SPCC\. The name is a PJSR process constructor name; list_processes lists the ones installed\.$/);
  });

  test(`${tool} rejects a non-process global without instantiating it`, async () => {
    const { ctx, emitted } = createFakeBridge({ replies: ['{}'] });
    await emit(apiFrom(ctx), 'CheckBox').catch(() => {});
    let built = false;
    const g = processGlobals();
    g.CheckBox = function CheckBox() { built = true; };
    assert.throws(() => evalWithGlobals(emitted[0], g), /No PixInsight process named CheckBox/);
    assert.equal(built, false);
  });

  test(`${tool} runs a real process exactly as before`, async () => {
    const { ctx, emitted } = createFakeBridge({ replies: ['{}'] });
    await emit(apiFrom(ctx), 'Real').catch(() => {});
    assert.doesNotThrow(() => evalWithGlobals(emitted[0], processGlobals()));
  });
}

// --- run_process ---

test('run_process rejects a process name that is not a bare identifier, before any PJSR is sent', async () => {
  const { ctx, emitted } = createFakeBridge();
  await assert.rejects(() => runProcess(apiFrom(ctx), 'SCNR; evil()', {}, 'RGB'), /process name/);
  assert.equal(emitted.length, 0);
});

test('run_process rejects a params key that is not a bare identifier, before any PJSR is sent', async () => {
  const { ctx, emitted } = createFakeBridge();
  await assert.rejects(() => runProcess(apiFrom(ctx), 'SCNR', { 'amount; evil()': 1 }, 'RGB'), /param key/);
  assert.equal(emitted.length, 0);
});

test('run_process with a view_id builds new <name>, assigns JSON params, and runs executeOn', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  const out = await runProcess(apiFrom(ctx), 'SCNR', { amount: 0.6, preserveLuminance: true }, 'RGB');
  assert.match(emitted[0], /var P = new SCNR;/);
  assert.match(emitted[0], /P\.amount = 0\.6;/);
  assert.match(emitted[0], /P\.preserveLuminance = true;/);
  assert.match(emitted[0], /P\.canProcessViews\(\)/);
  assert.match(emitted[0], /ImageWindow\.windowById\("RGB"\)/);
  assert.match(emitted[0], /executeOn/);
  assert.deepEqual(out, { ok: true, message: 'SCNR executed on RGB.' });
});

test('run_process with no view_id runs executeGlobal instead', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  const out = await runProcess(apiFrom(ctx), 'PixelMath', {}, undefined);
  assert.match(emitted[0], /P\.canProcessGlobal\(\)/);
  assert.match(emitted[0], /P\.executeGlobal\(\)/);
  // The __run(P, view) helper (which internally calls executeOn) is always defined by guard(),
  // even when unused — same convention as v0-pipeline:agents/llm/tools-essential.mjs:19 — but it must never
  // actually be invoked on the no-view/executeGlobal path.
  assert.doesNotMatch(emitted[0], /__run\(P, __w/);
  assert.deepEqual(out, { ok: true, message: 'PixelMath executed globally.' });
});

test('run_process throws "the process did not run" on a falsy executeOn/executeGlobal, not a silent ok:false', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'the process did not run (see console message)' } }] });
  await assert.rejects(() => runProcess(apiFrom(ctx), 'SCNR', {}, 'RGB'), /the process did not run/);
});

// --- run_process (tool descriptor) ---

test('run_process tool descriptor wraps runProcess and requires "name"', async () => {
  const { ctx } = createFakeBridge();
  await assert.rejects(() => byName.run_process.handler(apiFrom(ctx), {}), /"name" is required/);
});

test('run_process tool descriptor returns the {ok, message} result as text', async () => {
  const { ctx } = createFakeBridge({ replies: ['ok'] });
  const out = await byName.run_process.handler(apiFrom(ctx), { name: 'GradientCorrection', view_id: 'RGB' });
  assert.match(out.text, /"ok":true/);
  assert.match(out.text, /GradientCorrection executed on RGB/);
});

// --- list_processes / describe_process tool descriptors ---

test('list_processes tool descriptor returns the process table as text', async () => {
  const { ctx } = createFakeBridge({ replies: [JSON.stringify(['SCNR'])] });
  const out = await byName.list_processes.handler(apiFrom(ctx), {});
  assert.match(out.text, /"processes"/);
  assert.match(out.text, /SCNR/);
});

test('describe_process tool descriptor requires "name" and returns the description as text', async () => {
  const { ctx } = createFakeBridge();
  await assert.rejects(() => byName.describe_process.handler(apiFrom(ctx), {}), /"name" is required/);

  const { ctx: ctx2 } = createFakeBridge({ replies: [SCNR_DESCRIBE_REPLY] });
  const out = await byName.describe_process.handler(apiFrom(ctx2), { name: 'SCNR' });
  assert.match(out.text, /"process": "SCNR"/);
});

// --- run_pjsr_file ---

test('run_pjsr_file reads the file from disk and passes its contents to api.pjsr, same shape as run_pjsr', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-pjsr-file-'));
  const file = path.join(dir, 'snippet.js');
  writeFileSync(file, '21*2');
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['42'] });
    const out = await byName.run_pjsr_file.handler(apiFrom(ctx), { path: file });
    assert.equal(emitted[0], '21*2');
    assert.equal(out.text, '42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run_pjsr_file surfaces a PJSR error without throwing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-pjsr-file-'));
  const file = path.join(dir, 'snippet.js');
  writeFileSync(file, 'x');
  try {
    const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'bad snippet' } }] });
    const out = await byName.run_pjsr_file.handler(apiFrom(ctx), { path: file });
    assert.match(out.text, /bad snippet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run_pjsr_file throws a clear error when the file does not exist', async () => {
  const { ctx } = createFakeBridge();
  await assert.rejects(() => byName.run_pjsr_file.handler(apiFrom(ctx), { path: '/no/such/file.js' }), /ENOENT/);
});
