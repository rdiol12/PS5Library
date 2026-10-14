import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { runWorker } from '../../src/library/inspect.js';
import { cacheArtwork } from '../../src/artwork/cache.js';

test(
  'saved firmware selects verified backport files, real FPKG variants and private native downloads',
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-backport-'));
    const config = {
      ...configuration(process.env),
      DUMP_ROOT: '',
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DISK_MARGIN_BYTES: 0,
    };
    const admin = database(config.DATABASE_URL),
      schema = `backport_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    config.DATABASE_URL = url.href;
    await mkdir(config.SOURCE_ROOT);
    let app = await createApp(config);
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
      const r = await app.inject({
        method: method as 'GET',
        url: '/api/v1' + url,
        payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: r.statusCode, body: r.json() };
    };
    try {
      const user = (
        await call('POST', '/auth/register', {
          username: 'fw-' + randomUUID(),
          password: 'test-backport-password',
          bootstrapToken: config.BOOTSTRAP_TOKEN,
        })
      ).body;
      const pair = (
        await call('POST', '/pairings', {
          deviceId: randomUUID(),
          name: 'Old firmware',
          clientKind: 'SIMULATOR',
          firmware: '4.51',
        })
      ).body;
      await call('POST', '/pairings/claim', { code: pair.code }, user.token);
      const device = (
        await call('POST', `/pairings/${pair.id}/poll`, { pollSecret: pair.pollSecret })
      ).body;
      const report = {
        firmware: '9.60',
        runtime: 'kstuff',
        clientVersion: 'test',
        agentVersion: 'test',
        shadowMountVersion: '1.7beta2',
        capabilities: {},
        storage: [],
        libraryRevision: 0,
      };
      assert.equal(
        (await call('GET', '/consoles', undefined, user.token)).body[0].firmware,
        '4.51',
      );
      assert.equal(
        (await call('POST', '/device/heartbeat', report, device.credential)).status,
        200,
      );
      assert.equal(
        (await call('GET', '/consoles', undefined, user.token)).body[0].firmware,
        '4.51',
        'Heartbeats cannot silently replace saved firmware',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/firmware',
            { firmware: '9.60', requestId: randomUUID() },
            device.credential,
          )
        ).status,
        409,
      );
      const refresh = await call('POST', `/consoles/${device.consoleId}/refresh`, {}, user.token);
      assert.equal(refresh.status, 202);
      const pending = (await call('POST', '/device/heartbeat', report, device.credential)).body
        .firmwareRequestId;
      assert.ok(pending);
      assert.equal(
        (
          await call(
            'POST',
            '/device/firmware',
            { firmware: '9.60', requestId: pending },
            device.credential,
          )
        ).status,
        200,
      );
      await app.close();
      app = await createApp(config);
      assert.equal(
        (await call('GET', '/consoles', undefined, user.token)).body[0].firmware,
        '9.60',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/firmware',
            { firmware: '4.51', requestId: pending },
            device.credential,
          )
        ).status,
        409,
        'Refresh tokens are consumed',
      );
      const db = database(config.DATABASE_URL);
      try {
        const gameId = randomUUID(),
          releaseId = randomUUID(),
          artifactId = randomUUID(),
          backportId = randomUUID(),
          inputHash = 'a'.repeat(64),
          titleId = 'PPSA99991',
          contentId = 'IV0000-PPSA99991_00-PS5LIBRARYTEST01';
        const storage = [
          {
            storageId: 'app-data',
            displayName: 'Internal App Data',
            path: '/data',
            totalBytes: 120000000,
            freeBytes: 95000000,
            writable: true,
            installMethodsSupported: ['HOMEBREW', 'FPKG'],
          },
          {
            storageId: 'native-install',
            displayName: 'Internal Storage',
            path: '/user',
            totalBytes: 110000000,
            freeBytes: 85000000,
            writable: false,
            installMethodsSupported: [],
          },
          {
            storageId: 'usb',
            displayName: 'USB SSD',
            path: '/mnt/usb0',
            totalBytes: 100000000,
            freeBytes: 90000000,
            writable: true,
            installMethodsSupported: ['SHADOWMOUNT', 'FPKG'],
          },
          {
            storageId: 'managed-usb',
            displayName: 'USB Extended Storage',
            path: '/mnt/ext0',
            totalBytes: 200000000,
            freeBytes: 180000000,
            writable: true,
            installMethodsSupported: ['HOMEBREW', 'FPKG'],
          },
          {
            storageId: 'm2',
            displayName: 'M.2 SSD',
            path: '/mnt/ext1',
            totalBytes: 200000000,
            freeBytes: 170000000,
            writable: true,
            installMethodsSupported: ['HOMEBREW', 'FPKG'],
          },
        ];
        await call(
          'POST',
          '/device/heartbeat',
          {
            ...report,
            capabilities: {
              shadowMount: true,
              backportOverlay: true,
              fpkgBackportOverlay: true,
              fpkgInstall: true,
              nativeDownloads: true,
            },
            runtimeStatus: { externalFpkgPatch: true, fakelibDefaultMode: 'full' },
            shadowMountFakelib: true,
            storage,
          },
          device.credential,
        );
        await db.query(
          "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,'Backport check','{}')",
          [gameId, user.user.id, titleId],
        );
        await cacheArtwork(
          db,
          config,
          gameId,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
          'icon',
        );
        await db.query(
          "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'01.00','BASE',$4)",
          [
            releaseId,
            gameId,
            contentId,
            { format: 'ffpkg', minimumFirmware: '12.00', size: 1024, sha256: inputHash },
          ],
        );
        await mkdir(path.join(root, 'artifacts'));
        await writeFile(path.join(root, 'artifacts', 'test.ffpkg'), Buffer.alloc(1024));
        const imageHash = createHash('sha256').update(Buffer.alloc(1024)).digest('hex');
        await db.query(
          'INSERT INTO ' +
            'artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash) ' +
            "VALUES($1,$2,'ffpkg','artifacts/test.ffpkg',$3,1024,true,'{}',$4)",
          [artifactId, releaseId, imageHash, inputHash],
        );
        const plan = () =>
          call('POST', '/transfers/plan', { releaseId, consoleId: device.consoleId }, user.token);
        assert.equal((await plan()).body.reason, 'BACKPORT_NOT_INDEXED');
        const library = Buffer.from('authorized library fixture'),
          libraryHash = createHash('sha256').update(library).digest('hex');
        const profile = {
          titleId,
          contentId,
          gameVersion: '01.00',
          inputHashes: [inputHash],
          targetFirmware: '9.60',
          runtime: 'kstuff',
          installationMethod: 'SHADOWMOUNT',
          testedState: 'TESTED',
          requiredLibraries: [{ path: 'fakelib/libsample.sprx', sha256: libraryHash }],
          requiredPatches: [],
        };
        const saved = await call('POST', '/profiles', profile, user.token);
        assert.equal(saved.status, 201);
        assert.equal(
          (await plan()).body.reason,
          'BACKPORT_FILES_MISSING',
          'Profile metadata alone is not an available backport',
        );
        assert.ok(
          (await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) => n.code === 'BACKPORT_FILES_MISSING',
          ),
        );
        await mkdir(path.join(root, 'backports', 'fixture', 'fakelib'), { recursive: true });
        await writeFile(
          path.join(root, 'backports', 'fixture', 'fakelib', 'libsample.sprx'),
          library,
        );
        const digest = await runWorker(['hash-tree', path.join(root, 'backports', 'fixture')]);
        await db.query(
          'INSERT INTO ' +
            'backport_artifacts(id,game_id,release_id,title_id,game_version,type,source,sha256,size,input_hash,relative_path) ' +
            "VALUES($1,$2,$3,$4,'01.00','SHADOWMOUNT_FOLDER','DUMP',$5,$6,$7,'backports/fixture')",
          [backportId, gameId, releaseId, titleId, digest.sha256, digest.size, inputHash],
        );
        const raw = (await plan()).body;
        assert.equal(
          raw.backport.needsPreparation,
          true,
          'Raw libraries are not a complete ShadowMount title overlay',
        );
        const preparedId = randomUUID(),
          preparedRoot = path.join(root, 'backports', 'prepared');
        await mkdir(path.join(preparedRoot, 'fakelib'), { recursive: true });
        await mkdir(path.join(preparedRoot, 'sce_sys'));
        await writeFile(path.join(preparedRoot, 'fakelib', 'libsample.sprx'), library);
        await writeFile(
          path.join(preparedRoot, 'sce_sys', 'param.json'),
          JSON.stringify({ requiredSystemSoftwareVersion: '0x0960000000000000' }),
        );
        const preparedDigest = await runWorker(['hash-tree', preparedRoot]);
        await db.query(
          'INSERT INTO ' +
            'backport_artifacts(id,game_id,release_id,title_id,game_version,type,source,sha256,size,input_hash,relative_path,profile_id,profile_hash) ' +
            "VALUES($1,$2,$3,$4,'01.00','SHADOWMOUNT_FOLDER','DUMP',$5,$6,$7,'backports/prepared',$8,$9)",
          [
            preparedId,
            gameId,
            releaseId,
            titleId,
            preparedDigest.sha256,
            preparedDigest.size,
            inputHash,
            saved.body.id,
            raw.backport.profileHash,
          ],
        );
        const ready = (await plan()).body;
        assert.equal(ready.allowed, true);
        assert.equal(ready.backport.placement, 'SCAN_PATH');
        assert.deepEqual(ready.backport.files.map((f: any) => f.path).sort(), [
          'fakelib/libsample.sprx',
          'sce_sys/param.json',
        ]);
        await db.query(
          "UPDATE compatibility_profiles SET profile=jsonb_set(profile,'{testedState}','\"UNTESTED\"') WHERE id=$1",
          [saved.body.id],
        );
        const untested = (await plan()).body;
        assert.equal(untested.compatibility.status, 'BACKPORT_UNTESTED');
        assert.equal(untested.allowed, true);
        assert.match(untested.message, /not been tested/);
        assert.ok(
          !(await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) => n.code === 'BACKPORT_NOT_INDEXED',
          ),
          'A usable untested profile resolves the stale not-indexed warning',
        );
        await call(
          'POST',
          '/profiles',
          {
            ...profile,
            requiredLibraries: [{ path: 'fakelib/not-supplied.sprx', sha256: libraryHash }],
          },
          user.token,
        );
        assert.equal(
          (await plan()).body.compatibility.profileId,
          saved.body.id,
          'A newer incomplete profile must not hide another exact profile with available files',
        );
        const transfer = await call(
          'POST',
          '/transfers',
          { artifactId, consoleId: device.consoleId, storageId: 'usb' },
          user.token,
        );
        assert.equal(transfer.status, 202);
        const task = (await call('GET', '/device/tasks', undefined, device.credential)).body[0];
        assert.equal(task.backport.profile.id, saved.body.id);
        assert.equal(task.backport.files.length, 2);
        await call(
          'POST',
          `/device/tasks/${task.id}/progress`,
          { state: 'TRANSFERRING', downloadedBytes: 0 },
          device.credential,
        );
        await plan();
        assert.ok(
          (await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) =>
              n.code === 'TRANSFER_STARTED' &&
              n.title === 'Backport check' &&
              n.message === 'Backport check download started.',
          ),
          'Transfer start includes the game title and survives until native delivery is acknowledged',
        );
        await call(
          'POST',
          `/device/tasks/${task.id}/progress`,
          { state: 'VERIFYING', downloadedBytes: 1024, sha256: imageHash },
          device.credential,
        );
        assert.equal(
          (
            await call(
              'POST',
              `/device/tasks/${task.id}/progress`,
              { state: 'REGISTERING', downloadedBytes: 1024, sha256: imageHash },
              device.credential,
            )
          ).status,
          409,
          'Game verification cannot substitute for backport verification',
        );
        await call(
          'POST',
          `/device/tasks/${task.id}/progress`,
          { state: 'ERROR', downloadedBytes: 1024, error: 'BACKPORT_FILES_MISMATCH' },
          device.credential,
        );
        assert.ok(
          (await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) =>
              n.code === 'TRANSFER_FAILED' &&
              n.message === 'Backport check download failed. Open Downloads for details.',
          ),
          'Permanent transfer failures are durable',
        );
        await writeFile(path.join(preparedRoot, 'fakelib', 'libsample.sprx'), 'changed');
        assert.equal((await plan()).body.reason, 'BACKPORT_FILES_MISMATCH');
        const notifications = await call(
          'GET',
          '/device/notifications',
          undefined,
          device.credential,
        );
        assert.ok(notifications.body.some((n: any) => n.code === 'BACKPORT_FILES_MISMATCH'));
        // The OS downloader receives a per-job URL, never the console's long-lived credential.
        const nativeId = randomUUID(),
          installedHash = createHash('sha256').update(Buffer.alloc(512)).digest('hex');
        await db.query(
          "UPDATE game_releases SET metadata=jsonb_set(metadata,'{minimumFirmware}','\"4.00\"') WHERE id=$1",
          [releaseId],
        );
        await db.query(
          'INSERT INTO ' +
            'artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash) ' +
            "VALUES($1,$2,'pkg','artifacts/native.pkg',$3,1024,true,$4,$5)",
          [
            nativeId,
            releaseId,
            imageHash,
            { installedImage: { size: 512, sha256: installedHash } },
            inputHash,
          ],
        );
        await writeFile(path.join(root, 'artifacts', 'native.pkg'), Buffer.alloc(1024));
        await db.query("UPDATE jobs SET state='CANCELLED' WHERE id=$1", [transfer.body.id]);
        const nativeStoragePlan = (await plan()).body;
        assert.deepEqual(
          nativeStoragePlan.storage
            .filter((entry: any) => ['app-data', 'native-install'].includes(entry.storageId))
            .map((entry: any) => ({
              id: entry.storageId,
              name: entry.displayName,
              free: entry.freeBytes,
              allowed: entry.allowed,
              reason: entry.reason,
            })),
          [
            {
              id: 'native-install',
              name: 'Internal Storage',
              free: 85000000,
              allowed: true,
              reason: null,
            },
          ],
          'Native FPKG exposes one internal destination measured from /user without a duplicate /data card',
        );
        assert.deepEqual(
          nativeStoragePlan.storage
            .filter((entry: any) => ['managed-usb', 'm2'].includes(entry.storageId))
            .map((entry: any) => entry.storageId)
            .sort(),
          ['m2', 'managed-usb'],
          'Friendly storage IDs do not hide attested managed USB and native M.2 FPKG destinations',
        );
        await db.query(
          "UPDATE console_storage SET free_bytes=100 WHERE console_id=$1 AND storage_id='native-install'",
          [device.consoleId],
        );
        const stagedWithoutInternalSpace = (await plan()).body.storage.find(
          (entry: any) => entry.storageId === 'managed-usb',
        );
        assert.equal(stagedWithoutInternalSpace.allowed, false);
        assert.equal(stagedWithoutInternalSpace.reason, 'INTERNAL_STAGING_INSUFFICIENT_SPACE');
        await db.query(
          "UPDATE console_storage SET free_bytes=85000000 WHERE console_id=$1 AND storage_id='native-install'",
          [device.consoleId],
        );
        assert.equal(
          (
            await call(
              'POST',
              '/transfers',
              { artifactId: nativeId, consoleId: device.consoleId, storageId: 'usb' },
              user.token,
            )
          ).status,
          409,
          'USB is not selectable when the native installer exposes no destination parameter',
        );
        const native = await call(
          'POST',
          '/transfers',
          { artifactId: nativeId, consoleId: device.consoleId, storageId: 'native-install' },
          user.token,
        );
        assert.equal(native.status, 202);
        const nativeTask = (
          await call('GET', '/device/tasks', undefined, device.credential)
        ).body.find((entry: any) => entry.id === native.body.id);
        assert.deepEqual(
          {
            size: nativeTask.totalBytes,
            sha256: nativeTask.sha256,
            installedImage: nativeTask.installedImage,
          },
          { size: 1024, sha256: imageHash, installedImage: { size: 512, sha256: installedHash } },
          'Source transport and installed image identities remain distinct',
        );
        const grant = await call(
          'POST',
          `/device/tasks/${native.body.id}/native-download`,
          {},
          device.credential,
        );
        assert.equal(grant.status, 200);
        const packageToken = grant.body.url.split('/')[5],
          iconToken = grant.body.iconUrl.split('/')[5];
        assert.equal(
          grant.body.url,
          `/api/v1/native-downloads/${native.body.id}/${packageToken}/game.pkg`,
        );
        assert.ok(!grant.body.url.includes(device.credential));
        assert.equal(
          grant.body.iconUrl,
          `/api/v1/native-downloads/${native.body.id}/${iconToken}/icon.png`,
        );
        assert.notEqual(iconToken, packageToken, 'Artwork cannot authorize package bytes');
        const icon = await app.inject({ url: grant.body.iconUrl });
        assert.equal(icon.statusCode, 200);
        assert.equal(icon.headers['content-type'], 'image/png');
        assert.deepEqual(
          icon.rawPayload.subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        assert.equal(
          (await app.inject({ url: grant.body.iconUrl.replace(/icon\.png$/, 'wrong.png') }))
            .statusCode,
          404,
          'Artwork filename must be canonical',
        );
        const ranged = await app.inject({
          url: grant.body.url,
          headers: { range: 'bytes=100-199' },
        });
        assert.equal(ranged.statusCode, 206);
        assert.equal(ranged.rawPayload.length, 100);
        for (
          let n = 0;
          n < 100 &&
          (await db.query('SELECT downloaded_bytes FROM jobs WHERE id=$1', [native.body.id]))
            .rows[0].downloaded_bytes !== 100;
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          (await db.query('SELECT downloaded_bytes FROM jobs WHERE id=$1', [native.body.id]))
            .rows[0].downloaded_bytes,
          100,
        );
        await new Promise((resolve) => setTimeout(resolve, 1050));
        assert.equal(
          (await app.inject({ url: grant.body.url, headers: { range: 'bytes=150-249' } }))
            .statusCode,
          206,
        );
        for (
          let n = 0;
          n < 100 &&
          (await db.query('SELECT speed_bytes_per_second FROM jobs WHERE id=$1', [native.body.id]))
            .rows[0].speed_bytes_per_second === 0;
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        await call(
          'POST',
          `/device/tasks/${native.body.id}/progress`,
          { state: 'TRANSFERRING', downloadedBytes: 100 },
          device.credential,
        );
        const afterStatusPoll = (
          await db.query('SELECT downloaded_bytes,speed_bytes_per_second FROM jobs WHERE id=$1', [
            native.body.id,
          ])
        ).rows[0];
        assert.equal(
          afterStatusPoll.downloaded_bytes,
          150,
          'A stale native status poll cannot move byte progress backward',
        );
        assert.ok(
          afterStatusPoll.speed_bytes_per_second > 0,
          'A native status poll without a speed cannot erase measured HTTP throughput',
        );
        await app.close();
        app = await createApp(config);
        const nativeProgress = (await call('GET', `/jobs/${native.body.id}`, undefined, user.token))
          .body;
        assert.equal(
          nativeProgress.downloadedBytes,
          150,
          'Overlapping ranges count once and survive restart',
        );
        assert.ok(
          nativeProgress.speedBytesPerSecond > 0 && nativeProgress.etaSeconds > 0,
          'Native Downloads reports measured HTTP speed and ETA',
        );
        assert.equal(
          (await app.inject({ method: 'HEAD', url: grant.body.url })).statusCode,
          200,
          'Native URL survives server restart',
        );
        const retry = await call(
          'POST',
          `/device/tasks/${native.body.id}/native-download`,
          {},
          device.credential,
        );
        assert.equal(retry.status, 200);
        assert.notEqual(retry.body.url, grant.body.url, 'Retry rotates the package URL');
        assert.equal(
          (await app.inject({ method: 'HEAD', url: grant.body.url })).statusCode,
          404,
          'Retry immediately revokes the old package URL',
        );
        assert.equal(
          (await app.inject({ url: grant.body.iconUrl })).statusCode,
          404,
          'Retry immediately revokes the old artwork URL',
        );
        assert.equal(
          (await app.inject({ method: 'HEAD', url: retry.body.url })).statusCode,
          200,
          'Retry package URL works',
        );
        assert.equal(
          (await app.inject({ url: retry.body.iconUrl })).statusCode,
          200,
          'Retry artwork URL works',
        );
        assert.equal(
          (
            await db.query(
              'SELECT COALESCE(sum(upper(r)-lower(r)),0)::bigint AS bytes FROM native_download_grants n ' +
                'CROSS JOIN LATERAL unnest(n.coverage) r WHERE n.job_id=$1',
              [native.body.id],
            )
          ).rows[0].bytes,
          150,
          'Token rotation preserves already delivered byte coverage',
        );
        assert.equal(
          (await app.inject({ url: retry.body.url.replace(/game\.pkg$/, 'wrong.pkg') })).statusCode,
          404,
          'Package filename must be canonical',
        );
        const invite = (await call('POST', '/admin/invites', {}, user.token)).body,
          contentOwner = (
            await call('POST', '/auth/register', {
              username: 'content-' + randomUUID(),
              password: 'test-content-owner-password',
              inviteToken: invite.token,
            })
          ).body;
        await db.query('UPDATE games SET user_id=$2 WHERE id=$1', [gameId, contentOwner.user.id]);
        await db.query('INSERT INTO game_shares(game_id,user_id,granted_by) VALUES($1,$2,$3)', [
          gameId,
          user.user.id,
          contentOwner.user.id,
        ]);
        assert.equal(
          (await app.inject({ url: retry.body.iconUrl })).statusCode,
          200,
          'A live share keeps the artwork capability valid',
        );
        await db.query('DELETE FROM game_shares WHERE game_id=$1 AND user_id=$2', [
          gameId,
          user.user.id,
        ]);
        assert.equal(
          (await app.inject({ method: 'HEAD', url: retry.body.url })).statusCode,
          404,
          'Revoking content access invalidates the package capability',
        );
        assert.equal(
          (await app.inject({ url: retry.body.iconUrl })).statusCode,
          404,
          'Revoking content access invalidates the artwork capability',
        );
        await db.query('UPDATE games SET user_id=$2 WHERE id=$1', [gameId, user.user.id]);
        const frontPair = (await call('POST', '/frontend/pairings', { deviceId: randomUUID() }))
          .body;
        await call(
          'POST',
          '/pairings/claim',
          { code: frontPair.code, consoleId: device.consoleId },
          user.token,
        );
        const front = (
          await call('POST', `/pairings/${frontPair.id}/poll`, { pollSecret: frontPair.pollSecret })
        ).body;
        assert.equal(
          (
            await call(
              'POST',
              `/device/tasks/${native.body.id}/native-download`,
              {},
              front.credential,
            )
          ).status,
          403,
          'Only the agent may mint OS download grants',
        );
        await db.query(
          "UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='AGENT'",
          [device.consoleId],
        );
        assert.equal(
          (await call('GET', '/device/status', undefined, front.credential)).status,
          200,
        );
        assert.equal(
          (await app.inject({ method: 'HEAD', url: retry.body.url })).statusCode,
          404,
          'A frontend credential cannot keep an agent download grant alive',
        );
        assert.equal(
          (await app.inject({ method: 'HEAD', url: retry.body.iconUrl })).statusCode,
          404,
          'Artwork grant also requires a live agent credential',
        );
        await db.query(
          "UPDATE console_credentials SET revoked_at=NULL WHERE console_id=$1 AND kind='AGENT'",
          [device.consoleId],
        );
        await db.query("UPDATE jobs SET desired_state='CANCELLED',state='CANCELLED' WHERE id=$1", [
          native.body.id,
        ]);
        assert.equal(
          (await app.inject({ url: retry.body.url })).statusCode,
          404,
          'Cancelled tasks revoke native download access',
        );
        assert.equal(
          (await app.inject({ url: retry.body.iconUrl })).statusCode,
          404,
          'Cancelled tasks revoke native artwork access',
        );
        const completedNative = await call(
          'POST',
          '/transfers',
          { artifactId: nativeId, consoleId: device.consoleId, storageId: 'native-install' },
          user.token,
        );
        assert.equal(completedNative.status, 202);
        await call(
          'POST',
          `/device/tasks/${completedNative.body.id}/progress`,
          { state: 'TRANSFERRING', downloadedBytes: 0 },
          device.credential,
        );
        assert.equal(
          (
            await call(
              'POST',
              `/device/tasks/${completedNative.body.id}/progress`,
              { state: 'VERIFYING', downloadedBytes: 1024, sha256: imageHash },
              device.credential,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              'POST',
              `/device/tasks/${completedNative.body.id}/progress`,
              { state: 'REGISTERING', downloadedBytes: 1024, sha256: imageHash },
              device.credential,
            )
          ).status,
          200,
        );
        const installed = {
          releaseId,
          titleId,
          contentId,
          version: '01.00',
          title: 'Backport check',
          storageId: 'native-install',
          relativePath: `app/${titleId}/app.pkg`,
          sha256: installedHash,
          size: 512,
          available: true,
          registered: true,
          backportProfileId: null,
          source: 'MANAGED',
          backportFiles: false,
        };
        assert.equal(
          (
            await call(
              'POST',
              '/device/heartbeat',
              {
                ...report,
                capabilities: {
                  shadowMount: true,
                  backportOverlay: true,
                  fpkgBackportOverlay: true,
                  fpkgInstall: true,
                  nativeDownloads: true,
                },
                runtimeStatus: { fakelibDefaultMode: 'full' },
                shadowMountFakelib: true,
                storage,
                libraryRevision: 1,
                inventoryComplete: true,
                inventory: [installed],
              },
              device.credential,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              'POST',
              `/device/tasks/${completedNative.body.id}/progress`,
              { state: 'READY_ON_PS5', downloadedBytes: 1024, sha256: imageHash },
              device.credential,
            )
          ).status,
          200,
          'READY uses the verified installed-image identity while transport remains source-package based',
        );
        assert.ok(
          !(await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) =>
              n.code === 'TRANSFER_READY' && n.message === 'Backport check is ready to play.',
          ),
          'Native installs use the PS5 download and completion UI instead of a duplicate PS5Library notice',
        );
        const sourceRoot = path.join(config.SOURCE_ROOT, user.user.id, 'backported');
        await mkdir(path.dirname(sourceRoot), { recursive: true });
        await runWorker([
          'extract-archive',
          'worker/Tests/Fixtures/homebrew.part1.rar',
          sourceRoot,
          '100000',
        ]);
        const dump = path.join(sourceRoot, 'Example'),
          paramFile = path.join(dump, 'sce_sys', 'param.json'),
          param = JSON.parse(await readFile(paramFile, 'utf8'));
        param.requiredSystemSoftwareVersion = '0x1200000000000000';
        await writeFile(paramFile, JSON.stringify(param));
        const sdkElf = Buffer.from(await readFile(path.join(dump, 'eboot.bin')));
        sdkElf.writeUInt16LE(2, 56);
        sdkElf.writeUInt32LE(0x61000001, 120);
        sdkElf.writeBigUInt64LE(512n, 128);
        sdkElf.writeBigUInt64LE(48n, 152);
        sdkElf.writeUInt32LE(48, 512);
        sdkElf.writeUInt32LE(0x4942524f, 520);
        sdkElf.writeUInt32LE(0x12090001, 528);
        sdkElf.writeUInt32LE(0x10000040, 532);
        await writeFile(path.join(root, 'sdk.elf'), sdkElf);
        await runWorker(['elf-to-fself', path.join(root, 'sdk.elf'), path.join(dump, 'sdk.self')]);
        await mkdir(path.join(dump, 'fakelib'), { recursive: true });
        const module = path.join(dump, 'fakelib', 'sample.sprx');
        await runWorker(['elf-to-fself', path.join(dump, 'eboot.bin'), module]);
        await mkdir(path.join(dump, 'backport', 'sce_module'), { recursive: true });
        const supplied = Buffer.from('explicit compatibility file');
        await writeFile(path.join(dump, 'backport', 'sce_module', 'compat.prx'), supplied);
        const sourceDigest = await runWorker(['hash-base-tree', dump]),
          moduleHash = createHash('sha256')
            .update(await readFile(module))
            .digest('hex'),
          suppliedFile = {
            path: 'sce_module/compat.prx',
            sha256: createHash('sha256').update(supplied).digest('hex'),
          };
        await writeFile(
          path.join(sourceRoot, 'library.json'),
          JSON.stringify({
            schemaVersion: 1,
            releases: [
              {
                key: 'dump',
                game: {
                  title: 'Backport pipeline check',
                  titleId: param.titleId,
                  contentId: param.contentId,
                },
                version: param.contentVersion,
                format: 'folder',
                sha256: sourceDigest.sha256,
                size: sourceDigest.size,
                sourceTreeSha256: sourceDigest.sourceTreeSha256,
                sourceTreeSize: sourceDigest.sourceTreeSize,
                minimumFirmware: '12.00',
                location: 'Example',
              },
            ],
          }),
        );
        const source = await call(
          'POST',
          '/sources',
          { name: 'Backport fixture', type: 'LOCAL_FOLDER', location: 'backported' },
          user.token,
        );
        assert.equal(source.status, 201);
        assert.equal(
          (await call('POST', `/sources/${source.body.id}/sync`, {}, user.token)).status,
          200,
        );
        const game = (await call('GET', '/catalog', undefined, user.token)).body.find(
            (g: any) => g.titleId === param.titleId,
          ),
          sr = game.releases[0].sources[0].id;
        const legacy = await call(
          'POST',
          '/profiles',
          {
            ...profile,
            titleId: param.titleId,
            contentId: param.contentId,
            gameVersion: param.contentVersion,
            inputHashes: [sourceDigest.sha256, sourceDigest.sourceTreeSha256],
            targetFirmware: '4.51',
            installationMethod: 'FPKG',
            testedState: 'UNTESTED',
            requiredLibraries: [{ path: 'fakelib/sample.sprx', sha256: moduleHash }],
          },
          user.token,
        );
        assert.equal(legacy.status, 201);
        const generated = await call(
          'POST',
          '/profiles/generate',
          {
            sourceReleaseId: sr,
            targetFirmware: '4.51',
            runtime: 'kstuff',
            installationMethod: 'FPKG',
          },
          user.token,
        );
        assert.equal(generated.status, 201, JSON.stringify(generated.body));
        assert.equal(generated.body.profile.testedState, 'UNTESTED');
        assert.ok(generated.body.profile.requiredPatches.some((p: any) => p.path === 'sdk.self'));
        assert.deepEqual(
          generated.body.profile.requiredLibraries.map((f: any) => f.path),
          ['fakelib/sample.sprx'],
        );
        assert.notEqual(
          generated.body.id,
          legacy.body.id,
          'An older profile without explicit supplied files cannot hide the in-dump backport',
        );
        assert.deepEqual(generated.body.profile.requiredFiles, [suppliedFile]);
        await db.query('DELETE FROM compatibility_profiles WHERE id=ANY($1::uuid[])', [
          [generated.body.id, legacy.body.id],
        ]);
        const nine = await call(
          'POST',
          '/profiles/generate',
          {
            sourceReleaseId: sr,
            targetFirmware: '9.60',
            runtime: 'kstuff',
            installationMethod: 'FPKG',
          },
          user.token,
        );
        assert.equal(nine.status, 201, JSON.stringify(nine.body));
        assert.deepEqual(
          nine.body.profile.requiredPatches.find((p: any) => p.path === 'sdk.self').sdk,
          { ps5: 0x09000040, ps4: 0x11590001 },
        );
        await db.query('DELETE FROM compatibility_profiles WHERE id=$1', [nine.body.id]);
        assert.equal(
          (
            await call(
              'POST',
              '/profiles/generate',
              {
                sourceReleaseId: sr,
                targetFirmware: '11.00',
                runtime: 'kstuff',
                installationMethod: 'FPKG',
              },
              user.token,
            )
          ).status,
          422,
        );
        const build = async (profileId?: string) => {
          const job = await call(
            'POST',
            '/preparations',
            { sourceReleaseId: sr, method: 'FPKG', profileId },
            user.token,
          );
          assert.equal(job.status, 202, JSON.stringify(job.body));
          for (let n = 0; n < 400; n++) {
            const state = (await call('GET', `/jobs/${job.body.id}`, undefined, user.token)).body;
            if (state.state === 'COMPLETED') return state.artifactId;
            assert.notEqual(state.state, 'ERROR', JSON.stringify(state));
            await new Promise((r) => setTimeout(r, 100));
          }
          throw Error('Worker did not finish');
        };
        const clean = await build();
        const exact = await call(
          'POST',
          '/profiles',
          {
            ...profile,
            titleId: param.titleId,
            contentId: param.contentId,
            gameVersion: param.contentVersion,
            inputHashes: [sourceDigest.sha256, sourceDigest.sourceTreeSha256],
            installationMethod: 'FPKG',
            requiredLibraries: [{ path: 'fakelib/sample.sprx', sha256: moduleHash }],
            requiredFiles: [suppliedFile],
          },
          user.token,
        );
        assert.equal(exact.status, 201);
        const variant = await build(exact.body.id);
        assert.equal(variant, clean, 'A backport profile reuses the clean FPKG cache');
        await call(
          'POST',
          '/device/heartbeat',
          {
            ...report,
            capabilities: { fpkgInstall: true, nativeDownloads: true },
            runtimeStatus: { fakelibDefaultMode: 'disabled' },
            storage,
          },
          device.credential,
        );
        const runtimePending = await call(
          'POST',
          '/installations/plan',
          { sourceReleaseId: sr, consoleId: device.consoleId, method: 'FPKG' },
          user.token,
        );
        assert.equal(runtimePending.body.compatibility.status, 'BACKPORT_RUNTIME_UNAVAILABLE');
        assert.equal(runtimePending.body.compatible, false);
        assert.equal(runtimePending.body.transferable, true);
        assert.equal(
          runtimePending.body.allowed,
          true,
          'A stopped compatibility runtime warns but does not block package download',
        );
        assert.equal(runtimePending.body.backport.placement, 'SCAN_PATH');
        assert.equal(runtimePending.body.artifactId, clean);
        const queued = await call(
          'POST',
          '/transfers',
          {
            artifactId: clean,
            consoleId: device.consoleId,
            storageId: 'native-install',
          },
          user.token,
        );
        assert.equal(queued.status, 202, JSON.stringify(queued.body));
        const pendingTask = (
          await call('GET', '/device/tasks', undefined, device.credential)
        ).body.find((task: any) => task.id === queued.body.id);
        assert.equal(pendingTask.backport.profileHash, runtimePending.body.backport.profileHash);
        assert.deepEqual(pendingTask.backport.files, runtimePending.body.backport.files);
        await call(
          'POST',
          '/device/heartbeat',
          {
            ...report,
            capabilities: {
              shadowMount: true,
              backportOverlay: true,
              fpkgBackportOverlay: true,
              fpkgInstall: true,
              nativeDownloads: true,
            },
            runtimeStatus: { fakelibDefaultMode: 'full' },
            shadowMountFakelib: true,
            storage,
          },
          device.credential,
        );
        const selected = await call(
          'POST',
          '/installations/plan',
          { sourceReleaseId: sr, consoleId: device.consoleId, method: 'FPKG' },
          user.token,
        );
        assert.equal(selected.body.allowed, true, JSON.stringify(selected.body));
        assert.equal(selected.body.artifactId, clean);
        assert.equal(selected.body.backport.placement, 'SCAN_PATH');
        const cleanHash = (await db.query('SELECT sha256 FROM artifacts WHERE id=$1', [clean]))
          .rows[0].sha256;
        assert.equal(
          (await db.query('SELECT sha256 FROM artifacts WHERE id=$1', [variant])).rows[0].sha256,
          cleanHash,
          'Backport preparation does not change package bytes',
        );
        const refreshed = (
          await call('POST', `/consoles/${device.consoleId}/refresh`, {}, user.token)
        ).body;
        await call(
          'POST',
          '/device/firmware',
          { requestId: refreshed.requestId, firmware: '12.00' },
          device.credential,
        );
        assert.equal(
          (await call('GET', '/device/tasks', undefined, device.credential)).body.length,
          0,
          'Firmware refresh invalidates a queued backport for the old firmware',
        );
        const nativePlan = (
          await call(
            'POST',
            '/installations/plan',
            { sourceReleaseId: sr, consoleId: device.consoleId, method: 'FPKG' },
            user.token,
          )
        ).body;
        assert.equal(nativePlan.compatibility.status, 'NATIVE_COMPATIBLE');
        assert.equal(nativePlan.backport, null);
        assert.equal(nativePlan.artifactId, clean, 'New firmware selects the clean cached package');
        // A normal install request patches the supplied module and builds its own cache automatically.
        const recheck = (
          await call('POST', `/consoles/${device.consoleId}/refresh`, {}, user.token)
        ).body;
        await call(
          'POST',
          '/device/firmware',
          { requestId: recheck.requestId, firmware: '4.51' },
          device.credential,
        );
        const originalElf = await readFile(path.join(dump, 'eboot.bin')),
          changedElf = Buffer.from(originalElf);
        changedElf[changedElf.length - 1] ^= 1;
        await writeFile(path.join(root, 'patched.elf'), changedElf);
        await runWorker([
          'elf-to-fself',
          path.join(root, 'patched.elf'),
          path.join(root, 'patched.sprx'),
        ]);
        const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex'),
          patchedHash = hash(await readFile(path.join(root, 'patched.sprx')));
        const number = (value: number) => {
          const bytes: number[] = [];
          for (;;) {
            const b = value % 128;
            value = Math.floor(value / 128);
            if (!value) {
              bytes.push(b | 128);
              return Buffer.from(bytes);
            }
            bytes.push(b);
            value--;
          }
        };
        const footer = Buffer.alloc(8);
        footer.writeUInt32LE(crc32(originalElf), 0);
        footer.writeUInt32LE(crc32(changedElf), 4);
        const patchBody = Buffer.concat([
          Buffer.from('BPS1'),
          number(originalElf.length),
          number(changedElf.length),
          number(0),
          number((changedElf.length - 1) * 4 + 1),
          changedElf,
          footer,
        ]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32LE(crc32(patchBody));
        const bps = Buffer.concat([patchBody, checksum]);
        const recipe = {
          path: 'fakelib/sample.sprx',
          inputSha256: moduleHash,
          outputSha256: patchedHash,
          bps: { data: bps.toString('base64'), sha256: hash(bps) },
          outputFormat: 'FSELF',
        };
        const automated = {
          ...profile,
          titleId: param.titleId,
          contentId: param.contentId,
          gameVersion: param.contentVersion,
          inputHashes: [sourceDigest.sha256, sourceDigest.sourceTreeSha256],
          targetFirmware: '4.51',
          installationMethod: 'FPKG',
          testedState: 'UNTESTED',
          requiredLibraries: [{ path: recipe.path, sha256: patchedHash }],
          requiredPatches: [recipe],
          requiredFiles: [suppliedFile],
        };
        assert.equal(
          (
            await call(
              'POST',
              '/profiles',
              {
                ...automated,
                requiredPatches: [{ ...recipe, bps: { ...recipe.bps, sha256: '0'.repeat(64) } }],
              },
              user.token,
            )
          ).status,
          409,
          'Patch payload hashes are checked at upload',
        );
        assert.equal(
          (
            await call(
              'POST',
              '/profiles',
              { ...automated, requiredPatches: [recipe, recipe] },
              user.token,
            )
          ).status,
          400,
          'Duplicate patch targets are rejected',
        );
        const corruptPatch = Buffer.from(bps);
        corruptPatch[corruptPatch.length - 1] ^= 1;
        assert.equal(
          (
            await call(
              'POST',
              '/profiles',
              {
                ...automated,
                requiredPatches: [
                  {
                    ...recipe,
                    bps: { data: corruptPatch.toString('base64'), sha256: hash(corruptPatch) },
                  },
                ],
              },
              user.token,
            )
          ).status,
          409,
          'BPS patch CRC is checked even when its SHA matches',
        );
        const automatedProfile = await call('POST', '/profiles', automated, user.token);
        assert.equal(automatedProfile.status, 201);
        const planned = (
          await call(
            'POST',
            '/installations/plan',
            { sourceReleaseId: sr, consoleId: device.consoleId, method: 'FPKG' },
            user.token,
          )
        ).body;
        assert.equal(planned.backport.needsPreparation, true);
        assert.equal(planned.artifactId, null);
        assert.equal(
          planned.allowed,
          true,
          'Known input and supplied patch permit automatic preparation',
        );
        const install = await call(
          'POST',
          '/installations',
          {
            sourceReleaseId: sr,
            consoleId: device.consoleId,
            storageId: 'native-install',
            method: 'FPKG',
          },
          user.token,
        );
        assert.equal(install.status, 202);
        let completed: any;
        for (let n = 0; n < 300; n++) {
          completed = (await call('GET', '/installations', undefined, user.token)).body.find(
            (i: any) => i.id === install.body.id,
          );
          assert.notEqual(completed.state, 'ERROR', JSON.stringify(completed));
          if (completed.transferJobId) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(
          completed.transferJobId,
          'The coordinator must automatically prepare and queue the clean package plus overlay',
        );
        const after = (
          await call(
            'POST',
            '/installations/plan',
            { sourceReleaseId: sr, consoleId: device.consoleId, method: 'FPKG' },
            user.token,
          )
        ).body;
        assert.equal(after.backport.needsPreparation, false);
        assert.equal(after.backport.files[0].sha256, patchedHash);
        assert.equal(after.artifactId, completed.artifactId);
        const prepared = (
          await db.query('SELECT * FROM backport_artifacts WHERE release_id=$1 AND profile_id=$2', [
            game.releases[0].id,
            automatedProfile.body.id,
          ])
        ).rows[0];
        assert.equal(prepared.profile_hash, after.backport.profileHash);
        assert.equal(
          hash(await readFile(path.join(config.DATA_DIR, prepared.relative_path, recipe.path))),
          patchedHash,
        );
        assert.equal(
          (await runWorker(['hash-base-tree', dump])).sha256,
          sourceDigest.sha256,
          'Automatic patching never modifies the watched source',
        );
        assert.equal(
          (await db.query('SELECT sha256 FROM artifacts WHERE id=$1', [clean])).rows[0].sha256,
          cleanHash,
          'The clean cache remains available',
        );
        assert.equal(
          (
            await call(
              'POST',
              '/preparations',
              { sourceReleaseId: sr, method: 'FPKG', profileId: automatedProfile.body.id },
              user.token,
            )
          ).body.artifactId,
          completed.artifactId,
          'Repeated preparation reuses the clean package and exact overlay',
        );
        const duplicate = await call(
          'POST',
          '/transfers',
          {
            artifactId: completed.artifactId,
            consoleId: device.consoleId,
            storageId: 'native-install',
          },
          user.token,
        );
        assert.equal(duplicate.status, 409);
        assert.equal(
          duplicate.body.error,
          'TRANSFER_ALREADY_QUEUED',
          'Duplicate transfers must be handled before a database constraint is violated',
        );
        await db.query("UPDATE jobs SET state='CANCELLED',desired_state='CANCELLED' WHERE id=$1", [
          completed.transferJobId,
        ]);
        const gameRecipe = {
          path: 'eboot.bin',
          inputSha256: hash(originalElf),
          outputSha256: hash(changedElf),
          bps: { data: bps.toString('base64'), sha256: hash(bps) },
          outputFormat: 'ELF',
        };
        const shadowProfile = await call(
          'POST',
          '/profiles',
          {
            ...automated,
            installationMethod: 'SHADOWMOUNT',
            requiredPatches: [recipe, gameRecipe],
          },
          user.token,
        );
        assert.equal(shadowProfile.status, 201);
        const shadowInstall = await call(
          'POST',
          '/installations',
          {
            sourceReleaseId: sr,
            consoleId: device.consoleId,
            storageId: 'usb',
            method: 'SHADOWMOUNT',
          },
          user.token,
        );
        assert.equal(shadowInstall.status, 202);
        let imageInstall: any;
        for (let n = 0; n < 300; n++) {
          imageInstall = (await call('GET', '/installations', undefined, user.token)).body.find(
            (i: any) => i.id === shadowInstall.body.id,
          );
          assert.notEqual(imageInstall.state, 'ERROR', JSON.stringify(imageInstall));
          if (imageInstall.transferJobId) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(
          imageInstall.transferJobId,
          'The image route must also prepare the selected patch automatically',
        );
        const imageTask = (
          await call('GET', '/device/tasks', undefined, device.credential)
        ).body.find((j: any) => j.id === imageInstall.transferJobId);
        assert.equal(imageTask.method, 'SHADOWMOUNT');
        assert.equal(imageTask.backport.placement, 'SCAN_PATH');
        assert.deepEqual(
          imageTask.backport.files.map((f: any) => f.path).sort(),
          ['eboot.bin', 'fakelib/sample.sprx', 'sce_module/compat.prx', 'sce_sys/param.json'],
          'The console receives the complete ShadowMount title overlay',
        );
        for (const [file, expected] of [
          ['eboot.bin', hash(changedElf)],
          ['fakelib/sample.sprx', patchedHash],
        ] as const) {
          const index = imageTask.backport.files.findIndex((f: any) => f.path === file),
            overlay = await app.inject({
              url: `/api/v1/device/tasks/${imageTask.id}/backport/${index}`,
              headers: { authorization: `Bearer ${device.credential}` },
            });
          assert.equal(overlay.statusCode, 200);
          assert.equal(
            hash(overlay.rawPayload),
            expected,
            `The PS5 receives the verified ${file} overlay`,
          );
        }
        const metadataIndex = imageTask.backport.files.findIndex(
            (f: any) => f.path === 'sce_sys/param.json',
          ),
          metadata = await app.inject({
            url: `/api/v1/device/tasks/${imageTask.id}/backport/${metadataIndex}`,
            headers: { authorization: `Bearer ${device.credential}` },
          });
        const overlayMetadata = JSON.parse(metadata.rawPayload.toString());
        assert.deepEqual(
          [overlayMetadata.requiredSystemSoftwareVersion, overlayMetadata.sdkVersion],
          ['0x0451000000000000', undefined],
        );
        const automaticRoot = path.join(config.SOURCE_ROOT, user.user.id, 'automatic'),
          automaticDump = path.join(automaticRoot, 'Example');
        await mkdir(automaticRoot, { recursive: true });
        await cp(dump, automaticDump, { recursive: true });
        const automaticParam = JSON.parse(
          await readFile(path.join(automaticDump, 'sce_sys', 'param.json'), 'utf8'),
        );
        automaticParam.titleId = 'PPSA99993';
        automaticParam.contentId = 'IV0000-PPSA99993_00-AUTOMATIONTEST01';
        automaticParam.requiredSystemSoftwareVersion = '0x1200000000000000';
        await writeFile(
          path.join(automaticDump, 'sce_sys', 'param.json'),
          JSON.stringify(automaticParam),
        );
        const automaticDigest = await runWorker(['hash-base-tree', automaticDump]);
        const archiveRoot = path.join(automaticRoot, 'Archive');
        await cp(path.resolve('worker/Tests/Fixtures'), archiveRoot, { recursive: true });
        const archivePath = path.join(archiveRoot, 'homebrew.part1.rar');
        const archiveInspection = await runWorker(['inspect', archivePath]),
          archiveDigest = await runWorker(['hash-archive', archivePath]);
        await writeFile(
          path.join(automaticRoot, 'library.json'),
          JSON.stringify({
            schemaVersion: 1,
            releases: [
              {
                key: 'automatic',
                game: {
                  title: 'Automatic profile check',
                  titleId: automaticParam.titleId,
                  contentId: automaticParam.contentId,
                },
                version: automaticParam.contentVersion,
                format: 'folder',
                sha256: automaticDigest.sha256,
                size: automaticDigest.size,
                sourceTreeSha256: automaticDigest.sourceTreeSha256,
                sourceTreeSize: automaticDigest.sourceTreeSize,
                minimumFirmware: '12.00',
                location: 'Example',
              },
              {
                key: 'automatic-archive',
                game: {
                  title: archiveInspection.identity.title,
                  titleId: archiveInspection.identity.titleId,
                  contentId: archiveInspection.identity.contentId,
                },
                version: archiveInspection.identity.version,
                format: 'rar',
                sha256: archiveDigest.sha256,
                size: archiveDigest.size,
                installedSize: archiveInspection.archive.expandedSize,
                minimumFirmware: '12.00',
                location: 'Archive/homebrew.part1.rar',
              },
            ],
          }),
        );
        const automaticSource = await call(
          'POST',
          '/sources',
          {
            name: 'Automatic profiles',
            type: 'LOCAL_FOLDER',
            location: 'automatic',
            autoPrepare: 'BOTH',
          },
          user.token,
        );
        assert.equal(automaticSource.status, 201);
        assert.equal(
          (
            await call(
              'POST',
              '/profiles',
              {
                titleId: automaticParam.titleId,
                contentId: automaticParam.contentId,
                gameVersion: automaticParam.contentVersion,
                inputHashes: [automaticDigest.sha256, automaticDigest.sourceTreeSha256],
                targetFirmware: '4.51',
                runtime: 'kstuff',
                installationMethod: 'FPKG',
                testedState: 'UNKNOWN',
                requiredLibraries: [],
                requiredPatches: [],
              },
              user.token,
            )
          ).status,
          201,
        );
        const automaticSync = await call(
          'POST',
          `/sources/${automaticSource.body.id}/sync`,
          {},
          user.token,
        );
        assert.equal(automaticSync.status, 200);
        const scheduled = (
          await db.query(
            `SELECT j.config->>'method' AS method,(j.config->>'profile') IS NOT NULL AS profiled
        FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id
        WHERE g.title_id=$1 AND j.kind='BUILD' ORDER BY method,profiled`,
            [automaticParam.titleId],
          )
        ).rows;
        assert.deepEqual(
          scheduled,
          [
            { method: 'FPKG', profiled: true },
            { method: 'SHADOWMOUNT', profiled: true },
          ],
          'Compatibility preparation also publishes the clean artifact, so automatic preparation queues one job per method',
        );
        const automaticProfile = (
          await db.query(
            "SELECT * FROM compatibility_profiles WHERE title_id=$1 AND target_firmware='4.51' AND " +
              "runtime='kstuff' AND profile->>'installationMethod'='FPKG' AND " +
              "profile->>'testedState'='UNTESTED'",
            [automaticParam.titleId],
          )
        ).rows;
        assert.equal(
          automaticProfile.length,
          1,
          'A new owned dump gets one usable exact profile instead of reusing UNKNOWN metadata',
        );
        assert.deepEqual(automaticProfile[0].profile.inputHashes, [
          automaticDigest.sha256,
          automaticDigest.sourceTreeSha256,
        ]);
        const archiveProfiles = (
          await db.query(
            "SELECT profile FROM compatibility_profiles WHERE title_id=$1 AND target_firmware='4.51' AND " +
              "runtime='kstuff' AND profile->>'installationMethod'='FPKG' AND profile->'inputHashes' ? $2",
            [archiveInspection.identity.titleId, archiveDigest.sha256],
          )
        ).rows;
        assert.equal(
          archiveProfiles.length,
          0,
          'An archive with no verified patch or compatibility library cannot become a metadata-only backport',
        );
        assert.equal(
          automaticSync.body.preparationErrors.filter((e: string) =>
            e.includes('BACKPORT_FILES_MISSING'),
          ).length,
          1,
          'Method-independent discovery failures are reported once instead of re-extracting for each method',
        );
        assert.ok(
          (await call('GET', '/device/notifications', undefined, device.credential)).body.some(
            (n: any) => n.code === 'BACKPORT_FILES_MISSING',
          ),
          'Missing archive backport material creates a durable console warning',
        );
        const replacement = path.join(archiveRoot, 'replacement.rar'),
          changedManifest = JSON.parse(
            await readFile(path.join(automaticRoot, 'library.json'), 'utf8'),
          );
        await writeFile(replacement, 'not an archive');
        changedManifest.releases[1].location = 'Archive/replacement.rar';
        await writeFile(path.join(automaticRoot, 'library.json'), JSON.stringify(changedManifest));
        const cachedFailure = await call(
          'POST',
          `/sources/${automaticSource.body.id}/sync`,
          {},
          user.token,
        );
        assert.equal(cachedFailure.status, 200, JSON.stringify(cachedFailure.body));
        assert.equal(
          cachedFailure.body.preparationErrors.filter((e: string) =>
            e.includes('BACKPORT_FILES_MISSING'),
          ).length,
          1,
          'An unchanged deterministic failure is reused without reopening a replacement path',
        );
        let automaticBuild: any;
        for (let n = 0; n < 300; n++) {
          automaticBuild = (
            await db.query(
              'SELECT state,error,artifact_id FROM jobs WHERE source_release_id=(SELECT sr.id FROM ' +
                'source_releases sr JOIN game_releases r ON r.id=sr.release_id JOIN games g ON ' +
                "g.id=r.game_id WHERE g.title_id=$1) AND config->'profile'->>'id'=$2 ORDER BY created_at " +
                'DESC LIMIT 1',
              [automaticParam.titleId, automaticProfile[0].id],
            )
          ).rows[0];
          if (['COMPLETED', 'ERROR'].includes(automaticBuild?.state)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(automaticBuild?.state, 'COMPLETED', JSON.stringify(automaticBuild));
        assert.ok(automaticBuild.artifact_id, 'The exact FPKG variant is cached automatically');
        const automaticShadow = await call(
          'POST',
          '/profiles/generate',
          {
            sourceReleaseId: (
              await db.query(
                'SELECT sr.id FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id JOIN games ' +
                  'g ON g.id=r.game_id WHERE g.title_id=$1',
                [automaticParam.titleId],
              )
            ).rows[0].id,
            targetFirmware: '4.51',
            runtime: 'kstuff',
            installationMethod: 'SHADOWMOUNT',
          },
          user.token,
        );
        assert.equal(automaticShadow.status, 201);
        const cleanShadow = await call(
          'POST',
          '/preparations',
          {
            sourceReleaseId: (
              await db.query(
                'SELECT sr.id FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id JOIN games ' +
                  'g ON g.id=r.game_id WHERE g.title_id=$1',
                [automaticParam.titleId],
              )
            ).rows[0].id,
            method: 'SHADOWMOUNT',
          },
          user.token,
        );
        assert.equal(cleanShadow.status, 202);
        const profileShadow = await call(
          'POST',
          '/preparations',
          {
            sourceReleaseId: (
              await db.query(
                'SELECT sr.id FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id JOIN games ' +
                  'g ON g.id=r.game_id WHERE g.title_id=$1',
                [automaticParam.titleId],
              )
            ).rows[0].id,
            method: 'SHADOWMOUNT',
            profileId: automaticShadow.body.id,
          },
          user.token,
        );
        assert.equal(profileShadow.status, 202);
        for (const id of [cleanShadow.body.id, profileShadow.body.id].filter(Boolean))
          for (let n = 0; n < 300; n++) {
            const state = (await call('GET', `/jobs/${id}`, undefined, user.token)).body;
            if (['COMPLETED', 'ERROR'].includes(state.state)) {
              assert.equal(state.state, 'COMPLETED', JSON.stringify(state));
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        const shadowArtifacts = (
          await db.query(
            'SELECT a.* FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON ' +
              "g.id=r.game_id WHERE g.title_id=$1 AND a.format='ffpkg'",
            [automaticParam.titleId],
          )
        ).rows;
        assert.equal(
          shadowArtifacts.length,
          1,
          'All ShadowMount profiles reuse one clean image artifact',
        );
        assert.equal(shadowArtifacts[0].profile_id, null);
        const held = [randomUUID(), randomUUID()];
        for (const [n, id] of held.entries())
          await db.query(
            'INSERT INTO ' +
              'jobs(id,user_id,kind,release_id,source_release_id,state,desired_state,total_bytes,config) ' +
              "VALUES($1,$2,'BUILD',$3,$4,'PAUSED','PAUSED',0,$5)",
            [
              id,
              user.user.id,
              game.releases[0].id,
              sr,
              { method: 'FPKG', cacheKey: 'patch-recipe-' + n },
            ],
          );
        await assert.rejects(
          () =>
            db.query(
              'INSERT INTO ' +
                'jobs(id,user_id,kind,release_id,source_release_id,state,desired_state,total_bytes,config) ' +
                "VALUES($1,$2,'BUILD',$3,$4,'PAUSED','PAUSED',0,$5)",
              [
                randomUUID(),
                user.user.id,
                game.releases[0].id,
                sr,
                { method: 'FPKG', cacheKey: 'patch-recipe-0' },
              ],
            ),
          { code: '23505' },
          'Distinct firmware/profile builds can coexist; identical active builds remain unique',
        );
      } finally {
        await db.end();
      }
    } finally {
      await app.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
