import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatSchema } from '../../shared/schemas/index.js';

test('heartbeat preserves verified native move capability and accepts installed PS5 titles', () => {
  const parsed = heartbeatSchema.parse({
    firmware: '4.50',
    runtime: 'kstuff-lite',
    clientVersion: 'test',
    agentVersion: 'test',
    libraryRevision: 1,
    capabilities: { gameMove: true },
    storage: [
      {
        storageId: 'ext0',
        displayName: 'USB Extended Storage',
        path: '/mnt/ext0',
        totalBytes: 1000,
        freeBytes: 500,
        writable: true,
        installMethodsSupported: [],
        nativeMoveStorageType: 1,
      },
    ],
    inventory: [
      {
        titleId: 'PPSA99991',
        contentId: 'IV0000-PPSA99991_00-PS5LIBRARYTEST01',
        version: '01.00',
        title: 'Test',
        storageId: 'ext0',
        relativePath: 'app/PPSA99991',
        sha256: null,
        size: 13,
        available: true,
        registered: true,
        source: 'INSTALLED_TITLE',
        platform: 'PS5',
      },
    ],
    inventoryComplete: true,
  });
  assert.equal(parsed.capabilities.gameMove, true);
  assert.equal(parsed.storage[0].nativeMoveStorageType, 1);
  assert.equal(parsed.inventory?.[0].platform, 'PS5');
});
