// Every file under test/live/ must guard itself with the PIXINSIGHT_CONNECTOR_LIVE opt-in (see
// test/live/introspect.live.test.mjs), or `node --test test/` (which recurses into test/live/)
// reddens every CI leg, since CI runners have no PixInsight installed. This test is the tripwire:
// a future live test that forgets the guard fails HERE, on every OS, loudly, rather than only
// showing up as "somehow six CI legs are red" to whoever added it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const LIVE_DIR = path.join(process.cwd(), 'test', 'live');

test('every file under test/live/ contains the PIXINSIGHT_CONNECTOR_LIVE skip guard', async () => {
  const entries = await readdir(LIVE_DIR, { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  assert.ok(files.length > 0, 'expected at least one file under test/live/ to check');
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    assert.ok(src.includes('PIXINSIGHT_CONNECTOR_LIVE'), `${path.relative(process.cwd(), file)} is missing the PIXINSIGHT_CONNECTOR_LIVE skip guard`);
  }
});
