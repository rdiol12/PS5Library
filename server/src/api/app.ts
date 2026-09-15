import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database, migrate, transaction } from '../db.js';
import type { Config } from '../config.js';
import { authentication, authRoutes } from '../auth/routes.js';
import { consoleRoutes } from '../consoles/routes.js';
import { catalogRoutes } from '../catalog/routes.js';
import { featuredRoutes } from '../catalog/featured.js';
import { transferRoutes } from '../transfers/routes.js';
import { startRunner } from '../jobs/runner.js';
import { preparationRoutes } from '../jobs/preparation.js';
import { installationRoutes } from '../jobs/installations.js';
import { fileHash } from '../downloads/stream.js';
import { jobEvent, jobJSON } from '../jobs/events.js';
import { AppError } from '../security/errors.js';
import { uuid } from '../../../shared/schemas/index.js';

export async function createApp(config: Config) {
  await mkdir(config.DATA_DIR, { recursive: true }); await mkdir(config.SOURCE_ROOT, { recursive: true });
  const db = database(config.DATABASE_URL);
  await migrate(db);
  const app = Fastify({ bodyLimit: 4 * 1024 ** 2, logger: false, trustProxy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 500, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 ** 2 } });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('x-frame-options','DENY');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/')) reply.header('cache-control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== new URL(config.PUBLIC_URL).origin) throw new AppError('ORIGIN_DENIED', 403);
  });
  app.setErrorHandler((error: any, req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error.code === '23505') return reply.code(409).send({ error: 'ALREADY_EXISTS' });
    if (error.code === 'ENOENT') return reply.code(404).send({ error: 'INPUT_NOT_FOUND' });
    if (error.message === 'METADATA_MISMATCH' || error.message === 'UNSAFE_PATH') return reply.code(409).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'REQUEST_REJECTED' });
    console.error('Request failed:', req.method, req.routeOptions.url, error.code ?? error.name, error.message);
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  const auth = authentication(db);
  await authRoutes(app, db, config, auth);
  await consoleRoutes(app, db, config, auth);
  await catalogRoutes(app, db, config, auth);
  await featuredRoutes(app, db, config, auth);
  const transfers = await transferRoutes(app, db, config, auth);
  const runner = await startRunner(db, config);
  const preparation = await preparationRoutes(app, db, config, auth, runner.reconcile);
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok', version: '0.1.0' }; });
  for (const [url, file, contentType] of [['/','index.html','text/html'], ['/pair','index.html','text/html'], ['/app.js','app.js','application/javascript'], ['/style.css','style.css','text/css']]) {
    app.get(url!, async (_req, reply) => reply.type(contentType!).send(await readFile(path.resolve('server/public', file!), 'utf8')));
  }
  const enqueueDownload = async (userId: string, sourceReleaseId: string) => {
    const source = (await db.query('SELECT sr.*,s.config,s.type FROM source_releases sr JOIN sources s ON s.id=sr.source_id WHERE sr.id=$1 AND s.user_id=$2', [sourceReleaseId, userId])).rows[0];
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (source.metadata.format === 'folder') throw new AppError('BUILD_REQUIRED', 409);
    const result = await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const cached=(await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND sha256=$2 AND verified',[source.release_id,source.metadata.sha256])).rows[0];
      if(cached){const file=path.join(config.DATA_DIR,cached.relative_path);const fileStat=await stat(file).catch(()=>null);if(fileStat?.size===cached.size&&await fileHash(file)===cached.sha256)return {cached:true,artifactId:cached.id as string};await sql.query('UPDATE artifacts SET verified=false WHERE id=$1',[cached.id]);if(fileStat)throw new AppError('CACHE_CORRUPT',409);}
      const active=(await sql.query("SELECT id FROM jobs WHERE source_release_id=$1 AND user_id=$2 AND kind='DOWNLOAD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED')",[source.id,userId])).rows[0];
      if(active)return {id:active.id as string,cached:false};
      const used = (await sql.query("SELECT (SELECT COALESCE(sum(size),0) FROM artifacts WHERE deleted_at IS NULL)+(SELECT COALESCE(sum(COALESCE((config->>'reservedBytes')::bigint,total_bytes)),0) FROM jobs WHERE kind IN ('DOWNLOAD','BUILD') AND state NOT IN ('COMPLETED','ERROR','CANCELLED')) AS bytes")).rows[0].bytes;
      if (Number(used) + source.metadata.size > config.QUOTA_BYTES) throw new AppError('QUOTA_EXCEEDED', 409);
      const id = randomUUID();
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,total_bytes,config) VALUES($1,$2,'DOWNLOAD',$3,$4,'QUEUED',$5,$6)", [id, userId, source.release_id, sourceReleaseId, source.metadata.size, { sourceMetadata: source.metadata, sourceConfig: source.config, sourceType: source.type }]);
      await jobEvent(sql, id);
      return {id,cached:false};
    });
    await runner.reconcile(); return result;
  };
  const installations=await installationRoutes(app,db,auth,preparation,transfers,enqueueDownload);
  app.post('/api/v1/downloads', async (req, reply) => {
    const user = await auth.user(req), body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(user.id, body.sourceReleaseId));
  });
  app.post('/api/v1/device/downloads', async (req, reply) => {
    const consoleInfo = await auth.device(req), body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(consoleInfo.user_id, body.sourceReleaseId));
  });
  const listJobs = async (userId: string) => (await db.query('SELECT j.*,g.title FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.user_id=$1 ORDER BY j.created_at DESC LIMIT 100', [userId])).rows.map(jobJSON);
  app.get('/api/v1/jobs', async req => listJobs((await auth.user(req)).id));
  app.get('/api/v1/device/jobs', async req => listJobs((await auth.device(req)).user_id));
  app.get('/api/v1/jobs/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    const job = (await db.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [id, user.id])).rows[0];
    if (!job) throw new AppError('NOT_FOUND', 404); return jobJSON(job);
  });
  app.post('/api/v1/jobs/:id/control', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ action: z.enum(['pause','resume','cancel','retry']) }).parse(req.body);
    await transaction(db, async sql => {
      const job = (await sql.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      if (job.kind !== 'DOWNLOAD' || ['COMPLETED','CANCELLED'].includes(job.state)) throw new AppError('UNSUPPORTED_JOB_CONTROL', 409);
      const desired = body.action === 'pause' ? 'PAUSED' : body.action === 'cancel' ? 'CANCELLED' : 'RUNNING';
      const state = desired === 'RUNNING' ? 'QUEUED' : desired;
      await sql.query('UPDATE jobs SET desired_state=$2,state=$3,attempts=CASE WHEN $4 THEN 0 ELSE attempts END,updated_at=now() WHERE id=$1', [id, desired, state, body.action === 'retry']);
      await jobEvent(sql, id);
    });
    await runner.reconcile(); return { ok: true };
  });
  const events = async (userId: string, after: number) => (await db.query('SELECT id,job_id AS "jobId",state,progress,created_at AS "createdAt" FROM job_events WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT 500', [userId, after])).rows;
  app.get('/api/v1/events', async req => {
    const user = await auth.user(req), after = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after;
    return events(user.id, after);
  });
  app.get('/api/v1/events/live', { websocket: true, preValidation: async req => { await auth.user(req); } }, (socket, req) => {
    let cursor = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after, sending = false;
    const send = async () => {
      if (sending) return; sending = true;
      try {
        const user = await auth.user(req), rows = await events(user.id, cursor);
        if (rows.length) { if (socket.bufferedAmount > 1024 ** 2) { socket.close(1008, 'Client too slow'); return; } socket.send(JSON.stringify({ type: 'events', events: rows })); cursor = rows.at(-1)!.id; }
      } catch { socket.close(1008, 'Session expired'); } finally { sending = false; }
    };
    const timer = setInterval(() => void send(), 500);
    socket.on('close', () => clearInterval(timer)); void send();
  });
  app.addHook('onClose', async () => { await installations.close(); await runner.close(); await db.end(); });
  return app;
}
