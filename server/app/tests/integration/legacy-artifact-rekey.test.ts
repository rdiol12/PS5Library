import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';
import { artifactBuildKey } from '../../src/jobs/preparation.js';
import { preparationRoutes } from '../../src/jobs/preparation-routes.js';

test(
  'automatic preparation rekeys a verified legacy full-tree FPKG instead of rebuilding it',
  { timeout: 20000 },
  async () => {
    const base = configuration(),
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-legacy-artifact-')),
      schema = 'legacy_artifact_' + randomUUID().replaceAll('-', ''),
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
    try {
      await migrate(db);
      await mkdir(path.join(config.DATA_DIR, 'artifacts'), { recursive: true });
      await mkdir(path.join(config.DATA_DIR, 'jobs'));
      const userId = randomUUID(),
        sourceId = randomUUID(),
        sourceReleaseId = randomUUID(),
        gameId = randomUUID(),
        releaseId = randomUUID(),
        artifactId = randomUUID(),
        baseHash = 'a'.repeat(64),
        treeHash = 'b'.repeat(64),
        relativePath = 'artifacts/legacy.pkg',
        contents = Buffer.from('verified legacy package');
      const game = {
          title: 'Legacy artifact fixture',
          titleId: 'PPSA99972',
          contentId: 'IV0000-PPSA99972_00-ARTIFACTREKEY001',
        },
        release = {
          key: 'legacy-artifact',
          game,
          version: '01.000.000',
          kind: 'BASE',
          region: 'Unknown',
          languages: [],
          size: 4,
          installedSize: 4,
          minimumFirmware: null,
          sdkVersion: null,
          format: 'folder',
          sha256: baseHash,
          sourceTreeSha256: treeHash,
          sourceTreeSize: 8,
          location: 'legacy-artifact',
        };
      await writeFile(path.join(config.DATA_DIR, relativePath), contents);
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','ADMIN')",
        [userId, `legacy-artifact-${randomUUID()}`],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Legacy artifact','WATCH_FOLDER',$3)",
        [
          sourceId,
          userId,
          { name: 'Legacy artifact', type: 'WATCH_FOLDER', location: '.', autoPrepare: 'FPKG' },
        ],
      );
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,'{}')",
        [gameId, userId, game.titleId, game.title],
      );
      await db.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,'BASE','{}')",
        [releaseId, gameId, game.contentId, release.version],
      );
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5)',
        [sourceReleaseId, sourceId, releaseId, release.key, release],
      );
      await db.query(
        `INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash,builder_version,cache_key)
      VALUES($1,$2,'pkg',$3,$4,$5,true,'{}',$6,$7,$8)`,
        [
          artifactId,
          releaseId,
          relativePath,
          'c'.repeat(64),
          contents.length,
          treeHash,
          'LibProsperoPKG / 5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1',
          artifactBuildKey(treeHash, 'FPKG'),
        ],
      );
      await db.query(
        "INSERT INTO automatic_preparations(source_release_id,input_hash,method) VALUES($1,$2,'FPKG')",
        [sourceReleaseId, treeHash],
      );
      const app = { post: () => {}, get: () => {}, delete: () => {} } as any,
        reconcile = async () => {};
      const result = await (
        await preparationRoutes(app, db, config, {} as any, reconcile)
      ).enqueue(userId, { sourceReleaseId, method: 'FPKG' }, true);
      assert.deepEqual(result, { cached: true, artifactId });
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM jobs WHERE kind='BUILD'")).rows[0]
          .count,
        0,
      );
      assert.deepEqual(
        (await db.query('SELECT input_hash,cache_key FROM artifacts WHERE id=$1', [artifactId]))
          .rows[0],
        { input_hash: baseHash, cache_key: artifactBuildKey(baseHash, 'FPKG') },
      );
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
