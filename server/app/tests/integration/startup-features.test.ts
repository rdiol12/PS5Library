import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { createApp } from '../../src/api/app.js';
import { database } from '../../src/db.js';

test(
  'startup feature flags disable official clients and new work without disabling administration',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-features-')),
      base = configuration({
        ...process.env,
        OPERATOR_URL: '',
        OPERATOR_TOKEN: '',
        ENABLE_COMPANION_APP: 'false',
        ENABLE_PS5_CONNECTIONS: 'false',
        ALLOW_ACCOUNT_REGISTRATION: 'false',
        ENABLE_COMMUNITY_FEATURES: 'false',
        ENABLE_NEW_DOWNLOADS: 'false',
        ENABLE_HOME_UPDATE_BRIDGE: 'false',
      }),
      admin = database(base.DATABASE_URL),
      schema = `features_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const app = await createApp({
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
      PACKAGE_WORKER_SOCKET: path.join(root, 'missing.sock'),
    });
    const call = (
      method: string,
      route: string,
      body?: unknown,
      token?: string,
      client?: 'companion' | 'ps5',
    ) =>
      app.inject({
        method: method as 'GET',
        url: '/api/v1' + route,
        payload: body,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(client ? { 'x-ps5library-client': client } : {}),
        },
      });
    try {
      const owner = await call('POST', '/auth/register', {
        username: 'feature-admin',
        password: 'test-feature-password',
        bootstrapToken: base.BOOTSTRAP_TOKEN,
      });
      assert.equal(owner.statusCode, 201, owner.body);
      const token = owner.json().token;
      const status = await call('GET', '/admin/status', undefined, token);
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json().features, {
        companionApp: false,
        ps5Connections: false,
        accountRegistration: false,
        community: false,
        newDownloads: false,
        homeUpdateBridge: false,
      });
      assert.equal(
        (await call('GET', '/me', undefined, token)).statusCode,
        200,
        'Browser administration remains available',
      );
      for (const [response, code] of [
        [
          await call(
            'POST',
            '/auth/login',
            { username: 'feature-admin', password: 'test-feature-password' },
            undefined,
            'companion',
          ),
          'COMPANION_APP_DISABLED',
        ],
        [
          await call(
            'POST',
            '/pairings',
            { deviceId: randomUUID(), name: 'Disabled PS5', clientKind: 'PS5' },
            undefined,
            'ps5',
          ),
          'PS5_CONNECTIONS_DISABLED',
        ],
        [
          await call('POST', '/hardware/recover', {
            deviceId: randomUUID(),
            hardwareProof: 'ab'.repeat(32),
          }),
          'PS5_CONNECTIONS_DISABLED',
        ],
        [await call('GET', '/device/status'), 'PS5_CONNECTIONS_DISABLED'],
        [await call('POST', '/admin/invites', {}, token), 'ACCOUNT_REGISTRATION_DISABLED'],
        [await call('GET', '/community/account', undefined, token), 'COMMUNITY_FEATURES_DISABLED'],
        [
          await call('POST', `/portable-saves/${randomUUID()}/publish`, {}, token),
          'COMMUNITY_FEATURES_DISABLED',
        ],
        [
          await call('POST', '/downloads', { sourceReleaseId: randomUUID() }, token),
          'NEW_DOWNLOADS_DISABLED',
        ],
      ] as const) {
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(response.json().error, code);
      }
    } finally {
      await app.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
