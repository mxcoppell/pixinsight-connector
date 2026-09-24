import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tools } from '../src/tools/execute.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// Task 6 adds run_process and run_pjsr_file to this file's `tools` export (its own tests live in
// test/introspect.test.mjs); this exact-list assertion is updated to match, not relaxed or dropped.
test('execute.mjs exports run_pjsr, run_pixelmath, pixelmath_new_image, run_process and run_pjsr_file only', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['pixelmath_new_image', 'run_pixelmath', 'run_pjsr', 'run_pjsr_file', 'run_process']);
});

test('run_pjsr passes the code through verbatim and returns the result', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['42'] });
  const out = await byName.run_pjsr.handler(apiFrom(ctx), { code: '21*2' });
  assert.equal(emitted[0], '21*2');
  assert.equal(out.text, '42');
});

test('run_pjsr surfaces an error without throwing', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'bad snippet' } }] });
  const out = await byName.run_pjsr.handler(apiFrom(ctx), { code: 'x' });
  assert.match(out.text, /bad snippet/);
  assert.equal(out.isError, true);
});

test('run_pixelmath emits the expression and truncation guard', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.run_pixelmath.handler(apiFrom(ctx), { view_id: 'RGB', expression: '$T*1.1' });
  assert.match(emitted[0], /P\.expression = "\$T\*1\.1"/);
  assert.match(emitted[0], /P\.truncateUpper = 1/);
});

test('run_pixelmath reports failure without throwing', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'syntax error' } }] });
  const out = await byName.run_pixelmath.handler(apiFrom(ctx), { view_id: 'RGB', expression: 'bad(' });
  assert.match(out.text, /PixelMath FAILED/);
  assert.equal(out.isError, true);
});

test('pixelmath_new_image requires all three channel expressions for color rgb', async () => {
  const { ctx } = createFakeBridge();
  const out = await byName.pixelmath_new_image.handler(apiFrom(ctx), { output_id: 'SHO', size_from: 'Ha', color: 'rgb', red: 'Sii' });
  assert.match(out.text, /needs red, green and blue/);
  assert.equal(out.isError, true);
});

test('pixelmath_new_image builds a new RGB image from the three expressions', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await byName.pixelmath_new_image.handler(apiFrom(ctx), {
    output_id: 'SHO', size_from: 'Ha', color: 'rgb', red: 'Sii', green: 'Ha', blue: 'Oiii',
  });
  assert.match(emitted[0], /P\.expression = "Sii"/);
  assert.match(emitted[0], /P\.expression1 = "Ha"/);
  assert.match(emitted[0], /P\.expression2 = "Oiii"/);
  assert.match(emitted[0], /PixelMath\.RGB/);
});

test('pixelmath_new_image throws when PixelMath produces no image', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'no image' } }] });
  await assert.rejects(
    () => byName.pixelmath_new_image.handler(apiFrom(ctx), { output_id: 'X', size_from: 'Ha', color: 'gray', expression: 'Ha' }),
    /no image/
  );
});

test('run_pjsr refuses a top-level return with its line, and sends nothing', async () => {
  const { ctx, emitted } = createFakeBridge();
  const out = await byName.run_pjsr.handler(apiFrom(ctx), { code: 'var a = 1;\n  if (a) return 0;\na' });
  assert.equal(out.isError, true);
  assert.match(out.text, /^Syntax error: Illegal return statement, code line 2: "if \(a\) return 0;"\. Nothing was sent/);
  assert.match(out.text, /Nothing was sent to PixInsight/);
  assert.equal(emitted.length, 0);
});

test('run_pjsr refuses a stray markdown line with its line number', async () => {
  const { ctx, emitted } = createFakeBridge();
  const out = await byName.run_pjsr.handler(apiFrom(ctx), { code: 'function f() { return 1; }\n## J. Scan\nf()' });
  assert.match(out.text, /Syntax error: .*code line 2: "## J\. Scan"/);
  assert.equal(emitted.length, 0);
});

test('run_pjsr prepends include files in order and names the file a syntax error is in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixinsight-connector-include-'));
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  fs.writeFileSync(a, 'function one() { return 1; }');
  fs.writeFileSync(b, 'function two() { return one() + 1; }');
  const ok = createFakeBridge({ replies: ['2'] });
  const out = await byName.run_pjsr.handler(apiFrom(ok.ctx), { code: 'two()', include: [a, b] });
  assert.equal(out.text, '2');
  assert.equal(ok.emitted[0], 'function one() { return 1; }\nfunction two() { return one() + 1; }\ntwo()');

  fs.writeFileSync(b, 'function two() {\n  return one( + ;\n}');
  const bad = createFakeBridge();
  const out2 = await byName.run_pjsr.handler(apiFrom(bad.ctx), { code: 'two()', include: [a, b] });
  assert.match(out2.text, /b\.js line 2: "return one\( \+ ;"/);
  assert.equal(bad.emitted.length, 0);
});

test('run_pjsr rejects an include that is relative or missing', async () => {
  const { ctx, emitted } = createFakeBridge();
  await assert.rejects(() => byName.run_pjsr.handler(apiFrom(ctx), { code: '1', include: ['lib.js'] }), /absolute path/);
  await assert.rejects(() => byName.run_pjsr.handler(apiFrom(ctx), { code: '1', include: [path.join(os.tmpdir(), 'no-such-pixinsight-connector.js')] }), /cannot be read/);
  assert.equal(emitted.length, 0);
});

test('run_pjsr_file refuses a file that does not parse, naming the file and line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixinsight-connector-file-'));
  const f = path.join(dir, 'step.js');
  fs.writeFileSync(f, 'var x = 1;\nreturn x;');
  const { ctx, emitted } = createFakeBridge();
  const out = await byName.run_pjsr_file.handler(apiFrom(ctx), { path: f });
  assert.match(out.text, /Illegal return statement, step\.js line 2: "return x;"/);
  assert.equal(emitted.length, 0);
});
