import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pruneSupersededNativeUpdateAssets } from '../../scripts/native-update-retention.mjs';

test('native update retention removes only superseded assets for the published title', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-native-retention-')),
    title = path.join(root, 'PPSA99051'),
    other = path.join(root, 'PPSA99783');
  const current = [
    `${'a'.repeat(64)}.pkg`,
    `${'b'.repeat(64)}.delta.pkg`,
    `${'c'.repeat(64)}.crc`,
    `PS5Library [PPSA99051] - Full Update - ${'a'.repeat(12)}.pkg`,
  ];
  const superseded = [
    `${'d'.repeat(64)}.pkg`,
    `${'e'.repeat(64)}.delta.pkg`,
    `${'f'.repeat(64)}.crc`,
    `PS5Library [PPSA99051] - Delta Update - ${'d'.repeat(12)}.pkg`,
  ];
  try {
    await mkdir(path.join(title, 'releases'), { recursive: true });
    await mkdir(other, { recursive: true });
    await Promise.all(
      [...current, ...superseded, 'latest.json', 'manual.pkg'].map((name) =>
        writeFile(path.join(title, name), name),
      ),
    );
    await writeFile(path.join(other, superseded[0]!), 'other title');

    await pruneSupersededNativeUpdateAssets(title, current);

    assert.deepEqual(
      (await readdir(title)).sort(),
      [...current, 'latest.json', 'manual.pkg', 'releases'].sort(),
    );
    assert.deepEqual(await readdir(other), [superseded[0]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
