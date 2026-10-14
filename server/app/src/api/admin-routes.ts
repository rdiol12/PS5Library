import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import { queryRows, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { clearDashboardLogs, readLogs, type Logger } from '../logging.js';
import { managedService, operatorStatus, restartManagedService } from '../operator-client.js';
import { runtimeSettings, runtimeSettingsUpdate } from '../runtime-settings.js';
import { startRunner } from '../jobs/runner.js';

const packageWorkerStatus = (
  config: Pick<Config, 'PACKAGE_WORKER_SOCKET' | 'PACKAGE_WORKER_URL' | 'PACKAGE_WORKER_TOKEN'>,
) =>
  new Promise<{ status: 'CONNECTED' | 'OFFLINE'; latencyMs: number }>((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const finish = (status: 'CONNECTED' | 'OFFLINE') => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      });
    };
    const receive = (response: import('node:http').IncomingMessage) => {
      response.resume();
      response.on('end', () => finish(response.statusCode === 200 ? 'CONNECTED' : 'OFFLINE'));
    };
    const request = config.PACKAGE_WORKER_URL
      ? httpRequest(
          new URL('/health', config.PACKAGE_WORKER_URL),
          {
            method: 'GET',
            timeout: 1000,
            headers: {
              authorization: `Bearer ${config.PACKAGE_WORKER_TOKEN}`,
            },
          },
          receive,
        )
      : httpRequest(
          {
            socketPath: config.PACKAGE_WORKER_SOCKET,
            path: '/health',
            method: 'GET',
            timeout: 1000,
          },
          receive,
        );
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish('OFFLINE'));
    request.end();
  });

export function registerAdminRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  settings: Awaited<ReturnType<typeof runtimeSettings>>,
  logs: Logger,
  runner: Awaited<ReturnType<typeof startRunner>>,
  startedAt: string,
  overrides: { operatorFetch?: typeof fetch },
) {
  const admin = async (req: Parameters<typeof auth.user>[0]) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN', 403);
    return user;
  };
  app.get('/api/v1/admin/runtime-settings', async (req) => {
    await admin(req);
    return settings.get();
  });
  app.patch(
    '/api/v1/admin/runtime-settings',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await admin(req),
        body = runtimeSettingsUpdate.parse(req.body),
        result = await settings.update(body.revision, body.settings, user.id),
        changedKeys = Object.keys(body.settings).sort().join(',');
      await logs.write(
        'WARN',
        'admin.runtime_settings_changed',
        `Runtime settings changed by ${user.username}`,
        { changedKeys, revision: String(result.revision), ip: req.ip },
      );
      return result;
    },
  );
  app.get('/api/v1/admin/status', async (req) => {
    await admin(req);
    const databaseStarted = process.hrtime.bigint();
    const status = (
      await db.query(`SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM consoles) AS consoles,
      (SELECT count(*)::int FROM consoles WHERE last_seen>now()-interval '30 seconds') AS "onlineConsoles",
      (SELECT count(*)::int FROM sources) AS sources,
      (SELECT count(*)::int
       FROM jobs
       WHERE dismissed_at IS NULL
       AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED','PAUSED')) AS "activeJobs",
      (SELECT count(*)::int FROM jobs WHERE dismissed_at IS NULL AND state='ERROR') AS "failedJobs",
      (SELECT count(*)::int FROM pairings WHERE claimed_at IS NULL AND expires_at>now()) AS "pendingPairings",
      (SELECT COALESCE(sum(size),0) FROM artifacts WHERE deleted_at IS NULL) AS "artifactBytes"`)
    ).rows[0];
    const databaseLatencyMs = Math.round(Number(process.hrtime.bigint() - databaseStarted) / 1e6);
    const [redis, worker, control] = await Promise.all([
      runner.diagnostics().catch(() => ({ status: 'OFFLINE', latencyMs: null, queue: null })),
      packageWorkerStatus(config),
      config.OPERATOR_URL
        ? operatorStatus(config, overrides.operatorFetch).catch(() => null)
        : null,
    ]);
    return {
      ...status,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      features: config.features,
      database: 'CONNECTED',
      services: {
        api: {
          status: 'CONNECTED',
          uptimeSeconds: Math.floor(process.uptime()),
        },
        database: { status: 'CONNECTED', latencyMs: databaseLatencyMs },
        redis,
        worker,
        operator: { status: control ? 'CONNECTED' : 'OFFLINE' },
      },
      queue: redis.queue,
      host: control?.host ?? null,
      managedServices: control?.services ?? [],
    };
  });
  app.get('/api/v1/admin/accounts', async (req) => {
    await admin(req);
    const [users, sessions, devices] = await Promise.all([
      db.query('SELECT id,username,role,created_at AS "createdAt" FROM users ORDER BY created_at'),
      db.query(
        `SELECT
           user_id AS "userId",
           created_at AS "createdAt",
           last_seen_at AS "lastSeenAt",
           host(last_ip) AS ip,
           user_agent AS "userAgent",
           expires_at AS "expiresAt"
         FROM sessions
         WHERE expires_at > now()
         ORDER BY last_seen_at DESC`,
      ),
      db.query(
        `SELECT
           c.user_id AS "userId",
           c.id AS "consoleId",
           c.device_id AS "deviceId",
           c.name,
           c.client_kind AS "clientKind",
           c.firmware,
           c.runtime,
           c.agent_version AS "agentVersion",
           c.last_seen AS "consoleLastSeen",
           CASE
             WHEN c.last_seen > now() - interval '30 seconds' THEN 'ONLINE'
             WHEN c.last_seen > now() - interval '5 minutes' THEN 'STALE'
             ELSE 'OFFLINE'
           END AS presence,
           k.kind AS "credentialKind",
           k.last_seen_at AS "lastSeenAt",
           host(k.last_ip) AS ip,
           k.revoked_at AS "revokedAt"
         FROM consoles c
         JOIN console_credentials k ON k.console_id = c.id
         WHERE c.user_id IS NOT NULL
         ORDER BY c.name, k.created_at`,
      ),
    ]);
    return users.rows.map((user) => ({
      ...user,
      sessions: sessions.rows.filter((row) => row.userId === user.id),
      devices: devices.rows.filter((row) => row.userId === user.id),
    }));
  });
  app.get('/api/v1/admin/logs', async (req) => {
    await admin(req);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(200),
        level: z.enum(['INFO', 'WARN', 'ERROR']).optional(),
        service: z.enum(['server', 'worker']).optional(),
      })
      .parse(req.query);
    return readLogs(config.DATA_DIR, query);
  });
  app.get('/api/v1/admin/jobs', async (req) => {
    await admin(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return queryRows(
      db,
      `SELECT
           j.id,
           j.kind,
           j.state,
           j.downloaded_bytes AS "downloadedBytes",
           j.total_bytes AS "totalBytes",
           j.speed_bytes_per_second AS "speedBytesPerSecond",
           j.config->'progress' AS progress,
           j.error,
           j.attempts,
           j.updated_at AS "updatedAt",
           u.username,
           g.title
         FROM jobs j
         JOIN users u ON u.id = j.user_id
         LEFT JOIN game_releases r ON r.id = j.release_id
         LEFT JOIN games g ON g.id = r.game_id
         ORDER BY j.updated_at DESC
         LIMIT $1`,
      [limit],
    );
  });
  app.delete('/api/v1/admin/logs', async (req) => {
    const user = await admin(req);
    await clearDashboardLogs(config.DATA_DIR, logs);
    await logs.write('WARN', 'admin.logs_cleared', `Logs cleared by ${user.username}`);
    return { ok: true };
  });
  app.post(
    '/api/v1/admin/services/:service/restart',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await admin(req),
        service = managedService.parse((req.params as { service: string }).service),
        body = z.object({ confirm: z.string() }).strict().parse(req.body);
      if (body.confirm !== service) throw new AppError('CONFIRMATION_REQUIRED', 400);
      try {
        await restartManagedService(config, service, overrides.operatorFetch);
      } catch (error) {
        throw new AppError(
          error instanceof Error && error.message === 'SERVICE_NOT_FOUND'
            ? 'SERVICE_NOT_FOUND'
            : 'OPERATOR_UNAVAILABLE',
          503,
        );
      }
      await logs.write(
        'WARN',
        'admin.service_restart',
        `Service restart requested by ${user.username}`,
        { target: service, ip: req.ip },
      );
      return reply.code(202).send({ accepted: true, service });
    },
  );
}
