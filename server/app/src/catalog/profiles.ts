import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import {
  buildFormats,
  firmware,
  profileSchema,
  uuid,
  type CompatibilityProfile,
} from '../../../shared/schemas/index.js';
import { accessibleSource, localSourceRoot } from '../sources/access.js';
import { AppError } from '../security/errors.js';
import { existingWithin } from '../security/paths.js';
import {
  deterministicProfileFailures,
  profileDiscoveryContext,
  profileHash,
} from '../library/backports.js';
import { runWorker } from '../library/inspect.js';
import { quotaMaximum } from '../storage/usage.js';

export async function resolveSuccessfulProfileNotices(
  db: DB,
  scope: { releaseId: string; consoleIds: string[] },
  targetFirmware: string,
  runtime: string,
  inputHash: string,
) {
  if (!scope.consoleIds.length) return;
  const context = `${targetFirmware}:${runtime}:${inputHash}`;
  const codes = [
    'BACKPORT_NOT_INDEXED',
    'BACKPORT_NO_MATCH',
    'UNSUPPORTED_INPUT',
    'ENCRYPTED_INPUT',
    'INCOMPLETE_INPUT',
    'MISSING_ARCHIVE_PART',
    'CORRUPT_INPUT',
    'INPUT_TOO_LARGE',
    'SOURCE_CHANGED',
    'PROFILE_GENERATION_FAILED',
    'BACKPORT_TARGET_UNVERIFIED',
    'PROFILE_MISMATCH',
  ];
  await db.query(
    `UPDATE console_notices
     SET resolved_at = now()
     WHERE release_id = $1
     AND console_id = ANY($2::uuid[])
     AND resolved_at IS NULL
     AND context = ANY($3::text[])
     AND code = ANY($4::text[])`,
    [
      scope.releaseId,
      scope.consoleIds,
      [context, `profile-v3:${context}`, `profile-v4:${context}`],
      codes,
    ],
  );
}
export const retryProfileAfterArtifact = (
  prior: { state: string; updated_at: string | Date } | undefined,
  artifact: { created_at: string | Date } | undefined,
) =>
  !!prior &&
  ['ERROR', 'CANCELLED'].includes(prior.state) &&
  !!artifact &&
  new Date(artifact.created_at).getTime() > new Date(prior.updated_at).getTime();
type ProfileRequest = {
  sourceReleaseId: string;
  targetFirmware: string;
  runtime: string;
  installationMethod: 'FPKG' | 'SHADOWMOUNT';
};

async function insertProfile(db: DB, userId: string, id: string, profile: CompatibilityProfile) {
  await db.query(
    `INSERT INTO compatibility_profiles(
       id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      userId,
      profile.titleId,
      profile.contentId,
      profile.gameVersion,
      profile.targetFirmware,
      profile.runtime,
      profile,
    ],
  );
}

export function createProfileService(db: DB, config: Config) {
  return async (
    userId: string,
    body: ProfileRequest,
    template?: z.infer<typeof profileSchema>,
    failureCache?: { releaseId: string; consoleIds: string[] },
  ) => {
    const source = await accessibleSource(db, userId, body.sourceReleaseId);
    if (source.source_owner !== userId) throw new AppError('NOT_FOUND', 404);
    if (source.metadata.retiredAt)
      throw new AppError(
        'SOURCE_RETIRED',
        409,
        'Restore this dump from quarantine before generating another profile.',
      );
    const profileInputHash = source.metadata.sourceTreeSha256 ?? source.metadata.sha256;
    let input: string | undefined,
      explicitBackport = false;
    if (
      buildFormats.includes(source.metadata.format) &&
      ['LOCAL_FOLDER', 'WATCH_FOLDER'].includes(source.type)
    ) {
      const root = localSourceRoot(config, source.type, source.source_owner);
      input = await existingWithin(root, path.resolve(root, source.metadata.location));
      if (source.metadata.format === 'folder') {
        const candidate = path.join(input, 'backport'),
          info = await stat(candidate).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
        if (info) {
          await existingWithin(input, candidate);
          if (!info.isDirectory()) throw new AppError('UNSAFE_PATH', 409);
          explicitBackport = true;
        }
      }
    }
    const existing = (
      await db.query(
        `SELECT id, profile
         FROM compatibility_profiles
         WHERE user_id=$1 AND title_id=$2 AND content_id=$3 AND game_version=$4
         AND target_firmware=$5 AND runtime=$6
         AND profile->>'installationMethod' = $7
         AND profile->'inputHashes' ? $8
         AND profile->>'testedState' <> 'UNKNOWN'
         AND (
           profile->>'delivery' = 'INTEGRATED'
           OR jsonb_array_length(profile->'requiredLibraries')
              + jsonb_array_length(profile->'requiredPatches')
              + jsonb_array_length(COALESCE(profile->'requiredFiles','[]'::jsonb)) > 0
         )
         AND (
           NOT $9::boolean
           OR jsonb_array_length(COALESCE(profile->'requiredFiles','[]'::jsonb)) > 0
         )
         ORDER BY (profile->>'testedState' = 'TESTED') DESC, created_at DESC
         LIMIT 1`,
        [
          userId,
          source.metadata.game.titleId,
          source.metadata.game.contentId,
          source.metadata.version,
          body.targetFirmware,
          body.runtime,
          body.installationMethod,
          profileInputHash,
          explicitBackport,
        ],
      )
    ).rows[0];
    if (existing) {
      if (failureCache)
        await resolveSuccessfulProfileNotices(
          db,
          failureCache,
          body.targetFirmware,
          body.runtime,
          profileInputHash,
        );
      return { ...existing, reusable: false };
    }
    if (failureCache && !explicitBackport) {
      const context = profileDiscoveryContext(body.targetFirmware, body.runtime, profileInputHash),
        failure = (
          await db.query(
            `SELECT code FROM console_notices
             WHERE release_id=$1 AND console_id=ANY($2::uuid[]) AND context=$3
             AND resolved_at IS NULL
             AND code = ANY($4::text[])
             ORDER BY created_at DESC LIMIT 1`,
            [
              failureCache.releaseId,
              failureCache.consoleIds,
              context,
              deterministicProfileFailures,
            ],
          )
        ).rows[0];
      if (failure) throw new AppError(failure.code, 409);
    }
    if (
      !buildFormats.includes(source.metadata.format) ||
      !['LOCAL_FOLDER', 'WATCH_FOLDER'].includes(source.type)
    )
      throw new AppError(
        'UNSUPPORTED_INPUT',
        422,
        'Automatic profile discovery requires an owned prepared folder or archive.',
      );
    if (!input) {
      const root = localSourceRoot(config, source.type, source.source_owner);
      input = await existingWithin(root, path.resolve(root, source.metadata.location));
    }
    const identity = {
      titleId: source.metadata.game.titleId,
      contentId: source.metadata.game.contentId,
      version: source.metadata.version,
      title: source.metadata.game.title,
      minimumFirmware: source.metadata.minimumFirmware,
    };
    let raw: unknown = template
      ? {
          ...template,
          id: undefined,
          installationMethod: body.installationMethod,
          testedState: 'UNTESTED',
        }
      : undefined;
    if (!raw && source.metadata.format === 'folder')
      raw = await runWorker([
        'generate-backport-profile',
        input,
        JSON.stringify(identity),
        body.targetFirmware,
        body.runtime,
        body.installationMethod,
        profileInputHash,
      ]);
    else if (!raw) {
      const staging = path.join(config.DATA_DIR, 'jobs', `profile-${randomUUID()}`),
        maximum = quotaMaximum(
          source.metadata.installedSize ?? source.metadata.size * 8,
          config.QUOTA_BYTES,
        );
      await mkdir(path.dirname(staging), { recursive: true });
      try {
        raw = await runWorker([
          'generate-backport-profile-archive',
          input,
          path.join(staging, 'extracted'),
          JSON.stringify(identity),
          body.targetFirmware,
          body.runtime,
          body.installationMethod,
          profileInputHash,
          String(maximum),
        ]);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const generated = profileSchema.parse(raw);
    if (!generated.inputHashes.includes(profileInputHash))
      throw new AppError('SOURCE_CHANGED', 409);
    const id = randomUUID(),
      profile = {
        ...generated,
        inputHashes: [...new Set([source.metadata.sha256, profileInputHash])],
        id,
      };
    profileHash(profile);
    await insertProfile(db, userId, id, profile);
    if (failureCache)
      await resolveSuccessfulProfileNotices(
        db,
        failureCache,
        body.targetFirmware,
        body.runtime,
        profileInputHash,
      );
    return { id, profile, reusable: true };
  };
}

export type CreateProfile = ReturnType<typeof createProfileService>;

export function registerProfileRoutes(
  app: FastifyInstance,
  db: DB,
  auth: Auth,
  createProfile: CreateProfile,
) {
  app.get('/api/v1/profiles', async (req) =>
    (
      await db.query('SELECT id,profile FROM compatibility_profiles WHERE user_id=$1', [
        (await auth.user(req)).id,
      ])
    ).rows.map((r) => ({ ...r.profile, id: r.id })),
  );
  app.post('/api/v1/profiles/generate', async (req, reply) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('ADMIN_REQUIRED', 403);
    const body = z
      .object({
        sourceReleaseId: uuid,
        targetFirmware: firmware,
        runtime: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        installationMethod: z.enum(['FPKG', 'SHADOWMOUNT']),
      })
      .parse(req.body);
    const { id, profile } = await createProfile(user.id, body);
    return reply.code(201).send({ id, profile });
  });
  app.post('/api/v1/profiles', async (req, reply) => {
    const user = await auth.user(req),
      profile = profileSchema.parse(req.body),
      id = randomUUID(),
      stored = { ...profile, id };
    profileHash(stored);
    await insertProfile(db, user.id, id, stored);
    return reply.code(201).send({ id });
  });
}
