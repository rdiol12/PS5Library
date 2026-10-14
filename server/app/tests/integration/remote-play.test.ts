import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash } from '../../src/auth/credentials.js';
import { api, isolatedApp } from './test-app.js';

test(
  'native Remote Play pairing is short-lived and restricted to the console owner and agent',
  { timeout: 60000 },
  async () => {
    const { config, admin, schema, app, db } = await isolatedApp('ps5library-remote-play-');
    const call = api(() => app);
    try {
      const owner = await call('POST', '/auth/register', {
        username: 'remote-owner',
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      const invite = await call('POST', '/admin/invites', {}, owner.body.token);
      const friend = await call('POST', '/auth/register', {
        username: 'remote-friend',
        password: 'test-password',
        inviteToken: invite.body.token,
      });
      const pair = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Living Room',
        clientKind: 'SIMULATOR',
        firmware: '4.50',
      });
      await call('POST', '/pairings/claim', { code: pair.body.code }, owner.body.token);
      const delivered = await call('POST', `/pairings/${pair.body.id}/poll`, {
        pollSecret: pair.body.pollSecret,
      });
      const consoleId = delivered.body.consoleId,
        agentToken = delivered.body.credential;
      const frontendToken = 'f'.repeat(64);
      await db.query(
        "INSERT INTO console_credentials(id,console_id,token_hash,kind,frontend_device_id) VALUES($1,$2,$3,'FRONTEND',$4)",
        [randomUUID(), consoleId, hash(frontendToken), randomUUID()],
      );
      const heartbeat = {
        firmware: '4.50',
        runtime: 'test',
        clientVersion: 'test',
        agentVersion: 'test',
        capabilities: { remotePlayPairing: true },
        storage: [],
        libraryRevision: 1,
      };
      assert.equal((await call('POST', '/device/heartbeat', heartbeat, agentToken)).status, 200);
      await db.query("UPDATE consoles SET last_seen=now()-interval '1 hour' WHERE id=$1", [
        consoleId,
      ]);
      assert.equal(
        (await call('POST', `/consoles/${consoleId}/remote-play/pairing`, {}, owner.body.token))
          .status,
        409,
        'Offline consoles cannot accept a live native pairing request',
      );
      assert.equal((await call('POST', '/device/heartbeat', heartbeat, agentToken)).status, 200);

      const started = await call(
        'POST',
        `/consoles/${consoleId}/remote-play/pairing`,
        {},
        owner.body.token,
      );
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.equal(started.body.state, 'REQUESTED');
      assert.equal(
        (
          await call(
            'GET',
            `/consoles/${consoleId}/remote-play/pairing/${started.body.id}`,
            undefined,
            friend.body.token,
          )
        ).status,
        404,
      );
      assert.equal(
        (await call('POST', `/consoles/${consoleId}/remote-play/pairing`, {}, owner.body.token))
          .status,
        409,
      );

      const request = await call('GET', '/device/remote-play/pairing', undefined, agentToken);
      assert.deepEqual(
        { id: request.body.id, state: request.body.state },
        { id: started.body.id, state: 'REQUESTED' },
      );
      assert.equal(
        (await call('GET', '/device/remote-play/pairing', undefined, frontendToken)).status,
        403,
        'A storefront credential cannot impersonate the agent',
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/remote-play/pairing/${started.body.id}`,
            { state: 'READY', pin: '1234', accountId: 'AQIDBAUGBwg=' },
            agentToken,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/remote-play/pairing/${started.body.id}`,
            { state: 'READY', pin: '12345678', accountId: 'AQIDBAUGBwg=' },
            agentToken,
          )
        ).status,
        200,
      );

      const ready = await call(
        'GET',
        `/consoles/${consoleId}/remote-play/pairing/${started.body.id}`,
        undefined,
        owner.body.token,
      );
      assert.equal(ready.body.state, 'READY');
      assert.equal(ready.body.pin, '12345678');
      assert.equal(ready.body.accountId, 'AQIDBAUGBwg=');
      const stored = (
        await db.query('SELECT remote_play_pairing_cipher FROM consoles WHERE id=$1', [consoleId])
      ).rows[0].remote_play_pairing_cipher;
      assert.ok(
        stored && !stored.includes('12345678') && !stored.includes('AQIDBAUGBwg='),
        'Pairing material must be encrypted at rest',
      );

      assert.equal(
        (
          await call(
            'POST',
            `/device/remote-play/pairing/${started.body.id}`,
            { state: 'PAIRED' },
            agentToken,
          )
        ).status,
        200,
      );
      const completed = await call(
        'GET',
        `/consoles/${consoleId}/remote-play/pairing/${started.body.id}`,
        undefined,
        owner.body.token,
      );
      assert.equal(completed.body.state, 'PAIRED');
      assert.equal(completed.body.pin, undefined);
      assert.equal(completed.body.accountId, undefined);
      assert.equal(
        (await db.query('SELECT remote_play_pairing_cipher FROM consoles WHERE id=$1', [consoleId]))
          .rows[0].remote_play_pairing_cipher,
        null,
      );

      const expiring = await call(
        'POST',
        `/consoles/${consoleId}/remote-play/pairing`,
        {},
        owner.body.token,
      );
      await call(
        'POST',
        `/device/remote-play/pairing/${expiring.body.id}`,
        { state: 'READY', pin: '87654321', accountId: 'AQIDBAUGBwg=' },
        agentToken,
      );
      await db.query(
        "UPDATE consoles SET remote_play_pairing_expires_at=now()-interval '1 second' WHERE id=$1",
        [consoleId],
      );
      assert.equal(
        (await call('GET', '/device/remote-play/pairing', undefined, agentToken)).body,
        null,
      );
      const expired = (
        await db.query(
          'SELECT remote_play_pairing_state,remote_play_pairing_cipher,remote_play_pairing_error FROM consoles WHERE id=$1',
          [consoleId],
        )
      ).rows[0];
      assert.deepEqual(expired, {
        remote_play_pairing_state: 'ERROR',
        remote_play_pairing_cipher: null,
        remote_play_pairing_error: 'REMOTE_PLAY_PAIRING_EXPIRED',
      });
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
