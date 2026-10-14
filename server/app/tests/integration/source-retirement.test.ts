import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { buildKey } from '../../src/jobs/preparation.js';
import { profileHash } from '../../src/library/backports.js';
import { runWorker } from '../../src/library/inspect.js';

test(
  'an admin can delete an exact watched dump only after its FPKG and backport verify',
  { timeout: 45000 },
  async () => {
    const temp = path.resolve(os.tmpdir()),
      root = await mkdtemp(path.join(temp, 'ps5library-retire-')),
      base = configuration({
        ...process.env,
        OPERATOR_URL: '',
        OPERATOR_TOKEN: '',
        COMMUNITY_MASTER_URL: '',
      }),
      adminDb = database(base.DATABASE_URL);
    const schema = `retire_${randomUUID().replaceAll('-', '')}`,
      url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: path.join(root, 'data'),
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: path.join(root, 'dumps'),
      DISK_MARGIN_BYTES: 0,
    };
    const db = database(config.DATABASE_URL);
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const call = async (method: 'GET' | 'POST', route: string, payload: unknown, token: string) =>
      app!.inject({
        method,
        url: `/api/v1${route}`,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    try {
      await adminDb.query(`CREATE SCHEMA ${schema}`);
      await mkdir(config.DUMP_ROOT, { recursive: true });
      app = await createApp(config);
      const owner = (
        await call(
          'POST',
          '/auth/register',
          {
            username: `owner-${randomUUID()}`,
            password: 'test-retirement-password',
            bootstrapToken: config.BOOTSTRAP_TOKEN,
          },
          '',
        )
      ).json();
      const invite = (await call('POST', '/admin/invites', {}, owner.token)).json();
      const member = (
        await call(
          'POST',
          '/auth/register',
          {
            username: `member-${randomUUID()}`,
            password: 'test-retirement-password',
            inviteToken: invite.token,
          },
          '',
        )
      ).json();
      const sourceId = randomUUID(),
        sourceReleaseId = randomUUID(),
        gameId = randomUUID(),
        releaseId = randomUUID(),
        profileId = randomUUID(),
        artifactId = randomUUID(),
        backportId = randomUUID();
      const titleId = 'PPSA99974',
        contentId = 'IV0000-PPSA99974_00-RETIREMENTTEST01',
        version = '01.005.000',
        dump = path.join(config.DUMP_ROOT, 'authorized-dump');
      const executable = Buffer.alloc(4096);
      executable.set([0x7f, 69, 76, 70, 2, 1, 1]);
      executable.writeUInt16LE(2, 16);
      executable.writeUInt16LE(62, 18);
      executable.writeUInt32LE(1, 20);
      executable.writeBigUInt64LE(0x400080n, 24);
      executable.writeBigUInt64LE(64n, 32);
      executable.writeUInt16LE(64, 52);
      executable.writeUInt16LE(56, 54);
      executable.writeUInt16LE(1, 56);
      executable.writeUInt32LE(1, 64);
      executable.writeUInt32LE(5, 68);
      executable.writeBigUInt64LE(0x400000n, 80);
      executable.writeBigUInt64LE(4096n, 96);
      executable.writeBigUInt64LE(4096n, 104);
      executable.writeBigUInt64LE(4096n, 112);
      executable[128] = 0xc3;
      await mkdir(path.join(dump, 'sce_sys'), { recursive: true });
      await mkdir(path.join(dump, 'backport'));
      await writeFile(
        path.join(dump, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId,
          contentId,
          contentVersion: version,
          masterVersion: '01.00',
          requiredSystemSoftwareVersion: '0x1200000000000000',
          localizedParameters: {
            defaultLanguage: 'en-US',
            'en-US': { titleName: 'Retirement fixture' },
          },
        }),
      );
      await writeFile(path.join(dump, 'eboot.bin'), executable);
      const overlay = path.join(dump, 'backport', 'compat.bin');
      await writeFile(overlay, 'exact overlay');
      const input = await runWorker(['hash-base-tree', dump]),
        release = {
          key: 'authorized-dump',
          game: {
            title: 'Retirement fixture',
            titleId,
            contentId,
            description: '',
            genres: [],
            platform: 'PS5',
          },
          version,
          kind: 'BASE',
          region: 'Unknown',
          languages: [],
          size: input.size,
          installedSize: input.size,
          minimumFirmware: '12.00',
          sdkVersion: null,
          format: 'folder',
          sha256: input.sha256,
          sourceTreeSha256: input.sourceTreeSha256,
          sourceTreeSize: input.sourceTreeSize,
          location: 'authorized-dump',
        };
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Watched games','WATCH_FOLDER',$3)",
        [
          sourceId,
          owner.user.id,
          { name: 'Watched games', type: 'WATCH_FOLDER', location: '.', shareCatalog: true },
        ],
      );
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,'Retirement fixture',$4)",
        [gameId, owner.user.id, titleId, release.game],
      );
      await db.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,'BASE',$5)",
        [
          releaseId,
          gameId,
          contentId,
          version,
          { ...release, game: undefined, location: undefined },
        ],
      );
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5)',
        [sourceReleaseId, sourceId, releaseId, 'authorized-dump', release],
      );
      const library = Buffer.from('verified fakelib fixture'),
        libraryHash = createHash('sha256').update(library).digest('hex');
      const profile = {
        id: profileId,
        titleId,
        contentId,
        gameVersion: version,
        inputHashes: [input.sha256, input.sourceTreeSha256],
        targetFirmware: '4.50',
        runtime: 'kstuff',
        installationMethod: 'FPKG',
        testedState: 'UNTESTED',
        requiredLibraries: [{ path: 'fakelib/libfixture.sprx', sha256: libraryHash }],
        requiredFiles: [],
        requiredPatches: [],
        notes: 'fixture',
      };
      await db.query(
        'INSERT INTO ' +
          'compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [profileId, owner.user.id, titleId, contentId, version, '4.50', 'kstuff', profile],
      );
      const pkg = Buffer.from('verified clean package'),
        pkgHash = createHash('sha256').update(pkg).digest('hex'),
        pkgRelative = `artifacts/${releaseId}/${pkgHash}.pkg`,
        pkgPath = path.join(config.DATA_DIR, pkgRelative);
      await mkdir(path.dirname(pkgPath), { recursive: true });
      await writeFile(pkgPath, pkg);
      await db.query(
        `INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash,builder_version,cache_key)
      VALUES($1,$2,'pkg',$3,$4,$5,true,$6,$7,'fixture-5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1',$8)`,
        [
          artifactId,
          releaseId,
          pkgRelative,
          pkgHash,
          pkg.length,
          {
            format: 'pkg',
            structurallyRecognized: true,
            metadataVerified: true,
            identity: { titleId, contentId, version, title: 'Retirement fixture' },
          },
          input.sha256,
          buildKey(input.sha256, 'FPKG'),
        ],
      );
      const backportRelative = `backports/${titleId}/${releaseId}/fixture`,
        backport = path.join(config.DATA_DIR, backportRelative);
      await mkdir(path.join(backport, 'fakelib'), { recursive: true });
      await mkdir(path.join(backport, 'sce_sys'));
      await writeFile(path.join(backport, 'fakelib', 'libfixture.sprx'), library);
      await writeFile(path.join(backport, 'sce_sys', 'param.json'), '{}');
      const backportDigest = await runWorker(['hash-tree', backport]);
      await db.query(
        `INSERT INTO backport_artifacts(
          id,
          game_id,
          release_id,
          title_id,
          game_version,
          target_firmware,
          type,
          source,
          sha256,
          size,
          profile_id,
          tested,
          input_hash,
          relative_path,
          profile_hash
        )
        VALUES(
          $1,$2,$3,$4,$5,'4.50','SHADOWMOUNT_FOLDER','DUMP',$6,$7,$8,false,$9,$10,$11
        )`,
        [
          backportId,
          gameId,
          releaseId,
          titleId,
          version,
          backportDigest.sha256,
          backportDigest.size,
          profileId,
          input.sha256,
          backportRelative,
          profileHash(profile as any),
        ],
      );
      const body = { confirm: 'RETIRE', inputSha256: input.sha256, profileId, deleteSource: true };
      assert.equal(
        (await call('POST', `/source-releases/${sourceReleaseId}/retire`, body, member.token))
          .statusCode,
        403,
        'Members cannot retire server input',
      );
      await writeFile(pkgPath, 'corrupt');
      const corrupt = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(corrupt.statusCode, 409, corrupt.body);
      assert.equal(corrupt.json().error, 'CACHE_CORRUPT');
      assert.ok(await stat(dump));
      await writeFile(pkgPath, pkg);
      const fabricated = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(fabricated.statusCode, 409, fabricated.body);
      assert.equal(fabricated.json().error, 'CACHE_CORRUPT');
      assert.ok(await stat(dump), 'Database labels cannot substitute for an inspected FPKG');
      const built = await runWorker([
        'build-verified',
        dump,
        path.join(root, 'package-build'),
        'FPKG',
        JSON.stringify({ titleId, contentId, version, title: 'Retirement fixture' }),
        releaseId,
        input.sha256,
        String(input.size),
      ]);
      await rm(pkgPath);
      await rename(built.outputPath, pkgPath);
      await db.query(
        'UPDATE artifacts SET sha256=$2,size=$3,inspection=$4,builder_version=$5 WHERE id=$1',
        [artifactId, built.sha256, built.size, built.inspection, built.builderVersion],
      );
      const omittedProfile = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        { confirm: 'RETIRE', inputSha256: input.sha256, deleteSource: true },
        owner.token,
      );
      assert.equal(omittedProfile.statusCode, 409, omittedProfile.body);
      assert.equal(omittedProfile.json().error, 'PROFILE_MISMATCH');
      assert.ok(
        await stat(dump),
        'Supplied backport files require their exact profile before source deletion',
      );
      await writeFile(path.join(backport, 'fakelib', 'libfixture.sprx'), 'corrupt');
      const corruptBackport = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(corruptBackport.statusCode, 409, corruptBackport.body);
      assert.equal(corruptBackport.json().error, 'BACKPORT_FILES_MISMATCH');
      assert.ok(await stat(dump));
      await writeFile(path.join(backport, 'fakelib', 'libfixture.sprx'), library);
      const changed = path.join(dump, 'changed-after-build');
      await writeFile(changed, 'changed');
      const changedSource = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(changedSource.statusCode, 409, changedSource.body);
      assert.equal(changedSource.json().error, 'SOURCE_CHANGED');
      assert.ok(await stat(dump), 'A failed post-move verification restores the dump');
      await assert.rejects(
        stat(path.join(config.DUMP_ROOT, '.ps5library-trash', sourceReleaseId, 'input')),
        { code: 'ENOENT' },
      );
      await rm(changed);
      await writeFile(overlay, 'changed overlay');
      const changedOverlay = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(changedOverlay.statusCode, 409, changedOverlay.body);
      assert.equal(changedOverlay.json().error, 'SOURCE_CHANGED');
      assert.ok(await stat(dump), 'Retirement also verifies the exact overlay tree');
      await writeFile(overlay, 'exact overlay');
      const retired = await call(
        'POST',
        `/source-releases/${sourceReleaseId}/retire`,
        body,
        owner.token,
      );
      assert.equal(retired.statusCode, 200, retired.body);
      assert.equal(retired.json().tested, false);
      await assert.rejects(stat(dump), { code: 'ENOENT' });
      const quarantine = path.join(config.DUMP_ROOT, '.ps5library-trash', sourceReleaseId, 'input');
      await assert.rejects(stat(quarantine), { code: 'ENOENT' });
      const stored = (
        await db.query('SELECT metadata FROM source_releases WHERE id=$1', [sourceReleaseId])
      ).rows[0].metadata;
      assert.ok(stored.retiredAt);
      assert.ok(stored.sourceRemovedAt);
      assert.equal(
        stored.quarantinePath,
        path.relative(config.DUMP_ROOT, quarantine).split(path.sep).join('/'),
      );
      const cached = await call(
        'POST',
        '/preparations',
        { sourceReleaseId, method: 'FPKG', profileId },
        owner.token,
      );
      assert.equal(cached.statusCode, 202, cached.body);
      assert.equal(
        cached.json().cached,
        true,
        'The retained package and backport remain usable without the dump',
      );
      const nativeSourceReleaseId = randomUUID(),
        nativeDump = path.join(config.DUMP_ROOT, 'native-dump');
      await mkdir(path.join(nativeDump, 'sce_sys'), { recursive: true });
      await writeFile(
        path.join(nativeDump, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId,
          contentId,
          contentVersion: version,
          masterVersion: '01.00',
          requiredSystemSoftwareVersion: '0x1200000000000000',
          localizedParameters: {
            defaultLanguage: 'en-US',
            'en-US': { titleName: 'Retirement fixture' },
          },
        }),
      );
      await writeFile(path.join(nativeDump, 'eboot.bin'), executable);
      const nativeInput = await runWorker(['hash-base-tree', nativeDump]);
      assert.equal(nativeInput.sha256, input.sha256);
      assert.equal(nativeInput.sourceTreeSha256, input.sha256);
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5)',
        [
          nativeSourceReleaseId,
          sourceId,
          releaseId,
          'native-dump',
          {
            ...release,
            key: 'native-dump',
            location: 'native-dump',
            sourceTreeSha256: nativeInput.sourceTreeSha256,
            sourceTreeSize: nativeInput.sourceTreeSize,
          },
        ],
      );
      const nativeRetired = await call(
        'POST',
        `/source-releases/${nativeSourceReleaseId}/retire`,
        { confirm: 'RETIRE', inputSha256: nativeInput.sha256, deleteSource: true },
        owner.token,
      );
      assert.equal(nativeRetired.statusCode, 200, nativeRetired.body);
      assert.equal(nativeRetired.json().backportId, null);
      assert.equal(nativeRetired.json().sourceDeleted, true);
      await assert.rejects(stat(nativeDump), { code: 'ENOENT' });
      const nativeCached = await call(
        'POST',
        '/preparations',
        { sourceReleaseId: nativeSourceReleaseId, method: 'FPKG' },
        owner.token,
      );
      assert.equal(nativeCached.statusCode, 202, nativeCached.body);
      assert.equal(
        nativeCached.json().cached,
        true,
        'A native clean FPKG remains usable after its dump is deleted',
      );
      const scan = await call('POST', `/sources/${sourceId}/sync`, {}, owner.token);
      assert.equal(scan.statusCode, 200, scan.body);
      assert.deepEqual(
        scan.json().artworkErrors,
        [],
        'Retired input is not reopened by later scans',
      );
      await db.query('UPDATE artifacts SET verified=false WHERE id=$1', [artifactId]);
      const rebuild = await call(
        'POST',
        '/preparations',
        { sourceReleaseId, method: 'FPKG', profileId },
        owner.token,
      );
      assert.equal(rebuild.statusCode, 409, rebuild.body);
      assert.equal(rebuild.json().error, 'SOURCE_RETIRED');
    } finally {
      await app?.close();
      await db.end();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminDb.end();
      assert.ok(root.startsWith(temp + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
