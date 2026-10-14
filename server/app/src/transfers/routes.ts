import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { serveFile, serveStoredFile } from '../downloads/serve.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { queryOne, transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { bytes, sha256, uuid, progressSchema } from '../../../shared/schemas/index.js';
import { AppError } from '../security/errors.js';
import { jobEvent, jobJSON } from '../jobs/events.js';
import { existingWithin, regularFileWithin } from '../security/paths.js';
import { nativeDownloadRoutes } from './native.js';
import { inspect } from '../library/inspect.js';
import { createTransferPlanner } from './planning.js';

const installedImageSchema = z
  .object({ size: bytes.refine((value) => value > 0), sha256 })
  .strict();
const installedImage = (inspection: unknown, sourceSize: number) => {
  const parsed = installedImageSchema.safeParse((inspection as any)?.installedImage);
  return parsed.success && parsed.data.size <= sourceSize ? parsed.data : null;
};
const taskTransitions: Record<string, string[]> = {
  QUEUED_FOR_PS5: ['TRANSFERRING', 'ERROR', 'CANCELLED'],
  TRANSFERRING: ['TRANSFERRING', 'VERIFYING', 'ERROR', 'CANCELLED'],
  VERIFYING: ['TRANSFERRING', 'VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'ERROR', 'CANCELLED'],
  REGISTERING: ['REGISTERING', 'READY_ON_PS5', 'ERROR', 'CANCELLED'],
  READY_ON_PS5: ['READY_ON_PS5'],
};

function registerDeviceTaskRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  app.get('/api/v1/device/tasks', async (req) => {
    const c = await auth.device(req);
    const jobs = (
      await db.query(
        `SELECT j.*, a.sha256, a.format, a.inspection, g.title, g.title_id,
                r.content_id, r.version, r.kind AS release_kind
           FROM jobs j
           JOIN artifacts a ON a.id=j.artifact_id
           JOIN game_releases r ON r.id=j.release_id
           JOIN games g ON g.id=r.game_id
          WHERE j.console_id=$1 AND j.kind='TRANSFER'
            AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')
          ORDER BY j.created_at`,
        [c.id],
      )
    ).rows;
    const tasks = [];
    for (const j of jobs) {
      let error =
        j.config.firmware !== undefined &&
        (j.config.firmware !== c.firmware || j.config.runtime !== c.runtime)
          ? 'CONSOLE_CONFIGURATION_CHANGED'
          : null;
      const image = error
        ? null
        : j.config.method === 'FPKG'
          ? installedImage(j.inspection, j.total_bytes)
          : null;
      if (!error && j.config.method === 'FPKG' && !image) error = 'ARTIFACT_INSPECTION_REQUIRED';
      if (error) {
        await db.query("UPDATE jobs SET state='ERROR',error=$2,updated_at=now() WHERE id=$1", [
          j.id,
          error,
        ]);
        await db.query(
          "UPDATE console_library_entries SET state='ERROR',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3",
          [c.id, j.release_id, j.storage_id],
        );
        await jobEvent(db, j.id);
        continue;
      }
      const profile = j.config.backport;
      tasks.push({
        ...jobJSON(j),
        sha256: j.sha256,
        format: j.format,
        method: j.config.method,
        title: j.title,
        titleId: j.title_id,
        contentId: j.content_id,
        version: j.version,
        releaseKind: j.release_kind,
        baseContentVersion: j.config.baseContentVersion ?? null,
        backport: profile?.placement === 'SCAN_PATH' ? profile : null,
        backportProfileId: profile?.profile?.id ?? null,
        backportProfileHash: profile?.profileHash ?? null,
        installedImage: image,
        artifactUrl: `/api/v1/device/artifacts/${j.artifact_id}`,
      });
    }
    return tasks;
  });
  app.get('/api/v1/device/tasks/:id/backport/:index', async (req, reply) => {
    const c = await auth.device(req),
      params = z
        .object({ id: uuid, index: z.coerce.number().int().min(0).max(200) })
        .parse(req.params);
    const job = await queryOne(
      db,
      `SELECT j.config
           FROM jobs j
           JOIN game_releases r ON r.id=j.release_id
          WHERE j.id=$1 AND j.console_id=$2 AND j.kind='TRANSFER'
            AND j.desired_state='RUNNING'
            AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')
            AND EXISTS(
              SELECT 1 FROM game_content_access access
               WHERE access.game_id=r.game_id AND access.user_id=$3
            )`,
      [params.id, c.id, c.user_id],
    );
    const plan = job?.config.backport,
      file = plan?.files[params.index];
    if (!file || plan.placement !== 'SCAN_PATH') throw new AppError('NOT_FOUND', 404);
    const b = await queryOne(
      db,
      'SELECT relative_path FROM backport_artifacts WHERE id=$1 AND deleted_at IS NULL',
      [plan.backportId],
    );
    if (!b) throw new AppError('BACKPORT_FILES_MISSING', 409);
    const location = path.join(config.DATA_DIR, b.relative_path, file.path),
      checked = await regularFileWithin(config.DATA_DIR, location, 'r');
    if (checked.info.size !== file.size) {
      await checked.handle.close();
      throw new AppError('BACKPORT_FILES_MISMATCH', 409);
    }
    return serveFile(
      req,
      reply,
      location,
      file.size,
      file.sha256,
      'application/octet-stream',
      undefined,
      checked.handle,
    );
  });
  app.post('/api/v1/device/tasks/:id/progress', (req) => updateProgress(req, db, auth));
  app.get('/api/v1/device/artifacts/:id', async (req, reply) => {
    const c = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id);
    const a = await queryOne(
      db,
      `SELECT a.*
           FROM artifacts a
           JOIN game_releases r ON r.id=a.release_id
          WHERE a.id=$1 AND a.verified
            AND EXISTS(
              SELECT 1 FROM jobs j
               WHERE j.artifact_id=a.id AND j.console_id=$2
                 AND j.kind='TRANSFER' AND j.desired_state='RUNNING'
            )
            AND EXISTS(
              SELECT 1 FROM game_content_access access
               WHERE access.game_id=r.game_id AND access.user_id=$3
            )`,
      [id, c.id, c.user_id],
    );
    if (!a) throw new AppError('NOT_FOUND', 404);
    const file = await existingWithin(config.DATA_DIR, path.join(config.DATA_DIR, a.relative_path));
    return serveStoredFile(
      req,
      reply,
      file,
      Number(a.size),
      a.sha256,
      'application/octet-stream',
      config.DATA_DIR,
    );
  });
}

async function updateProgress(req: FastifyRequest, db: DB, auth: Auth) {
  const c = await auth.device(req),
    id = uuid.parse((req.params as { id: string }).id),
    body = progressSchema.parse(req.body);
  return transaction(db, async (sql) => {
    const job = await queryOne(
      sql,
      'SELECT j.*,a.sha256,a.inspection FROM jobs j JOIN artifacts a ON a.id=j.artifact_id WHERE j.id=$1 AND j.console_id=$2 FOR UPDATE OF j',
      [id, c.id],
    );
    if (!job) throw new AppError('NOT_FOUND', 404);
    if (
      job.config.firmware !== undefined &&
      (job.config.firmware !== c.firmware || job.config.runtime !== c.runtime)
    )
      throw new AppError('CONSOLE_CONFIGURATION_CHANGED', 409);
    if (body.backportDownloadedBytes !== undefined) {
      if (!job.config.backport || body.backportDownloadedBytes > job.config.backport.size)
        throw new AppError('INVALID_JOB_TRANSITION', 409);
      await sql.query("UPDATE jobs SET config=jsonb_set(config,'{progress}',$2) WHERE id=$1", [
        id,
        JSON.stringify({
          stage: 'Preparing compatibility files',
          completedBytes: body.backportDownloadedBytes,
          totalBytes: job.config.backport.size,
        }),
      ]);
    } else if (['VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'ERROR'].includes(body.state))
      await sql.query("UPDATE jobs SET config=config-'progress' WHERE id=$1", [id]);
    if (
      !taskTransitions[job.state]?.includes(body.state) ||
      body.downloadedBytes > job.total_bytes ||
      job.desired_state !== 'RUNNING'
    )
      throw new AppError('INVALID_JOB_TRANSITION', 409);
    if (body.state === 'CANCELLED') {
      await sql.query(
        `UPDATE jobs
            SET state='CANCELLED',
                desired_state='CANCELLED',
                downloaded_bytes=GREATEST(downloaded_bytes,$2),
                speed_bytes_per_second=0,
                eta_seconds=NULL,
                error=NULL,
                dismissed_at=now(),
                updated_at=now()
          WHERE id=$1`,
        [id, body.downloadedBytes],
      );
      await sql.query(
        "DELETE FROM console_library_entries WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='QUEUED_FOR_PS5'",
        [c.id, job.release_id, job.storage_id],
      );
      await sql.query(
        "UPDATE console_library_entries SET state='MISSING',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state NOT IN ('READY_ON_PS5','MISSING')",
        [c.id, job.release_id, job.storage_id],
      );
      await sql.query('DELETE FROM native_download_grants WHERE job_id=$1', [id]);
      await sql.query('DELETE FROM job_events WHERE job_id=$1', [id]);
      return { ok: true };
    }
    if (
      ['VERIFYING', 'REGISTERING', 'READY_ON_PS5'].includes(body.state) &&
      (body.downloadedBytes !== job.total_bytes || body.sha256 !== job.sha256)
    )
      throw new AppError('VERIFICATION_REQUIRED', 409);
    if (
      ['REGISTERING', 'READY_ON_PS5'].includes(body.state) &&
      job.config.backport &&
      body.backportProfileHash !== job.config.backport.profileHash
    )
      throw new AppError('BACKPORT_VERIFICATION_REQUIRED', 409);
    if (body.state === 'READY_ON_PS5') {
      const image =
        job.config.method === 'FPKG'
          ? installedImage(job.inspection, job.total_bytes)
          : { size: job.total_bytes, sha256: job.sha256 };
      if (!image) throw new AppError('ARTIFACT_INSPECTION_REQUIRED', 409);
      const inventory = await queryOne(
        sql,
        "SELECT * FROM console_library_entries WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='READY_ON_PS5' AND sha256=$4 AND size=$5",
        [c.id, job.release_id, job.storage_id, image.sha256, image.size],
      );
      if (!inventory || (job.config.method !== 'HOMEBREW' && !inventory.registered))
        throw new AppError('INVENTORY_CONFIRMATION_REQUIRED', 409);
      if (
        job.config.backport &&
        (inventory.backport_profile_id !== job.config.backport.profile.id ||
          inventory.backport_files !== (job.config.backport.placement === 'SCAN_PATH'))
      )
        throw new AppError('BACKPORT_VERIFICATION_REQUIRED', 409);
    }
    const transferring = body.state === 'TRANSFERRING',
      downloaded = transferring
        ? Math.max(job.downloaded_bytes, body.downloadedBytes)
        : body.downloadedBytes;
    const speed = body.speedBytesPerSecond ?? (transferring ? job.speed_bytes_per_second : 0),
      eta = speed ? Math.ceil((job.total_bytes - downloaded) / speed) : null;
    await sql.query(
      'UPDATE jobs SET state=$2,downloaded_bytes=$3,speed_bytes_per_second=$4,eta_seconds=$5,error=$6,updated_at=now() WHERE id=$1',
      [id, body.state, downloaded, speed, eta, body.error ?? null],
    );
    if (body.state !== 'READY_ON_PS5')
      await sql.query(
        'UPDATE console_library_entries SET state=$4,updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3',
        [c.id, job.release_id, job.storage_id, body.state],
      );
    await jobEvent(sql, id);
    return { ok: true };
  });
}

export async function transferRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  inspectFile = inspect,
) {
  const native = await nativeDownloadRoutes(app, db, config, auth);
  const plan = createTransferPlanner(db, config);
  const artifactInspections = new Map<string, Promise<Awaited<ReturnType<typeof inspect>>>>();
  app.post('/api/v1/transfers/plan', async (req) => {
    const u = await auth.user(req),
      b = z.object({ releaseId: uuid, consoleId: uuid }).parse(req.body);
    return plan(u.id, b.releaseId, b.consoleId);
  });
  app.post('/api/v1/device/transfers/plan', async (req) => {
    const c = await auth.device(req),
      b = z.object({ releaseId: uuid, consoleId: uuid.optional() }).parse(req.body);
    return plan(c.user_id, b.releaseId, b.consoleId ?? c.id);
  });
  const enqueue = async (
    userId: string,
    body: { artifactId: string; consoleId: string; storageId: string; installationId?: string },
  ) => {
    if (body.installationId) {
      const old = await queryOne(
        db,
        "SELECT id FROM jobs WHERE user_id=$1 AND config->>'installationId'=$2 AND kind='TRANSFER'",
        [userId, body.installationId],
      );
      if (old) return { id: old.id as string };
    }
    const artifact = await queryOne(
      db,
      `SELECT a.*, g.title_id, r.content_id, r.version, r.kind, r.metadata
           FROM artifacts a
           JOIN game_releases r ON r.id=a.release_id
           JOIN games g ON g.id=r.game_id
          WHERE a.id=$1 AND a.verified
            AND EXISTS(
              SELECT 1 FROM game_content_access access
               WHERE access.game_id=g.id AND access.user_id=$2
            )`,
      [body.artifactId, userId],
    );
    if (!artifact) throw new AppError('NOT_FOUND', 404);
    const selected = await plan(userId, artifact.release_id, body.consoleId, artifact.id);
    if (!selected.allowed) throw new AppError(selected.reason, 409);
    if (
      selected.compatibility.method === 'FPKG' &&
      !installedImage(artifact.inspection, artifact.size)
    ) {
      let pending = artifactInspections.get(artifact.id);
      if (!pending) {
        pending = (async () => {
          const file = await existingWithin(
              config.DATA_DIR,
              path.join(config.DATA_DIR, artifact.relative_path),
            ),
            before = await stat(file);
          if (!before.isFile() || before.size !== Number(artifact.size))
            throw new AppError('ARTIFACT_MISSING_OR_CHANGED', 409);
          const inspection = await inspectFile(file, 'pkg', {
              titleId: artifact.title_id,
              contentId: artifact.content_id,
              version: artifact.version,
            }),
            after = await stat(file);
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            !installedImage(inspection, artifact.size)
          )
            throw new AppError('ARTIFACT_INSPECTION_REQUIRED', 409);
          await db.query(
            "UPDATE artifacts SET inspection=$2 WHERE id=$1 AND verified AND sha256=$3 AND size=$4 AND NOT inspection?'installedImage'",
            [artifact.id, inspection, artifact.sha256, artifact.size],
          );
          return inspection;
        })().finally(() => artifactInspections.delete(artifact.id));
        artifactInspections.set(artifact.id, pending);
      }
      artifact.inspection = await pending;
    }
    const destination = selected.storage.find((s) => s.storageId === body.storageId);
    if (!destination?.allowed) throw new AppError('INSUFFICIENT_OR_UNSUPPORTED_STORAGE', 409);
    const id = randomUUID();
    await transaction(db, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      if (
        !(await sql.query('SELECT id FROM artifacts WHERE id=$1 AND verified', [artifact.id]))
          .rowCount
      )
        throw new AppError('ARTIFACT_MISSING_OR_CHANGED', 409);
      await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        body.consoleId,
        userId,
      ]);
      if (
        artifact.kind === 'UPDATE' &&
        !(
          await sql.query(
            `SELECT 1
               FROM console_library_entries e
               JOIN game_releases installed ON installed.id=e.release_id
               JOIN games game ON game.id=installed.game_id
              WHERE e.console_id=$1 AND e.storage_id=$2
                AND e.state='READY_ON_PS5' AND e.registered
                AND game.title_id=$3 AND installed.content_id=$4
                AND installed.version=$5`,
            [
              body.consoleId,
              body.storageId,
              artifact.title_id,
              artifact.content_id,
              selected.baseContentVersion,
            ],
          )
        ).rowCount
      )
        throw new AppError('UPDATE_BASE_CHANGED', 409);
      if (
        (
          await sql.query(
            "SELECT id FROM jobs WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND kind='TRANSFER' AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",
            [body.consoleId, artifact.release_id, body.storageId],
          )
        ).rowCount
      )
        throw new AppError(
          'TRANSFER_ALREADY_QUEUED',
          409,
          'Wait for this title transfer to finish or cancel it before starting another installation method.',
        );
      if (
        (
          await sql.query(
            `SELECT j.id
               FROM jobs j
               JOIN game_releases r ON r.id=j.release_id
               JOIN games g ON g.id=r.game_id
              WHERE j.console_id=$1 AND j.kind='DELETE'
                AND j.state NOT IN ('COMPLETED','ERROR','CANCELLED')
                AND g.title_id=(
                  SELECT g2.title_id
                    FROM game_releases r2
                    JOIN games g2 ON g2.id=r2.game_id
                   WHERE r2.id=$2
                )`,
            [body.consoleId, artifact.release_id],
          )
        ).rowCount
      )
        throw new AppError('GAME_IN_USE', 409, 'Wait for this game removal to finish.');
      const reservedAt = async (storageId: string) =>
        (
          await queryOne(
            sql,
            `SELECT COALESCE(sum(
                      CASE WHEN storage_id=$2
                        THEN COALESCE((config->>'reservedBytes')::bigint,0)
                        ELSE 0
                      END
                      + CASE WHEN config->>'stagingStorageId'=$2
                        THEN COALESCE((config->>'stagingReservedBytes')::bigint,0)
                        ELSE 0
                      END
                    ),0)::bigint AS bytes
               FROM jobs
              WHERE kind='TRANSFER' AND console_id=$1
                AND (storage_id=$2 OR config->>'stagingStorageId'=$2)
                AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')`,
            [body.consoleId, storageId],
          )
        ).bytes as number;
      const reserved = await reservedAt(body.storageId);
      if (destination.freeBytes < reserved + destination.requiredBytes)
        throw new AppError('INSUFFICIENT_SPACE', 409);
      if (
        destination.stagingStorageId &&
        destination.stagingFreeBytes <
          (await reservedAt(destination.stagingStorageId)) + destination.stagingRequiredBytes
      )
        throw new AppError('INSUFFICIENT_INTERNAL_SPACE', 409);
      await sql.query(
        "INSERT INTO jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,config) VALUES($1,$2,'TRANSFER',$3,$4,$5,$6,'QUEUED_FOR_PS5',$7,$8)",
        [
          id,
          userId,
          artifact.release_id,
          artifact.id,
          body.consoleId,
          body.storageId,
          artifact.size,
          {
            method: selected.compatibility.method,
            reservedBytes: destination.requiredBytes,
            stagingStorageId: destination.stagingStorageId ?? undefined,
            stagingReservedBytes: destination.stagingRequiredBytes || undefined,
            installationId: body.installationId,
            backport: selected.backport,
            baseContentVersion: selected.baseContentVersion ?? undefined,
            firmware: selected.firmware,
            runtime: selected.runtime,
          },
        ],
      );
      await sql.query(
        `INSERT INTO console_library_entries(console_id,release_id,storage_id,state)
         VALUES($1,$2,$3,'QUEUED_FOR_PS5')
         ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET
           state='QUEUED_FOR_PS5',updated_at=now()`,
        [body.consoleId, artifact.release_id, body.storageId],
      );
      await jobEvent(sql, id);
    });
    return { id };
  };
  app.post('/api/v1/transfers', async (req, reply) => {
    const user = await auth.user(req),
      body = z
        .object({ artifactId: uuid, consoleId: uuid, storageId: z.string().max(64) })
        .parse(req.body);
    return reply.code(202).send(await enqueue(user.id, body));
  });
  app.post('/api/v1/device/transfers', async (req, reply) => {
    const c = await auth.device(req),
      body = z
        .object({ artifactId: uuid, storageId: z.string().max(64), consoleId: uuid.optional() })
        .parse(req.body);
    return reply
      .code(202)
      .send(await enqueue(c.user_id, { ...body, consoleId: body.consoleId ?? c.id }));
  });
  registerDeviceTaskRoutes(app, db, config, auth);
  return { plan, enqueue, close: native.close };
}
