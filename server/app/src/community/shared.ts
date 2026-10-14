import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import type { DB, SQL } from '../db.js';
import { serveStoredFile } from '../downloads/serve.js';
import type { Logger } from '../logging.js';
import { AppError } from '../security/errors.js';
import { within } from '../security/paths.js';

export type CommunityRouteContext = {
  app: FastifyInstance;
  db: DB;
  config: Config;
  auth: Auth;
  logs: Logger;
  fetcher: typeof fetch;
};
export type RequireInstalledVersion = (
  consoleId: string,
  userId: string,
  gameTitleId: string,
  gameVersion: string,
) => Promise<void>;

export async function requireUpdate(sql: SQL, text: string, values: unknown[]) {
  if (!(await sql.query(text, values)).rowCount) throw new AppError('NOT_FOUND', 404);
}

type StoredSave = { relative_path: string; total_bytes: number; sha256: string };

export const serveSave = (
  req: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  row: StoredSave,
) =>
  serveStoredFile(
    req,
    reply,
    within(config.DATA_DIR, path.join(config.DATA_DIR, row.relative_path)),
    row.total_bytes,
    row.sha256,
    'application/vnd.ps5library.save',
    config.DATA_DIR,
  );
