import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';

test('catalog reverse lookups use release indexes', async () => {
  const base = configuration(),
    admin = database(base.DATABASE_URL),
    schema = `indexes_${randomUUID().replaceAll('-', '')}`,
    url = new URL(base.DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = database(url.href);
  try {
    await migrate(db);
    await db.query('SET enable_seqscan=off');
    const plan = async (sql: string) =>
      JSON.stringify((await db.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]);
    const source = await plan(
      "SELECT * FROM source_releases WHERE release_id='00000000-0000-0000-0000-000000000000'::uuid",
    );
    const backport = await plan(
      "SELECT * FROM backport_artifacts WHERE release_id='00000000-0000-0000-0000-000000000000'::uuid AND deleted_at IS NULL",
    );
    assert.match(source, /source_releases_release/);
    assert.match(backport, /backport_artifacts_release_active/);
    assert.match(
      await plan(
        "SELECT id FROM job_events WHERE job_id='00000000-0000-0000-0000-000000000000'::uuid ORDER BY id",
      ),
      /job_events_job/,
    );
    assert.match(
      await plan(
        "SELECT id FROM sources WHERE config ? 'scanIntervalMinutes' AND next_scan_at<=now() ORDER BY next_scan_at LIMIT 5",
      ),
      /sources_due_scan/,
    );
    assert.match(
      await plan(
        "SELECT * FROM installations WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') ORDER BY created_at LIMIT 50",
      ),
      /installations_active_scan/,
    );
    assert.match(
      await plan("SELECT id FROM game_media WHERE state IN ('QUEUED','PREPARING')"),
      /game_media_work_scan/,
    );
    assert.match(
      await plan(
        "SELECT id FROM console_notices WHERE user_id='00000000-0000-0000-0000-000000000000'::uuid " +
          'AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 100',
      ),
      /console_notices_user_pending/,
    );
    assert.match(
      await plan(
        'SELECT id FROM console_notices WHERE ' +
          "console_id='00000000-0000-0000-0000-000000000000'::uuid AND delivered_at IS NULL AND " +
          'resolved_at IS NULL ORDER BY created_at LIMIT 20',
      ),
      /console_notices_device_pending/,
    );
    assert.match(
      await plan(
        'SELECT release_id FROM console_library_entries WHERE ' +
          "release_id='00000000-0000-0000-0000-000000000000'::uuid AND state='READY_ON_PS5'",
      ),
      /console_library_ready_release/,
    );
    assert.match(
      await plan(
        'SELECT j.id FROM jobs j JOIN artifacts a ON a.id=j.artifact_id AND ' +
          "a.release_id=j.release_id WHERE j.console_id='00000000-0000-0000-0000-000000000000'::uuid " +
          "AND j.release_id='00000000-0000-0000-0000-000000000000'::uuid AND j.storage_id='internal' " +
          "AND j.kind='TRANSFER' AND j.state='READY_ON_PS5' AND j.config?'launchFailure'",
      ),
      /jobs_failed_transfer_history/,
    );
    assert.match(
      await plan(
        'UPDATE pairings SET credential_cipher=NULL WHERE ' +
          "console_id='00000000-0000-0000-0000-000000000000'::uuid AND kind='AGENT' AND " +
          'credential_cipher IS NOT NULL',
      ),
      /pairings_console_credentials/,
    );
    assert.match(
      await plan(
        'SELECT id FROM compatibility_profiles WHERE ' +
          "user_id='00000000-0000-0000-0000-000000000000'::uuid AND title_id='PPSA00000' AND " +
          "content_id='IV0000-PPSA00000_00-PS5LIBRARYTEST00' AND game_version='01.000.000' AND " +
          "target_firmware='4.50' AND runtime='kstuff' ORDER BY created_at DESC LIMIT 1",
      ),
      /compatibility_profiles_match/,
    );
    assert.match(
      await plan(
        "SELECT COALESCE(sum(COALESCE((config->>'reservedBytes')::bigint,total_bytes)),0) FROM jobs " +
          "WHERE kind IN ('DOWNLOAD','BUILD') AND state NOT IN ('COMPLETED','ERROR','CANCELLED')",
      ),
      /jobs_open_work/,
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
