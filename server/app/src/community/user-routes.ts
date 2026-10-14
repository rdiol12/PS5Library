import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { seal } from '../auth/credentials.js';
import { AppError } from '../security/errors.js';
import {
  MasterError,
  approvedMasterCredential,
  approvedMasterUserCredential,
  deviceCipherContext,
  identitySessionSchema,
  masterRequest,
  openCommunityCipher,
  sessionCipherContext,
  throwUserMasterError,
} from './master-client.js';
import type { CommunityRouteContext } from './shared.js';
const identityDeviceSchema = z
  .object({
    deviceCode: z.string().regex(/^[a-f0-9]{64}$/),
    userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresIn: z.number().int().min(60).max(3600),
    interval: z.number().int().min(1).max(60),
  })
  .strict();
const sealedDeviceSchema = z
  .object({ userId: z.string().uuid(), deviceCode: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const friendSchema = z
  .object({
    id: z.string().uuid(),
    handle: z.string().regex(/^[a-z0-9_]{3,32}$/),
    displayName: z.string().min(1).max(80),
    friendsSince: z.string(),
  })
  .strict();
const friendSessionSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    gameTitleId: z.string().regex(/^[A-Z]{4}[0-9]{5}$/),
    gameVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    playerCount: z.number().int().min(1).max(16),
    maxPlayers: z.number().int().min(2).max(16),
    expiresAt: z.string(),
  })
  .strict();
const friendPresenceSchema = friendSchema
  .omit({ friendsSince: true })
  .extend({
    state: z.enum(['ONLINE', 'AWAY', 'OFFLINE']),
    updatedAt: z.string().nullable(),
    session: friendSessionSchema.nullable().optional(),
  })
  .strict();
const handle = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/),
  friendIdentity = friendSchema.pick({ id: true, handle: true, displayName: true });
const friendRequestsSchema = z
  .object({
    incoming: z.array(
      z.object({ id: z.string().uuid(), createdAt: z.string(), from: friendIdentity }).strict(),
    ),
    outgoing: z.array(
      z.object({ id: z.string().uuid(), createdAt: z.string(), to: friendIdentity }).strict(),
    ),
  })
  .strict();
const gameAdapter = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  gameTitle = z.string().regex(/^[A-Z]{4}[0-9]{5}$/),
  gameVersion = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  gameSessionCreate = z
    .object({
      adapterId: gameAdapter,
      gameTitleId: gameTitle,
      gameVersion,
      maxPlayers: z.number().int().min(2).max(16),
      connectionData: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/),
    })
    .strict(),
  gameSessionQuery = gameSessionCreate.pick({
    adapterId: true,
    gameTitleId: true,
    gameVersion: true,
  });
const gameSessionSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: gameAdapter,
    gameTitleId: gameTitle,
    gameVersion,
    maxPlayers: z.number().int().min(2).max(16),
    playerCount: z.number().int().min(1).max(16),
    host: z
      .object({ id: z.string().uuid(), handle, displayName: z.string().min(1).max(80) })
      .strict(),
    createdAt: z.string(),
    expiresAt: z.string(),
    connectionData: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,2048}$/)
      .optional(),
  })
  .strict();

export function registerCommunityUserRoutes({
  app,
  db,
  config,
  auth,
  logs,
  fetcher,
}: CommunityRouteContext) {
  const userRow = async (userId: string) =>
    (await db.query('SELECT * FROM community_user_connections WHERE user_id=$1', [userId])).rows[0];
  const userView = (value: any) =>
    value
      ? {
          configured: Boolean(config.COMMUNITY_MASTER_URL) && config.features.community,
          state: value.state,
          userCode: value.state === 'AWAITING_OWNER' ? value.user_code : null,
          verificationUriComplete:
            value.state === 'AWAITING_OWNER' ? value.verification_uri_complete : null,
          expiresAt: value.expires_at,
          account: value.master_account_id
            ? {
                id: value.master_account_id,
                handle: value.master_handle,
                displayName: value.master_display_name,
              }
            : null,
          error: value.error,
          updatedAt: value.updated_at,
        }
      : {
          configured: Boolean(config.COMMUNITY_MASTER_URL) && config.features.community,
          state: 'DISCONNECTED',
          account: null,
        };
  const queueAccountNotice = async (userId: string, consoleId: string, value: any) => {
    let code = '',
      context = '',
      message = '';
    if (value?.state === 'CONNECTED' && value.master_account_id && value.master_handle) {
      code = 'COMMUNITY_CONNECTED';
      context = `account:${value.master_account_id}`;
      message = `Welcome to the PS5Library Store. Your Community account @${value.master_handle} is connected.`;
    } else if (value?.state === 'ERROR' && value.error) {
      const reasons: Record<string, string> = {
        AUTHORIZATION_EXPIRED: 'the sign-in code expired',
        AUTHORIZATION_DENIED: 'the sign-in request was declined',
        AUTHORIZATION_NOT_FOUND: 'the sign-in request no longer exists',
        AUTHORIZATION_CONSUMED: 'the sign-in code was already used',
        CHALLENGE_EXPIRED: 'the passkey request expired',
        PASSKEY_VERIFICATION_FAILED: 'the passkey could not be verified',
        CREDENTIAL_UNREADABLE: 'the saved sign-in could not be opened',
        COMMUNITY_CREDENTIAL_UNREADABLE: 'the saved sign-in could not be opened',
        REAUTHENTICATION_REQUIRED: 'the saved session expired',
        MASTER_UNREACHABLE: 'the Community server could not be reached',
        INVALID_MASTER_RESPONSE: 'the Community server returned an invalid response',
        UNAUTHORIZED: 'the Community session was rejected',
      };
      code = 'COMMUNITY_LOGIN_FAILED';
      context = `error:${new Date(value.updated_at).toISOString()}`;
      message = `PS5Library Community sign-in failed because ${reasons[value.error] ?? 'the Community server rejected the request'}. Open Profile > Community and try again.`;
    }
    if (!code) return;
    await db.query(
      `INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message,resolve_on_delivery)
      SELECT $1,$2,$3,NULL,$4,$5,$6,true WHERE EXISTS(SELECT 1 FROM consoles WHERE id=$3 AND user_id=$2)
      AND NOT EXISTS(SELECT 1 FROM console_notices WHERE console_id=$3 AND code=$4 AND context=$5)`,
      [randomUUID(), userId, consoleId, code, context, message],
    );
  };
  const userToken = (userId: string, allowPending = false) =>
    approvedMasterUserCredential(db, config, userId, fetcher, allowPending);
  const parsed = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new AppError('INVALID_MASTER_RESPONSE', 502);
    return result.data;
  };
  const userRequest = async (
    userId: string,
    route: string,
    options: { method?: string; body?: unknown } = {},
  ) => {
    const [userCredential, nodeCredential] = await Promise.all([
      userToken(userId),
      approvedMasterCredential(db, config),
    ]);
    try {
      return await masterRequest(
        config,
        route,
        { ...options, token: nodeCredential, userToken: userCredential },
        fetcher,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof MasterError) await throwUserMasterError(db, userId, error);
      throw new AppError('MASTER_UNREACHABLE', 502);
    }
  };
  const friendsPresence = async (userId: string) =>
    parsed(z.array(friendPresenceSchema), await userRequest(userId, '/api/v1/friends/presence'));
  const setPresence = async (userId: string, state: 'ONLINE' | 'AWAY' | null) => {
    await userRequest(userId, '/api/v1/presence', {
      method: state ? 'PUT' : 'DELETE',
      ...(state ? { body: { state } } : {}),
    });
  };
  const gameSessions = async (userId: string, value: unknown) => {
    const query = gameSessionQuery.parse(value),
      search = new URLSearchParams(query);
    return parsed(
      z.array(gameSessionSchema),
      await userRequest(userId, `/api/v1/game-sessions?${search}`),
    );
  };
  const createGameSession = async (userId: string, value: unknown) =>
    parsed(
      gameSessionSchema,
      await userRequest(userId, '/api/v1/game-sessions', {
        method: 'POST',
        body: gameSessionCreate.parse(value),
      }),
    );
  const gameSessionAction = async (
    userId: string,
    id: string,
    action: 'join' | 'heartbeat' | 'close',
  ) => {
    const route = `/api/v1/game-sessions/${z.string().uuid().parse(id)}${action === 'close' ? '' : `/${action}`}`,
      method = action === 'join' ? 'POST' : action === 'heartbeat' ? 'PUT' : 'DELETE',
      result = await userRequest(userId, route, { method });
    return action === 'join' ? parsed(gameSessionSchema, result) : null;
  };
  const registerPresenceAndSessions = (
    prefix: '/api/v1/community' | '/api/v1/device/community',
    identify: (req: FastifyRequest) => Promise<string>,
  ) => {
    app.put(`${prefix}/presence`, async (req, reply) => {
      const state = z
        .object({ state: z.enum(['ONLINE', 'AWAY']) })
        .strict()
        .parse(req.body).state;
      await setPresence(await identify(req), state);
      return reply.code(204).send();
    });
    app.delete(`${prefix}/presence`, async (req, reply) => {
      await setPresence(await identify(req), null);
      return reply.code(204).send();
    });
    app.get(`${prefix}/game-sessions`, async (req) => gameSessions(await identify(req), req.query));
    app.post(`${prefix}/game-sessions`, async (req, reply) =>
      reply.code(201).send(await createGameSession(await identify(req), req.body)),
    );
    app.post(`${prefix}/game-sessions/:id/join`, async (req) =>
      gameSessionAction(await identify(req), (req.params as { id: string }).id, 'join'),
    );
    app.put(`${prefix}/game-sessions/:id/heartbeat`, async (req, reply) => {
      await gameSessionAction(await identify(req), (req.params as { id: string }).id, 'heartbeat');
      return reply.code(204).send();
    });
    app.delete(`${prefix}/game-sessions/:id`, async (req, reply) => {
      await gameSessionAction(await identify(req), (req.params as { id: string }).id, 'close');
      return reply.code(204).send();
    });
  };
  const friendRequestAction =
    (action?: 'accept' | 'decline') => async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await userRequest(
        (await auth.user(req)).id,
        `/api/v1/friends/requests/${id}${action ? `/${action}` : ''}`,
        { method: action ? 'POST' : 'DELETE' },
      );
      return reply.code(204).send();
    };
  app.get('/api/v1/community/account', async (req) =>
    userView(await userRow((await auth.user(req)).id)),
  );
  app.post(
    '/api/v1/community/account/request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await auth.user(req),
        { deviceName } = z
          .object({ deviceName: z.string().trim().min(1).max(80) })
          .strict()
          .parse(req.body);
      if (!config.COMMUNITY_MASTER_URL) throw new AppError('COMMUNITY_MASTER_NOT_CONFIGURED', 409);
      const nodeToken = await approvedMasterCredential(db, config),
        created = identityDeviceSchema.parse(
          await masterRequest(
            config,
            '/api/v1/identity/device-sessions',
            { method: 'POST', token: nodeToken, body: { deviceName } },
            fetcher,
          ),
        );
      for (const location of [created.verificationUri, created.verificationUriComplete])
        if (new URL(location).origin !== config.COMMUNITY_MASTER_URL)
          throw new AppError('INVALID_MASTER_RESPONSE', 502);
      const cipher = seal(
        JSON.stringify({ userId: user.id, deviceCode: created.deviceCode }),
        config.BOOTSTRAP_TOKEN,
        deviceCipherContext(config.COMMUNITY_MASTER_URL, user.id),
      );
      await db.query(
        `INSERT INTO community_user_connections(
           user_id,master_url,state,device_code_cipher,user_code,verification_uri,
           verification_uri_complete,expires_at,error,updated_at
         )
         VALUES(
           $1,$2,'AWAITING_OWNER',$3,$4,$5,$6,
           now()+$7*interval '1 second',NULL,now()
         )
         ON CONFLICT(user_id) DO UPDATE SET
           master_url=EXCLUDED.master_url,
           state='AWAITING_OWNER',
           device_code_cipher=EXCLUDED.device_code_cipher,
           session_cipher=NULL,
           user_code=EXCLUDED.user_code,
           verification_uri=EXCLUDED.verification_uri,
           verification_uri_complete=EXCLUDED.verification_uri_complete,
           expires_at=EXCLUDED.expires_at,
           master_account_id=NULL,
           master_handle=NULL,
           master_display_name=NULL,
           error=NULL,
           updated_at=now()`,
        [
          user.id,
          config.COMMUNITY_MASTER_URL,
          cipher,
          created.userCode,
          created.verificationUri,
          created.verificationUriComplete,
          created.expiresIn,
        ],
      );
      await logs.write(
        'INFO',
        'community.user_link_requested',
        `Community identity requested by ${user.username}`,
      );
      return reply.code(202).send(userView(await userRow(user.id)));
    },
  );
  app.post('/api/v1/community/account/refresh', async (req) => {
    const user = await auth.user(req),
      current = await userRow(user.id);
    if (!current) return userView(current);
    if (current.master_url !== config.COMMUNITY_MASTER_URL)
      throw new AppError('COMMUNITY_MASTER_CHANGED', 409);
    if (current.state !== 'AWAITING_OWNER' || !current.device_code_cipher) return userView(current);
    let deviceCode: string;
    try {
      const sealed = sealedDeviceSchema.parse(
        JSON.parse(
          openCommunityCipher(
            current.device_code_cipher,
            config.BOOTSTRAP_TOKEN,
            deviceCipherContext(current.master_url, user.id),
          ),
        ),
      );
      if (sealed.userId !== user.id) throw new Error('owner mismatch');
      deviceCode = sealed.deviceCode;
      if (!current.device_code_cipher.startsWith('v2:'))
        await db.query(
          'UPDATE community_user_connections SET device_code_cipher=$2,updated_at=now() WHERE user_id=$1 AND device_code_cipher=$3',
          [
            user.id,
            seal(
              JSON.stringify(sealed),
              config.BOOTSTRAP_TOKEN,
              deviceCipherContext(current.master_url, user.id),
            ),
            current.device_code_cipher,
          ],
        );
    } catch {
      await db.query(
        "UPDATE community_user_connections SET state='ERROR',error='CREDENTIAL_UNREADABLE',updated_at=now() WHERE user_id=$1",
        [user.id],
      );
      return userView(await userRow(user.id));
    }
    try {
      const nodeToken = await approvedMasterCredential(db, config),
        result = identitySessionSchema.parse(
          await masterRequest(
            config,
            '/api/v1/identity/device-sessions/token',
            { method: 'POST', token: nodeToken, body: { deviceCode } },
            fetcher,
          ),
        ),
        sessionCipher = seal(
          JSON.stringify({
            userId: user.id,
            accessToken: result.accessToken,
            accessExpiresAt: Date.now() + result.accessTokenExpiresIn * 1000,
            refreshToken: result.refreshToken,
          }),
          config.BOOTSTRAP_TOKEN,
          sessionCipherContext(current.master_url, user.id),
        );
      await db.query(
        `UPDATE community_user_connections SET state='CONNECTED',device_code_cipher=NULL,session_cipher=$2,user_code=NULL,verification_uri=NULL,verification_uri_complete=NULL,expires_at=NULL,
        master_account_id=$3,master_handle=$4,master_display_name=$5,error=NULL,updated_at=now() WHERE user_id=$1`,
        [
          user.id,
          sessionCipher,
          result.account.id,
          result.account.handle,
          result.account.displayName,
        ],
      );
      await logs.write(
        'INFO',
        'community.user_linked',
        `Community identity linked by ${user.username}`,
        { masterAccountId: result.account.id },
      );
    } catch (error) {
      if (error instanceof MasterError && error.code === 'AUTHORIZATION_PENDING')
        return userView(current);
      const code = error instanceof MasterError ? error.code : 'MASTER_UNREACHABLE';
      await db.query(
        "UPDATE community_user_connections SET state='ERROR',error=$2,updated_at=now() WHERE user_id=$1",
        [user.id, code],
      );
    }
    return userView(await userRow(user.id));
  });
  app.delete('/api/v1/community/account', async (req, reply) => {
    const user = await auth.user(req),
      current = await userRow(user.id);
    if (!current) return userView(current);
    if (current.state === 'CONNECTED' || current.state === 'DISCONNECT_PENDING')
      try {
        const [userCredential, nodeCredential] = await Promise.all([
          userToken(user.id, true),
          approvedMasterCredential(db, config),
        ]);
        await masterRequest(
          config,
          '/api/v1/identity/logout',
          { method: 'POST', token: nodeCredential, userToken: userCredential },
          fetcher,
        );
      } catch (error) {
        const code =
          error instanceof MasterError
            ? error.code
            : error instanceof AppError
              ? error.code
              : 'MASTER_UNREACHABLE';
        if (
          ![
            'COMMUNITY_ACCOUNT_REAUTHENTICATION_REQUIRED',
            'COMMUNITY_CREDENTIAL_UNREADABLE',
          ].includes(code)
        ) {
          await db.query(
            "UPDATE community_user_connections SET state='DISCONNECT_PENDING',error=$2,updated_at=now() WHERE user_id=$1",
            [user.id, code],
          );
          return reply.code(202).send(userView(await userRow(user.id)));
        }
      }
    await db.query(
      `UPDATE community_user_connections SET state='DISCONNECTED',device_code_cipher=NULL,session_cipher=NULL,user_code=NULL,verification_uri=NULL,verification_uri_complete=NULL,expires_at=NULL,
      master_account_id=NULL,master_handle=NULL,master_display_name=NULL,error=NULL,updated_at=now() WHERE user_id=$1`,
      [user.id],
    );
    await logs.write(
      'INFO',
      'community.user_disconnected',
      `Community identity disconnected by ${user.username}`,
    );
    return userView(await userRow(user.id));
  });
  app.get('/api/v1/community/friends', async (req) =>
    parsed(z.array(friendSchema), await userRequest((await auth.user(req)).id, '/api/v1/friends')),
  );
  app.get('/api/v1/community/friends/presence', async (req) =>
    friendsPresence((await auth.user(req)).id),
  );
  app.get('/api/v1/community/friends/requests', async (req) =>
    parsed(
      friendRequestsSchema,
      await userRequest((await auth.user(req)).id, '/api/v1/friends/requests'),
    ),
  );
  app.post('/api/v1/community/friends/requests', async (req, reply) => {
    const body = z.object({ handle }).strict().parse(req.body),
      result = parsed(
        z.object({ id: z.string().uuid() }).strict(),
        await userRequest((await auth.user(req)).id, '/api/v1/friends/requests', {
          method: 'POST',
          body,
        }),
      );
    return reply.code(201).send(result);
  });
  app.post('/api/v1/community/friends/requests/:id/accept', friendRequestAction('accept'));
  app.post('/api/v1/community/friends/requests/:id/decline', friendRequestAction('decline'));
  app.delete('/api/v1/community/friends/requests/:id', friendRequestAction());
  app.delete('/api/v1/community/friends/:handle', async (req, reply) => {
    const target = z.object({ handle }).parse(req.params).handle;
    await userRequest((await auth.user(req)).id, `/api/v1/friends/${encodeURIComponent(target)}`, {
      method: 'DELETE',
    });
    return reply.code(204).send();
  });
  registerPresenceAndSessions('/api/v1/community', async (req) => (await auth.user(req)).id);
  app.get('/api/v1/device/community/account', async (req) => {
    const device = await auth.device(req),
      current = await userRow(device.user_id);
    await queueAccountNotice(device.user_id, device.id, current);
    return userView(current);
  });
  app.get('/api/v1/device/community/friends/presence', async (req) =>
    friendsPresence((await auth.device(req)).user_id),
  );
  registerPresenceAndSessions(
    '/api/v1/device/community',
    async (req) => (await auth.device(req)).user_id,
  );
}
