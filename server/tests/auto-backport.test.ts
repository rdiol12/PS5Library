import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../src/config.js';
import { runtimeSettingsPatch, runtimeSettingDefinitions } from '../src/runtime-settings.js';
import { adoptCreatedBackport } from '../src/jobs/preparation.js';
import { validWorkerProgress } from '../src/worker-progress.js';

test('experimental backport creation is an explicit hot-reload setting', () => {
  const config = configuration({
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost',
    BOOTSTRAP_TOKEN: 'a'.repeat(32),
  });
  assert.equal(config.AUTO_CREATE_BACKPORT, false);
  assert.deepEqual(runtimeSettingsPatch.parse({ autoCreateBackport: true }), {
    autoCreateBackport: true,
  });
  const definition = runtimeSettingDefinitions(config, {} as any).find(
    (x) => x.key === 'autoCreateBackport',
  );
  assert.equal(definition?.writable, true);
  assert.match(definition?.label ?? '', /Experimental/);
});

test('creator status is valid progress and unknown status is rejected', () => {
  const event = {
    stage: 'Creating backport (Experimental)',
    completedStages: 1,
    totalStages: 7,
    backportCreation: { state: 'CREATING', experimental: true },
  };
  assert.equal(validWorkerProgress(event), true);
  assert.equal(
    validWorkerProgress({ ...event, backportCreation: { state: 'guessed', experimental: true } }),
    false,
  );
});

test('created profile is bound to the build and persisted before packaging', async () => {
  const profile = {
    id: '11111111-1111-4111-8111-111111111111',
    titleId: 'PPSA12345',
    contentId: 'EP0000-PPSA12345_00-ABCDEFGHIJKLMNOP',
    gameVersion: '01.000.000',
    inputHashes: ['a'.repeat(64), 'b'.repeat(64)],
    targetFirmware: '4.50',
    runtime: 'ShadowMountPlus',
    installationMethod: 'FPKG',
    testedState: 'UNTESTED',
    delivery: 'OVERLAY',
    requiredLibraries: [],
    requiredPatches: [],
    requiredFiles: [{ path: 'sce_sys/param.json', sha256: 'c'.repeat(64) }],
  };
  const row: any = {
    id: 'job',
    user_id: 'owner',
    title_id: profile.titleId,
    content_id: profile.contentId,
    version: profile.gameVersion,
    config: { method: 'FPKG', sourceMetadata: { format: 'folder', sha256: 'b'.repeat(64) } },
  };
  const calls: string[] = [];
  const db: any = {
    connect: async () => ({
      query: async (text: string) => {
        calls.push(text);
        return { rowCount: 1, rows: [] };
      },
      release() {},
    }),
  };
  await adoptCreatedBackport(db, row, profile);
  assert.equal(row.config.profile.id, profile.id);
  assert.equal(row.config.sourceMetadata.sourceTreeSha256, 'a'.repeat(64));
  assert.ok(calls.some((x) => x.includes('INSERT INTO compatibility_profiles')));
  assert.ok(calls.some((x) => x.includes('UPDATE jobs')));
  await assert.rejects(
    adoptCreatedBackport(db, row, { ...profile, titleId: 'PPSA99999' }),
    /PROFILE_MISMATCH/,
  );
  await assert.rejects(
    adoptCreatedBackport(db, row, { ...profile, inputHashes: ['d'.repeat(64)] }),
    /PROFILE_MISMATCH/,
  );
});
