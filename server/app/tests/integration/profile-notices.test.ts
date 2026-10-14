import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configuration } from '../../src/config.js';
import { database, migrate } from '../../src/db.js';
import { resolveSuccessfulProfileNotices } from '../../src/catalog/routes.js';

test('successful exact profiles resolve only matching stale profile warnings', async () => {
  const base = configuration(process.env),
    admin = database(base.DATABASE_URL),
    schema = `profile_notices_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = database(url.href);
  try {
    await migrate(db);
    const userId = randomUUID(),
      consoleId = randomUUID(),
      otherConsoleId = randomUUID(),
      gameId = randomUUID(),
      releaseId = randomUUID(),
      sourceHash = 'a'.repeat(64),
      runtime = 'kst_ff',
      suffix = `4.50:${runtime}:${sourceHash}`;
    await db.query("INSERT INTO users(id,username,password_hash) VALUES($1,'owner','x')", [userId]);
    await db.query(
      "INSERT INTO consoles(id,device_id,user_id,name,client_kind) VALUES($1,$2,$3,'Target','PS5'),($4,$5,$3,'Other','PS5')",
      [consoleId, randomUUID(), userId, otherConsoleId, randomUUID()],
    );
    await db.query(
      "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA00001','Fixture','{}')",
      [gameId, userId],
    );
    await db.query(
      'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
        "VALUES($1,$2,'UP0000-PPSA00001_00-PS5LIBRARYTEST0','01.00','BASE','{}')",
      [releaseId, gameId],
    );
    const fixtures = [
      ['BACKPORT_NO_MATCH', `profile-v3:${suffix}`, consoleId],
      ['BACKPORT_FILES_MISMATCH', `profile-v3:4.50:${runtime}:${'b'.repeat(64)}`, consoleId],
      ['BACKPORT_NOT_INDEXED', `profile-v3:${suffix}`, otherConsoleId],
      ['BACKPORT_FILES_MISMATCH', `profile-v4:${suffix}`, consoleId],
      ['BACKPORT_NO_MATCH', `profile-v3:4.50:kstXff:${sourceHash}`, consoleId],
    ];
    for (const [code, context, target] of fixtures)
      await db.query(
        "INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message) VALUES($1,$2,$3,$4,$5,$6,'warning')",
        [randomUUID(), userId, target, releaseId, code, context],
      );

    await resolveSuccessfulProfileNotices(
      db,
      { releaseId, consoleIds: [consoleId] },
      '4.50',
      runtime,
      sourceHash,
    );

    const notices = (
      await db.query(
        'SELECT console_id,context,resolved_at FROM console_notices ORDER BY created_at',
      )
    ).rows;
    assert.ok(notices[0].resolved_at);
    assert.equal(notices[1].resolved_at, null, 'A different source hash remains active');
    assert.equal(
      notices[2].resolved_at,
      null,
      'A console outside the successful profile group remains active',
    );
    assert.equal(
      notices[3].resolved_at,
      null,
      'Profile discovery does not hide an unresolved file-integrity warning',
    );
    assert.equal(
      notices[4].resolved_at,
      null,
      'Runtime characters are matched literally, not as SQL wildcards',
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
