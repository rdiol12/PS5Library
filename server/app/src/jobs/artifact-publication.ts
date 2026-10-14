import { randomUUID, createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { uuid, profileSchema } from '../../../shared/schemas/index.js';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import { AppError } from '../security/errors.js';
import { existingWithin, within } from '../security/paths.js';
import { runWorker } from '../library/inspect.js';
import { jobEvent } from './events.js';
import { profileHash } from '../library/backports.js';
import { artifactStoragePath, releaseStorageFolder, safeStorageName } from '../storage/names.js';
import { throttleWorkerProgress } from '../worker-progress.js';

export const builders = {
  FPKG: '5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1',
  SHADOWMOUNT: 'b5307a60d5b4e3a68ba680e0e33cfadf05017c77',
};
export const buildKey = (sha: string, method: keyof typeof builders, profile?: string | null) =>
  createHash('sha256')
    .update(
      `pipeline-v8-playgo:${method}:${builders[method]}:${sha}${profile ? `:backport-v5:${profile}` : ''}`,
    )
    .digest('hex');
export const artifactBuildKey = (
  sha: string,
  method: keyof typeof builders,
  _profile?: z.infer<typeof profileSchema> | null,
) => buildKey(sha, method, null);
export const legacyFpkgBuilderVersion = builders.FPKG.split('+', 1)[0]!;
export const sameFileIdentity = (left: Stats, right: Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;
export const packageBuildAllowed = (role: string | undefined) => role === 'ADMIN';
export const transferArtifactUsable = (artifact: any) => {
  if (!artifact?.builder_version) return true;
  const method =
    artifact.format === 'pkg' ? 'FPKG' : artifact.format === 'ffpkg' ? 'SHADOWMOUNT' : null;
  if (method && artifact.cache_key === artifactBuildKey(artifact.input_hash, method)) return true;
  const image = artifact.inspection?.installedImage;
  return (
    artifact.format === 'pkg' &&
    !artifact.profile_id &&
    typeof artifact.builder_version === 'string' &&
    artifact.builder_version.endsWith(legacyFpkgBuilderVersion) &&
    artifact.inspection?.structurallyRecognized === true &&
    artifact.inspection?.metadataVerified === true &&
    Number.isSafeInteger(image?.size) &&
    image.size > 0 &&
    /^[0-9a-f]{64}$/.test(image?.sha256 ?? '')
  );
};
export const preparationReservationBytes = (
  size: number,
  patchGrowth: number,
  format: string,
  method: keyof typeof builders,
) =>
  format === 'folder' && method === 'FPKG'
    ? size + patchGrowth + 64 * 1024 ** 2
    : size * (format === 'folder' ? 4 : 5) + patchGrowth * 5 + 64 * 1024 ** 2;
export const profileInputHash = (source: any) => source.sourceTreeSha256 ?? source.sha256;
export const suppliedCompatibilityMaterial = async (root: string | null) =>
  root !== null &&
  (await readdir(root, { withFileTypes: true })).some(
    (entry) =>
      ['backport', 'backports', 'fakelib', 'fakelib2'].includes(entry.name.toLowerCase()) &&
      (entry.isFile() || entry.isSymbolicLink() || entry.isDirectory()),
  );
export const buildInput = (source: any, method: keyof typeof builders) =>
  source.format === 'folder' && method === 'SHADOWMOUNT'
    ? { sha256: profileInputHash(source), size: source.sourceTreeSize ?? source.size }
    : { sha256: source.sha256, size: source.size };
const artifactByCacheKey = async (
  sql: Pick<DB, 'query'>,
  releaseId: string,
  cacheKey: string | null,
  oldest = false,
) =>
  (
    await sql.query(
      `SELECT ${oldest ? 'id, relative_path, sha256, size' : '*'} FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified AND deleted_at IS NULL ORDER BY created_at ${oldest ? 'ASC' : 'DESC'} LIMIT 1`,
      [releaseId, cacheKey],
    )
  ).rows[0];

export async function ensurePublishDirectories(
  dataDir: string,
  row: Parameters<typeof releaseStorageFolder>[0],
  backport: boolean,
) {
  const directories = [
    path.join(dataDir, 'artifacts', releaseStorageFolder(row)),
    ...(backport ? [path.join(dataDir, 'backports', releaseStorageFolder(row))] : []),
  ];
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await access(directory, constants.W_OK);
    }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new AppError(
        'STORAGE_NOT_WRITABLE',
        500,
        'The configured server storage is not writable by the server container.',
      );
    throw error;
  }
}

export async function cachedBuildArtifact(
  db: DB,
  config: Config,
  releaseId: string,
  source: any,
  method: keyof typeof builders,
) {
  const inputHash = buildInput(source, method).sha256,
    cacheKey = artifactBuildKey(inputHash, method);
  const exact = await artifactByCacheKey(db, releaseId, cacheKey);
  if (
    exact ||
    method !== 'FPKG' ||
    source.format !== 'folder' ||
    !source.sourceTreeSha256 ||
    source.sourceTreeSha256 === source.sha256
  )
    return exact;
  const legacyKey = artifactBuildKey(source.sourceTreeSha256, 'FPKG'),
    legacy = (
      await db.query(
        `SELECT *
         FROM artifacts
         WHERE release_id = $1
           AND format = 'pkg'
           AND profile_id IS NULL
           AND input_hash = $2
           AND cache_key = $3
           AND verified
           AND deleted_at IS NULL
           AND right(builder_version, length($4)) = $4
         ORDER BY created_at DESC
         LIMIT 1`,
        [releaseId, source.sourceTreeSha256, legacyKey, builders.FPKG],
      )
    ).rows[0];
  if (!legacy) return null;
  const file = await existingWithin(
      config.DATA_DIR,
      path.join(config.DATA_DIR, legacy.relative_path),
    ).catch(() => null),
    before = file ? await stat(file).catch(() => null) : null;
  if (!before?.isFile() || before.size !== Number(legacy.size)) return null;
  return transaction(db, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(3150003)');
    const currentExact = await artifactByCacheKey(sql, releaseId, cacheKey);
    if (currentExact) return currentExact;
    const current = (
        await sql.query(
          `SELECT *
           FROM artifacts
           WHERE id = $1
             AND release_id = $2
             AND format = 'pkg'
             AND profile_id IS NULL
             AND input_hash = $3
             AND cache_key = $4
             AND verified
             AND deleted_at IS NULL
             AND right(builder_version, length($5)) = $5
           FOR UPDATE`,
          [legacy.id, releaseId, source.sourceTreeSha256, legacyKey, builders.FPKG],
        )
      ).rows[0],
      after = await stat(file!).catch(() => null);
    if (
      !current ||
      current.relative_path !== legacy.relative_path ||
      current.sha256 !== legacy.sha256 ||
      Number(current.size) !== Number(legacy.size) ||
      !after ||
      !sameFileIdentity(before, after)
    )
      return null;
    return (
      await sql.query('UPDATE artifacts SET input_hash=$2,cache_key=$3 WHERE id=$1 RETURNING *', [
        legacy.id,
        source.sha256,
        cacheKey,
      ])
    ).rows[0];
  });
}

export async function publishArtifact(db: DB, config: Config, row: any, result: any) {
  if (
    row.kind === 'BUILD' &&
    (result.libraryPolicy !== 'CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC' ||
      !result.builderVersion?.endsWith(builders[row.config.method as keyof typeof builders]))
  )
    throw new AppError(
      'WORKER_VERSION_MISMATCH',
      409,
      'Rebuild the package worker before preparing content.',
    );
  const applied = row.config.profile ? profileHash(row.config.profile) : null;
  if (
    (result.profileId ?? null) !== (row.config.profile?.id ?? null) ||
    (result.profileHash ?? null) !== applied
  )
    throw new AppError('PROFILE_NOT_APPLIED', 409);
  const cacheKey =
    row.kind === 'BUILD'
      ? artifactBuildKey(result.inputHash, row.config.method, row.config.profile)
      : (row.config.cacheKey ?? null);
  const relativePath = artifactStoragePath(row, result);
  const target = path.join(config.DATA_DIR, relativePath);
  const publishProgress = async (stage: string, completedBytes: number, totalBytes: number) => {
    const progress = {
      stage,
      completedStages: 6,
      totalStages: 7,
      operation: { completedBytes, totalBytes },
    };
    if (
      !(
        await db.query(
          `UPDATE jobs
           SET config = jsonb_set(config, '{progress}', $2::jsonb),
               speed_bytes_per_second = 0,
               eta_seconds = NULL,
               updated_at = now()
           WHERE id = $1
             AND desired_state = 'RUNNING'
           RETURNING id`,
          [row.id, JSON.stringify(progress)],
        )
      ).rowCount
    ) {
      const control = (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [row.id]))
        .rows[0];
      throw new AppError(control?.desired_state ?? 'CANCELLED');
    }
    await jobEvent(db, row.id);
  };
  const verifyFile = async (filename: string, size: number, sha: string, stage: string) => {
    const before = await stat(filename).catch(() => null);
    if (before?.size !== size) throw new AppError('CACHE_CORRUPT', 409);
    await publishProgress(stage, 0, size);
    const progress = throttleWorkerProgress((p) =>
      publishProgress(stage, p.operation?.completedBytes ?? 0, p.operation?.totalBytes ?? size),
    );
    const actual = await runWorker(['hash-file', filename], progress).catch((error) => {
      if (error instanceof AppError) throw error;
      return null;
    });
    const after = await stat(filename).catch(() => null);
    if (
      actual?.sha256 !== sha ||
      actual?.size !== size ||
      !after ||
      !sameFileIdentity(before, after)
    )
      throw new AppError('CACHE_CORRUPT', 409);
    return after;
  };
  const backport = result.shadowMountBackport
    ? (() => {
        const value = z
          .object({
            outputPath: z.string(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            size: z.number().int().nonnegative().safe(),
          })
          .parse(result.shadowMountBackport);
        const inputHash = z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .parse(
              row.config.sourceMetadata?.sourceTreeSha256 ??
                row.config.sourceMetadata?.sha256 ??
                result.inputHash,
            ),
          targetFirmware = safeStorageName(
            row.config.profile?.targetFirmware ?? 'Unknown firmware',
          ),
          appliedSuffix = applied ? `-${applied.slice(0, 12)}` : '',
          profileName = `Backport ${targetFirmware} [${inputHash.slice(0, 12)}${appliedSuffix}]`;
        const relative = path.posix.join('backports', releaseStorageFolder(row), profileName),
          destination = within(config.DATA_DIR, path.join(config.DATA_DIR, relative));
        return { ...value, inputHash, relative, destination };
      })()
    : null;
  while (true) {
    const artifact = await artifactByCacheKey(db, row.release_id, cacheKey, true);
    const artifactCheck = artifact
      ? {
          filename: path.join(config.DATA_DIR, artifact.relative_path),
          info: await verifyFile(
            path.join(config.DATA_DIR, artifact.relative_path),
            artifact.size,
            artifact.sha256,
            'Verifying cached package',
          ),
        }
      : null;
    const targetInfo = artifact ? null : await stat(target).catch(() => null),
      targetCheck = artifact
        ? null
        : targetInfo
          ? {
              info: await verifyFile(
                target,
                result.size,
                result.sha256,
                'Verifying published package',
              ),
              outputInfo: null,
            }
          : {
              info: null,
              outputInfo: await verifyFile(
                result.outputPath,
                result.size,
                result.sha256,
                'Verifying package for publish',
              ),
            };
    if (targetCheck && !targetCheck.info && targetCheck.outputInfo?.size !== result.size)
      throw new AppError('CACHE_CORRUPT', 409);
    let backportCheck: null | { source: string; info: Stats } = null;
    if (backport) {
      const existing = await stat(backport.destination).catch(() => null),
        source = existing
          ? backport.destination
          : await existingWithin(
              path.join(config.DATA_DIR, 'jobs', uuid.parse(row.id)),
              backport.outputPath,
            ),
        before = await stat(source);
      await publishProgress('Verifying compatibility files', 0, backport.size);
      const progress = throttleWorkerProgress((p) =>
        publishProgress(
          'Verifying compatibility files',
          p.operation?.completedBytes ?? 0,
          p.operation?.totalBytes ?? backport.size,
        ),
      );
      const actual = await runWorker(['hash-tree', source], progress),
        after = await stat(source).catch(() => null);
      if (
        actual.sha256 !== backport.sha256 ||
        actual.size !== backport.size ||
        !after ||
        !sameFileIdentity(before, after)
      )
        throw new AppError('CACHE_CORRUPT', 409);
      await publishProgress('Verifying compatibility files', backport.size, backport.size);
      backportCheck = { source, info: after };
    }
    const published = await transaction(db, async (sql) => {
      // ponytail: one short publish/delete/quota lock; partition by volume if throughput requires it.
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const control = (
        await sql.query('SELECT desired_state FROM jobs WHERE id=$1 FOR UPDATE', [row.id])
      ).rows[0];
      if (control?.desired_state !== 'RUNNING')
        throw new AppError(control?.desired_state ?? 'CANCELLED');
      const currentArtifact = await artifactByCacheKey(sql, row.release_id, cacheKey, true);
      if (
        !artifact !== !currentArtifact ||
        (artifact &&
          currentArtifact &&
          (artifact.id !== currentArtifact.id ||
            artifact.relative_path !== currentArtifact.relative_path ||
            artifact.sha256 !== currentArtifact.sha256 ||
            artifact.size !== currentArtifact.size))
      )
        return null;
      if (backport && backportCheck) {
        const current = await stat(backportCheck.source).catch(() => null);
        if (!current || !sameFileIdentity(current, backportCheck.info)) return null;
        if (backportCheck.source !== backport.destination) {
          if (await stat(backport.destination).catch(() => null)) return null;
          await mkdir(path.dirname(backport.destination), { recursive: true });
          await rename(backportCheck.source, backport.destination);
        }
        await sql.query(
          `INSERT INTO backport_artifacts(
             id,
             game_id,
             release_id,
             title_id,
             game_version,
             target_firmware,
             type,
             source,
             sha256,
             size,
             profile_id,
             tested,
             artifact_id,
             input_hash,
             relative_path,
             profile_hash
           )
           SELECT
             $1,
             r.game_id,
             r.id,
             g.title_id,
             r.version,
             $9,
             'SHADOWMOUNT_FOLDER',
             'DUMP',
             $3,
             $4,
             $7,
             false,
             NULL,
             $5,
             $6,
             $8
           FROM game_releases r
           JOIN games g ON g.id = r.game_id
           WHERE r.id = $2
           ON CONFLICT(relative_path) DO UPDATE SET deleted_at = NULL`,
          [
            randomUUID(),
            row.release_id,
            backport.sha256,
            backport.size,
            backport.inputHash,
            backport.relative,
            result.profileId ?? null,
            applied,
            row.config.profile?.targetFirmware ?? null,
          ],
        );
      }
      let publishedArtifact = currentArtifact;
      if (publishedArtifact) {
        const current = artifactCheck && (await stat(artifactCheck.filename).catch(() => null));
        if (!current || !artifactCheck || !sameFileIdentity(current, artifactCheck.info))
          return null;
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        if (targetCheck?.info) {
          const current = await stat(target).catch(() => null);
          if (!current || !sameFileIdentity(current, targetCheck.info)) return null;
        } else {
          if (await stat(target).catch(() => null)) return null;
          const output = await stat(result.outputPath).catch(() => null);
          if (
            !output ||
            !targetCheck?.outputInfo ||
            !sameFileIdentity(output, targetCheck.outputInfo)
          )
            throw new AppError('CACHE_CORRUPT', 409);
          await rename(result.outputPath, target);
        }
        publishedArtifact = (
          await sql.query(
            `INSERT INTO artifacts(
               id,
               release_id,
               format,
               relative_path,
               sha256,
               size,
               verified,
               inspection,
               input_hash,
               builder_version,
               cache_key,
               profile_id,
               profile_hash
             )
             VALUES($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11, $12)
             ON CONFLICT(relative_path) DO UPDATE SET
               verified = true,
               deleted_at = NULL,
               inspection = $7,
               input_hash = $8,
               builder_version = $9,
               cache_key = $10,
               profile_id = $11,
               profile_hash = $12
             RETURNING id`,
            [
              randomUUID(),
              row.release_id,
              result.format,
              relativePath,
              result.sha256,
              result.size,
              result.inspection,
              result.inputHash ?? result.sha256,
              result.builderVersion ?? null,
              cacheKey,
              null,
              null,
            ],
          )
        ).rows[0];
      }
      if (
        result.inspection.metadataVerified &&
        result.inspection.identity &&
        result.inspection.kind !== 'DLC' &&
        row.config.sourceMetadata?.kind !== 'DLC'
      ) {
        const identity = result.inspection.identity;
        const data = { titleId: identity.titleId, title: identity.title };
        await sql.query(
          `INSERT INTO metadata_records(id, game_id, provider, rank, data)
           SELECT $1, game_id, $2, 1, $3
           FROM game_releases
           WHERE id = $4
           ON CONFLICT(game_id, provider) DO UPDATE SET data = $3`,
          [randomUUID(), `inspection:${row.release_id}`, data, row.release_id],
        );
        await sql.query(
          'UPDATE games SET title=$2,metadata=metadata || $3::jsonb WHERE id=(SELECT game_id FROM game_releases WHERE id=$1)',
          [row.release_id, identity.title, data],
        );
      }
      const progress = {
        stage: 'Verified on server',
        completedStages: 7,
        totalStages: 7,
        package: { method: row.config.method, state: 'VERIFIED' },
        fakelib: { state: backport ? 'VERIFIED' : 'NOT_REQUIRED', size: backport?.size },
      };
      await sql.query(
        `UPDATE jobs
         SET state = 'COMPLETED',
             artifact_id = $2,
             downloaded_bytes = total_bytes,
             speed_bytes_per_second = 0,
             eta_seconds = 0,
             config = jsonb_set(config, '{progress}', $3::jsonb),
             updated_at = now()
         WHERE id = $1`,
        [row.id, publishedArtifact.id, JSON.stringify(progress)],
      );
      await sql.query(
        `INSERT INTO library_entries(user_id, release_id, artifact_id, state)
         VALUES($1, $2, $3, 'READY_ON_SERVER')
         ON CONFLICT(user_id, release_id) DO UPDATE SET
           artifact_id = $3,
           state = 'READY_ON_SERVER'`,
        [row.user_id, row.release_id, publishedArtifact.id],
      );
      await jobEvent(sql, row.id);
      return publishedArtifact.id as string;
    });
    if (published !== null) return published;
  }
}
