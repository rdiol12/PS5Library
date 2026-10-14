import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serverVersion } from '../src/api/app.js';

test('health version comes from the package version', async () => {
  const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  assert.equal(serverVersion, packageVersion);
  assert.match(await readFile('app/src/api/app.ts', 'utf8'), /version: serverVersion/);
});
