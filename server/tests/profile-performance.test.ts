import test from 'node:test';
import assert from 'node:assert/strict';
import { profileRoutes } from '../src/auth/profile.js';

test('profile starts its independent reads together', async () => {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>(),
    register =
      (method: string) =>
      (route: string, ...args: unknown[]) =>
        handlers.set(`${method} ${route}`, args.at(-1) as (req: unknown) => Promise<unknown>);
  const app = {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
  };
  let started = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = {
    query: async (sql: string) => {
      started++;
      await gate;
      return {
        rows: sql.startsWith('SELECT username')
          ? [{ username: 'owner', role: 'ADMIN', avatar_sha256: null }]
          : [],
      };
    },
  };
  const auth = { user: async () => ({ id: '00000000-0000-4000-8000-000000000000' }) };
  await profileRoutes(app as never, db as never, {} as never, auth as never);
  const profile = handlers.get('GET /api/v1/profile')!({});
  await new Promise((resolve) => setImmediate(resolve));
  const readsStarted = started;
  release();
  assert.deepEqual(await profile, {
    username: 'owner',
    role: 'ADMIN',
    avatarUrl: null,
    consoles: [],
  });
  assert.equal(readsStarted, 4);
});
