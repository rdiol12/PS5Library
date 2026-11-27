import test from 'node:test';
import assert from 'node:assert/strict';
import { database, migrate } from '../src/db.js';

test('database operations have finite timeouts while migrations disable them locally', async () => {
  const db = database('postgres://localhost/unused');
  try {
    assert.deepEqual(
      {
        connectionTimeoutMillis: db.options.connectionTimeoutMillis,
        idleTimeoutMillis: db.options.idleTimeoutMillis,
        statement_timeout: db.options.statement_timeout,
        lock_timeout: db.options.lock_timeout,
        idle_in_transaction_session_timeout: db.options.idle_in_transaction_session_timeout,
      },
      {
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 60_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 30_000,
      },
    );
  } finally {
    await db.end();
  }

  const queries: string[] = [];
  const client = {
    query: async (query: string) => {
      queries.push(query);
      return { rows: [] };
    },
    release() {},
  };
  await migrate({ connect: async () => client } as never);
  assert.deepEqual(queries.slice(0, 3), [
    'BEGIN',
    'SET LOCAL statement_timeout=0; SET LOCAL lock_timeout=0; SET LOCAL idle_in_transaction_session_timeout=0',
    'SELECT pg_advisory_xact_lock(3150001)',
  ]);
});
