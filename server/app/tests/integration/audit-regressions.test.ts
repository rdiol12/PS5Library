import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { hash } from '../../src/auth/credentials.js';
import { catalogFor } from '../../src/catalog/routes.js';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';

// Keep the pre-optimization implementation in the regression test so the
// production TypeScript, rather than stand-alone SQL, is compared end to end.
const legacyCatalogFor = async (db: ReturnType<typeof database>, userId: string, query = '') => {
  const games = (
    await db.query(
      'SELECT g.*,EXISTS(SELECT 1 FROM saved_games s WHERE s.user_id=$1 AND s.game_id=g.id) AS ' +
        'saved FROM games g WHERE EXISTS(SELECT 1 FROM game_read_access access WHERE ' +
        'access.game_id=g.id AND access.user_id=$1) AND (title ILIKE $2 OR title_id ILIKE $2) ORDER ' +
        'BY title LIMIT 500',
      [userId, `%${query}%`],
    )
  ).rows;
  const trailers = (
    await db.query(
      'SELECT t.* FROM game_media t JOIN games g ON g.id=t.game_id WHERE EXISTS(SELECT 1 FROM ' +
        'game_read_access access WHERE access.game_id=g.id AND access.user_id=$1)',
      [userId],
    )
  ).rows;
  const artwork = (
    await db.query(
      'SELECT a.game_id,a.kind,a.sha256 FROM artwork a JOIN game_read_access access ON access.game_id=a.game_id WHERE access.user_id=$1',
      [userId],
    )
  ).rows;
  const releases = (
    await db.query(
      `SELECT r.*,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', sr.id,
            'name', s.name,
            'format', sr.metadata->>'format',
            'size', sr.metadata->'size'
          ))
          FROM source_releases sr
          JOIN sources s ON s.id=sr.source_id
          WHERE sr.release_id=r.id AND NOT (sr.metadata ? 'retiredAt')
        ), '[]') AS sources,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', a.id,
            'format', a.format,
            'size', a.size,
            'sha256', a.sha256
          ))
          FROM artifacts a
          WHERE a.release_id=r.id AND a.verified AND a.deleted_at IS NULL
        ), '[]') AS artifacts,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', b.id,
            'type', b.type,
            'size', b.size,
            'sha256', b.sha256,
            'inputHash', b.input_hash,
            'targetFirmware', b.target_firmware,
            'profileId', b.profile_id,
            'tested', b.tested
          ))
          FROM backport_artifacts b
          WHERE b.release_id=r.id AND b.deleted_at IS NULL
        ), '[]') AS backports
      FROM game_releases r
      JOIN games g ON g.id=r.game_id
      WHERE EXISTS(
        SELECT 1
        FROM game_read_access access
        WHERE access.game_id=g.id AND access.user_id=$1
      )
      AND (
        EXISTS(
          SELECT 1
          FROM source_releases sr
          WHERE sr.release_id=r.id AND NOT (sr.metadata ? 'retiredAt')
        )
        OR EXISTS(
          SELECT 1
          FROM artifacts a
          WHERE a.release_id=r.id AND a.verified AND a.deleted_at IS NULL
        )
        OR EXISTS(
          SELECT 1
          FROM backport_artifacts b
          WHERE b.release_id=r.id AND b.deleted_at IS NULL
        )
        OR EXISTS(
          SELECT 1
          FROM console_library_entries l
          JOIN consoles c ON c.id=l.console_id
          WHERE l.release_id=r.id
            AND l.state='READY_ON_PS5'
            AND c.user_id=$1
        )
      )`,
      [userId],
    )
  ).rows;
  const hashes = new Map(artwork.map((a) => [`${a.game_id}:${a.kind}`, a.sha256]));
  const image = (id: string, kind: string) =>
    `/api/v1/artwork/${id}/${kind}?v=${hashes.get(`${id}:${kind}`) ?? 'missing'}`;
  return games.map((g) => ({
    ...g.metadata,
    artwork: undefined,
    id: g.id,
    title: g.title,
    titleId: g.title_id,
    saved: g.saved,
    shared: g.shared,
    canManage: g.user_id === userId,
    addedAt: g.created_at,
    recentlyUpdated: releases.some(
      (r) =>
        r.game_id === g.id &&
        (r.kind === 'UPDATE' ||
          (r.kind === 'BASE' &&
            new Date(r.created_at).getTime() > new Date(g.created_at).getTime() + 1000)),
    ),
    trailerState: trailers.find((t) => t.game_id === g.id && t.kind === 'trailer')?.state ?? null,
    trailer:
      trailers
        .filter((t) => t.game_id === g.id && t.kind === 'trailer' && t.state === 'READY')
        .map((t) => ({
          url: `/api/v1/trailers/${g.id}`,
          sha256: t.sha256,
          size: t.size,
          duration: t.duration,
        }))[0] ?? null,
    musicState: trailers.find((t) => t.game_id === g.id && t.kind === 'music')?.state ?? null,
    music:
      trailers
        .filter((t) => t.game_id === g.id && t.kind === 'music' && t.state === 'READY')
        .map((t) => ({
          url: `/api/v1/music/${g.id}`,
          sha256: t.sha256,
          size: t.size,
          duration: t.duration,
        }))[0] ?? null,
    coverUrl: image(g.id, 'cover'),
    heroUrl: image(g.id, 'hero'),
    iconUrl: image(g.id, 'icon'),
    screenshotUrls: (g.metadata.artwork?.screenshots ?? []).map((_: unknown, i: number) =>
      image(g.id, `screenshot-${i}`),
    ),
    releases: releases
      .filter((r) => r.game_id === g.id)
      .sort(
        (a, b) =>
          ['BASE', 'UPDATE', 'DLC'].indexOf(a.kind) - ['BASE', 'UPDATE', 'DLC'].indexOf(b.kind) ||
          b.version.localeCompare(a.version) ||
          String(a.metadata.title ?? '').localeCompare(String(b.metadata.title ?? '')),
      )
      .map((r) => ({
        ...r.metadata,
        id: r.id,
        contentId: r.content_id,
        version: r.version,
        kind: r.kind,
        sources: r.sources,
        artifacts: r.artifacts,
        backports: r.backports,
      })),
  }));
};

const canonicalCatalog = (catalog: any[]) =>
  catalog.map((game) => ({
    ...game,
    releases: game.releases.map((release: any) => ({
      ...release,
      sources: [...release.sources].sort((a, b) => a.id.localeCompare(b.id)),
      artifacts: [...release.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
      backports: [...release.backports].sort((a, b) => a.id.localeCompare(b.id)),
    })),
  }));

test(
  'a size-mismatched cached artifact is invalidated even though the request is rejected',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-cache-corrupt-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `cache_corrupt_${randomUUID().replaceAll('-', '')}`,
      url = new URL(base.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
      OPERATOR_URL: '',
      OPERATOR_TOKEN: '',
    };
    await mkdir(config.SOURCE_ROOT, { recursive: true });
    const app = await createApp(config),
      db = database(config.DATABASE_URL);
    try {
      const userId = randomUUID(),
        gameId = randomUUID(),
        releaseId = randomUUID(),
        sourceId = randomUUID(),
        sourceReleaseId = randomUUID(),
        artifactId = randomUUID(),
        token = randomBytes(32).toString('hex'),
        relativePath = 'artifacts/corrupt.pkg';
      await mkdir(path.join(root, 'artifacts'));
      await writeFile(path.join(root, relativePath), Buffer.alloc(3));
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'test','ADMIN')",
        [userId, `cache-${randomUUID()}`],
      );
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hash(token), userId],
      );
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA90001','Corrupt cache','{}')",
        [gameId, userId],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-PPSA90001_00-CORRUPTCACHETEST','01.00','BASE','{}')",
        [releaseId, gameId],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Cache source','REMOTE_HTTP','{}')",
        [sourceId, userId],
      );
      await db.query(
        "INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,'cache',$4)",
        [
          sourceReleaseId,
          sourceId,
          releaseId,
          {
            format: 'pkg',
            sha256: 'a'.repeat(64),
            size: 10,
            location: 'https://example.com/game.pkg',
          },
        ],
      );
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,10,true,'{}')",
        [artifactId, releaseId, relativePath, 'a'.repeat(64)],
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/downloads',
        headers: { authorization: `Bearer ${token}` },
        payload: { sourceReleaseId },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'CACHE_CORRUPT');
      assert.equal(
        (await db.query('SELECT verified FROM artifacts WHERE id=$1', [artifactId])).rows[0]
          .verified,
        false,
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'page-scoped catalog queries preserve release filters and recheck access',
  { timeout: 30000 },
  async () => {
    const base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `catalog_page_${randomUUID().replaceAll('-', '')}`,
      url = new URL(base.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const db = database(url.href);
    try {
      await migrate(db);
      const owner = randomUUID(),
        member = randomUUID(),
        source = randomUUID();
      await db.query(
        "INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test'),($3,$4,'test')",
        [owner, `owner-${randomUUID()}`, member, `member-${randomUUID()}`],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Catalog source','REMOTE_HTTP','{}')",
        [source, owner],
      );
      const fixtures = [
        { title: 'Active', titleId: 'PPSA91001', kind: 'BASE', source: { format: 'pkg', size: 1 } },
        {
          title: 'Retired',
          titleId: 'PPSA91002',
          kind: 'BASE',
          source: { format: 'pkg', size: 2, retiredAt: '2026-01-01' },
        },
        { title: 'Unverified', titleId: 'PPSA91003', kind: 'BASE' },
        { title: 'DLC', titleId: 'PPSA91004', kind: 'DLC', source: { format: 'pkg', size: 4 } },
        { title: 'No release', titleId: 'PPSA91005' },
        { title: 'Ready only', titleId: 'PPSA91006', kind: 'BASE' },
      ] as const;
      const ids = new Map<string, { game: string; release?: string }>();
      for (const fixture of fixtures) {
        const game = randomUUID(),
          release = fixture.title === 'No release' ? undefined : randomUUID();
        ids.set(fixture.title, { game, release });
        await db.query(
          'INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5)',
          [game, owner, fixture.titleId, fixture.title, { description: fixture.title }],
        );
        if (release)
          await db.query(
            "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'01.00',$4,'{}')",
            [release, game, `IV0000-${fixture.titleId}_00-CATALOGTEST000000`, fixture.kind],
          );
        if (release && fixture.source)
          await db.query(
            'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), source, release, fixture.title, fixture.source],
          );
      }
      const unverified = ids.get('Unverified')!;
      await db.query(
        'INSERT INTO ' +
          'artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,deleted_at) ' +
          "VALUES($1,$2,'pkg',$3,$4,3,false,'{}',NULL),($5,$2,'pkg',$6,$7,3,true,'{}',now())",
        [
          randomUUID(),
          unverified.release,
          'artifacts/unverified.pkg',
          '3'.repeat(64),
          randomUUID(),
          'artifacts/deleted.pkg',
          '4'.repeat(64),
        ],
      );
      const active = ids.get('Active')!;
      await db.query(
        "INSERT INTO artwork(id,game_id,kind,sha256,relative_path,width,height,size) VALUES($1,$2,'cover',$3,'artwork/active.webp',1,1,1)",
        [randomUUID(), active.game, 'a'.repeat(64)],
      );
      await db.query(
        'INSERT INTO ' +
          'game_media(id,game_id,state,reserved_bytes,size,sha256,duration,kind,input_format) ' +
          "VALUES($1,$2,'READY',0,1,$3,1,'trailer','mov')",
        [randomUUID(), active.game, 'b'.repeat(64)],
      );
      const activeArtifact = randomUUID(),
        profile = randomUUID();
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,5,true,'{}')",
        [activeArtifact, active.release, 'artifacts/active.pkg', '5'.repeat(64)],
      );
      await db.query(
        'INSERT INTO ' +
          'compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) ' +
          "SELECT $1,$2,g.title_id,r.content_id,r.version,'4.51','runtime','{}' FROM game_releases r " +
          'JOIN games g ON g.id=r.game_id WHERE r.id=$3',
        [profile, owner, active.release],
      );
      await db.query(
        'INSERT INTO ' +
          'backport_artifacts(' +
          'id,game_id,release_id,title_id,game_version,target_firmware,type,source,sha256,size,' +
          'profile_id,tested,artifact_id,input_hash,relative_path,deleted_at' +
          ') ' +
          'VALUES' +
          "($1,$2,$3,'PPSA91001','01.00','4.51','FPKG','test',$4,1,$5,true,$6,$7," +
          "'backports/active',NULL)," +
          "($8,$2,$3,'PPSA91001','01.00','4.51','FPKG','test',$9,1,$5,true,$6,$7," +
          "'backports/deleted',now())",
        [
          randomUUID(),
          active.game,
          active.release,
          '6'.repeat(64),
          profile,
          activeArtifact,
          '7'.repeat(64),
          randomUUID(),
          '8'.repeat(64),
        ],
      );
      const ready = ids.get('Ready only')!,
        consoleId = randomUUID();
      await db.query(
        "INSERT INTO consoles(id,device_id,user_id,name,client_kind) VALUES($1,$2,$3,'Catalog console','SIMULATOR')",
        [consoleId, randomUUID(), owner],
      );
      await db.query(
        "INSERT INTO console_library_entries(console_id,release_id,storage_id,state) VALUES($1,$2,'internal','READY_ON_PS5')",
        [consoleId, ready.release],
      );

      const optimized = await catalogFor(db, owner),
        legacy = await legacyCatalogFor(db, owner);
      assert.deepEqual(
        canonicalCatalog(optimized),
        canonicalCatalog(legacy),
        'The optimized production function is row-for-row equivalent; aggregate order is intentionally ignored',
      );
      const owned = Object.fromEntries(optimized.map((game) => [game.title, game]));
      assert.equal(owned.Active.releases.length, 1);
      assert.equal(owned.Active.releases[0].sources.length, 1);
      assert.equal(owned.Active.releases[0].artifacts.length, 1);
      assert.equal(owned.Active.releases[0].backports.length, 1);
      assert.equal(owned.Retired.releases.length, 0);
      assert.equal(owned.Unverified.releases.length, 0);
      assert.equal(owned.DLC.releases[0].kind, 'DLC');
      assert.equal(owned['No release'].releases.length, 0);
      assert.equal(owned['Ready only'].releases.length, 1);

      await db.query('INSERT INTO game_shares(game_id,user_id,granted_by) VALUES($1,$2,$3)', [
        active.game,
        member,
        owner,
      ]);
      let pageSelected = false;
      const revokeAfterPage = {
        query: async (sql: string, args?: unknown[]) => {
          const result = await db.query(sql, args);
          if (!pageSelected && /^\s*SELECT\s+g\.\*/.test(sql)) {
            pageSelected = true;
            await db.query('DELETE FROM game_shares WHERE game_id=$1 AND user_id=$2', [
              active.game,
              member,
            ]);
          }
          return result;
        },
      };
      const revoked = await catalogFor(revokeAfterPage as any, member, 'Active');
      assert.equal(revoked.length, 1, 'The game was readable when the page was selected');
      assert.equal(revoked[0].releases.length, 0, 'Release details are reauthorized');
      assert.equal(revoked[0].trailer, null);
      assert.match(revoked[0].coverUrl, /v=missing$/);
      assert.deepEqual(await catalogFor(db, member, 'No such game'), []);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
