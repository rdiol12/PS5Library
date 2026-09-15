import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { uuid, progressSchema } from '../../../shared/schemas/index.js';
import { compatibility, planStorage, presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { jobEvent, jobJSON } from '../jobs/events.js';

export async function transferRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  async function plan(userId: string, releaseId: string, consoleId: string, artifactId?: string, preparation?: {format:string;size:number;sha256:string;cacheKey?:string}) {
    const c = (await db.query("SELECT c.*,COALESCE(k.capabilities,'{}') AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2", [consoleId, userId])).rows[0];
    const r = (await db.query('SELECT r.*,g.title_id FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.id=$1 AND g.user_id=$2', [releaseId, userId])).rows[0];
    if (!c || !r) throw new AppError('NOT_FOUND', 404);
    const a = (await db.query('SELECT * FROM artifacts WHERE release_id=$1 AND verified AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR format=$3) AND ($4::text IS NULL OR cache_key=$4) AND ($5::text IS NULL OR sha256=$5) ORDER BY created_at DESC LIMIT 1', [releaseId, artifactId ?? null, preparation?.format??null, preparation?.cacheKey??null, preparation&&!preparation.cacheKey?preparation.sha256:null])).rows[0];
    const profiles = (await db.query('SELECT profile FROM compatibility_profiles WHERE user_id=$1 AND title_id=$2', [userId, r.title_id])).rows.map(p => p.profile);
    const result = compatibility({ titleId: r.title_id, contentId: r.content_id, version: r.version, sha256: preparation?.sha256 ?? a?.input_hash ?? a?.sha256 ?? r.metadata.sha256, minimumFirmware: r.metadata.minimumFirmware ?? null, format: a?.format ?? preparation?.format ?? r.metadata.format }, { firmware: c.firmware, runtime: c.runtime, capabilities: c.capabilities, shadowMountFakelib: c.shadowmount_fakelib, standaloneBackPork: c.standalone_backpork }, profiles);
    const backport = result.profileId ? (await db.query('SELECT b.* FROM backport_artifacts b JOIN artifacts a ON a.id=b.artifact_id WHERE b.profile_id=$1 AND b.release_id=$2 AND b.tested AND a.verified', [result.profileId, releaseId])).rows[0] : null;
    const online = presence(c.last_seen ? new Date(c.last_seen).getTime() : null) === 'ONLINE';
    const storage = (await db.query('SELECT * FROM console_storage WHERE console_id=$1 ORDER BY display_name', [consoleId])).rows.map(s => ({ storageId: s.storage_id, displayName: s.display_name,
      ...planStorage({ freeBytes: s.free_bytes, writable: s.writable, installMethodsSupported: s.methods }, result.method ?? '', { game: a?.size ?? preparation?.size ?? r.metadata.size ?? 0, update: 0, backport: backport?.size ?? 0, temporary: a?.size ?? preparation?.size ?? r.metadata.size ?? 0, margin: config.DISK_MARGIN_BYTES }) }));
    return { compatibility: result, online, artifactId: a?.id ?? null, backportArtifactId: backport?.artifact_id ?? null, storage,
      allowed: !!a && online && result.status === 'NATIVE_COMPATIBLE',
      reason: !a ? 'PREPARE_ON_SERVER_FIRST' : !online ? 'CONSOLE_OFFLINE' : result.status === 'MATCHING_BACKPORT_AVAILABLE' ? 'BACKPORT_PLACEMENT_NOT_ENABLED' : result.status };
  }
  app.post('/api/v1/transfers/plan', async req => {
    const u = await auth.user(req), b = z.object({ releaseId: uuid, consoleId: uuid }).parse(req.body);
    return plan(u.id, b.releaseId, b.consoleId);
  });
  app.post('/api/v1/device/transfers/plan', async req => {
    const c = await auth.device(req), b = z.object({ releaseId: uuid, consoleId: uuid.optional() }).parse(req.body);
    return plan(c.user_id, b.releaseId, b.consoleId ?? c.id);
  });
  const enqueue = async (userId: string, body: { artifactId: string; consoleId: string; storageId: string; installationId?:string }) => {
    if(body.installationId){const old=(await db.query("SELECT id FROM jobs WHERE user_id=$1 AND config->>'installationId'=$2 AND kind='TRANSFER'",[userId,body.installationId])).rows[0];if(old)return {id:old.id as string};}
    const artifact = (await db.query('SELECT a.* FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE a.id=$1 AND g.user_id=$2 AND a.verified', [body.artifactId, userId])).rows[0];
    if (!artifact) throw new AppError('NOT_FOUND', 404);
    const selected = await plan(userId, artifact.release_id, body.consoleId, artifact.id);
    if (!selected.allowed) throw new AppError(selected.reason, 409);
    const destination = selected.storage.find(s => s.storageId === body.storageId);
    if (!destination?.allowed) throw new AppError('INSUFFICIENT_OR_UNSUPPORTED_STORAGE', 409);
    const id = randomUUID();
    await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      if (!(await sql.query('SELECT id FROM artifacts WHERE id=$1 AND verified', [artifact.id])).rowCount) throw new AppError('ARTIFACT_MISSING_OR_CHANGED', 409);
      await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE', [body.consoleId, userId]);
      const reserved = (await sql.query("SELECT COALESCE(sum((config->>'reservedBytes')::bigint),0)::bigint AS bytes FROM jobs WHERE kind='TRANSFER' AND console_id=$1 AND storage_id=$2 AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')", [body.consoleId, body.storageId])).rows[0].bytes;
      if (destination.freeBytes < reserved + destination.requiredBytes) throw new AppError('INSUFFICIENT_SPACE', 409);
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,config) VALUES($1,$2,'TRANSFER',$3,$4,$5,$6,'QUEUED_FOR_PS5',$7,$8)", [id, userId, artifact.release_id, artifact.id, body.consoleId, body.storageId, artifact.size, { method: selected.compatibility.method, reservedBytes: destination.requiredBytes, installationId:body.installationId }]);
      await sql.query("INSERT INTO console_library_entries(console_id,release_id,storage_id,state) VALUES($1,$2,$3,'QUEUED_FOR_PS5') ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET state='QUEUED_FOR_PS5',updated_at=now()", [body.consoleId, artifact.release_id, body.storageId]);
      await jobEvent(sql, id);
    });
    return { id };
  };
  app.post('/api/v1/transfers', async (req, reply) => {
    const user = await auth.user(req), body = z.object({ artifactId: uuid, consoleId: uuid, storageId: z.string().max(64) }).parse(req.body);
    return reply.code(202).send(await enqueue(user.id, body));
  });
  app.post('/api/v1/device/transfers', async (req, reply) => {
    const c = await auth.device(req), body = z.object({ artifactId: uuid, storageId: z.string().max(64), consoleId: uuid.optional() }).parse(req.body);
    return reply.code(202).send(await enqueue(c.user_id, { ...body, consoleId: body.consoleId ?? c.id }));
  });
  app.get('/api/v1/device/tasks', async req => {
    const c = await auth.device(req);
    return (await db.query("SELECT j.*,a.sha256,a.format,g.title,g.title_id,r.content_id,r.version FROM jobs j JOIN artifacts a ON a.id=j.artifact_id JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.console_id=$1 AND j.kind='TRANSFER' AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') ORDER BY j.created_at", [c.id])).rows.map(j => ({ ...jobJSON(j), sha256: j.sha256, format: j.format, method: j.config.method, title: j.title, titleId: j.title_id, contentId: j.content_id, version: j.version, artifactUrl: `/api/v1/device/artifacts/${j.artifact_id}` }));
  });
  app.post('/api/v1/device/tasks/:id/progress', async req => {
    const c = await auth.device(req), id = uuid.parse((req.params as { id: string }).id), body = progressSchema.parse(req.body);
    return transaction(db, async sql => {
      const job = (await sql.query('SELECT j.*,a.sha256 FROM jobs j JOIN artifacts a ON a.id=j.artifact_id WHERE j.id=$1 AND j.console_id=$2 FOR UPDATE OF j', [id, c.id])).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      const transitions: Record<string, string[]> = { QUEUED_FOR_PS5: ['TRANSFERRING','ERROR'], TRANSFERRING: ['TRANSFERRING','VERIFYING','ERROR'], VERIFYING: ['TRANSFERRING','VERIFYING','REGISTERING','READY_ON_PS5','ERROR'], REGISTERING: ['REGISTERING','READY_ON_PS5','ERROR'], READY_ON_PS5: ['READY_ON_PS5'] };
      if (!transitions[job.state]?.includes(body.state) || body.downloadedBytes > job.total_bytes || job.desired_state !== 'RUNNING') throw new AppError('INVALID_JOB_TRANSITION', 409);
      if (['VERIFYING','REGISTERING','READY_ON_PS5'].includes(body.state) && (body.downloadedBytes !== job.total_bytes || body.sha256 !== job.sha256)) throw new AppError('VERIFICATION_REQUIRED', 409);
      if (body.state === 'READY_ON_PS5') {
        const inventory = (await sql.query("SELECT * FROM console_library_entries WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='READY_ON_PS5' AND sha256=$4 AND size=$5", [c.id, job.release_id, job.storage_id, job.sha256, job.total_bytes])).rows[0];
        if (!inventory || (job.config.method !== 'HOMEBREW' && !inventory.registered)) throw new AppError('INVENTORY_CONFIRMATION_REQUIRED', 409);
      }
      const eta = body.speedBytesPerSecond ? Math.ceil((job.total_bytes - body.downloadedBytes) / body.speedBytesPerSecond) : null;
      await sql.query('UPDATE jobs SET state=$2,downloaded_bytes=$3,speed_bytes_per_second=$4,eta_seconds=$5,error=$6,updated_at=now() WHERE id=$1', [id, body.state, body.downloadedBytes, body.speedBytesPerSecond, eta, body.error ?? null]);
      if (body.state !== 'READY_ON_PS5') await sql.query('UPDATE console_library_entries SET state=$4,updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3', [c.id, job.release_id, job.storage_id, body.state]);
      await jobEvent(sql, id); return { ok: true };
    });
  });
  app.get('/api/v1/device/artifacts/:id', async (req, reply) => {
    const c = await auth.device(req), id = uuid.parse((req.params as { id: string }).id);
    const a = (await db.query('SELECT a.* FROM artifacts a WHERE a.id=$1 AND a.verified AND EXISTS(SELECT 1 FROM jobs j WHERE j.artifact_id=a.id AND j.console_id=$2 AND j.kind=\'TRANSFER\' AND j.desired_state=\'RUNNING\')', [id, c.id])).rows[0];
    if (!a) throw new AppError('NOT_FOUND', 404);
    const file = path.join(config.DATA_DIR, a.relative_path);
    if ((await stat(file)).size !== a.size) throw new AppError('ARTIFACT_MISSING_OR_CHANGED', 409);
    let start = 0, end = a.size - 1;
    reply.header('accept-ranges', 'bytes').header('etag', `"${a.sha256}"`).header('cache-control','private, no-store');
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) >= a.size || (range[2] && (Number(range[2]) >= a.size || Number(range[2]) < Number(range[1])))) return reply.code(416).header('content-range', `bytes */${a.size}`).send({ error: 'INVALID_RANGE' });
      if (!req.headers['if-range'] || req.headers['if-range'] === `"${a.sha256}"`) {
        start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
        reply.code(206).header('content-range', `bytes ${start}-${end}/${a.size}`);
      }
    }
    return reply.type('application/octet-stream').header('content-length', end - start + 1).send(createReadStream(file, { start, end }));
  });
  return { plan, enqueue };
}
