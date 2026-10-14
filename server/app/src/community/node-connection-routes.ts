import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { seal } from '../auth/credentials.js';
import type { Auth } from '../auth/routes.js';
import { transaction } from '../db.js';
import { AppError } from '../security/errors.js';
import {
  MasterError,
  masterRequest,
  nodeCipherContext,
  openMasterCredential,
} from './master-client.js';
import type { CommunityRouteContext } from './shared.js';
const connectionSchema = z.object({
  connectionId: z.string().uuid(),
  serverId: z.string().regex(/^srv_[A-Za-z0-9_-]{16}$/),
  status: z.enum(['PENDING', 'APPROVED', 'BANNED']),
  banReason: z.string().nullable().optional(),
});
const disconnectUsers = `UPDATE community_user_connections
  SET state='DISCONNECTED',
      device_code_cipher=NULL,
      session_cipher=NULL,
      user_code=NULL,
      verification_uri=NULL,
      verification_uri_complete=NULL,
      error=NULL,
      updated_at=now()`;
export function registerNodeConnectionRoutes({
  app,
  db,
  config,
  auth,
  logs,
  fetcher,
}: CommunityRouteContext) {
  const admin = async (req: Parameters<Auth['user']>[0]) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN', 403);
    return user;
  };
  const row = async () =>
    (await db.query('SELECT * FROM community_master_connection WHERE singleton')).rows[0];
  const view = (value: any) =>
    value
      ? {
          configured: Boolean(config.COMMUNITY_MASTER_URL) && config.features.community,
          displayName: value.display_name,
          serverId: value.server_identifier,
          state: value.state,
          userCode: value.state === 'AWAITING_OWNER' ? value.user_code : null,
          verificationUriComplete:
            value.state === 'AWAITING_OWNER' ? value.verification_uri_complete : null,
          expiresAt: value.expires_at,
          banReason: value.state === 'BANNED' ? value.ban_reason : null,
          error: value.error,
          updatedAt: value.updated_at,
        }
      : {
          configured: Boolean(config.COMMUNITY_MASTER_URL) && config.features.community,
          state: 'DISCONNECTED',
        };
  const poll = async () => {
    const current = await row();
    if (!current?.credential_cipher || current.state === 'DISCONNECTED') return current;
    if (current.master_url !== config.COMMUNITY_MASTER_URL) {
      await db.query(
        "UPDATE community_master_connection SET state='ERROR',error='COMMUNITY_MASTER_CHANGED',updated_at=now() WHERE singleton",
      );
      return row();
    }
    let token: string;
    try {
      token = await openMasterCredential(db, config, current);
    } catch {
      await db.query(
        "UPDATE community_master_connection SET state='ERROR',error='CREDENTIAL_UNREADABLE',updated_at=now() WHERE singleton",
      );
      return row();
    }
    if (current.state === 'DISCONNECT_PENDING')
      try {
        await masterRequest(config, '/api/v1/connection', { method: 'DELETE', token }, fetcher);
        await transaction(db, async (sql) => {
          await sql.query(
            "UPDATE community_master_connection SET credential_cipher=NULL,state='DISCONNECTED',error=NULL,updated_at=now() WHERE singleton",
          );
          await sql.query(disconnectUsers);
        });
        return row();
      } catch (error) {
        const code = error instanceof MasterError ? error.code : 'MASTER_UNREACHABLE';
        await db.query(
          'UPDATE community_master_connection SET error=$1,updated_at=now() WHERE singleton',
          [code],
        );
        return row();
      }
    try {
      const result = current.server_identifier
        ? connectionSchema
            .pick({ serverId: true, status: true, banReason: true })
            .parse(await masterRequest(config, '/api/v1/connections/status', { token }, fetcher))
        : connectionSchema.parse(
            await masterRequest(
              config,
              '/api/v1/device-authorizations/token',
              { method: 'POST', body: { deviceCode: token } },
              fetcher,
            ),
          );
      await db.query(
        `UPDATE community_master_connection
            SET server_identifier=$1,
                state=$2,
                ban_reason=$3,
                error=NULL,
                user_code=NULL,
                verification_uri=NULL,
                verification_uri_complete=NULL,
                updated_at=now()
          WHERE singleton`,
        [result.serverId, result.status, result.banReason ?? null],
      );
      if (current.state !== result.status)
        await logs.write(
          'INFO',
          'community.state_changed',
          `Community connection is ${result.status}`,
          { serverId: result.serverId, state: result.status },
        );
    } catch (error) {
      if (error instanceof MasterError && error.code === 'AUTHORIZATION_PENDING') return current;
      const code =
        error instanceof MasterError
          ? error.code
          : error instanceof AppError
            ? error.code
            : 'MASTER_UNREACHABLE';
      await db.query(
        "UPDATE community_master_connection SET state=CASE WHEN state='DISCONNECT_PENDING' THEN state ELSE 'ERROR' END,error=$1,updated_at=now() WHERE singleton",
        [code],
      );
      await logs.write('WARN', 'community.poll_failed', code);
    }
    return row();
  };

  app.get('/api/v1/admin/community', async (req) => {
    await admin(req);
    return view(config.features.community ? await poll() : await row());
  });
  app.post(
    '/api/v1/admin/community/request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await admin(req),
        { displayName } = z
          .object({ displayName: z.string().trim().min(1).max(80) })
          .strict()
          .parse(req.body);
      if (!config.COMMUNITY_MASTER_URL) throw new AppError('COMMUNITY_MASTER_NOT_CONFIGURED', 409);
      const existing = await row(),
        installationId = existing?.installation_id ?? randomUUID(),
        created = z
          .object({
            deviceCode: z.string().regex(/^[a-f0-9]{64}$/),
            userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
            verificationUri: z.string().url(),
            verificationUriComplete: z.string().url(),
            expiresIn: z.number().int().min(60).max(3600),
          })
          .parse(
            await masterRequest(
              config,
              '/api/v1/device-authorizations',
              { method: 'POST', body: { installationId, displayName } },
              fetcher,
            ),
          );
      for (const location of [created.verificationUri, created.verificationUriComplete])
        if (new URL(location).origin !== config.COMMUNITY_MASTER_URL)
          throw new AppError('INVALID_MASTER_RESPONSE', 502);
      await db.query(
        `INSERT INTO community_master_connection(
           singleton,installation_id,master_url,display_name,credential_cipher,user_code,
           verification_uri,verification_uri_complete,state,expires_at,error,updated_at
         )
         VALUES(
           true,$1,$2,$3,$4,$5,$6,$7,'AWAITING_OWNER',
           now()+$8*interval '1 second',NULL,now()
         )
         ON CONFLICT(singleton) DO UPDATE SET
           installation_id=EXCLUDED.installation_id,
           master_url=EXCLUDED.master_url,
           display_name=EXCLUDED.display_name,
           credential_cipher=EXCLUDED.credential_cipher,
           user_code=EXCLUDED.user_code,
           verification_uri=EXCLUDED.verification_uri,
           verification_uri_complete=EXCLUDED.verification_uri_complete,
           server_identifier=NULL,
           state='AWAITING_OWNER',
           ban_reason=NULL,
           expires_at=EXCLUDED.expires_at,
           error=NULL,
           updated_at=now()`,
        [
          installationId,
          config.COMMUNITY_MASTER_URL,
          displayName,
          seal(
            created.deviceCode,
            config.BOOTSTRAP_TOKEN,
            nodeCipherContext(config.COMMUNITY_MASTER_URL),
          ),
          created.userCode,
          created.verificationUri,
          created.verificationUriComplete,
          created.expiresIn,
        ],
      );
      await logs.write(
        'INFO',
        'community.access_requested',
        `Community access requested by ${user.username}`,
        { state: 'AWAITING_OWNER' },
      );
      return reply.code(202).send(view(await row()));
    },
  );
  app.post('/api/v1/admin/community/refresh', async (req) => {
    await admin(req);
    return view(await poll());
  });
  app.delete('/api/v1/admin/community', async (req, reply) => {
    const user = await admin(req),
      current = await row();
    if (!current) return reply.code(204).send();
    if (current.credential_cipher && current.master_url !== config.COMMUNITY_MASTER_URL) {
      await transaction(db, async (sql) => {
        await sql.query(
          "UPDATE community_master_connection SET state='DISCONNECT_PENDING',error='COMMUNITY_MASTER_CHANGED',updated_at=now() WHERE singleton",
        );
        await sql.query(disconnectUsers);
      });
      return reply.code(202).send(view(await row()));
    }
    if (current.credential_cipher) {
      let token: string;
      try {
        token = await openMasterCredential(db, config, current);
      } catch {
        await db.query(
          "UPDATE community_master_connection SET state='DISCONNECT_PENDING',error='CREDENTIAL_UNREADABLE',updated_at=now() WHERE singleton",
        );
        return reply.code(202).send(view(await row()));
      }
      try {
        await masterRequest(config, '/api/v1/connection', { method: 'DELETE', token }, fetcher);
      } catch (error) {
        const code = error instanceof MasterError ? error.code : 'MASTER_UNREACHABLE';
        await db.query(
          "UPDATE community_master_connection SET state='DISCONNECT_PENDING',error=$1,updated_at=now() WHERE singleton",
          [code],
        );
        await logs.write('WARN', 'community.disconnect_pending', code);
        return reply.code(202).send(view(await row()));
      }
    }
    await transaction(db, async (sql) => {
      await sql.query(
        `UPDATE community_master_connection
            SET credential_cipher=NULL,
                user_code=NULL,
                verification_uri=NULL,
                verification_uri_complete=NULL,
                state='DISCONNECTED',
                error=NULL,
                updated_at=now()
          WHERE singleton`,
      );
      await sql.query(disconnectUsers);
    });
    await logs.write(
      'INFO',
      'community.disconnected',
      `Community disconnected by ${user.username}`,
    );
    return { ok: true };
  });
}
