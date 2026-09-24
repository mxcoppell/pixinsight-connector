import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools } from '../src/tools/preview.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test('preview.mjs exports save_preview and the save_and_show_preview alias', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['save_and_show_preview', 'save_preview']);
  assert.equal(byName.save_preview.handler, byName.save_and_show_preview.handler);
});

test('save_preview returns the file path as text, never an image content block', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-preview-'));
  try {
    const { ctx } = createFakeBridge({ replies: ['ok', JSON.stringify({ median: 0.2, mad: 0.01, max: 0.9 })] });
    const api = apiFrom(ctx, { workspace: { dir, scratchDir: dir } });
    // The handler checks fs.existsSync(previewPath) to decide the closing line; simulate PixInsight
    // having written the file, since the fake bridge does not actually run PJSR.
    mkdirSync(path.join(dir, 'previews'), { recursive: true });
    writeFileSync(path.join(dir, 'previews', 'after_stretch.jpg'), '');
    const out = await byName.save_preview.handler(api, { view_id: 'RGB', label: 'after_stretch' });
    assert.equal(typeof out.text, 'string');
    assert.ok(!('type' in out) || out.type !== 'image');
    assert.match(out.text, /Preview saved: after_stretch/);
    assert.match(out.text, /median=0\.200000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save_preview rejects a label that would escape the previews directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-preview-'));
  try {
    const { ctx } = createFakeBridge();
    const api = apiFrom(ctx, { workspace: { dir, scratchDir: dir } });
    await assert.rejects(
      () => byName.save_preview.handler(api, { view_id: 'RGB', label: '../../../../etc/cron.d/evil' }),
      /plain filename/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save_preview reports when the file was not created', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-preview-'));
  try {
    const { ctx } = createFakeBridge({ replies: ['ok', JSON.stringify({ median: 0.2 })] });
    const api = apiFrom(ctx, { workspace: { dir, scratchDir: dir } });
    const out = await byName.save_preview.handler(api, { view_id: 'RGB', label: 'missing' });
    assert.match(out.text, /Preview file not created/);
    assert.equal(out.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save_preview removes an older JPEG with the same label before PixInsight runs, so a failed snippet never reports it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-preview-'));
  try {
    const stale = path.join(dir, 'previews', 'final.jpg');
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, 'yesterday');
    const { existsSync } = await import('node:fs');
    let presentWhenSnippetRan = null;
    const ctx = {
      pjsr: async () => { presentWhenSnippetRan = existsSync(stale); return { status: 'error', error: { message: 'Resample failed' } }; },
      listImages: async () => [],
    };
    const api = apiFrom(ctx, { workspace: { dir, scratchDir: dir } });
    await assert.rejects(() => byName.save_preview.handler(api, { view_id: 'RGB', label: 'final' }), /Resample failed/);
    assert.equal(presentWhenSnippetRan, false, 'the stale JPEG must be gone before the snippet runs');
    assert.equal(existsSync(stale), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save_preview hands PixInsight the preview path as toPixPath makes it: a Windows path with forward slashes, a POSIX backslash kept', async () => {
  // On Windows `a\\b` is two folders and must reach PJSR as a/b; on macOS/Linux it is one folder whose
  // name holds a backslash, and must reach PJSR unchanged (JSON-escaped in the string literal).
  const base = mkdtempSync(path.join(tmpdir(), 'pixinsight-connector-preview-'));
  const dir = `${base}${path.sep}a\\b`;
  try {
    const { ctx, emitted } = createFakeBridge({ replies: ['ok', JSON.stringify({ median: 0.2 })] });
    const api = apiFrom(ctx, { workspace: { dir, scratchDir: dir } });
    await byName.save_preview.handler(api, { view_id: 'RGB', label: 'p' });
    if (path.sep === '\\') {
      assert.ok(!emitted[0].includes('\\\\'), 'no backslash reaches PJSR');
      assert.ok(emitted[0].includes('a/b'), emitted[0]);
    } else {
      assert.ok(emitted[0].includes(JSON.stringify(path.join(dir, 'previews', 'p.jpg'))), emitted[0]);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
