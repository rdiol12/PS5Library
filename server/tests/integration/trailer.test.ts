import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { createApp } from '../../src/api/app.js';
import { watchedMedia } from '../../src/sources/watch.js';
import type { Release } from '../../../shared/schemas/index.js';

test(
  'authorized trailer upload prepares persistent H264/AAC media and private Range playback',
  { timeout: 120000 },
  async () => {
    const schema = 'trailer_' + randomUUID().replaceAll('-', ''),
      root = path.resolve('data', schema),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      execute = promisify(execFile);
    await mkdir(root, { recursive: true });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DUMP_ROOT: '',
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DISK_MARGIN_BYTES: 0,
    };
    let app = await createApp(config);
    const db = database(config.DATABASE_URL);
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) =>
      app.inject({
        method,
        url: '/api/v1' + url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const account = (
          await call('POST', '/auth/register', {
            username: 'trailer-owner',
            password: 'sample-only-password',
            bootstrapToken: base.BOOTSTRAP_TOKEN,
          })
        ).json(),
        gameId = randomUUID();
      await db.query(
        'INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5)',
        [gameId, account.user.id, 'BREW09991', 'Generated trailer check', { platform: 'PS5' }],
      );
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${root}:/output`,
          'ps5library-build:0.43',
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=15',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          '2',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-c:a',
          'aac',
          '-y',
          '/output/input.mp4',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      const input = await readFile(path.join(root, 'input.mp4'));
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/games/${gameId}/trailer`,
            headers: { 'content-type': 'video/mp4' },
            payload: input,
          })
        ).statusCode,
        401,
      );
      const upload = await app.inject({
        method: 'PUT',
        url: `/api/v1/games/${gameId}/trailer`,
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'video/mp4' },
        payload: input,
      });
      assert.equal(upload.statusCode, 202, upload.body);
      let game: any;
      for (let i = 0; i < 400; i++) {
        game = (await call('GET', '/catalog', undefined, account.token)).json()[0];
        if (game.trailer || game.trailerState === 'ERROR') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(game.trailer, JSON.stringify(game));
      assert.equal(typeof game.trailer.size, 'number');
      assert.ok(game.trailer.size > 0);
      assert.ok(game.trailer.duration > 0 && game.trailer.duration <= 180.1);
      const media = await app.inject({
        url: game.trailer.url,
        headers: { authorization: `Bearer ${account.token}` },
      });
      assert.equal(media.headers['content-type'], 'video/mp4');
      assert.equal(
        createHash('sha256').update(media.rawPayload).digest('hex'),
        game.trailer.sha256,
      );
      const range = await app.inject({
        url: game.trailer.url,
        headers: { authorization: `Bearer ${account.token}`, range: 'bytes=0-15' },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.rawPayload.length, 16);
      assert.equal((await app.inject({ url: game.trailer.url })).statusCode, 401);
      // A game's supplied menu music is separate from its trailer and shares the same access boundary.
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${root}:/output`,
          'ps5library-build:0.43',
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:sample_rate=48000',
          '-t',
          '1',
          '-y',
          '/output/music.wav',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      const music = await readFile(path.join(root, 'music.wav')),
        dump = path.join(root, 'dump');
      await mkdir(path.join(dump, 'sce_sys'), { recursive: true });
      await writeFile(path.join(dump, 'sce_sys', 'snd0.wav'), music);
      const release = {
        format: 'folder',
        location: 'dump',
        kind: 'BASE',
        version: '01.00',
        game: {
          title: 'Generated preview check',
          titleId: 'BREW09991',
          contentId: 'UP0000-BREW09991_00-HOMEBREW00000001',
          platform: 'PS5',
        },
      } as Release;
      await writeFile(
        path.join(dump, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: release.game.titleId,
          contentId: release.game.contentId,
          contentVersion: release.version,
        }),
      );
      const supplied = await watchedMedia({ ...config, DUMP_ROOT: root }, release);
      assert.equal(supplied.music?.file, path.join(dump, 'sce_sys', 'snd0.wav'));
      await writeFile(
        path.join(dump, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: release.game.titleId,
          contentId: release.game.contentId,
          contentVersion: '02.00',
        }),
      );
      await assert.rejects(
        watchedMedia({ ...config, DUMP_ROOT: root }, release),
        (error: any) => error.code === 'SOURCE_CHANGED',
        'Changed dump identity cannot attach music to the previous release',
      );
      const musicUpload = await app.inject({
        method: 'PUT',
        url: `/api/v1/games/${gameId}/music`,
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'audio/wav' },
        payload: music,
      });
      assert.equal(musicUpload.statusCode, 202, musicUpload.body);
      for (let i = 0; i < 400; i++) {
        game = (await call('GET', '/catalog', undefined, account.token)).json()[0];
        if (game.music || game.musicState === 'ERROR') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(game.music, JSON.stringify(game));
      assert.equal(typeof game.music.size, 'number');
      assert.ok(game.trailer, 'Music must preserve the existing trailer');
      const musicStream = await app.inject({
        url: game.music.url,
        headers: { authorization: `Bearer ${account.token}` },
      });
      assert.equal(musicStream.headers['content-type'], 'audio/mp4');
      assert.equal(
        createHash('sha256').update(musicStream.rawPayload).digest('hex'),
        game.music.sha256,
      );
      assert.equal((await app.inject({ url: game.music.url })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: game.music.url,
            headers: { authorization: `Bearer ${account.token}`, range: 'bytes=0-15' },
          })
        ).statusCode,
        206,
      );
      const invite = (await call('POST', '/admin/invites', {}, account.token)).json();
      const friend = (
        await call('POST', '/auth/register', {
          username: 'trailer-friend',
          password: 'sample-only-password',
          inviteToken: invite.token,
        })
      ).json();
      assert.equal(
        (
          await app.inject({
            url: game.trailer.url,
            headers: { authorization: `Bearer ${friend.token}` },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: game.music.url,
            headers: { authorization: `Bearer ${friend.token}` },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/games/${gameId}/music`,
            headers: { authorization: `Bearer ${friend.token}`, 'content-type': 'audio/wav' },
            payload: music,
          })
        ).statusCode,
        404,
      );
      await app.close();
      app = await createApp(config);
      assert.equal(
        (await call('GET', '/catalog', undefined, account.token)).json()[0].trailer.sha256,
        game.trailer.sha256,
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
