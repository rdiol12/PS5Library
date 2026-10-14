import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { createApp } from '../../src/api/app.js';
import { runWorker } from '../../src/library/inspect.js';

test(
  'watched dump settles, supplies exact metadata/art, auto-builds both formats and stays shared across restart',
  { timeout: 180000 },
  async () => {
    const base = configuration(),
      schema = 'watch_' + randomUUID().replaceAll('-', ''),
      root = path.resolve('data', schema),
      admin = database(base.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: path.join(root, 'dumps'),
      DISK_MARGIN_BYTES: 0,
    };
    await mkdir(config.DUMP_ROOT, { recursive: true });
    const db = database(config.DATABASE_URL);
    let app = await createApp(config);
    const call = (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: unknown,
      token?: string,
    ) =>
      app.inject({
        method,
        url: '/api/v1' + url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: 'watch-owner',
          password: 'sample-only-password',
          bootstrapToken: base.BOOTSTRAP_TOKEN,
        })
      ).json();
      const folder = path.join(config.DUMP_ROOT, 'wrapper', 'homebrew');
      await mkdir(path.join(folder, 'sce_sys'), { recursive: true });
      const bytes = Buffer.alloc(4096);
      bytes.set([0x7f, 69, 76, 70, 2, 1, 1]);
      bytes.writeUInt16LE(2, 16);
      bytes.writeUInt16LE(62, 18);
      bytes.writeUInt32LE(1, 20);
      bytes.writeBigUInt64LE(0x400080n, 24);
      bytes.writeBigUInt64LE(64n, 32);
      bytes.writeUInt16LE(64, 52);
      bytes.writeUInt16LE(56, 54);
      bytes.writeUInt16LE(1, 56);
      bytes.writeUInt32LE(1, 64);
      bytes.writeUInt32LE(5, 68);
      bytes.writeBigUInt64LE(0x400000n, 80);
      bytes.writeBigUInt64LE(4096n, 96);
      bytes.writeBigUInt64LE(4096n, 104);
      bytes.writeBigUInt64LE(4096n, 112);
      bytes[128] = 0xc3;
      await writeFile(path.join(folder, 'eboot.bin'), bytes);
      await mkdir(path.join(folder, 'fakelib'), { recursive: true });
      await writeFile(path.join(folder, 'fakelib', 'libsample.sprx'), bytes);
      await writeFile(
        path.join(folder, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: 'PPSA99995',
          contentId: 'IV0000-PPSA99995_00-PS5LIBRARYDEMO00',
          contentVersion: '01.005.000',
          masterVersion: '01.00',
          requiredSystemSoftwareVersion: '0x0760000000000000',
          localizedParameters: {
            defaultLanguage: 'en-US',
            'en-US': { titleName: 'Watched homebrew' },
          },
        }),
      );
      await writeFile(
        path.join(folder, 'sce_sys', 'icon0.png'),
        await readFile('../frontend/ps5/assets/icon0.png'),
      );
      const mediaRoot = path.join(config.DUMP_ROOT, '.ps5library', 'PPSA99995', '01.005.000');
      await mkdir(mediaRoot, { recursive: true });
      const metadata = {
        titleId: 'PPSA99995',
        contentId: 'IV0000-PPSA99995_00-PS5LIBRARYDEMO00',
        version: '01.005.000',
        title: 'Wrong display title cannot replace inspected title',
        description: 'Authorized local sidecar',
        publisher: 'Fixture publisher',
      };
      await writeFile(path.join(mediaRoot, 'metadata.json'), JSON.stringify(metadata));
      await promisify(execFile)(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${mediaRoot}:/output`,
          config.TRAILER_WORKER_IMAGE,
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=320x180:r=15',
          '-t',
          '1',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-y',
          '/output/trailer.mp4',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      const before = await runWorker(['hash-tree', folder]);
      const sourceResponse = await call(
        'POST',
        '/sources',
        {
          name: 'Watch test',
          type: 'WATCH_FOLDER',
          location: '.',
          scanIntervalMinutes: 1,
          autoPrepare: 'BOTH',
          shareCatalog: true,
        },
        owner.token,
      );
      assert.equal(sourceResponse.statusCode, 201, sourceResponse.body);
      const source = sourceResponse.json();
      assert.equal(
        (await call('POST', `/sources/${source.id}/sync`, {}, owner.token)).statusCode,
        200,
      );
      assert.equal(
        (await call('GET', '/catalog', undefined, owner.token)).json().length,
        0,
        'Do not ingest during the stability window',
      );
      await db.query("UPDATE source_observations SET changed_at=now()-interval '2 minutes'");
      const scan = await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      assert.equal(scan.statusCode, 200, scan.body);
      let catalog: any[] = [];
      for (let i = 0; i < 600; i++) {
        catalog = (await call('GET', '/catalog', undefined, owner.token)).json();
        if (catalog[0]?.releases[0]?.artifacts.length === 2 && catalog[0]?.trailer) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(catalog.length, 1);
      const game = catalog[0];
      assert.equal(game.title, 'Watched homebrew');
      assert.equal(game.releases[0].version, '01.005.000');
      assert.equal(game.releases[0].minimumFirmware, '7.60');
      assert.equal(game.shared, true);
      assert.deepEqual(game.releases[0].artifacts.map((a: any) => a.format).sort(), [
        'ffpkg',
        'pkg',
      ]);
      assert.equal(
        game.releases[0].backports.length,
        1,
        'Both builds reuse one separate backport copy',
      );
      const backport = (
        await db.query('SELECT * FROM backport_artifacts WHERE release_id=$1', [
          game.releases[0].id,
        ])
      ).rows[0];
      assert.equal(backport.type, 'SHADOWMOUNT_FOLDER');
      assert.equal(backport.input_hash, before.sha256);
      assert.equal(backport.profile_id, null);
      assert.equal(backport.target_firmware, null);
      assert.equal(backport.tested, false);
      assert.deepEqual(
        await readFile(path.join(root, backport.relative_path, 'fakelib', 'libsample.sprx')),
        bytes,
        'Separate backport survives staging cleanup',
      );
      assert.equal(game.description, 'Authorized local sidecar');
      assert.equal(game.publisher, 'Fixture publisher');
      assert.ok(game.trailer);
      assert.equal(game.artwork, undefined, 'Raw local artwork paths never reach clients');
      assert.equal(
        (
          await app.inject({
            url: game.coverUrl,
            headers: { authorization: `Bearer ${owner.token}` },
          })
        ).headers['content-type'],
        'image/webp',
      );
      assert.equal(
        (await runWorker(['hash-tree', folder])).sha256,
        before.sha256,
        'Watch/convert does not alter the original',
      );
      const invite = (await call('POST', '/admin/invites', {}, owner.token)).json(),
        friend = (
          await call('POST', '/auth/register', {
            username: 'watch-friend',
            password: 'sample-only-password',
            inviteToken: invite.token,
          })
        ).json();
      assert.equal((await call('GET', '/catalog', undefined, friend.token)).json()[0].id, game.id);
      assert.equal((await call('GET', '/sources', undefined, friend.token)).json().length, 0);
      assert.equal((await call('GET', '/jobs', undefined, friend.token)).json().length, 0);
      assert.equal(
        (
          await app.inject({
            url: game.trailer.url,
            headers: { authorization: `Bearer ${friend.token}` },
          })
        ).statusCode,
        200,
        'Shared game trailers are available to server members',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/sources',
            { name: 'Forbidden', type: 'WATCH_FOLDER', location: '.' },
            friend.token,
          )
        ).statusCode,
        403,
      );
      const paired = async (token: string, firmware: string) => {
        const pairing = (
          await call('POST', '/pairings', {
            deviceId: randomUUID(),
            name: 'Firmware ' + firmware,
            clientKind: 'SIMULATOR',
          })
        ).json();
        assert.equal(
          (await call('POST', '/pairings/claim', { code: pairing.code }, token)).statusCode,
          200,
        );
        const device = (
          await call('POST', `/pairings/${pairing.id}/poll`, { pollSecret: pairing.pollSecret })
        ).json();
        const heartbeat = await call(
          'POST',
          '/device/heartbeat',
          {
            firmware,
            runtime: 'test',
            clientVersion: '0.2.2',
            agentVersion: '0.2.2',
            capabilities: { fpkgInstall: true, shadowMount: true, backportOverlay: true },
            libraryRevision: 0,
            storage: [
              {
                storageId: 'usb',
                displayName: 'USB SSD',
                path: '/mnt/usb0',
                totalBytes: 10 ** 10,
                freeBytes: 10 ** 9,
                writable: true,
                installMethodsSupported: ['FPKG', 'SHADOWMOUNT'],
              },
            ],
          },
          device.credential,
        );
        assert.equal(heartbeat.statusCode, 200, heartbeat.body);
        return device;
      };
      const older = await paired(owner.token, '4.51'),
        current = await paired(friend.token, '7.60'),
        newer = await paired(friend.token, '12.00');
      await db.query("UPDATE console_capabilities SET capabilities='{}' WHERE console_id=$1", [
        older.consoleId,
      ]);
      const unavailable = await call(
        'POST',
        '/installations/plan',
        { sourceReleaseId: game.releases[0].sources[0].id, consoleId: older.consoleId },
        owner.token,
      );
      assert.equal(
        unavailable.statusCode,
        200,
        'An unavailable method is a blocked plan, not a failed request',
      );
      assert.equal(unavailable.json().allowed, false);
      assert.deepEqual(unavailable.json().methods, []);
      assert.match(unavailable.json().message, /installation method/i);
      assert.equal(
        (
          await call(
            'POST',
            '/installations',
            {
              sourceReleaseId: game.releases[0].sources[0].id,
              consoleId: older.consoleId,
              storageId: 'usb',
            },
            owner.token,
          )
        ).statusCode,
        409,
        'A blocked plan cannot enqueue a transfer',
      );
      await db.query('UPDATE console_capabilities SET capabilities=$2 WHERE console_id=$1', [
        older.consoleId,
        { fpkgInstall: true, shadowMount: true, backportOverlay: true },
      ]);
      for (const device of [current, newer])
        for (const method of ['FPKG', 'SHADOWMOUNT']) {
          const plan = (
            await call(
              'POST',
              '/installations/plan',
              {
                sourceReleaseId: game.releases[0].sources[0].id,
                consoleId: device.consoleId,
                method,
              },
              friend.token,
            )
          ).json();
          assert.equal(plan.compatibility.status, 'NATIVE_COMPATIBLE');
          assert.equal(plan.backportRequired, false);
          assert.equal(plan.backportArtifactId, null);
          assert.equal(plan.components.backport, 0);
          if (method === 'FPKG') {
            assert.equal(
              plan.allowed,
              false,
              'Generic USB is not a native FPKG install destination',
            );
            assert.equal(plan.reason, 'INSUFFICIENT_OR_UNSUPPORTED_STORAGE');
          } else assert.equal(plan.allowed, true, JSON.stringify(plan));
        }
      const blocked = (
        await call(
          'POST',
          '/installations/plan',
          {
            sourceReleaseId: game.releases[0].sources[0].id,
            consoleId: older.consoleId,
            method: 'SHADOWMOUNT',
          },
          owner.token,
        )
      ).json();
      assert.equal(blocked.backportRequired, true);
      assert.equal(blocked.compatibility.status, 'BACKPORT_NOT_INDEXED');
      assert.equal(
        blocked.allowed,
        false,
        'A found folder is reported as awaiting an exact profile, not as a changed-file mismatch',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/installations/plan',
            { sourceReleaseId: game.releases[0].sources[0].id, consoleId: older.consoleId },
            friend.token,
          )
        ).statusCode,
        404,
        "Friends cannot target another owner's PS5",
      );
      const image = game.releases[0].artifacts.find((a: any) => a.format === 'ffpkg');
      const packageArtifact = game.releases[0].artifacts.find((a: any) => a.format === 'pkg');
      await db.query(
        "UPDATE artifacts SET inspection=jsonb_set(inspection,'{identity,minimumFirmware}', '\"12.00\"') WHERE id=$1",
        [packageArtifact.id],
      );
      assert.equal(
        (
          await call(
            'POST',
            '/installations/plan',
            {
              sourceReleaseId: game.releases[0].sources[0].id,
              consoleId: current.consoleId,
              method: 'FPKG',
            },
            friend.token,
          )
        ).json().backportRequired,
        true,
        'A raised output firmware is enforced',
      );
      await db.query(
        "UPDATE artifacts SET inspection=jsonb_set(inspection,'{identity,minimumFirmware}', '\"4.00\"') WHERE id=$1",
        [packageArtifact.id],
      );
      assert.equal(
        (
          await call(
            'POST',
            '/installations/plan',
            {
              sourceReleaseId: game.releases[0].sources[0].id,
              consoleId: older.consoleId,
              method: 'FPKG',
            },
            owner.token,
          )
        ).json().backportRequired,
        true,
        'Lowered output metadata cannot bypass the source requirement',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/transfers',
            { artifactId: image.id, consoleId: current.consoleId, storageId: 'usb' },
            friend.token,
          )
        ).statusCode,
        202,
      );
      const tasks = (await call('GET', '/device/tasks', undefined, current.credential)).json();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].format, 'ffpkg');
      assert.equal(tasks[0].totalBytes, image.size);
      assert.equal(
        (await call('GET', '/device/tasks', undefined, newer.credential)).json().length,
        0,
        'No task is sent to another console',
      );
      assert.equal(
        (await call('GET', '/device/tasks', undefined, older.credential)).json().length,
        0,
        'Unmatched older firmware receives no game or backport',
      );
      const file = await app.inject({
        url: tasks[0].artifactUrl,
        headers: { authorization: `Bearer ${current.credential}` },
      });
      assert.equal(file.statusCode, 200);
      assert.equal(file.rawPayload.length, image.size);
      assert.equal(
        (await call('DELETE', `/backports/${backport.id}`, undefined, friend.token)).statusCode,
        404,
        'Shared readers cannot delete backport copies',
      );
      const artifact = game.releases[0].artifacts.find((a: any) => a.format === 'pkg');
      await call('DELETE', `/artifacts/${artifact.id}`, undefined, owner.token);
      await app.close();
      app = await createApp(config);
      await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      let profileJobs: any[] = [];
      for (let i = 0; i < 600; i++) {
        profileJobs = (
          await db.query(
            "SELECT state,error FROM jobs WHERE config->>'profile' IS NOT NULL ORDER BY created_at",
          )
        ).rows;
        if (
          profileJobs.length === 2 &&
          profileJobs.every((j) => ['COMPLETED', 'ERROR'].includes(j.state))
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(
        profileJobs.map((j) => j.state),
        ['COMPLETED', 'COMPLETED'],
        'The first scan after registering an older console prepares both exact compatibility routes',
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM jobs WHERE kind='BUILD' AND config->>'profile' IS NULL",
          )
        ).rows[0].count,
        2,
        'Registering a console does not rebuild a deliberately deleted clean cache',
      );
      await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      assert.equal(
        (await call('GET', '/jobs', undefined, owner.token)).json().length,
        4,
        'Completed exact profile caches are reused on later scans',
      );
      assert.equal((await call('GET', '/catalog', undefined, friend.token)).json()[0].shared, true);
      assert.deepEqual(
        await readFile(path.join(root, backport.relative_path, 'fakelib', 'libsample.sprx')),
        bytes,
        'Deleting the FPKG leaves the separate backport intact',
      );
      // A small menu-music update must not wait for another complete dump hash/build.
      await promisify(execFile)(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${folder}:/output`,
          config.TRAILER_WORKER_IMAGE,
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          '1',
          '-y',
          '/output/sce_sys/snd0.wav',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      assert.equal(
        (await call('DELETE', `/games/${game.id}/trailer`, undefined, owner.token)).statusCode,
        200,
      );
      await promisify(execFile)(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${mediaRoot}:/output`,
          config.TRAILER_WORKER_IMAGE,
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=green:s=320x180:r=15',
          '-t',
          '1',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-y',
          '/output/trailer.mp4',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      assert.equal(
        (await call('POST', `/sources/${source.id}/sync`, {}, owner.token)).statusCode,
        200,
      );
      let withMusic: any;
      for (let i = 0; i < 400; i++) {
        withMusic = (await call('GET', '/catalog', undefined, friend.token)).json()[0];
        if (withMusic.music && withMusic.trailer) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        withMusic.music,
        'Existing-title menu music imports during the dump stability window',
      );
      assert.ok(
        withMusic.trailer,
        'A newly supplied trailer must import without rehashing the entire existing dump',
      );
      assert.notEqual(withMusic.trailer.sha256, game.trailer.sha256);
      assert.equal(
        (
          await app.inject({
            url: withMusic.music.url,
            headers: { authorization: `Bearer ${friend.token}` },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await db.query('SELECT state FROM source_observations WHERE source_id=$1', [source.id]))
          .rows[0].state,
        'STABILIZING',
      );
      await writeFile(
        path.join(mediaRoot, 'metadata.json'),
        JSON.stringify({ ...metadata, contentId: 'IV0000-PPSA99996_00-PS5LIBRARYDEMO00' }),
      );
      assert.equal(
        (await call('POST', `/sources/${source.id}/sync`, {}, owner.token)).json().error,
        'METADATA_MISMATCH',
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
