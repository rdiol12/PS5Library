import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, isolatedApp } from './test-app.js';

test(
  'a PS5 recovery token restores its console while hardware proof cannot',
  { timeout: 60000 },
  async () => {
    const { config, admin, schema, app, db } = await isolatedApp('ps5library-hardware-', {
      COMMUNITY_MASTER_URL: '',
    });
    const call = api(() => app);
    try {
      const owner = await call('POST', '/auth/register', {
        username: 'hardware-owner',
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      assert.equal(owner.status, 201);
      const ownerToken = owner.body.token;
      const invite = await call('POST', '/admin/invites', {}, ownerToken),
        member = await call('POST', '/auth/register', {
          username: 'hardware-member',
          password: 'test-password',
          inviteToken: invite.body.token,
        });
      const proof = '12'.repeat(32),
        deviceId = randomUUID();
      assert.equal(
        (
          await call('POST', '/pairings', {
            deviceId: randomUUID(),
            name: 'Invalid simulator',
            clientKind: 'SIMULATOR',
            hardwareProof: proof,
          })
        ).status,
        400,
      );
      const pair = await call('POST', '/pairings', {
        deviceId,
        name: 'Living Room PS5',
        clientKind: 'PS5',
        firmware: '4.50',
        hardwareProof: proof,
      });
      assert.equal(pair.status, 201, JSON.stringify(pair.body));
      const claimed = await call('POST', '/pairings/claim', { code: pair.body.code }, ownerToken);
      assert.equal(claimed.status, 200);
      assert.equal(
        claimed.body.recoveryToken,
        undefined,
        'Recovery secrets are delivered only to the paired device',
      );
      const paired = await call('POST', `/pairings/${pair.body.id}/poll`, {
        pollSecret: pair.body.pollSecret,
      });
      assert.equal(paired.status, 200);
      assert.match(paired.body.recoveryToken, /^[a-f0-9]{64}$/);
      const consoleId = paired.body.consoleId,
        firstAgent = paired.body.credential,
        recoveryToken = paired.body.recoveryToken;
      const bound = await call('POST', '/device/hardware', { hardwareProof: proof }, firstAgent);
      assert.equal(bound.status, 200, JSON.stringify(bound.body));
      assert.equal(bound.body.recoveryToken, recoveryToken);
      assert.equal(
        (await call('POST', '/device/hardware', { hardwareProof: '34'.repeat(32) }, firstAgent))
          .status,
        409,
      );
      const frontend = await call('POST', '/frontend/pairings', { deviceId: randomUUID() });
      assert.equal(
        (await call('POST', '/pairings/claim', { code: frontend.body.code, consoleId }, ownerToken))
          .status,
        200,
      );
      const frontendPair = await call('POST', `/pairings/${frontend.body.id}/poll`, {
        pollSecret: frontend.body.pollSecret,
      });
      assert.equal(
        frontendPair.body.recoveryToken,
        recoveryToken,
        'A manually paired storefront persists the stable recovery token',
      );
      await db.query('UPDATE consoles SET library_revision=77 WHERE id=$1', [consoleId]);
      assert.equal(
        (await call('POST', '/hardware/recover', { deviceId: randomUUID(), hardwareProof: proof }))
          .status,
        400,
        'A public console identifier cannot recover storefront access',
      );
      const recovered = await call('POST', '/hardware/recover', {
        deviceId: randomUUID(),
        recoveryToken,
      });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.equal(recovered.body.consoleId, consoleId);
      assert.equal(recovered.body.recoveryToken, recoveryToken);
      assert.notEqual(recovered.body.credential, firstAgent);
      assert.equal(
        (await db.query('SELECT library_revision FROM consoles WHERE id=$1', [consoleId])).rows[0]
          .library_revision,
        77,
      );
      assert.equal(
        (await call('POST', '/device/heartbeat', {}, recovered.body.credential)).status,
        403,
        'Hardware recovery grants storefront authority, not agent authority',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/hardware',
            { hardwareProof: proof },
            recovered.body.credential,
          )
        ).status,
        403,
        'A recovered storefront cannot mint agent authority',
      );
      assert.equal(
        (await call('POST', `/consoles/${consoleId}/revoke`, {}, ownerToken)).status,
        200,
      );
      assert.equal(
        (await call('POST', '/hardware/recover', { deviceId: randomUUID(), recoveryToken })).status,
        404,
      );
      const reattach = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Living Room PS5',
        clientKind: 'PS5',
        firmware: '4.50',
        hardwareProof: proof,
      });
      assert.equal(reattach.status, 201);
      assert.equal(
        (await call('POST', '/pairings/claim', { code: reattach.body.code, consoleId }, ownerToken))
          .status,
        200,
        'The owner can explicitly reconnect a revoked PS5',
      );
      const reattached = await call('POST', `/pairings/${reattach.body.id}/poll`, {
        pollSecret: reattach.body.pollSecret,
      });
      assert.equal(reattached.status, 200);
      assert.equal(reattached.body.consoleId, consoleId);
      assert.equal(reattached.body.recoveryToken, recoveryToken);
      assert.equal(
        (await call('DELETE', `/admin/consoles/${consoleId}`, {}, member.body.token)).status,
        403,
      );
      assert.equal(
        (await call('DELETE', `/admin/consoles/${consoleId}`, {}, ownerToken)).status,
        200,
      );
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM consoles WHERE id=$1', [consoleId])).rows[0]
          .n,
        0,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM console_hardware_identities WHERE console_id=$1',
            [consoleId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await call('POST', '/hardware/recover', { deviceId: randomUUID(), recoveryToken })).status,
        404,
      );
      const replacement = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Replacement PS5',
        clientKind: 'PS5',
        firmware: '4.50',
        hardwareProof: proof,
      });
      assert.equal(
        (await call('POST', '/pairings/claim', { code: replacement.body.code }, ownerToken)).status,
        200,
      );
      const replacementPair = await call('POST', `/pairings/${replacement.body.id}/poll`, {
        pollSecret: replacement.body.pollSecret,
      });
      assert.notEqual(
        replacementPair.body.recoveryToken,
        recoveryToken,
        'Admin removal must invalidate the old stable recovery token',
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
