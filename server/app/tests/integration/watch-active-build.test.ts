import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { catalogRoutes } from '../../src/catalog/routes.js';
import { database, migrate } from '../../src/db.js';
import { discoverWatched } from '../../src/sources/watch.js';

test(
  'scheduled watch scan indexes and queues a new dump behind an active build',
  { timeout: 20000 },
  async () => {
    const base = configuration(),
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-watch-active-')),
      schema = 'watch_active_' + randomUUID().replaceAll('-', ''),
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
      },
      db = database(url.href);
    let close: () => Promise<void> = async () => {};
    try {
      await migrate(db);
      await mkdir(path.join(config.DUMP_ROOT, 'game', 'sce_sys'), { recursive: true });
      const userId = randomUUID(),
        sourceId = randomUUID(),
        activeGameId = randomUUID(),
        activeReleaseId = randomUUID();
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','ADMIN')",
        [userId, `watch-active-${randomUUID()}`],
      );
      const source = {
        id: sourceId,
        config: {
          name: 'Watched games',
          type: 'WATCH_FOLDER' as const,
          location: '.',
          scanIntervalMinutes: 1,
          autoPrepare: 'FPKG' as const,
          shareCatalog: true,
        },
      };
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Watched games','WATCH_FOLDER',$3)",
        [sourceId, userId, source.config],
      );
      await writeFile(
        path.join(config.DUMP_ROOT, 'game', 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: 'PPSA99971',
          contentId: 'IV0000-PPSA99971_00-WATCHACTIVE00001',
          contentVersion: '01.000.000',
          localizedParameters: { 'en-US': { titleName: 'Queued watch fixture' } },
        }),
      );
      await discoverWatched(db, config, source, async () => {});
      const release = {
        key: 'watch-active',
        game: {
          title: 'Queued watch fixture',
          titleId: 'PPSA99971',
          contentId: 'IV0000-PPSA99971_00-WATCHACTIVE00001',
        },
        kind: 'BASE',
        version: '01.000.000',
        size: 1,
        installedSize: 1,
        format: 'folder',
        sha256: '1'.repeat(64),
        location: 'game',
      };
      await db.query(
        "UPDATE source_observations SET changed_at=now()-interval '2 minutes',state='READY',release=$2 WHERE source_id=$1",
        [sourceId, release],
      );
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA99970','Active build fixture','{}')",
        [activeGameId, userId],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-PPSA99970_00-ACTIVEBUILD000001','01.000.000','BASE','{}')",
        [activeReleaseId, activeGameId],
      );
      await db.query(
        "INSERT INTO jobs(id,user_id,kind,release_id,state,config) VALUES($1,$2,'BUILD',$3,'BUILDING','{\"method\":\"FPKG\"}')",
        [randomUUID(), userId, activeReleaseId],
      );
      const app = {
        post: () => {},
        get: () => {},
        patch: () => {},
        put: () => {},
        delete: () => {},
        addHook: (name: string, hook: () => Promise<void>) => {
          if (name === 'onClose') close = hook;
        },
      } as any;
      const prepare = async (
        owner: string,
        body: { sourceReleaseId: string; method: 'FPKG' | 'SHADOWMOUNT' },
      ) => {
        const row = (
            await db.query('SELECT release_id FROM source_releases WHERE id=$1', [
              body.sourceReleaseId,
            ])
          ).rows[0],
          id = randomUUID();
        await db.query(
          "INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,config) VALUES($1,$2,'BUILD',$3,$4,'QUEUED',$5)",
          [id, owner, row.release_id, body.sourceReleaseId, { method: body.method }],
        );
        return { id };
      };
      await catalogRoutes(app, db, config, {} as any, prepare, async () => ({}));
      let jobs: any[] = [];
      for (let i = 0; i < 140; i++) {
        jobs = (await db.query("SELECT state FROM jobs WHERE kind='BUILD' ORDER BY created_at"))
          .rows;
        if (jobs.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(
        jobs.map((job) => job.state),
        ['BUILDING', 'QUEUED'],
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM games WHERE title_id='PPSA99971'"))
          .rows[0].count,
        1,
      );
    } finally {
      await close();
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
