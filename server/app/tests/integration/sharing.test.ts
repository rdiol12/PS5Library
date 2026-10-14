import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { createApp } from '../../src/api/app.js';
import { database } from '../../src/db.js';
import { accessibleSource } from '../../src/sources/access.js';

test(
  'revoking a game share denies content despite a stale recipient console entry',
  { timeout: 60_000 },
  async () => {
    const base = configuration(),
      adminDb = database(base.DATABASE_URL),
      schema = `sharing_${randomUUID().replaceAll('-', '')}`,
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-sharing-'));
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
        ...base,
        DATABASE_URL: url.href,
        DATA_DIR: root,
        SOURCE_ROOT: path.join(root, 'sources'),
        DUMP_ROOT: '',
      },
      app = await createApp(config),
      db = database(config.DATABASE_URL);
    const call = (
      method: 'GET' | 'POST' | 'PUT',
      route: string,
      payload?: unknown,
      token?: string,
    ) =>
      app.inject({
        method,
        url: '/api/v1' + route,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: 'owner',
          password: 'test-owner-password',
          bootstrapToken: base.BOOTSTRAP_TOKEN,
        })
      ).json();
      const invite1 = (await call('POST', '/admin/invites', undefined, owner.token)).json();
      const member1 = (
        await call('POST', '/auth/register', {
          username: 'family-one',
          password: 'test-family-password-one',
          inviteToken: invite1.token,
        })
      ).json();
      const invite2 = (await call('POST', '/admin/invites', undefined, owner.token)).json();
      const member2 = (
        await call('POST', '/auth/register', {
          username: 'family-two',
          password: 'test-family-password-two',
          inviteToken: invite2.token,
        })
      ).json();
      const game = randomUUID(),
        release = randomUUID(),
        source = randomUUID(),
        sourceRelease = randomUUID(),
        artifact = randomUUID(),
        transfer = randomUUID();
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata,shared) VALUES($1,$2,'BREW00001','Private title','{}',false)",
        [game, owner.user.id],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-BREW00001_00-PS5LIBRARYTEST0','01.00','BASE','{}')",
        [release, game],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Private source','LOCAL_FOLDER','{}')",
        [source, owner.user.id],
      );
      await db.query(
        "INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,'private-title',$4)",
        [
          sourceRelease,
          source,
          release,
          {
            key: 'private-title',
            game: {
              title: 'Private title',
              titleId: 'BREW00001',
              contentId: 'IV0000-BREW00001_00-PS5LIBRARYTEST0',
            },
            version: '01.00',
            kind: 'BASE',
            size: 1,
            format: 'folder',
            sha256: 'a'.repeat(64),
            sourceTreeSha256: 'b'.repeat(64),
            sourceTreeSize: 1,
            location: 'private-title',
          },
        ],
      );
      await mkdir(path.join(root, 'artifacts'));
      await writeFile(path.join(root, 'artifacts', 'shared.pkg'), 'x');
      await db.query(
        'INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) ' +
          "VALUES($1,$2,'pkg','artifacts/shared.pkg',$3,1,true,'{}')",
        [artifact, release, 'a'.repeat(64)],
      );

      assert.deepEqual((await call('GET', '/catalog', undefined, member1.token)).json(), []);
      const candidates = await call('GET', `/games/${game}/shares`, undefined, owner.token);
      assert.equal(candidates.statusCode, 200, candidates.body);
      assert.deepEqual(
        candidates.json().users.map((user: any) => [user.username, user.granted]),
        [
          ['family-one', false],
          ['family-two', false],
        ],
      );
      assert.equal(
        (await call('GET', `/games/${game}/shares`, undefined, member1.token)).statusCode,
        404,
      );

      const granted = await call(
        'PUT',
        `/games/${game}/shares`,
        { userIds: [member1.user.id] },
        owner.token,
      );
      assert.equal(granted.statusCode, 200, granted.body);
      const sharedCatalog = (await call('GET', '/catalog', undefined, member1.token)).json();
      assert.equal(sharedCatalog[0].id, game);
      assert.equal(sharedCatalog[0].releases[0].sources[0].id, sourceRelease);
      assert.equal((await accessibleSource(db, member1.user.id, sourceRelease)).id, sourceRelease);
      const pairing = (
        await call('POST', '/pairings', {
          deviceId: randomUUID(),
          name: 'Family PS5',
          clientKind: 'SIMULATOR',
        })
      ).json();
      assert.equal(
        (await call('POST', '/pairings/claim', { code: pairing.code }, member1.token)).statusCode,
        200,
      );
      const device = (
        await call('POST', `/pairings/${pairing.id}/poll`, { pollSecret: pairing.pollSecret })
      ).json();
      await db.query(
        "INSERT INTO console_library_entries(console_id,release_id,storage_id,state) VALUES($1,$2,'missing','MISSING')",
        [device.consoleId, release],
      );
      await db.query(
        'INSERT INTO jobs(id,user_id,kind,release_id,artifact_id,console_id,state,total_bytes) ' +
          "VALUES($1,$2,'TRANSFER',$3,$4,$5,'TRANSFERRING',1)",
        [transfer, member1.user.id, release, artifact, device.consoleId],
      );
      const deniedBuild = await call(
        'POST',
        '/preparations',
        { sourceReleaseId: sourceRelease, method: 'FPKG' },
        member1.token,
      );
      assert.equal(deniedBuild.statusCode, 403, deniedBuild.body);
      assert.equal(deniedBuild.json().error, 'ADMIN_REQUIRED');
      assert.equal(
        (
          await db.query("SELECT count(*)::int AS n FROM jobs WHERE user_id=$1 AND kind='BUILD'", [
            member1.user.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.deepEqual((await call('GET', '/catalog', undefined, member2.token)).json(), []);

      assert.equal(
        (await call('PUT', `/games/${game}/shares`, { userIds: [randomUUID()] }, owner.token))
          .statusCode,
        400,
      );
      assert.equal(
        (await call('PUT', `/games/${game}/shares`, { userIds: [] }, owner.token)).statusCode,
        200,
      );
      assert.equal(
        (await call('GET', '/catalog', undefined, member1.token)).json()[0].id,
        game,
        'The stale console row may retain catalog visibility',
      );
      await assert.rejects(
        () => accessibleSource(db, member1.user.id, sourceRelease),
        (error: any) => error.statusCode === 404,
      );
      assert.equal(
        (await call('POST', '/downloads', { sourceReleaseId: sourceRelease }, member1.token))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await call(
            'POST',
            '/transfers/plan',
            { releaseId: release, consoleId: device.consoleId },
            member1.token,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await call('GET', `/device/artifacts/${artifact}`, undefined, device.credential))
          .statusCode,
        404,
      );
    } finally {
      await app.close();
      await db.end();
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminDb.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'catalog only lists releases available from a source, server output, or the user console',
  { timeout: 60_000 },
  async () => {
    const base = configuration(),
      adminDb = database(base.DATABASE_URL),
      schema = `catalog_${randomUUID().replaceAll('-', '')}`,
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-catalog-'));
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
        ...base,
        DATABASE_URL: url.href,
        DATA_DIR: root,
        SOURCE_ROOT: path.join(root, 'sources'),
        DUMP_ROOT: '',
      },
      app = await createApp(config),
      db = database(config.DATABASE_URL);
    const call = (method: 'GET' | 'POST', route: string, payload?: unknown, token?: string) =>
      app.inject({
        method,
        url: '/api/v1' + route,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: 'catalog-owner',
          password: 'test-catalog-owner-password',
          bootstrapToken: base.BOOTSTRAP_TOKEN,
        })
      ).json();
      const game = randomUUID(),
        source = randomUUID(),
        active = randomUUID(),
        retired = randomUUID(),
        cached = randomUUID(),
        backport = randomUUID(),
        installed = randomUUID(),
        orphan = randomUUID();
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'BREW00002','Catalog title','{}')",
        [game, owner.user.id],
      );
      for (const [id, version] of [
        [active, '01.00'],
        [retired, '02.00'],
        [cached, '03.00'],
        [backport, '04.00'],
        [installed, '05.00'],
        [orphan, '06.00'],
      ])
        await db.query(
          'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
            "VALUES($1,$2,'IV0000-BREW00002_00-PS5LIBRARYTEST0',$3,'BASE','{}')",
          [id, game, version],
        );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Catalog source','STATIC_MANIFEST','{}')",
        [source, owner.user.id],
      );
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) ' +
          "VALUES($1,$2,$3,'active','{}')," +
          '($4,$2,$5,\'retired\',\'{"retiredAt":"2026-10-07T00:00:00Z"}\'),' +
          '($6,$2,$7,\'retired-cached\',\'{"retiredAt":"2026-10-07T00:00:00Z"}\')',
        [randomUUID(), source, active, randomUUID(), retired, randomUUID(), cached],
      );
      await db.query(
        'INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) ' +
          "VALUES($1,$2,'pkg','artifacts/catalog.pkg',$3,1,true,'{}')",
        [randomUUID(), cached, 'a'.repeat(64)],
      );
      await db.query(
        'INSERT INTO ' +
          'backport_artifacts(id,game_id,release_id,title_id,game_version,type,source,sha256,size,input_hash,relative_path) ' +
          "VALUES($1,$2,$3,'BREW00002','04.00','SHADOWMOUNT_FOLDER','DUMP',$4,1,$5,'backports/catalog')",
        [randomUUID(), game, backport, 'b'.repeat(64), 'c'.repeat(64)],
      );
      const consoleId = randomUUID();
      await db.query(
        "INSERT INTO consoles(id,device_id,user_id,name,client_kind) VALUES($1,$2,$3,'Catalog PS5','PS5')",
        [consoleId, randomUUID(), owner.user.id],
      );
      await db.query(
        "INSERT INTO console_library_entries(console_id,release_id,storage_id,state) VALUES($1,$2,'internal','READY_ON_PS5')",
        [consoleId, installed],
      );

      const releases = (await call('GET', '/catalog', undefined, owner.token)).json()[0].releases;
      assert.deepEqual(
        releases.map((release: any) => release.id).sort(),
        [active, backport, cached, installed].sort(),
      );
      assert.deepEqual(releases.find((release: any) => release.id === cached).sources, []);
    } finally {
      await app.close();
      await db.end();
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminDb.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
