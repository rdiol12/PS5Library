import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { transaction, type DB } from '../db.js';
import { hash, passwordHash, passwordMatches, sameSecret, secret } from './credentials.js';
import { AppError } from '../security/errors.js';

export function authentication(db: DB) {
  const token = (req: FastifyRequest) => req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? req.cookies.session ?? '';
  const user = async (req: FastifyRequest) => {
    const row = (await db.query('SELECT u.id,u.username,u.role,u.default_console_id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()', [hash(token(req))])).rows[0];
    if (!row) throw new AppError('UNAUTHORIZED', 401); return row;
  };
  const device = async (req: FastifyRequest) => {
    const row = (await db.query('SELECT c.* FROM consoles c JOIN console_credentials k ON k.console_id=c.id WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND c.user_id IS NOT NULL', [hash(token(req))])).rows[0];
    if (!row) throw new AppError('UNAUTHORIZED', 401); return row;
  };
  return { user, device, token };
}
export type Auth = ReturnType<typeof authentication>;
export async function authRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const credentials = z.object({ username: z.string().min(3).max(80).regex(/^[A-Za-z0-9_.@-]+$/), password: z.string().min(12).max(200), bootstrapToken: z.string().max(200).optional(), inviteToken: z.string().max(100).optional() });
  const session = async (id: string) => {
    const token = secret();
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [hash(token), id]);
    return token;
  };
  app.post('/api/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.parse(req.body), id = randomUUID();
    const encoded = await passwordHash(body.password);
    const user = await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150002)');
      const first = !(await sql.query('SELECT id FROM users LIMIT 1')).rowCount;
      let invitation;
      if (first) { if (!sameSecret(body.bootstrapToken ?? '', config.BOOTSTRAP_TOKEN)) throw new AppError('BOOTSTRAP_REQUIRED', 403); }
      else {
        invitation = (await sql.query('SELECT id FROM invites WHERE token_hash=$1 AND expires_at>now() AND claimed_by IS NULL FOR UPDATE', [hash(body.inviteToken ?? '')])).rows[0];
        if (!invitation) throw new AppError('VALID_INVITE_REQUIRED', 403);
      }
      const user = (await sql.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,role', [id, body.username, encoded, first ? 'ADMIN' : 'MEMBER'])).rows[0];
      if (invitation) await sql.query('UPDATE invites SET claimed_by=$1 WHERE id=$2', [id, invitation.id]);
      return user;
    });
    const token = await session(id);
    reply.setCookie('session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.PUBLIC_URL.startsWith('https:'), maxAge: 30 * 86400 });
    return reply.code(201).send({ user, token });
  });
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.parse(req.body);
    const row = (await db.query('SELECT id,username,role,password_hash FROM users WHERE username=$1', [body.username])).rows[0];
    if (!row || !await passwordMatches(body.password, row.password_hash)) throw new AppError('INVALID_CREDENTIALS', 401);
    const token = await session(row.id);
    reply.setCookie('session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.PUBLIC_URL.startsWith('https:'), maxAge: 30 * 86400 });
    return { user: { id: row.id, username: row.username, role: row.role }, token };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(auth.token(req))]);
    reply.clearCookie('session', { path: '/' }); return { ok: true };
  });
  app.get('/api/v1/me', async req => {
    const u = await auth.user(req); return { id: u.id, username: u.username, role: u.role, defaultConsoleId: u.default_console_id };
  });
  app.post('/api/v1/admin/invites', async (req, reply) => {
    const u = await auth.user(req); if (u.role !== 'ADMIN') throw new AppError('FORBIDDEN', 403);
    const token = secret(), id = randomUUID();
    await db.query("INSERT INTO invites(id,created_by,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days')", [id, u.id, hash(token)]);
    return reply.code(201).send({ id, token, expiresInSeconds: 7 * 86400 });
  });
}
