import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
pg.types.setTypeParser(20, text => { const value = Number(text); if (!Number.isSafeInteger(value)) throw new Error('Integer exceeds JSON safe range'); return value; });
export function database(url: string) { return new pg.Pool({ connectionString: url, max: 12 }); }
export type DB = pg.Pool;
export type SQL = Pick<pg.PoolClient, 'query'>;
export async function transaction<T>(db: DB, fn: (sql: pg.PoolClient) => Promise<T>) {
  const sql = await db.connect();
  try { await sql.query('BEGIN'); const result = await fn(sql); await sql.query('COMMIT'); return result; }
  catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
export async function migrate(db: DB) {
  await transaction(db, async sql => {
    await sql.query('SELECT pg_advisory_xact_lock(3150001)');
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())');
    const directory = path.resolve('server/migrations');
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
      const body = await readFile(path.join(directory, name), 'utf8');
      const hash = createHash('sha256').update(body).digest('hex');
      const old = (await sql.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (old && old.sha256 !== hash) throw new Error(`Migration changed after application: ${name}`);
      if (old) continue;
      await sql.query(body);
      await sql.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    }
  });
}
