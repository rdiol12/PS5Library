import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { transaction, type DB } from '../db.js';
import type { Logger } from '../logging.js';
import { runWorker } from '../library/inspect.js';
import { profileSchema } from '../../../shared/schemas/index.js';
import { profileHash } from '../library/backports.js';
import { localSourceRoot } from '../sources/access.js';
import { signature } from '../sources/watch.js';
import { existingWithin } from '../security/paths.js';
import { AppError } from '../security/errors.js';
import { jobEvent } from './events.js';
import type { WorkerProgress } from '../worker-progress.js';

// A user drops a backport bundle (a zip or the extracted files) into a game's `backport/` folder.
// This subsystem notices the change on any game, installs the new set (removing the old files),
// regenerates the compatibility profile, and surfaces the work in the Activity tab as a cancellable
// BACKPORT_SYNC job with a progress bar. It never rebuilds the base package: a backport change
// leaves the base-tree hash untouched, so only the (small) overlay is rebuilt at the next install.

// Keyed by stamp format: changing how the stamp is computed must re-baseline quietly, not make
// every existing game look changed.
const STAMP_KEY = 'backportStampV2';
const DEFAULT_RUNTIME = 'kstuff';
const DEFAULT_METHOD = 'FPKG';
// Target firmware is not implied by the backport binaries. For a game that already has a profile we
// reuse its settings; for a brand-new one we read the firmware from the bundle name (FW_4.50_...).
const firmwareFromName = (name: string) => {
  const match = /fw[_-]?v?(\d{1,2})\.(\d{2})(?![0-9])/i.exec(name);
  return match ? `${Number(match[1])}.${match[2]}` : null;
};

type BackportState = { stamp: string; zip: string | null; files: number; bytes: number };

// A cheap metadata-only fingerprint of the backport folder (names + sizes + mtimes), plus the first
// delivered zip if one is present. Hashing file contents is avoided here; this runs on every scan.
export async function backportState(dir: string): Promise<BackportState | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Stamp over relative path + size only (NOT mtime): installing/restoring files copies them with
  // fresh mtimes, so an mtime-based stamp would drift on every rollback and loop the scan forever.
  const hash = createHash('sha256').update('backport-stamp-v2');
  const rows: { rel: string; size: number }[] = [];
  let zip: string | null = null,
    bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name),
      rel = path.relative(dir, full).split(path.sep).join('/');
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    rows.push({ rel, size: info.size });
    bytes += info.size;
    if (!zip && /\.zip$/i.test(entry.name)) zip = full;
  }
  if (!rows.length) return null;
  for (const row of rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)))
    hash.update(JSON.stringify([row.rel, row.size]));
  return { stamp: hash.digest('hex'), zip, files: rows.length, bytes };
}

async function activeProfile(db: DB, userId: string, titleId: string) {
  return (
    await db.query(
      `SELECT profile
       FROM compatibility_profiles
       WHERE user_id = $1 AND title_id = $2
       ORDER BY (profile->>'testedState' = 'TESTED') DESC, created_at DESC
       LIMIT 1`,
      [userId, titleId],
    )
  ).rows[0]?.profile as Record<string, any> | undefined;
}

// A game is busy if it has an in-flight build/transfer/sync for the same release. The sync must not
// run alongside a build or compete with another sync.
async function releaseBusy(db: DB, releaseId: string, exceptJob?: string) {
  return !!(
    await db.query(
      `SELECT 1 FROM jobs
       WHERE release_id = $1
         AND ($2::uuid IS NULL OR id <> $2)
         AND kind IN ('BUILD', 'TRANSFER', 'BACKPORT_SYNC')
         AND state NOT IN ('COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED')
       LIMIT 1`,
      [releaseId, exceptJob ?? null],
    )
  ).rowCount;
}

// Detect changed/new backport folders across every eligible game and enqueue one sync job each.
export async function scanBackportDeliveries(db: DB, config: Config, logs: Logger) {
  if (!config.DUMP_ROOT) return;
  const candidates = (
    await db.query(
      `SELECT DISTINCT ON (r.id)
         sr.id AS source_release_id,
         sr.metadata,
         sr.source_id,
         r.id AS release_id,
         g.title_id,
         g.title,
         s.user_id,
         s.type AS source_type
       FROM source_releases sr
       JOIN game_releases r ON r.id = sr.release_id
       JOIN games g ON g.id = r.game_id
       JOIN sources s ON s.id = sr.source_id
       WHERE sr.metadata->>'format' = 'folder'
         AND COALESCE(sr.metadata->>'kind', 'BASE') = 'BASE'
         AND s.type IN ('WATCH_FOLDER', 'LOCAL_FOLDER')
         AND NOT (sr.metadata ? 'retiredAt')
       ORDER BY r.id, sr.id`,
    )
  ).rows;
  for (const row of candidates) {
    try {
      const location = row.metadata?.location as string | undefined;
      if (!location) continue;
      const root = localSourceRoot(config, row.source_type, row.user_id);
      const gameDir = await existingWithin(root, path.resolve(root, location)).catch(() => null);
      if (!gameDir) continue;
      const state = await backportState(path.join(gameDir, 'backport'));
      if (!state) continue;
      const syncedStamp = row.metadata?.[STAMP_KEY] as string | undefined;
      // First sight of any backport folder: record its stamp quietly and never sync, so existing
      // games are left alone. Only a dropped zip or a change after that baseline starts a sync.
      const changed = state.zip || state.stamp !== syncedStamp;
      if (!changed) continue;
      if (!state.zip && !syncedStamp) {
        await db.query(
          `UPDATE source_releases
           SET metadata = metadata || jsonb_build_object($3::text, $2::text)
           WHERE id = $1`,
          [row.source_release_id, state.stamp, STAMP_KEY],
        );
        continue;
      }
      if (await releaseBusy(db, row.release_id)) continue;
      // Don't re-enqueue the same input: a prior sync for this exact stamp (pending, done, or
      // failed) is left alone until the user dismisses it or drops different files.
      const attempted = await db.query(
        `SELECT 1 FROM jobs
         WHERE release_id = $1 AND kind = 'BACKPORT_SYNC'
           AND dismissed_at IS NULL AND config->>'stamp' = $2
         LIMIT 1`,
        [row.release_id, state.stamp],
      );
      if (attempted.rowCount) continue;
      const id = randomUUID();
      await db.query(
        `INSERT INTO jobs(id, user_id, kind, release_id, source_release_id, state, config)
         VALUES($1, $2, 'BACKPORT_SYNC', $3, $4, 'QUEUED', $5)`,
        [
          id,
          row.user_id,
          row.release_id,
          row.source_release_id,
          {
            sourceType: row.source_type,
            location,
            titleId: row.title_id,
            stamp: state.stamp,
            progress: { stage: 'Queued backport update', completedStages: 0, totalStages: 5 },
          },
        ],
      );
      await jobEvent(db, id);
      await logs.write('INFO', 'backport.sync_enqueued', undefined, {
        jobId: id,
        titleId: row.title_id,
      });
    } catch (error) {
      await logs.write(
        'WARN',
        'backport.scan_failed',
        error instanceof Error ? error.message : 'scan failed',
        { titleId: row.title_id },
      );
    }
  }
}

const cancelled = async (db: DB, id: string) =>
  (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [id])).rows[0]?.desired_state !==
  'RUNNING';

async function report(
  db: DB,
  id: string,
  stage: string,
  completedStages: number,
  bytes?: { completedBytes: number; totalBytes: number },
) {
  await transaction(db, async (sql) => {
    await sql.query(
      // Only advance a job that is still wanted — never resurrect one the user just cancelled.
      `UPDATE jobs
       SET state = 'BUILDING',
           downloaded_bytes = $3,
           total_bytes = $4,
           config = jsonb_set(config, '{progress}', $2::jsonb),
           updated_at = now()
       WHERE id = $1 AND desired_state = 'RUNNING'`,
      [
        id,
        {
          stage,
          completedStages,
          totalStages: 5,
          ...(bytes ? { operation: bytes } : {}),
        },
        bytes?.completedBytes ?? 0,
        bytes?.totalBytes ?? 0,
      ],
    );
    await jobEvent(sql, id);
  });
}

// Run one enqueued sync: install the new backport set, rehash the tree (progress-bearing, so the
// stall watchdog stays armed), regenerate the profile, and record the result. All file moves are
// staged under the job workspace so a cancel or failure restores the previous backport folder.
export async function runBackportSync(db: DB, config: Config, logs: Logger, job: any) {
  const workspace = path.join(config.DATA_DIR, 'jobs', job.id),
    backup = path.join(workspace, 'backport-backup'),
    incoming = path.join(workspace, 'incoming');
  const fail = async (code: string, message?: string) => {
    await transaction(db, async (sql) => {
      await sql.query(
        `UPDATE jobs SET state='ERROR', error=$2, speed_bytes_per_second=0, eta_seconds=NULL,
         config = jsonb_set(config, '{progress}', $3::jsonb), updated_at=now() WHERE id=$1`,
        [
          job.id,
          code,
          { stage: message ?? 'Backport update failed', completedStages: 0, totalStages: 5 },
        ],
      );
      await jobEvent(sql, job.id);
    });
    await logs.write('ERROR', 'backport.sync_failed', message ?? code, {
      jobId: job.id,
      titleId: job.config?.titleId,
    });
  };
  const root = localSourceRoot(config, job.config.sourceType, job.user_id);
  let gameDir: string;
  try {
    gameDir = await existingWithin(root, path.resolve(root, job.config.location));
  } catch {
    return fail('SOURCE_MISSING', 'The game folder is no longer available');
  }
  const backportDir = path.join(gameDir, 'backport');
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  await mkdir(workspace, { recursive: true });
  let installed = false;
  try {
    // 1) Stage the new file set. A dropped zip is extracted (by the worker, where it can be scanned)
    //    into `incoming`; loose files are taken from the folder as-is.
    await report(db, job.id, 'Preparing backport update', 0);
    const state = await backportState(backportDir);
    if (!state) return fail('BACKPORT_FILES_MISSING', 'No backport files were found');
    if (state.zip) {
      await report(db, job.id, 'Extracting backport files', 1);
      // The worker's extractor creates `incoming` and refuses a pre-existing path (OUTPUT_EXISTS).
      // No run key: a key is reattach-keyed, and reusing one across calls replays a settled result.
      await runWorker(['extract-zip', state.zip, incoming, String(2 * 1024 ** 3)]);
    }
    // 2) Back up the current folder, then replace it with the new set (old files removed).
    if (await cancelled(db, job.id)) throw new AppError('CANCELLED');
    await report(db, job.id, 'Installing backport files', 2);
    await cp(backportDir, backup, { recursive: true });
    if (state.zip) {
      installed = true;
      await rm(backportDir, { recursive: true, force: true });
      await cp(incoming, backportDir, { recursive: true });
    }
    // 3) Rehash the game tree. hash-base-tree reports byte progress, so the long pass keeps the
    //    worker watchdog armed and drives this job's progress bar.
    if (await cancelled(db, job.id)) throw new AppError('CANCELLED');
    await report(db, job.id, 'Verifying game files', 3);
    const digest = (await runWorker(
      ['hash-base-tree', gameDir],
      async (event: WorkerProgress) => {
        const bytes = event.operation ?? event.staging ?? event.extraction;
        await report(db, job.id, 'Verifying game files', 3, bytes).catch(() => {});
      },
      job.id,
    )) as { sha256: string; size: number; sourceTreeSha256: string; sourceTreeSize: number };
    // 4) Regenerate the profile. Reuse an existing profile's firmware/runtime/method; for a new game
    //    infer the firmware from the bundle name and default the rest.
    if (await cancelled(db, job.id)) throw new AppError('CANCELLED');
    await report(db, job.id, 'Generating compatibility profile', 4);
    const existing = await activeProfile(db, job.user_id, job.config.titleId);
    const meta = job.source_metadata ?? {};
    const targetFirmware =
      existing?.targetFirmware ?? firmwareFromName(path.basename(state.zip ?? job.config.location));
    if (!targetFirmware)
      return fail(
        'BACKPORT_TARGET_UNVERIFIED',
        'Could not determine target firmware — set a profile once for this game',
      );
    const runtime = existing?.runtime ?? DEFAULT_RUNTIME;
    const method = existing?.installationMethod ?? meta.autoPrepare ?? DEFAULT_METHOD;
    const identity = {
      titleId: job.title_id,
      contentId: job.content_id,
      version: job.version,
      title: job.title,
      minimumFirmware: meta.minimumFirmware ?? null,
    };
    const generated = profileSchema.parse(
      // No run key (see extract): keep job.id unique to the hash call so cancel can target it.
      await runWorker([
        'generate-backport-profile',
        gameDir,
        JSON.stringify(identity),
        targetFirmware,
        runtime,
        method,
        digest.sourceTreeSha256,
      ]),
    );
    const id = randomUUID();
    const profile = {
      ...generated,
      inputHashes: [...new Set([digest.sha256, ...generated.inputHashes])],
      id,
    };
    profileHash(profileSchema.parse(profile));
    // 5) Commit: add the new profile (newest wins; older ones stay because built artifacts and
    //    installations reference them), refresh the source digest so the watcher does not re-hash,
    //    and record the synced stamp. All in one transaction.
    const stamp = await signature(gameDir);
    await transaction(db, async (sql) => {
      await sql.query(
        `INSERT INTO compatibility_profiles(
           id, user_id, title_id, content_id, game_version, target_firmware, runtime, profile)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          job.user_id,
          profile.titleId,
          profile.contentId,
          profile.gameVersion,
          targetFirmware,
          runtime,
          profile,
        ],
      );
      await sql.query(
        `UPDATE source_releases
         SET metadata = metadata
           || jsonb_build_object(
                'sha256', $2::text,
                'size', $3::bigint,
                'installedSize', $3::bigint,
                'sourceTreeSha256', $4::text,
                'sourceTreeSize', $5::bigint,
                $7::text, $6::text)
         WHERE id = $1`,
        [
          job.source_release_id,
          digest.sha256,
          digest.size,
          digest.sourceTreeSha256,
          digest.sourceTreeSize,
          (await backportState(backportDir))?.stamp ?? state.stamp,
          STAMP_KEY,
        ],
      );
      await sql.query(
        `UPDATE source_observations SET signature=$3, state='READY', error=NULL
         WHERE source_id=$1 AND path=$2`,
        [job.source_id, job.config.location, stamp],
      );
      await sql.query(
        `UPDATE jobs SET state='COMPLETED', speed_bytes_per_second=0, eta_seconds=NULL,
         config = jsonb_set(config, '{progress}', $2::jsonb), updated_at=now() WHERE id=$1`,
        [job.id, { stage: 'Backport updated', completedStages: 5, totalStages: 5 }],
      );
      await jobEvent(sql, job.id);
    });
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await logs.write('INFO', 'backport.sync_completed', undefined, {
      jobId: job.id,
      titleId: job.title_id,
      files: profile.requiredFiles?.length ?? 0,
    });
  } catch (error) {
    // Restore the previous backport folder exactly (wipe first so no new-set files linger). This
    // returns the stamp to its pre-sync value, so the dedup guard holds and the scan won't loop.
    // Only needed when a dropped zip replaced the folder; the backup is kept if the restore fails.
    let restored = true;
    if (installed)
      try {
        await stat(backup);
        await rm(backportDir, { recursive: true, force: true });
        await cp(backup, backportDir, { recursive: true });
      } catch (restoreError) {
        restored = false;
        await logs.write(
          'ERROR',
          'backport.restore_failed',
          restoreError instanceof Error ? restoreError.message : String(restoreError),
          { jobId: job.id, backup },
        );
      }
    if (restored) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    // A cancel that aborts the worker mid-hash surfaces as a worker error; treat it as the cancel.
    if (
      (error instanceof AppError && error.code === 'CANCELLED') ||
      (await cancelled(db, job.id).catch(() => false))
    ) {
      await db.query(
        `UPDATE jobs SET state='CANCELLED', speed_bytes_per_second=0, eta_seconds=NULL,
         config = jsonb_set(config, '{progress}', $2::jsonb), updated_at=now() WHERE id=$1`,
        [job.id, { stage: 'Backport update cancelled', completedStages: 0, totalStages: 5 }],
      );
      await jobEvent(db, job.id);
      return;
    }
    await logs.write(
      'ERROR',
      'backport.sync_error',
      error instanceof Error ? error.message : String(error),
      { jobId: job.id },
    );
    await fail(error instanceof AppError ? error.code : 'BACKPORT_SYNC_FAILED');
  }
}

// Pick the oldest queued sync whose game is not otherwise busy and run it (one at a time).
export async function processBackportSyncJobs(db: DB, config: Config, logs: Logger) {
  const job = (
    await db.query(
      `SELECT j.*, g.title, r.content_id, r.version, sr.metadata AS source_metadata
       FROM jobs j
       JOIN game_releases r ON r.id = j.release_id
       JOIN games g ON g.id = r.game_id
       LEFT JOIN source_releases sr ON sr.id = j.source_release_id
       WHERE j.kind = 'BACKPORT_SYNC'
         AND j.desired_state = 'RUNNING'
         AND j.state = 'QUEUED'
       ORDER BY j.created_at, j.id
       LIMIT 1`,
    )
  ).rows[0];
  if (!job) return;
  job.title_id = job.config?.titleId;
  if (await releaseBusy(db, job.release_id, job.id)) return;
  await runBackportSync(db, config, logs, job);
}
