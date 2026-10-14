import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibility, planStorage, presence, resolveMetadata } from '../src/library/policy.js';
import { safeName, isPublicAddress } from '../src/security/paths.js';
import { sourceHeaders } from '../src/sources/connectors.js';
import { configuration } from '../src/config.js';
import {
  inventoryItem,
  heartbeatSchema,
  localUserId,
  profileSchema,
  releaseSchema,
  saveDirectory,
  savePlatform,
  uploadChunk,
} from '../../shared/schemas/index.js';
import {
  backportFiles,
  backportFileDelivered,
  backportMessages,
  deterministicProfileFailures,
  profileDiscoveryContext,
} from '../src/library/backports.js';
import { hardwareLookup, hardwareRecoveryToken, passwordMatches } from '../src/auth/credentials.js';
import { quotaExceeded, quotaMaximum, storageUsage } from '../src/storage/usage.js';
import {
  archiveBuildRequiredBytes,
  retryObservationError,
  shouldInspectObservation,
} from '../src/sources/watch.js';
import {
  legacyFpkgBuilderVersion,
  packageBuildAllowed,
  transferArtifactUsable,
} from '../src/jobs/preparation.js';
import { retryProfileAfterArtifact } from '../src/catalog/routes.js';

const privateAddress = ['10', '0', '0', '1'].join('.');
const linkLocalAddress = ['169', '254', '169', '254'].join('.');
const publicAddress = ['8', '8', '8', '8'].join('.');

test('hardware recovery identity is stable, secret-bound and domain-separated', () => {
  const proof = 'a1'.repeat(32),
    nonce = 'c3'.repeat(32),
    key = 'server-secret'.repeat(4),
    lookup = hardwareLookup(proof, key),
    token = hardwareRecoveryToken(lookup, nonce, key);
  assert.match(lookup, /^[a-f0-9]{64}$/);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(lookup, token);
  assert.equal(hardwareLookup(proof, key), lookup);
  assert.equal(hardwareRecoveryToken(lookup, nonce, key), token);
  assert.notEqual(hardwareLookup('b2'.repeat(32), key), lookup);
  assert.notEqual(hardwareRecoveryToken(lookup, 'd4'.repeat(32), key), token);
  assert.notEqual(hardwareLookup(proof, 'different-secret'.repeat(4)), lookup);
  assert.throws(() => hardwareLookup('raw-console-id', key));
});

test('watched dumps retry transient worker failures only', () => {
  for (const code of ['WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'INSPECTION_FAILED'])
    assert.equal(retryObservationError(code), true);
  for (const code of ['UNSUPPORTED_INPUT', 'CORRUPT_INPUT', 'QUOTA_EXCEEDED'])
    assert.equal(retryObservationError(code), false);
  assert.equal(shouldInspectObservation('ERROR', 'WORKER_UNAVAILABLE'), true);
  assert.equal(
    shouldInspectObservation('BLOCKED', 'QUOTA_EXCEEDED', 1_580_459_473_904, 0),
    true,
    'A zero quota disables the logical cap',
  );
  assert.equal(
    shouldInspectObservation('ERROR', 'WORKER_UNAVAILABLE', 1_580_459_473_904, 100 * 1024 ** 3),
    false,
  );
  assert.equal(
    shouldInspectObservation('BLOCKED', 'QUOTA_EXCEEDED', 1_580_459_473_904, 100 * 1024 ** 3),
    false,
  );
  assert.equal(
    shouldInspectObservation('BLOCKED', 'QUOTA_EXCEEDED', 1024, 100 * 1024 ** 3),
    true,
    'A larger configured quota permits a later retry',
  );
});

test('zero storage quota keeps physical disk checks as the only capacity limit', () => {
  assert.equal(quotaExceeded(10_000, 20_000, 0), false);
  assert.equal(quotaExceeded(90, 11, 100), true);
  assert.equal(quotaMaximum(316_078_473_008, 0), 316_078_473_008);
  assert.equal(quotaMaximum(316_078_473_008, 100 * 1024 ** 3), 100 * 1024 ** 3);
  const env = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost',
    BOOTSTRAP_TOKEN: 'test'.repeat(8),
    QUOTA_BYTES: '0',
  };
  assert.equal(configuration(env).QUOTA_BYTES, 0);
});

test('verified packages from the known pre-compression builder remain transferable', () => {
  const artifact = {
    format: 'pkg',
    input_hash: 'a'.repeat(64),
    cache_key: 'legacy',
    builder_version: `LibProsperoPKG drakmor / ${legacyFpkgBuilderVersion}`,
    profile_id: null,
    inspection: {
      structurallyRecognized: true,
      metadataVerified: true,
      installedImage: { size: 1, sha256: 'b'.repeat(64) },
    },
  };
  assert.equal(transferArtifactUsable(artifact), true);
  assert.equal(
    transferArtifactUsable({
      ...artifact,
      inspection: { ...artifact.inspection, installedImage: null },
    }),
    false,
  );
  assert.equal(transferArtifactUsable({ ...artifact, builder_version: 'unknown builder' }), false);
  assert.equal(
    transferArtifactUsable({ ...artifact, profile_id: 'legacy-integrated-profile' }),
    false,
  );
});

test('only administrators may create package artifacts', () => {
  assert.equal(packageBuildAllowed('ADMIN'), true);
  assert.equal(packageBuildAllowed('MEMBER'), false);
});

test('automatic backport preparation retries once when a clean package is newer than its failed profile job', () => {
  const failed = { state: 'ERROR', updated_at: '2026-10-08T07:48:20Z' };
  assert.equal(retryProfileAfterArtifact(failed, { created_at: '2026-10-08T12:41:13Z' }), true);
  assert.equal(retryProfileAfterArtifact(failed, { created_at: '2026-10-08T07:00:00Z' }), false);
  assert.equal(
    retryProfileAfterArtifact(
      { state: 'COMPLETED', updated_at: failed.updated_at },
      { created_at: '2026-10-08T12:41:13Z' },
    ),
    false,
  );
});

test('watched archives are capacity-checked before hashing or automatic preparation', () => {
  const expandedSize = 316_078_473_008,
    requiredBytes = 1_580_459_473_904;
  assert.equal(archiveBuildRequiredBytes(expandedSize), requiredBytes);
  assert.ok(requiredBytes > 100 * 1024 ** 3);
  assert.throws(() => archiveBuildRequiredBytes(Number.MAX_SAFE_INTEGER), /INPUT_TOO_LARGE/);
});

test('malformed stored password hashes fail closed', async () => {
  for (const stored of ['', 'missing-separator', 'salt:not-hex', 'salt:00'])
    assert.equal(await passwordMatches('password', stored), false);
});

test('save transport validation and quota accounting are shared', async () => {
  assert.equal(localUserId.parse('12345678'), '12345678');
  assert.equal(saveDirectory.parse('autosave'), 'autosave');
  assert.equal(savePlatform.parse('PS5'), 'PS5');
  for (const value of ['123', 'GGGGGGGG']) assert.throws(() => localUserId.parse(value));
  for (const value of ['../save', 'folder/save']) assert.throws(() => saveDirectory.parse(value));
  assert.throws(() => uploadChunk.parse({ offset: 0, data: '%%%=' }));
  let values: unknown[] = [];
  const used = await storageUsage(
    {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        for (const table of [
          'artifacts',
          'backport_artifacts',
          'game_media',
          'jobs',
          'save_backups',
          'portable_save_archives',
        ])
          assert.match(sql, new RegExp(`FROM ${table}\\b`));
        values = args;
        return { rows: [{ bytes: '42' }] };
      },
    } as any,
    { saveBackupId: 'backup', portableSaveId: 'portable' },
  );
  assert.equal(used, 42);
  assert.deepEqual(values, ['backup', 'portable']);
});

test('PS5 content versions keep all three numeric components', () => {
  const release = {
    key: 'dump',
    game: {
      title: 'Version check',
      titleId: 'PPSA15552',
      contentId: 'UP4016-PPSA15552_00-DEADCELLS0000000',
    },
    size: 1,
    format: 'folder',
    sha256: 'a'.repeat(64),
    location: 'dump',
  };
  for (const version of ['01.005.000', '01.008.001', '01.200.000', '01.00'])
    assert.equal(releaseSchema.parse({ ...release, version }).version, version);
  for (const version of ['1.5', '01.0005.000', '01.005.000x'])
    assert.throws(() => releaseSchema.parse({ ...release, version }));
});

test('existing dumps can report physical presence without claiming a full-file checksum', () => {
  const item = {
    titleId: 'PPSA03208',
    contentId: 'EP9000-PPSA03208_00-GHOSTSHIP0000000',
    title: 'Existing dump',
    version: '02.017.000',
    storageId: 'ext1',
    relativePath: 'PPSA03208-app0',
    available: true,
    registered: false,
    sha256: null,
    size: null,
    source: 'EXISTING_DUMP',
  };
  assert.equal(inventoryItem.parse(item).source, 'EXISTING_DUMP');
  assert.throws(() => inventoryItem.parse({ ...item, source: 'MANAGED' }));
  assert.throws(() =>
    inventoryItem.parse({ ...item, contentId: 'EP9000-PPSA99999_00-GHOSTSHIP0000000' }),
  );
});

test('browser aliases require explicit exact HTTP(S) origins', () => {
  const env = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost',
    BOOTSTRAP_TOKEN: 'test'.repeat(8),
    PUBLIC_URL: 'https://store.example',
  };
  assert.equal(
    configuration(env).TRUST_PROXY_HOPS,
    1,
    'HTTPS uses the bundled single-hop reverse proxy unless explicitly overridden',
  );
  assert.equal(
    configuration({ ...env, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS,
    0,
    'An explicit proxy trust override wins',
  );
  assert.equal(
    configuration({ ...env, PUBLIC_URL: 'http://store.example' }).TRUST_PROXY_HOPS,
    0,
    'Direct HTTP does not trust forwarded addresses by default',
  );
  assert.deepEqual(configuration(env).browserOrigins, ['https://store.example']);
  assert.throws(
    () => configuration({ ...env, COMMUNITY_MASTER_URL: 'https://store.example' }),
    /different origin/i,
  );
  assert.deepEqual(configuration(env).features, {
    companionApp: true,
    ps5Connections: true,
    accountRegistration: true,
    community: true,
    newDownloads: true,
    homeUpdateBridge: false,
  });
  assert.equal(configuration(env).HOME_UPDATE_AGENT_URL, '');
  assert.equal(
    configuration({ ...env, HOME_UPDATE_AGENT_URL: `http://${privateAddress}:37952` })
      .HOME_UPDATE_AGENT_URL,
    `http://${privateAddress}:37952`,
  );
  assert.equal(configuration({ ...env, OPERATOR_TOKEN: 'x'.repeat(32) }).OPERATOR_URL, '');
  assert.throws(
    () => configuration({ ...env, OPERATOR_URL: 'http://operator:3160' }),
    /OPERATOR_TOKEN/,
  );
  assert.equal(
    configuration({
      ...env,
      PACKAGE_WORKER_URL: 'http://host.docker.internal:3152',
      PACKAGE_WORKER_TOKEN: 'w'.repeat(64),
    }).PACKAGE_WORKER_URL,
    'http://host.docker.internal:3152',
  );
  assert.throws(
    () => configuration({ ...env, PACKAGE_WORKER_URL: 'http://host.docker.internal:3152' }),
    /PACKAGE_WORKER_TOKEN/,
  );
  for (const url of [
    'http://127.0.0.1:3152',
    'https://host.docker.internal:3152',
    'http://host.docker.internal:3152/path',
  ])
    assert.throws(() =>
      configuration({ ...env, PACKAGE_WORKER_URL: url, PACKAGE_WORKER_TOKEN: 'w'.repeat(64) }),
    );
  for (const url of [
    'http://127.0.0.1:37952',
    'http://example.com:37952',
    `https://${privateAddress}:37952`,
    `http://${privateAddress}:80`,
    `http://${privateAddress}:37952/path`,
  ])
    assert.throws(() => configuration({ ...env, HOME_UPDATE_AGENT_URL: url }));
  assert.deepEqual(
    configuration({
      ...env,
      ENABLE_COMPANION_APP: 'false',
      ENABLE_PS5_CONNECTIONS: 'false',
      ALLOW_ACCOUNT_REGISTRATION: 'false',
      ENABLE_COMMUNITY_FEATURES: 'false',
      ENABLE_NEW_DOWNLOADS: 'false',
      ENABLE_HOME_UPDATE_BRIDGE: 'true',
    }).features,
    {
      companionApp: false,
      ps5Connections: false,
      accountRegistration: false,
      community: false,
      newDownloads: false,
      homeUpdateBridge: true,
    },
  );
  assert.throws(() => configuration({ ...env, ENABLE_COMPANION_APP: 'yes' }));
  assert.deepEqual(
    configuration({ ...env, BROWSER_ORIGINS: ' http://localhost:3150, http://127.0.0.1:3150, ' })
      .browserOrigins,
    ['https://store.example', 'http://localhost:3150', 'http://127.0.0.1:3150'],
  );
  for (const origin of [
    '*',
    'https://*.example',
    'null',
    'file:///tmp',
    'ftp://store.example',
    'http://user:pass@localhost:3150',
    'http://localhost:3150/path',
    'http://localhost:3150?query=1',
  ]) {
    assert.throws(() => configuration({ ...env, BROWSER_ORIGINS: origin }));
  }
});

const release = {
  titleId: 'PPSA99999',
  contentId: 'IV0000-PPSA99999_00-PS5LIBRARYDEMO00',
  version: '01.00',
  sha256: 'a'.repeat(64),
  minimumFirmware: '10.01',
  format: 'ffpkg',
};
const consoleInfo = {
  firmware: '7.61',
  runtime: 'kstuff-lite',
  capabilities: { shadowMount: true, backportOverlay: true },
  shadowMountFakelib: true,
  standaloneBackPork: false,
  fakelibMode: 'full' as const,
};
test('compatibility requires exact release, input hash, firmware, runtime and tested profile', () => {
  assert.equal(compatibility(release, consoleInfo, []).status, 'BACKPORT_NOT_INDEXED');
  const profile = {
    id: 'profile',
    titleId: release.titleId,
    contentId: release.contentId,
    gameVersion: release.version,
    inputHashes: [release.sha256],
    targetFirmware: '7.61',
    runtime: 'kstuff-lite',
    installationMethod: 'SHADOWMOUNT',
    testedState: 'TESTED',
    requiredLibraries: [],
    requiredPatches: [],
  };
  assert.equal(
    compatibility(release, consoleInfo, [profile]).status,
    'MATCHING_BACKPORT_AVAILABLE',
  );
  assert.equal(
    compatibility({ ...release, sourceTreeSha256: 'c'.repeat(64) }, consoleInfo, [profile]).status,
    'BACKPORT_NO_MATCH',
    'A base-only profile cannot match a changed watched overlay',
  );
  assert.equal(
    compatibility({ ...release, sourceTreeSha256: 'c'.repeat(64) }, consoleInfo, [
      { ...profile, inputHashes: ['c'.repeat(64)] },
    ]).status,
    'MATCHING_BACKPORT_AVAILABLE',
    'The exact full-tree hash already binds the clean package and overlay',
  );
  assert.equal(
    compatibility({ ...release, sourceTreeSha256: 'c'.repeat(64) }, consoleInfo, [
      { ...profile, inputHashes: [release.sha256, 'c'.repeat(64)] },
    ]).status,
    'MATCHING_BACKPORT_AVAILABLE',
  );
  assert.equal(
    compatibility({ ...release, version: '01.01' }, consoleInfo, [profile]).status,
    'BACKPORT_NOT_INDEXED',
  );
  assert.equal(
    compatibility({ ...release, sha256: 'b'.repeat(64) }, consoleInfo, [profile]).status,
    'BACKPORT_NO_MATCH',
  );
  assert.equal(
    compatibility(release, { ...consoleInfo, firmware: '7.60' }, [profile]).status,
    'BACKPORT_NO_MATCH',
  );
  assert.equal(
    compatibility(release, consoleInfo, [{ ...profile, testedState: 'UNTESTED' }]).status,
    'BACKPORT_UNTESTED',
  );
  assert.equal(
    compatibility(release, { ...consoleInfo, standaloneBackPork: true }, [
      { ...profile, requiredLibraries: [{ path: 'fakelib/libc.prx' }] },
    ]).status,
    'RUNTIME_CONFLICT',
  );
  assert.equal(
    compatibility({ ...release, minimumFirmware: null }, consoleInfo, []).status,
    'UNKNOWN',
  );
  assert.equal(
    compatibility(release, { ...consoleInfo, firmware: '10.01' }, []).status,
    'NATIVE_COMPATIBLE',
  );
  for (const firmware of ['10.01', '12.00']) {
    const native = compatibility(release, { ...consoleInfo, firmware }, [profile]);
    assert.equal(native.backportRequired, false);
    assert.equal(native.profileId, null);
  }
  assert.equal(compatibility(release, consoleInfo, [profile]).backportRequired, true);
  for (const firmware of [null, '', '9.6', 'invalid'])
    assert.equal(
      compatibility(release, { ...consoleInfo, firmware }, [profile]).backportRequired,
      null,
    );
  assert.equal(
    compatibility({ ...release, format: 'pkg' }, consoleInfo, []).status,
    'UNSUPPORTED_METHOD',
  );
});
test('an exact integrated backport needs no external overlay', async () => {
  const pkg = { ...release, format: 'pkg' },
    oldRuntime = {
      ...consoleInfo,
      capabilities: { fpkgInstall: true, backportOverlay: false },
      standaloneBackPork: true,
    },
    runtime = {
      ...oldRuntime,
      capabilities: { ...oldRuntime.capabilities, integratedBackportProfiles: true },
    };
  const profile = profileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    titleId: release.titleId,
    contentId: release.contentId,
    gameVersion: release.version,
    inputHashes: [release.sha256],
    targetFirmware: '7.61',
    runtime: 'kstuff-lite',
    installationMethod: 'FPKG',
    delivery: 'INTEGRATED',
    testedState: 'UNTESTED',
    requiredLibraries: [],
    requiredPatches: [],
  });
  assert.equal(
    compatibility(pkg, oldRuntime, [profile]).status,
    'INTEGRATED_BACKPORT_AGENT_REQUIRED',
    'Old agents cannot receive integrated-profile tasks',
  );
  assert.deepEqual(compatibility(pkg, runtime, [profile]), {
    status: 'BACKPORT_UNTESTED',
    method: 'FPKG',
    profileId: profile.id,
    backportRequired: true,
    backportDelivery: 'INTEGRATED',
  });
  const files = await backportFiles(
    {
      query: async () => assert.fail('Integrated profiles must not query overlay artifacts'),
    } as any,
    {} as any,
    'release',
    release.sha256,
    profile,
  );
  assert.equal(files.placement, 'INTEGRATED');
  assert.equal(files.size, 0);
  assert.deepEqual(files.files, []);
  const unavailableOverlay = {
    ...profile,
    id: '22222222-2222-4222-8222-222222222222',
    delivery: 'OVERLAY' as const,
    testedState: 'TESTED',
    requiredLibraries: [{ path: 'fakelib/libc.prx', sha256: 'b'.repeat(64) }],
  };
  assert.equal(
    compatibility(pkg, runtime, [unavailableOverlay, profile]).profileId,
    profile.id,
    'A usable integrated profile wins over an unavailable overlay',
  );
  assert.throws(() =>
    profileSchema.parse({
      ...profile,
      requiredLibraries: [{ path: 'fakelib/libc.prx', sha256: 'b'.repeat(64) }],
    }),
  );
});

test('installed FPKG overlays require their capability and a mode suitable for their files', () => {
  const pkg = { ...release, format: 'pkg' };
  const profile = {
    id: 'profile',
    titleId: release.titleId,
    contentId: release.contentId,
    gameVersion: release.version,
    inputHashes: [release.sha256],
    targetFirmware: '7.61',
    runtime: 'kstuff-lite',
    installationMethod: 'FPKG',
    delivery: 'OVERLAY' as const,
    testedState: 'TESTED',
    requiredLibraries: [{ path: 'fakelib/libGameCompat.sprx' }],
    requiredPatches: [],
    requiredFiles: [],
  };
  const runtime = {
    ...consoleInfo,
    capabilities: {
      fpkgInstall: true,
      backportOverlay: true,
      fpkgBackportOverlay: true,
    },
  };

  assert.equal(compatibility(pkg, runtime, [profile]).status, 'MATCHING_BACKPORT_AVAILABLE');
  assert.equal(
    compatibility(
      pkg,
      { ...runtime, capabilities: { ...runtime.capabilities, fpkgBackportOverlay: false } },
      [profile],
    ).status,
    'BACKPORT_RUNTIME_UNAVAILABLE',
    'Generic ShadowMount overlays must not authorize installed-FPKG overlays',
  );
  for (const fakelibMode of ['emulators', 'disabled', null] as const)
    assert.equal(
      compatibility(pkg, { ...runtime, fakelibMode }, [profile]).status,
      'BACKPORT_RUNTIME_UNAVAILABLE',
    );
  const fileOnly = {
    ...profile,
    requiredLibraries: [],
    requiredFiles: [{ path: 'eboot.bin', sha256: 'b'.repeat(64) }],
  };
  assert.equal(
    compatibility(pkg, { ...runtime, fakelibMode: 'disabled' }, [fileOnly]).status,
    'MATCHING_BACKPORT_AVAILABLE',
    'Disabling fakelib must not disable ordinary app0 redirects',
  );
  assert.equal(
    compatibility(pkg, { ...runtime, fakelibMode: 'disabled', standaloneBackPork: true }, [
      fileOnly,
    ]).status,
    'MATCHING_BACKPORT_AVAILABLE',
    'Standalone fakelib conflicts must not block ordinary app0 redirects',
  );
  const emulatorsOnly = {
    ...profile,
    requiredLibraries: [{ path: 'fakelib/libSceAppContent.sprx' }],
  };
  assert.equal(
    compatibility(pkg, { ...runtime, fakelibMode: 'emulators' }, [emulatorsOnly]).status,
    'MATCHING_BACKPORT_AVAILABLE',
  );
});

test('heartbeat bounds ShadowMount per-title fakelib overrides', () => {
  const report = {
    runtime: 'kstuff-lite',
    clientVersion: 'test',
    agentVersion: 'test',
    capabilities: { fpkgBackportOverlay: true },
    storage: [],
    libraryRevision: 0,
    runtimeStatus: {
      fakelibDefaultMode: 'full',
      fakelibModes: { PPSA00001: 'disabled' },
    },
  };
  const parsed = heartbeatSchema.parse(report);
  assert.equal(parsed.capabilities.fpkgBackportOverlay, true);
  assert.equal(parsed.runtimeStatus.fakelibDefaultMode, 'full');
  assert.equal(parsed.runtimeStatus.fakelibModes.PPSA00001, 'disabled');
  assert.throws(() =>
    heartbeatSchema.parse({
      ...report,
      runtimeStatus: {
        ...report.runtimeStatus,
        fakelibModes: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [
            `PPSA${index.toString().padStart(5, '0')}`,
            'full',
          ]),
        ),
      },
    }),
  );
});

test('beta5 omits only incompatible installed-package fakelib files from delivery', () => {
  assert.equal(backportFileDelivered('FPKG', 'fakelib/libkernel.sprx'), false);
  assert.equal(backportFileDelivered('SHADOWMOUNT', 'fakelib2/LIBKERNEL.SPRX'), false);
  assert.equal(backportFileDelivered('FPKG', 'fakelib/libSceAmpr.sprx'), false);
  assert.equal(backportFileDelivered('FPKG', 'fakelib/libScePlayGo.sprx'), false);
  assert.equal(backportFileDelivered('SHADOWMOUNT', 'fakelib/libSceAmpr.sprx'), true);
  assert.equal(backportFileDelivered('FPKG', 'fakelib/nested/libkernel.sprx'), true);
  assert.equal(backportFileDelivered('FPKG', 'fakelib/libGameCompat.sprx'), true);
});
test('automatic profile failures have console-facing warnings', () => {
  for (const code of [
    'UNSUPPORTED_INPUT',
    'ENCRYPTED_INPUT',
    'INCOMPLETE_INPUT',
    'MISSING_ARCHIVE_PART',
    'CORRUPT_INPUT',
    'INPUT_TOO_LARGE',
    'SOURCE_CHANGED',
    'PROFILE_GENERATION_FAILED',
  ])
    assert.ok(backportMessages[code]);
  assert.ok(deterministicProfileFailures.includes('INPUT_TOO_LARGE'));
  assert.equal(
    profileDiscoveryContext('4.50', 'kstuff', 'a'.repeat(64)),
    'profile-v4:4.50:kstuff:' + 'a'.repeat(64),
  );
});
test('storage reserves all components, temporary bytes and margin', () => {
  const storage = { freeBytes: 1000, writable: true, installMethodsSupported: ['SHADOWMOUNT'] };
  assert.equal(
    planStorage(storage, 'SHADOWMOUNT', {
      game: 200,
      update: 100,
      backport: 50,
      temporary: 200,
      margin: 100,
    }).requiredBytes,
    650,
  );
  assert.equal(
    planStorage({ ...storage, freeBytes: 600 }, 'SHADOWMOUNT', { game: 650 }).allowed,
    false,
  );
  assert.equal(planStorage(storage, 'FPKG', { game: 1 }).allowed, false);
  assert.equal(planStorage(storage, 'FPKG', { game: 1 }).reason, 'UNSUPPORTED_METHOD');
  assert.equal(
    planStorage({ ...storage, writable: false }, 'SHADOWMOUNT', { game: 1 }).reason,
    'NOT_WRITABLE',
  );
  assert.equal(planStorage(storage, 'SHADOWMOUNT', { game: 1001 }).reason, 'INSUFFICIENT_SPACE');
  assert.equal(planStorage(storage, 'SHADOWMOUNT', { game: 1 }).reason, null);
  assert.throws(() => planStorage(storage, 'SHADOWMOUNT', { game: -1 }));
});
test('presence and metadata never fabricate facts', () => {
  assert.equal(presence(null, 100_000), 'OFFLINE');
  assert.equal(presence(90_000, 100_000), 'ONLINE');
  assert.equal(presence(30_000, 100_000), 'STALE');
  assert.equal(presence(0, 300_000), 'OFFLINE');
  assert.throws(
    () =>
      resolveMetadata([
        { rank: 1, data: { titleId: 'PPSA11111' } },
        { rank: 3, data: { titleId: 'PPSA22222' } },
      ]),
    /METADATA_MISMATCH/,
  );
  assert.equal(
    resolveMetadata([
      { rank: 3, data: { title: 'Source' } },
      { rank: 1, data: { title: 'Verified' } },
    ]).title,
    'Verified',
  );
});
test('trust boundaries reject path traversal, device filenames and private SSRF destinations', () => {
  for (const name of ['../x', 'a/b', 'a\\b', 'CON', 'NUL.pkg', 'a:stream', '.', 'x\n'])
    assert.throws(() => safeName(name));
  assert.equal(safeName('example.ffpkg'), 'example.ffpkg');
  for (const address of [
    '127.0.0.1',
    privateAddress,
    linkLocalAddress,
    '::1',
    '::ffff:127.0.0.1',
    'fc00:' + ':1',
  ])
    assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress(publicAddress), true);
});
test('repository credentials never follow a manifest URL to another origin', () => {
  process.env.REPOSITORY_TOKEN_CHECK = 'test-only';
  const source = {
    type: 'PRIVATE_HTTP' as const,
    name: 'Private',
    location: 'https://repo.example/library.json',
    tokenEnv: 'REPOSITORY_TOKEN_CHECK',
  };
  assert.deepEqual(sourceHeaders(source, 'https://cdn.example/game.elf'), {});
  assert.equal(
    sourceHeaders(source, 'https://repo.example/game.elf').authorization,
    'Bearer test-only',
  );
  delete process.env.REPOSITORY_TOKEN_CHECK;
});
