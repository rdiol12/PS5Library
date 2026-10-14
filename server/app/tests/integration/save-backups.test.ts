import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { api, isolatedApp } from './test-app.js';

test(
  'encrypted save backups are resumable, immutable, and owner scoped',
  { timeout: 60000 },
  async () => {
    const setup = await isolatedApp('ps5library-save-backup-');
    const { root, config, admin, schema, db } = setup;
    let { app } = setup;
    const call = api(() => app);
    const pair = async (token: string, name: string) => {
      const pending = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name,
        clientKind: 'SIMULATOR',
        firmware: '4.50',
      });
      await call('POST', '/pairings/claim', { code: pending.body.code }, token);
      return (
        await call('POST', `/pairings/${pending.body.id}/poll`, {
          pollSecret: pending.body.pollSecret,
        })
      ).body;
    };
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: 'save-owner',
          password: 'test-password',
          bootstrapToken: config.BOOTSTRAP_TOKEN,
        })
      ).body;
      const invite = (await call('POST', '/admin/invites', {}, owner.token)).body;
      const friend = (
        await call('POST', '/auth/register', {
          username: 'save-friend',
          password: 'test-password',
          inviteToken: invite.token,
        })
      ).body;
      const first = await pair(owner.token, 'Living Room'),
        second = await pair(owner.token, 'Bedroom');
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
      const heartbeat = {
        firmware: '4.50',
        runtime: 'test',
        clientVersion: 'test',
        agentVersion: 'test',
        capabilities: { saveBackup: true },
        storage: [],
        libraryRevision: 1,
        saveData,
      };
      assert.equal(
        (await call('POST', '/device/heartbeat', heartbeat, first.credential)).status,
        200,
      );
      const request = {
        localUserId: '12345678',
        platform: 'PS5',
        gameTitleId: 'PPSA10001',
        saveTitleId: 'PPSA10000',
        directory: 'autosave',
      };
      assert.equal(
        (await call('POST', `/consoles/${first.consoleId}/saves/backups`, request, friend.token))
          .status,
        404,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/consoles/${first.consoleId}/saves/backups`,
            { ...request, directory: 'missing' },
            owner.token,
          )
        ).status,
        404,
      );
      const created = await call(
        'POST',
        `/consoles/${first.consoleId}/saves/backups`,
        request,
        owner.token,
      );
      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.equal(created.body.state, 'REQUESTED');
      assert.equal(
        (await call('POST', `/consoles/${first.consoleId}/saves/backups`, request, owner.token))
          .status,
        409,
        'Only one active backup per exact slot',
      );
      assert.equal((await call('GET', '/save-backups', undefined, friend.token)).body.length, 0);
      const task = (await call('GET', '/device/save-backups', undefined, first.credential)).body;
      assert.equal(task.id, created.body.id);
      assert.equal(task.localUserId, '12345678');
      assert.equal(
        (await call('GET', '/device/save-backups', undefined, second.credential)).body,
        null,
      );
      const data = Buffer.from('PS5LSV01encrypted-save');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const manifest = {
        format: 'RAW_CONSOLE_V1',
        localUserId: '12345678',
        platform: 'PS5',
        gameTitleId: 'PPSA10001',
        saveTitleId: 'PPSA10000',
        directory: 'autosave',
        files: [{ path: 'encrypted/save-image', size: data.length, sha256 }],
      };
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-backups/${task.id}/start`,
            { totalBytes: data.length, sha256, manifest },
            second.credential,
          )
        ).status,
        404,
      );
      const staging = path.join(root, 'save-backups', '.staging'),
        outside = path.join(root, 'outside.bin'),
        link = path.join(staging, `${task.id}.part`);
      await mkdir(staging, { recursive: true });
      await writeFile(outside, 'unchanged');
      try {
        await symlink(outside, link, 'file');
        assert.equal(
          (
            await call(
              'POST',
              `/device/save-backups/${task.id}/start`,
              { totalBytes: data.length, sha256, manifest },
              first.credential,
            )
          ).status,
          409,
        );
        assert.equal(await readFile(outside, 'utf8'), 'unchanged');
        await rm(link);
      } catch (error: any) {
        if (error?.code !== 'EPERM') throw error;
      }
      const started = await call(
        'POST',
        `/device/save-backups/${task.id}/start`,
        { totalBytes: data.length, sha256, manifest },
        first.credential,
      );
      assert.deepEqual(started.body, { uploadedBytes: 0 });
      const split = 9;
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-backups/${task.id}/chunks`,
            { offset: 0, data: data.subarray(0, split).toString('base64') },
            first.credential,
          )
        ).body.uploadedBytes,
        split,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-backups/${task.id}/chunks`,
            { offset: 0, data: data.subarray(split).toString('base64') },
            first.credential,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/save-backups/${task.id}/chunks`,
            { offset: split, data: data.subarray(split).toString('base64') },
            first.credential,
          )
        ).body.uploadedBytes,
        data.length,
      );
      assert.equal(
        (await call('POST', `/device/save-backups/${task.id}/complete`, {}, first.credential))
          .status,
        200,
      );
      const backups = (await call('GET', '/save-backups', undefined, owner.token)).body;
      assert.equal(backups.length, 1);
      assert.equal(backups[0].state, 'READY');
      assert.equal(backups[0].uploadedBytes, data.length);
      assert.equal(backups[0].sha256, sha256);
      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/save-backups/${task.id}/download`,
        headers: { authorization: `Bearer ${friend.token}` },
      });
      assert.equal(denied.statusCode, 404);
      const range = await app.inject({
        method: 'GET',
        url: `/api/v1/save-backups/${task.id}/download`,
        headers: { authorization: `Bearer ${owner.token}`, range: 'bytes=8-16' },
      });
      assert.equal(range.statusCode, 206);
      assert.deepEqual(range.rawPayload, data.subarray(8, 17));
      await app.close();
      app = await createApp(config);
      assert.equal(
        (await call('GET', '/save-backups', undefined, owner.token)).body[0].state,
        'READY',
        'Backup metadata survives restart',
      );
      const stored = (
        await db.query('SELECT relative_path FROM save_backups WHERE id=$1', [task.id])
      ).rows[0].relative_path;
      assert.equal((await stat(path.join(root, stored))).size, data.length);
      assert.equal(
        (await call('DELETE', `/save-backups/${task.id}`, undefined, owner.token)).status,
        200,
      );
      assert.equal(await stat(path.join(root, stored)).catch(() => null), null);
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
