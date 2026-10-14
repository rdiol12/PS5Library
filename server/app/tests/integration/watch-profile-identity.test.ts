import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { runWorker } from '../../src/library/inspect.js';

test(
  'an overlay change regenerates its exact profile and reuses the clean FPKG',
  { timeout: 60000 },
  async () => {
    const base = configuration(),
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-watch-profile-')),
      schema = 'watch_profile_' + randomUUID().replaceAll('-', ''),
      admin = database(base.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
        ...base,
        DATABASE_URL: url.href,
        DATA_DIR: path.join(root, 'data'),
        SOURCE_ROOT: path.join(root, 'sources'),
        DUMP_ROOT: path.join(root, 'dumps'),
        DISK_MARGIN_BYTES: 0,
      },
      db = database(url.href);
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const call = async (method: 'GET' | 'POST', route: string, payload: unknown, token: string) =>
      app!.inject({
        method,
        url: `/api/v1${route}`,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    try {
      await runWorker([
        'extract-archive',
        'worker/Tests/Fixtures/homebrew.part1.rar',
        config.DUMP_ROOT,
        '100000',
      ]);
      const folder = path.join(config.DUMP_ROOT, 'Example'),
        paramFile = path.join(folder, 'sce_sys', 'param.json'),
        param = JSON.parse(await readFile(paramFile, 'utf8'));
      param.titleId = 'PPSA99968';
      param.contentId = 'IV0000-PPSA99968_00-WATCHPROFILETEST';
      param.requiredSystemSoftwareVersion = '0x1200000000000000';
      await writeFile(paramFile, JSON.stringify(param));
      const supplied = path.join(folder, 'backport', 'sce_module', 'compat.prx');
      await mkdir(path.dirname(supplied), { recursive: true });
      await writeFile(supplied, 'first exact overlay');
      app = await createApp(config);
      const owner = (
        await call(
          'POST',
          '/auth/register',
          {
            username: `watch-profile-${randomUUID()}`,
            password: 'test-watch-profile-password',
            bootstrapToken: config.BOOTSTRAP_TOKEN,
          },
          '',
        )
      ).json();
      const created = await call(
        'POST',
        '/sources',
        {
          name: 'Watch profile identity',
          type: 'WATCH_FOLDER',
          location: '.',
          scanIntervalMinutes: 60,
        },
        owner.token,
      );
      assert.equal(created.statusCode, 201, created.body);
      const sourceId = created.json().id;
      await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      await db.query(
        "UPDATE source_observations SET changed_at=now()-interval '2 minutes' WHERE source_id=$1",
        [sourceId],
      );
      const indexed = await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      assert.equal(indexed.statusCode, 200, indexed.body);
      const sourceRelease = (
          await db.query('SELECT id,metadata FROM source_releases WHERE source_id=$1', [sourceId])
        ).rows[0],
        request = {
          sourceReleaseId: sourceRelease.id,
          targetFirmware: '4.51',
          runtime: 'kstuff',
          installationMethod: 'FPKG',
        };
      const legacyId = randomUUID(),
        legacyProfile = {
          id: legacyId,
          titleId: param.titleId,
          contentId: param.contentId,
          gameVersion: param.contentVersion,
          inputHashes: [sourceRelease.metadata.sourceTreeSha256],
          targetFirmware: '4.51',
          runtime: 'kstuff',
          installationMethod: 'FPKG',
          delivery: 'OVERLAY',
          testedState: 'UNTESTED',
          requiredLibraries: [],
          requiredPatches: [],
          requiredFiles: [
            {
              path: 'sce_module/compat.prx',
              sha256: createHash('sha256')
                .update(await readFile(supplied))
                .digest('hex'),
            },
          ],
        };
      await db.query(
        'INSERT INTO ' +
          'compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          legacyId,
          owner.user.id,
          param.titleId,
          param.contentId,
          param.contentVersion,
          '4.51',
          'kstuff',
          legacyProfile,
        ],
      );
      const firstProfile = await call('POST', '/profiles/generate', request, owner.token);
      assert.equal(firstProfile.statusCode, 201, firstProfile.body);
      assert.deepEqual(firstProfile.json().profile.inputHashes, [
        sourceRelease.metadata.sourceTreeSha256,
      ]);
      assert.equal(
        firstProfile.json().id,
        legacyId,
        'The exact full-tree identity reuses an existing profile without generating a duplicate',
      );
      const prepare = async (profileId: string) => {
        const queued = await call(
          'POST',
          '/preparations',
          { sourceReleaseId: sourceRelease.id, method: 'FPKG', profileId },
          owner.token,
        );
        assert.equal(queued.statusCode, 202, queued.body);
        if (queued.json().cached) return queued.json().artifactId;
        for (let i = 0; i < 400; i++) {
          const job = (
            await call('GET', `/jobs/${queued.json().id}`, undefined, owner.token)
          ).json();
          if (job.state === 'COMPLETED') return job.artifactId;
          assert.notEqual(job.state, 'ERROR', JSON.stringify(job));
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw Error('Worker did not finish');
      };
      const artifactId = await prepare(firstProfile.json().id),
        firstRequired = firstProfile.json().profile.requiredFiles[0].sha256;

      await appendFile(supplied, ' changed');
      await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      await db.query(
        "UPDATE source_observations SET changed_at=now()-interval '2 minutes' WHERE source_id=$1",
        [sourceId],
      );
      await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      const updated = (
        await db.query('SELECT metadata FROM source_releases WHERE id=$1', [sourceRelease.id])
      ).rows[0].metadata;
      assert.equal(updated.sha256, sourceRelease.metadata.sha256);
      assert.notEqual(updated.sourceTreeSha256, sourceRelease.metadata.sourceTreeSha256);
      const secondProfile = await call('POST', '/profiles/generate', request, owner.token);
      assert.equal(secondProfile.statusCode, 201, secondProfile.body);
      assert.notEqual(secondProfile.json().id, firstProfile.json().id);
      assert.notEqual(secondProfile.json().profile.requiredFiles[0].sha256, firstRequired);
      assert.equal(
        secondProfile.json().profile.requiredFiles[0].sha256,
        createHash('sha256')
          .update(await readFile(supplied))
          .digest('hex'),
      );
      assert.equal(
        await prepare(secondProfile.json().id),
        artifactId,
        'The exact overlay is rebuilt around the unchanged clean package',
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM artifacts WHERE release_id=(SELECT release_id FROM ' +
              "source_releases WHERE id=$1) AND format='pkg'",
            [sourceRelease.id],
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await app?.close();
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
