import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibility, planStorage, presence, resolveMetadata } from '../src/library/policy.js';
import { safeName, isPublicAddress } from '../src/security/paths.js';
import { sourceHeaders } from '../src/sources/connectors.js';
import { configuration } from '../src/config.js';

test('browser aliases require explicit exact HTTP(S) origins', () => {
  const env = { DATABASE_URL: 'postgres://localhost/test', REDIS_URL: 'redis://localhost', BOOTSTRAP_TOKEN: 'test'.repeat(8), PUBLIC_URL: 'https://store.example' };
  assert.deepEqual(configuration(env).browserOrigins, ['https://store.example']);
  assert.deepEqual(configuration({ ...env, BROWSER_ORIGINS: ' http://localhost:3150, http://127.0.0.1:3150, ' }).browserOrigins, ['https://store.example', 'http://localhost:3150', 'http://127.0.0.1:3150']);
  for (const origin of ['*', 'https://*.example', 'null', 'file:///tmp', 'ftp://store.example', 'http://user:pass@localhost:3150', 'http://localhost:3150/path', 'http://localhost:3150?query=1']) {
    assert.throws(() => configuration({ ...env, BROWSER_ORIGINS: origin }));
  }
});

const release = { titleId: 'PPSA99999', contentId: 'IV0000-PPSA99999_00-PS5LIBRARYDEMO00', version: '01.00', sha256: 'a'.repeat(64), minimumFirmware: '10.01', format: 'ffpkg' };
const consoleInfo = { firmware: '7.61', runtime: 'kstuff-lite', capabilities: { shadowMount: true, backportOverlay: true }, shadowMountFakelib: true, standaloneBackPork: false };
test('compatibility requires exact release, input hash, firmware, runtime and tested profile', () => {
  assert.equal(compatibility(release, consoleInfo, []).status, 'BACKPORT_NO_MATCH');
  const profile = { id: 'profile', titleId: release.titleId, contentId: release.contentId, gameVersion: release.version, inputHashes: [release.sha256], targetFirmware: '7.61', runtime: 'kstuff-lite', installationMethod: 'SHADOWMOUNT', testedState: 'TESTED', requiredLibraries: [], requiredPatches: [] };
  assert.equal(compatibility(release, consoleInfo, [profile]).status, 'MATCHING_BACKPORT_AVAILABLE');
  assert.equal(compatibility({ ...release, version: '01.01' }, consoleInfo, [profile]).status, 'BACKPORT_NO_MATCH');
  assert.equal(compatibility({ ...release, sha256: 'b'.repeat(64) }, consoleInfo, [profile]).status, 'BACKPORT_NO_MATCH');
  assert.equal(compatibility(release, consoleInfo, [{ ...profile, testedState: 'UNTESTED' }]).status, 'BACKPORT_UNTESTED');
  assert.equal(compatibility(release, { ...consoleInfo, standaloneBackPork: true }, [profile]).status, 'RUNTIME_CONFLICT');
  assert.equal(compatibility({ ...release, minimumFirmware: null }, consoleInfo, []).status, 'UNKNOWN');
  assert.equal(compatibility(release, { ...consoleInfo, firmware: '10.01' }, []).status, 'NATIVE_COMPATIBLE');
  assert.equal(compatibility({ ...release, format: 'pkg' }, consoleInfo, []).status, 'UNSUPPORTED_METHOD');
});
test('storage reserves all components, temporary bytes and margin', () => {
  const storage = { freeBytes: 1000, writable: true, installMethodsSupported: ['SHADOWMOUNT'] };
  assert.equal(planStorage(storage, 'SHADOWMOUNT', { game: 200, update: 100, backport: 50, temporary: 200, margin: 100 }).requiredBytes, 650);
  assert.equal(planStorage({ ...storage, freeBytes: 600 }, 'SHADOWMOUNT', { game: 650 }).allowed, false);
  assert.equal(planStorage(storage, 'FPKG', { game: 1 }).allowed, false);
  assert.throws(() => planStorage(storage, 'SHADOWMOUNT', { game: -1 }));
});
test('presence and metadata never fabricate facts', () => {
  assert.equal(presence(null, 100_000), 'OFFLINE');
  assert.equal(presence(90_000, 100_000), 'ONLINE');
  assert.equal(presence(30_000, 100_000), 'STALE');
  assert.equal(presence(0, 300_000), 'OFFLINE');
  assert.throws(() => resolveMetadata([{ rank: 1, data: { titleId: 'PPSA11111' } }, { rank: 3, data: { titleId: 'PPSA22222' } }]), /METADATA_MISMATCH/);
  assert.equal(resolveMetadata([{ rank: 3, data: { title: 'Source' } }, { rank: 1, data: { title: 'Verified' } }]).title, 'Verified');
});
test('trust boundaries reject path traversal, device filenames and private SSRF destinations', () => {
  for (const name of ['../x', 'a/b', 'a\\b', 'CON', 'NUL.pkg', 'a:stream', '.', 'x\n']) assert.throws(() => safeName(name));
  assert.equal(safeName('example.ffpkg'), 'example.ffpkg');
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});
test('repository credentials never follow a manifest URL to another origin', () => {
  process.env.REPOSITORY_TOKEN_CHECK = 'test-only';
  const source = { type: 'PRIVATE_HTTP' as const, name: 'Private', location: 'https://repo.example/library.json', tokenEnv: 'REPOSITORY_TOKEN_CHECK' };
  assert.deepEqual(sourceHeaders(source, 'https://cdn.example/game.elf'), {});
  assert.equal(sourceHeaders(source, 'https://repo.example/game.elf').authorization, 'Bearer test-only');
  delete process.env.REPOSITORY_TOKEN_CHECK;
});
