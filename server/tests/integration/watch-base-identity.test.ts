import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';
import { runWorker } from '../../src/library/inspect.js';
import { discoverWatched } from '../../src/sources/watch.js';

test(
  'watched overlays reindex without changing the base package identity',
  { timeout: 30000 },
  async () => {
    const base = configuration(),
      root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-watch-base-')),
      schema = 'watch_base_' + randomUUID().replaceAll('-', ''),
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
    try {
      await migrate(db);
      const folder = path.join(config.DUMP_ROOT, 'game');
      await mkdir(path.join(folder, 'sce_sys'), { recursive: true });
      await mkdir(path.join(folder, 'fakelib'));
      const identity = {
        titleId: 'PPSA99969',
        contentId: 'IV0000-PPSA99969_00-WATCHBASEIDENTIT',
        contentVersion: '01.000.000',
        localizedParameters: { 'en-US': { titleName: 'Watch base identity' } },
      };
      await writeFile(path.join(folder, 'sce_sys', 'param.json'), JSON.stringify(identity));
      await writeFile(path.join(folder, 'eboot.bin'), 'base executable');
      await writeFile(path.join(folder, 'fakelib', 'compat.sprx'), 'overlay one');
      const userId = randomUUID(),
        sourceId = randomUUID(),
        source = { id: sourceId, config: { location: '.' } };
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','ADMIN')",
        [userId, `watch-base-${randomUUID()}`],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Watch base identity','WATCH_FOLDER',$3)",
        [sourceId, userId, { name: 'Watch base identity', type: 'WATCH_FOLDER', location: '.' }],
      );
      const full = await runWorker(['hash-tree', folder]),
        baseTree = await runWorker(['hash-base-tree', folder]);
      assert.notEqual(full.sha256, baseTree.sha256);

      await discoverWatched(db, config, source, async () => {});
      const legacy = {
        key: 'legacy',
        game: {
          title: 'Watch base identity',
          titleId: identity.titleId,
          contentId: identity.contentId,
        },
        version: identity.contentVersion,
        kind: 'BASE',
        size: full.size,
        installedSize: full.size,
        format: 'folder',
        sha256: full.sha256,
        location: 'game',
      };
      await db.query(
        "UPDATE source_observations SET signature='watch-v3-legacy',changed_at=now()-interval '2 " +
          "minutes',state='READY',release=$2 WHERE source_id=$1",
        [sourceId, legacy],
      );
      await discoverWatched(db, config, source, async () => {});
      assert.deepEqual(
        (
          await db.query('SELECT state,release FROM source_observations WHERE source_id=$1', [
            sourceId,
          ])
        ).rows[0],
        { state: 'STABILIZING', release: null },
        'The signature namespace transition invalidates a legacy full-tree release',
      );

      await db.query(
        "UPDATE source_observations SET changed_at=now()-interval '2 minutes' WHERE source_id=$1",
        [sourceId],
      );
      const published: any[] = [];
      await discoverWatched(db, config, source, async (release) => {
        published.push(release);
      });
      assert.equal(published.length, 1);
      assert.equal(published[0].sha256, baseTree.sha256);
      assert.equal(published[0].size, baseTree.size);
      assert.equal(published[0].sourceTreeSha256, full.sha256);
      assert.equal(published[0].sourceTreeSize, full.size);

      await appendFile(path.join(folder, 'fakelib', 'compat.sprx'), ' changed');
      await discoverWatched(db, config, source, async () => {});
      assert.equal(
        (await db.query('SELECT state FROM source_observations WHERE source_id=$1', [sourceId]))
          .rows[0].state,
        'STABILIZING',
        'Overlay metadata remains part of the observation signature',
      );
      await db.query(
        "UPDATE source_observations SET changed_at=now()-interval '2 minutes' WHERE source_id=$1",
        [sourceId],
      );
      await discoverWatched(db, config, source, async (release) => {
        published.push(release);
      });
      const changed = published.at(-1),
        changedFull = await runWorker(['hash-tree', folder]);
      assert.equal(changed.sha256, baseTree.sha256);
      assert.equal(changed.size, baseTree.size);
      assert.equal(changed.sourceTreeSha256, changedFull.sha256);
      assert.notEqual(changed.sourceTreeSha256, full.sha256);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
