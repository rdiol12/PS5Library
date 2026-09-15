import { randomUUID, createHash } from 'node:crypto';
import { mkdir, stat, statfs, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid } from '../../../shared/schemas/index.js';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { existingWithin, within } from '../security/paths.js';
import { sourceHeaders } from '../sources/connectors.js';
import { downloadFile, fileHash } from '../downloads/stream.js';
import { runWorker } from '../library/inspect.js';
import { jobEvent } from './events.js';

const builders = { FPKG: '748eabf1b7d17819528cabf367d8e27109d8fce3', SHADOWMOUNT: 'b5307a60d5b4e3a68ba680e0e33cfadf05017c77' };
export const buildKey = (sha: string, method: keyof typeof builders) => createHash('sha256').update(`pipeline-v1:${method}:${builders[method]}:${sha}`).digest('hex');

export async function publishArtifact(db: DB, config: Config, row: any, result: any) {
  const relativePath = path.join('artifacts', row.release_id, `${result.sha256}.${result.format}`);
  const target = path.join(config.DATA_DIR, relativePath);
  return transaction(db, async sql => {
    // ponytail: one short publish/delete/quota lock; partition by volume if throughput requires it.
    await sql.query('SELECT pg_advisory_xact_lock(3150003)');
    const control = (await sql.query('SELECT desired_state FROM jobs WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (control.desired_state !== 'RUNNING') throw new AppError(control.desired_state);
    await mkdir(path.dirname(target), { recursive: true });
    const current = await stat(target).catch(() => null);
    if (current && (current.size !== result.size || await fileHash(target) !== result.sha256)) throw new AppError('CACHE_CORRUPT', 409);
    if (!current) await rename(result.outputPath, target);
    const artifact = (await sql.query(`INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash,builder_version,cache_key)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10) ON CONFLICT(relative_path) DO UPDATE SET verified=true,deleted_at=NULL,inspection=$7,input_hash=$8,builder_version=$9,cache_key=$10 RETURNING id`,
    [randomUUID(), row.release_id, result.format, relativePath, result.sha256, result.size, result.inspection, result.inputHash ?? result.sha256, result.builderVersion ?? null, row.config.cacheKey ?? null])).rows[0];
    if (result.inspection.metadataVerified && result.inspection.identity) {
      const identity = result.inspection.identity;
      const data = { titleId: identity.titleId, title: identity.title };
      await sql.query("INSERT INTO metadata_records(id,game_id,provider,rank,data) SELECT $1,game_id,$2,1,$3 FROM game_releases WHERE id=$4 ON CONFLICT(game_id,provider) DO UPDATE SET data=$3", [randomUUID(), `inspection:${row.release_id}`, data, row.release_id]);
      await sql.query("UPDATE games SET title=$2,metadata=metadata || $3::jsonb WHERE id=(SELECT game_id FROM game_releases WHERE id=$1)", [row.release_id, identity.title, data]);
    }
    await sql.query("UPDATE jobs SET state='COMPLETED',artifact_id=$2,downloaded_bytes=total_bytes,speed_bytes_per_second=0,eta_seconds=0,updated_at=now() WHERE id=$1", [row.id, artifact.id]);
    await sql.query("INSERT INTO library_entries(user_id,release_id,artifact_id,state) VALUES($1,$2,$3,'READY_ON_SERVER') ON CONFLICT(user_id,release_id) DO UPDATE SET artifact_id=$3,state='READY_ON_SERVER'", [row.user_id, row.release_id, artifact.id]);
    await jobEvent(sql, row.id); return artifact.id as string;
  });
}

export async function prepare(db: DB, config: Config, row: any) {
  const source = row.config.sourceMetadata, local = row.config.sourceType === 'LOCAL_FOLDER';
  const root = path.join(config.DATA_DIR, 'jobs', row.id); await mkdir(root, { recursive: true });
  const setStage = async (state: string, progress?: object) => {
    const current = (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [row.id])).rows[0];
    if (current.desired_state !== 'RUNNING') throw new AppError(current.desired_state);
    await db.query('UPDATE jobs SET state=$2,config=jsonb_set(config,\'{progress}\',$3),speed_bytes_per_second=0,updated_at=now() WHERE id=$1', [row.id, state, JSON.stringify(progress ?? { stage: state, completedStages: 0, totalStages: 7 })]); await jobEvent(db, row.id);
  };
  await db.query("UPDATE jobs SET attempts=attempts+1,error=NULL WHERE id=$1", [row.id]);
  const location = local ? await existingWithin(path.join(config.SOURCE_ROOT, row.user_id), source.location) : source.location;
  const identity = { titleId: row.title_id, contentId: row.content_id, version: row.version };
  let folder = location;
  if (source.format !== 'folder') {
    const part = path.join(root, 'content.part'); await setStage('DOWNLOADING');
    await downloadFile({ location, local, partPath: part, size: source.size, sha256: source.sha256, privateOrigins: config.privateOrigins, headers: sourceHeaders(row.config.sourceConfig, local ? undefined : location), margin: config.DISK_MARGIN_BYTES,
      progress: async p => { await setStage('DOWNLOADING'); await db.query('UPDATE jobs SET downloaded_bytes=$2,speed_bytes_per_second=$3,eta_seconds=$4 WHERE id=$1', [row.id, p.downloadedBytes, p.speedBytesPerSecond, p.etaSeconds]); await jobEvent(db, row.id); } });
    await setStage('EXTRACTING');
    folder = path.join(root, `extracted-${randomUUID()}`);
    const limit = Math.min(config.QUOTA_BYTES, source.installedSize ?? source.size * 8);
    const space = await statfs(root); if (space.bavail * space.bsize < limit + config.DISK_MARGIN_BYTES) throw new AppError('INSUFFICIENT_SPACE', 409);
    await runWorker(['extract-zip', part, folder, String(limit)]);
    await runWorker(['inspect', folder, JSON.stringify(identity)]);
  }
  const result = await runWorker([source.format === 'folder' ? 'build-verified' : 'build', folder, path.join(root, 'output'), row.config.method, JSON.stringify(identity), row.release_id, ...(source.format === 'folder' ? [source.sha256,String(source.size)] : [])], p => setStage('BUILDING', p));
  await publishArtifact(db, config, row, result);
  await rm(within(config.DATA_DIR, root), { recursive: true, force: true });
}

export async function preparationRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth, reconcile: () => Promise<void>) {
  const bodySchema = z.object({ sourceReleaseId: uuid, method: z.enum(['FPKG','SHADOWMOUNT']) });
  const enqueue = async (userId: string, body: z.infer<typeof bodySchema>) => {
    const source = (await db.query('SELECT sr.*,s.config,s.type FROM source_releases sr JOIN sources s ON s.id=sr.source_id WHERE sr.id=$1 AND s.user_id=$2', [body.sourceReleaseId, userId])).rows[0];
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (!['folder','zip'].includes(source.metadata.format) || source.metadata.format === 'folder' && source.type !== 'LOCAL_FOLDER') throw new AppError('UNSUPPORTED_INPUT', 422, 'Preparation currently accepts local prepared folders and ZIPs with the game files at their root.');
    const key = buildKey(source.metadata.sha256, body.method);
    const result = await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const cached = (await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified ORDER BY created_at DESC LIMIT 1', [source.release_id, key])).rows[0];
      if (cached) {
        const file = path.join(config.DATA_DIR, cached.relative_path);
        const fileStat = await stat(file).catch(() => null);
        if (fileStat?.size === cached.size && await fileHash(file) === cached.sha256) return { cached: true, artifactId: cached.id };
        await sql.query('UPDATE artifacts SET verified=false WHERE id=$1', [cached.id]);
        if (fileStat) throw new AppError('CACHE_CORRUPT', 409, 'Delete the changed cached file before preparing again.');
      }
      const active = (await sql.query("SELECT id FROM jobs WHERE user_id=$1 AND source_release_id=$2 AND kind='BUILD' AND config->>'method'=$3 AND state NOT IN ('COMPLETED','ERROR','CANCELLED')", [userId, source.id, body.method])).rows[0];
      if (active) return { id: active.id, cached: false };
      const reserve = (source.metadata.installedSize ?? source.metadata.size) * 4 + 64 * 1024 ** 2;
      const used = (await sql.query("SELECT (SELECT COALESCE(sum(size),0) FROM artifacts WHERE deleted_at IS NULL)+(SELECT COALESCE(sum(COALESCE((config->>'reservedBytes')::bigint,total_bytes)),0) FROM jobs WHERE kind IN ('DOWNLOAD','BUILD') AND state NOT IN ('COMPLETED','ERROR','CANCELLED')) AS bytes")).rows[0].bytes;
      if (Number(used) + reserve > config.QUOTA_BYTES) throw new AppError('QUOTA_EXCEEDED', 409);
      const id = randomUUID();
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,total_bytes,config) VALUES($1,$2,'BUILD',$3,$4,'QUEUED',$5,$6)", [id, userId, source.release_id, source.id, source.metadata.size, { sourceMetadata: source.metadata, sourceConfig: source.config, sourceType: source.type, method: body.method, cacheKey: key, reservedBytes: reserve }]);
      await jobEvent(sql, id); return { id, cached: false };
    });
    await reconcile(); return result;
  };
  app.post('/api/v1/preparations', async (req, reply) => reply.code(202).send(await enqueue((await auth.user(req)).id, bodySchema.parse(req.body))));
  app.post('/api/v1/device/preparations', async (req, reply) => reply.code(202).send(await enqueue((await auth.device(req)).user_id, bodySchema.parse(req.body))));
  app.get('/api/v1/artifacts', async req => (await db.query('SELECT a.id,a.format,a.size,a.sha256,a.verified,a.builder_version AS "builderVersion",a.created_at AS "createdAt",a.release_id AS "releaseId",g.title,r.version FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE g.user_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at DESC', [(await auth.user(req)).id])).rows);
  app.delete('/api/v1/artifacts/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    return transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const artifact = (await sql.query('SELECT a.* FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE a.id=$1 AND g.user_id=$2 AND a.deleted_at IS NULL FOR UPDATE OF a', [id, user.id])).rows[0];
      if (!artifact) throw new AppError('NOT_FOUND', 404);
      if ((await sql.query("SELECT id FROM jobs WHERE artifact_id=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')", [id])).rowCount) throw new AppError('ARTIFACT_IN_USE', 409);
      await rm(within(config.DATA_DIR, path.join(config.DATA_DIR, artifact.relative_path)), { force: true });
      await sql.query('UPDATE artifacts SET verified=false,deleted_at=now() WHERE id=$1', [id]);
      await sql.query('DELETE FROM library_entries WHERE artifact_id=$1', [id]);
      return { ok: true, freedBytes: artifact.size };
    });
  });
  return { enqueue };
}
