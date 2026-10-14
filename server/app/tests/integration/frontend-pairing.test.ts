import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/api/app.js';
import { api, isolatedApp } from './test-app.js';

test('native frontend can register the first PS5', { timeout: 60000 }, async () => {
  const { config, admin, schema, app, db } = await isolatedApp('ps5library-first-frontend-', {
    COMMUNITY_MASTER_URL: '',
  });
  const call = api(() => app);
  try {
    const owner = await call('POST', '/auth/register', {
      username: 'first-console-owner',
      password: 'test-password',
      bootstrapToken: config.BOOTSTRAP_TOKEN,
    });
    const pairing = await call('POST', '/frontend/pairings', { deviceId: randomUUID() });
    assert.equal(
      (await call('POST', '/pairings/claim', { code: pairing.body.code }, owner.body.token)).status,
      200,
    );
    const paired = await call('POST', `/pairings/${pairing.body.id}/poll`, {
      pollSecret: pairing.body.pollSecret,
    });
    assert.equal(paired.status, 200);
    assert.ok(paired.body.credential);
    const consoles = await call('GET', '/consoles', undefined, owner.body.token);
    assert.equal(consoles.body.length, 1);
    assert.equal(consoles.body[0].id, paired.body.consoleId);
    assert.equal(consoles.body[0].isDefault, true);
    assert.equal(
      (await call('GET', '/device/status', undefined, paired.body.credential)).status,
      200,
    );
    assert.equal(
      (
        await db.query('SELECT kind FROM console_credentials WHERE console_id=$1', [
          paired.body.consoleId,
        ])
      ).rows[0].kind,
      'FRONTEND',
    );
  } finally {
    await app.close();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test(
  'native frontend pairs with an owned console without gaining agent authority',
  { timeout: 60000 },
  async () => {
    const setup = await isolatedApp('ps5library-frontend-', {
      COMMUNITY_MASTER_URL: '',
    });
    const { config, admin, schema, db } = setup;
    let { app } = setup;
    const call = api(() => app);
    try {
      const owner = await call('POST', '/auth/register', {
        username: 'native-owner',
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      assert.equal(owner.status, 201);
      const token = owner.body.token;
      const invitation = await call('POST', '/admin/invites', {}, token);
      const friend = await call('POST', '/auth/register', {
        username: 'native-friend',
        password: 'test-password',
        inviteToken: invitation.body.token,
      });
      const pair = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Living Room',
        clientKind: 'SIMULATOR',
        firmware: '4.51',
      });
      assert.match(pair.body.code, /^[2-9A-HJ-NP-Z]{5}$/);
      await call('POST', '/pairings/claim', { code: pair.body.code }, token);
      const paired = await call('POST', `/pairings/${pair.body.id}/poll`, {
        pollSecret: pair.body.pollSecret,
      });
      const consoleId = paired.body.consoleId,
        agentToken = paired.body.credential;
      const report = {
        firmware: '4.51',
        runtime: 'test',
        clientVersion: '0.2.10',
        agentVersion: '0.2.10',
        capabilities: { inventoryScan: true, nativeNotifications: true },
        storage: [
          {
            storageId: 'internal',
            displayName: 'Internal Storage',
            path: '/data',
            totalBytes: 10000,
            freeBytes: 9000,
            writable: true,
            installMethodsSupported: ['HOMEBREW'],
          },
        ],
        libraryRevision: 1,
        inventory: [],
        inventoryComplete: true,
      };
      const initialHeartbeat = await call('POST', '/device/heartbeat', report, agentToken);
      assert.equal(initialHeartbeat.status, 200);
      assert.equal(initialHeartbeat.body.libraryRevision, 1);
      const stableRows = async () =>
        Object.fromEntries(
          (
            await db.query(
              `SELECT 'capabilities' AS name,xmin::text AS version FROM console_capabilities WHERE console_id=$1
      UNION ALL SELECT 'heartbeat',xmin::text FROM console_heartbeats WHERE console_id=$1 AND NOT(payload ? 'launchTrace')
      UNION ALL SELECT 'pairing',xmin::text FROM pairings WHERE console_id=$1 AND kind='AGENT'`,
              [consoleId],
            )
          ).rows.map((row) => [row.name, row.version]),
        );
      const stableBefore = await stableRows();
      assert.equal(
        (await call('POST', '/device/heartbeat', { ...report, libraryRevision: 2 }, agentToken))
          .status,
        200,
      );
      assert.deepEqual(
        await stableRows(),
        stableBefore,
        'A heartbeat with unchanged observed state must not rewrite capability, diagnostic, or pairing rows',
      );
      const saveData = {
        source: 'LOCAL_SAVE_DATABASES',
        localUserId: '12345678',
        complete: true,
        items: [
          {
            platform: 'PS5',
            gameTitleId: 'PPSA54321',
            saveTitleId: 'PPSA54321',
            directory: 'slot1',
            title: 'Stable save',
            subtitle: 'Autosave',
            detail: 'Checkpoint',
            sizeBytes: 4096,
            modifiedAt: 1000,
          },
        ],
      };
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...report, libraryRevision: 2, saveData },
            agentToken,
          )
        ).status,
        200,
      );
      const saveVersion = (
        await db.query('SELECT xmin::text AS version FROM console_save_data WHERE console_id=$1', [
          consoleId,
        ])
      ).rows[0].version;
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...report, libraryRevision: 2, saveData },
            agentToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await db.query(
            'SELECT xmin::text AS version FROM console_save_data WHERE console_id=$1',
            [consoleId],
          )
        ).rows[0].version,
        saveVersion,
        'An unchanged save scan must not rewrite save rows',
      );
      await db.query('UPDATE consoles SET library_revision=100 WHERE id=$1', [consoleId]);
      const staleHeartbeat = await call(
        'POST',
        '/device/heartbeat',
        { ...report, libraryRevision: 2 },
        agentToken,
      );
      assert.equal(
        staleHeartbeat.body.libraryRevision,
        100,
        'The server tells a reset agent which revision it must surpass',
      );
      assert.equal(
        (await db.query('SELECT library_revision FROM consoles WHERE id=$1', [consoleId])).rows[0]
          .library_revision,
        100,
        'A stale inventory revision cannot replace newer server state',
      );
      assert.equal(
        (await call('POST', '/device/heartbeat', { ...report, libraryRevision: 101 }, agentToken))
          .body.libraryRevision,
        101,
        'The next fresh inventory revision is accepted',
      );
      const staleGameId = randomUUID(),
        staleReleaseId = randomUUID(),
        staleProfileId = randomUUID(),
        staleContentId = 'UP0000-PPSA12345_00-PS5LIBRARYTEST01';
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA12345','Stale receipt','{}')",
        [staleGameId, owner.body.user.id],
      );
      await db.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'01.00','BASE','{}')",
        [staleReleaseId, staleGameId, staleContentId],
      );
      const staleReceipt = {
        releaseId: staleReleaseId,
        titleId: 'PPSA12345',
        contentId: staleContentId,
        version: '01.00',
        title: 'Stale receipt',
        storageId: 'internal',
        relativePath: 'app/PPSA12345/app.pkg',
        sha256: 'a'.repeat(64),
        size: 100,
        available: true,
        registered: true,
        backportProfileId: staleProfileId,
        source: 'MANAGED',
        backportFiles: true,
      };
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...report, libraryRevision: 102, inventory: [staleReceipt] },
            agentToken,
          )
        ).status,
        200,
        'A deleted backport profile must not make the whole console stale',
      );
      const quarantined = (
        await db.query(
          'SELECT state,backport_profile_id,backport_files FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
          [consoleId, staleReleaseId],
        )
      ).rows[0];
      assert.deepEqual(
        quarantined,
        { state: 'ERROR', backport_profile_id: null, backport_files: false },
        'The stale receipt is retained as an error without trusting its deleted profile',
      );
      const discovered = {
        titleId: 'PPSA54321',
        contentId: 'UP0000-PPSA54321_00-PS5LIBRARYTEST02',
        version: '01.00',
        title: 'Stable inventory',
        platform: 'PS5',
        storageId: 'internal',
        relativePath: 'app/PPSA54321/app.pkg',
        sha256: null,
        size: 200,
        available: true,
        registered: true,
        source: 'INSTALLED_TITLE',
        backportFiles: false,
      };
      const discoveredHeartbeat = await call(
        'POST',
        '/device/heartbeat',
        { ...report, libraryRevision: 103, inventory: [discovered] },
        agentToken,
      );
      assert.equal(discoveredHeartbeat.status, 200, JSON.stringify(discoveredHeartbeat.body));
      const inventoryVersions = async () =>
        Object.fromEntries(
          (
            await db.query(
              `SELECT 'game' AS name, g.xmin::text AS version
              FROM games g
              WHERE g.user_id=$1 AND g.title_id=$2
              UNION ALL
              SELECT 'release', r.xmin::text
              FROM game_releases r
              JOIN games g ON g.id=r.game_id
              WHERE g.user_id=$1 AND g.title_id=$2
              UNION ALL
              SELECT 'library', l.xmin::text
              FROM console_library_entries l
              JOIN game_releases r ON r.id=l.release_id
              JOIN games g ON g.id=r.game_id
              WHERE l.console_id=$3 AND g.title_id=$2`,
              [owner.body.user.id, discovered.titleId, consoleId],
            )
          ).rows.map((row) => [row.name, row.version]),
        );
      const inventoryBefore = await inventoryVersions();
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...report, libraryRevision: 104, inventory: [discovered] },
            agentToken,
          )
        ).status,
        200,
      );
      assert.deepEqual(
        await inventoryVersions(),
        inventoryBefore,
        'A new inventory revision with unchanged content must not rewrite game, release, or library rows',
      );
      const before = (
        await db.query('SELECT firmware,last_seen,library_revision FROM consoles WHERE id=$1', [
          consoleId,
        ])
      ).rows[0];
      assert.equal(
        (await call('POST', `/consoles/${consoleId}/notifications/test`, {}, friend.body.token))
          .status,
        404,
      );
      const queued = await call('POST', `/consoles/${consoleId}/notifications/test`, {}, token);
      assert.equal(queued.status, 202);
      const notices = await call('GET', '/device/notifications', undefined, agentToken);
      assert.equal(notices.body.length, 1);
      assert.equal(notices.body[0].code, 'NATIVE_TEST');
      assert.match(notices.body[0].message, /notification.*connected/i);
      assert.equal(
        (await call('POST', `/device/notifications/${notices.body[0].id}/ack`, {}, agentToken))
          .status,
        200,
      );
      assert.equal(
        (await call('GET', '/device/notifications', undefined, agentToken)).body.length,
        0,
      );
      assert.equal(
        (await call('GET', '/notifications', undefined, token)).body.length,
        0,
        'One-shot native tests resolve after delivery',
      );

      const deviceId = randomUUID(),
        front = await call('POST', '/frontend/pairings', { deviceId });
      assert.equal(front.status, 201, JSON.stringify(front.body));
      assert.match(front.body.code, /^[2-9A-HJ-NP-Z]{5}$/);
      assert.equal(
        (
          await call(
            'POST',
            '/pairings/claim',
            { code: front.body.code, consoleId },
            friend.body.token,
          )
        ).status,
        404,
      );
      assert.equal(
        (await call('POST', '/pairings/claim', { code: front.body.code, consoleId }, token)).status,
        200,
      );
      // Agent delivery acknowledgment must not consume the frontend's credential.
      assert.equal((await call('POST', '/device/heartbeat', report, agentToken)).status, 200);
      assert.equal(
        (await call('POST', `/pairings/${front.body.id}/poll`, { pollSecret: '0'.repeat(64) }))
          .status,
        410,
      );
      const delivered = await call('POST', `/pairings/${front.body.id}/poll`, {
        pollSecret: front.body.pollSecret,
      });
      assert.equal(delivered.status, 200);
      assert.equal(delivered.body.consoleId, consoleId);
      const credential = delivered.body.credential;
      assert.notEqual(credential, agentToken);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM consoles')).rows[0].n,
        1,
        'Frontend must not create a second PS5',
      );
      assert.equal((await call('POST', '/frontend/pairings', { deviceId })).status, 409);
      const status = await call('GET', '/device/status', undefined, credential);
      assert.equal(status.status, 200);
      assert.equal(status.body.firmware, '4.51');
      assert.equal(status.body.storage.length, 1);
      assert.equal(
        (await call('GET', '/device/profile', undefined, credential)).body.username,
        'native-owner',
      );
      assert.equal((await call('GET', '/device/consoles', undefined, credential)).body.length, 1);
      assert.equal((await call('GET', '/device/catalog', undefined, credential)).status, 200);
      assert.equal((await call('GET', '/device/installations', undefined, credential)).status, 200);
      assert.deepEqual(
        (await call('POST', '/device/jobs/reorder', { ids: [] }, credential)).body,
        { ids: [] },
        'The paired storefront may reorder its download queue',
      );
      assert.equal(
        (await call('GET', '/device/updates', undefined, credential)).status,
        200,
        'The native storefront may check the signed update feed',
      );
      assert.equal(
        (await call('GET', '/device/native-updates', undefined, credential)).status,
        200,
        'The native storefront may check its package update feed',
      );
      assert.equal(
        (await call('GET', `/device/consoles/${randomUUID()}/library`, undefined, credential))
          .status,
        404,
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/transfers/plan',
            { releaseId: randomUUID(), consoleId },
            credential,
          )
        ).status,
        404,
        'The native storefront may resolve cached-package compatibility without agent authority',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/transfers',
            { artifactId: randomUUID(), consoleId, storageId: 'internal' },
            credential,
          )
        ).status,
        404,
        'The native storefront may queue its approved cached-package transfer without agent authority',
      );
      assert.equal(
        (
          await call('POST', `/pairings/${front.body.id}/poll`, {
            pollSecret: front.body.pollSecret,
          })
        ).status,
        409,
        'First authenticated frontend use acknowledges delivery',
      );
      const protectedRoutes = [
        ['POST', '/device/heartbeat'],
        ['POST', '/device/firmware'],
        ['GET', '/device/tasks'],
        ['GET', '/device/notifications'],
        ['POST', `/device/tasks/${randomUUID()}/progress`],
        ['GET', `/device/artifacts/${randomUUID()}`],
      ];
      for (const [method, route] of protectedRoutes)
        assert.equal(
          (await call(method!, route!, method === 'POST' ? {} : undefined, credential)).status,
          403,
          route,
        );
      const after = (
        await db.query('SELECT firmware,library_revision FROM consoles WHERE id=$1', [consoleId])
      ).rows[0];
      assert.equal(after.firmware, before.firmware);
      assert.equal(after.library_revision, before.library_revision);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM console_heartbeats WHERE NOT(payload ? 'launchTrace')",
          )
        ).rows[0].n,
        1,
        'Only the latest routine heartbeat is retained',
      );

      const reattachDeviceId = randomUUID(),
        reattach = await call('POST', '/pairings', {
          deviceId: reattachDeviceId,
          name: 'Recovered local agent',
          clientKind: 'PS5',
          firmware: '4.51',
          hardwareProof: '56'.repeat(32),
        });
      const temporaryConsoleId = (
        await db.query('SELECT console_id FROM pairings WHERE id=$1', [reattach.body.id])
      ).rows[0].console_id;
      assert.notEqual(temporaryConsoleId, consoleId);
      assert.equal(
        (await call('POST', '/pairings/claim', { code: reattach.body.code }, credential)).status,
        200,
        'The paired storefront may attach its local agent without a user session',
      );
      const reattached = await call('POST', `/pairings/${reattach.body.id}/poll`, {
        pollSecret: reattach.body.pollSecret,
      });
      assert.equal(reattached.status, 200);
      assert.equal(reattached.body.consoleId, consoleId);
      assert.notEqual(reattached.body.credential, credential);
      assert.notEqual(reattached.body.credential, agentToken);
      assert.equal(
        (await call('POST', '/device/heartbeat', report, agentToken)).status,
        401,
        'Reattaching revokes the lost agent credential',
      );
      assert.equal(
        (await call('POST', '/device/heartbeat', report, reattached.body.credential)).status,
        200,
        'The replacement credential has agent authority',
      );
      const rebound = (await db.query('SELECT device_id FROM consoles WHERE id=$1', [consoleId]))
        .rows[0];
      assert.equal(rebound.device_id, reattachDeviceId);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM consoles')).rows[0].n,
        1,
        'Reattaching the agent must not duplicate the PS5',
      );
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM consoles WHERE id=$1', [
            temporaryConsoleId,
          ])
        ).rows[0].n,
        0,
        'The temporary pairing console is removed after rebinding',
      );
      await app.close();
      app = await createApp(config);
      assert.equal(
        (await call('GET', '/device/status', undefined, credential)).status,
        200,
        'Native app pairing survives a server restart',
      );
      await db.query("UPDATE console_credentials SET revoked_at=now() WHERE kind='FRONTEND'");
      assert.equal((await call('GET', '/device/status', undefined, credential)).status, 401);
      assert.equal(
        (await call('POST', '/device/heartbeat', report, reattached.body.credential)).status,
        200,
        'Revoking a frontend leaves the replacement agent intact',
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
