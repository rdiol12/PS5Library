import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backportState } from '../src/jobs/backport-sync.js';

test('backport folder stamp ignores timestamps and tracks the file set', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-backport-'));
  try {
    assert.equal(await backportState(path.join(root, 'missing')), null);
    await mkdir(path.join(root, 'fakelib'), { recursive: true });
    assert.equal(await backportState(root), null);
    await writeFile(path.join(root, 'eboot.bin'), 'eboot');
    await writeFile(path.join(root, 'fakelib', 'libSceAgc.sprx'), 'agc');
    const first = await backportState(root);
    assert.equal(first?.files, 2);
    assert.equal(first?.zip, null);

    await utimes(path.join(root, 'eboot.bin'), new Date(0), new Date(0));
    assert.equal((await backportState(root))?.stamp, first?.stamp);

    await writeFile(path.join(root, 'fakelib', 'libScePsml.sprx'), 'psml');
    const added = await backportState(root);
    assert.notEqual(added?.stamp, first?.stamp);

    await writeFile(path.join(root, 'update.zip'), 'zip');
    assert.equal((await backportState(root))?.zip, path.join(root, 'update.zip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
