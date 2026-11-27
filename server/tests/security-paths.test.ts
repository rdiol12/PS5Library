import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileWithin, regularFileWithin } from '../src/security/paths.js';

test('contained file reads remain bound to the opened file after an ancestor junction swap', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ps5library-contained-file-'));
  const root = path.join(base, 'root'),
    live = path.join(root, 'live'),
    parked = path.join(root, 'parked'),
    outside = path.join(base, 'outside');
  await Promise.all([mkdir(live, { recursive: true }), mkdir(outside)]);
  await Promise.all([
    writeFile(path.join(live, 'value.txt'), 'inside'),
    writeFile(path.join(outside, 'value.txt'), 'outside'),
  ]);
  const checked = await regularFileWithin(root, path.join(live, 'value.txt'), 'r');
  let closed = false;
  try {
    try {
      await rename(live, parked);
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
        throw error;
      assert.equal(await checked.handle.readFile('utf8'), 'inside');
      await checked.handle.close();
      closed = true;
      await rename(live, parked);
    }
    await symlink(outside, live, process.platform === 'win32' ? 'junction' : 'dir');
    if (!closed) assert.equal(await checked.handle.readFile('utf8'), 'inside');
    await assert.rejects(readFileWithin(root, path.join(live, 'value.txt'), 'utf8'), /UNSAFE_PATH/);
  } finally {
    if (!closed) await checked.handle.close();
    await rm(base, { recursive: true, force: true });
  }
});
