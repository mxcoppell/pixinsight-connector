import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCoreCatalog } from '../src/tools/index.mjs';

test('every tool satisfies the descriptor contract', async () => {
  const { definitions, handlers } = await buildCoreCatalog();
  const names = definitions.map((d) => d.name);
  for (const d of definitions) {
    assert.match(d.name, /^[a-z][a-z0-9_]*$/, `${d.name}: snake_case`);
    assert.equal(names.filter((n) => n === d.name).length, 1, `${d.name}: unique`);
    assert.ok(d.description?.length > 20, `${d.name}: real description`);
    assert.equal(d.inputSchema.type, 'object', `${d.name}: object schema`);
    assert.equal(handlers.get(d.name).length, 2, `${d.name}: handler is (api, input)`);
  }
});

test('no tool description carries processing opinion', async () => {
  const { definitions } = await buildCoreCatalog();
  for (const d of definitions) {
    assert.doesNotMatch(d.description, /\b0\.\d+\s*(to|-|–)\s*0\.\d+\b/, `${d.name}: tuning range`);
    assert.doesNotMatch(d.description, /\b(recommended|should use|ALWAYS|never use)\b/i, `${d.name}: advice`);
  }
});

// Ordering is technique: "use this after X", "align first", "run X first", "before combining". A
// description may state a precondition (the image must be linear), never the step to take next.
const ORDERING_HINT = /\b(?:use (?:this|it) (?:after|before|when)|before combining|\w+ first\b(?! (?:sentence|expression|view|channel))|typically an?|should be an?)\b/i;
test('no tool or parameter description tells the caller what to do next', async () => {
  const { definitions } = await buildCoreCatalog();
  const problems = [];
  for (const d of definitions) {
    if (ORDERING_HINT.test(d.description)) problems.push(`${d.name}: ${d.description.match(ORDERING_HINT)[0]}`);
    for (const [param, schema] of Object.entries(d.inputSchema.properties ?? {})) {
      const text = schema.description ?? '';
      if (ORDERING_HINT.test(text)) problems.push(`${d.name}.${param}: ${text.match(ORDERING_HINT)[0]}`);
    }
  }
  assert.deepEqual(problems, []);
});

// The new module goes into a private copy of src/, never the real src/tools/: node --test runs test
// files in parallel, and every other test that scans src/ (hygiene, dead-file, docs and README-table
// gates, the real catalog) would otherwise see the transient file appear, or vanish mid-read.
test('adding a tool module needs no registry edit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixinsight-connector-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('src', path.join(root, 'src'), { recursive: true });
  const copy = await import(pathToFileURL(path.join(root, 'src', 'tools', 'index.mjs')).href);
  const before = (await copy.buildCoreCatalog()).definitions.length;
  assert.equal(before, (await buildCoreCatalog()).definitions.length, 'the copy starts as the real catalog');

  await writeFile(path.join(root, 'src', 'tools', 'zz-temp.mjs'), `export const tools = [{
    name: 'temp_probe', description: 'A temporary tool used only by this test run.',
    inputSchema: { type: 'object', properties: {} }, handler: async (api, input) => ({ text: 'ok' }) }];`);
  const after = await copy.buildCoreCatalog();
  assert.equal(after.definitions.length, before + 1);
  assert.ok(after.handlers.has('temp_probe'));
});

// Result texts and the server's instructions follow the same rule as descriptions: say what
// happened, never which step to take next.
const NEXT_STEP_ADVICE = /\b(?:check that|check the|ensure|after BXT|start with|copy_astrometric_solution from)\b/i;

test('failure texts report what happened, not which step to take next', async () => {
  const { createFakeBridge, apiFrom } = await import('./fake-bridge.mjs');
  const { handlers } = await buildCoreCatalog();
  const cases = [
    ['run_spcc', { view_id: 'RGB' }, ['SPCC_result=false']],
    ['run_plate_solve', { view_id: 'RGB', ra_deg: 1, dec_deg: 1, pixel_scale: 1 }, ['@@SOLVE@@{"solved":false,"error":"no solution"}']],
    ['combine_channels', { r_view_id: 'R', g_view_id: 'G', b_view_id: 'B', output_id: 'RGB' }, ['CC_result=false']],
  ];
  for (const [name, input, replies] of cases) {
    const { ctx } = createFakeBridge({ replies });
    const out = await handlers.get(name)(apiFrom(ctx), input);
    assert.equal(out.isError, true, name);
    assert.doesNotMatch(out.text, NEXT_STEP_ADVICE, `${name}: ${out.text}`);
  }
});

// With no install, api.platform is { error } and every path in it is absent. A tool that reads a
// platform path reports that held message, never a Node error about an undefined path.
test('tools that read api.platform paths report the held error when no install resolved', async () => {
  const { createFakeBridge, apiFrom } = await import('./fake-bridge.mjs');
  const { PlatformError } = await import('../src/platform.mjs');
  const { handlers } = await buildCoreCatalog();
  const held = 'Could not find a PixInsight installation (looked for "/opt/PixInsight/bin/PixInsight").';
  const reject = async () => { throw new PlatformError(held); };
  const api = apiFrom(createFakeBridge().ctx, { platform: { error: held }, pjsr: reject, listImages: reject });
  const cases = [
    ['find_filters', { query: 'Ha' }],
    ['run_spfc', { view_id: 'RGB' }],
    ['run_spcc', { view_id: 'RGB', white_reference: 'Average Spiral Galaxy', red_filter_name: 'R' }],
    ['run_mgc', { view_id: 'RGB' }],
  ];
  for (const [name, input] of cases) {
    // Either shape is clean: a PlatformError (the server returns its message as is) or an isError
    // result that carries the held message.
    const out = await handlers.get(name)(api, input).then((r) => r, (e) => e);
    if (out instanceof Error) {
      assert.equal(out.name, 'PlatformError', `${name}: ${out.message}`);
      assert.equal(out.message, held, name);
    } else {
      assert.equal(out.isError, true, name);
      assert.ok(out.text.includes(held), `${name}: ${out.text}`);
    }
  }
});

test('the server instructions say what the server is, not what to do first', async () => {
  const { createServer } = await import('../src/server.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createFakeBridge, apiFrom } = await import('./fake-bridge.mjs');
  const server = createServer({ catalog: await buildCoreCatalog(), api: apiFrom(createFakeBridge().ctx) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions.length > 40);
    assert.doesNotMatch(instructions, NEXT_STEP_ADVICE);
    assert.doesNotMatch(instructions, /\bscan_workspace\b/);
  } finally {
    await client.close();
    await server.close();
  }
});
