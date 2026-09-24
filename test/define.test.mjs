import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineProcessTool } from '../src/define.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';

const scnr = defineProcessTool({
  name: 'run_scnr', process: 'SCNR', description: 'Run SCNR to remove a colour cast from a view.',
  target: 'view',
  params: {
    amount: { type: 'number', pjsr: 'amount', default: 0.8, description: 'Removal strength, 0 to 1.' },
    protection: { type: 'string', pjsr: 'protectionMethod', constantsFrom: 'SCNR',
                  enum: ['AverageNeutral', 'MaximumMask'], default: 'AverageNeutral',
                  description: 'Protection method.' },
  },
});

test('generates a JSON Schema with view_id required and params optional', () => {
  assert.deepEqual(scnr.inputSchema.required, ['view_id']);
  assert.equal(scnr.inputSchema.properties.amount.type, 'number');
  assert.deepEqual(scnr.inputSchema.properties.protection.enum, ['AverageNeutral', 'MaximumMask']);
});

test('emits PJSR with V8 constants, never .prototype', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await scnr.handler(apiFrom(ctx), { view_id: 'RGB', amount: 0.5, protection: 'MaximumMask' });
  assert.match(emitted[0], /new SCNR/);
  assert.match(emitted[0], /P\.amount = 0\.5/);
  assert.match(emitted[0], /P\.protectionMethod = SCNR\.MaximumMask/);
  assert.doesNotMatch(emitted[0], /\.prototype\./);
});

test('omitted params are not emitted at all, so PixInsight defaults stand', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await scnr.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.doesNotMatch(emitted[0], /P\.amount/);
});

test('a falsy executeOn throws rather than reporting success', async () => {
  const { ctx } = createFakeBridge({ replies: [{ status: 'error', error: { message: 'the process did not run' } }] });
  await assert.rejects(() => scnr.handler(apiFrom(ctx), { view_id: 'RGB' }), /did not run/);
});

test('an unknown enum value is rejected before it reaches PixInsight', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: ['ok'] });
  await assert.rejects(() => scnr.handler(apiFrom(ctx), { view_id: 'RGB', protection: 'Nonsense' }), /Nonsense/);
  assert.equal(emitted.length, 0);
});

test('a process name that is not a bare identifier is refused', () => {
  assert.throws(() => defineProcessTool({ name: 'x', process: 'SCNR; evil()', description: 'd', params: {} }), /process name/);
});

// --- Result text (e2e defect: run_nxt / linear_fit / run_scnr returned a bare "Script executed.") ---

test('the generated handler reports the process, the view and every parameter it set', async () => {
  const { ctx } = createFakeBridge({ replies: ['Script executed.'] });
  const out = await scnr.handler(apiFrom(ctx), { view_id: 'RGB', amount: 0.5, protection: 'MaximumMask' });
  assert.equal(typeof out, 'object');
  assert.match(out.text, /SCNR/);
  assert.match(out.text, /"RGB"/);
  assert.match(out.text, /amount=0\.5/);
  assert.match(out.text, /protection=MaximumMask/);
  assert.doesNotMatch(out.text, /^Script executed\.$/);
  assert.notEqual(out.isError, true);
});

test('with no parameters given, the result says PixInsight defaults were used', async () => {
  const { ctx } = createFakeBridge({ replies: ['Script executed.'] });
  const out = await scnr.handler(apiFrom(ctx), { view_id: 'RGB' });
  assert.match(out.text, /SCNR/);
  assert.match(out.text, /"RGB"/);
  assert.match(out.text, /default/i);
});

// --- `required: true` on a param spec (the parked Task 4 limitation) ---

const fit = defineProcessTool({
  name: 'fixture_fit', process: 'LinearFit', description: 'Run LinearFit against a reference view.',
  target: 'view',
  params: {
    reference_id: { type: 'string', pjsr: 'referenceViewId', required: true, description: 'Reference view ID.' },
    reject_high: { type: 'number', pjsr: 'rejectHigh', description: 'High rejection threshold.' },
  },
});

test('a param declared required: true joins view_id in the schema\'s required list', () => {
  assert.deepEqual(fit.inputSchema.required, ['view_id', 'reference_id']);
  assert.equal('required' in fit.inputSchema.properties.reference_id, false, 'required is a schema-level list, not a property keyword');
});

test('the generated handler refuses a call missing a required param, before reaching PixInsight', async () => {
  const { ctx, emitted } = createFakeBridge();
  await assert.rejects(() => fit.handler(apiFrom(ctx), { view_id: 'L' }), /reference_id/);
  assert.equal(emitted.length, 0);
});
