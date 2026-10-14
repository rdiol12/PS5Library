import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { queryOne, queryRows, transaction, type DB } from '../db.js';
import { presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { fileHandleHash, regularFile, within } from '../security/paths.js';
import type { Logger } from '../logging.js';
import {
  bytes,
  localUserId,
  saveDirectory,
  savePlatform,
  sha256,
  titleId,
  uploadChunk,
  uuid,
} from '../../../shared/schemas/index.js';
import { communitySaveManifestSchema } from '../../../shared/schemas/community.js';
import { validatePortableSaveArchive } from '../../../shared/saves/portable.js';
import { quotaExceeded, requireDiskSpace, storageUsage } from '../storage/usage.js';
import { approvedMasterCredential, approvedMasterUserCredential, masterRequest } from './routes.js';
import { consoleSaveData } from '../consoles/save-data.js';
import { appendUpload, resumeUpload } from '../storage/upload.js';
import { registerSaveImportRoutes, saveFailure as failure } from './save-import-routes.js';
import { requireUpdate, serveSave, type RequireInstalledVersion } from './shared.js';

const version = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/);
const exportRequest = z
  .object({
    localUserId,
    platform: savePlatform,
    gameTitleId: titleId,
    saveTitleId: titleId,
    directory: saveDirectory,
    gameVersion: version,
    region: version.optional(),
  })
  .strict();
const start = z
  .object({
    totalBytes: bytes.min(1).max(8 * 1024 ** 3),
    sha256,
    manifest: communitySaveManifestSchema,
  })
  .strict();
const terms = z
  .object({
    accepted: z.literal(true),
    termsVersion: z.string().min(1).max(40),
    termsSha256: sha256,
  })
  .strict();
const publication = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).default(''),
  })
  .strict();
const catalogRequest = z.object({ consoleId: uuid, gameTitleId: titleId, gameVersion: version });
const masterTerms = z.object({
  version: z.string().min(1).max(40),
  sha256,
  body: z.string().min(40).max(50_000),
  acceptLabel: z.string().min(1).max(300),
});
const masterCatalog = z
  .object({
    gameTitleId: titleId,
    versions: z.array(
      z
        .object({
          gameVersion: version,
          saves: z.array(
            z
              .object({
                id: uuid,
                platform: z.enum(['PS4', 'PS5']),
                gameTitleId: titleId,
                saveTitleId: titleId,
                gameVersion: version,
                region: z.string().nullable(),
                displayName: z.string(),
                description: z.string(),
                sha256,
                size: bytes.min(1).max(8 * 1024 ** 3),
                publisher: z.string(),
                createdAt: z.string().or(z.date()),
                downloadUrl: z.string(),
                manifest: communitySaveManifestSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
function exactCatalog(
  catalog: z.infer<typeof masterCatalog>,
  gameTitleId: string,
  gameVersion: string,
) {
  if (catalog.gameTitleId !== gameTitleId) throw new AppError('MASTER_METADATA_MISMATCH', 502);
  for (const group of catalog.versions) {
    if (group.gameVersion !== gameVersion) throw new AppError('MASTER_METADATA_MISMATCH', 502);
    for (const item of group.saves) {
      const manifest = item.manifest;
      if (
        item.gameTitleId !== gameTitleId ||
        item.gameVersion !== gameVersion ||
        item.downloadUrl !== `/api/v1/saves/${item.id}/archive` ||
        manifest.platform !== item.platform ||
        manifest.gameTitleId !== item.gameTitleId ||
        manifest.saveTitleId !== item.saveTitleId ||
        manifest.gameVersion !== item.gameVersion ||
        manifest.archiveSha256 !== item.sha256 ||
        manifest.archiveSize !== item.size ||
        manifest.compatibility.gameVersion !== item.gameVersion
      )
        throw new AppError('MASTER_METADATA_MISMATCH', 502);
    }
  }
  return catalog;
}
const part = (config: Config, id: string) =>
    path.join(config.DATA_DIR, 'portable-saves', '.staging', `${id}.part`),
  relative = (userId: string, id: string, digest: string) =>
    path.join('portable-saves', userId, `${id}-${digest}.ps5save`);
const view = (row: any) => ({
  id: row.id,
  origin: row.origin,
  consoleId: row.console_id,
  localUserId: row.local_user_id,
  platform: row.platform,
  gameTitleId: row.game_title_id,
  saveTitleId: row.save_title_id,
  directory: row.directory,
  gameVersion: row.game_version,
  region: row.region,
  state: row.state,
  totalBytes: row.total_bytes,
  uploadedBytes: row.uploaded_bytes,
  sha256: row.sha256,
  fileCount: row.file_count,
  manifest: row.manifest,
  displayName: row.display_name,
  description: row.description,
  masterPublicationId: row.master_publication_id,
  masterState: row.master_state,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  downloadUrl: row.state === 'READY' ? `/api/v1/portable-saves/${row.id}/download` : null,
});

async function failArchive(
  db: DB,
  id: string,
  error: string,
  status: number,
  staging?: string,
): Promise<never> {
  if (staging) await rm(staging, { force: true });
  await db.query(
    "UPDATE portable_save_archives SET state='ERROR',error=$2,updated_at=now() WHERE id=$1",
    [id, error],
  );
  throw new AppError(error, status);
}

function registerSaveExportRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  requireInstalledVersion: RequireInstalledVersion,
) {
  app.post('/api/v1/consoles/:id/saves/exports', async (req, reply) => {
    const user = await auth.user(req),
      consoleId = uuid.parse((req.params as { id: string }).id),
      body = exportRequest.parse(req.body);
    const source = await consoleSaveData(
      db,
      user.id,
      consoleId,
      body.localUserId,
      body.platform,
      body.gameTitleId,
      body.saveTitleId,
      body.directory,
    );
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (source.capabilities.saveExport !== true)
      throw new AppError(
        'CAPABILITY_UNAVAILABLE',
        409,
        'This agent has not reported portable save export support.',
      );
    if (presence(source.last_seen ? new Date(source.last_seen).getTime() : null) !== 'ONLINE')
      throw new AppError('CONSOLE_OFFLINE', 409);
    await requireInstalledVersion(consoleId, user.id, source.game_title_id, body.gameVersion);
    const id = randomUUID();
    await db.query(
      `INSERT INTO portable_save_archives(
         id,user_id,origin,console_id,local_user_id,platform,game_title_id,
         save_title_id,directory,game_version,region,source_modified_at,state
       ) VALUES(
         $1,$2,'EXPORT',$3,$4,$5,$6,$7,$8,$9,$10,$11,'REQUESTED'
       )`,
      [
        id,
        user.id,
        consoleId,
        source.local_user_id,
        source.platform,
        source.game_title_id,
        source.save_title_id,
        source.directory,
        body.gameVersion,
        body.region ?? null,
        source.modified_at,
      ],
    );
    return reply.code(202).send({ id, state: 'REQUESTED' });
  });
  app.get('/api/v1/portable-saves', async (req) =>
    (
      await db.query(
        'SELECT * FROM portable_save_archives WHERE user_id=$1 ORDER BY created_at DESC',
        [(await auth.user(req)).id],
      )
    ).rows.map(view),
  );
  app.get('/api/v1/portable-saves/:id/download', async (req, reply) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id),
      row = await queryOne(
        db,
        "SELECT * FROM portable_save_archives WHERE id=$1 AND user_id=$2 AND state='READY'",
        [id, user.id],
      );
    if (!row) throw new AppError('NOT_FOUND', 404);
    return serveSave(req, reply, config, row);
  });
  app.get('/api/v1/device/save-exports', async (req) => {
    const device = await auth.device(req),
      row = await queryOne(
        db,
        `SELECT p.*, c.firmware, c.runtime
           FROM portable_save_archives p
           JOIN consoles c ON c.id=p.console_id
          WHERE p.console_id=$1 AND p.origin='EXPORT'
            AND p.state IN ('REQUESTED','UPLOADING','VERIFYING')
          ORDER BY p.created_at
          LIMIT 1`,
        [device.id],
      );
    return row ? { ...view(row), firmware: row.firmware, runtime: row.runtime } : null;
  });
  app.post('/api/v1/device/save-exports/:id/start', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = start.parse(req.body);
    return transaction(db, async (sql) => {
      const row = await queryOne(
        sql,
        "SELECT * FROM portable_save_archives WHERE id=$1 AND console_id=$2 AND origin='EXPORT' AND state IN ('REQUESTED','UPLOADING') FOR UPDATE",
        [id, device.id],
      );
      if (!row) throw new AppError('NOT_FOUND', 404);
      const m = body.manifest;
      if (
        m.archiveSize !== body.totalBytes ||
        m.archiveSha256 !== body.sha256 ||
        m.platform !== row.platform ||
        m.gameTitleId !== row.game_title_id ||
        m.saveTitleId !== row.save_title_id ||
        m.directory !== row.directory ||
        m.gameVersion !== row.game_version ||
        (row.total_bytes !== null &&
          (row.total_bytes !== body.totalBytes || row.sha256 !== body.sha256))
      )
        throw new AppError('METADATA_MISMATCH', 409);
      if (row.total_bytes === null) {
        const usage = await storageUsage(sql, { portableSaveId: id });
        if (quotaExceeded(usage, body.totalBytes, config.QUOTA_BYTES))
          throw new AppError('QUOTA_EXCEEDED', 409);
        await requireDiskSpace(config.DATA_DIR, body.totalBytes + config.DISK_MARGIN_BYTES);
      }
      const uploaded = await resumeUpload(part(config, id), body.totalBytes);
      await sql.query(
        "UPDATE portable_save_archives SET state='UPLOADING',total_bytes=$2,uploaded_bytes=$3,sha256=$4,file_count=$5,manifest=$6,error=NULL,updated_at=now() WHERE id=$1",
        [id, body.totalBytes, uploaded, body.sha256, m.fileCount, m],
      );
      return { uploadedBytes: uploaded };
    });
  });
  app.post('/api/v1/device/save-exports/:id/chunks', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = uploadChunk.parse(req.body);
    return transaction(db, async (sql) => {
      const row = await queryOne(
        sql,
        "SELECT * FROM portable_save_archives WHERE id=$1 AND console_id=$2 AND state='UPLOADING' FOR UPDATE",
        [id, device.id],
      );
      if (!row) throw new AppError('NOT_FOUND', 404);
      const uploaded = await appendUpload(
        part(config, id),
        body.offset,
        body.data,
        row.total_bytes,
      );
      await sql.query(
        'UPDATE portable_save_archives SET uploaded_bytes=$2,updated_at=now() WHERE id=$1',
        [id, uploaded],
      );
      return { uploadedBytes: uploaded };
    });
  });
  app.post('/api/v1/device/save-exports/:id/complete', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      row = await transaction(db, async (sql) => {
        const found = await queryOne(
          sql,
          "SELECT * FROM portable_save_archives WHERE id=$1 AND console_id=$2 AND state IN ('UPLOADING','VERIFYING') FOR UPDATE",
          [id, device.id],
        );
        if (!found) throw new AppError('NOT_FOUND', 404);
        if (found.uploaded_bytes !== found.total_bytes) throw new AppError('INCOMPLETE_INPUT', 409);
        await sql.query(
          "UPDATE portable_save_archives SET state='VERIFYING',updated_at=now() WHERE id=$1",
          [id],
        );
        return found;
      });
    const destination = within(
        config.DATA_DIR,
        path.join(config.DATA_DIR, relative(row.user_id, id, row.sha256)),
      ),
      staging = part(config, id),
      source = (await lstat(staging).catch(() => null))?.isFile() ? staging : destination;
    try {
      await validatePortableSaveArchive(source, row.total_bytes, row.file_count, row.sha256);
    } catch {
      await failArchive(db, id, 'CORRUPT_INPUT', 409, staging);
    }
    if (source === staging) {
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(staging, destination);
    }
    await db.query(
      "UPDATE portable_save_archives SET state='READY',relative_path=$2,error=NULL,updated_at=now() WHERE id=$1",
      [id, path.relative(config.DATA_DIR, destination)],
    );
    return { ok: true };
  });
  app.post('/api/v1/device/save-exports/:id/error', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = failure.parse(req.body);
    await requireUpdate(
      db,
      "UPDATE portable_save_archives SET state='ERROR',error=$3,updated_at=now() WHERE id=$1 AND console_id=$2 AND state IN ('REQUESTED','UPLOADING','VERIFYING')",
      [id, device.id, body.error],
    );
    await rm(part(config, id), { force: true });
    return { ok: true };
  });
}

export async function communitySaveRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  logs: Logger,
  fetcher: typeof fetch = fetch,
) {
  const masterCredentials = (userId: string) =>
    Promise.all([
      approvedMasterCredential(db, config),
      approvedMasterUserCredential(db, config, userId, fetcher),
    ]);
  const currentTerms = async () => {
    const value = masterTerms.parse(
      await masterRequest(config, '/api/v1/terms/current', {}, fetcher),
    );
    if (createHash('sha256').update(value.body).digest('hex') !== value.sha256)
      throw new AppError('INVALID_MASTER_RESPONSE', 502);
    return value;
  };
  const consent = async (userId: string) => {
    const current = await currentTerms(),
      accepted = await queryOne(
        db,
        'SELECT terms_version,terms_sha256 FROM community_user_terms WHERE user_id=$1',
        [userId],
      );
    if (
      !accepted ||
      accepted.terms_version !== current.version ||
      accepted.terms_sha256 !== current.sha256
    )
      throw new AppError(
        'TERMS_ACCEPTANCE_REQUIRED',
        428,
        'Review and accept the current Community Save terms.',
      );
    return current;
  };
  const installedVersion = async (consoleId: string, userId: string, gameTitleId: string) => {
    const rows = (await queryRows(
      db,
      `SELECT DISTINCT r.version, r.kind
           FROM console_library_entries l
           JOIN consoles c ON c.id=l.console_id
           JOIN game_releases r ON r.id=l.release_id
           JOIN games g ON g.id=r.game_id
          WHERE c.id=$1 AND c.user_id=$2 AND g.title_id=$3
            AND l.state='READY_ON_PS5' AND r.kind IN ('BASE','UPDATE')`,
      [consoleId, userId, gameTitleId],
    )) as { version: string; kind: string }[];
    const candidates = rows.some((row) => row.kind === 'UPDATE')
      ? rows.filter((row) => row.kind === 'UPDATE')
      : rows;
    if (!candidates.length) return null;
    const parts = (value: string) => {
      const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
    };
    if (candidates.length > 1 && candidates.some((row) => !parts(row.version))) return null;
    return candidates.sort((a, b) => {
      const left = parts(a.version),
        right = parts(b.version);
      if (!left || !right) return 0;
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i]! - left[i]!;
      return 0;
    })[0]!.version;
  };
  const requireInstalledVersion = async (
    consoleId: string,
    userId: string,
    gameTitleId: string,
    gameVersion: string,
  ) => {
    if ((await installedVersion(consoleId, userId, gameTitleId)) !== gameVersion)
      throw new AppError('GAME_VERSION_MISMATCH', 409);
  };
  const masterCatalogFor = async (
    userId: string,
    consoleId: string,
    gameTitleId: string,
    gameVersion: string,
  ) => {
    await consent(userId);
    await requireInstalledVersion(consoleId, userId, gameTitleId, gameVersion);
    const [token, userToken] = await masterCredentials(userId),
      catalog = masterCatalog.parse(
        await masterRequest(
          config,
          `/api/v1/saves?gameTitleId=${encodeURIComponent(gameTitleId)}&gameVersion=${encodeURIComponent(gameVersion)}`,
          { token, userToken },
          fetcher,
        ),
      );
    return { token, userToken, catalog: exactCatalog(catalog, gameTitleId, gameVersion) };
  };

  app.get('/api/v1/community/terms', async (req) => {
    const user = await auth.user(req),
      current = await currentTerms(),
      accepted = Boolean(
        (
          await db.query(
            'SELECT 1 FROM community_user_terms WHERE user_id=$1 AND terms_version=$2 AND terms_sha256=$3',
            [user.id, current.version, current.sha256],
          )
        ).rowCount,
      );
    return { ...current, accepted };
  });
  app.post('/api/v1/community/terms/accept', async (req) => {
    const user = await auth.user(req),
      body = terms.parse(req.body),
      current = await currentTerms();
    if (body.termsVersion !== current.version || body.termsSha256 !== current.sha256)
      throw new AppError('TERMS_CHANGED', 409);
    await db.query(
      `INSERT INTO community_user_terms(user_id,terms_version,terms_sha256) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET terms_version=$2,terms_sha256=$3,accepted_at=now()`,
      [user.id, current.version, current.sha256],
    );
    await logs.write(
      'INFO',
      'community.terms_accepted',
      `Community save terms accepted by ${user.username}`,
      { version: current.version },
    );
    return { ok: true };
  });

  registerSaveExportRoutes(app, db, config, auth, requireInstalledVersion);

  app.post('/api/v1/portable-saves/:id/publish', async (req, reply) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = publication.parse(req.body);
    await consent(user.id);
    const [token, userToken] = await masterCredentials(user.id),
      row = await queryOne(
        db,
        "SELECT * FROM portable_save_archives WHERE id=$1 AND user_id=$2 AND origin='EXPORT' AND state='READY'",
        [id, user.id],
      );
    if (!row) throw new AppError('NOT_FOUND', 404);
    let publicationId = row.master_publication_id as string | null;
    if (publicationId && row.master_state !== 'UPLOAD_ERROR')
      throw new AppError('ALREADY_PUBLISHED', 409);
    if (!publicationId) {
      const created = z
        .object({ id: uuid, state: z.literal('PUBLISHING'), uploadUrl: z.string() })
        .parse(
          await masterRequest(
            config,
            '/api/v1/saves/publications',
            {
              method: 'POST',
              token,
              userToken,
              body: {
                manifest: row.manifest,
                displayName: body.displayName,
                description: body.description,
              },
            },
            fetcher,
          ),
        );
      publicationId = created.id;
      await db.query(
        "UPDATE portable_save_archives SET display_name=$2,description=$3,master_publication_id=$4,master_state='UPLOADING',updated_at=now() WHERE id=$1",
        [id, body.displayName, body.description, publicationId],
      );
    }
    const uploadUrl = new URL(
        `/api/v1/saves/publications/${publicationId}/archive`,
        config.COMMUNITY_MASTER_URL,
      ),
      file = within(config.DATA_DIR, path.join(config.DATA_DIR, row.relative_path)),
      checked = await regularFile(file, 'r');
    try {
      if (
        checked.info.size !== row.total_bytes ||
        (await fileHandleHash(checked.handle)) !== row.sha256
      )
        throw new AppError('CORRUPT_INPUT', 409);
      const response = await fetcher(uploadUrl, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(30 * 60_000),
        headers: {
          authorization: `Bearer ${token}`,
          'x-ps5library-user-token': userToken,
          'content-type': 'application/vnd.ps5library.save',
          'content-length': String(row.total_bytes),
        },
        body: checked.handle.createReadStream({ start: 0, autoClose: false }) as any,
        duplex: 'half',
      } as any);
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError('MASTER_UPLOAD_FAILED', 502);
      }
      await response.body?.cancel();
    } catch (error) {
      await db.query(
        "UPDATE portable_save_archives SET master_state='UPLOAD_ERROR',updated_at=now() WHERE id=$1",
        [id],
      );
      throw error;
    } finally {
      await checked.handle.close();
    }
    await db.query(
      "UPDATE portable_save_archives SET master_state='PUBLISHING',updated_at=now() WHERE id=$1",
      [id],
    );
    await logs.write(
      'INFO',
      'community.save_published',
      `Portable save submitted by ${user.username}`,
      { publicationId, titleId: row.game_title_id, version: row.game_version },
    );
    return reply.code(202).send({ publicationId, state: 'PUBLISHING' });
  });

  app.get('/api/v1/community/saves', async (req) => {
    const user = await auth.user(req),
      query = catalogRequest.parse(req.query);
    return (await masterCatalogFor(user.id, query.consoleId, query.gameTitleId, query.gameVersion))
      .catalog;
  });
  app.post('/api/v1/community/saves/:id/download', async (req, reply) => {
    const user = await auth.user(req),
      publicationId = uuid.parse((req.params as { id: string }).id),
      body = catalogRequest.strict().parse(req.body);
    const { token, userToken, catalog } = await masterCatalogFor(
        user.id,
        body.consoleId,
        body.gameTitleId,
        body.gameVersion,
      ),
      item = catalog.versions
        .flatMap((group) => group.saves)
        .find((value) => value.id === publicationId);
    if (!item) throw new AppError('NOT_FOUND', 404);
    const id = randomUUID(),
      staging = part(config, id),
      destination = within(
        config.DATA_DIR,
        path.join(config.DATA_DIR, relative(user.id, id, item.sha256)),
      );
    await transaction(db, async (sql) => {
      if (quotaExceeded(await storageUsage(sql), item.size, config.QUOTA_BYTES))
        throw new AppError('QUOTA_EXCEEDED', 409);
      await requireDiskSpace(config.DATA_DIR, item.size + config.DISK_MARGIN_BYTES);
      await sql.query(
        `INSERT INTO portable_save_archives(
           id,user_id,origin,platform,game_title_id,save_title_id,directory,
           game_version,region,state,total_bytes,sha256,file_count,manifest,
           display_name,description,master_publication_id,master_state
         ) VALUES(
           $1,$2,'COMMUNITY',$3,$4,$5,$6,$7,$8,'DOWNLOADING',
           $9,$10,$11,$12,$13,$14,$15,'PUBLISHED'
         )`,
        [
          id,
          user.id,
          item.platform,
          item.gameTitleId,
          item.saveTitleId,
          item.manifest.directory,
          item.gameVersion,
          item.region,
          item.size,
          item.sha256,
          item.manifest.fileCount,
          item.manifest,
          item.displayName,
          item.description,
          item.id,
        ],
      );
    });
    let handle!: FileHandle;
    try {
      await mkdir(path.dirname(staging), { recursive: true });
      handle = await open(staging, 'wx', 0o600);
    } catch {
      await failArchive(db, id, 'STAGING_FAILED', 500);
    }
    try {
      const response = await fetcher(
        new URL(`/api/v1/saves/${item.id}/archive`, config.COMMUNITY_MASTER_URL),
        {
          redirect: 'error',
          signal: AbortSignal.timeout(30 * 60_000),
          headers: {
            authorization: `Bearer ${token}`,
            'x-ps5library-user-token': userToken,
            accept: 'application/vnd.ps5library.save',
          },
        },
      );
      if (!response.ok || !response.body) throw new Error('MASTER_DOWNLOAD_FAILED');
      let size = 0;
      const digest = createHash('sha256');
      for await (const value of response.body) {
        const data = Buffer.from(value);
        size += data.length;
        if (size > item.size) throw new Error('ARCHIVE_SIZE_MISMATCH');
        digest.update(data);
        let offset = 0;
        while (offset < data.length)
          offset += (await handle.write(data, offset, data.length - offset, null)).bytesWritten;
      }
      await handle.sync();
      if (size !== item.size || digest.digest('hex') !== item.sha256)
        throw new Error('ARCHIVE_MISMATCH');
    } catch {
      await handle.close().catch(() => {});
      await failArchive(db, id, 'MASTER_DOWNLOAD_FAILED', 502, staging);
    }
    await handle.close();
    try {
      await validatePortableSaveArchive(staging, item.size, item.manifest.fileCount, item.sha256);
    } catch {
      await failArchive(db, id, 'CORRUPT_INPUT', 409, staging);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(staging, destination);
    await db.query(
      "UPDATE portable_save_archives SET state='READY',uploaded_bytes=total_bytes,relative_path=$2,error=NULL,updated_at=now() WHERE id=$1",
      [id, path.relative(config.DATA_DIR, destination)],
    );
    return reply.code(201).send({ id, state: 'READY' });
  });

  registerSaveImportRoutes(app, db, config, auth, requireInstalledVersion);
}
