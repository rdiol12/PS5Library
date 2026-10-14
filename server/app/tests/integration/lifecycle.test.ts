import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { runWorker } from '../../src/library/inspect.js';
import { passwordHash } from '../../src/auth/credentials.js';

test(
  'real PostgreSQL/Redis: pairing → catalog → verified download → transfer → inventory → restart',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-check-'));
    const publicOrigin = 'http://store.example:3150',
      localOrigin = 'http://127.0.0.1:3150';
    const config = {
      ...configuration({
        ...process.env,
        PUBLIC_URL: publicOrigin,
        BROWSER_ORIGINS: `${localOrigin}, http://localhost:3150`,
        OPERATOR_URL: '',
        OPERATOR_TOKEN: '',
      }),
      DUMP_ROOT: '',
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DISK_MARGIN_BYTES: 0,
    };
    const adminDb = database(config.DATABASE_URL);
    const schema = `ps5library_test_${randomUUID().replaceAll('-', '')}`;
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(config.DATABASE_URL);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    config.DATABASE_URL = databaseUrl.href;
    await mkdir(config.SOURCE_ROOT);
    let app = await createApp(config);
    const call = async (
      method: string,
      url: string,
      payload?: unknown,
      token?: string,
      origin?: string,
    ) => {
      const response = await app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        payload,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(origin ? { origin } : {}),
        },
      });
      return { status: response.statusCode, body: response.json() };
    };
    const name = `check-${randomUUID()}`;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    try {
      for (const origin of [publicOrigin, localOrigin, 'http://localhost:3150', undefined]) {
        assert.equal(
          (await call('POST', '/auth/logout', {}, undefined, origin)).status,
          200,
          `Accept configured browser origin or native request: ${origin}`,
        );
      }
      for (const origin of [
        'https://attacker.example',
        'null',
        'http://127.0.0.1:3151',
        'http://127.0.0.1.attacker.example:3150',
      ]) {
        for (const method of ['POST', 'PATCH', 'DELETE']) {
          const denied = await call(method, '/auth/logout', {}, undefined, origin);
          assert.equal(denied.status, 403);
          assert.equal(denied.body.error, 'ORIGIN_DENIED');
        }
        const socket = await app.inject({
          url: '/api/v1/events/live',
          headers: {
            origin,
            host: new URL(origin === 'null' ? 'http://attacker.example' : origin).host,
            upgrade: 'websocket',
            connection: 'upgrade',
            'sec-websocket-version': '13',
            'sec-websocket-key': Buffer.alloc(16).toString('base64'),
          },
        });
        assert.equal(
          socket.statusCode,
          403,
          'WebSocket origin must not trust an attacker-controlled Host',
        );
      }
      assert.equal(
        (
          await call(
            'POST',
            '/auth/register',
            {
              username: name,
              password: 'eleven' + 'chars',
              bootstrapToken: config.BOOTSTRAP_TOKEN,
            },
            undefined,
            localOrigin,
          )
        ).status,
        400,
      );
      // First bootstrap only; subsequent runs create an isolated account with the local bootstrap secret.
      const user = await call(
        'POST',
        '/auth/register',
        { username: name, password: 'twelve-' + 'chars', bootstrapToken: config.BOOTSTRAP_TOKEN },
        undefined,
        localOrigin,
      );
      assert.equal(user.status, 201, JSON.stringify(user.body));
      const token = user.body.token;
      const legacyDb = database(config.DATABASE_URL);
      await legacyDb.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
        await passwordHash('abcde'),
        user.body.user.id,
      ]);
      await legacyDb.end();
      assert.equal(
        (
          await call(
            'POST',
            '/auth/login',
            { username: name, password: 'abcde' },
            undefined,
            publicOrigin,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            'POST',
            '/auth/login',
            { username: name, password: 'wrong' },
            undefined,
            localOrigin,
          )
        ).status,
        401,
      );
      const cookieLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: localOrigin },
        payload: { username: name, password: 'abcde' },
      });
      assert.equal(cookieLogin.statusCode, 200);
      const sessionCookie = cookieLogin.cookies.find((c) => c.name === 'session')!;
      assert.ok(sessionCookie.httpOnly);
      assert.equal(sessionCookie.sameSite, 'Strict');
      assert.equal(
        (await app.inject({ url: '/api/v1/me', cookies: { session: sessionCookie.value } })).json()
          .id,
        user.body.user.id,
      );
      const live = await app.injectWS('/api/v1/events/live', {
        headers: { origin: localOrigin, cookie: `session=${sessionCookie.value}` },
      });
      live.close();
      const invite = await call('POST', '/admin/invites', {}, token);
      assert.equal(invite.status, 201);
      const friend = await call('POST', '/auth/register', {
        username: `friend-${randomUUID()}`,
        password: 'test-friend-integration-password',
        inviteToken: invite.body.token,
      });
      assert.equal(friend.status, 201);
      const friendToken = friend.body.token;
      assert.equal((await call('POST', '/admin/invites', {}, friendToken)).status, 403);
      assert.equal(
        (
          await call('POST', '/auth/register', {
            username: `replay-${randomUUID()}`,
            password: 'test-friend-integration-password',
            inviteToken: invite.body.token,
          })
        ).status,
        403,
      );
      const pendingDevice = randomUUID(),
        pending = await call('POST', '/pairings', {
          deviceId: pendingDevice,
          name: 'Expired code check',
          clientKind: 'SIMULATOR',
        });
      const pairingDb = database(config.DATABASE_URL);
      await pairingDb.query(
        "UPDATE pairings SET expires_at=now()-interval '1 second' WHERE id=$1",
        [pending.body.id],
      );
      assert.equal(
        (
          await call('POST', '/pairings', {
            deviceId: pendingDevice,
            name: 'Renewed code',
            clientKind: 'SIMULATOR',
          })
        ).status,
        201,
        'An unclaimed expired identity can request a fresh code',
      );
      assert.equal(
        (
          await pairingDb.query('SELECT count(*)::int AS n FROM pairings WHERE id=$1', [
            pending.body.id,
          ])
        ).rows[0].n,
        0,
        'Expired pairing secrets are removed',
      );
      assert.equal(
        (
          await pairingDb.query('SELECT count(*)::int AS n FROM consoles WHERE device_id=$1', [
            pendingDevice,
          ])
        ).rows[0].n,
        1,
        'Expired orphan console identities are replaced without accumulating rows',
      );
      await pairingDb.end();
      assert.equal(
        (await call('POST', '/pairings/claim', { code: pending.body.code }, token)).status,
        410,
      );
      const pair = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Development console',
        clientKind: 'SIMULATOR',
      });
      assert.equal(pair.status, 201);
      assert.equal(
        (await call('POST', '/pairings/claim', { code: pair.body.code }, token)).status,
        200,
      );
      assert.equal(
        (await call('POST', '/pairings/claim', { code: pair.body.code }, token)).status,
        409,
      );
      const poll = await call('POST', `/pairings/${pair.body.id}/poll`, {
        pollSecret: pair.body.pollSecret,
      });
      assert.equal(poll.status, 200);
      const deviceToken = poll.body.credential,
        consoleId = poll.body.consoleId;
      const summary = {
        localUserId: '12345678',
        source: 'LOCAL_SUMMARY',
        sourceSha256: 'a'.repeat(64),
        modifiedAt: 1741335221,
        earnedTrophies: { platinum: 0, gold: 0, silver: 0, bronze: 4 },
      };
      const saveData = {
        source: 'LOCAL_SAVE_DATABASES',
        localUserId: '12345678',
        complete: true,
        items: [
          {
            platform: 'PS5',
            gameTitleId: 'PPSA10001',
            saveTitleId: 'PPSA10000',
            directory: 'autosave',
            title: 'Current Game',
            subtitle: 'Autosave',
            detail: 'Mission 7',
            sizeBytes: 4194304,
            modifiedAt: 1789237800,
          },
        ],
      };
      const trophyHeartbeat = {
        firmware: '4.51',
        runtime: 'test',
        clientVersion: '0.2.1',
        agentVersion: '0.2.1',
        capabilities: {},
        storage: [],
        libraryRevision: 0,
        trophySummary: summary,
        saveData,
      };
      assert.equal(
        (await call('POST', '/device/heartbeat', trophyHeartbeat, deviceToken)).status,
        200,
      );
      const deviceLive = await app.injectWS('/api/v1/device/live', {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      const overflowClose = new Promise<number>((resolve) => deviceLive.once('close', resolve));
      deviceLive.send(JSON.stringify(trophyHeartbeat));
      deviceLive.send(JSON.stringify(trophyHeartbeat));
      assert.equal(
        await Promise.race([
          overflowClose,
          new Promise<number>((resolve) => setTimeout(() => resolve(0), 1000)),
        ]),
        1008,
        'A client cannot build an unbounded heartbeat backlog',
      );
      const deviceEvents = await call('GET', '/device/events?after=0', undefined, deviceToken);
      assert.equal(deviceEvents.status, 200);
      assert.deepEqual(deviceEvents.body, { type: 'events', events: [] });
      assert.equal(
        (await call('GET', '/profile', undefined, token)).body.consoles[0].trophySummary
          .earnedTrophies.bronze,
        4,
      );
      assert.deepEqual(
        (await call('GET', '/profile', undefined, token)).body.consoles[0].saveData,
        [{ localUserId: saveData.localUserId, ...saveData.items[0] }],
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...trophyHeartbeat, saveData: { ...saveData, complete: false, items: [] } },
            deviceToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call('GET', '/profile', undefined, token)).body.consoles[0].saveData.length,
        1,
        'A partial scan retains the last known save cache',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...trophyHeartbeat, saveData: { ...saveData, items: [] } },
            deviceToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call('GET', '/profile', undefined, token)).body.consoles[0].saveData.length,
        0,
        'A complete scan removes missing save slots',
      );
      assert.equal(
        (await call('POST', '/device/heartbeat', trophyHeartbeat, deviceToken)).status,
        200,
      );
      const heartbeatDb = database(config.DATABASE_URL),
        saveVersion = (
          await heartbeatDb.query(
            'SELECT xmin::text AS version FROM console_save_data WHERE console_id=$1',
            [consoleId],
          )
        ).rows[0].version;
      const trophySyncedAt = (
        await heartbeatDb.query('SELECT trophy_synced_at FROM consoles WHERE id=$1', [consoleId])
      ).rows[0].trophy_synced_at;
      assert.equal(
        (await call('POST', '/device/heartbeat', trophyHeartbeat, deviceToken)).status,
        200,
      );
      assert.equal(
        (
          await heartbeatDb.query(
            'SELECT xmin::text AS version FROM console_save_data WHERE console_id=$1',
            [consoleId],
          )
        ).rows[0].version,
        saveVersion,
        'An unchanged save snapshot must not rewrite cached save rows',
      );
      assert.equal(
        (
          await heartbeatDb.query('SELECT trophy_synced_at FROM consoles WHERE id=$1', [consoleId])
        ).rows[0].trophy_synced_at.getTime(),
        trophySyncedAt.getTime(),
        'An unchanged trophy summary must not advance its sync timestamp',
      );
      await heartbeatDb.end();
      assert.equal(
        (await call('GET', '/profile', undefined, friendToken)).body.consoles.length,
        0,
        'Trophy summaries are private to the console owner',
      );
      assert.equal((await call('GET', '/profile', undefined, deviceToken)).status, 401);
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            {
              ...trophyHeartbeat,
              trophySummary: {
                ...summary,
                earnedTrophies: { ...summary.earnedTrophies, bronze: -1 },
              },
            },
            deviceToken,
          )
        ).status,
        400,
      );
      assert.equal((await call('GET', '/consoles', undefined, friendToken)).body.length, 0);
      assert.equal(
        (await call('PATCH', `/consoles/${consoleId}`, { name: 'Stolen' }, friendToken)).status,
        404,
      );
      assert.equal(
        (await call('POST', `/consoles/${consoleId}/revoke`, {}, friendToken)).status,
        404,
      );
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/library`, undefined, friendToken)).status,
        404,
      );
      const heartbeat = {
        firmware: '9.60',
        runtime: 'development',
        clientVersion: '0.1.0',
        agentVersion: '0.1.0',
        capabilities: {
          homebrew: true,
          rangeDownloads: true,
          storageEnumeration: true,
          inventoryScan: true,
        },
        storage: [
          {
            storageId: 'internal',
            displayName: 'Internal Storage',
            path: '/data',
            totalBytes: 1000000000,
            freeBytes: 900000000,
            writable: true,
            installMethodsSupported: ['HOMEBREW'],
          },
          {
            storageId: 'internal-installed',
            displayName: 'Internal Storage',
            path: '/user',
            totalBytes: 1000000000,
            freeBytes: 900000000,
            writable: false,
            installMethodsSupported: [],
          },
        ],
        libraryRevision: 1,
        inventory: [],
        inventoryComplete: true,
      };
      const staleStorage = database(config.DATABASE_URL);
      await staleStorage.query(
        `INSERT INTO console_storage(
          console_id,
          storage_id,
          display_name,
          path,
          total_bytes,
          free_bytes,
          writable,
          methods
        )
        VALUES(
          $1,
          'gone-usb',
          'Disconnected USB',
          '/mnt/usb0',
          2097152,
          1736704,
          true,
          '["SHADOWMOUNT"]'
        )`,
        [consoleId],
      );
      await staleStorage.end();
      assert.equal((await call('POST', '/device/heartbeat', heartbeat, deviceToken)).status, 200);
      assert.equal((await call('GET', '/consoles', undefined, token)).body[0].presence, 'ONLINE');
      for (const [route, credential] of [
        ['/consoles', token],
        ['/device/consoles', deviceToken],
        ['/device/status', deviceToken],
      ]) {
        const response = (await call('GET', route, undefined, credential)).body;
        const storage = (Array.isArray(response) ? response[0] : response).storage;
        assert.deepEqual(
          storage.map((s: any) => s.storageId),
          ['internal'],
          'Inventory roots must not duplicate the physical storage selector',
        );
        assert.equal(storage[0].writable, true);
      }
      assert.equal((await call('GET', '/catalog', undefined, deviceToken)).status, 401);
      const sample = Buffer.alloc(65536, 0);
      sample.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
      sample.writeUInt16LE(2, 16);
      sample.writeUInt16LE(62, 18);
      sample.writeUInt32LE(1, 20);
      sample.writeBigUInt64LE(0x400080n, 24);
      sample.writeBigUInt64LE(64n, 32);
      sample.writeUInt16LE(64, 52);
      sample.writeUInt16LE(56, 54);
      sample.writeUInt16LE(1, 56);
      sample.writeUInt32LE(1, 64);
      sample.writeUInt32LE(5, 68);
      sample.writeBigUInt64LE(0x400000n, 80);
      sample.writeBigUInt64LE(BigInt(sample.length), 96);
      sample.writeBigUInt64LE(BigInt(sample.length), 104);
      sample.writeBigUInt64LE(4096n, 112);
      sample[128] = 0xc3;
      const digest = createHash('sha256').update(sample).digest('hex');
      const sourceFolder = path.join(config.SOURCE_ROOT, user.body.user.id, name);
      await mkdir(sourceFolder, { recursive: true });
      await writeFile(path.join(sourceFolder, 'demo.elf'), sample);
      const metadata = {
        title: 'PS5Library Homebrew',
        titleId: 'PPSA99999',
        contentId: 'IV0000-PPSA99999_00-PS5LIBRARYDEMO00',
        description: 'Generated integration fixture',
      };
      await writeFile(
        path.join(sourceFolder, 'library.json'),
        JSON.stringify({
          schemaVersion: 1,
          releases: [
            {
              key: 'demo',
              game: metadata,
              version: '01.00',
              size: sample.length,
              minimumFirmware: '1.00',
              format: 'elf',
              sha256: digest,
              location: 'demo.elf',
            },
          ],
        }),
      );
      const source = await call(
        'POST',
        '/sources',
        { name: 'Local homebrew', type: 'LOCAL_FOLDER', location: name },
        token,
      );
      assert.equal(source.status, 201, JSON.stringify(source.body));
      assert.equal((await call('POST', `/sources/${source.body.id}/sync`, {}, token)).status, 200);
      const catalog = await call('GET', '/catalog', undefined, token);
      assert.equal(catalog.body.length, 1);
      assert.equal((await call('GET', '/catalog', undefined, friendToken)).body.length, 0);
      assert.equal((await call('GET', '/sources', undefined, friendToken)).body.length, 0);
      assert.equal(
        (await call('POST', `/sources/${source.body.id}/sync`, {}, friendToken)).status,
        404,
      );
      const releaseId = catalog.body[0].releases[0].id;
      const sourceReleaseId = catalog.body[0].releases[0].sources[0].id;
      const download = await call('POST', '/downloads', { sourceReleaseId }, token);
      assert.equal(download.status, 202, JSON.stringify(download.body));
      let job: any;
      for (let i = 0; i < 100; i++) {
        job = (await call('GET', `/jobs/${download.body.id}`, undefined, token)).body;
        if (['COMPLETED', 'ERROR'].includes(job.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(job.state, 'COMPLETED', JSON.stringify(job));
      assert.equal(job.downloadedBytes, sample.length);
      assert.equal((await call('GET', `/jobs/${job.id}`, undefined, friendToken)).status, 404);
      assert.equal(
        (await call('POST', '/downloads', { sourceReleaseId }, friendToken)).status,
        404,
      );
      assert.equal((await call('GET', '/events?after=0', undefined, friendToken)).body.length, 0);
      assert.equal(
        (await call('GET', `/artwork/${catalog.body[0].id}/cover`, undefined, friendToken)).status,
        404,
      );
      assert.equal(
        (await call('POST', '/transfers/plan', { releaseId, consoleId }, friendToken)).status,
        404,
      );
      const plan = await call('POST', '/transfers/plan', { releaseId, consoleId }, token);
      assert.equal(plan.body.compatibility.status, 'NATIVE_COMPATIBLE');
      assert.deepEqual(
        plan.body.storage.map((s: any) => s.storageId),
        ['internal'],
      );
      assert.equal(
        plan.body.storage[0].allowed,
        true,
        'A writable internal destination with enough space is selectable',
      );
      assert.equal(plan.body.storage[0].reason, null);
      const transfer = await call(
        'POST',
        '/transfers',
        { artifactId: job.artifactId, consoleId, storageId: 'internal' },
        token,
      );
      assert.equal(transfer.status, 202, JSON.stringify(transfer.body));
      assert.equal(
        (await call('DELETE', `/artifacts/${job.artifactId}`, undefined, token)).status,
        409,
      );
      const tasks = await call('GET', '/device/tasks', undefined, deviceToken);
      assert.equal(tasks.body[0].id, transfer.body.id);
      // A malicious/premature completed message cannot make an artifact appear installed.
      assert.equal(
        (
          await call(
            'POST',
            `/device/tasks/${transfer.body.id}/progress`,
            { state: 'READY_ON_PS5', downloadedBytes: sample.length, sha256: digest },
            deviceToken,
          )
        ).status,
        409,
      );
      const range = await app.inject({
        method: 'GET',
        url: `/api/v1/device/artifacts/${job.artifactId}`,
        headers: { authorization: `Bearer ${deviceToken}`, range: 'bytes=100-199' },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.rawPayload.length, 100);
      assert.equal(
        (
          await call(
            'POST',
            `/device/tasks/${transfer.body.id}/progress`,
            { state: 'TRANSFERRING', downloadedBytes: 100 },
            deviceToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/tasks/${transfer.body.id}/progress`,
            { state: 'VERIFYING', downloadedBytes: sample.length, sha256: digest },
            deviceToken,
          )
        ).status,
        200,
      );
      heartbeat.libraryRevision = 2;
      const inventory = [
        {
          releaseId,
          ...metadata,
          version: '01.00',
          storageId: 'internal',
          relativePath: 'homebrew/demo.elf',
          sha256: digest,
          size: sample.length,
          available: true,
          registered: false,
        },
      ];
      assert.equal(
        (await call('POST', '/device/heartbeat', { ...heartbeat, inventory }, deviceToken)).status,
        200,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/tasks/${transfer.body.id}/progress`,
            { state: 'READY_ON_PS5', downloadedBytes: sample.length, sha256: digest },
            deviceToken,
          )
        ).status,
        200,
      );
      await t.test(
        'shared catalog reuses verified cache without exposing accounts, sources or jobs',
        async () => {
          const gameId = catalog.body[0].id;
          assert.equal(
            (await call('PATCH', `/games/${gameId}/sharing`, { shared: true }, friendToken)).status,
            403,
          );
          assert.equal(
            (await call('PATCH', `/games/${gameId}/sharing`, { shared: true }, token)).status,
            200,
          );
          const shared = (await call('GET', '/catalog', undefined, friendToken)).body;
          assert.equal(shared.length, 1);
          assert.equal(shared[0].shared, true);
          assert.equal(shared[0].canManage, false);
          assert.equal(shared[0].releases[0].sources[0].id, sourceReleaseId);
          assert.equal(
            (
              await app.inject({
                url: `/api/v1/artwork/${gameId}/cover`,
                headers: { authorization: `Bearer ${friendToken}` },
              })
            ).statusCode,
            200,
          );
          const cached = await call('POST', '/downloads', { sourceReleaseId }, friendToken);
          assert.equal(cached.status, 202);
          assert.equal(cached.body.cached, true);
          assert.equal(cached.body.artifactId, job.artifactId);
          assert.equal((await call('GET', '/jobs', undefined, friendToken)).body.length, 0);
          assert.equal((await call('GET', '/sources', undefined, friendToken)).body.length, 0);
          assert.equal((await call('GET', '/consoles', undefined, friendToken)).body.length, 0);
          assert.equal(
            (await call('DELETE', `/artifacts/${job.artifactId}`, undefined, friendToken)).status,
            404,
          );
          assert.equal(
            (await call('POST', '/transfers/plan', { releaseId, consoleId }, friendToken)).status,
            404,
          );
          assert.equal(
            (await call('PATCH', `/games/${gameId}/sharing`, { shared: false }, token)).status,
            200,
          );
          assert.equal((await call('GET', '/catalog', undefined, friendToken)).body.length, 0);
          assert.equal(
            (await call('POST', '/downloads', { sourceReleaseId }, friendToken)).status,
            404,
          );
        },
      );
      await app.close();
      app = await createApp(config);
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body[0].state,
        'READY_ON_PS5',
      );
      assert.equal((await call('GET', '/device/tasks', undefined, deviceToken)).status, 200);
      heartbeat.libraryRevision = 3;
      await call('POST', '/device/heartbeat', heartbeat, deviceToken);
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body[0].state,
        'MISSING',
      );
      assert.ok((await call('GET', '/events?after=0', undefined, token)).body.length > 0);
      assert.equal(
        (await call('DELETE', `/artifacts/${job.artifactId}`, undefined, friendToken)).status,
        404,
      );
      assert.equal(
        (await call('DELETE', `/artifacts/${job.artifactId}`, undefined, token)).status,
        200,
      );
      assert.equal(
        (await call('GET', '/catalog', undefined, token)).body[0].releases[0].artifacts.length,
        0,
      );
      const prepared = path.join(sourceFolder, 'prepared');
      await mkdir(path.join(prepared, 'sce_sys'), { recursive: true });
      await writeFile(path.join(prepared, 'eboot.bin'), sample);
      const game = {
        ...metadata,
        title: 'Cache check homebrew',
        titleId: 'PPSA99998',
        contentId: metadata.contentId.replace('99999', '99998'),
      };
      await writeFile(
        path.join(prepared, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: game.titleId,
          contentId: game.contentId,
          contentVersion: '01.00',
          localizedParameters: { 'en-US': { titleName: game.title } },
        }),
      );
      const tree = await runWorker(['hash-tree', prepared]);
      await writeFile(
        path.join(sourceFolder, 'library.json'),
        JSON.stringify({
          schemaVersion: 1,
          releases: [
            {
              key: 'prepared',
              game,
              version: '01.00',
              size: tree.size,
              format: 'folder',
              sha256: tree.sha256,
              location: 'prepared',
            },
          ],
        }),
      );
      const automatic = await call(
        'POST',
        '/sources',
        {
          name: 'Scheduled local source',
          type: 'LOCAL_FOLDER',
          location: name,
          scanIntervalMinutes: 5,
        },
        token,
      );
      assert.equal(automatic.status, 201);
      let buildSource: string | undefined, buildGameId: string | undefined;
      for (let i = 0; i < 150 && !buildSource; i++) {
        const games = (await call('GET', '/catalog', undefined, token)).body,
          found = games.find((g: any) => g.titleId === game.titleId);
        buildGameId = found?.id;
        buildSource = found?.releases[0]?.sources[0]?.id;
        if (!buildSource) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(buildSource, 'Scheduled scan discovered prepared game');
      const request = { sourceReleaseId: buildSource, method: 'FPKG' };
      assert.equal(
        (await call('PATCH', `/games/${buildGameId}/sharing`, { shared: true }, token)).status,
        200,
      );
      const memberBuild = await call('POST', '/preparations', request, friendToken);
      assert.equal(memberBuild.status, 403, JSON.stringify(memberBuild.body));
      assert.equal(memberBuild.body.error, 'ADMIN_REQUIRED');
      const build = await call('POST', '/preparations', request, token);
      assert.equal(build.status, 202, JSON.stringify(build.body));
      let built: any;
      for (let i = 0; i < 300; i++) {
        built = (await call('GET', `/jobs/${build.body.id}`, undefined, token)).body;
        if (['COMPLETED', 'ERROR'].includes(built.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(built.state, 'COMPLETED', JSON.stringify(built));
      assert.equal(built.progress.completedStages, 7);
      const again = await call('POST', '/preparations', request, token);
      assert.equal(again.body.cached, true);
      assert.equal(again.body.artifactId, built.artifactId);
      assert.equal(
        (await runWorker(['hash-tree', prepared])).sha256,
        tree.sha256,
        'Original dump remains unchanged',
      );
      const db = database(config.DATABASE_URL);
      await db.query("UPDATE artifacts SET inspection=inspection-'installedImage' WHERE id=$1", [
        built.artifactId,
      ]);
      await db.query(
        "UPDATE game_releases SET metadata=jsonb_set(metadata,'{minimumFirmware}','\"1.00\"') WHERE id=$1",
        [built.releaseId],
      );
      await db.query(
        'UPDATE console_capabilities SET ' +
          'capabilities=capabilities||\'{"fpkgInstall":true,"nativeDownloads":true}\'::jsonb WHERE ' +
          'console_id=$1',
        [consoleId],
      );
      await db.query('UPDATE consoles SET last_seen=now() WHERE id=$1', [consoleId]);
      const repaired = await call(
        'POST',
        '/transfers',
        { artifactId: built.artifactId, consoleId, storageId: 'internal-installed' },
        token,
      );
      assert.equal(repaired.status, 202, JSON.stringify(repaired.body));
      assert.ok(
        (
          await db.query(
            "SELECT inspection->'installedImage' AS image FROM artifacts WHERE id=$1",
            [built.artifactId],
          )
        ).rows[0].image,
        'A verified legacy package is reinspected instead of rebuilt',
      );
      await db.query("UPDATE jobs SET state='CANCELLED' WHERE id=$1", [repaired.body.id]);
      assert.equal(
        (await call('DELETE', `/artifacts/${built.artifactId}`, undefined, friendToken)).status,
        404,
      );
      assert.equal(
        (await call('DELETE', `/artifacts/${built.artifactId}`, undefined, token)).status,
        200,
      );
      assert.equal(
        (await call('POST', `/games/${catalog.body[0].id}/save`, { saved: true }, token)).status,
        200,
      );
      assert.equal(
        (await call('POST', `/games/${catalog.body[0].id}/save`, { saved: true }, friendToken))
          .status,
        404,
      );
      const installBody = { sourceReleaseId, consoleId, storageId: 'internal' };
      assert.equal((await call('POST', '/installations', installBody, friendToken)).status, 404);
      const install = await call('POST', '/installations', installBody, deviceToken);
      assert.equal(install.status, 401, 'User endpoint does not accept a console credential');
      await db.query("UPDATE consoles SET last_seen=now()-interval '3 minutes' WHERE id=$1", [
        consoleId,
      ]);
      const cancelled = await call('POST', '/device/installations', installBody, deviceToken);
      assert.equal(cancelled.status, 202, JSON.stringify(cancelled.body));
      assert.equal(
        (await call('DELETE', `/installations/${cancelled.body.id}`, undefined, friendToken))
          .status,
        404,
      );
      assert.equal(
        (await call('DELETE', `/device/installations/${cancelled.body.id}`, undefined, deviceToken))
          .status,
        200,
      );
      assert.equal(
        (await call('GET', '/device/installations', undefined, deviceToken)).body.find(
          (v: any) => v.id === cancelled.body.id,
        )?.state,
        'CANCELLED',
      );
      const accepted = await call('POST', '/device/installations', installBody, deviceToken);
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      assert.equal(
        (await call('POST', '/installations', installBody, token)).body.id,
        accepted.body.id,
        'Repeated confirmation is idempotent',
      );
      let waiting: any;
      for (let i = 0; i < 120; i++) {
        waiting = (await call('GET', '/device/installations', undefined, deviceToken)).body.find(
          (v: any) => v.id === accepted.body.id,
        );
        if (waiting?.state === 'WAITING_FOR_PS5' || waiting?.state === 'ERROR') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(waiting?.state, 'WAITING_FOR_PS5', JSON.stringify(waiting));
      assert.equal((await call('POST', '/device/heartbeat', heartbeat, deviceToken)).status, 200);
      await app.close();
      app = await createApp(config);
      let installed: any;
      for (let i = 0; i < 120; i++) {
        installed = (await call('GET', '/installations', undefined, token)).body.find(
          (v: any) => v.id === accepted.body.id,
        );
        if (installed?.transferJobId || installed?.state === 'ERROR') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(installed?.transferJobId, JSON.stringify(installed));
      const queuedJobs = (await call('GET', '/device/jobs', undefined, deviceToken)).body;
      assert.equal(
        queuedJobs.filter((v: any) => v.id === installed.transferJobId).length,
        1,
        'The transfer is listed once',
      );
      assert.equal((await call('GET', '/installations', undefined, friendToken)).body.length, 0);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM jobs WHERE config->>'installationId'=$1 AND kind='TRANSFER'",
            [accepted.body.id],
          )
        ).rows[0].n,
        1,
      );
      await db.query(
        "UPDATE console_library_entries SET state='READY_ON_PS5',registered=true WHERE console_id=$1 " +
          'AND release_id=(SELECT release_id FROM source_releases WHERE id=$2)',
        [consoleId, sourceReleaseId],
      );
      const alreadyInstalled = await call(
        'POST',
        '/device/installations',
        installBody,
        deviceToken,
      );
      assert.equal(alreadyInstalled.status, 409);
      assert.equal(
        alreadyInstalled.body.error,
        'ALREADY_INSTALLED',
        'A confirmed console copy cannot be queued again',
      );
      await db.query(
        "UPDATE console_library_entries SET state='QUEUED_FOR_PS5',registered=false WHERE " +
          'console_id=$1 AND release_id=(SELECT release_id FROM source_releases WHERE id=$2)',
        [consoleId, sourceReleaseId],
      );
      assert.ok((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n > 0);
      const legacy = {
        titleId: 'PPSA03208',
        contentId: 'EP9000-PPSA03208_00-GHOSTSHIP0000000',
        title: 'Existing console dump',
        version: '02.017.000',
        storageId: 'internal',
        relativePath: 'PPSA03208-app0',
        sha256: null,
        size: null,
        source: 'EXISTING_DUMP',
        available: true,
        registered: false,
        backportFiles: true,
      };
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            {
              ...heartbeat,
              libraryRevision: 100,
              inventory: [legacy],
              runtimeStatus: {
                shadowMount: 'RUNNING',
                kstuff: 'RUNNING',
                backPork: 'NOT_RUNNING',
                fakelibEnabled: true,
                externalFpkgPatch: true,
              },
            },
            deviceToken,
          )
        ).status,
        200,
      );
      const imported = (await call('GET', '/catalog', undefined, token)).body.find(
        (g: any) => g.titleId === legacy.titleId,
      );
      assert.equal(imported.title, legacy.title);
      assert.equal(imported.releases[0].format, 'folder');
      const onConsole = (
        await call('GET', `/consoles/${consoleId}/library`, undefined, token)
      ).body.find((r: any) => r.titleId === legacy.titleId);
      assert.equal(onConsole.state, 'READY_ON_PS5');
      assert.equal(onConsole.source, 'EXISTING_DUMP');
      assert.equal(onConsole.registered, false);
      assert.equal(onConsole.backportFiles, true);
      const consoleStatus = (await call('GET', '/consoles', undefined, token)).body[0];
      assert.equal(consoleStatus.runtimeStatus.shadowMount, 'RUNNING');
      assert.equal(consoleStatus.runtimeStatus.externalFpkgPatch, true);
      assert.equal(
        (await call('POST', '/device/library/artwork', {}, deviceToken)).status,
        404,
        'Console artwork stays on the console',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            { ...heartbeat, libraryRevision: 101, inventory: [] },
            deviceToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body.find(
          (r: any) => r.titleId === legacy.titleId,
        ).state,
        'MISSING',
      );
      await t.test(
        'installed PS4 packages remain owner-scoped and reconcile without fabricated checksums',
        async () => {
          const apps = path.join(root, 'console-apps'),
            titleId = 'CUSA99997';
          const packagePath = path.join(apps, titleId, 'app.pkg');
          await mkdir(path.dirname(packagePath), { recursive: true });
          await writeFile(packagePath, Buffer.from('installed PS4 package fixture'));
          const size = (await stat(packagePath)).size;
          assert.ok(size > 0);
          const ps4 = {
            titleId,
            contentId: `IV0000-${titleId}_00-PS4LIBRARYDEMO00`,
            title: 'Installed PS4 fixture',
            platform: 'PS4',
            version: '01.00',
            storageId: 'internal',
            relativePath: `${titleId}/app.pkg`,
            source: 'INSTALLED_TITLE',
            sha256: null,
            size,
            available: true,
            registered: true,
          };
          const report = {
            ...heartbeat,
            libraryRevision: 102,
            storage: [{ ...heartbeat.storage[0], path: apps }],
            inventory: [ps4],
            inventoryComplete: true,
          };
          const accepted = await call('POST', '/device/heartbeat', report, deviceToken);
          assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
          const imported = (await call('GET', '/catalog', undefined, token)).body.find(
            (g: any) => g.titleId === titleId,
          );
          assert.ok(imported);
          assert.equal(imported.platform, 'PS4');
          assert.equal(imported.releases[0].format, 'pkg');
          assert.equal(imported.releases[0].size, size);
          const entries = (await call('GET', `/consoles/${consoleId}/library`, undefined, token))
            .body;
          const entry = entries.find((r: any) => r.titleId === titleId);
          assert.equal(entry.state, 'READY_ON_PS5');
          assert.equal(entry.source, 'INSTALLED_TITLE');
          assert.equal(entry.registered, true);
          const stored = (
            await db.query(
              'SELECT sha256,size,relative_path FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
              [consoleId, imported.releases[0].id],
            )
          ).rows[0];
          assert.equal(stored.sha256, null, 'Discovery must not invent a whole-package checksum');
          assert.equal(Number(stored.size), size);
          assert.equal(stored.relative_path, ps4.relativePath);
          assert.equal(
            (await call('GET', '/catalog', undefined, friendToken)).body.some(
              (g: any) => g.titleId === titleId,
            ),
            false,
          );
          assert.equal(
            (await call('GET', `/consoles/${consoleId}/library`, undefined, friendToken)).status,
            404,
          );
          const profile = await call('GET', '/device/profile', undefined, deviceToken);
          assert.equal(profile.status, 200);
          const profileGame = profile.body.consoles
            .find((c: any) => c.id === consoleId)
            .games.find((g: any) => g.titleId === titleId);
          assert.equal(profileGame.available, true);
          assert.equal(profileGame.platform, 'PS4');
          assert.equal(profileGame.trophies.status, 'UNAVAILABLE');
          assert.equal(
            (await call('POST', '/profile/avatar', { data: png.toString('base64') }, deviceToken))
              .status,
            401,
          );
          assert.equal(
            (await call('POST', '/profile/avatar', { data: 'not-base64' }, token)).status,
            400,
          );
          assert.equal(
            (await call('POST', '/profile/avatar', { data: png.toString('base64') }, token)).status,
            200,
          );
          const avatar = (await call('GET', '/profile', undefined, token)).body.avatarUrl;
          assert.ok(avatar);
          const ownerAvatar = await app.inject({
            url: avatar,
            headers: { authorization: `Bearer ${token}` },
          });
          assert.equal(ownerAvatar.headers['content-type'], 'image/webp');
          assert.equal(
            (await app.inject({ url: avatar, headers: { authorization: `Bearer ${deviceToken}` } }))
              .statusCode,
            200,
          );
          assert.equal(
            (await app.inject({ url: avatar, headers: { authorization: `Bearer ${friendToken}` } }))
              .statusCode,
            404,
            'Avatar URL cannot grant access to a different account',
          );
          assert.equal(
            (await call('PUT', '/device/profile/avatar', { gameId: imported.id }, deviceToken))
              .status,
            404,
            'A game without cached art cannot become an avatar',
          );
          assert.equal((await call('DELETE', '/profile/avatar', {}, token)).status, 200);
          assert.equal((await call('GET', '/profile', undefined, token)).body.avatarUrl, null);
          assert.equal(
            (
              await call(
                'POST',
                '/device/heartbeat',
                { ...report, libraryRevision: 103, inventory: [] },
                deviceToken,
              )
            ).status,
            200,
          );
          assert.equal(
            (await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body.find(
              (r: any) => r.titleId === titleId,
            ).state,
            'MISSING',
          );
          assert.equal(
            (await call('GET', '/profile', undefined, token)).body.consoles
              .find((c: any) => c.id === consoleId)
              .games.find((g: any) => g.titleId === titleId).available,
            false,
          );
        },
      );
      await db.end();
    } finally {
      await app.close();
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminDb.end();
    }
  },
);
