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
  'admins can hot-reload safe runtime settings with persisted optimistic updates',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-runtime-settings-')),
      base = configuration({
        ...process.env,
        OPERATOR_URL: '',
        OPERATOR_TOKEN: '',
        HOME_UPDATE_AGENT_URL: '',
      }),
      adminDb = database(base.DATABASE_URL),
      schema = `runtime_settings_${randomUUID().replaceAll('-', '')}`;
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const makeConfig = () => ({
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
      PACKAGE_WORKER_SOCKET: path.join(root, 'missing.sock'),
      features: { ...base.features },
    });
    let config = makeConfig(),
      app = await createApp(config);
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
      const owner = (
          await call('POST', '/auth/register', {
            username: 'runtime-admin',
            password: 'test-runtime-settings-password',
            bootstrapToken: base.BOOTSTRAP_TOKEN,
          })
        ).json(),
        token = owner.token as string;
      const invite = (await call('POST', '/admin/invites', {}, token)).json();
      const member = (
        await call('POST', '/auth/register', {
          username: 'runtime-member',
          password: 'test-runtime-member-password',
          inviteToken: invite.token,
        })
      ).json();
      assert.equal(
        (await call('GET', '/admin/runtime-settings', undefined, member.token)).statusCode,
        403,
      );

      const initial = await call('GET', '/admin/runtime-settings', undefined, token);
      assert.equal(initial.statusCode, 200, initial.body);
      const current = initial.json();
      assert.equal(current.settings.companionApp, true);
      assert.ok(
        current.definitions.some(
          (item: any) =>
            item.key === 'companionApp' &&
            item.apply === 'immediate' &&
            item.writable === true &&
            item.enforcement === 'client-declared',
        ),
      );
      assert.ok(
        current.definitions.some(
          (item: any) =>
            item.key === 'homeUpdateBridge' &&
            item.available === false &&
            item.effective === false &&
            item.requires.includes('HOME_UPDATE_AGENT_URL'),
        ),
      );
      assert.ok(
        current.definitions.some(
          (item: any) =>
            item.key === 'DATABASE_URL' &&
            item.apply === 'restart' &&
            item.secret === true &&
            !('value' in item),
        ),
      );
      assert.ok(!initial.body.includes(base.BOOTSTRAP_TOKEN));
      assert.ok(!initial.body.includes(base.DATABASE_URL));

      const invalid = await call(
        'PATCH',
        '/admin/runtime-settings',
        { revision: current.revision, settings: { databaseUrl: 'secret' } },
        token,
      );
      assert.equal(invalid.statusCode, 400, invalid.body);
      const racing = await Promise.all([
        call(
          'PATCH',
          '/admin/runtime-settings',
          { revision: current.revision, settings: { quotaBytes: 111 } },
          token,
        ),
        call(
          'PATCH',
          '/admin/runtime-settings',
          { revision: current.revision, settings: { quotaBytes: 222 } },
          token,
        ),
      ]);
      assert.deepEqual(racing.map((response) => response.statusCode).sort(), [200, 409]);
      const afterRace = (await call('GET', '/admin/runtime-settings', undefined, token)).json();
      const changed = {
        companionApp: false,
        ps5Connections: false,
        accountRegistration: false,
        community: false,
        newDownloads: false,
        homeUpdateBridge: true,
        quotaBytes: 123456789,
        diskMarginBytes: 456789,
      };
      const updated = await call(
        'PATCH',
        '/admin/runtime-settings',
        { revision: afterRace.revision, settings: changed },
        token,
      );
      assert.equal(updated.statusCode, 200, updated.body);
      assert.deepEqual(updated.json().settings, changed);
      assert.equal(config.QUOTA_BYTES, changed.quotaBytes);
      assert.equal(config.DISK_MARGIN_BYTES, changed.diskMarginBytes);
      assert.deepEqual(config.features, {
        companionApp: false,
        ps5Connections: false,
        accountRegistration: false,
        community: false,
        newDownloads: false,
        homeUpdateBridge: true,
      });
      const stale = await call(
        'PATCH',
        '/admin/runtime-settings',
        { revision: current.revision, settings: { companionApp: true } },
        token,
      );
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().error, 'SETTINGS_CHANGED');

      assert.equal(
        (
          await call(
            'POST',
            '/auth/login',
            { username: 'runtime-admin', password: 'test-runtime-settings-password' },
            undefined,
            'companion',
          )
        ).json().error,
        'COMPANION_APP_DISABLED',
      );
      assert.equal((await call('GET', '/device/status')).json().error, 'PS5_CONNECTIONS_DISABLED');
      assert.equal(
        (
          await call('POST', '/pairings', {
            deviceId: randomUUID(),
            name: 'Headerless bypass',
            clientKind: 'SIMULATOR',
          })
        ).json().error,
        'PS5_CONNECTIONS_DISABLED',
      );
      assert.equal(
        (await call('POST', '/admin/invites', {}, token)).json().error,
        'ACCOUNT_REGISTRATION_DISABLED',
      );
      assert.equal(
        (await call('GET', '/community/account', undefined, token)).json().error,
        'COMMUNITY_FEATURES_DISABLED',
      );
      assert.equal(
        (await call('POST', '/downloads', { sourceReleaseId: randomUUID() }, token)).json().error,
        'NEW_DOWNLOADS_DISABLED',
      );
      const logs = (await call('GET', '/admin/logs?limit=50', undefined, token)).json();
      const audit = logs.find((entry: any) => entry.event === 'admin.runtime_settings_changed');
      assert.ok(audit);
      assert.equal(audit.changedKeys, Object.keys(changed).sort().join(','));
      assert.ok(!('settings' in audit));

      await app.close();
      config = makeConfig();
      app = await createApp(config);
      const restored = await call('GET', '/admin/runtime-settings', undefined, token);
      assert.equal(restored.statusCode, 200, restored.body);
      assert.deepEqual(restored.json().settings, changed);
      assert.equal(config.QUOTA_BYTES, changed.quotaBytes);
      assert.equal(config.features.newDownloads, false);
    } finally {
      await app.close();
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminDb.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
