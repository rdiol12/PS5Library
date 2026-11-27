import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cheatProfileImport,
  cheatProfileMatches,
  decodeCheatProfile,
  validateJsonCheatProfile,
} from '../src/cheats/profiles.js';
import { cheatDeliveryFileName, verifiedCheatDeliveryTarget } from '../src/cheats/deliveries.js';

test('cheat profiles are byte-hashed and match only their exact constrained target', () => {
  const payload = Buffer.from(
    JSON.stringify({
      name: 'Fixture',
      id: 'PPSA01628',
      version: '1.026.000',
      process: 'eboot.bin',
      mods: [
        {
          name: 'Infinite health',
          type: 'checkbox',
          memory: [{ offset: '615c17', on: '9090', off: 'c4c1' }],
        },
      ],
    }),
  );
  const imported = cheatProfileImport.parse({
    titleId: 'PPSA01628',
    gameVersion: '1.026.000',
    process: 'eboot.bin',
    contentId: 'UP0001-PPSA01628_00-EXAMPLE000000000',
    targetExecutableSha256: 'a'.repeat(64),
    format: 'JSON',
    profileBase64: payload.toString('base64'),
    provenance: {
      sourceType: 'UPSTREAM_SNAPSHOT',
      sourceName: 'etaHEN/PS5_Cheats',
      sourceFile: 'json/PPSA01628_1.026.000.json',
      sourceCommit: 'ef295511ea4252474b16325618ffaafd3afb3cbb',
    },
  });
  const decoded = decodeCheatProfile(imported);
  validateJsonCheatProfile(decoded.body, imported);
  const stored = { ...imported, profileSha256: decoded.sha256 };
  assert.equal(
    cheatProfileMatches(stored, {
      titleId: 'PPSA01628',
      gameVersion: '1.026.000',
      process: 'eboot.bin',
      contentId: stored.contentId,
      targetExecutableSha256: stored.targetExecutableSha256,
    }),
    true,
  );
  assert.equal(
    cheatProfileMatches(stored, {
      titleId: 'PPSA01628',
      gameVersion: '1.026.000',
      process: 'eboot.bin',
    }),
    false,
  );
  assert.equal(
    cheatProfileMatches(stored, {
      titleId: 'PPSA01628',
      gameVersion: '1.026.000',
      process: 'eboot.bin',
      contentId: stored.contentId,
      targetExecutableSha256: 'b'.repeat(64),
    }),
    false,
  );
  assert.equal(
    cheatProfileMatches(stored, {
      titleId: 'PPSA01628',
      gameVersion: '1.026.001',
      process: 'eboot.bin',
      contentId: stored.contentId,
      targetExecutableSha256: stored.targetExecutableSha256,
    }),
    false,
  );
  assert.throws(() => decodeCheatProfile({ ...imported, profileBase64: '%%%=' }));
  assert.throws(
    () => decodeCheatProfile({ ...imported, profileSha256: 'b'.repeat(64) }),
    (error: any) => error?.code === 'PROFILE_HASH_MISMATCH',
  );
  assert.throws(() =>
    validateJsonCheatProfile(
      Buffer.from(
        JSON.stringify({
          name: 'Fixture',
          id: 'PPSA01628',
          version: '1.026.000',
          process: 'eboot.bin',
          mods: [
            {
              name: 'Overlap',
              type: 'checkbox',
              memory: [
                { offset: '10', on: '9090', off: 'cccc' },
                { offset: '11', on: '90', off: 'cc' },
              ],
            },
          ],
        }),
      ),
      imported,
    ),
  );
  assert.throws(
    () =>
      validateJsonCheatProfile(
        Buffer.from(
          JSON.stringify({
            name: 'Fixture',
            id: 'PPSA01628',
            version: '1.026.001',
            process: 'eboot.bin',
            mods: [
              {
                name: 'Infinite health',
                type: 'checkbox',
                memory: [{ offset: '1', on: '90', off: 'cc' }],
              },
            ],
          }),
        ),
        imported,
      ),
    (error: any) => error?.code === 'METADATA_MISMATCH',
  );
  assert.throws(() =>
    validateJsonCheatProfile(
      Buffer.from(
        JSON.stringify({
          name: 'Fixture',
          id: 'PPSA01628',
          version: '1.026.000',
          process: 'eboot.bin',
          mods: [
            {
              name: 'Unsafe absolute write',
              type: 'checkbox',
              memory: [{ offset: '1', on: '90', off: 'cc', absolute: true }],
            },
          ],
        }),
      ),
      imported,
    ),
  );
  assert.equal(
    cheatDeliveryFileName('PPSA01628', '1.026.000', 'eboot.bin'),
    'PPSA01628_1.026.000_eboot.bin.json',
  );
  assert.equal(
    verifiedCheatDeliveryTarget({
      title_id: 'PPSA01628',
      game_version: '1.026.000',
      process_name: 'eboot.bin',
      target_executable_sha256: 'a'.repeat(64),
    }),
    'PPSA01628_1.026.000_eboot.bin.json',
  );
  assert.throws(
    () =>
      verifiedCheatDeliveryTarget({
        title_id: 'PPSA01628',
        game_version: '1.026.000',
        process_name: 'eboot.bin',
      }),
    (error: any) => error?.code === 'CHEAT_TARGET_HASH_REQUIRED',
  );
  assert.throws(() => cheatDeliveryFileName('PPSA01628', '1.026.000', '../eboot.bin'));
});
