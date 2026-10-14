import { z } from 'zod';
import { queryOne, type DB } from '../db.js';
import type { Config } from '../config.js';
import { compatibility, planStorage, presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { buildKey, legacyFpkgBuilderVersion, transferArtifactUsable } from '../jobs/preparation.js';
import {
  backportFiles,
  backportNotice,
  backportMessages,
  profileHash,
} from '../library/backports.js';

const contentVersion = z.string().regex(/^\d{2}\.\d{3}\.\d{3}$/);
const backportStatuses = new Set(['MATCHING_BACKPORT_AVAILABLE', 'BACKPORT_UNTESTED']);
const backportFileStatuses = new Set([...backportStatuses, 'BACKPORT_RUNTIME_UNAVAILABLE']);

export const createTransferPlanner = (db: DB, config: Config) => {
  return async function plan(
    userId: string,
    releaseId: string,
    consoleId: string,
    artifactId?: string,
    preparation?: {
      format: string;
      size: number;
      sha256: string;
      baseSha256?: string;
      sourceTreeSha256?: string;
      cacheKey?: string;
    },
  ) {
    const targetConsole = await queryOne(
      db,
      "SELECT c.*,COALESCE(k.capabilities,'{}') AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2",
      [consoleId, userId],
    );
    const release = await queryOne(
      db,
      `SELECT r.*, g.title_id, g.user_id AS source_owner
         FROM game_releases r
         JOIN games g ON g.id=r.game_id
        WHERE r.id=$1
          AND EXISTS(
            SELECT 1 FROM game_content_access access
             WHERE access.game_id=g.id AND access.user_id=$2
          )`,
      [releaseId, userId],
    );
    if (!targetConsole || !release) throw new AppError('NOT_FOUND', 404);
    const requestedInputHash = artifactId
      ? null
      : (preparation?.sha256 ?? release.metadata.sha256 ?? null);
    let artifact = await queryOne(
      db,
      `SELECT * FROM artifacts
        WHERE release_id=$1 AND verified AND deleted_at IS NULL
          AND ($2::uuid IS NULL OR id=$2)
          AND ($3::text IS NULL OR format=$3)
          AND ($4::text IS NULL OR cache_key=$4)
          AND ($5::text IS NULL OR sha256=$5)
          AND ($6::text IS NULL OR COALESCE(input_hash,sha256)=$6)
        ORDER BY created_at DESC
        LIMIT 1`,
      [
        releaseId,
        artifactId ?? null,
        preparation?.format ?? null,
        preparation?.cacheKey ?? null,
        preparation && !preparation.cacheKey ? preparation.sha256 : null,
        requestedInputHash,
      ],
    );
    if (!artifact && !artifactId && preparation?.format === 'pkg')
      artifact = await queryOne(
        db,
        `SELECT * FROM artifacts
          WHERE release_id=$1 AND format='pkg' AND input_hash=$2
            AND right(builder_version,length($3))=$3
            AND profile_id IS NULL AND verified AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [releaseId, preparation.sha256, legacyFpkgBuilderVersion],
      );
    if (artifact && !transferArtifactUsable(artifact)) artifact = undefined;
    const profiles = (
      await db.query(
        'SELECT profile FROM compatibility_profiles WHERE user_id=ANY($1::uuid[]) AND title_id=$2 ORDER BY created_at DESC',
        [[userId, release.source_owner], release.title_id],
      )
    ).rows.map((p) => p.profile);
    const applicableProfiles = artifact?.profile_id
      ? profiles.filter((p) => p.id === artifact.profile_id)
      : profiles;
    // A builder may normalize metadata. Never lower the original dump's firmware requirement.
    const builtFirmware = artifact?.inspection?.identity?.minimumFirmware;
    const minimumFirmware =
      release.metadata.minimumFirmware &&
      builtFirmware &&
      Number(builtFirmware) > Number(release.metadata.minimumFirmware)
        ? builtFirmware
        : (release.metadata.minimumFirmware ?? null);
    const inputHash =
        preparation?.sha256 ?? artifact?.input_hash ?? artifact?.sha256 ?? release.metadata.sha256,
      baseInputHash = preparation?.baseSha256 ?? release.metadata.sha256,
      exactInputHash =
        preparation?.sourceTreeSha256 ?? release.metadata.sourceTreeSha256 ?? baseInputHash;
    const checkedRelease = {
      titleId: release.title_id,
      contentId: release.content_id,
      version: release.version,
      sha256: baseInputHash,
      sourceTreeSha256: exactInputHash,
      minimumFirmware,
      format: artifact?.format ?? preparation?.format ?? release.metadata.format,
    };
    const checkedConsole = {
      firmware: targetConsole.firmware,
      runtime: targetConsole.runtime,
      capabilities: targetConsole.capabilities,
      shadowMountFakelib: targetConsole.shadowmount_fakelib,
      standaloneBackPork: targetConsole.standalone_backpork,
      fakelibMode:
        targetConsole.runtime_status?.fakelibModes?.[release.title_id] ??
        targetConsole.runtime_status?.fakelibDefaultMode ??
        null,
    };
    const result = compatibility(checkedRelease, checkedConsole, applicableProfiles);
    const baseVersion =
      release.kind === 'UPDATE'
        ? contentVersion.safeParse(release.metadata?.baseContentVersion)
        : null;
    const baseContentVersion = baseVersion?.success ? baseVersion.data : null;
    const installedBase =
      baseContentVersion && release.version > baseContentVersion
        ? await queryOne(
            db,
            `SELECT e.storage_id
               FROM console_library_entries e
               JOIN game_releases installed ON installed.id=e.release_id
               JOIN games game ON game.id=installed.game_id
              WHERE e.console_id=$1 AND e.state='READY_ON_PS5' AND e.registered
                AND game.title_id=$2 AND installed.content_id=$3
                AND installed.version=$4
              ORDER BY e.updated_at DESC
              LIMIT 1`,
            [consoleId, release.title_id, release.content_id, baseContentVersion],
          )
        : null;
    if (
      result.method === 'FPKG' &&
      (!['BASE', 'UPDATE'].includes(release.kind) || !release.title_id.startsWith('PPSA'))
    )
      result.status = 'UNSUPPORTED_METHOD';
    if (release.kind === 'UPDATE' && !baseVersion?.success)
      result.status = 'UPDATE_BASE_VERSION_MISSING';
    else if (
      release.kind === 'UPDATE' &&
      (!installedBase || release.version <= baseContentVersion!)
    )
      result.status = 'UPDATE_BASE_NOT_INSTALLED';
    if (targetConsole.firmware_request_id) result.status = 'FIRMWARE_REFRESH_PENDING';
    let backport: Awaited<ReturnType<typeof backportFiles>> | null = null;
    if (result.profileId && backportFileStatuses.has(result.status)) {
      const candidates = applicableProfiles
        .map((p) => ({ profile: p, match: compatibility(checkedRelease, checkedConsole, [p]) }))
        .filter((p) => backportFileStatuses.has(p.match.status))
        .sort(
          (left, right) =>
            Number(right.profile.testedState === 'TESTED') -
            Number(left.profile.testedState === 'TESTED'),
        );
      const failures: string[] = [];
      for (const candidate of candidates)
        try {
          backport = await backportFiles(
            db,
            config,
            releaseId,
            exactInputHash,
            candidate.profile,
            false,
          );
          Object.assign(result, candidate.match);
          if (backport.needsPreparation) artifact = undefined;
          break;
        } catch (error) {
          if (
            preparation &&
            error instanceof AppError &&
            error.code === 'BACKPORT_FILES_MISSING' &&
            candidate.profile.id &&
            (
              await db.query(
                "SELECT 1 FROM jobs WHERE release_id=$1 AND kind='BUILD' AND desired_state='RUNNING' AND state NOT IN ('COMPLETED','ERROR','CANCELLED') AND config->'profile'->>'id'=$2 LIMIT 1",
                [releaseId, candidate.profile.id],
              )
            ).rowCount
          ) {
            backport = {
              profile: candidate.profile,
              profileHash: profileHash(candidate.profile),
              backportId: null,
              files: [],
              size: 0,
              needsPreparation: true,
              placement: 'SCAN_PATH' as const,
            };
            Object.assign(result, candidate.match, { status: 'BACKPORT_PREPARING' });
            artifact = undefined;
            break;
          }
          if (error instanceof z.ZodError) failures.push('PROFILE_MISMATCH');
          else if (error instanceof AppError) failures.push(error.code);
          else throw error;
        }
      if (!backport)
        result.status = failures.includes('BACKPORT_FILES_MISMATCH')
          ? 'BACKPORT_FILES_MISMATCH'
          : (failures[0] ?? 'BACKPORT_NO_MATCH');
    }
    if (!result.backportRequired && artifact?.profile_id) {
      const format = artifact.format;
      artifact = await queryOne(
        db,
        `SELECT * FROM artifacts
          WHERE release_id=$1 AND COALESCE(input_hash,sha256)=$2 AND format=$3
            AND profile_id IS NULL AND verified AND deleted_at IS NULL
            AND ($4::uuid IS NULL OR id=$4)
          ORDER BY created_at DESC
          LIMIT 1`,
        [releaseId, inputHash, format, artifactId ?? null],
      );
      if (
        artifact?.builder_version &&
        ['pkg', 'ffpkg'].includes(artifact.format) &&
        artifact.cache_key !==
          buildKey(inputHash, artifact.format === 'pkg' ? 'FPKG' : 'SHADOWMOUNT', null)
      )
        artifact = undefined;
    }
    const compatible =
      result.status === 'NATIVE_COMPATIBLE' ||
      result.status === 'BACKPORT_PREPARING' ||
      backportStatuses.has(result.status);
    const transferable =
      compatible ||
      (result.method === 'FPKG' && result.status === 'BACKPORT_RUNTIME_UNAVAILABLE' && !!backport);
    const context = `${targetConsole.firmware}:${targetConsole.runtime}:${exactInputHash}`;
    await backportNotice(db, userId, consoleId, releaseId, result.status, context);
    if (transferable)
      await db.query(
        'UPDATE console_notices SET resolved_at=now() WHERE console_id=$1 AND release_id=$2 AND code=ANY($3::text[]) AND code<>$4 AND resolved_at IS NULL',
        [consoleId, releaseId, Object.keys(backportMessages), result.status],
      );
    const lastSeen = targetConsole.last_seen ? new Date(targetConsole.last_seen).getTime() : null;
    const online = presence(lastSeen) === 'ONLINE';
    const overlayBytes = backport?.placement === 'SCAN_PATH' ? backport.size : 0;
    const packageBytes = artifact?.size ?? preparation?.size ?? release.metadata.size ?? 0;
    const components = {
      game: release.kind === 'UPDATE' ? 0 : packageBytes,
      update: release.kind === 'UPDATE' ? packageBytes : 0,
      backport: overlayBytes,
      temporary: packageBytes + overlayBytes,
      margin: config.DISK_MARGIN_BYTES,
    };
    const volumes = (
      await db.query(
        'SELECT * FROM console_storage_volumes WHERE console_id=$1 AND (writable OR jsonb_array_length(methods)>0) ORDER BY display_name,storage_id',
        [consoleId],
      )
    ).rows;
    const internal = volumes.filter((s) => s.path === '/data' || s.path === '/user');
    const internalDestination = internal.find((s) => s.methods.includes(result.method ?? ''));
    const storage = volumes
      .filter((s) => !internalDestination || !internal.includes(s) || s === internalDestination)
      .map((s) => {
        const destination = planStorage(
            { freeBytes: s.free_bytes, writable: s.writable, installMethodsSupported: s.methods },
            result.method ?? '',
            components,
          ),
          needsStage = result.method === 'FPKG' && s.path === '/mnt/ext0';
        const stage = needsStage
          ? volumes.find(
              (candidate) => candidate.path === '/user' && candidate.methods.includes('FPKG'),
            )
          : null;
        const staging = stage
          ? planStorage(
              {
                freeBytes: stage.free_bytes,
                writable: stage.writable,
                installMethodsSupported: stage.methods,
              },
              'FPKG',
              components,
            )
          : null;
        const updateStorageAllowed =
          release.kind !== 'UPDATE' || s.storage_id === installedBase?.storage_id;
        return {
          storageId: s.storage_id,
          displayName: s === internalDestination ? 'Internal Storage' : s.display_name,
          ...destination,
          allowed:
            updateStorageAllowed &&
            destination.allowed &&
            (!needsStage || staging?.allowed === true),
          reason: !updateStorageAllowed
            ? 'UPDATE_STORAGE_MISMATCH'
            : (destination.reason ??
              (needsStage && !stage
                ? 'INTERNAL_STAGING_UNAVAILABLE'
                : staging?.reason
                  ? `INTERNAL_STAGING_${staging.reason}`
                  : null)),
          stagingStorageId: stage?.storage_id ?? null,
          stagingRequiredBytes: staging?.requiredBytes ?? 0,
          stagingFreeBytes: stage?.free_bytes ?? 0,
        };
      });
    return {
      compatibility: result,
      online,
      artifactId: artifact?.id ?? null,
      baseContentVersion,
      backportRequired: result.backportRequired,
      backportArtifactId: backport?.backportId ?? null,
      backport,
      components,
      storage,
      firmware: targetConsole.firmware,
      runtime: targetConsole.runtime,
      compatible,
      transferable,
      allowed: !!artifact && online && transferable,
      message:
        result.status === 'BACKPORT_PREPARING'
          ? 'Compatibility files are being prepared with the package.'
          : (backportMessages[result.status] ?? null),
      reason: !transferable
        ? result.status
        : !artifact
          ? 'PREPARE_ON_SERVER_FIRST'
          : !online
            ? 'CONSOLE_OFFLINE'
            : result.status,
    };
  };
};
