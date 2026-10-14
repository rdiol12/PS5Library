import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { accessibleSource } from '../sources/access.js';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database, migrate, transaction } from '../db.js';
import type { Config } from '../config.js';
import { authentication, authRoutes } from '../auth/routes.js';
import { hash } from '../auth/credentials.js';
import { profileRoutes } from '../auth/profile.js';
import { trailerRoutes } from '../artwork/trailers.js';
import { consoleRoutes } from '../consoles/routes.js';
import { removalRoutes } from '../consoles/removals.js';
import { saveBackupRoutes } from '../consoles/save-backups.js';
import { catalogRoutes } from '../catalog/routes.js';
import { updateRoutes } from '../updates/routes.js';
import { transferRoutes } from '../transfers/routes.js';
import { startRunner } from '../jobs/runner.js';
import { preparationRoutes } from '../jobs/preparation-routes.js';
import { installationRoutes } from '../jobs/installations.js';
import { jobEvent } from '../jobs/events.js';
import { AppError } from '../security/errors.js';
import { uuid } from '../../../shared/schemas/index.js';
import { serverLogger, type LogLevel } from '../logging.js';
import { communityRoutes } from '../community/routes.js';
import { communitySaveRoutes } from '../community/saves.js';
import { quotaExceeded, storageUsage } from '../storage/usage.js';
import { cheatProfileRoutes } from '../cheats/profiles.js';
import { cheatDeliveryRoutes } from '../cheats/deliveries.js';
import { runtimeSettings } from '../runtime-settings.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerJobRoutes } from '../jobs/routes.js';

// Keep source files focused while preserving the storefront's two-request asset contract.
export const browserBundles = [
  [
    '/app.js',
    ['app-library.js', 'app-profile.js', 'app-manager.js', 'app-details.js', 'app.js'],
    'application/javascript',
  ],
  [
    '/style.css',
    [
      'style-base.css',
      'style-operational.css',
      'style-storefront.css',
      'style-manager.css',
      'style-system.css',
      'style-consoles.css',
      'style-saves.css',
    ],
    'text/css',
  ],
] as const;
const browserAssetPaths = new Set<string>(browserBundles.map(([url]) => url));
const browserPagePaths = new Set<string>(['/', '/pair', '/profile']);

const newWorkRoutes = new Set([
  '/api/v1/downloads',
  '/api/v1/device/downloads',
  '/api/v1/preparations',
  '/api/v1/device/preparations',
  '/api/v1/installations',
  '/api/v1/device/installations',
  '/api/v1/transfers',
  '/api/v1/device/transfers',
]);
const ipLimitedRoutes = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/pairings',
  '/api/v1/frontend/pairings',
  '/api/v1/pairings/claim',
  '/api/v1/pairings/:id/poll',
  '/api/v1/hardware/recover',
]);
export const generalIpBackstopMax = 12_000;
export const rateLimitKey = (req: FastifyRequest) => {
  const route = req.routeOptions.url ?? req.url.split('?')[0]!;
  if (ipLimitedRoutes.has(route)) return `ip:${req.ip}`;
  const bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const credential = bearer ?? req.cookies.session;
  return credential && /^[a-f0-9]{64}$/.test(credential)
    ? `credential:${hash(credential)}`
    : `ip:${req.ip}`;
};
export const serverVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .parse(
    (
      JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
        version?: unknown;
      }
    ).version,
  );
export async function installRateLimits(
  app: FastifyInstance,
  ipBackstopMax = generalIpBackstopMax,
) {
  await app.register(rateLimit, {
    max: 500,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  });
  const backstop = app.createRateLimit({
    max: ipBackstopMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => `ip:${req.ip}`,
  });
  app.addHook('onRequest', async (req) => {
    const result = await backstop(req);
    if (!result.isAllowed && result.isExceeded) throw new AppError('RATE_LIMITED', 429);
  });
}

export async function createApp(
  config: Config,
  overrides: {
    communityFetch?: typeof fetch;
    operatorFetch?: typeof fetch;
  } = {},
) {
  await mkdir(config.DATA_DIR, { recursive: true });
  await mkdir(path.join(config.DATA_DIR, 'jobs'), { recursive: true });
  await mkdir(config.SOURCE_ROOT, { recursive: true });
  const db = database(config.DATABASE_URL);
  await migrate(db);
  const settings = await runtimeSettings(db, config);
  const logs = await serverLogger(config.DATA_DIR);
  const startedAt = new Date().toISOString();
  const requestStarted = new WeakMap<object, bigint>();
  const runner = await startRunner(db, config, logs);
  const trustProxy: boolean | ((address: string, hop: number) => boolean) = config.TRUST_PROXY_HOPS
    ? (_address, hop) => hop < config.TRUST_PROXY_HOPS
    : false;
  const app = Fastify({ bodyLimit: 4 * 1024 ** 2, logger: false, trustProxy });
  await app.register(cookie);
  await installRateLimits(app);
  await app.register(websocket, { options: { maxPayload: 4 * 1024 ** 2 } });
  app.addHook('onRequest', async (req, reply) => {
    requestStarted.set(req, process.hrtime.bigint());
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY');
    if (config.PUBLIC_URL.startsWith('https:'))
      reply.header('strict-transport-security', 'max-age=31536000');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const route = req.url.split('?')[0]!;
    if (req.url.startsWith('/api/') || browserPagePaths.has(route) || browserAssetPaths.has(route))
      reply.header('cache-control', 'no-store');
    const rawClient = req.headers['x-ps5library-client'];
    const client = Array.isArray(rawClient) ? rawClient[0] : rawClient;
    if (route.startsWith('/api/') && client === 'companion' && !config.features.companionApp)
      throw new AppError('COMPANION_APP_DISABLED', 403);
    if (
      route.startsWith('/api/') &&
      !config.features.ps5Connections &&
      (client === 'ps5' ||
        route.startsWith('/api/v1/device/') ||
        route === '/api/v1/hardware/recover' ||
        route === '/api/v1/pairings' ||
        route === '/api/v1/frontend/pairings' ||
        route === '/api/v1/pairings/claim' ||
        /^\/api\/v1\/pairings\/[^/]+\/poll$/.test(route))
    )
      throw new AppError('PS5_CONNECTIONS_DISABLED', 403);
    if (
      !config.features.community &&
      (route.startsWith('/api/v1/community/') ||
        route.startsWith('/api/v1/device/community/') ||
        (req.method === 'POST' &&
          (route.startsWith('/api/v1/admin/community/') ||
            (route.startsWith('/api/v1/portable-saves/') && route.endsWith('/publish')))))
    )
      throw new AppError('COMMUNITY_FEATURES_DISABLED', 403);
    if (!config.features.newDownloads && req.method === 'POST' && newWorkRoutes.has(route))
      throw new AppError('NEW_DOWNLOADS_DISABLED', 403);
    if (req.headers.origin && !config.browserOrigins.includes(req.headers.origin))
      throw new AppError('ORIGIN_DENIED', 403);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url || req.url.split('?')[0]!;
    const started = requestStarted.get(req);
    const statusCode = reply.statusCode;
    if (
      route === '/health' ||
      browserAssetPaths.has(route) ||
      (route === '/api/v1/device/events' && statusCode < 400)
    )
      return;
    const level: LogLevel = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    void logs.write(level, 'http.request', undefined, {
      requestId: req.id,
      method: req.method,
      route,
      statusCode,
      durationMs: started ? Math.round(Number(process.hrtime.bigint() - started) / 1e6) : undefined,
      range: route.startsWith('/api/v1/native-updates/') ? (req.headers.range ?? null) : undefined,
    });
  });
  app.setErrorHandler((error: any, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        issues: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (error instanceof AppError) {
      void logs.write('WARN', 'http.rejected', error.message, {
        requestId: req.id,
        method: req.method,
        route: req.routeOptions.url,
        statusCode: error.statusCode,
        code: error.code,
      });
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error.code === '23505') return reply.code(409).send({ error: 'ALREADY_EXISTS' });
    if (error.code === 'ENOENT') return reply.code(404).send({ error: 'INPUT_NOT_FOUND' });
    if (error.message === 'METADATA_MISMATCH' || error.message === 'UNSAFE_PATH')
      return reply.code(409).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: 'REQUEST_REJECTED' });
    void logs.write('ERROR', 'http.error', error.message, {
      requestId: req.id,
      method: req.method,
      route: req.routeOptions.url,
      statusCode: 500,
    });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  const auth = authentication(db);
  app.get('/api/v1/service-info', async () => ({
    service: 'ps5library-node',
    apiVersion: 1,
  }));
  await authRoutes(app, db, config, auth);
  await cheatProfileRoutes(app, db, auth);
  await cheatDeliveryRoutes(app, db, auth);
  registerAdminRoutes(app, db, config, auth, settings, logs, runner, startedAt, overrides);
  await communityRoutes(app, db, config, auth, logs, overrides.communityFetch);
  await communitySaveRoutes(app, db, config, auth, logs, overrides.communityFetch);
  await profileRoutes(app, db, config, auth);
  await consoleRoutes(app, db, config, auth);
  await saveBackupRoutes(app, db, config, auth);
  await updateRoutes(app, config, auth, db);
  const transfers = await transferRoutes(app, db, config, auth);
  await trailerRoutes(app, db, config, auth, runner.reconcile);
  const preparation = await preparationRoutes(app, db, config, auth, runner.reconcile);
  await removalRoutes(app, db, auth);
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok', version: serverVersion };
  });
  for (const [url, file] of [
    ['/', 'index.html'],
    ['/pair', 'index.html'],
    ['/profile', 'index.html'],
  ] as const)
    app.get(url, async (_req, reply) =>
      reply.type('text/html').send(await readFile(path.resolve('app/public', file), 'utf8')),
    );
  for (const [url, files, contentType] of browserBundles) {
    const content = (
      await Promise.all(files.map((file) => readFile(path.resolve('app/public', file), 'utf8')))
    ).join('\n');
    app.get(url, async (_req, reply) => reply.type(contentType).send(content));
  }
  for (const file of ['space-grotesk-medium.ttf', 'space-grotesk-bold.ttf'])
    app.get(`/fonts/${file}`, async (_req, reply) =>
      reply
        .type('font/ttf')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(await readFile(path.resolve('app/public/fonts', file))),
    );
  const enqueueDownload = async (userId: string, sourceReleaseId: string, automatic = false) => {
    if (!config.features.newDownloads) {
      if (automatic) return { skipped: true };
      throw new AppError('NEW_DOWNLOADS_DISABLED', 403);
    }
    const source = await accessibleSource(db, userId, sourceReleaseId);
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (['folder', 'zip', 'rar', '7z'].includes(source.metadata.format))
      throw new AppError('BUILD_REQUIRED', 409);
    if (
      automatic &&
      (
        await db.query(
          "SELECT 1 FROM automatic_preparations WHERE source_release_id=$1 AND input_hash=$2 AND method='DOWNLOAD'",
          [source.id, source.metadata.sha256],
        )
      ).rowCount
    )
      return { skipped: true };
    const result = await transaction(db, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const cached = (
        await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND sha256=$2 AND verified', [
          source.release_id,
          source.metadata.sha256,
        ])
      ).rows[0];
      if (cached) {
        const file = path.join(config.DATA_DIR, cached.relative_path);
        const fileStat = await stat(file).catch(() => null);
        if (fileStat?.isFile() && fileStat.size === Number(cached.size)) {
          if (automatic)
            await sql.query(
              `INSERT INTO automatic_preparations(
                 source_release_id,
                 input_hash,
                 method
               )
               VALUES($1, $2, 'DOWNLOAD')
               ON CONFLICT DO NOTHING`,
              [source.id, source.metadata.sha256],
            );
          return { cached: true, artifactId: cached.id as string };
        }
        await sql.query('UPDATE artifacts SET verified=false WHERE id=$1', [cached.id]);
        if (fileStat) return { corrupt: true as const };
      }
      if (
        (
          await sql.query(
            "SELECT metadata ? 'retiredAt' AS retired FROM source_releases WHERE id=$1 FOR UPDATE",
            [source.id],
          )
        ).rows[0]?.retired
      )
        return { retired: true as const };
      if (
        automatic &&
        !(
          await sql.query(
            `INSERT INTO automatic_preparations(
               source_release_id,
               input_hash,
               method
             )
             VALUES($1, $2, 'DOWNLOAD')
             ON CONFLICT DO NOTHING
             RETURNING source_release_id`,
            [source.id, source.metadata.sha256],
          )
        ).rowCount
      )
        return { skipped: true };
      const active = (
        await sql.query(
          `SELECT id
           FROM jobs
           WHERE source_release_id = $1
           AND user_id = $2
           AND kind = 'DOWNLOAD'
           AND state NOT IN ('COMPLETED', 'ERROR', 'CANCELLED')`,
          [source.id, userId],
        )
      ).rows[0];
      if (active) return { id: active.id as string, cached: false };
      if (quotaExceeded(await storageUsage(sql), source.metadata.size, config.QUOTA_BYTES))
        throw new AppError('QUOTA_EXCEEDED', 409);
      const id = randomUUID();
      await sql.query(
        `INSERT INTO jobs(
           id,
           user_id,
           kind,
           release_id,
           source_release_id,
           state,
           total_bytes,
           config
         )
         VALUES($1, $2, 'DOWNLOAD', $3, $4, 'QUEUED', $5, $6)`,
        [
          id,
          userId,
          source.release_id,
          sourceReleaseId,
          source.metadata.size,
          {
            sourceMetadata: source.metadata,
            sourceConfig: source.config,
            sourceType: source.type,
            sourceOwner: source.source_owner,
          },
        ],
      );
      await jobEvent(sql, id);
      return { id, cached: false };
    });
    if ('corrupt' in result) throw new AppError('CACHE_CORRUPT', 409);
    if ('retired' in result)
      throw new AppError('SOURCE_RETIRED', 409, 'Restore this dump before downloading it again.');
    await runner.reconcile();
    return result;
  };
  await catalogRoutes(app, db, config, auth, preparation.enqueue, enqueueDownload);
  const installations = await installationRoutes(
    app,
    db,
    auth,
    preparation,
    transfers,
    enqueueDownload,
  );
  app.post('/api/v1/downloads', async (req, reply) => {
    const user = await auth.user(req),
      body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(user.id, body.sourceReleaseId));
  });
  app.post('/api/v1/device/downloads', async (req, reply) => {
    const consoleInfo = await auth.device(req),
      body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(consoleInfo.user_id, body.sourceReleaseId));
  });
  registerJobRoutes(app, db, auth, runner);
  await logs.write(
    'INFO',
    'server.initialized',
    `PS5Library initialized on ${config.HOST}:${config.PORT}`,
  );
  app.addHook('onClose', async () => {
    await logs.write('INFO', 'server.stopping');
    await installations.close();
    await runner.close();
    await transfers.close();
    await db.end();
    await logs.flush();
  });
  return app;
}
