import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { database, migrate, parseSchema } from '../../src/db.js';

const schemaSource = await readFile(path.resolve('app/schema.sql'), 'utf8'),
  migrations = parseSchema(schemaSource);
const releaseIndexes = [
  'compatibility_profiles_match',
  'console_heartbeats_latest_normal',
  'console_library_ready_release',
  'console_notices_device_pending',
  'console_notices_user_pending',
  'game_media_work_scan',
  'installations_active_scan',
  'job_events_job',
  'jobs_failed_transfer_history',
  'jobs_open_work',
  'pairings_console_credentials',
  'sources_due_scan',
];

async function isolatedDatabase(prefix: string) {
  const base = configuration(),
    admin = database(base.DATABASE_URL),
    schema = `${prefix}_${randomUUID().replaceAll('-', '')}`,
    url = new URL(base.DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { admin, db: database(url.href), schema };
}

async function dropLatestMigrationObjects(db: ReturnType<typeof database>) {
  await db.query('DROP INDEX jobs_open_work');
}

test('schema parser rejects a malformed trailing migration marker', () => {
  const marker = `-- PS5LIBRARY MIGRATION ${migrations.at(-1)!.name}\n`;
  assert.throws(
    () => parseSchema(schemaSource.replace(marker, marker.replace('.sql', '-invalid.sql'))),
    /Invalid app\/schema\.sql format/,
  );
});

test('published 001-051 sections match the live migration history', () => {
  const digest = createHash('sha256')
    .update(
      migrations
        .slice(0, 51)
        .map(({ name, sha256 }) => `${name}\0${sha256}\n`)
        .join(''),
    )
    .digest('hex');
  assert.equal(digest, '9e7d7f99aa21a127b94bb0771310b564798e493df74ff34e2d498c7865f03b21');
});

test('fresh install applies every section from the single schema file', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_fresh');
  try {
    await migrate(db);
    assert.deepEqual(
      (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
        (row) => row.name,
      ),
      migrations.map((migration) => migration.name),
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname',
          [releaseIndexes],
        )
      ).rows.map((row) => row.indexname),
      releaseIndexes,
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('complete legacy migration history resumes from its unchanged prefix', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_legacy');
  try {
    await migrate(db);
    await dropLatestMigrationObjects(db);
    await db.query('DELETE FROM schema_migrations WHERE name=$1', [migrations.at(-1)!.name]);
    await migrate(db);
    assert.deepEqual(
      (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
        (row) => row.name,
      ),
      migrations.map((migration) => migration.name),
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname',
          [releaseIndexes],
        )
      ).rows.map((row) => row.indexname),
      releaseIndexes,
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('a database at migration 049 applies runtime settings 050 and open-work index 051', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_049');
  try {
    await migrate(db);
    await db.query('DROP INDEX jobs_open_work');
    await db.query('DROP TABLE runtime_settings');
    await db.query('DELETE FROM schema_migrations WHERE name=ANY($1::text[])', [
      ['050_runtime_settings.sql', '051_open_work_index.sql'],
    ]);
    await migrate(db);
    assert.equal(
      (await db.query("SELECT to_regclass('runtime_settings') IS NOT NULL AS present")).rows[0]
        .present,
      true,
    );
    assert.equal(
      (await db.query("SELECT to_regclass('jobs_open_work') IS NOT NULL AS present")).rows[0]
        .present,
      true,
    );
    assert.deepEqual(
      (
        await db.query("SELECT name FROM schema_migrations WHERE name>='050_' ORDER BY name")
      ).rows.map((row) => row.name),
      ['050_runtime_settings.sql', '051_open_work_index.sql'],
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('legacy database records an already-applied idempotent latest migration', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_precreated');
  try {
    await migrate(db);
    await db.query('DELETE FROM schema_migrations WHERE name=$1', [migrations.at(-1)!.name]);
    await migrate(db);
    assert.equal(
      (
        await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1', [
          migrations.at(-1)!.name,
        ])
      ).rows[0].n,
      1,
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('gapped or modified legacy migration history is rejected without being rewritten', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_partial');
  try {
    await migrate(db);
    await db.query('DELETE FROM schema_migrations WHERE name=$1', [migrations.at(-2)!.name]);
    await assert.rejects(migrate(db), /SCHEMA_MIGRATION_HISTORY_INVALID/);
    assert.equal(
      Number((await db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n),
      migrations.length - 1,
    );
    await db.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [
      migrations.at(-2)!.name,
      migrations.at(-2)!.sha256,
    ]);
    await db.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE name=$1", [
      migrations.at(-1)!.name,
    ]);
    await assert.rejects(migrate(db), /SCHEMA_MIGRATION_HISTORY_INVALID/);
    assert.equal(
      (
        await db.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [
          migrations.at(-1)!.name,
        ])
      ).rows[0].sha256,
      '0'.repeat(64),
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('out-of-order legacy migration history is rejected', async () => {
  const { admin, db, schema } = await isolatedDatabase('baseline_order');
  try {
    await migrate(db);
    await db.query(
      "UPDATE schema_migrations SET applied_at=CASE name WHEN $1 THEN now()+interval '2 seconds' " +
        "WHEN $2 THEN now()+interval '1 second' ELSE applied_at END WHERE name=ANY($3::text[])",
      [migrations[0]!.name, migrations[1]!.name, [migrations[0]!.name, migrations[1]!.name]],
    );
    await assert.rejects(migrate(db), /SCHEMA_MIGRATION_HISTORY_INVALID/);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
