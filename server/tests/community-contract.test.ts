import test from 'node:test';
import assert from 'node:assert/strict';
import { communitySaveManifestSchema } from '../../shared/schemas/community.js';
import { approvedMasterCredential, masterRequest } from '../src/community/routes.js';
import { seal, unseal } from '../src/auth/credentials.js';

const manifest = {
  schemaVersion: 1 as const,
  platform: 'PS5' as const,
  gameTitleId: 'PPSA12345',
  saveTitleId: 'PPSA12345',
  directory: 'autosave',
  gameVersion: '01.020',
  archiveSha256: 'a'.repeat(64),
  archiveSize: 4096,
  fileCount: 12,
  exportedAt: '2026-09-20T10:00:00.000Z',
  source: { firmware: '4.51', runtime: 'etaHEN', exporterVersion: '0.1.0' },
  portability: {
    format: 'PORTABLE_FILES' as const,
    platformMetadataExcluded: true as const,
    embeddedAccountIdentifiersRemoved: false as const,
    encryptionKeysIncluded: false as const,
  },
  compatibility: { mode: 'EXACT_GAME_VERSION' as const, gameVersion: '01.020' },
};

test('the public Community contract accepts only sanitized exact-version save payloads', () => {
  assert.equal(communitySaveManifestSchema.parse(manifest).gameVersion, '01.020');
  assert.throws(() =>
    communitySaveManifestSchema.parse({
      ...manifest,
      compatibility: { ...manifest.compatibility, gameVersion: '01.021' },
    }),
  );
  assert.throws(() =>
    communitySaveManifestSchema.parse({
      ...manifest,
      portability: { ...manifest.portability, embeddedAccountIdentifiersRemoved: true },
    }),
  );
  assert.throws(() =>
    communitySaveManifestSchema.parse({
      ...manifest,
      packageUrl: 'https://example.invalid/game.pkg',
    }),
  );
});

test('a stored Node credential never crosses to a newly configured Master origin', async () => {
  const bootstrap = 'b'.repeat(64),
    credential = 'c'.repeat(64),
    db = {
      query: async () => ({
        rows: [
          {
            credential_cipher: seal(credential, bootstrap),
            state: 'APPROVED',
            master_url: 'https://old-master.example',
          },
        ],
      }),
    } as any;
  await assert.rejects(
    approvedMasterCredential(db, {
      BOOTSTRAP_TOKEN: bootstrap,
      COMMUNITY_MASTER_URL: 'https://new-master.example',
    } as any),
    (error: any) => error?.code === 'COMMUNITY_MASTER_CHANGED',
  );
});

test('sealed credentials are bound to their purpose', () => {
  const key = 'b'.repeat(64),
    cipher = (seal as any)('node-secret', key, 'community-node:https://master.example');
  assert.equal(
    (unseal as any)(cipher, key, 'community-node:https://master.example'),
    'node-secret',
  );
  assert.throws(() => (unseal as any)(cipher, key, 'pairing:123'));
  assert.throws(() => (unseal as any)(cipher, key));
});

test('Master requests reject foreign routes and untrusted error codes', async () => {
  const config = { COMMUNITY_MASTER_URL: 'https://master.example' } as any;
  let calls = 0;
  await assert.rejects(
    masterRequest(
      config,
      'https://attacker.invalid/steal',
      { token: 'c'.repeat(64) },
      (async () => {
        calls++;
        throw new Error('called');
      }) as any,
    ),
    (error: any) => error?.code === 'INVALID_MASTER_ROUTE',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    masterRequest(
      config,
      '/api/v1/test',
      {},
      (async () =>
        new Response(JSON.stringify({ error: 'c'.repeat(64) }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as any,
    ),
    (error: any) => error?.code === 'MASTER_REQUEST_FAILED',
  );
});
