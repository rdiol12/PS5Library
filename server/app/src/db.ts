import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
pg.types.setTypeParser(20, text => { const value = Number(text); if (!Number.isSafeInteger(value)) throw new Error('Integer exceeds JSON safe range'); return value; });
export function database(url: string) { return new pg.Pool({connectionString:url,max:12,connectionTimeoutMillis:5_000,idleTimeoutMillis:30_000,statement_timeout:60_000,lock_timeout:10_000,idle_in_transaction_session_timeout:30_000}); }
export type DB = pg.Pool;
export type SQL = Pick<pg.PoolClient, 'query'>;
export type SchemaMigration = {name:string;body:string;sha256:string};
const schemaHeader='-- PS5Library ordered database schema. Keep existing section bodies unchanged; append new numbered sections.\n';
export function parseSchema(source:string):SchemaMigration[]{
  if(!source.startsWith(schemaHeader)||source.includes('\r')) throw new Error('Invalid app/schema.sql format: expected the release header and LF line endings');
  const markers=[...source.matchAll(/^-- PS5LIBRARY MIGRATION ([0-9]{3}_[a-z0-9_]+\.sql)\n/gm)];
  if((source.match(/^-- PS5LIBRARY MIGRATION/gm)?.length??0)!==markers.length) throw new Error('Invalid app/schema.sql format: malformed migration marker');
  if(!markers.length||markers[0]?.index!==schemaHeader.length) throw new Error('Invalid app/schema.sql format: no ordered migration sections');
  return markers.map((marker,index)=>{
    const name=marker[1]!;
    if(name.slice(0,3)!==String(index+1).padStart(3,'0')) throw new Error(`Invalid app/schema.sql migration order at ${name}`);
    const start=marker.index!+marker[0].length,end=markers[index+1]?.index??source.length,body=source.slice(start,end);
    if(!body.trim()||!body.endsWith('\n')) throw new Error(`Invalid empty or unterminated schema section: ${name}`);
    return {name,body,sha256:createHash('sha256').update(body).digest('hex')};
  });
}
export async function transaction<T>(db: DB, fn: (sql: pg.PoolClient) => Promise<T>) {
  const sql = await db.connect();
  try { await sql.query('BEGIN'); const result = await fn(sql); await sql.query('COMMIT'); return result; }
  catch (error) { await sql.query('ROLLBACK'); throw error; }
  finally { sql.release(); }
}
export async function migrate(db: DB) {
  const migrations=parseSchema(await readFile(path.resolve('app/schema.sql'),'utf8'));
  await transaction(db, async sql => {
    await sql.query('SET LOCAL statement_timeout=0; SET LOCAL lock_timeout=0; SET LOCAL idle_in_transaction_session_timeout=0');
    await sql.query('SELECT pg_advisory_xact_lock(3150001)');
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())');
    const rows=(await sql.query<{name:string;sha256:string}>('SELECT name,sha256 FROM schema_migrations ORDER BY applied_at,name')).rows;
    const expectedPrefix=migrations.slice(0,rows.length);
    if(rows.length>migrations.length||rows.some((row,index)=>row.name!==expectedPrefix[index]?.name||row.sha256!==expectedPrefix[index]?.sha256)){
      throw new Error('SCHEMA_MIGRATION_HISTORY_INVALID: expected an unchanged contiguous prefix of app/schema.sql');
    }
    for (const migration of migrations.slice(rows.length)) {
      await sql.query(migration.body);
      await sql.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [migration.name,migration.sha256]);
    }
  });
}
