import { sourceLocation } from '../sources/access.js';
import { mkdir, stat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { profileSchema } from '../../../shared/schemas/index.js';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { AppError } from '../security/errors.js';
import { within } from '../security/paths.js';
import { sourceHeaders } from '../sources/connectors.js';
import { downloadFile } from '../downloads/stream.js';
import { runWorker } from '../library/inspect.js';
import { jobEvent } from './events.js';
import { quotaMaximum } from '../storage/usage.js';
import { throttleWorkerProgress } from '../worker-progress.js';
import {
  buildInput,
  cachedBuildArtifact,
  ensurePublishDirectories,
  publishArtifact,
} from './artifact-publication.js';
export * from './artifact-publication.js';

export async function prepare(db: DB, config: Config, row: any) {
  const source = row.config.sourceMetadata;
  const expected = buildInput(source, row.config.method);
  const root = path.join(config.DATA_DIR, 'jobs', row.id);
  await mkdir(root, { recursive: true });
  const setStage = async (state: string, progress?: object) => {
    const changed = await db.query(
      `UPDATE jobs
       SET state = $2,
           config = jsonb_set(config, '{progress}', $3),
           speed_bytes_per_second = 0,
           updated_at = now()
       WHERE id = $1
         AND desired_state = 'RUNNING'
       RETURNING id`,
      [
        row.id,
        state,
        JSON.stringify(progress ?? { stage: state, completedStages: 0, totalStages: 7 }),
      ],
    );
    if (!changed.rowCount) {
      const control = (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [row.id]))
        .rows[0];
      throw new AppError(control?.desired_state ?? 'CANCELLED');
    }
    await jobEvent(db, row.id);
  };
  await db.query('UPDATE jobs SET attempts=attempts+1,error=NULL WHERE id=$1', [row.id]);
  if (row.attempts > 0)
    await rm(within(config.DATA_DIR, path.join(root, 'output')), { recursive: true, force: true });
  const [local, location] = await sourceLocation(
    config,
    row.config.sourceType,
    row.config.sourceOwner ?? row.user_id,
    source.location,
  );
  const identity = { titleId: row.title_id, contentId: row.content_id, version: row.version };
  let input = location;
  if (source.format !== 'folder' && !local) {
    input = path.join(root, 'content.part');
    await setStage('DOWNLOADING');
    await downloadFile({
      location,
      local,
      partPath: input,
      size: source.size,
      sha256: source.sha256,
      privateOrigins: config.privateOrigins,
      headers: sourceHeaders(row.config.sourceConfig, location),
      margin: config.DISK_MARGIN_BYTES,
      progress: async (p) => {
        await setStage('DOWNLOADING');
        await db.query(
          'UPDATE jobs SET downloaded_bytes=$2,speed_bytes_per_second=$3,eta_seconds=$4 WHERE id=$1',
          [row.id, p.downloadedBytes, p.speedBytesPerSecond, p.etaSeconds],
        );
        await jobEvent(db, row.id);
      },
      onVerify: () =>
        setStage('VERIFYING', { stage: 'Verifying source', completedStages: 1, totalStages: 7 }),
    });
  }
  const profileArgs: string[] = [];
  const profile = row.config.profile ? profileSchema.parse(row.config.profile) : null;
  await ensurePublishDirectories(config.DATA_DIR, row, profile?.delivery === 'OVERLAY');
  if (profile) {
    const file = path.join(root, 'profile.json');
    await writeFile(file, JSON.stringify(profile));
    profileArgs.push(file);
  }
  const cached =
    profile?.delivery === 'OVERLAY' && source.format === 'folder' && row.config.method === 'FPKG'
      ? await cachedBuildArtifact(db, config, row.release_id, source, 'FPKG')
      : null;
  const cachedFile = cached ? path.join(config.DATA_DIR, cached.relative_path) : null,
    cachedInfo = cachedFile ? await stat(cachedFile).catch(() => null) : null;
  const overlay =
    cached && cachedInfo?.isFile() && cachedInfo.size === Number(cached.size)
      ? await runWorker(
          [
            'build-backport',
            input,
            path.join(root, 'output'),
            row.config.method,
            JSON.stringify(identity),
            source.sha256,
            ...profileArgs,
          ],
          throttleWorkerProgress((p) => setStage('BUILDING', p)),
        )
      : null;
  const result = overlay
    ? {
        ...overlay,
        outputPath: cachedFile,
        format: cached.format,
        sha256: cached.sha256,
        size: Number(cached.size),
        builderVersion: cached.builder_version,
        releaseId: row.release_id,
        createdAt: new Date().toISOString(),
        inspection: cached.inspection,
        libraryPolicy: 'CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC',
      }
    : source.format === 'folder'
      ? await runWorker(
          [
            'build-verified',
            input,
            path.join(root, 'output'),
            row.config.method,
            JSON.stringify(identity),
            row.release_id,
            expected.sha256,
            String(expected.size),
            ...profileArgs,
          ],
          throttleWorkerProgress((p) => setStage('BUILDING', p)),
        )
      : await runWorker(
          [
            'build-archive',
            input,
            path.join(root, 'output'),
            row.config.method,
            JSON.stringify(identity),
            row.release_id,
            source.sha256,
            String(quotaMaximum(source.installedSize ?? source.size * 8, config.QUOTA_BYTES)),
            ...profileArgs,
          ],
          throttleWorkerProgress((p) =>
            setStage(p.stage === 'Extracting archive' ? 'EXTRACTING' : 'BUILDING', p),
          ),
        );
  await publishArtifact(db, config, row, result);
  await rm(within(config.DATA_DIR, root), { recursive: true, force: true });
}
