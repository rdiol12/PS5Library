import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import type { DB, SQL } from '../db.js';
import { AppError } from '../security/errors.js';

export type ConsoleRouteContext = { app: FastifyInstance; db: DB; config: Config; auth: Auth };

export async function requireOwnedConsole(
  sql: SQL,
  consoleId: string,
  userId: string,
  lock = false,
) {
  const query = `SELECT id FROM consoles WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`;
  const row = (await sql.query(query, [consoleId, userId])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}
