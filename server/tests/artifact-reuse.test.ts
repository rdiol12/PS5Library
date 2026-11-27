import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { artifactBuildKey, publishArtifact } from '../src/jobs/preparation.js';
import { profileHash } from '../src/library/backports.js';

const compact = (source: string) => source.replace(/\s+/g, '');

test('FPKG cache identity follows embedded game bytes, independently of external libraries and runtime', () => {
  assert.equal(
    artifactBuildKey('d800f410f123366274d3033df5ec1cbaf236a7c5ad850b21a1d6f5f755d09051', 'FPKG'),
    '23f051820f14e6e0ee5cdb8b4cf90e36d793f7ebdd9556f1d3d4a3e5540e222a',
    'Existing clean FPKGs keep their cache identity',
  );
  const source = 'a'.repeat(64),
    profile: any = {
      id: randomUUID(),
      delivery: 'OVERLAY',
      installationMethod: 'FPKG',
      targetFirmware: '4.50',
      runtime: 'kstuff',
      requiredLibraries: [],
      requiredPatches: [],
      requiredFiles: [{ path: 'eboot.bin', sha256: 'b'.repeat(64) }],
    };
  const key = artifactBuildKey(source, 'FPKG', profile);
  assert.notEqual(key, artifactBuildKey(source, 'FPKG'));
  assert.equal(
    key,
    artifactBuildKey(source, 'FPKG', {
      ...profile,
      id: randomUUID(),
      runtime: 'ShadowMountPlus',
      requiredFiles: [
        ...profile.requiredFiles,
        { path: 'fakelib/libSceAgc.sprx', sha256: 'c'.repeat(64) },
      ],
    }),
  );
  assert.notEqual(
    key,
    artifactBuildKey(source, 'FPKG', {
      ...profile,
      requiredFiles: [{ path: 'eboot.bin', sha256: 'd'.repeat(64) }],
    }),
  );
});

test('publishing freshly verified output skips the second read but rejects a changed file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-publish-check-'));
  try {
    const file = path.join(root, 'verified.pkg');
    await writeFile(file, 'verified fixture');
    const info = await stat(file),
      stages: unknown[] = [];
    const db: any = {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('UPDATE jobs')) stages.push(args[1]);
        return { rows: [], rowCount: 1 };
      },
      connect: async () => {
        throw new Error('PUBLISH_TRANSACTION_REACHED');
      },
    };
    const row = {
      kind: 'BUILD',
      id: randomUUID(),
      release_id: randomUUID(),
      title: 'Publish fixture',
      title_id: 'PPSA99999',
      version: '01.000.000',
      release_kind: 'BASE',
      config: { method: 'FPKG' },
    };
    const result = {
      outputPath: file,
      format: 'pkg',
      size: info.size,
      sha256: createHash('sha256').update('verified fixture').digest('hex'),
      inputHash: 'a'.repeat(64),
      verifiedOutputMtimeMs: Math.trunc(info.mtimeMs),
      libraryPolicy: 'FPKG_EMBEDDED_GAMEFILES_EXTERNAL_LIBRARIES',
      builderVersion: '5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1',
    };
    await assert.rejects(
      publishArtifact(db, { DATA_DIR: root } as any, row, result),
      /PUBLISH_TRANSACTION_REACHED/,
    );
    assert.deepEqual(stages, [], 'No full-file publish hash pass');
    const profile: any = {
      id: randomUUID(),
      delivery: 'OVERLAY',
      installationMethod: 'FPKG',
      targetFirmware: '4.50',
      inputHashes: [result.inputHash],
      requiredFiles: [],
      requiredLibraries: [],
      requiredPatches: [],
    };
    await assert.rejects(
      publishArtifact(
        db,
        { DATA_DIR: root } as any,
        { ...row, config: { ...row.config, profile } },
        {
          ...result,
          profileId: profile.id,
          profileHash: profileHash(profile),
          inspection: { identity: { minimumFirmware: '18.00' } },
        },
      ),
      (error: any) => error.code === 'BACKPORT_PATCH_MISSING',
    );
    await writeFile(file, 'modified fixture');
    await utimes(file, info.atime, new Date(info.mtimeMs + 2000));
    await assert.rejects(
      publishArtifact(db, { DATA_DIR: root } as any, row, result),
      /CACHE_CORRUPT/,
    );
  } finally {
    assert.ok(root.startsWith(os.tmpdir() + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('verified artifacts are reused by regular-file type and recorded size without another SHA-256 pass', async () => {
  const download = await readFile('server/src/api/app.ts', 'utf8');
  const transfer = await readFile('server/src/transfers/routes.ts', 'utf8');
  const downloadReuse = download.slice(
    download.indexOf('  const enqueueDownload = async'),
    download.indexOf('  await catalogRoutes'),
  );
  const transferReuse = transfer.slice(
    transfer.indexOf('  const enqueue = async'),
    transfer.indexOf("  app.post('/api/v1/transfers'"),
  );

  assert.match(
    downloadReuse.replace(/\s+/g, ' '),
    /fileStat\?\.isFile\(\)\s*&&\s*fileStat\.size\s*===\s*Number\(cached\.size\)/,
  );
  assert.doesNotMatch(downloadReuse, /fileHash\(/);
  assert.match(
    transferReuse.replace(/\s+/g, ' '),
    /before\.isFile\(\)\s*\|\|\s*before\.size\s*!==\s*Number\(artifact\.size\)/,
  );
  assert.doesNotMatch(transferReuse, /fileHash\(/);
  const artifactDownload = transfer.slice(
    transfer.indexOf("  app.get('/api/v1/device/artifacts/:id'"),
  );
  assert.match(
    compact(artifactDownload),
    /serveStoredFile\(req,reply,file,Number\(a\.size\),a\.sha256,'application\/octet-stream',config\.DATA_DIR,?\)/,
  );
});
