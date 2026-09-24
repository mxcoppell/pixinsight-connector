// The handler contract (CONTRIBUTING.md, "What a handler returns") over the whole core catalog: when
// PixInsight reports an error, every tool's MCP result is an error (isError), never a success an
// agent could act on; and when the user pressed Pause/Abort, every tool's result is the server's
// STOPPED BY USER mapping, not a tool-specific "FAILED: … MCP_ABORTED …" the agent may retry.
//
// Driven through the real createServer() dispatch with an api whose every pjsr call fails, so a
// tool may either throw or return { isError: true }; both are fine, a plain { text } is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { apiFrom } from './fake-bridge.mjs';

// Tools whose valid input cannot reach a pjsr call without real state, so an erroring pjsr says
// nothing about them. Keep this short.
const EXCLUDED = new Set([
  'pixinsight_info', 'scan_workspace', // report the connector's own state; no PixInsight
  'list_open_images', // reads api.listImages, which this fake answers
  'find_filters', 'run_spfc', // read PixInsight's filter database from disk before any pjsr
]);

const OPEN_VIEWS = ['V1', 'V2', 'V3', 'M1'];

// One valid input per tool, generated from its schema, with the few fields a generic value would
// make invalid spelled out.
function inputFor(def, dir) {
  const overrides = {
    pixelmath_new_image: { color: 'gray', expression: 'V1' },
    run_mgc: { mars_files: [path.join(dir, 'fake.xmars')] },
    export_image: { file_path: 'out.png' },
    run_pjsr_file: { path: path.join(dir, 'snippet.js') },
    open_image: { file_path: path.join(dir, 'image.xisf') },
    run_curves: { channel: 'RGB', points: [[0, 0], [1, 1]] },
    get_image_dimensions: { view_ids: ['V1'] },
    run_process: { name: 'SCNR', view_id: 'V1' },
    describe_process: { name: 'SCNR' },
    save_preview: { label: 'contract' },
    save_and_show_preview: { label: 'contract' },
    apply_mask: { mask_id: 'M1' },
    align_to_reference: { reference_id: 'V1', target_id: 'V2' },
    create_zone_masks: { core_clip: 0.4, shell_clip: 0.15, halo_clip: 0.04 }, // needs halo < shell < core < 1
    robust_median_stretch: { target_median: 0.25 },
    stretch_stars: { midtone: 0.2 },
    continuous_clamp: { headroom: 0.12, rate: 3 },
    star_protected_blend: { core_threshold_low: 0.6, core_threshold_high: 0.82 }, // needs low < high
    restore_star_color: { restore_start: 0.6, restore_end: 0.82 }, // needs start < end
    measure_star_layer: { levels: [0.98] },
    multi_scale_enhance: { mask_clip_low: 0.06 }, // needs [0, 1)
    dynamic_narrowband_blend: { mask_clip: 0.04 }, // needs [0, 1)
  }[def.name] ?? {};
  const input = {};
  for (const key of def.inputSchema.required ?? []) {
    const prop = def.inputSchema.properties[key];
    if (prop.enum) input[key] = prop.enum[0];
    else if (prop.type === 'number' || prop.type === 'integer') input[key] = 1;
    else if (prop.type === 'boolean') input[key] = false;
    else if (prop.type === 'array') input[key] = ['V1'];
    else if (/file|path/.test(key)) input[key] = path.join(dir, 'file.xisf');
    else if (/_id$|^view|^size_from$/.test(key)) input[key] = 'V1';
    else input[key] = 'x';
  }
  return { ...input, ...overrides };
}

async function harness(errorMessage) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-contract-'));
  writeFileSync(path.join(dir, 'snippet.js'), '1;');
  writeFileSync(path.join(dir, 'image.xisf'), '');
  const ctx = {
    pjsr: async () => ({ status: 'error', error: { message: errorMessage } }),
    listImages: async () => OPEN_VIEWS.map((id) => ({ id, width: 10, height: 10, isColor: false })),
  };
  const api = apiFrom(ctx, { workspace: { dir, scratchDir: path.join(dir, 'agentic', 'scratch'), outputDir: path.join(dir, 'output') } });
  const core = await buildCoreCatalog();
  const server = createServer({ catalog: core, api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { dir, core, client, close: async () => { await client.close(); await server.close(); } };
}

test('every core tool reports a PixInsight error as an MCP error result', async () => {
  const h = await harness('Script error: boom');
  const plain = [];
  try {
    for (const def of h.core.definitions) {
      if (EXCLUDED.has(def.name)) continue;
      const r = await h.client.callTool({ name: def.name, arguments: inputFor(def, h.dir) });
      if (r.isError !== true) plain.push(`${def.name}: ${r.content.map((c) => c.text).join(' | ').slice(0, 160)}`);
    }
  } finally {
    await h.close();
  }
  assert.deepEqual(plain, [], 'these tools reported a failed PixInsight call as success');
});

test('every core tool maps a Pause/Abort (MCP_ABORTED) to the server\'s STOPPED BY USER result', async () => {
  const h = await harness('Script error: MCP_ABORTED: Pause/Abort was pressed');
  const wrong = [];
  try {
    for (const def of h.core.definitions) {
      if (EXCLUDED.has(def.name)) continue;
      const r = await h.client.callTool({ name: def.name, arguments: inputFor(def, h.dir) });
      const text = r.content.map((c) => c.text).join(' | ');
      if (r.isError !== true || !/^STOPPED BY USER/.test(r.content[0].text)) wrong.push(`${def.name}: ${text.slice(0, 160)}`);
    }
  } finally {
    await h.close();
  }
  assert.deepEqual(wrong, [], 'these tools did not reach the server\'s abort mapping');
});

test('the exclusion list names only tools that exist', async () => {
  const names = new Set((await buildCoreCatalog()).definitions.map((d) => d.name));
  for (const n of EXCLUDED) assert.ok(names.has(n), `${n} is not a core tool`);
});
