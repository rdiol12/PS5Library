import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Config } from '../config.js';
import { queryOne, transaction, type DB } from '../db.js';
import { hash, passwordHash, passwordMatches, sameSecret, secret } from './credentials.js';
import { AppError } from '../security/errors.js';

// Fail closed for sandboxed storefronts. New device endpoints remain agent-only
// until explicitly reviewed here; no frontend may publish physical console state.
const frontendRoutes = new Set([
  'GET /api/v1/device/status',
  'GET /api/v1/device/catalog',
  'GET /api/v1/device/jobs',
  'GET /api/v1/device/consoles',
  'GET /api/v1/device/profile',
  'GET /api/v1/device/events',
  'GET /api/v1/device/consoles/:id/library',
  'GET /api/v1/device/installations',
  'GET /api/v1/device/updates',
  'GET /api/v1/device/native-updates',

  'GET /api/v1/device/community/account',
  'GET /api/v1/device/community/friends/presence',
  'GET /api/v1/device/community/game-sessions',
  'POST /api/v1/device/community/game-sessions',
  'POST /api/v1/device/community/game-sessions/:id/join',
  'PUT /api/v1/device/community/game-sessions/:id/heartbeat',
  'DELETE /api/v1/device/community/game-sessions/:id',

  'GET /api/v1/artwork/:gameId/:kind',
  'GET /api/v1/profile/avatar',
  'GET /api/v1/trailers/:gameId',
  'GET /api/v1/music/:gameId',

  'POST /api/v1/device/games/:id/save',
  'POST /api/v1/device/installations/plan',
  'POST /api/v1/device/transfers/plan',
  'POST /api/v1/device/installations',
  'POST /api/v1/device/transfers',
  'POST /api/v1/device/consoles/:id/refresh',
  'POST /api/v1/device/consoles/:id/library/remove',
  'POST /api/v1/device/jobs/reorder',
  'POST /api/v1/device/jobs/:id/control',
  'DELETE /api/v1/device/jobs/:id',
  'DELETE /api/v1/device/installations/:id',
  'PUT /api/v1/device/profile/avatar',
  'DELETE /api/v1/device/profile/avatar',
  'PUT /api/v1/device/community/presence',
  'DELETE /api/v1/device/community/presence',

  'POST /api/v1/pairings/claim',
]);

function clientMetadata(request: FastifyRequest) {
  const userAgent = Array.isArray(request.headers['user-agent'])
    ? request.headers['user-agent'][0]
    : request.headers['user-agent'];
  return {
    ip: isIP(request.ip) ? request.ip : null,
    agent: userAgent?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || null,
  };
}

export function authentication(db: DB) {
  const token = (request: FastifyRequest) =>
    request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ??
    request.cookies.session ??
    '';

  const user = async (request: FastifyRequest) => {
    const tokenHash = hash(token(request));
    const row = await queryOne(
      db,
      `SELECT u.id, u.username, u.role, u.default_console_id,
                s.last_seen_at AS session_last_seen,
                host(s.last_ip) AS session_ip,
                s.user_agent AS session_agent
           FROM users u
           JOIN sessions s ON s.user_id = u.id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!row) {
      throw new AppError('UNAUTHORIZED', 401);
    }

    const { ip, agent } = clientMetadata(request);
    const sessionChanged =
      Date.now() - new Date(row.session_last_seen).getTime() > 60_000 ||
      row.session_ip !== ip ||
      row.session_agent !== agent;
    if (sessionChanged) {
      await db.query(
        'UPDATE sessions SET last_seen_at=now(),last_ip=$2,user_agent=$3 WHERE token_hash=$1',
        [tokenHash, ip, agent],
      );
    }
    return row;
  };

  const device = async (request: FastifyRequest) => {
    const tokenHash = hash(token(request));
    const row = await queryOne(
      db,
      `SELECT c.*,
                k.id AS credential_id,
                k.kind AS credential_kind,
                k.last_seen_at AS credential_last_seen,
                host(k.last_ip) AS credential_ip
           FROM consoles c
           JOIN console_credentials k ON k.console_id = c.id
          WHERE k.token_hash = $1
            AND k.revoked_at IS NULL
            AND c.user_id IS NOT NULL`,
      [tokenHash],
    );
    if (!row) {
      throw new AppError('UNAUTHORIZED', 401);
    }

    const { ip } = clientMetadata(request);
    const credentialChanged =
      !row.credential_last_seen ||
      Date.now() - new Date(row.credential_last_seen).getTime() > 60_000 ||
      row.credential_ip !== ip;
    if (credentialChanged) {
      await db.query(
        'UPDATE console_credentials SET last_seen_at=now(),last_ip=$2 WHERE token_hash=$1',
        [tokenHash, ip],
      );
    }

    if (row.credential_kind === 'FRONTEND') {
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const route = `${method} ${request.routeOptions.url}`;
      if (!frontendRoutes.has(route)) {
        throw new AppError('AGENT_REQUIRED', 403);
      }
      // Only use of this specific credential acknowledges its delivery. An
      // independently running agent must not consume a pending app pairing.
      await db.query(
        `UPDATE pairings
            SET credential_cipher = NULL
          WHERE credential_id = $1
            AND credential_cipher IS NOT NULL`,
        [row.credential_id],
      );
    }
    return row;
  };
  return { user, device, token };
}

export type Auth = ReturnType<typeof authentication>;
export async function authRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const invalidPasswordHash = await passwordHash(secret());
  const credentials = z.object({
    username: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[A-Za-z0-9_.@-]+$/),
    password: z.string().min(1).max(200),
    bootstrapToken: z.string().max(200).optional(),
    inviteToken: z.string().max(100).optional(),
  });
  const registration = credentials.extend({ password: z.string().min(12).max(200) });
  const sessionCookie = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.PUBLIC_URL.startsWith('https:'),
    maxAge: 30 * 86400,
  } as const;

  const createSession = async (userId: string, request: FastifyRequest) => {
    const token = secret();
    const { ip, agent } = clientMetadata(request);
    await db.query('DELETE FROM sessions WHERE expires_at<=now()');
    await db.query(
      `INSERT INTO sessions(token_hash, user_id, expires_at, last_ip, user_agent)
       VALUES($1, $2, now() + interval '30 days', $3, $4)`,
      [hash(token), userId, ip, agent],
    );
    return token;
  };

  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = registration.parse(req.body);
      const id = randomUUID();
      const encodedPassword = await passwordHash(body.password);
      const user = await transaction(db, async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(3150002)');
        const isFirstUser = !(await sql.query('SELECT id FROM users LIMIT 1')).rowCount;
        let invitation;
        if (isFirstUser) {
          if (!sameSecret(body.bootstrapToken ?? '', config.BOOTSTRAP_TOKEN)) {
            throw new AppError('BOOTSTRAP_REQUIRED', 403);
          }
        } else {
          if (!config.features.accountRegistration) {
            throw new AppError('ACCOUNT_REGISTRATION_DISABLED', 403);
          }
          invitation = await queryOne(
            sql,
            `SELECT id
                 FROM invites
                WHERE token_hash = $1
                  AND expires_at > now()
                  AND claimed_by IS NULL
                  FOR UPDATE`,
            [hash(body.inviteToken ?? '')],
          );
          if (!invitation) {
            throw new AppError('VALID_INVITE_REQUIRED', 403);
          }
        }
        const createdUser = await queryOne(
          sql,
          `INSERT INTO users(id, username, password_hash, role)
             VALUES($1, $2, $3, $4)
             RETURNING id, username, role`,
          [id, body.username, encodedPassword, isFirstUser ? 'ADMIN' : 'MEMBER'],
        );
        if (invitation) {
          await sql.query('UPDATE invites SET claimed_by=$1 WHERE id=$2', [id, invitation.id]);
        }
        return createdUser;
      });
      const token = await createSession(id, req);
      reply.setCookie('session', token, sessionCookie);
      return reply.code(201).send({ user, token });
    },
  );
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = credentials.parse(req.body);
      const row = await queryOne(
        db,
        'SELECT id,username,role,password_hash FROM users WHERE username=$1',
        [body.username],
      );
      const valid = await passwordMatches(body.password, row?.password_hash ?? invalidPasswordHash);
      if (!row || !valid) {
        throw new AppError('INVALID_CREDENTIALS', 401);
      }
      const token = await createSession(row.id, req);
      reply.setCookie('session', token, sessionCookie);
      return { user: { id: row.id, username: row.username, role: row.role }, token };
    },
  );
  app.post('/api/v1/auth/logout', async (req, reply) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(auth.token(req))]);
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/v1/me', async (req) => {
    const user = await auth.user(req);
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      defaultConsoleId: user.default_console_id,
    };
  });
  app.post('/api/v1/admin/invites', async (req, reply) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 403);
    }
    if (!config.features.accountRegistration) {
      throw new AppError('ACCOUNT_REGISTRATION_DISABLED', 403);
    }
    const token = secret();
    const id = randomUUID();
    await db.query('DELETE FROM invites WHERE expires_at<=now() OR claimed_by IS NOT NULL');
    await db.query(
      `INSERT INTO invites(id, created_by, token_hash, expires_at)
       VALUES($1, $2, $3, now() + interval '7 days')`,
      [id, user.id, hash(token)],
    );
    return reply.code(201).send({ id, token, expiresInSeconds: 7 * 86400 });
  });
}
