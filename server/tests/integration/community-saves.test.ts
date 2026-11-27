import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../src/api/app.js';
import { seal } from '../../src/auth/credentials.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';

function archive(files: Array<[string, Buffer]>) {
  const parts = [Buffer.from('PS5LSP01'), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(files.length);
  for (const [name, data] of files) {
    const encoded = Buffer.from(name),
      nameSize = Buffer.alloc(2),
      fileSize = Buffer.alloc(8);
    nameSize.writeUInt16BE(encoded.length);
    fileSize.writeBigUInt64BE(BigInt(data.length));
    parts.push(nameSize, encoded, fileSize, createHash('sha256').update(data).digest(), data);
  }
  return Buffer.concat(parts);
}
async function bodyBytes(body: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test(
  'portable save export, reviewed community download and rollback-gated import are exact-version and owner scoped',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-community-saves-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `community_saves_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
      PACKAGE_WORKER_SOCKET: path.join(root, 'missing.sock'),
      COMMUNITY_MASTER_URL: 'https://master.example',
    };
    await mkdir(config.SOURCE_ROOT);
    const masterToken = 'e'.repeat(64),
      masterUserToken = 'f'.repeat(64),
      publicationId = randomUUID(),
      termsBody =
        'Community saves are untrusted. Back up your save before accepting the risk of damage.',
      termsSha = createHash('sha256').update(termsBody).digest('hex'),
      portable = archive([['progress/slot.dat', Buffer.from('portable progress')]]),
      portableSha = createHash('sha256').update(portable).digest('hex');
    let uploaded = Buffer.alloc(0),
      mismatchedCatalog = false,
      invalidTermsHash = false;
    const manifest = {
      schemaVersion: 1,
      platform: 'PS5',
      gameTitleId: 'PPSA10001',
      saveTitleId: 'PPSA10000',
      directory: 'autosave',
      gameVersion: '01.020',
      archiveSha256: portableSha,
      archiveSize: portable.length,
      fileCount: 1,
      exportedAt: new Date().toISOString(),
      source: { firmware: '4.50', runtime: 'test', exporterVersion: '0.3.0' },
      portability: {
        format: 'PORTABLE_FILES',
        platformMetadataExcluded: true,
        embeddedAccountIdentifiersRemoved: false,
        encryptionKeysIncluded: false,
      },
      compatibility: { mode: 'EXACT_GAME_VERSION', gameVersion: '01.020' },
    };
    const masterFetch: typeof fetch = async (input, init = {}) => {
      const requestUrl = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        ),
        json = (value: unknown, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { 'content-type': 'application/json' },
          });
      assert.equal(requestUrl.origin, 'https://master.example');
      if (requestUrl.pathname === '/api/v1/terms/current')
        return json({
          version: 'v1',
          sha256: invalidTermsHash ? '0'.repeat(64) : termsSha,
          body: termsBody,
          acceptLabel: 'I accept the save download risk.',
        });
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${masterToken}`);
      assert.equal(
        (init.headers as Record<string, string>)['x-ps5library-user-token'],
        masterUserToken,
      );
      if (requestUrl.pathname === '/api/v1/saves/publications' && init.method === 'POST')
        return json(
          {
            id: publicationId,
            state: 'PUBLISHING',
            uploadUrl: `/api/v1/saves/publications/${publicationId}/archive`,
          },
          201,
        );
      if (
        requestUrl.pathname === `/api/v1/saves/publications/${publicationId}/archive` &&
        init.method === 'PUT'
      ) {
        uploaded = await bodyBytes(init.body);
        return new Response(null, { status: 204 });
      }
      if (
        requestUrl.pathname === '/api/v1/saves' &&
        requestUrl.searchParams.get('gameTitleId') === 'PPSA10001' &&
        requestUrl.searchParams.get('gameVersion') === '01.020'
      )
        return json({
          gameTitleId: mismatchedCatalog ? 'PPSA20002' : 'PPSA10001',
          versions: [
            {
              gameVersion: '01.020',
              saves: [
                {
                  id: publicationId,
                  platform: 'PS5',
                  gameTitleId: 'PPSA10001',
                  saveTitleId: 'PPSA10000',
                  gameVersion: '01.020',
                  region: null,
                  displayName: 'Shared autosave',
                  description: 'Before boss',
                  sha256: portableSha,
                  size: portable.length,
                  publisher: 'Family server',
                  createdAt: new Date().toISOString(),
                  downloadUrl: `/api/v1/saves/${publicationId}/archive`,
                  manifest,
                },
              ],
            },
          ],
        });
      if (requestUrl.pathname === `/api/v1/saves/${publicationId}/archive`)
        return new Response(portable, {
          headers: {
            'content-type': 'application/vnd.ps5library.save',
            'content-length': String(portable.length),
          },
        });
      return json({ error: 'NOT_FOUND' }, 404);
    };
    const app = await createApp(config, { communityFetch: masterFetch }),
      db = database(config.DATABASE_URL),
      call = async (method: string, route: string, body?: unknown, token?: string) => {
        const response = await app.inject({
          method: method as any,
          url: '/api/v1' + route,
          payload: body,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        return {
          status: response.statusCode,
          body: response.body ? response.json() : null,
          response,
        };
      };
    try {
      const owner = (
          await call('POST', '/auth/register', {
            username: 'save-owner',
            password: 'test-password',
            bootstrapToken: config.BOOTSTRAP_TOKEN,
          })
        ).body,
        invite = (await call('POST', '/admin/invites', {}, owner.token)).body,
        friend = (
          await call('POST', '/auth/register', {
            username: 'save-friend',
            password: 'test-password',
            inviteToken: invite.token,
          })
        ).body,
        pending = await call('POST', '/pairings', {
          deviceId: randomUUID(),
          name: 'Living Room',
          clientKind: 'SIMULATOR',
          firmware: '4.50',
        });
      await call('POST', '/pairings/claim', { code: pending.body.code }, owner.token);
      const device = (
        await call('POST', `/pairings/${pending.body.id}/poll`, {
          pollSecret: pending.body.pollSecret,
        })
      ).body;
      await db.query(
        `INSERT INTO community_master_connection(
          singleton,
          installation_id,
          master_url,
          display_name,
          credential_cipher,
          server_identifier,
          state
        )
        VALUES(true,$1,$2,'Test',$3,'srv_1234567890abcdef','APPROVED')`,
        [
          randomUUID(),
          config.COMMUNITY_MASTER_URL,
          seal(
            masterToken,
            config.BOOTSTRAP_TOKEN,
            `community-node:${config.COMMUNITY_MASTER_URL}`,
          ),
        ],
      );
      await db.query(
        `INSERT INTO community_user_connections(
          user_id,
          master_url,
          state,
          session_cipher,
          master_account_id,
          master_handle,
          master_display_name
        )
        VALUES($1,$2,'CONNECTED',$3,$4,'save_owner','Save Owner')`,
        [
          owner.user.id,
          config.COMMUNITY_MASTER_URL,
          seal(
            JSON.stringify({
              userId: owner.user.id,
              accessToken: masterUserToken,
              accessExpiresAt: Date.now() + 600_000,
              refreshToken: `${randomUUID()}.${'1'.repeat(64)}`,
            }),
            config.BOOTSTRAP_TOKEN,
            `community-session:${config.COMMUNITY_MASTER_URL}:${owner.user.id}`,
          ),
          randomUUID(),
        ],
      );
      const game = randomUUID(),
        baseRelease = randomUUID(),
        release = randomUUID();
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA10001','Game','{}')",
        [game, owner.user.id],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'UP0000-PPSA10001_00-TEST000000000000','01.000','BASE','{}'),($3,$2,'UP0000-PPSA10001_00-TEST000000000000','01.020','UPDATE','{}')",
        [baseRelease, game, release],
      );
      await db.query(
        'INSERT INTO ' +
          'console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) ' +
          "VALUES($1,'internal','Internal','/user',1000000,500000,false,'[]')",
        [device.consoleId],
      );
      await db.query(
        'INSERT INTO console_library_entries(console_id,release_id,storage_id,state,source) ' +
          "VALUES($1,$2,'internal','READY_ON_PS5','INSTALLED_TITLE'),($1,$3,'internal','READY_ON_PS5','INSTALLED_TITLE')",
        [device.consoleId, baseRelease, release],
      );
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
            title: 'Game',
            subtitle: 'Autosave',
            detail: 'Mission',
            sizeBytes: 4096,
            modifiedAt: 1789237800,
          },
        ],
      };
      assert.equal(
        (
          await call(
            'POST',
            '/device/heartbeat',
            {
              firmware: '4.50',
              runtime: 'test',
              clientVersion: 'test',
              agentVersion: 'test',
              capabilities: {
                saveBackup: true,
                saveExport: true,
                saveImport: true,
                saveRollback: true,
              },
              storage: [],
              libraryRevision: 1,
              saveData,
            },
            device.credential,
          )
        ).status,
        200,
      );
      const exportBody = {
        localUserId: '12345678',
        platform: 'PS5',
        gameTitleId: 'PPSA10001',
        saveTitleId: 'PPSA10000',
        directory: 'autosave',
        gameVersion: '01.020',
      };
      assert.equal(
        (
          await call(
            'POST',
            `/consoles/${device.consoleId}/saves/exports`,
            { ...exportBody, gameVersion: '01.000' },
            owner.token,
          )
        ).status,
        409,
        'A base entry must not label a save when a newer update is installed',
      );
      const created = await call(
        'POST',
        `/consoles/${device.consoleId}/saves/exports`,
        exportBody,
        owner.token,
      );
      assert.equal(created.status, 202, JSON.stringify(created.body));
      invalidTermsHash = true;
      assert.equal(
        (await call('GET', '/community/terms', undefined, owner.token)).status,
        502,
        'terms body must match the Master digest',
      );
      invalidTermsHash = false;
      assert.equal(
        (
          await call(
            'POST',
            '/community/terms/accept',
            { accepted: true, termsVersion: 'v1', termsSha256: termsSha },
            owner.token,
          )
        ).status,
        200,
      );
      await call(
        'POST',
        '/community/terms/accept',
        { accepted: true, termsVersion: 'v1', termsSha256: termsSha },
        friend.token,
      );
      assert.deepEqual((await call('GET', '/portable-saves', undefined, friend.token)).body, []);
      assert.equal(
        (
          await call(
            'GET',
            `/community/saves?consoleId=${device.consoleId}&gameTitleId=PPSA10001&gameVersion=01.020`,
            undefined,
            friend.token,
          )
        ).status,
        409,
      );
      const task = (await call('GET', '/device/save-exports', undefined, device.credential)).body;
      assert.equal(task.id, created.body.id);
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-exports/${task.id}/start`,
            { totalBytes: portable.length, sha256: portableSha, manifest },
            device.credential,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-exports/${task.id}/chunks`,
            { offset: 0, data: portable.toString('base64') },
            device.credential,
          )
        ).body.uploadedBytes,
        portable.length,
      );
      assert.equal(
        (await call('POST', `/device/save-exports/${task.id}/complete`, {}, device.credential))
          .status,
        200,
      );
      const exported = await app.inject({
        url: `/api/v1/portable-saves/${task.id}/download`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.deepEqual(exported.rawPayload, portable);
      assert.equal(
        (
          await call(
            'POST',
            `/portable-saves/${task.id}/publish`,
            { displayName: 'My save', description: 'Ready' },
            owner.token,
          )
        ).status,
        202,
      );
      assert.deepEqual(uploaded, portable);
      const catalog = await call(
        'GET',
        `/community/saves?consoleId=${device.consoleId}&gameTitleId=PPSA10001&gameVersion=01.020`,
        undefined,
        owner.token,
      );
      assert.equal(catalog.body.versions[0].saves[0].id, publicationId);
      mismatchedCatalog = true;
      assert.equal(
        (
          await call(
            'GET',
            `/community/saves?consoleId=${device.consoleId}&gameTitleId=PPSA10001&gameVersion=01.020`,
            undefined,
            owner.token,
          )
        ).status,
        502,
      );
      mismatchedCatalog = false;
      const downloaded = await call(
        'POST',
        `/community/saves/${publicationId}/download`,
        { consoleId: device.consoleId, gameTitleId: 'PPSA10001', gameVersion: '01.020' },
        owner.token,
      );
      assert.equal(downloaded.status, 201, JSON.stringify(downloaded.body));
      assert.equal(
        (
          await call(
            'POST',
            `/portable-saves/${downloaded.body.id}/import`,
            { consoleId: device.consoleId, localUserId: '12345678' },
            friend.token,
          )
        ).status,
        404,
      );
      await db.query(
        "UPDATE console_save_data SET game_title_id='PPSA99999' WHERE console_id=$1 AND local_user_id='12345678'",
        [device.consoleId],
      );
      assert.equal(
        (
          await call(
            'POST',
            `/portable-saves/${downloaded.body.id}/import`,
            { consoleId: device.consoleId, localUserId: '12345678' },
            owner.token,
          )
        ).status,
        409,
        'A donor slot for another game must be rejected',
      );
      await db.query(
        "UPDATE console_save_data SET game_title_id='PPSA10001' WHERE console_id=$1 AND local_user_id='12345678'",
        [device.consoleId],
      );
      const imported = await call(
        'POST',
        `/portable-saves/${downloaded.body.id}/import`,
        { consoleId: device.consoleId, localUserId: '12345678' },
        owner.token,
      );
      assert.equal(imported.status, 202, JSON.stringify(imported.body));
      assert.equal(
        (await call('GET', '/device/save-imports', undefined, device.credential)).body,
        null,
        'Import waits for an immutable rollback backup',
      );
      const backup = (await call('GET', '/device/save-backups', undefined, device.credential)).body,
        raw = Buffer.from('PS5LSV01rollback'),
        rawSha = createHash('sha256').update(raw).digest('hex'),
        rawManifest = {
          format: 'RAW_CONSOLE_V1',
          localUserId: '12345678',
          platform: 'PS5',
          gameTitleId: 'PPSA10001',
          saveTitleId: 'PPSA10000',
          directory: 'autosave',
          files: [{ path: 'encrypted/save-image', size: raw.length, sha256: rawSha }],
        };
      await call(
        'POST',
        `/device/save-backups/${backup.id}/start`,
        { totalBytes: raw.length, sha256: rawSha, manifest: rawManifest },
        device.credential,
      );
      await call(
        'POST',
        `/device/save-backups/${backup.id}/chunks`,
        { offset: 0, data: raw.toString('base64') },
        device.credential,
      );
      assert.equal(
        (await call('POST', `/device/save-backups/${backup.id}/complete`, {}, device.credential))
          .status,
        200,
      );
      const importTask = (await call('GET', '/device/save-imports', undefined, device.credential))
        .body;
      assert.equal(importTask.id, imported.body.id);
      const payload = await app.inject({
        url: `/api/v1/device/save-imports/${importTask.id}/archive`,
        headers: { authorization: `Bearer ${device.credential}` },
      });
      assert.deepEqual(payload.rawPayload, portable);
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-imports/${importTask.id}/progress`,
            { downloadedBytes: portable.length, speedBytesPerSecond: 1000 },
            device.credential,
          )
        ).status,
        200,
      );
      let importView = (await call('GET', '/save-imports', undefined, owner.token)).body[0];
      assert.equal(importView.downloadedBytes, portable.length);
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-imports/${importTask.id}/progress`,
            { downloadedBytes: 0, speedBytesPerSecond: 0 },
            device.credential,
          )
        ).status,
        404,
      );
      await call('POST', `/device/save-imports/${importTask.id}/start`, {}, device.credential);
      await call('POST', `/device/save-imports/${importTask.id}/complete`, {}, device.credential);
      importView = (await call('GET', '/save-imports', undefined, owner.token)).body[0];
      assert.equal(importView.state, 'COMPLETED');
      assert.equal(importView.downloadedBytes, portable.length);
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
