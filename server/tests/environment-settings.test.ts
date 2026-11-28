import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { environmentOverridesPath, loadConfiguration } from '../src/config.js';
import { runtimeSettingDefinitions, secretSettingValue } from '../src/runtime-settings.js';

const base = (dataDir: string, extra: Record<string, string> = {}) => ({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  BOOTSTRAP_TOKEN: 'b'.repeat(32),
  DATA_DIR: dataDir,
  PUBLIC_URL: 'http://127.0.0.1:3150',
  ...extra,
});

test('dashboard environment overrides apply only when enabled and never block startup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ps5library-env-'));
  try {
    const file = environmentOverridesPath(dataDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ PUBLIC_URL: 'https://library.example', PORT: '9', DATA_DIR: '/elsewhere' }),
    );
    assert.equal(loadConfiguration(base(dataDir)).PUBLIC_URL, 'http://127.0.0.1:3150');

    const enabled = loadConfiguration(base(dataDir, { ALLOW_ENVIRONMENT_EDITS: 'true' }));
    assert.equal(enabled.PUBLIC_URL, 'https://library.example');
    assert.equal(enabled.PORT, 3150);
    assert.equal(enabled.DATA_DIR, path.resolve(dataDir));

    await writeFile(file, JSON.stringify({ PUBLIC_URL: 'not a url' }));
    assert.equal(
      loadConfiguration(base(dataDir, { ALLOW_ENVIRONMENT_EDITS: 'true' })).PUBLIC_URL,
      'http://127.0.0.1:3150',
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('environment definitions expose values, hide secrets and mark what is editable', () => {
  const config = loadConfiguration(base(os.tmpdir(), { ALLOW_ENVIRONMENT_EDITS: 'true' }));
  const definitions = runtimeSettingDefinitions(config, {} as any) as any[];
  const find = (key: string) => definitions.find((item) => item.key === key);
  assert.equal(find('PUBLIC_URL').value, 'http://127.0.0.1:3150');
  assert.equal(find('PUBLIC_URL').editable, true);
  assert.equal(find('PORT').editable, false);
  assert.equal(find('DATABASE_URL').editable, false);
  assert.equal(find('DATABASE_URL').configured, true);
  assert.equal('value' in find('DATABASE_URL'), false);
  assert.equal(secretSettingValue(config, 'BOOTSTRAP_TOKEN'), 'b'.repeat(32));
  assert.throws(() => secretSettingValue(config, 'PUBLIC_URL'));

  const locked = runtimeSettingDefinitions(
    loadConfiguration(base(os.tmpdir())),
    {} as any,
  ) as any[];
  assert.equal(locked.find((item) => item.key === 'PUBLIC_URL').editable, false);
});
