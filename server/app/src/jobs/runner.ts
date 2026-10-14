import { sourceLocation } from '../sources/access.js';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { transaction, type DB } from '../db.js';
import { downloadFile } from '../downloads/stream.js';
import { inspect } from '../library/inspect.js';
import { within } from '../security/paths.js';
import { sourceHeaders } from '../sources/connectors.js';
import { AppError } from '../security/errors.js';
import { jobEvent } from './events.js';
import { packageBuildAllowed, prepare, publishArtifact } from './preparation.js';
import { mediaDirectory, prepareTrailer } from '../artwork/trailers.js';
import type { Logger } from '../logging.js';

export const parseRedisInfo = (value: string) =>
  Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes(':'))
      .map((line) => {
        const split = line.indexOf(':');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
export const workerLockDuration = 30 * 60_000;
const runnableJobStates = "('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING')";
const pendingQueueStates = [
  'active',
  'waiting',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
] as const;
const unknownQueueJobDelayMs = 60 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const queuedJobControlAllowed = (
  kind: string,
  state: string,
  action: 'pause' | 'resume' | 'cancel',
) =>
  !['COMPLETED', 'CANCELLED', 'ERROR'].includes(state) &&
  (kind === 'DOWNLOAD' || (kind === 'BUILD' && action === 'cancel'));
export const retryableJobFailure = (attempts: number, code: string) =>
  attempts < 2 &&
  [
    'DOWNLOAD_FAILED',
    'DOWNLOAD_HTTP_ERROR',
    'DOWNLOAD_TIMEOUT',
    'INCOMPLETE_INPUT',
    'STORAGE_NOT_WRITABLE',
  ].includes(code);
const logCompleted = (logs: Logger, jobId: string | undefined, task: string, started: bigint) =>
  void logs.write('INFO', 'queue.job_completed', undefined, {
    jobId,
    task,
    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
  });
const logStarted = (logs: Logger, queued: Job, task: string) =>
  void logs.write('INFO', 'queue.job_started', undefined, {
    jobId: queued.id,
    task,
    attempt: queued.attemptsMade + 1,
  });

type QueueJob = {
  id?: string;
  name: string;
  data?: { id?: string };
  remove(): Promise<void>;
};

export async function cleanupOrphanedQueueJobs(
  queue: { getJobs(states: [...typeof pendingQueueStates]): Promise<QueueJob[]> },
  db: DB,
) {
  const queued = await queue.getJobs([...pendingQueueStates]);
  const jobIds = queued.flatMap((job) =>
      job.name === 'download' && job.id && uuidPattern.test(job.id) ? [job.id] : [],
    ),
    mediaIds = queued.flatMap((job) =>
      job.name === 'trailer' && job.data?.id && uuidPattern.test(job.data.id) ? [job.data.id] : [],
    ),
    [jobs, media] = await Promise.all([
      jobIds.length
        ? db.query('SELECT id::text AS id FROM jobs WHERE id = ANY($1::uuid[])', [jobIds])
        : Promise.resolve({ rows: [] }),
      mediaIds.length
        ? db.query('SELECT id::text AS id FROM game_media WHERE id = ANY($1::uuid[])', [mediaIds])
        : Promise.resolve({ rows: [] }),
    ]),
    knownJobs = new Set(jobs.rows.map((row) => row.id)),
    knownMedia = new Set(media.rows.map((row) => row.id));
  let removed = 0,
    failed = 0;
  for (const job of queued) {
    const orphan =
      (job.name === 'download' && !!job.id && !knownJobs.has(job.id)) ||
      (job.name === 'trailer' && !!job.data?.id && !knownMedia.has(job.data.id));
    if (!orphan) continue;
    try {
      await job.remove();
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

export async function closeIdleQueue(queue: Pick<Queue, 'getJobCounts' | 'obliterate' | 'close'>) {
  try {
    const counts = await queue.getJobCounts(...pendingQueueStates);
    if (Object.values(counts).every((count) => count === 0)) await queue.obliterate();
  } finally {
    await queue.close();
  }
}

export async function cleanupTerminalJobWorkspaces(
  db: DB,
  dataDir: string,
  removeWorkspace: (workspace: string) => Promise<void> = (workspace) =>
    rm(workspace, { recursive: true, force: true }),
) {
  const jobsDirectory = within(dataDir, path.join(dataDir, 'jobs'));
  let entries: Dirent[];
  try {
    entries = await readdir(jobsDirectory, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return 0;
    throw error;
  }
  const workspaces = new Map(
    entries
      .filter((entry) => entry.isDirectory() && uuidPattern.test(entry.name))
      .map((entry) => [entry.name.toLowerCase(), entry.name] as const),
  );
  const ids = [...workspaces.keys()].sort();
  if (!ids.length) return 0;
  const rows = (
    await db.query(
      `SELECT id, state, error, dismissed_at
       FROM jobs
       WHERE id=ANY($1::uuid[])
         AND kind IN ('BUILD','DOWNLOAD')
         AND state IN ('COMPLETED','ERROR','CANCELLED')`,
      [ids],
    )
  ).rows.filter(
    (row) => row.state !== 'ERROR' || row.dismissed_at || !retryableJobFailure(0, row.error ?? ''),
  );
  let cleaned = 0;
  for (const row of rows) {
    const name = workspaces.get(String(row.id).toLowerCase());
    if (!name) continue;
    const workspace = within(jobsDirectory, path.join(jobsDirectory, name));
    try {
      const info = await lstat(workspace);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await removeWorkspace(workspace);
      cleaned++;
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        continue;
      throw error;
    }
  }
  return cleaned;
}

export async function runActiveJob(
  active: Set<string>,
  id: string | undefined,
  run: () => Promise<void>,
) {
  if (id !== undefined && active.has(id)) return false;
  if (id !== undefined) active.add(id);
  try {
    await run();
    return true;
  } finally {
    if (id !== undefined) active.delete(id);
  }
}

export async function claimUserJob(db: DB, id: string, userId: string) {
  return transaction(db, async (sql) => {
    const owner = (await sql.query('SELECT role FROM users WHERE id=$1 FOR UPDATE', [userId]))
      .rows[0];
    if (!owner) return false;
    const head = (
      await sql.query(
        `SELECT id, kind
         FROM jobs
         WHERE user_id = $1
           AND kind IN ('DOWNLOAD', 'BUILD')
           AND desired_state = 'RUNNING'
           AND state IN ${runnableJobStates}
         ORDER BY
           CASE WHEN state = 'QUEUED' THEN 1 ELSE 0 END,
           queue_order NULLS LAST,
           created_at,
           id
         LIMIT 1
         FOR UPDATE`,
        [userId],
      )
    ).rows[0];
    if (!head || head.id !== id) {
      await sql.query(
        `UPDATE jobs
         SET state = 'QUEUED',
             speed_bytes_per_second = 0,
             eta_seconds = NULL,
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND kind IN ('DOWNLOAD', 'BUILD')
           AND desired_state = 'RUNNING'
           AND state IN ('DOWNLOADING', 'VERIFYING', 'RETRYING', 'EXTRACTING', 'BUILDING')`,
        [id, userId],
      );
      return false;
    }
    if (head.kind === 'BUILD' && !packageBuildAllowed(owner.role)) {
      await sql.query(
        `UPDATE jobs
         SET state = 'ERROR',
             desired_state = 'PAUSED',
             error = 'ADMIN_REQUIRED',
             speed_bytes_per_second = 0,
             eta_seconds = NULL,
             updated_at = now()
         WHERE id = $1`,
        [id],
      );
      await jobEvent(sql, id);
      return false;
    }
    return !!(
      await sql.query(
        `UPDATE jobs
         SET state = $2,
             error = NULL,
             updated_at = now()
         WHERE id = $1
           AND desired_state = 'RUNNING'
           AND state IN ${runnableJobStates}
         RETURNING id`,
        [id, head.kind === 'BUILD' ? 'BUILDING' : 'DOWNLOADING'],
      )
    ).rowCount;
  });
}

export async function reorderQueuedJobs(db: DB, userId: string, ids: string[]) {
  return transaction(db, async (sql) => {
    const owner = (await sql.query('SELECT role FROM users WHERE id=$1 FOR UPDATE', [userId]))
      .rows[0];
    if (!owner) throw new AppError('INVALID_QUEUE_ORDER', 409);
    const rows = (
      await sql.query(
        `SELECT id, kind
         FROM jobs
         WHERE user_id = $1
           AND kind IN ('DOWNLOAD', 'BUILD')
           AND desired_state = 'RUNNING'
           AND state = 'QUEUED'
         ORDER BY queue_order NULLS LAST, created_at, id
         FOR UPDATE`,
        [userId],
      )
    ).rows;
    if (rows.some((row) => row.kind === 'BUILD') && !packageBuildAllowed(owner.role))
      throw new AppError('ADMIN_REQUIRED', 403);
    const current = new Set(rows.map((row) => row.id));
    if (
      ids.length !== current.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !current.has(id))
    )
      throw new AppError('INVALID_QUEUE_ORDER', 409);
    if (ids.length)
      await sql.query(
        `UPDATE jobs j
         SET queue_order = o.position, updated_at = now()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
         WHERE j.id = o.id
           AND j.user_id = $2`,
        [ids, userId],
      );
    return ids;
  });
}

async function processTrailerJob(
  db: DB,
  config: Config,
  logs: Logger,
  queued: Job,
  started: bigint,
) {
  logStarted(logs, queued, queued.name);
  try {
    await prepareTrailer(db, config, queued.data.id);
    logCompleted(logs, queued.id, queued.name, started);
  } catch (error) {
    void logs.write(
      'ERROR',
      'queue.job_failed',
      error instanceof Error ? error.message : 'Trailer preparation failed',
      {
        jobId: queued.id ?? undefined,
        task: queued.name,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      },
    );
    throw error;
  }
}

async function processLibraryJob(
  db: DB,
  config: Config,
  logs: Logger,
  queued: Job,
  started: bigint,
) {
  const row = (
    await db.query(
      `SELECT
         j.*,
         sr.metadata AS source_metadata,
         s.config AS source_config,
         s.type AS source_type,
         g.title,
         g.title_id,
         r.content_id,
         r.version,
         r.kind AS release_kind
       FROM jobs j
       JOIN source_releases sr ON sr.id = j.source_release_id
       JOIN sources s ON s.id = sr.source_id
       JOIN game_releases r ON r.id = j.release_id
       JOIN games g ON g.id = r.game_id
       WHERE j.id = $1`,
      [queued.id],
    )
  ).rows[0];
  if (
    !row ||
    ['COMPLETED', 'ERROR', 'CANCELLED'].includes(row.state) ||
    row.desired_state !== 'RUNNING'
  ) {
    void logs.write('INFO', 'queue.job_skipped', undefined, {
      jobId: queued.id ?? undefined,
      task: queued.name,
      state: row?.state ?? 'MISSING',
    });
    return;
  }
  if (!(await claimUserJob(db, row.id, row.user_id))) {
    void logs.write('INFO', 'queue.job_deferred', undefined, {
      jobId: row.id,
      userId: row.user_id,
    });
    return;
  }
  logStarted(logs, queued, row.kind.toLowerCase());
  const partPath = path.join(config.DATA_DIR, 'jobs', row.id, 'content.part');
  try {
    if (row.kind === 'BUILD') {
      await prepare(db, config, row);
      logCompleted(logs, row.id, 'build', started);
      return;
    }
    await db.query(
      "UPDATE jobs SET state='DOWNLOADING',attempts=attempts+1,error=NULL,updated_at=now() WHERE id=$1",
      [row.id],
    );
    await jobEvent(db, row.id);
    const source = row.config.sourceMetadata;
    const [local, location] = await sourceLocation(
      config,
      row.config.sourceType,
      row.config.sourceOwner ?? row.user_id,
      source.location,
    );
    const output = await downloadFile({
      location,
      local,
      partPath,
      size: source.size,
      sha256: source.sha256,
      privateOrigins: config.privateOrigins,
      headers: sourceHeaders(row.config.sourceConfig, local ? undefined : location),
      margin: config.DISK_MARGIN_BYTES,
      progress: async (progress) => {
        const control = (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [row.id]))
          .rows[0].desired_state;
        if (control !== 'RUNNING') throw new AppError(control);
        await transaction(db, async (sql) => {
          await sql.query(
            `UPDATE jobs
             SET downloaded_bytes = $2,
                 total_bytes = $3,
                 speed_bytes_per_second = $4,
                 eta_seconds = $5,
                 updated_at = now()
             WHERE id = $1`,
            [
              row.id,
              progress.downloadedBytes,
              progress.totalBytes,
              progress.speedBytesPerSecond,
              progress.etaSeconds,
            ],
          );
          await jobEvent(sql, row.id);
        });
      },
      onVerify: async () => {
        await db.query(
          "UPDATE jobs SET state='VERIFYING',speed_bytes_per_second=0,updated_at=now() WHERE id=$1",
          [row.id],
        );
        await jobEvent(db, row.id);
      },
    });
    const inspection = await inspect(partPath, source.format, {
      titleId: row.title_id,
      contentId: row.content_id,
      version: row.version,
    });
    await publishArtifact(db, config, row, {
      ...output,
      outputPath: partPath,
      format: source.format,
      inspection,
    });
    logCompleted(logs, row.id, 'download', started);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'DOWNLOAD_FAILED';
    const state = ['PAUSED', 'CANCELLED'].includes(code)
      ? code
      : retryableJobFailure(row.attempts, code)
        ? 'RETRYING'
        : 'ERROR';
    await db.query(
      'UPDATE jobs SET state=$2,error=$3,speed_bytes_per_second=0,eta_seconds=NULL,updated_at=now() WHERE id=$1',
      [row.id, state, state === 'PAUSED' ? null : code],
    );
    await jobEvent(db, row.id);
    if (state === 'CANCELLED' || code === 'CORRUPT_INPUT') await rm(partPath, { force: true });
    if (row.kind === 'BUILD' && ['ERROR', 'CANCELLED'].includes(state))
      await rm(within(config.DATA_DIR, path.join(config.DATA_DIR, 'jobs', row.id)), {
        recursive: true,
        force: true,
      });
    void logs.write(
      state === 'ERROR' ? 'ERROR' : 'WARN',
      'queue.job_failed',
      error instanceof Error ? error.message : code,
      {
        jobId: row.id,
        task: row.kind.toLowerCase(),
        code,
        state,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      },
    );
    if (state === 'RETRYING') throw error;
  }
}

async function processQueuedJob(
  db: DB,
  config: Config,
  logs: Logger,
  activeJobs: Set<string>,
  queued: Job,
) {
  if (
    !(await runActiveJob(activeJobs, queued.id, async () => {
      const started = process.hrtime.bigint();
      if (queued.name === 'trailer') {
        await processTrailerJob(db, config, logs, queued, started);
        return;
      }
      await processLibraryJob(db, config, logs, queued, started);
    }))
  )
    void logs.write('WARN', 'queue.job_duplicate_skipped', undefined, {
      jobId: queued.id ?? undefined,
      task: queued.name,
    });
}

export async function startRunner(db: DB, config: Config, logs: Logger) {
  const cleaned = await cleanupTerminalJobWorkspaces(db, config.DATA_DIR);
  if (cleaned)
    await logs.write('INFO', 'queue.terminal_workspaces_cleaned', undefined, { count: cleaned });
  const url = new URL(config.REDIS_URL);
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
  // A separate queue per database/schema keeps isolated integration checks out of live queues.
  const name = `ps5library-${createHash('sha256').update(config.DATABASE_URL).digest('hex').slice(0, 12)}`;
  const queue = new Queue(name, { connection });
  queue.on(
    'error',
    (error) => void logs.write('ERROR', 'redis.queue_error', error.message, { queue: name }),
  );
  await queue.waitUntilReady();
  const orphaned = await cleanupOrphanedQueueJobs(queue, db);
  if (orphaned.removed || orphaned.failed)
    await logs.write(orphaned.failed ? 'WARN' : 'INFO', 'queue.orphans_reconciled', undefined, {
      ...orphaned,
      queue: name,
    });
  // ponytail: process-local guard matches the single server deployment; use a DB lease before horizontal scaling.
  const activeJobs = new Set<string>();
  const worker = new Worker(
    name,
    async (queued, token) => {
      if (queued.name !== 'download' && queued.name !== 'trailer') {
        await queued.moveToDelayed(Date.now() + unknownQueueJobDelayMs, token);
        void logs.write('WARN', 'queue.job_unsupported_deferred', undefined, {
          jobId: queued.id ?? undefined,
          task: queued.name,
          retryInMs: unknownQueueJobDelayMs,
        });
        throw new DelayedError();
      }
      await processQueuedJob(db, config, logs, activeJobs, queued);
    },
    { connection, concurrency: 2, lockDuration: workerLockDuration, lockRenewTime: 30_000 },
  );
  worker.on(
    'error',
    (error) => void logs.write('ERROR', 'queue.worker_error', error.message, { queue: name }),
  );
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const jobs = (
        await db.query(
          `SELECT DISTINCT ON (user_id) id
           FROM jobs
           WHERE kind IN ('DOWNLOAD', 'BUILD')
             AND desired_state = 'RUNNING'
             AND state IN ${runnableJobStates}
           ORDER BY
             user_id,
             CASE WHEN state = 'QUEUED' THEN 1 ELSE 0 END,
             queue_order NULLS LAST,
             created_at,
             id`,
        )
      ).rows;
      for (const job of jobs)
        await queue.add(
          'download',
          {},
          {
            jobId: job.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      const abandoned = (
        await db.query(
          "SELECT id,relative_path FROM game_media WHERE state='UPLOADING' AND updated_at<now()-interval '11 minutes'",
        )
      ).rows;
      for (const row of abandoned) {
        await rm(mediaDirectory(config, row), { recursive: true, force: true });
        await db.query(
          `UPDATE game_media
           SET state = 'ERROR',
               reserved_bytes = 0,
               error = 'UPLOAD_INTERRUPTED',
               updated_at = now()
           WHERE id = $1
             AND state = 'UPLOADING'`,
          [row.id],
        );
      }
      const trailers = (
        await db.query("SELECT id FROM game_media WHERE state IN ('QUEUED','PREPARING')")
      ).rows;
      for (const row of trailers)
        await queue.add(
          'trailer',
          { id: row.id },
          { jobId: 'trailer-' + row.id, removeOnComplete: true, removeOnFail: true },
        );
    } finally {
      reconciling = false;
    }
  };
  await worker.waitUntilReady();
  await reconcile();
  await logs.write('INFO', 'queue.ready', undefined, { queue: name, concurrency: 2 });
  const timer = setInterval(
    () =>
      void reconcile().catch(
        (e) => void logs.write('ERROR', 'queue.reconcile_failed', e.message, { queue: name }),
      ),
    2000,
  );
  const diagnostics = async () => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          const started = process.hrtime.bigint(),
            client = await queue.client,
            raw = client as unknown as {
              call?: (command: string, ...args: string[]) => Promise<unknown>;
            };
          const [counts, details, slowlogLength] = await Promise.all([
              queue.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed', 'paused'),
              client.info(),
              raw.call ? raw.call('SLOWLOG', 'LEN') : Promise.resolve(null),
            ]),
            info = parseRedisInfo(details);
          return {
            status: 'CONNECTED',
            latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
            version: info.redis_version ?? null,
            uptimeSeconds: Number(info.uptime_in_seconds ?? 0),
            usedMemory: info.used_memory_human ?? null,
            connectedClients: Number(info.connected_clients ?? 0),
            slowlogLength: Number(slowlogLength),
            queue: { name, consumerRunning: worker.isRunning(), ...counts },
          };
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Redis diagnostics timed out')), 2000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  return {
    reconcile,
    diagnostics,
    close: async () => {
      clearInterval(timer);
      await worker.close();
      await closeIdleQueue(queue);
    },
  };
}
