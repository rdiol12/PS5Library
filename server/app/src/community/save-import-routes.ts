import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { queryOne, queryRows, transaction, type DB } from '../db.js';
import { presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { bytes, localUserId, uuid } from '../../../shared/schemas/index.js';
import { consoleSaveData } from '../consoles/save-data.js';
import { requireUpdate, serveSave, type RequireInstalledVersion } from './shared.js';
export const saveFailure = z
  .object({
    error: z.enum([
      'SAVE_SOURCE_UNAVAILABLE',
      'SAVE_SOURCE_CHANGED',
      'INSUFFICIENT_SPACE',
      'SAVE_EXPORT_FAILED',
      'SAVE_IMPORT_FAILED',
      'ROLLBACK_FAILED',
      'CORRUPT_INPUT',
      'CAPABILITY_UNAVAILABLE',
    ]),
  })
  .strict();
const importProgress = z
  .object({ downloadedBytes: bytes, speedBytesPerSecond: bytes.default(0) })
  .strict();
export function registerSaveImportRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  requireInstalledVersion: RequireInstalledVersion,
) {
  app.post('/api/v1/portable-saves/:id/import', async (req, reply) => {
    const user = await auth.user(req),
      archiveId = uuid.parse((req.params as { id: string }).id),
      body = z.object({ consoleId: uuid, localUserId }).strict().parse(req.body);
    const archive = await queryOne(
      db,
      "SELECT * FROM portable_save_archives WHERE id=$1 AND user_id=$2 AND state='READY'",
      [archiveId, user.id],
    );
    if (!archive) throw new AppError('NOT_FOUND', 404);
    const target = await consoleSaveData(
      db,
      user.id,
      body.consoleId,
      body.localUserId,
      archive.platform,
      archive.game_title_id,
      archive.save_title_id,
      archive.directory,
    );
    if (!target)
      throw new AppError(
        'TARGET_SAVE_SLOT_REQUIRED',
        409,
        'Create the matching save slot in the game before importing.',
      );
    if (
      target.capabilities.saveBackup !== true ||
      target.capabilities.saveImport !== true ||
      target.capabilities.saveRollback !== true
    )
      throw new AppError('CAPABILITY_UNAVAILABLE', 409);
    if (presence(target.last_seen ? new Date(target.last_seen).getTime() : null) !== 'ONLINE')
      throw new AppError('CONSOLE_OFFLINE', 409);
    await requireInstalledVersion(
      body.consoleId,
      user.id,
      archive.game_title_id,
      archive.game_version,
    );
    const backupId = randomUUID(),
      id = randomUUID();
    await transaction(db, async (sql) => {
      await sql.query(
        `INSERT INTO save_backups(id,user_id,console_id,local_user_id,platform,game_title_id,save_title_id,directory,source_modified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          backupId,
          user.id,
          body.consoleId,
          body.localUserId,
          target.platform,
          target.game_title_id,
          target.save_title_id,
          target.directory,
          target.modified_at,
        ],
      );
      await sql.query(
        `INSERT INTO save_imports(id,user_id,archive_id,console_id,local_user_id,rollback_backup_id,state) VALUES($1,$2,$3,$4,$5,$6,'WAITING_ROLLBACK')`,
        [id, user.id, archiveId, body.consoleId, body.localUserId, backupId],
      );
    });
    return reply.code(202).send({ id, state: 'WAITING_ROLLBACK', rollbackBackupId: backupId });
  });
  app.get('/api/v1/save-imports', async (req) =>
    queryRows(
      db,
      `SELECT i.id, i.state, i.error,
                i.archive_id AS "archiveId", i.console_id AS "consoleId",
                i.local_user_id AS "localUserId",
                i.rollback_backup_id AS "rollbackBackupId",
                i.downloaded_bytes AS "downloadedBytes",
                i.speed_bytes_per_second AS "speedBytesPerSecond",
                i.created_at AS "createdAt", i.updated_at AS "updatedAt",
                p.display_name AS "displayName", p.game_title_id AS "gameTitleId",
                p.game_version AS "gameVersion", p.save_title_id AS "saveTitleId",
                p.directory, p.total_bytes AS "totalBytes",
                b.state AS "rollbackState"
           FROM save_imports i
           JOIN portable_save_archives p ON p.id=i.archive_id
           JOIN save_backups b ON b.id=i.rollback_backup_id
          WHERE i.user_id=$1
          ORDER BY i.created_at DESC`,
      [(await auth.user(req)).id],
    ),
  );
  app.get('/api/v1/device/save-imports', async (req) => {
    const device = await auth.device(req);
    await db.query(
      `UPDATE save_imports i
          SET state='ERROR',error='ROLLBACK_FAILED',updated_at=now()
         FROM save_backups b
        WHERE i.console_id=$1 AND i.rollback_backup_id=b.id
          AND i.state='WAITING_ROLLBACK' AND b.state='ERROR'`,
      [device.id],
    );
    await db.query(
      "UPDATE save_imports i SET state='REQUESTED',updated_at=now() FROM save_backups b WHERE i.console_id=$1 AND i.rollback_backup_id=b.id AND i.state='WAITING_ROLLBACK' AND b.state='READY'",
      [device.id],
    );
    const row = await queryOne(
      db,
      `SELECT i.*, p.platform, p.game_title_id, p.save_title_id, p.directory,
              p.game_version, p.total_bytes, p.sha256, p.file_count, p.manifest
         FROM save_imports i
         JOIN portable_save_archives p ON p.id=i.archive_id
        WHERE i.console_id=$1 AND i.state IN ('REQUESTED','IMPORTING','VERIFYING')
        ORDER BY i.created_at
        LIMIT 1`,
      [device.id],
    );
    return row
      ? {
          id: row.id,
          state: row.state,
          localUserId: row.local_user_id,
          platform: row.platform,
          gameTitleId: row.game_title_id,
          saveTitleId: row.save_title_id,
          directory: row.directory,
          gameVersion: row.game_version,
          totalBytes: row.total_bytes,
          sha256: row.sha256,
          fileCount: row.file_count,
          manifest: row.manifest,
          archiveUrl: `/api/v1/device/save-imports/${row.id}/archive`,
        }
      : null;
  });
  app.post('/api/v1/device/save-imports/:id/start', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id);
    await requireUpdate(
      db,
      "UPDATE save_imports SET state='IMPORTING',error=NULL,updated_at=now() WHERE id=$1 AND console_id=$2 AND state IN ('REQUESTED','IMPORTING')",
      [id, device.id],
    );
    return { ok: true };
  });
  app.post('/api/v1/device/save-imports/:id/progress', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = importProgress.parse(req.body);
    await requireUpdate(
      db,
      `UPDATE save_imports i
          SET downloaded_bytes=$3,speed_bytes_per_second=$4,updated_at=now()
         FROM portable_save_archives p
        WHERE i.id=$1 AND i.console_id=$2 AND i.archive_id=p.id
          AND i.state IN ('REQUESTED','IMPORTING')
          AND $3 BETWEEN i.downloaded_bytes AND p.total_bytes`,
      [id, device.id, body.downloadedBytes, body.speedBytesPerSecond],
    );
    return { ok: true };
  });
  app.get('/api/v1/device/save-imports/:id/archive', async (req, reply) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      row = await queryOne(
        db,
        `SELECT p.*
           FROM save_imports i
           JOIN portable_save_archives p ON p.id=i.archive_id
          WHERE i.id=$1 AND i.console_id=$2
            AND i.state IN ('REQUESTED','IMPORTING','VERIFYING')
            AND p.state='READY'`,
        [id, device.id],
      );
    if (!row) throw new AppError('NOT_FOUND', 404);
    return serveSave(req, reply, config, row);
  });
  app.post('/api/v1/device/save-imports/:id/complete', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id);
    await requireUpdate(
      db,
      `UPDATE save_imports i
            SET state='COMPLETED',downloaded_bytes=p.total_bytes,
                speed_bytes_per_second=0,error=NULL,updated_at=now()
           FROM portable_save_archives p
          WHERE i.id=$1 AND i.console_id=$2 AND i.archive_id=p.id
            AND i.state IN ('IMPORTING','VERIFYING')`,
      [id, device.id],
    );
    return { ok: true };
  });
  app.post('/api/v1/device/save-imports/:id/error', async (req) => {
    const device = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = saveFailure.parse(req.body);
    await requireUpdate(
      db,
      "UPDATE save_imports SET state='ERROR',error=$3,updated_at=now() WHERE id=$1 AND console_id=$2 AND state IN ('REQUESTED','IMPORTING','VERIFYING')",
      [id, device.id, body.error],
    );
    return { ok: true };
  });
}
