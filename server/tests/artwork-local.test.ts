import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fetchArtwork, optimizeArtwork } from '../src/artwork/cache.js';
import type { Config } from '../src/config.js';

test('large local PNG artwork reaches the existing bounded optimizer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-artwork-'));
  try {
    const input = await sharp(randomBytes(2048 * 1720 * 4), {
      raw: { width: 2048, height: 1720, channels: 4 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(input.length > 12 * 1024 ** 2 && input.length < 16 * 1024 ** 2);
    const file = path.join(root, 'pic0.png');
    await writeFile(file, input);
    const received = await fetchArtwork({} as Config, file, root);
    assert.deepEqual(received, input);
    const result = await optimizeArtwork(received, 'hero');
    assert.ok(result.info.width <= 1600 && result.info.height <= 900);
    await writeFile(file, Buffer.alloc(16 * 1024 ** 2 + 1));
    await assert.rejects(fetchArtwork({} as Config, file, root), { code: 'ARTWORK_TOO_LARGE' });
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'ps5library-artwork-')));
    await rm(root, { recursive: true, force: true });
  }
});
