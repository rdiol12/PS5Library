import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';
import { claimUserJob, reorderQueuedJobs } from '../../src/jobs/runner.js';

test('each user prepares one queued download at a time while other users continue', async () => {
  const base = configuration({ ...process.env, OPERATOR_URL: '', OPERATOR_TOKEN: '' }),
    admin = database(base.DATABASE_URL),
    schema = `user_queue_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = database(url.href);
  try {
    await migrate(db);
    const userA = randomUUID(),
      userB = randomUUID(),
      gameA = randomUUID(),
      gameB = randomUUID(),
      releaseA = randomUUID(),
      releaseB = randomUUID(),
      a1 = randomUUID(),
      a2 = randomUUID(),
      b1 = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,'queue-a','x','ADMIN'),($2,'queue-b','x','MEMBER')",
      [userA, userB],
    );
    await db.query(
      "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'QUEUE00001','Queue A','{}'),($3,$4,'QUEUE00002','Queue B','{}')",
      [gameA, userA, gameB, userB],
    );
    await db.query(
      'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
        "VALUES($1,$2,'IV0000-QUEUE00001_00-PS5LIBRARYTEST0','01.00','BASE','{}'),($3,$4,'IV0000-QUEUE00002_00-PS5LIBRARYTEST0','01.00','BASE','{}')",
      [releaseA, gameA, releaseB, gameB],
    );
    await db.query(
      'INSERT INTO jobs(id,user_id,kind,release_id,state,created_at) ' +
        "VALUES($1,$2,'DOWNLOAD',$3,'QUEUED','2026-01-01T00:00:00Z')," +
        "($4,$2,'BUILD',$3,'QUEUED','2026-01-01T00:00:01Z')," +
        "($5,$6,'DOWNLOAD',$7,'QUEUED','2026-01-01T00:00:00Z')",
      [a1, userA, releaseA, a2, b1, userB, releaseB],
    );

    const [secondA, firstA, firstB] = await Promise.all([
      claimUserJob(db, a2, userA),
      claimUserJob(db, a1, userA),
      claimUserJob(db, b1, userB),
    ]);
    assert.equal(secondA, false);
    assert.equal(firstA, true);
    assert.equal(firstB, true);
    assert.deepEqual(
      (await db.query('SELECT id,state FROM jobs ORDER BY id')).rows
        .map((row) => [row.id, row.state])
        .sort(),
      [
        [a1, 'DOWNLOADING'],
        [a2, 'QUEUED'],
        [b1, 'DOWNLOADING'],
      ].sort(),
    );

    await db.query("UPDATE jobs SET state='PAUSED',desired_state='PAUSED' WHERE id=$1", [a1]);
    assert.equal(await claimUserJob(db, a2, userA), true);
    assert.equal(
      (await db.query('SELECT state FROM jobs WHERE id=$1', [a2])).rows[0].state,
      'BUILDING',
    );
    await db.query("UPDATE jobs SET state='QUEUED',desired_state='RUNNING' WHERE id=$1", [a1]);
    assert.equal(
      await claimUserJob(db, a1, userA),
      false,
      'resuming an older job must not overlap the job already running',
    );
    await db.query("UPDATE jobs SET state='COMPLETED' WHERE id=$1", [a2]);
    assert.equal(await claimUserJob(db, a1, userA), true);
    await db.query("UPDATE users SET role='MEMBER' WHERE id=$1", [userA]);
    await db.query("UPDATE jobs SET state='COMPLETED' WHERE id=$1", [a1]);
    await db.query("UPDATE jobs SET state='QUEUED',desired_state='RUNNING' WHERE id=$1", [a2]);
    assert.equal(
      await claimUserJob(db, a2, userA),
      false,
      'a BUILD owner must still be ADMIN when the runner claims it',
    );
    assert.deepEqual(
      (await db.query('SELECT state,desired_state,error FROM jobs WHERE id=$1', [a2])).rows[0],
      { state: 'ERROR', desired_state: 'PAUSED', error: 'ADMIN_REQUIRED' },
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('queued jobs can be reordered without accepting another user or active job', async () => {
  const base = configuration({ ...process.env, OPERATOR_URL: '', OPERATOR_TOKEN: '' }),
    admin = database(base.DATABASE_URL),
    schema = `job_reorder_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = database(url.href);
  try {
    await migrate(db);
    const userA = randomUUID(),
      userB = randomUUID(),
      gameA = randomUUID(),
      gameB = randomUUID(),
      releaseA = randomUUID(),
      releaseB = randomUUID(),
      a1 = randomUUID(),
      a2 = randomUUID(),
      a3 = randomUUID(),
      b1 = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,'reorder-a','x','ADMIN'),($2,'reorder-b','x','MEMBER')",
      [userA, userB],
    );
    await db.query(
      "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'ORDER00001','Order A','{}'),($3,$4,'ORDER00002','Order B','{}')",
      [gameA, userA, gameB, userB],
    );
    await db.query(
      'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
        "VALUES($1,$2,'IV0000-ORDER00001_00-PS5LIBRARYTEST0','01.00','BASE','{}'),($3,$4,'IV0000-ORDER00002_00-PS5LIBRARYTEST0','01.00','BASE','{}')",
      [releaseA, gameA, releaseB, gameB],
    );
    await db.query(
      'INSERT INTO jobs(id,user_id,kind,release_id,state,created_at) ' +
        "VALUES($1,$2,'DOWNLOAD',$3,'QUEUED','2026-01-01T00:00:00Z')," +
        "($4,$2,'BUILD',$3,'QUEUED','2026-01-01T00:00:01Z')," +
        "($5,$2,'DOWNLOAD',$3,'BUILDING','2026-01-01T00:00:02Z')," +
        "($6,$7,'DOWNLOAD',$8,'QUEUED','2026-01-01T00:00:00Z')",
      [a1, userA, releaseA, a2, a3, b1, userB, releaseB],
    );

    assert.deepEqual(await reorderQueuedJobs(db, userA, [a2, a1]), [a2, a1]);
    await db.query("UPDATE users SET role='MEMBER' WHERE id=$1", [userA]);
    await assert.rejects(
      reorderQueuedJobs(db, userA, [a1, a2]),
      /ADMIN_REQUIRED/,
      'a member must not reorder queued BUILD work',
    );
    await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [userA]);
    await assert.rejects(reorderQueuedJobs(db, userA, [a3]), /INVALID_QUEUE_ORDER/);
    await db.query("UPDATE jobs SET state='COMPLETED' WHERE id=$1", [a3]);
    assert.equal(await claimUserJob(db, a2, userA), true);
    await assert.rejects(reorderQueuedJobs(db, userA, [b1]), /INVALID_QUEUE_ORDER/);
    assert.equal(
      (await db.query('SELECT queue_order FROM jobs WHERE id=$1', [b1])).rows[0].queue_order,
      null,
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
