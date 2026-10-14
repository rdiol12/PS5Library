import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';

type Config = ReturnType<typeof configuration>;
type App = Awaited<ReturnType<typeof createApp>>;

export async function isolatedApp(prefix: string, overrides: Partial<Config> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = {
    ...configuration(process.env),
    DUMP_ROOT: '',
    DATA_DIR: root,
    SOURCE_ROOT: path.join(root, 'sources'),
    ...overrides,
  };
  const admin = database(config.DATABASE_URL);
  const schema = `ps5library_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(config.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  config.DATABASE_URL = url.href;
  await mkdir(config.SOURCE_ROOT);
  return {
    root,
    config,
    admin,
    schema,
    app: await createApp(config),
    db: database(config.DATABASE_URL),
  };
}

export function api(app: () => App) {
  return async (method: string, route: string, body?: unknown, token?: string) => {
    const response = await app().inject({
      method: method as 'GET',
      url: '/api/v1' + route,
      payload: body,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.statusCode, body: response.json() };
  };
}
