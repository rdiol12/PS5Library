import { randomUUID } from 'node:crypto';
import { accessibleSource } from '../sources/access.js';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  uuid,
  buildFormats,
  profileSchema,
  releaseSchema,
  sha256,
} from '../../../shared/schemas/index.js';
import { transaction, type DB, type SQL } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { existingWithin, within } from '../security/paths.js';
import { fileHash } from '../downloads/stream.js';
import { runWorker } from '../library/inspect.js';
import { jobEvent } from './events.js';
import { backportFiles, profileHash } from '../library/backports.js';
import { quotaExceeded, requireDiskSpace, storageUsage } from '../storage/usage.js';
import {
  artifactBuildKey,
  buildInput,
  buildKey,
  builders,
  cachedBuildArtifact,
  packageBuildAllowed,
  preparationReservationBytes,
  profileInputHash,
  sameFileIdentity,
  suppliedCompatibilityMaterial,
} from './preparation.js';

const bodySchema = z.object({
  sourceReleaseId: uuid,
  method: z.enum(['FPKG', 'SHADOWMOUNT']),
  profileId: uuid.optional(),
});

type PreparationEnqueue = ReturnType<typeof createPreparationEnqueue>;
type StagedMove = { original: string; staged: string };
type StageDeletion = (
  relativePath: string,
  options?: { required?: boolean; recursive?: boolean },
) => Promise<void>;

const retirementFields =
  'source_id release_id type config content_id version title_id metadata'.split(' ');

const retirementFingerprint = (row: Record<string, unknown>) =>
  JSON.stringify(retirementFields.map((field) => row[field]));

async function restoreStagedMove(move?: StagedMove) {
  if (
    move &&
    !(await stat(move.original).catch(() => null)) &&
    (await stat(move.staged).catch(() => null))
  )
    await rename(move.staged, move.original);
}

async function loadProfile(sql: DB | SQL, id: string | undefined, userIds: string[]) {
  if (!id) return null;
  return (
    await sql.query(
      'SELECT profile FROM compatibility_profiles WHERE id=$1 AND user_id=ANY($2::uuid[])',
      [id, userIds],
    )
  ).rows[0]?.profile;
}

const hasRows = async (sql: DB | SQL, query: string, values: unknown[]) =>
  Boolean((await sql.query(query, values)).rowCount);

async function stagedDeletion<T>(
  db: DB,
  config: Config,
  operation: (sql: SQL, stage: StageDeletion) => Promise<T>,
) {
  let moved: (StagedMove & { recursive: boolean }) | undefined,
    committed = false;
  try {
    const result = await transaction(db, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const stage: StageDeletion = async (relativePath, options = {}) => {
        const candidate = within(config.DATA_DIR, path.join(config.DATA_DIR, relativePath)),
          present = await stat(candidate).catch(() => null);
        if (!present && !options.required) return;
        const original = await existingWithin(config.DATA_DIR, candidate),
          staged = within(config.DATA_DIR, `${original}.delete-${randomUUID()}`);
        await rename(original, staged);
        moved = { original, staged, recursive: options.recursive ?? false };
      };
      return operation(sql, stage);
    });
    committed = true;
    if (moved) await rm(moved.staged, { recursive: moved.recursive, force: true });
    return result;
  } catch (error) {
    if (!committed) await restoreStagedMove(moved);
    throw error;
  }
}

async function matchingBackport(
  sql: DB | SQL,
  releaseId: string,
  inputHashes: string[],
  profileFingerprint: string | null,
) {
  return (
    await sql.query(
      `SELECT id
       FROM backport_artifacts
       WHERE release_id = $1
         AND input_hash = ANY($2::text[])
         AND type = 'SHADOWMOUNT_FOLDER'
         AND deleted_at IS NULL
         AND (profile_hash = $3 OR profile_hash IS NULL)
       ORDER BY (profile_hash IS NOT NULL) DESC, created_at DESC
       LIMIT 1`,
      [releaseId, inputHashes, profileFingerprint],
    )
  ).rows[0]?.id as string | undefined;
}

async function verifiedPackage(
  sql: DB | SQL,
  releaseId: string,
  inputHash: string,
  cacheKey: string,
) {
  return (
    await sql.query(
      `SELECT *
       FROM artifacts
       WHERE release_id = $1
         AND format = 'pkg'
         AND profile_id IS NULL
         AND verified
         AND deleted_at IS NULL
         AND input_hash = $2
         AND cache_key = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [releaseId, inputHash, cacheKey],
    )
  ).rows[0];
}

async function exactBackport(
  sql: DB | SQL,
  releaseId: string,
  inputHashes: string[],
  profileId: string | undefined,
  profileFingerprint: string | null,
) {
  return (
    await sql.query(
      `SELECT *
       FROM backport_artifacts
       WHERE release_id = $1
         AND input_hash = ANY($2::text[])
         AND type = 'SHADOWMOUNT_FOLDER'
         AND profile_id = $3
         AND profile_hash = $4
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [releaseId, inputHashes, profileId, profileFingerprint],
    )
  ).rows[0];
}

async function retirementSource(sql: DB | SQL, id: string, userId: string, lock = false) {
  return (
    await sql.query(
      `SELECT sr.*, s.type, s.config, r.content_id, r.version, g.title_id
       FROM source_releases sr
       JOIN sources s ON s.id = sr.source_id
       JOIN game_releases r ON r.id = sr.release_id
       JOIN games g ON g.id = r.game_id
       WHERE sr.id = $1 AND s.user_id = $2
       ${lock ? 'FOR UPDATE OF sr' : ''}`,
      [id, userId],
    )
  ).rows[0];
}

async function sourceInUse(sql: DB | SQL, id: string) {
  return hasRows(
    sql,
    `SELECT 1 FROM jobs
     WHERE source_release_id=$1
       AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')
     UNION ALL
     SELECT 1 FROM installations
     WHERE source_release_id=$1
       AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')
     LIMIT 1`,
    [id],
  );
}

async function retirementAssets(
  db: DB,
  config: Config,
  row: Awaited<ReturnType<typeof retirementSource>>,
  source: z.infer<typeof releaseSchema>,
  sourcePath: string | null,
  profileId: string | undefined,
  userId: string,
) {
  const profile = profileId
      ? profileSchema.parse(await loadProfile(db, profileId, [userId]))
      : null,
    inputHash = profileInputHash(source);
  if (
    profile &&
    (profile.id !== profileId ||
      profile.titleId !== row.title_id ||
      profile.contentId !== row.content_id ||
      profile.gameVersion !== row.version ||
      profile.installationMethod !== 'FPKG' ||
      profile.testedState === 'UNKNOWN' ||
      !profile.inputHashes.includes(inputHash) ||
      (profile.delivery === 'OVERLAY' &&
        !profile.requiredLibraries.length &&
        !profile.requiredPatches.length &&
        !profile.requiredFiles.length))
  )
    throw new AppError('PROFILE_MISMATCH', 409);
  if (!profile && (await suppliedCompatibilityMaterial(sourcePath)))
    throw new AppError(
      'PROFILE_MISMATCH',
      409,
      'Select the exact compatibility profile before deleting a dump that contains backport files.',
    );

  const fingerprint = profile ? profileHash(profile) : null,
    packageKey = artifactBuildKey(source.sha256, 'FPKG', profile),
    artifact = await verifiedPackage(db, row.release_id, source.sha256, packageKey);
  if (!artifact || !artifact.builder_version?.endsWith(builders.FPKG))
    throw new AppError('FPKG_NOT_READY', 409);
  const identity = artifact.inspection?.identity;
  if (
    artifact.inspection?.metadataVerified !== true ||
    identity?.titleId !== row.title_id ||
    identity?.contentId !== row.content_id ||
    identity?.version !== row.version
  )
    throw new AppError('METADATA_MISMATCH', 409);

  const packageFile = await existingWithin(
      config.DATA_DIR,
      path.join(config.DATA_DIR, artifact.relative_path),
    ).catch(() => null),
    packageBefore = packageFile ? await stat(packageFile).catch(() => null) : null;
  if (
    !packageFile ||
    !packageBefore?.isFile() ||
    packageBefore.size !== artifact.size ||
    (await fileHash(packageFile)) !== artifact.sha256
  )
    throw new AppError('CACHE_CORRUPT', 409);
  const packageInspection = await runWorker([
      'inspect',
      packageFile,
      JSON.stringify({ titleId: row.title_id, contentId: row.content_id, version: row.version }),
    ]).catch(() => null),
    packageInfo = await stat(packageFile).catch(() => null);
  if (
    packageInspection?.format !== 'pkg' ||
    packageInspection.structurallyRecognized !== true ||
    packageInspection.metadataVerified !== true ||
    packageInspection.kind !== source.kind ||
    !packageInfo ||
    !sameFileIdentity(packageBefore, packageInfo)
  )
    throw new AppError('CACHE_CORRUPT', 409);

  const backport =
    !profile || profile.delivery === 'INTEGRATED'
      ? null
      : await exactBackport(db, row.release_id, profile.inputHashes, profileId, fingerprint);
  if (profile?.delivery === 'OVERLAY' && !backport)
    throw new AppError('BACKPORT_FILES_MISSING', 409);
  const verifiedBackport = profile
    ? await backportFiles(db, config, row.release_id, inputHash, profile)
    : null;
  if (
    verifiedBackport &&
    (verifiedBackport.needsPreparation ||
      (profile!.delivery === 'OVERLAY' && verifiedBackport.backportId !== backport.id))
  )
    throw new AppError('BACKPORT_FILES_MISMATCH', 409);
  return {
    profile,
    fingerprint,
    packageKey,
    artifact,
    packageFile,
    packageInfo,
    backport,
    backportResult: {
      backportId: backport?.id ?? null,
      tested: profile?.testedState === 'TESTED',
    },
  };
}

const markSourceRemoved = (sql: DB | SQL, id: string) =>
  sql.query(
    "UPDATE source_releases SET metadata=metadata||jsonb_build_object('sourceRemovedAt',COALESCE(metadata->'sourceRemovedAt',to_jsonb(now()))) WHERE id=$1",
    [id],
  );

function createPreparationEnqueue(db: DB, config: Config, reconcile: () => Promise<void>) {
  return async (userId: string, body: z.infer<typeof bodySchema>, automatic = false) => {
    if (!config.features.newDownloads) {
      if (automatic) return { skipped: true };
      throw new AppError('NEW_DOWNLOADS_DISABLED', 403);
    }
    const source = await accessibleSource(db, userId, body.sourceReleaseId);
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (
      !buildFormats.includes(source.metadata.format) ||
      (['folder', 'rar', '7z'].includes(source.metadata.format) &&
        !['LOCAL_FOLDER', 'WATCH_FOLDER'].includes(source.type))
    )
      throw new AppError(
        'UNSUPPORTED_INPUT',
        422,
        'Use local prepared folders, complete local RAR/7z sets, or ZIP archives.',
      );
    if (source.metadata.kind === 'DLC')
      throw new AppError(
        'UNSUPPORTED_INPUT',
        422,
        'Supplied DLC packages are cached directly and never rebuilt into the base game.',
      );
    const profile = body.profileId
      ? profileSchema.parse(await loadProfile(db, body.profileId, [userId, source.source_owner]))
      : null;
    const exactInputHash = profileInputHash(source.metadata),
      input = buildInput(source.metadata, body.method);
    if (
      profile &&
      (profile.titleId !== source.metadata.game.titleId ||
        profile.contentId !== source.metadata.game.contentId ||
        profile.gameVersion !== source.metadata.version ||
        !profile.inputHashes.includes(exactInputHash) ||
        profile.installationMethod !== body.method ||
        profile.testedState === 'UNKNOWN')
    )
      throw new AppError('PROFILE_MISMATCH', 409);
    const automaticInputHash = profile ? exactInputHash : input.sha256;
    if (
      automatic &&
      (await hasRows(
        db,
        'SELECT 1 FROM automatic_preparations WHERE source_release_id=$1 AND input_hash=$2 AND method=$3',
        [source.id, automaticInputHash, body.method],
      ))
    )
      return { skipped: true };
    const fingerprint = profile ? profileHash(profile) : null,
      key = buildKey(input.sha256, body.method, fingerprint),
      artifactKey = artifactBuildKey(input.sha256, body.method, profile);
    while (true) {
      const cached = await cachedBuildArtifact(
        db,
        config,
        source.release_id,
        source.metadata,
        body.method,
      );
      let filePresent = false,
        valid = false,
        ready = false,
        backportId: string | null = null,
        backportError: unknown;
      if (cached) {
        const file = path.join(config.DATA_DIR, cached.relative_path),
          fileStat = await stat(file).catch(() => null);
        filePresent = !!fileStat;
        valid = fileStat?.isFile() === true && fileStat.size === cached.size;
        ready = valid;
        if (valid && profile)
          try {
            const verified = await backportFiles(
              db,
              config,
              source.release_id,
              exactInputHash,
              profile,
            );
            ready = !verified.needsPreparation;
            backportId = verified.backportId;
          } catch (error) {
            if (error instanceof AppError && error.code === 'BACKPORT_FILES_MISSING') ready = false;
            else backportError = error;
            backportId =
              (await matchingBackport(db, source.release_id, profile.inputHashes, fingerprint)) ??
              null;
          }
      }
      const result = await transaction(db, async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const current = (
          await sql.query(
            'SELECT * FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified ORDER BY created_at DESC LIMIT 1',
            [source.release_id, artifactKey],
          )
        ).rows[0];
        if (
          !cached !== !current ||
          (cached &&
            current &&
            (cached.id !== current.id ||
              cached.relative_path !== current.relative_path ||
              cached.sha256 !== current.sha256 ||
              cached.size !== current.size))
        )
          return { retry: true as const };
        if (valid && profile) {
          const currentBackport =
            (await matchingBackport(sql, source.release_id, profile.inputHashes, fingerprint)) ??
            null;
          if (currentBackport !== backportId) return { retry: true as const };
        }
        if (
          automatic &&
          !(
            await sql.query(
              `INSERT INTO automatic_preparations(source_release_id, input_hash, method)
               VALUES($1, $2, $3)
               ON CONFLICT DO NOTHING
               RETURNING source_release_id`,
              [source.id, automaticInputHash, body.method],
            )
          ).rowCount
        )
          return { skipped: true };
        if (backportError) throw backportError;
        if (cached) {
          if (valid && ready) return { cached: true, artifactId: cached.id };
          if (!valid) {
            await sql.query('UPDATE artifacts SET verified=false WHERE id=$1', [cached.id]);
            if (filePresent)
              throw new AppError(
                'CACHE_CORRUPT',
                409,
                'Delete the changed cached file before preparing again.',
              );
          }
        }
        const role = (await sql.query('SELECT role FROM users WHERE id=$1 FOR UPDATE', [userId]))
          .rows[0]?.role as string | undefined;
        if (!packageBuildAllowed(role))
          throw new AppError(
            'ADMIN_REQUIRED',
            403,
            'Only an administrator can prepare a new package.',
          );
        if (source.metadata.retiredAt)
          throw new AppError(
            'SOURCE_RETIRED',
            409,
            'Restore this dump from quarantine before rebuilding it.',
          );
        const active = (
          await sql.query(
            `SELECT id
             FROM jobs
             WHERE user_id = $1
               AND source_release_id = $2
               AND kind = 'BUILD'
               AND config->>'cacheKey' = $3
               AND state NOT IN ('COMPLETED', 'ERROR', 'CANCELLED')`,
            [userId, source.id, key],
          )
        ).rows[0];
        if (active) return { id: active.id, cached: false };
        const patchGrowth =
          (profile?.requiredPatches.filter((p) => p.bps || p.sdk || p.outputFormat).length ?? 0) *
          65536;
        const reserve = preparationReservationBytes(
          source.metadata.format === 'folder'
            ? input.size
            : (source.metadata.installedSize ?? source.metadata.size * 8),
          patchGrowth,
          source.metadata.format,
          body.method,
        );
        if (!Number.isSafeInteger(reserve)) throw new AppError('INPUT_TOO_LARGE', 422);
        if (quotaExceeded(await storageUsage(sql), reserve, config.QUOTA_BYTES))
          throw new AppError('QUOTA_EXCEEDED', 409);
        await requireDiskSpace(
          path.join(config.DATA_DIR, 'jobs'),
          reserve + config.DISK_MARGIN_BYTES,
        );
        const id = randomUUID(),
          jobConfig = {
            sourceMetadata: source.metadata,
            sourceConfig: source.config,
            sourceType: source.type,
            sourceOwner: source.source_owner,
            method: body.method,
            cacheKey: key,
            reservedBytes: reserve,
            profile,
          };
        await sql.query(
          `INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,total_bytes,config)
           VALUES($1, $2, 'BUILD', $3, $4, 'QUEUED', $5, $6)`,
          [id, userId, source.release_id, source.id, input.size, jobConfig],
        );
        await jobEvent(sql, id);
        return { id, cached: false };
      });
      if ('retry' in result) continue;
      await reconcile();
      return result;
    }
  };
}

function registerPreparationEndpoints(
  app: FastifyInstance,
  db: DB,
  auth: Auth,
  enqueue: PreparationEnqueue,
) {
  app.post('/api/v1/preparations', async (req, reply) =>
    reply.code(202).send(await enqueue((await auth.user(req)).id, bodySchema.parse(req.body))),
  );
  app.post('/api/v1/device/preparations', async (req, reply) =>
    reply
      .code(202)
      .send(await enqueue((await auth.device(req)).user_id, bodySchema.parse(req.body))),
  );
  app.get(
    '/api/v1/artifacts',
    async (req) =>
      (
        await db.query(
          `SELECT
             a.id,
             a.format,
             a.size,
             a.sha256,
             a.verified,
             a.builder_version AS "builderVersion",
             a.created_at AS "createdAt",
             a.release_id AS "releaseId",
             g.title,
             r.version
           FROM artifacts a
           JOIN game_releases r ON r.id = a.release_id
           JOIN games g ON g.id = r.game_id
           WHERE g.user_id = $1
             AND a.deleted_at IS NULL
           ORDER BY a.created_at DESC`,
          [(await auth.user(req)).id],
        )
      ).rows,
  );
}

function registerSourceRetirementRoute(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  app.post('/api/v1/source-releases/:id/retire', async (req) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('ADMIN_REQUIRED', 403);
    if (!config.DUMP_ROOT) throw new AppError('DUMP_ROOT_NOT_CONFIGURED', 409);
    const id = uuid.parse((req.params as { id: string }).id),
      body = z
        .object({
          confirm: z.literal('RETIRE'),
          inputSha256: sha256,
          profileId: uuid.optional(),
          deleteSource: z.boolean().optional().default(false),
        })
        .strict()
        .parse(req.body);
    const fileState: {
      rollbackMove?: StagedMove;
      cleanup?: { dumpRoot: string; quarantine: string };
    } = {};
    let committed = false;
    try {
      const row = await retirementSource(db, id, user.id);
      if (!row) throw new AppError('NOT_FOUND', 404);
      if (row.type !== 'WATCH_FOLDER')
        throw new AppError('UNSUPPORTED_INPUT', 422, 'Only watched dump folders can be retired.');
      const source = releaseSchema.parse(row.metadata);
      if (body.inputSha256 !== source.sha256) throw new AppError('SOURCE_CHANGED', 409);
      if (row.metadata.retiredAt && (!body.deleteSource || row.metadata.sourceRemovedAt))
        return {
          ok: true,
          alreadyRetired: true,
          sourceDeleted: Boolean(row.metadata.sourceRemovedAt),
          quarantinePath: row.metadata.quarantinePath,
        };
      if (source.format !== 'folder' || source.location === '.')
        throw new AppError(
          'UNSUPPORTED_INPUT',
          422,
          'Only an individual watched dump folder can be retired.',
        );
      if (await sourceInUse(db, id)) throw new AppError('SOURCE_IN_USE', 409);
      const dumpRoot = await existingWithin(config.DUMP_ROOT, config.DUMP_ROOT),
        originalPath = within(dumpRoot, path.resolve(dumpRoot, source.location));
      if (originalPath === dumpRoot) throw new AppError('UNSAFE_PATH', 409);
      const quarantineRelative = path.posix.join('.ps5library-trash', id, 'input'),
        trashRoot = within(dumpRoot, path.join(dumpRoot, '.ps5library-trash')),
        quarantineParent = within(dumpRoot, path.join(trashRoot, id)),
        quarantine = within(dumpRoot, path.join(quarantineParent, 'input'));
      const [originalInfo, quarantineInfo] = await Promise.all([
        stat(originalPath).catch(() => null),
        stat(quarantine).catch(() => null),
      ]);
      if (originalInfo && quarantineInfo) throw new AppError('QUARANTINE_CONFLICT', 409);
      if (!originalInfo && !quarantineInfo && !row.metadata.retiredAt)
        throw new AppError('INPUT_NOT_FOUND', 404);
      if (originalInfo) await existingWithin(dumpRoot, originalPath);
      if (quarantineInfo) await existingWithin(dumpRoot, quarantine);
      const sourcePath = originalInfo ? originalPath : quarantineInfo ? quarantine : null,
        sourceInfo = originalInfo ?? quarantineInfo;
      const profileId = body.profileId,
        verified = await retirementAssets(db, config, row, source, sourcePath, profileId, user.id);
      const { profile, fingerprint, packageKey, artifact, backport } = verified;
      for (const folder of [trashRoot, quarantineParent]) {
        try {
          await mkdir(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const safe = await existingWithin(dumpRoot, folder);
        if (!(await stat(safe)).isDirectory()) throw new AppError('UNSAFE_PATH', 409);
      }
      if (!row.metadata.retiredAt) {
        const digest = await runWorker([
            'hash-base-tree',
            await existingWithin(dumpRoot, sourcePath!),
          ]),
          after = await stat(sourcePath!).catch(() => null);
        if (
          digest.sha256 !== source.sha256 ||
          digest.size !== source.size ||
          (source.sourceTreeSha256 && digest.sourceTreeSha256 !== source.sourceTreeSha256) ||
          (source.sourceTreeSize !== undefined && digest.sourceTreeSize !== source.sourceTreeSize)
        )
          throw new AppError('SOURCE_CHANGED', 409);
        if (!sourceInfo || !after || !sameFileIdentity(sourceInfo, after))
          throw new AppError('SOURCE_CHANGED', 409);
      }
      const rowState = retirementFingerprint(row);
      const result = await transaction(db, async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const current = await retirementSource(sql, id, user.id, true);
        if (!current || retirementFingerprint(current) !== rowState)
          throw new AppError('SOURCE_CHANGED', 409);
        if (await sourceInUse(sql, id)) throw new AppError('SOURCE_IN_USE', 409);
        const currentRawProfile = await loadProfile(sql, profileId, [user.id]);
        if (profile) {
          if (!currentRawProfile) throw new AppError('PROFILE_MISMATCH', 409);
          const currentProfile = profileSchema.parse(currentRawProfile);
          if (profileHash(currentProfile) !== fingerprint)
            throw new AppError('PROFILE_MISMATCH', 409);
        }
        const currentArtifact = await verifiedPackage(
          sql,
          row.release_id,
          source.sha256,
          packageKey,
        );
        if (
          !currentArtifact ||
          currentArtifact.id !== artifact.id ||
          currentArtifact.sha256 !== artifact.sha256 ||
          Number(currentArtifact.size) !== Number(artifact.size) ||
          currentArtifact.relative_path !== artifact.relative_path ||
          currentArtifact.builder_version !== artifact.builder_version ||
          JSON.stringify(currentArtifact.inspection) !== JSON.stringify(artifact.inspection)
        )
          throw new AppError('CACHE_CORRUPT', 409);
        const currentPackage = await stat(verified.packageFile).catch(() => null);
        if (!currentPackage || !sameFileIdentity(verified.packageInfo, currentPackage))
          throw new AppError('CACHE_CORRUPT', 409);
        const currentBackport =
          !profile || profile.delivery === 'INTEGRATED'
            ? null
            : await exactBackport(sql, row.release_id, profile.inputHashes, profileId, fingerprint);
        if (
          (currentBackport?.id ?? null) !== (backport?.id ?? null) ||
          (currentBackport &&
            backport &&
            (currentBackport.sha256 !== backport.sha256 ||
              Number(currentBackport.size) !== Number(backport.size) ||
              currentBackport.relative_path !== backport.relative_path))
        )
          throw new AppError('BACKPORT_FILES_MISMATCH', 409);
        const currentOriginal = await stat(originalPath).catch(() => null),
          currentQuarantine = await stat(quarantine).catch(() => null);
        if (
          Boolean(currentOriginal) !== Boolean(originalInfo) ||
          Boolean(currentQuarantine) !== Boolean(quarantineInfo) ||
          (currentOriginal && originalInfo && !sameFileIdentity(currentOriginal, originalInfo)) ||
          (currentQuarantine &&
            quarantineInfo &&
            !sameFileIdentity(currentQuarantine, quarantineInfo))
        )
          throw new AppError('SOURCE_CHANGED', 409);
        if (currentOriginal) await existingWithin(dumpRoot, originalPath);
        if (currentQuarantine) await existingWithin(dumpRoot, quarantine);
        if (!currentOriginal && !currentQuarantine) {
          if (body.deleteSource && current.metadata.retiredAt) {
            await markSourceRemoved(sql, id);
            return {
              ok: true,
              alreadyRetired: true,
              sourceDeleted: true,
              quarantinePath: quarantineRelative,
              artifactId: artifact.id,
              ...verified.backportResult,
            };
          }
          throw new AppError('INPUT_NOT_FOUND', 404);
        }
        if (currentOriginal) {
          await rename(originalPath, quarantine);
          fileState.rollbackMove = { original: originalPath, staged: quarantine };
        }
        if (!current.metadata.retiredAt) {
          await sql.query(
            "UPDATE source_releases SET metadata=metadata||jsonb_build_object('retiredAt',now(),'quarantinePath',$2::text) WHERE id=$1",
            [id, quarantineRelative],
          );
          const watchRoot = within(dumpRoot, path.resolve(dumpRoot, row.config.location)),
            observation = path.relative(watchRoot, originalPath).split(path.sep).join('/') || '.';
          await sql.query(
            "UPDATE source_observations SET state='RETIRED',error=NULL WHERE source_id=$1 AND path=$2",
            [row.source_id, observation],
          );
        }
        fileState.cleanup = { dumpRoot, quarantine };
        return {
          ok: true,
          sourceDeleted: false,
          quarantinePath: quarantineRelative,
          artifactId: artifact.id,
          ...verified.backportResult,
        };
      });
      committed = true;
      if (body.deleteSource && fileState.cleanup) {
        const pending = await stat(fileState.cleanup.quarantine).catch(() => null);
        if (pending)
          await rm(await existingWithin(fileState.cleanup.dumpRoot, fileState.cleanup.quarantine), {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          });
        await markSourceRemoved(db, id);
        return { ...result, sourceDeleted: true };
      }
      return result;
    } catch (error) {
      if (!committed) await restoreStagedMove(fileState.rollbackMove);
      throw error;
    }
  });
}

function registerArtifactDeletionRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  app.delete('/api/v1/backports/:id', async (req) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id);
    return stagedDeletion(db, config, async (sql, stage) => {
      const row = (
        await sql.query(
          `SELECT b.*
           FROM backport_artifacts b
           JOIN games g ON g.id = b.game_id
           WHERE b.id = $1
             AND g.user_id = $2
             AND b.type = 'SHADOWMOUNT_FOLDER'
             AND b.deleted_at IS NULL
           FOR UPDATE OF b`,
          [id, user.id],
        )
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      if (row.profile_id) throw new AppError('BACKPORT_IN_USE', 409);
      if (
        await hasRows(
          sql,
          `SELECT id
           FROM jobs
           WHERE config->'backport'->>'backportId' = $1
             AND state NOT IN ('COMPLETED', 'READY_ON_PS5', 'ERROR', 'CANCELLED')`,
          [id],
        )
      )
        throw new AppError('BACKPORT_IN_USE', 409);
      await stage(row.relative_path, { required: true, recursive: true });
      await sql.query('UPDATE backport_artifacts SET deleted_at=now() WHERE id=$1', [id]);
      return { ok: true, freedBytes: row.size };
    });
  });
  app.delete('/api/v1/artifacts/:id', async (req) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id);
    return stagedDeletion(db, config, async (sql, stage) => {
      const artifact = (
        await sql.query(
          `SELECT a.*
           FROM artifacts a
           JOIN game_releases r ON r.id = a.release_id
           JOIN games g ON g.id = r.game_id
           WHERE a.id = $1
             AND g.user_id = $2
             AND a.deleted_at IS NULL
           FOR UPDATE OF a`,
          [id, user.id],
        )
      ).rows[0];
      if (!artifact) throw new AppError('NOT_FOUND', 404);
      if (
        await hasRows(
          sql,
          "SELECT id FROM jobs WHERE artifact_id=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')",
          [id],
        )
      )
        throw new AppError('ARTIFACT_IN_USE', 409);
      await stage(artifact.relative_path);
      await sql.query('UPDATE artifacts SET verified=false,deleted_at=now() WHERE id=$1', [id]);
      await sql.query('DELETE FROM library_entries WHERE artifact_id=$1', [id]);
      return { ok: true, freedBytes: artifact.size };
    });
  });
}

export async function preparationRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  reconcile: () => Promise<void>,
) {
  const enqueue = createPreparationEnqueue(db, config, reconcile);
  registerPreparationEndpoints(app, db, auth, enqueue);
  registerSourceRetirementRoute(app, db, config, auth);
  registerArtifactDeletionRoutes(app, db, config, auth);
  return { enqueue };
}
