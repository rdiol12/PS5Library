import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { seal, unseal } from '../../src/auth/credentials.js';

test(
  'Library Node persists a separately authenticated Master approval request',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-community-client-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `community_client_${randomUUID().replaceAll('-', '')}`;
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
    const deviceCode = 'd'.repeat(64),
      identityDeviceCode = 'e'.repeat(64),
      serverId = 'srv_1234567890abcdef',
      friendRequestId = randomUUID(),
      gameSessionId = randomUUID(),
      gameSession = {
        id: '',
        adapterId: 'homebrew-test-v1',
        gameTitleId: 'PPSA99999',
        gameVersion: '1.0.0',
        maxPlayers: 2,
        playerCount: 1,
        host: { id: randomUUID(), handle: 'alice_451', displayName: 'Alice' },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      };
    gameSession.id = gameSessionId;
    let authorized = false,
      identityAuthorized = false,
      rejectUser = false,
      status: 'PENDING' | 'APPROVED' | 'BANNED' = 'PENDING',
      disconnected = false,
      identityLoggedOut = false,
      masterCalls = 0,
      lastHeaders: Record<string, string> = {},
      expectedUserToken = 'a'.repeat(64);
    const masterFetch: typeof fetch = async (input, init = {}) => {
      const requestUrl = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        ),
        json = (value: unknown, code = 200) =>
          new Response(JSON.stringify(value), {
            status: code,
            headers: { 'content-type': 'application/json' },
          }),
        headers = new Headers(init.headers);
      lastHeaders = Object.fromEntries(headers.entries());
      masterCalls++;
      assert.equal(requestUrl.origin, 'https://master.example');
      if (requestUrl.pathname === '/api/v1/device-authorizations' && init.method === 'POST')
        return json(
          {
            deviceCode,
            userCode: 'ABCDEFGH',
            verificationUri: 'https://master.example/connect',
            verificationUriComplete: 'https://master.example/connect?code=ABCDEFGH',
            expiresIn: 600,
            interval: 5,
          },
          201,
        );
      if (requestUrl.pathname === '/api/v1/device-authorizations/token') {
        const body = JSON.parse(String(init.body));
        assert.equal(body.deviceCode, deviceCode);
        return authorized
          ? json({
              connectionId: randomUUID(),
              serverId,
              status,
              banReason: status === 'BANNED' ? 'Operator test' : null,
            })
          : json({ error: 'AUTHORIZATION_PENDING' }, 428);
      }
      const node = () => assert.equal(headers.get('authorization'), `Bearer ${deviceCode}`),
        user = () => {
          node();
          assert.equal(headers.get('x-ps5library-user-token'), expectedUserToken);
        };
      if (requestUrl.pathname === '/api/v1/identity/device-sessions' && init.method === 'POST') {
        node();
        return json(
          {
            deviceCode: identityDeviceCode,
            userCode: 'HGFEDCBA',
            verificationUri: 'https://master.example/account/connect',
            verificationUriComplete: 'https://master.example/account/connect?code=HGFEDCBA',
            expiresIn: 600,
            interval: 5,
          },
          201,
        );
      }
      if (requestUrl.pathname === '/api/v1/identity/device-sessions/token') {
        node();
        const body = JSON.parse(String(init.body));
        assert.equal(body.deviceCode, identityDeviceCode);
        return identityAuthorized
          ? json({
              account: {
                id: randomUUID(),
                handle: 'member_master',
                displayName: 'Member Master',
                friendRequestPolicy: 'EVERYONE',
              },
              accessToken: 'a'.repeat(64),
              accessTokenExpiresIn: 900,
              refreshToken: `${randomUUID()}.${'b'.repeat(64)}`,
            })
          : json({ error: 'AUTHORIZATION_PENDING' }, 428);
      }
      if (requestUrl.pathname === '/api/v1/identity/refresh') {
        user();
        assert.match(JSON.parse(String(init.body)).refreshToken, /^[0-9a-f-]{36}\.[a-f0-9]{64}$/);
        expectedUserToken = 'c'.repeat(64);
        return json({
          accessToken: expectedUserToken,
          accessTokenExpiresIn: 900,
          refreshToken: `${randomUUID()}.${'f'.repeat(64)}`,
        });
      }
      if (
        rejectUser &&
        (requestUrl.pathname.startsWith('/api/v1/friends') ||
          requestUrl.pathname === '/api/v1/presence' ||
          requestUrl.pathname.startsWith('/api/v1/game-sessions'))
      ) {
        user();
        return json({ error: 'UNAUTHORIZED' }, 401);
      }
      if (
        requestUrl.pathname.startsWith('/api/v1/friends') ||
        requestUrl.pathname === '/api/v1/presence' ||
        requestUrl.pathname.startsWith('/api/v1/game-sessions')
      )
        user();
      if (requestUrl.pathname === '/api/v1/friends') {
        user();
        return json([
          {
            id: randomUUID(),
            handle: 'alice_451',
            displayName: 'Alice',
            friendsSince: new Date().toISOString(),
          },
        ]);
      }
      if (
        requestUrl.pathname === '/api/v1/friends/requests' &&
        (!init.method || init.method === 'GET')
      )
        return json({
          incoming: [
            {
              id: friendRequestId,
              createdAt: new Date().toISOString(),
              from: { id: randomUUID(), handle: 'alice_451', displayName: 'Alice' },
            },
          ],
          outgoing: [],
        });
      if (requestUrl.pathname === '/api/v1/friends/requests' && init.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { handle: 'new_friend' });
        return json({ id: friendRequestId }, 201);
      }
      if (
        requestUrl.pathname === `/api/v1/friends/requests/${friendRequestId}/accept` &&
        init.method === 'POST'
      )
        return new Response(null, { status: 204 });
      if (requestUrl.pathname === '/api/v1/friends/presence') {
        user();
        return json([
          {
            id: randomUUID(),
            handle: 'alice_451',
            displayName: 'Alice',
            state: 'ONLINE',
            updatedAt: new Date().toISOString(),
            session: {
              id: gameSessionId,
              adapterId: 'homebrew-test-v1',
              gameTitleId: 'PPSA99999',
              gameVersion: '1.0.0',
              playerCount: 1,
              maxPlayers: 2,
              expiresAt: gameSession.expiresAt,
            },
          },
        ]);
      }
      if (requestUrl.pathname === '/api/v1/presence' && init.method === 'PUT') {
        user();
        assert.deepEqual(JSON.parse(String(init.body)), { state: 'ONLINE' });
        return new Response(null, { status: 204 });
      }
      if (requestUrl.pathname === '/api/v1/presence' && init.method === 'DELETE')
        return new Response(null, { status: 204 });
      if (
        requestUrl.pathname === '/api/v1/game-sessions' &&
        (!init.method || init.method === 'GET')
      ) {
        user();
        assert.equal(requestUrl.searchParams.get('adapterId'), 'homebrew-test-v1');
        return json([gameSession]);
      }
      if (requestUrl.pathname === '/api/v1/game-sessions' && init.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), {
          adapterId: 'homebrew-test-v1',
          gameTitleId: 'PPSA99999',
          gameVersion: '1.0.0',
          maxPlayers: 2,
          connectionData: 'dGVzdA',
        });
        return json({ ...gameSession, connectionData: 'dGVzdA' }, 201);
      }
      if (
        requestUrl.pathname === `/api/v1/game-sessions/${gameSessionId}/join` &&
        init.method === 'POST'
      )
        return json({ ...gameSession, playerCount: 2, connectionData: 'dGVzdA' });
      if (
        requestUrl.pathname === `/api/v1/game-sessions/${gameSessionId}/heartbeat` &&
        init.method === 'PUT'
      )
        return new Response(null, { status: 204 });
      if (
        requestUrl.pathname === `/api/v1/game-sessions/${gameSessionId}` &&
        init.method === 'DELETE'
      )
        return new Response(null, { status: 204 });
      if (
        [
          '/api/v1/friends/requests',
          '/api/v1/presence',
          '/api/v1/game-sessions',
          `/api/v1/friends/requests/${friendRequestId}/accept`,
          `/api/v1/game-sessions/${gameSessionId}/join`,
          `/api/v1/game-sessions/${gameSessionId}/heartbeat`,
          `/api/v1/game-sessions/${gameSessionId}`,
        ].includes(requestUrl.pathname)
      )
        user();
      if (requestUrl.pathname === '/api/v1/identity/logout' && init.method === 'POST') {
        user();
        identityLoggedOut = true;
        return new Response(null, { status: 204 });
      }
      node();
      if (requestUrl.pathname === '/api/v1/connections/status')
        return json({ serverId, status, banReason: status === 'BANNED' ? 'Operator test' : null });
      if (requestUrl.pathname === '/api/v1/connection' && init.method === 'DELETE') {
        disconnected = true;
        return new Response(null, { status: 204 });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    };
    let app = await createApp(config, { communityFetch: masterFetch }),
      db = database(config.DATABASE_URL);
    const call = async (method: string, route: string, payload?: unknown, token?: string) => {
      const response = await app.inject({
        method: method as 'GET',
        url: '/api/v1' + route,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: response.statusCode, body: response.body ? response.json() : null };
    };
    try {
      const service = await call('GET', '/service-info');
      assert.equal(service.status, 200);
      assert.deepEqual(service.body, { service: 'ps5library-node', apiVersion: 1 });
      const owner = (
        await call('POST', '/auth/register', {
          username: 'community-owner',
          password: 'test-community-password',
          bootstrapToken: config.BOOTSTRAP_TOKEN,
        })
      ).body;
      const invite = (await call('POST', '/admin/invites', {}, owner.token)).body,
        member = (
          await call('POST', '/auth/register', {
            username: 'community-member',
            password: 'test-community-password',
            inviteToken: invite.token,
          })
        ).body;
      const blocked = await call(
        'POST',
        '/community/account/request',
        { deviceName: 'Member iPhone' },
        member.token,
      );
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error, 'COMMUNITY_MASTER_NOT_APPROVED');
      assert.equal(
        (
          await call(
            'POST',
            '/admin/community/request',
            { displayName: 'Family server' },
            member.token,
          )
        ).status,
        403,
      );
      const requested = await call(
        'POST',
        '/admin/community/request',
        { displayName: 'Family server' },
        owner.token,
      );
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
      assert.equal(requested.body.state, 'AWAITING_OWNER');
      assert.equal(requested.body.userCode, 'ABCDEFGH');
      assert.equal('deviceCode' in requested.body, false);
      assert.equal('masterUrl' in requested.body, false);
      const stored = (await db.query('SELECT * FROM community_master_connection')).rows[0];
      assert.notEqual(stored.credential_cipher, deviceCode);
      assert.equal(stored.server_identifier, null);
      assert.equal(
        (await call('POST', '/admin/community/refresh', {}, owner.token)).body.state,
        'AWAITING_OWNER',
      );
      authorized = true;
      assert.equal(
        (await call('POST', '/admin/community/refresh', {}, owner.token)).body.state,
        'PENDING',
      );
      status = 'APPROVED';
      assert.equal(
        (await call('GET', '/admin/community', undefined, owner.token)).body.state,
        'APPROVED',
      );
      await app.close();
      app = await createApp(config, { communityFetch: masterFetch });
      assert.equal(
        (await call('GET', '/admin/community', undefined, owner.token)).body.state,
        'APPROVED',
        'connection survives restart',
      );
      await app.close();
      let changedOriginCalls = 0;
      app = await createApp(
        { ...config, COMMUNITY_MASTER_URL: 'https://replacement.example' },
        {
          communityFetch: async () => {
            changedOriginCalls++;
            throw new Error('credential crossed origin');
          },
        },
      );
      const changedOrigin = await call('GET', '/admin/community', undefined, owner.token);
      assert.equal(changedOrigin.body.error, 'COMMUNITY_MASTER_CHANGED');
      assert.equal(
        changedOriginCalls,
        0,
        'stored Node credentials never reach a replacement Master origin',
      );
      const changedDisconnect = await call('DELETE', '/admin/community', undefined, owner.token);
      assert.equal(changedDisconnect.status, 202);
      assert.equal(
        changedOriginCalls,
        0,
        'disconnect does not send an old credential to a replacement origin',
      );
      await db.query(
        "UPDATE community_master_connection SET state='APPROVED',error=NULL WHERE singleton",
      );
      await app.close();
      app = await createApp(config, { communityFetch: masterFetch });
      assert.equal(
        (await call('GET', '/admin/community', undefined, owner.token)).body.state,
        'APPROVED',
      );
      const userLink = await call(
        'POST',
        '/community/account/request',
        { deviceName: 'Member iPhone' },
        member.token,
      );
      assert.equal(userLink.status, 202, JSON.stringify(userLink.body));
      assert.equal(userLink.body.state, 'AWAITING_OWNER');
      assert.equal(userLink.body.userCode, 'HGFEDCBA');
      assert.equal('deviceCode' in userLink.body, false);
      assert.equal(
        (await call('GET', '/community/account', undefined, owner.token)).body.state,
        'DISCONNECTED',
        'Master identity is isolated per local account',
      );
      assert.equal(
        (await call('POST', '/community/account/refresh', {}, member.token)).body.state,
        'AWAITING_OWNER',
      );
      identityAuthorized = true;
      const linked = await call('POST', '/community/account/refresh', {}, member.token);
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.state, 'CONNECTED');
      assert.equal(linked.body.account.handle, 'member_master');
      const storedIdentity = (
        await db.query(
          'SELECT user_id,device_code_cipher,session_cipher FROM community_user_connections',
        )
      ).rows[0];
      assert.equal(storedIdentity.user_id, member.user.id);
      assert.equal(storedIdentity.device_code_cipher, null);
      assert.notEqual(storedIdentity.session_cipher, 'a'.repeat(64));
      const cipherContext = `community-session:${config.COMMUNITY_MASTER_URL}:${member.user.id}`,
        expired = JSON.parse(
          unseal(storedIdentity.session_cipher, config.BOOTSTRAP_TOKEN, cipherContext),
        );
      expired.accessExpiresAt = 1;
      await db.query('UPDATE community_user_connections SET session_cipher=$2 WHERE user_id=$1', [
        member.user.id,
        seal(JSON.stringify(expired), config.BOOTSTRAP_TOKEN, cipherContext),
      ]);
      const friends = await call('GET', '/community/friends', undefined, member.token);
      assert.equal(friends.status, 200, JSON.stringify(lastHeaders));
      assert.equal(friends.body[0].handle, 'alice_451');
      const friendPresence = await call(
        'GET',
        '/community/friends/presence',
        undefined,
        member.token,
      );
      assert.equal(friendPresence.body[0].state, 'ONLINE');
      assert.equal(friendPresence.body[0].session.gameTitleId, 'PPSA99999');
      assert.equal('connectionData' in friendPresence.body[0].session, false);
      assert.equal(
        (await call('GET', '/community/friends/requests', undefined, member.token)).body.incoming[0]
          .from.handle,
        'alice_451',
      );
      assert.equal(
        (await call('POST', '/community/friends/requests', { handle: 'new_friend' }, member.token))
          .body.id,
        friendRequestId,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/community/friends/requests/${friendRequestId}/accept`,
            {},
            member.token,
          )
        ).status,
        204,
      );
      assert.equal(
        (await call('PUT', '/community/presence', { state: 'ONLINE' }, member.token)).status,
        204,
      );
      assert.equal(
        (await call('GET', '/community/friends', undefined, owner.token)).status,
        409,
        "an unlinked local account cannot use another user's Master session",
      );
      const pair = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Member PS5',
        clientKind: 'SIMULATOR',
        firmware: '4.51',
      });
      assert.equal(
        (await call('POST', '/pairings/claim', { code: pair.body.code }, member.token)).status,
        200,
      );
      const paired = await call('POST', `/pairings/${pair.body.id}/poll`, {
          pollSecret: pair.body.pollSecret,
        }),
        front = await call('POST', '/frontend/pairings', { deviceId: randomUUID() });
      assert.equal(
        (
          await call(
            'POST',
            '/pairings/claim',
            { code: front.body.code, consoleId: paired.body.consoleId },
            member.token,
          )
        ).status,
        200,
      );
      const frontend = await call('POST', `/pairings/${front.body.id}/poll`, {
        pollSecret: front.body.pollSecret,
      });
      assert.equal(
        (await call('GET', '/device/community/account', undefined, frontend.body.credential)).body
          .account.handle,
        'member_master',
      );
      let notices = (await call('GET', '/device/notifications', undefined, paired.body.credential))
        .body;
      assert.equal(notices[0].code, 'COMMUNITY_CONNECTED');
      assert.equal(
        notices[0].message,
        'Welcome to the PS5Library Store. Your Community account @member_master is connected.',
      );
      assert.equal(
        (
          await call(
            'GET',
            '/device/community/friends/presence',
            undefined,
            frontend.body.credential,
          )
        ).body[0].state,
        'ONLINE',
      );
      assert.equal(
        (
          await call(
            'PUT',
            '/device/community/presence',
            { state: 'ONLINE' },
            frontend.body.credential,
          )
        ).status,
        204,
      );
      const hosted = await call(
        'POST',
        '/community/game-sessions',
        {
          adapterId: 'homebrew-test-v1',
          gameTitleId: 'PPSA99999',
          gameVersion: '1.0.0',
          maxPlayers: 2,
          connectionData: 'dGVzdA',
        },
        member.token,
      );
      assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
      assert.equal(hosted.body.id, gameSessionId);
      const sessions = await call(
        'GET',
        '/device/community/game-sessions?adapterId=homebrew-test-v1&gameTitleId=PPSA99999&gameVersion=1.0.0',
        undefined,
        frontend.body.credential,
      );
      assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
      assert.equal(sessions.body[0].id, gameSessionId);
      assert.equal('connectionData' in sessions.body[0], false);
      const joined = await call(
        'POST',
        `/device/community/game-sessions/${gameSessionId}/join`,
        {},
        frontend.body.credential,
      );
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal(joined.body.connectionData, 'dGVzdA');
      assert.equal(
        (
          await call(
            'PUT',
            `/device/community/game-sessions/${gameSessionId}/heartbeat`,
            {},
            frontend.body.credential,
          )
        ).status,
        204,
      );
      assert.equal(
        (
          await call(
            'DELETE',
            `/device/community/game-sessions/${gameSessionId}`,
            undefined,
            frontend.body.credential,
          )
        ).status,
        204,
      );
      await db.query(
        "UPDATE community_user_connections SET state='ERROR',error='AUTHORIZATION_DENIED',updated_at=now() WHERE user_id=$1",
        [member.user.id],
      );
      assert.equal(
        (await call('GET', '/device/community/account', undefined, frontend.body.credential)).body
          .state,
        'ERROR',
      );
      notices = (await call('GET', '/device/notifications', undefined, paired.body.credential))
        .body;
      assert.equal(
        notices.some(
          (notice: any) =>
            notice.code === 'COMMUNITY_LOGIN_FAILED' &&
            notice.message.includes('sign-in request was declined'),
        ),
        true,
      );
      await db.query(
        "UPDATE community_user_connections SET state='CONNECTED',error=NULL,updated_at=now() WHERE user_id=$1",
        [member.user.id],
      );
      await db.query(
        "UPDATE community_user_connections SET state='DISCONNECT_PENDING',updated_at=now() WHERE user_id=$1",
        [member.user.id],
      );
      const callsBeforePending = masterCalls;
      assert.equal(
        (await call('GET', '/community/friends', undefined, member.token)).status,
        409,
        'disconnect-pending users cannot keep using Community APIs',
      );
      assert.equal(masterCalls, callsBeforePending, 'opt-out blocks network calls immediately');
      await db.query(
        "UPDATE community_user_connections SET state='CONNECTED',updated_at=now() WHERE user_id=$1",
        [member.user.id],
      );
      const sessionBeforeRejection = (
        await db.query('SELECT session_cipher FROM community_user_connections WHERE user_id=$1', [
          member.user.id,
        ])
      ).rows[0].session_cipher;
      rejectUser = true;
      const rejectedSession = await call('GET', '/community/friends', undefined, member.token);
      assert.equal(rejectedSession.status, 401);
      assert.equal(rejectedSession.body.error, 'COMMUNITY_ACCOUNT_REAUTHENTICATION_REQUIRED');
      const retired = (
        await db.query(
          'SELECT state,session_cipher,error FROM community_user_connections WHERE user_id=$1',
          [member.user.id],
        )
      ).rows[0];
      assert.deepEqual(retired, {
        state: 'ERROR',
        session_cipher: null,
        error: 'REAUTHENTICATION_REQUIRED',
      });
      const callsBeforeReplay = masterCalls;
      assert.equal((await call('GET', '/community/friends', undefined, member.token)).status, 409);
      assert.equal(masterCalls, callsBeforeReplay, 'a rejected session is not replayed');
      rejectUser = false;
      await db.query(
        "UPDATE community_user_connections SET state='CONNECTED',session_cipher=$2,error=NULL,updated_at=now() WHERE user_id=$1",
        [member.user.id, sessionBeforeRejection],
      );
      const unlinked = await call('DELETE', '/community/account', undefined, member.token);
      assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
      assert.equal(unlinked.body.state, 'DISCONNECTED');
      assert.equal(identityLoggedOut, true);
      assert.equal(
        (await call('GET', '/community/friends', undefined, member.token)).status,
        409,
        'revoked user session cannot read friends',
      );
      status = 'BANNED';
      const banned = (await call('POST', '/admin/community/refresh', {}, owner.token)).body;
      assert.equal(banned.state, 'BANNED');
      assert.equal(banned.banReason, 'Operator test');
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
        VALUES(
          $1,
          $2,
          'CONNECTED',
          'legacy-active-session',
          $1,
          'community_owner',
          'Community Owner'
        )
        ON CONFLICT(user_id) DO UPDATE SET
          state='CONNECTED',
          session_cipher='legacy-active-session'`,
        [owner.user.id, config.COMMUNITY_MASTER_URL],
      );
      await db.query(
        'UPDATE community_master_connection SET credential_cipher=$1 WHERE singleton',
        [seal(deviceCode, config.BOOTSTRAP_TOKEN)],
      );
      disconnected = false;
      assert.equal((await call('DELETE', '/admin/community', undefined, owner.token)).status, 200);
      assert.equal(disconnected, true);
      assert.equal(
        (await db.query('SELECT state,credential_cipher FROM community_master_connection')).rows[0]
          .state,
        'DISCONNECTED',
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM community_user_connections WHERE state<>'DISCONNECTED' OR session_cipher IS NOT NULL",
          )
        ).rows[0].count,
        0,
        'Node disconnect clears every local Master user session',
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
