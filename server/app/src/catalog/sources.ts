import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import {
  buildFormats,
  releaseSchema,
  sourceSchema,
  uuid,
  type CompatibilityProfile,
  type Release,
  type SourceConfig,
} from '../../../shared/schemas/index.js';
import { connector } from '../sources/connectors.js';
import { discoverWatched, watchedMedia } from '../sources/watch.js';
import { localSourceRoot } from '../sources/access.js';
import { storeTrailer } from '../artwork/trailers.js';
import { AppError } from '../security/errors.js';
import {
  existingWithin,
  fileHandleHash,
  readFileWithin,
  regularFileWithin,
} from '../security/paths.js';
import { resolveMetadata } from '../library/policy.js';
import { backportNotice, profileDiscoveryContext } from '../library/backports.js';
import { runWorker } from '../library/inspect.js';
import { cacheArtwork, fetchArtwork } from '../artwork/cache.js';
import { retryProfileAfterArtifact, type CreateProfile } from './profiles.js';

export type PrepareRelease = (
  userId: string,
  body: {
    sourceReleaseId: string;
    method: 'FPKG' | 'SHADOWMOUNT';
    profileId?: string;
  },
  automatic?: boolean,
) => Promise<unknown>;

export type DownloadRelease = (
  userId: string,
  sourceId: string,
  automatic?: boolean,
) => Promise<unknown>;

type SourceSyncDependencies = {
  db: DB;
  config: Config;
  createProfile: CreateProfile;
  prepare: PrepareRelease;
  download: DownloadRelease;
};

type SourceSyncContext = SourceSyncDependencies & {
  source: { id: string; type: SourceConfig['type']; config: SourceConfig };
  userId: string;
  consoles: {
    id: string;
    firmware: string;
    runtime: string;
    capabilities: Record<string, boolean>;
  }[];
  artworkErrors: string[];
  preparationErrors: string[];
};

type PublishedRelease = {
  gameId: string;
  releaseId: string;
  sourceReleaseId: string;
  release: Release;
};

type BackportTarget = {
  targetFirmware: string;
  runtime: string;
  methods: Map<'FPKG' | 'SHADOWMOUNT', string[]>;
};

const errorCode = (error: unknown, fallback: string) =>
  error instanceof AppError ? error.code : fallback;

function recordPreparationError(
  context: SourceSyncContext,
  title: string,
  error: unknown,
  fallback = 'PREPARATION_FAILED',
) {
  const code = errorCode(error, fallback);
  context.preparationErrors.push(`${title}: ${code}`);
  return code;
}

async function notifyBackportFailure(
  context: SourceSyncContext,
  published: PublishedRelease,
  target: BackportTarget,
  consoleIds: string[],
  code: string,
) {
  await Promise.all(
    consoleIds.map((consoleId) =>
      backportNotice(
        context.db,
        context.userId,
        consoleId,
        published.releaseId,
        code,
        profileDiscoveryContext(
          target.targetFirmware,
          target.runtime,
          published.release.sourceTreeSha256 ?? published.release.sha256,
        ),
      ),
    ),
  );
}

async function importMedia(
  context: SourceSyncContext,
  gameId: string,
  sourceReleaseId: string,
  release: Release,
  kind: 'music' | 'trailer',
  media: { file: string; format: string } | null | undefined,
) {
  const { db, config, artworkErrors } = context;
  if (!media) return;
  let checked;
  try {
    checked = await regularFileWithin(config.DUMP_ROOT, media.file, 'r');
    const size = checked.info.size;
    if (size > (kind === 'music' ? 32 : 512) * 1024 ** 2) throw new AppError('MEDIA_SIZE_LIMIT');
    const sha256 = await fileHandleHash(checked.handle);
    await storeTrailer(
      db,
      config,
      gameId,
      checked.handle.createReadStream({ start: 0, autoClose: false }),
      size,
      { sourceReleaseId, sha256 },
      kind,
      media.format,
    );
  } catch (e) {
    artworkErrors.push(
      `${release.game.title}: ${e instanceof AppError ? e.code : kind.toUpperCase() + '_IMPORT_FAILED'}`,
    );
  } finally {
    await checked?.handle.close();
  }
}

async function storeReleases(context: SourceSyncContext, releases: Release[]) {
  const { db, source, userId } = context;
  const artwork: {
    gameId: string;
    releaseId: string;
    sourceReleaseId: string;
    release: Release;
  }[] = [];
  const rank = source.type === 'WATCH_FOLDER' ? 1 : 3;
  await transaction(db, async (sql) => {
    for (const release of releases) {
      const existing = (
        await sql.query('SELECT * FROM games WHERE user_id=$1 AND title_id=$2', [
          userId,
          release.game.titleId,
        ])
      ).rows[0];
      const previous = (
        await sql.query(
          `SELECT r.* FROM source_releases sr
           JOIN game_releases r ON r.id = sr.release_id
           WHERE sr.source_id = $1 AND sr.source_key = $2`,
          [source.id, release.key],
        )
      ).rows[0];
      if (
        previous &&
        previous.content_id === release.game.contentId &&
        previous.version === release.version &&
        previous.kind !== release.kind
      ) {
        await sql.query('UPDATE game_releases SET kind=$2 WHERE id=$1', [
          previous.id,
          release.kind,
        ]);
        if (release.kind === 'DLC')
          await sql.query(
            "DELETE FROM metadata_records WHERE game_id=$1 AND (data->>'contentId'=$2 OR provider=$3)",
            [previous.game_id, previous.content_id, `inspection:${previous.id}`],
          );
      }
      const records = existing
        ? (
            await sql.query('SELECT rank,data FROM metadata_records WHERE game_id=$1', [
              existing.id,
            ])
          ).rows
        : [];
      // DLC identity belongs to the release; its name/content ID cannot replace the base game's metadata.
      const observed =
        release.kind === 'DLC' && !records.length
          ? (
              await sql.query(
                `SELECT o.details->'identity' AS identity FROM source_observations o
                 JOIN sources s ON s.id = o.source_id
                 WHERE s.user_id=$1 AND o.details->>'titleId'=$2 AND o.details ? 'archive'
                 ORDER BY o.changed_at DESC LIMIT 1`,
                [userId, release.game.titleId],
              )
            ).rows[0]?.identity
          : null;
      const metadata =
        release.kind === 'DLC'
          ? records.length
            ? resolveMetadata(records)
            : observed
              ? { ...release.game, ...observed }
              : { ...release.game, title: release.game.titleId }
          : resolveMetadata([...records, { rank, data: release.game }]);
      const gameId = existing?.id ?? randomUUID();
      await sql.query(
        `INSERT INTO games(id,user_id,title_id,title,metadata,shared)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(user_id, title_id)
         DO UPDATE SET title = $4, metadata = $5`,
        [
          gameId,
          userId,
          release.game.titleId,
          metadata.title,
          metadata,
          source.config.shareCatalog ?? false,
        ],
      );
      const { game, location, ...normalized } = release;
      normalized.title = release.title ?? release.game.title;
      const r = (
        await sql.query(
          `INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT(game_id, content_id, version, kind)
           DO UPDATE SET metadata = $6
           RETURNING id`,
          [randomUUID(), gameId, game.contentId, release.version, release.kind, normalized],
        )
      ).rows[0];
      const sr = (
        await sql.query(
          `INSERT INTO source_releases(id,source_id,release_id,source_key,metadata)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(source_id, source_key)
           DO UPDATE SET release_id=$3, metadata=CASE
               WHEN source_releases.metadata ? 'retiredAt' AND
                 (NOT (source_releases.metadata ? 'sourceMissingAt') OR
                  source_releases.metadata ? 'sourceRemovedAt')
               THEN source_releases.metadata
               ELSE $5
             END
           RETURNING id`,
          [randomUUID(), source.id, r.id, release.key, release],
        )
      ).rows[0];
      if (release.kind !== 'DLC')
        await sql.query(
          `INSERT INTO metadata_records(id,game_id,provider,rank,data)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(game_id, provider)
           DO UPDATE SET data = $5, rank = $4`,
          [randomUUID(), gameId, `source:${source.id}`, rank, game],
        );
      artwork.push({
        gameId,
        releaseId: r.id,
        sourceReleaseId: sr.id,
        release,
      });
    }
    await sql.query('UPDATE sources SET last_synced=now(),error=NULL WHERE id=$1', [source.id]);
  });
  return artwork;
}

async function cacheReleaseMedia(
  context: SourceSyncContext,
  published: PublishedRelease,
  trailers: Map<string, string>,
  musicFiles: Map<string, { file: string; format: string }>,
) {
  const { db, config, source, userId, artworkErrors } = context;
  const { gameId, sourceReleaseId, release } = published;
  const art = release.kind === 'DLC' ? undefined : release.game.artwork;
  if (
    release.kind !== 'DLC' &&
    release.format === 'pkg' &&
    ['LOCAL_FOLDER', 'WATCH_FOLDER'].includes(source.type) &&
    (!art?.cover || !art?.icon || !art?.hero)
  ) {
    const stage = path.join(config.DATA_DIR, 'artwork', '.staging', randomUUID());
    try {
      const sourceRoot = localSourceRoot(config, source.type, userId),
        input = await existingWithin(sourceRoot, path.resolve(sourceRoot, release.location));
      await mkdir(stage, { recursive: true });
      const embedded = await runWorker(['extract-pkg-artwork', input, stage]);
      if (embedded.icon) {
        const bytes = await readFileWithin(stage, path.resolve(embedded.icon));
        if (!art?.icon) await cacheArtwork(db, config, gameId, bytes, 'icon');
        if (!art?.cover) await cacheArtwork(db, config, gameId, bytes, 'cover');
      }
      if (embedded.hero && !art?.hero)
        await cacheArtwork(
          db,
          config,
          gameId,
          await readFileWithin(stage, path.resolve(embedded.hero)),
          'hero',
        );
    } catch {
      artworkErrors.push(`${release.game.title}: embedded package artwork unavailable`);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  const entries = [
    ['cover', art?.cover],
    ['hero', art?.hero],
    ['icon', art?.icon],
    ...(art?.screenshots ?? []).map((value, i) => [`screenshot-${i}`, value]),
  ];
  for (const [kind, location] of entries)
    if (kind && location)
      try {
        const localRoot =
          source.type === 'WATCH_FOLDER'
            ? path.resolve(config.DUMP_ROOT)
            : source.type === 'LOCAL_FOLDER'
              ? path.resolve(localSourceRoot(config, source.type, userId), source.config.location)
              : undefined;
        const resolved =
          localRoot || /^https?:/.test(location)
            ? location
            : new URL(location, source.config.location).href;
        await cacheArtwork(
          db,
          config,
          gameId,
          await fetchArtwork(config, resolved, localRoot),
          kind,
        );
      } catch {
        artworkErrors.push(`${release.game.title}: ${kind} unavailable`);
      }
  const trailer = trailers.get(release.key);
  await importMedia(
    context,
    gameId,
    sourceReleaseId,
    release,
    'trailer',
    trailer ? { file: trailer, format: 'mov' } : null,
  );
  await importMedia(
    context,
    gameId,
    sourceReleaseId,
    release,
    'music',
    musicFiles.get(release.key),
  );
}

async function prepareRelease(
  context: SourceSyncContext,
  published: PublishedRelease,
  prepareAutomatically: boolean,
) {
  const { db, source, userId, consoles, createProfile, prepare, download } = context;
  const { releaseId, sourceReleaseId, release } = published;
  const profiledMethods = new Set<string>();
  if (prepareAutomatically && source.config.autoPrepare) {
    const methods: ('FPKG' | 'SHADOWMOUNT')[] =
      source.config.autoPrepare === 'BOTH' ? ['FPKG', 'SHADOWMOUNT'] : [source.config.autoPrepare];
    if (
      release.kind !== 'DLC' &&
      buildFormats.includes(release.format) &&
      /^\d{1,2}\.\d{2}$/.test(release.minimumFirmware ?? '')
    ) {
      const required = Number(release.minimumFirmware!.replace('.', ''));
      const targets = new Map<string, BackportTarget>();
      for (const console of consoles)
        for (const method of methods) {
          const target = Number(String(console.firmware).replace('.', '')),
            capabilities = console.capabilities ?? {};
          if (
            !Number.isInteger(target) ||
            target >= required ||
            (method === 'FPKG' && !capabilities.fpkgInstall) ||
            (method === 'SHADOWMOUNT' &&
              (!capabilities.shadowMount || !capabilities.backportOverlay))
          )
            continue;
          const key = `${console.firmware}:${console.runtime}`,
            known = targets.get(key) ?? {
              targetFirmware: console.firmware,
              runtime: console.runtime,
              methods: new Map<'FPKG' | 'SHADOWMOUNT', string[]>(),
            };
          known.methods.set(method, [...(known.methods.get(method) ?? []), console.id]);
          targets.set(key, known);
        }
      for (const target of targets.values()) {
        let template: CompatibilityProfile | undefined;
        for (const [method, consoleIds] of target.methods) {
          let generated: Awaited<ReturnType<typeof createProfile>>;
          try {
            generated = await createProfile(
              userId,
              {
                sourceReleaseId,
                targetFirmware: target.targetFirmware,
                runtime: target.runtime,
                installationMethod: method,
              },
              template,
              {
                releaseId,
                consoleIds: [...target.methods.values()].flat(),
              },
            );
          } catch (error) {
            const code = recordPreparationError(
              context,
              release.game.title,
              error,
              'PROFILE_GENERATION_FAILED',
            );
            await notifyBackportFailure(
              context,
              published,
              target,
              [...target.methods.values()].flat(),
              code,
            );
            break;
          }
          if (generated.reusable) template = generated.profile;
          try {
            const prior = (
              await db.query(
                `SELECT state,updated_at FROM jobs
                 WHERE source_release_id=$1 AND config->'profile'->>'id'=$2
                 AND config->>'method'=$3 ORDER BY created_at DESC LIMIT 1`,
                [sourceReleaseId, generated.id, method],
              )
            ).rows[0];
            const artifact =
              prior && ['ERROR', 'CANCELLED'].includes(prior.state)
                ? (
                    await db.query(
                      `SELECT created_at FROM artifacts
                       WHERE release_id=$1 AND format=$2 AND verified AND deleted_at IS NULL
                       ORDER BY created_at DESC LIMIT 1`,
                      [releaseId, method === 'FPKG' ? 'pkg' : 'ffpkg'],
                    )
                  ).rows[0]
                : undefined;
            const scheduled = !prior || retryProfileAfterArtifact(prior, artifact);
            if (scheduled)
              await prepare(userId, {
                sourceReleaseId,
                method,
                profileId: generated.id,
              });
            if (scheduled || !['ERROR', 'CANCELLED'].includes(prior.state))
              profiledMethods.add(method);
          } catch (error) {
            const code = recordPreparationError(context, release.game.title, error);
            await notifyBackportFailure(context, published, target, consoleIds, code);
          }
        }
      }
    }
    const remaining = buildFormats.includes(release.format)
      ? methods
          .filter((method) => !profiledMethods.has(method))
          .map((method) => () => prepare(userId, { sourceReleaseId, method }, true))
      : [() => download(userId, sourceReleaseId, true)];
    for (const operation of remaining)
      try {
        await operation();
      } catch (error) {
        recordPreparationError(context, release.game.title, error);
      }
  }
}

async function publishReleases(
  context: SourceSyncContext,
  releases: Release[],
  prepareAutomatically = true,
) {
  const trailers = new Map<string, string>();
  const musicFiles = new Map<string, { file: string; format: string }>();
  if (context.source.type === 'WATCH_FOLDER')
    for (let i = 0; i < releases.length; i++) {
      const media = await watchedMedia(context.config, releases[i]!);
      releases[i] = media.release;
      if (media.trailer) trailers.set(media.release.key, media.trailer);
      if (media.music) musicFiles.set(media.release.key, media.music);
    }
  for (const published of await storeReleases(context, releases)) {
    await cacheReleaseMedia(context, published, trailers, musicFiles);
    await prepareRelease(context, published, prepareAutomatically);
  }
}

async function syncOne(dependencies: SourceSyncDependencies, userId: string, id: string) {
  const { db, config } = dependencies;
  const source = (await db.query('SELECT * FROM sources WHERE id=$1 AND user_id=$2', [id, userId]))
    .rows[0];
  if (!source) throw new AppError('NOT_FOUND', 404);
  try {
    const userConfig = {
      ...config,
      SOURCE_ROOT: path.join(config.SOURCE_ROOT, userId),
    };
    const artworkErrors: string[] = [],
      preparationErrors: string[] = [];
    const consoles = source.config.autoPrepare
      ? (
          await db.query(
            `SELECT c.id,c.firmware,c.runtime,
                 COALESCE(k.capabilities, '{}') AS capabilities FROM consoles c
               LEFT JOIN console_capabilities k ON k.console_id = c.id
               WHERE c.user_id=$1 AND c.firmware IS NOT NULL AND c.runtime<>'unknown'`,
            [userId],
          )
        ).rows
      : [];
    const context: SourceSyncContext = {
      ...dependencies,
      source,
      userId,
      consoles,
      artworkErrors,
      preparationErrors,
    };
    // Media has its own identity/hash; importing it does not reverify or rebuild the full dump.
    if (source.type === 'WATCH_FOLDER')
      for (const known of (
        await db.query(
          `SELECT sr.id,sr.metadata,r.game_id FROM source_releases sr
             JOIN game_releases r ON r.id = sr.release_id
             WHERE sr.source_id=$1 AND NOT (sr.metadata ? 'retiredAt') AND r.kind<>'DLC'
             ORDER BY sr.id LIMIT 500`,
          [source.id],
        )
      ).rows) {
        try {
          const release = releaseSchema.parse(known.metadata);
          const media = await watchedMedia(config, release);
          await importMedia(context, known.game_id, known.id, release, 'music', media.music);
          await importMedia(
            context,
            known.game_id,
            known.id,
            release,
            'trailer',
            media.trailer ? { file: media.trailer, format: 'mov' } : null,
          );
        } catch (e) {
          if (e instanceof AppError && e.code === 'METADATA_MISMATCH') throw e;
          artworkErrors.push('Existing title media is unavailable');
        }
      }
    const watched =
      source.type === 'WATCH_FOLDER'
        ? await discoverWatched(db, config, source, (release, automatic) =>
            publishReleases(context, [release], automatic),
          )
        : null;
    const releases = watched?.releases ?? (await connector(source.config, userConfig).discover());
    if (!watched) await publishReleases(context, releases);
    const errors = [
      ...preparationErrors,
      ...(watched?.errors ?? []).map((e) => `${e.path}: ${e.error}`),
    ];
    await db.query('UPDATE sources SET last_synced=now(),error=$2 WHERE id=$1', [
      source.id,
      errors.length ? errors.join('; ').slice(0, 4000) : null,
    ]);
    return {
      discovered: releases.length,
      artworkErrors,
      preparationErrors,
      inspectionErrors: watched?.errors ?? [],
    };
  } catch (error) {
    await db.query('UPDATE sources SET error=$2 WHERE id=$1', [
      source.id,
      error instanceof AppError ? error.code : 'SOURCE_SYNC_FAILED',
    ]);
    throw error;
  }
}

function createSourceSynchronizer(dependencies: SourceSyncDependencies) {
  const scans = new Map<string, Promise<unknown>>();
  return {
    sync(userId: string, id: string) {
      const key = `${userId}:${id}`;
      if (scans.has(key)) return scans.get(key)!;
      const pending = syncOne(dependencies, userId, id).finally(() => scans.delete(key));
      scans.set(key, pending);
      return pending;
    },
    wait: () => Promise.allSettled(scans.values()),
  };
}

export function registerSourceRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  createProfile: CreateProfile,
  prepare: PrepareRelease,
  download: DownloadRelease,
) {
  app.get('/api/v1/sources', async (req) => {
    const user = await auth.user(req);
    return (
      await db.query(
        `SELECT id,name,type,last_synced,error,
           config->>'autoPrepare' AS "autoPrepare",
           config->'shareCatalog' AS "shareCatalog",
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'path',o.path, 'state',o.state, 'error',o.error, 'details',o.details
            )), '[]') FROM source_observations o WHERE o.source_id=s.id) AS observations
         FROM sources s WHERE user_id=$1 ORDER BY name`,
        [user.id],
      )
    ).rows;
  });
  app.post('/api/v1/sources', async (req, reply) => {
    const user = await auth.user(req),
      source = sourceSchema.parse(req.body),
      id = randomUUID();
    if (source.tokenEnv && user.role !== 'ADMIN')
      throw new AppError('ADMIN_CREDENTIAL_CONFIGURATION_REQUIRED', 403);
    if (
      (source.type === 'WATCH_FOLDER' || source.shareCatalog || source.autoPrepare) &&
      user.role !== 'ADMIN'
    )
      throw new AppError('ADMIN_REQUIRED', 403);
    if (
      ['LOCAL_FOLDER', 'WATCH_FOLDER'].includes(source.type) &&
      (path.isAbsolute(source.location) || source.location.split(/[\\/]/).includes('..'))
    )
      throw new AppError('UNSAFE_PATH');
    if (source.type === 'WATCH_FOLDER' && !config.DUMP_ROOT)
      throw new AppError('DUMP_ROOT_NOT_CONFIGURED', 409);
    await db.query('INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,$3,$4,$5)', [
      id,
      user.id,
      source.name,
      source.type,
      source,
    ]);
    return reply.code(201).send({ id });
  });
  const synchronizer = createSourceSynchronizer({ db, config, createProfile, prepare, download });
  app.post('/api/v1/sources/:id/sync', async (req) =>
    synchronizer.sync((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)),
  );
  let scanning = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      if (config.DUMP_ROOT)
        await transaction(db, async (sql) => {
          await sql.query('SELECT pg_advisory_xact_lock(3150007)');
          const owner = (
            await sql.query("SELECT id FROM users WHERE role='ADMIN' ORDER BY created_at LIMIT 1")
          ).rows[0];
          if (
            owner &&
            !(
              await sql.query(
                "SELECT id FROM sources WHERE type='WATCH_FOLDER' AND config->>'location'='.'",
              )
            ).rowCount
          )
            await sql.query(
              "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Watched games','WATCH_FOLDER',$3)",
              [
                randomUUID(),
                owner.id,
                sourceSchema.parse({
                  name: 'Watched games',
                  type: 'WATCH_FOLDER',
                  location: '.',
                  scanIntervalMinutes: 1,
                  autoPrepare: config.DUMP_AUTO_PREPARE,
                  shareCatalog: true,
                }),
              ],
            );
        });
      const due = (
        await db.query(
          `UPDATE sources SET next_scan_at=now()
             + ((config->>'scanIntervalMinutes')::int * interval '1 minute')
           WHERE id IN (
             SELECT id FROM sources WHERE config ? 'scanIntervalMinutes'
             AND next_scan_at<=now() ORDER BY next_scan_at LIMIT 5 FOR UPDATE SKIP LOCKED
           )
           RETURNING id, user_id`,
        )
      ).rows;
      for (const source of due) {
        await synchronizer.sync(source.user_id, source.id).catch(() => {});
        await db.query(
          `UPDATE sources SET next_scan_at=now()
             + ((config->>'scanIntervalMinutes')::int * interval '1 minute')
           WHERE id=$1 AND config ? 'scanIntervalMinutes'`,
          [source.id],
        );
      }
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(
    () => void scan().catch((e) => console.error('Source scan:', e.code ?? e.name)),
    10000,
  );
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await synchronizer.wait();
    while (scanning) await new Promise((resolve) => setTimeout(resolve, 50));
  });
}
