import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { createApp } from '../../src/api/app.js';

test(
  'a successful watch scan retires missing input without deleting its artifact',
  { timeout: 30000 },
  async () => {
    const base = configuration(),
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-watch-missing-')),
      schema = 'watch_missing_' + randomUUID().replaceAll('-', ''),
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
      PACKAGE_WORKER_SOCKET: path.join(root, 'missing.sock'),
    };
    await mkdir(config.DUMP_ROOT, { recursive: true });
    const db = database(config.DATABASE_URL);
    let app = await createApp(config);
    const call = (method: 'GET' | 'POST', route: string, payload: unknown, token = '') =>
      app.inject({
        method,
        url: `/api/v1${route}`,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: `watch-missing-${randomUUID()}`,
          password: 'test-watch-missing-password',
          bootstrapToken: base.BOOTSTRAP_TOKEN,
        })
      ).json();
      const sourceResponse = await call(
        'POST',
        '/sources',
        {
          name: 'Missing watch fixture',
          type: 'WATCH_FOLDER',
          location: '.',
          scanIntervalMinutes: 60,
        },
        owner.token,
      );
      assert.equal(sourceResponse.statusCode, 201, sourceResponse.body);
      const sourceId = sourceResponse.json().id;
      const gameId = randomUUID(),
        releaseId = randomUUID(),
        sourceReleaseId = randomUUID(),
        artifactId = randomUUID(),
        sourceKey = 'missing-fixture';
      const release = {
        key: sourceKey,
        game: {
          title: 'Missing fixture',
          titleId: 'PPSA99973',
          contentId: 'IV0000-PPSA99973_00-MISSINGWATCH0001',
        },
        kind: 'BASE',
        version: '01.000.000',
        size: 1,
        format: 'pkg',
        sha256: '1'.repeat(64),
        location: 'gone.pkg',
      };
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA99973','Missing fixture',$3)",
        [gameId, owner.user.id, release.game],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-PPSA99973_00-MISSINGWATCH0001','01.000.000','BASE','{}')",
        [releaseId, gameId],
      );
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5)',
        [sourceReleaseId, sourceId, releaseId, sourceKey, release],
      );
      await db.query(
        "INSERT INTO source_observations(source_id,path,signature,state,release) VALUES($1,'gone.pkg','signature','READY',$2)",
        [sourceId, release],
      );
      const artifactRelative = `artifacts/${artifactId}.pkg`,
        artifactFile = path.join(config.DATA_DIR, artifactRelative);
      await mkdir(path.dirname(artifactFile), { recursive: true });
      await writeFile(artifactFile, 'x');
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,1,true,'{}')",
        [artifactId, releaseId, artifactRelative, release.sha256],
      );

      const scan = await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      assert.equal(scan.statusCode, 200, scan.body);
      const missing = (
        await db.query(
          'SELECT state,error FROM source_observations WHERE source_id=$1 AND path=$2',
          [sourceId, 'gone.pkg'],
        )
      ).rows[0];
      assert.deepEqual(missing, { state: 'MISSING', error: 'SOURCE_MISSING' });
      const retired = (
        await db.query('SELECT metadata FROM source_releases WHERE id=$1', [sourceReleaseId])
      ).rows[0].metadata;
      assert.ok(retired.retiredAt);
      assert.ok(retired.sourceMissingAt);
      assert.equal(retired.retirementReason, 'SOURCE_MISSING');
      assert.deepEqual(
        (await db.query('SELECT verified,deleted_at FROM artifacts WHERE id=$1', [artifactId]))
          .rows[0],
        { verified: true, deleted_at: null },
      );
      const cachedCatalog = (await call('GET', '/catalog', undefined, owner.token)).json()[0]
        .releases[0];
      assert.deepEqual(cachedCatalog.sources, []);
      assert.equal(cachedCatalog.artifacts[0].id, artifactId);
      const cached = await call('POST', '/downloads', { sourceReleaseId }, owner.token);
      assert.equal(cached.statusCode, 202, cached.body);
      assert.equal(cached.json().cached, true);
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS count FROM jobs WHERE source_release_id=$1', [
            sourceReleaseId,
          ])
        ).rows[0].count,
        0,
      );
      await rm(artifactFile);
      const unavailablePackage = await call('POST', '/downloads', { sourceReleaseId }, owner.token);
      assert.equal(unavailablePackage.statusCode, 409, unavailablePackage.body);
      assert.equal(unavailablePackage.json().error, 'SOURCE_RETIRED');
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS count FROM jobs WHERE source_release_id=$1', [
            sourceReleaseId,
          ])
        ).rows[0].count,
        0,
      );
      assert.equal(
        (await db.query('SELECT verified FROM artifacts WHERE id=$1', [artifactId])).rows[0]
          .verified,
        false,
      );
      assert.deepEqual(
        (await call('GET', '/catalog', undefined, owner.token)).json()[0].releases,
        [],
      );

      await writeFile(path.join(config.DUMP_ROOT, 'gone.pkg'), 'returned');
      const returned = await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      assert.equal(returned.statusCode, 200, returned.body);
      assert.equal(
        (
          await db.query(
            "SELECT metadata ? 'retiredAt' AS retired FROM source_releases WHERE id=$1",
            [sourceReleaseId],
          )
        ).rows[0].retired,
        true,
        'A returned path is unavailable until its contents settle and pass inspection',
      );
      const beforeUnavailable = (
        await db.query('SELECT state,error FROM source_observations WHERE source_id=$1', [sourceId])
      ).rows[0];
      assert.deepEqual(beforeUnavailable, { state: 'STABILIZING', error: null });
      await db.query(
        "UPDATE sources SET config=jsonb_set(config,'{location}','\"unavailable\"') WHERE id=$1",
        [sourceId],
      );
      const unavailable = await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      assert.ok(unavailable.statusCode >= 400, unavailable.body);
      assert.deepEqual(
        (
          await db.query('SELECT state,error FROM source_observations WHERE source_id=$1', [
            sourceId,
          ])
        ).rows[0],
        beforeUnavailable,
        'An unavailable root cannot retire observations',
      );
      assert.equal(
        (
          await db.query(
            "SELECT metadata ? 'retiredAt' AS retired FROM source_releases WHERE id=$1",
            [sourceReleaseId],
          )
        ).rows[0].retired,
        true,
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
