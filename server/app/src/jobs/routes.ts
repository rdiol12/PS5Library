import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import { uuid } from '../../../shared/schemas/index.js';
import { queuedJobControlAllowed, reorderQueuedJobs, startRunner } from './runner.js';
import { jobEvent, jobJSON, liveJobEvents } from './events.js';
import { packageBuildAllowed } from './preparation.js';
import { AppError } from '../security/errors.js';

export function registerJobRoutes(
  app: FastifyInstance,
  db: DB,
  auth: Auth,
  runner: Awaited<ReturnType<typeof startRunner>>,
) {
  const listJobs = async (userId: string) =>
    (
      await db.query(
        `WITH q AS (
           SELECT
             id,
             row_number() OVER (
               PARTITION BY user_id
               ORDER BY
                 CASE WHEN state = 'QUEUED' THEN 1 ELSE 0 END,
                 queue_order NULLS LAST,
                 created_at,
                 id
             )::int AS queue_position
           FROM jobs
           WHERE user_id = $1
           AND kind IN ('DOWNLOAD', 'BUILD')
           AND desired_state = 'RUNNING'
           AND state IN (
             'QUEUED',
             'DOWNLOADING',
             'VERIFYING',
             'RETRYING',
             'EXTRACTING',
             'BUILDING'
           )
         ), page AS (
           SELECT j.*, q.queue_position
           FROM jobs j
           LEFT JOIN q ON q.id = j.id
           WHERE j.user_id = $1 AND j.dismissed_at IS NULL
           ORDER BY
             q.queue_position NULLS LAST,
             j.created_at DESC,
             j.id DESC
           LIMIT 100
         )
         SELECT
           p.*,
           g.title,
           u.role AS viewer_role,
           a.relative_path AS artifact_path,
           l.relative_path AS console_path,
           s.display_name AS storage_name
         FROM page p
         JOIN users u ON u.id = p.user_id
         JOIN game_releases r ON r.id = p.release_id
         JOIN games g ON g.id = r.game_id
         LEFT JOIN artifacts a ON a.id = p.artifact_id
         LEFT JOIN console_library_entries l
           ON l.console_id = p.console_id
           AND l.release_id = p.release_id
           AND l.storage_id = p.storage_id
         LEFT JOIN console_storage s
           ON s.console_id = p.console_id
           AND s.storage_id = p.storage_id
         ORDER BY
           p.queue_position NULLS LAST,
           p.created_at DESC,
           p.id DESC`,
        [userId],
      )
    ).rows.map((row) => jobJSON(row, row.viewer_role === 'ADMIN'));
  app.get('/api/v1/jobs', async (req) => listJobs((await auth.user(req)).id));
  app.get('/api/v1/device/jobs', async (req) => listJobs((await auth.device(req)).user_id));
  const jobOrder = z
    .object({
      ids: z
        .array(uuid)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict();
  app.post('/api/v1/jobs/reorder', async (req) => {
    const ids = await reorderQueuedJobs(
      db,
      (await auth.user(req)).id,
      jobOrder.parse(req.body).ids,
    );
    await runner.reconcile();
    return { ids };
  });
  app.post('/api/v1/device/jobs/reorder', async (req) => {
    const ids = await reorderQueuedJobs(
      db,
      (await auth.device(req)).user_id,
      jobOrder.parse(req.body).ids,
    );
    await runner.reconcile();
    return { ids };
  });
  app.get('/api/v1/jobs/:id', async (req) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id);
    const job = (await db.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [id, user.id]))
      .rows[0];
    if (!job) throw new AppError('NOT_FOUND', 404);
    return jobJSON(job, user.role === 'ADMIN');
  });
  const controlJob = async (
    userId: string,
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
  ) => {
    await transaction(db, async (sql) => {
      const job = (
        await sql.query(
          `SELECT j.*, u.role AS owner_role
           FROM jobs j
           JOIN users u ON u.id = j.user_id
           WHERE j.id = $1
           AND j.user_id = $2
           AND j.dismissed_at IS NULL
           FOR UPDATE OF j, u`,
          [id, userId],
        )
      ).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      if (action === 'retry') {
        if (job.state !== 'ERROR') throw new AppError('UNSUPPORTED_JOB_CONTROL', 409);
        if (job.kind === 'BUILD' && !packageBuildAllowed(job.owner_role))
          throw new AppError('ADMIN_REQUIRED', 403);
        const state = job.kind === 'TRANSFER' ? 'QUEUED_FOR_PS5' : 'QUEUED';
        await sql.query(
          `UPDATE jobs
           SET desired_state = 'RUNNING',
               state = $2,
               attempts = 0,
               error = NULL,
               speed_bytes_per_second = 0,
               eta_seconds = NULL,
               updated_at = now()
           WHERE id = $1`,
          [id, state],
        );
        if (job.kind === 'TRANSFER')
          await sql.query(
            `UPDATE console_library_entries
             SET state = 'QUEUED_FOR_PS5', updated_at = now()
             WHERE console_id = $1
             AND release_id = $2
             AND storage_id = $3`,
            [job.console_id, job.release_id, job.storage_id],
          );
      } else if (job.kind === 'TRANSFER') {
        if (action !== 'cancel' || ['READY_ON_PS5', 'CANCELLED'].includes(job.state))
          throw new AppError('UNSUPPORTED_JOB_CONTROL', 409);
        await sql.query(
          `UPDATE jobs
           SET desired_state = 'CANCELLED',
               state = 'CANCELLED',
               speed_bytes_per_second = 0,
               eta_seconds = NULL,
               updated_at = now()
           WHERE id = $1`,
          [id],
        );
        await sql.query(
          `DELETE FROM console_library_entries
           WHERE console_id = $1
           AND release_id = $2
           AND storage_id = $3
           AND state = 'QUEUED_FOR_PS5'`,
          [job.console_id, job.release_id, job.storage_id],
        );
        await sql.query(
          `UPDATE console_library_entries
           SET state = 'MISSING', updated_at = now()
           WHERE console_id = $1
           AND release_id = $2
           AND storage_id = $3
           AND state NOT IN ('READY_ON_PS5', 'MISSING')`,
          [job.console_id, job.release_id, job.storage_id],
        );
        await sql.query('DELETE FROM native_download_grants WHERE job_id=$1', [id]);
      } else {
        if (!queuedJobControlAllowed(job.kind, job.state, action))
          throw new AppError('UNSUPPORTED_JOB_CONTROL', 409);
        const desired =
            action === 'pause' ? 'PAUSED' : action === 'cancel' ? 'CANCELLED' : 'RUNNING',
          state = desired === 'RUNNING' ? 'QUEUED' : desired;
        await sql.query('UPDATE jobs SET desired_state=$2,state=$3,updated_at=now() WHERE id=$1', [
          id,
          desired,
          state,
        ]);
      }
      await jobEvent(sql, id);
    });
    await runner.reconcile();
    return { ok: true };
  };
  const jobControl = z.object({
    action: z.enum(['pause', 'resume', 'cancel', 'retry']),
  });
  app.post('/api/v1/jobs/:id/control', async (req) =>
    controlJob(
      (await auth.user(req)).id,
      uuid.parse((req.params as { id: string }).id),
      jobControl.parse(req.body).action,
    ),
  );
  app.post('/api/v1/device/jobs/:id/control', async (req) =>
    controlJob(
      (await auth.device(req)).user_id,
      uuid.parse((req.params as { id: string }).id),
      jobControl.parse(req.body).action,
    ),
  );
  const dismissJob = async (userId: string, id: string) => {
    const result = await db.query(
      `WITH dismissed AS (
         UPDATE jobs
         SET dismissed_at = now(), updated_at = now()
         WHERE id = $1
         AND user_id = $2
         AND dismissed_at IS NULL
         AND state IN ('COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED')
         RETURNING id
       ), removed AS (
         DELETE FROM job_events e
         USING dismissed d
         WHERE e.job_id = d.id
       )
       SELECT id FROM dismissed`,
      [id, userId],
    );
    if (result.rowCount) return { ok: true };
    if (
      !(
        await db.query('SELECT id FROM jobs WHERE id=$1 AND user_id=$2 AND dismissed_at IS NULL', [
          id,
          userId,
        ])
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    throw new AppError('JOB_STILL_ACTIVE', 409);
  };
  app.delete('/api/v1/jobs/:id', async (req) =>
    dismissJob((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)),
  );
  app.delete('/api/v1/device/jobs/:id', async (req) =>
    dismissJob((await auth.device(req)).user_id, uuid.parse((req.params as { id: string }).id)),
  );
  const events = async (userId: string, after: number) =>
    (
      await db.query(
        `SELECT
           e.id,
           e.job_id AS "jobId",
           e.state,
           CASE
             WHEN u.role = 'ADMIN' THEN e.progress
             ELSE e.progress - 'conversion'
           END AS progress,
           e.created_at AS "createdAt"
         FROM job_events e
         JOIN jobs j
           ON j.id = e.job_id
           AND j.user_id = e.user_id
           AND j.dismissed_at IS NULL
         JOIN users u ON u.id = e.user_id
         WHERE e.user_id = $1 AND e.id > $2
         ORDER BY e.id
         LIMIT 500`,
        [userId, after],
      )
    ).rows;
  app.get('/api/v1/events', async (req) => {
    const user = await auth.user(req),
      after = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after;
    return events(user.id, after);
  });
  const liveOwners = new WeakMap<object, string>();
  app.get(
    '/api/v1/events/live',
    {
      websocket: true,
      preValidation: async (req) => {
        liveOwners.set(req, (await auth.user(req)).id);
      },
    },
    (socket, req) => {
      const ownerId = liveOwners.get(req);
      liveOwners.delete(req);
      if (!ownerId) {
        socket.close(1008, 'Session expired');
        return;
      }
      const after = z
        .object({ after: z.coerce.number().int().min(0).default(0) })
        .parse(req.query).after;
      liveJobEvents(socket, ownerId, after, events, async () => {
        if ((await auth.user(req)).id !== ownerId) throw new AppError('UNAUTHORIZED', 401);
      });
    },
  );
  app.get('/api/v1/device/events', async (req) => {
    const after = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .parse(req.query).after;
    return {
      type: 'events',
      events: await events((await auth.device(req)).user_id, after),
    };
  });
}
