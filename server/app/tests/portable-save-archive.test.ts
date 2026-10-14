import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePortableSaveArchive } from '../../shared/saves/portable.js';

function archive(files: Array<[string, Buffer]>) {
  const parts = [Buffer.from('PS5LSP01'), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(files.length);
  for (const [name, data] of files) {
    const encoded = Buffer.from(name),
      nameSize = Buffer.alloc(2),
      fileSize = Buffer.alloc(8);
    nameSize.writeUInt16BE(encoded.length);
    fileSize.writeBigUInt64BE(BigInt(data.length));
    parts.push(nameSize, encoded, fileSize, createHash('sha256').update(data).digest(), data);
  }
  return Buffer.concat(parts);
}
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('portable save envelope rejects traversal, corruption and trailing data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-portable-')),
    file = path.join(root, 'save.ps5save');
  try {
    const valid = archive([
      ['progress/slot.dat', Buffer.from('save data')],
      ['profile.bin', Buffer.from('profile')],
    ]);
    await writeFile(file, valid);
    assert.deepEqual(await validatePortableSaveArchive(file, valid.length, 2, sha(valid)), {
      fileCount: 2,
      contentBytes: 16,
    });
    await assert.rejects(
      validatePortableSaveArchive(file, valid.length, 2, '0'.repeat(64)),
      /PORTABLE_ARCHIVE_HASH/,
    );
    const traversal = archive([['../outside', Buffer.from('bad')]]);
    await writeFile(file, traversal);
    await assert.rejects(
      validatePortableSaveArchive(file, traversal.length, 1, sha(traversal)),
      /PORTABLE_ARCHIVE_PATH/,
    );
    const metadata = archive([['sce_sys/param.sfo', Buffer.from('account')]]);
    await writeFile(file, metadata);
    await assert.rejects(
      validatePortableSaveArchive(file, metadata.length, 1, sha(metadata)),
      /PORTABLE_ARCHIVE_PATH/,
    );
    const collision = archive([
      ['slot/data', Buffer.from('child')],
      ['slot', Buffer.from('parent')],
    ]);
    await writeFile(file, collision);
    await assert.rejects(
      validatePortableSaveArchive(file, collision.length, 2, sha(collision)),
      /PORTABLE_ARCHIVE_PATH/,
    );
    const temporary = archive([['slot.ps5library.tmp', Buffer.from('reserved')]]);
    await writeFile(file, temporary);
    await assert.rejects(
      validatePortableSaveArchive(file, temporary.length, 1, sha(temporary)),
      /PORTABLE_ARCHIVE_PATH/,
    );
    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(file, corrupt);
    await assert.rejects(
      validatePortableSaveArchive(file, corrupt.length, 2, sha(corrupt)),
      /PORTABLE_ARCHIVE_ENTRY_HASH/,
    );
    const trailing = Buffer.concat([valid, Buffer.from('x')]);
    await writeFile(file, trailing);
    await assert.rejects(
      validatePortableSaveArchive(file, trailing.length, 2, sha(trailing)),
      /PORTABLE_ARCHIVE_TRAILING_DATA/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
