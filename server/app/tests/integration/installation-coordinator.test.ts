import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';
import { installationRoutes } from '../../src/jobs/installations.js';

test(
  'the installation coordinator leaves slow work outside transactions and finalizes conditionally',
  { timeout: 10000 },
  async () => {
    const base = configuration({ ...process.env, OPERATOR_URL: '', OPERATOR_TOKEN: '' }),
      admin = database(base.DATABASE_URL),
      schema = `installation_lock_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const db = database(url.href),
      app = Fastify();
    const userId = randomUUID(),
      consoleId = randomUUID(),
      gameId = randomUUID(),
      releaseId = randomUUID(),
      sourceId = randomUUID(),
      sourceReleaseId = randomUUID(),
      jobId = randomUUID(),
      firstId = randomUUID(),
      secondId = randomUUID(),
      sha256 = 'a'.repeat(64);
    let unblock: () => void = () => {},
      coordinator: Awaited<ReturnType<typeof installationRoutes>> | undefined;
    const blocked = new Promise<{ id: string }>((resolve) => {
      unblock = () => resolve({ id: jobId });
    });
    let started!: () => void;
    const reconciling = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      await migrate(db);
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,'installation-lock','x','ADMIN')",
        [userId],
      );
      await db.query(
        'INSERT INTO consoles(id,device_id,user_id,name,client_kind,last_seen,firmware,runtime) ' +
          "VALUES($1,$2,$3,'Test PS5','SIMULATOR',now(),'4.51','test')",
        [consoleId, randomUUID(), userId],
      );
      await db.query(
        'INSERT INTO console_capabilities(console_id,capabilities) VALUES($1,\'{"homebrew":true}\')',
        [consoleId],
      );
      await db.query(
        'INSERT INTO ' +
          'console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) ' +
          "VALUES($1,'first','First','/first',1000,1000,true,'[\"HOMEBREW\"]'),($1,'second','Second','/second',1000,1000,true,'[\"HOMEBREW\"]')",
        [consoleId],
      );
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'LOCK00001','Lock test','{}')",
        [gameId, userId],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-LOCK00001_00-PS5LIBRARYTEST0','01.00','BASE',$3)",
        [releaseId, gameId, { format: 'elf', size: 1, sha256 }],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Lock source','HTTP_JSON','{}')",
        [sourceId, userId],
      );
      await db.query(
        "INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,'lock',$4)",
        [sourceReleaseId, sourceId, releaseId, { format: 'elf', size: 1, sha256 }],
      );
      await db.query(
        "INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state) VALUES($1,$2,'DOWNLOAD',$3,$4,'QUEUED')",
        [jobId, userId, releaseId, sourceReleaseId],
      );
      await db.query(
        'INSERT INTO ' +
          'installations(id,user_id,source_release_id,console_id,storage_id,method,source_sha256,created_at) ' +
          "VALUES($1,$2,$3,$4,'first','HOMEBREW',$5,'2026-01-01'),($6,$2,$3,$4,'second','HOMEBREW',$5,'2026-01-02')",
        [firstId, userId, sourceReleaseId, consoleId, sha256, secondId],
      );
      const planned = {
        compatibility: { status: 'NATIVE_COMPATIBLE', profileId: null },
        compatible: true,
        backportRequired: false,
        artifactId: null,
        storage: [
          { storageId: 'first', allowed: true },
          { storageId: 'second', allowed: true },
        ],
        reason: 'READY_TO_PREPARE',
        transferable: true,
      };
      coordinator = await installationRoutes(
        app,
        db,
        {
          user: async () => ({ id: userId }),
          device: async () => ({ id: consoleId, user_id: userId }),
        } as any,
        { enqueue: async () => ({}) } as any,
        { plan: async () => planned, enqueue: async () => ({ id: randomUUID() }) } as any,
        async () => {
          started();
          return blocked;
        },
      );
      await reconciling;
      const lockState = (
        await db.query(
          'SELECT activity.state FROM pg_locks held JOIN pg_stat_activity activity ON ' +
            "activity.pid=held.pid WHERE held.locktype='advisory' AND held.classid=0 AND " +
            'held.objid=3150006 AND held.granted AND held.database=(SELECT oid FROM pg_database WHERE ' +
            'datname=current_database())',
        )
      ).rows[0]?.state;
      assert.equal(
        lockState,
        'idle',
        'Nested work must not leave the coordinator advisory lock idle in a transaction',
      );
      const writer = await db.connect();
      try {
        await writer.query("SET lock_timeout='200ms'");
        await writer.query('BEGIN');
        const current = await writer.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE', [
          firstId,
        ]);
        assert.equal(
          current.rowCount,
          1,
          'Slow nested work must run without holding the installation row transaction open',
        );
        await writer.query("UPDATE installations SET state='CANCELLED' WHERE id=$1", [firstId]);
        await writer.query('COMMIT');
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        writer.release();
      }
      unblock();
      for (let attempt = 0; attempt < 50; attempt++) {
        const row = (
          await db.query('SELECT state,source_job_id FROM installations WHERE id=$1', [secondId])
        ).rows[0];
        if (row?.state === 'PREPARING' && row.source_job_id === jobId) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const rows = (
        await db.query('SELECT id,state,source_job_id FROM installations ORDER BY created_at')
      ).rows;
      assert.deepEqual(rows, [
        { id: firstId, state: 'CANCELLED', source_job_id: null },
        { id: secondId, state: 'PREPARING', source_job_id: jobId },
      ]);
    } finally {
      unblock();
      await coordinator?.close();
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
