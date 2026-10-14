import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { updateRoutes } from '../src/updates/routes.js';
import { seal } from '../src/auth/credentials.js';
import { nativeUpdateFolder, xml } from '../src/updates/native.js';

const homeUpdateAgent = `http://${['10', '0', '0', '1'].join('.')}:37952`;

test('native update XML attributes escape every reserved character', () => {
  assert.equal(xml(`A&B<C>D"E'F`), 'A&amp;B&lt;C&gt;D&quot;E&apos;F');
});

const nativeDelta = () => {
  const delta = Buffer.alloc(0x204);
  Buffer.from([0x7f, 0x43, 0x4e, 0x54]).copy(delta);
  delta.writeUInt32BE(8, 0x10);
  delta.writeUInt16BE(6, 0x14);
  delta.writeBigUInt64BE(0x100n, 0x20);
  delta.writeBigUInt64BE(0x100n, 0x28);
  Buffer.from('UP9000-PPSA99051_00-PS5LIBRARYHOMETE').copy(delta, 0x40);
  delta.writeUInt32BE(0x23, 0x74);
  Buffer.from([0x7f, 0x52, 0x4c, 0x43]).copy(delta, 0x200);
  return delta;
};

test('OpenStory Home and direct updates are isolated by title and exact installed base', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openstory-home-update-')),
    app = Fastify(),
    title = 'PPSA99783',
    content = 'UP9000-PPSA99783_00-OPENSTORYPS50000';
  const directory = path.join(root, 'native-updates', nativeUpdateFolder(title)),
    pkg = Buffer.alloc(65536, 19),
    crc = Buffer.alloc(4, 7),
    delta = nativeDelta();
  delta.fill(0, 0x40, 0x64);
  delta.write(content, 0x40, 'ascii');
  const sha = (data: Buffer, algorithm = 'sha256') =>
    createHash(algorithm).update(data).digest('hex');
  const metadata = {
    schemaVersion: 1,
    titleId: title,
    contentId: content,
    contentVersion: '01.000.003',
    baseContentVersion: '01.000.002',
    revision: 1,
    systemVersion: 0,
    package: {
      size: pkg.length,
      sha256: sha(pkg),
      sha1: sha(pkg, 'sha1'),
      digest: 'ab'.repeat(32),
    },
    playgo: { size: crc.length, sha256: sha(crc) },
    delta: { size: delta.length, sha256: sha(delta) },
  };
  try {
    await mkdir(path.join(directory, 'releases'), { recursive: true });
    for (const [name, data] of [
      [`${sha(pkg)}.pkg`, pkg],
      [`${sha(crc)}.crc`, crc],
      [`${sha(delta)}.delta.pkg`, delta],
    ] as const)
      await writeFile(path.join(directory, name), data);
    await writeFile(
      path.join(directory, 'icon.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await writeFile(path.join(directory, 'latest.json'), JSON.stringify(metadata));
    await writeFile(path.join(directory, 'releases/1.json'), JSON.stringify(metadata));
    await updateRoutes(
      app,
      { DATA_DIR: root, PUBLIC_URL: 'http://library.test:3150' } as any,
      {
        device: async (req: any) => {
          if (req.headers.authorization !== 'Bearer paired-console')
            throw Object.assign(Error('UNAUTHORIZED'), { statusCode: 401 });
          return {};
        },
      } as any,
    );
    const feed = await app.inject({
      url: `/api/v1/native-updates/${title}/from/01.000.002/version.xml`,
    });
    assert.equal(feed.statusCode, 200);
    assert.match(feed.payload, /content_id="UP9000-PPSA99783_00-OPENSTORYPS50000"/);
    assert.equal(
      (await app.inject({ url: `/api/v1/native-updates/${title}/version.xml` })).statusCode,
      404,
      'Game feeds require an exact installed base',
    );
    assert.doesNotMatch(
      (await app.inject({ url: `/api/v1/native-updates/${title}/from/01.000.001/version.xml` }))
        .payload,
      /manifest_url|delta_url/,
    );
    assert.doesNotMatch(
      (await app.inject({ url: '/api/v1/native-updates/PPSA99051/version.xml' })).payload,
      /manifest_url|delta_url/,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/device/native-updates?baseContentVersion=01.000.002',
          headers: { authorization: 'Bearer paired-console' },
        })
      ).json(),
      null,
      'The storefront app updater must not offer a game update',
    );
    const manifestUrl = /manifest_url="([^"]+)"/.exec(feed.payload)![1]!;
    const manifest = (await app.inject({ url: new URL(manifestUrl).pathname })).json();
    assert.match(manifest.pieces[0].url, /PPSA99783/);
    const bytes = await app.inject({
      url: new URL(manifest.pieces[0].url).pathname,
      headers: { range: 'bytes=5-' },
    });
    assert.equal(bytes.statusCode, 206);
    assert.deepEqual(bytes.rawPayload, pkg.subarray(5));
    const install = '/api/v1/device/native-updates/install',
      headers = { authorization: 'Bearer paired-console' },
      payload = { titleId: title, baseContentVersion: '01.000.002' };
    assert.equal((await app.inject({ method: 'POST', url: install, payload })).statusCode, 401);
    const direct = await app.inject({ method: 'POST', url: install, headers, payload });
    assert.equal(direct.statusCode, 200, direct.body);
    assert.deepEqual(direct.json(), {
      titleId: title,
      contentId: content,
      title: 'OpenStory',
      baseContentVersion: '01.000.002',
      contentVersion: '01.000.003',
      revision: 1,
      size: pkg.length,
      sha256: sha(pkg),
      packageUrl: `/api/v1/native-updates/${title}/1/packages/${sha(pkg)}.pkg`,
      iconUrl: `/api/v1/native-updates/${title}/icon.png`,
    });
    assert.deepEqual(
      (await app.inject({ url: direct.json().iconUrl })).rawPayload,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: install,
          headers,
          payload: { ...payload, baseContentVersion: '01.000.001' },
        })
      ).statusCode,
      409,
    );
    assert.notEqual(
      (
        await app.inject({
          method: 'POST',
          url: install,
          headers,
          payload: { baseContentVersion: '01.000.002' },
        })
      ).statusCode,
      200,
    );
    assert.notEqual(
      (
        await app.inject({
          method: 'POST',
          url: install,
          headers,
          payload: { ...payload, titleId: 'PPSA99999' },
        })
      ).statusCode,
      200,
    );
    assert.notEqual(
      (
        await app.inject({
          method: 'POST',
          url: install,
          headers,
          payload: { ...payload, title: 'Spoofed', iconUrl: 'https://attacker.invalid/icon.png' },
        })
      ).statusCode,
      200,
    );
    await writeFile(
      path.join(directory, 'latest.json'),
      JSON.stringify({
        ...metadata,
        titleId: 'PPSA99051',
        contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
      }),
    );
    assert.equal(
      (await app.inject({ url: `/api/v1/native-updates/${title}/from/01.000.002/version.xml` }))
        .statusCode,
      409,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Home update bridge redirects an exact release only while enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-home-bridge-')),
    app = Fastify(),
    title = 'PPSA99783',
    content = 'UP9000-PPSA99783_00-OPENSTORYPS50000';
  const directory = path.join(root, 'native-updates', nativeUpdateFolder(title)),
    pkg = Buffer.alloc(65536, 23),
    crc = Buffer.alloc(4, 9),
    delta = nativeDelta();
  delta.fill(0, 0x40, 0x64);
  delta.write(content, 0x40, 'ascii');
  const sha = (data: Buffer, algorithm = 'sha256') =>
    createHash(algorithm).update(data).digest('hex');
  const metadata = {
    schemaVersion: 1,
    titleId: title,
    contentId: content,
    contentVersion: '01.000.003',
    baseContentVersion: '01.000.002',
    revision: 1,
    systemVersion: 0,
    package: {
      size: pkg.length,
      sha256: sha(pkg),
      sha1: sha(pkg, 'sha1'),
      digest: 'ab'.repeat(32),
    },
    playgo: { size: crc.length, sha256: sha(crc) },
    delta: { size: delta.length, sha256: sha(delta) },
  };
  const config = {
    DATA_DIR: root,
    PUBLIC_URL: 'http://library.test:3150',
    HOME_UPDATE_AGENT_URL: homeUpdateAgent,
    features: { homeUpdateBridge: true },
  };
  try {
    await mkdir(path.join(directory, 'releases'), { recursive: true });
    for (const [name, data] of [
      [`${sha(pkg)}.pkg`, pkg],
      [`${sha(crc)}.crc`, crc],
      [`${sha(delta)}.delta.pkg`, delta],
    ] as const)
      await writeFile(path.join(directory, name), data);
    await writeFile(path.join(directory, 'latest.json'), JSON.stringify(metadata));
    await updateRoutes(app, config as any, { device: async () => ({}) } as any);
    const url = `/api/v1/native-updates/${title}/from/01.000.002/version.xml`,
      bridged = await app.inject({ url });
    assert.equal(bridged.statusCode, 307);
    assert.equal(
      bridged.headers.location,
      `${homeUpdateAgent}/api/v1/agent/home-update/${title}/01.000.002`,
    );
    assert.doesNotMatch(
      (await app.inject({ url: `/api/v1/native-updates/${title}/from/01.000.001/version.xml` }))
        .payload,
      /manifest_url|delta_url/,
    );
    config.features.homeUpdateBridge = false;
    const fallback = await app.inject({ url });
    assert.equal(fallback.statusCode, 200);
    assert.match(fallback.payload, /manifest_url=/);
    config.features.homeUpdateBridge = true;
    config.HOME_UPDATE_AGENT_URL = '';
    assert.equal((await app.inject({ url })).statusCode, 200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('device updates are authenticated, immutable and support verified resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-update-'));
  const app = Fastify();
  const auth = {
    device: async (req: any) => {
      if (req.headers.authorization !== 'Bearer paired-console')
        throw Object.assign(Error('UNAUTHORIZED'), { statusCode: 401 });
      return {};
    },
  };
  try {
    await updateRoutes(app, { DATA_DIR: root } as any, auth as any);
    const shell = await app.inject({ url: '/api/v1/native-updates/PPSA99051/version.xml' });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.headers['content-type'] ?? '', /^application\/xml/);
    assert.match(shell.payload, /<title_patch[^>]+nptitleid="PPSA99051_00"/);
    assert.match(shell.payload, /content_id="UP9000-PPSA99051_00-PS5LIBRARYHOMETE"/);
    assert.doesNotMatch(
      shell.payload,
      /manifest_url|delta_url/,
      'No native patch package is advertised before one is published',
    );
    const headers = { authorization: 'Bearer paired-console' };
    const absent = await app.inject({ url: '/api/v1/device/updates', headers });
    assert.equal(absent.json(), null);
    // Older json-c clients require a delimiter after a top-level scalar.
    assert.match(absent.payload, /^null\s+$/);
    const data = Buffer.concat([Buffer.from([127, 69, 76, 70]), Buffer.alloc(100, 37)]);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const payload = JSON.stringify({
      schemaVersion: 1,
      product: 'PS5Library',
      build: 2026091602,
      version: '0.2.1',
      sha256,
      size: data.length,
    });
    const key = generateKeyPairSync('ed25519');
    const envelope = {
      payload,
      signature: sign(null, Buffer.from(payload), key.privateKey).toString('hex'),
    };
    await mkdir(path.join(root, 'updates'));
    await writeFile(path.join(root, 'updates', sha256 + '.elf'), data);
    await writeFile(path.join(root, 'updates/latest.json'), JSON.stringify(envelope));
    assert.equal((await app.inject({ url: '/api/v1/device/updates' })).statusCode, 401);
    assert.deepEqual(
      (await app.inject({ url: '/api/v1/device/updates', headers })).json(),
      envelope,
    );
    const url = '/api/v1/device/updates/' + sha256;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const resumed = await app.inject({
      url,
      headers: { ...headers, range: 'bytes=20-', 'if-range': '"' + sha256 + '"' },
    });
    assert.equal(resumed.statusCode, 206);
    assert.deepEqual(resumed.rawPayload, data.subarray(20));
    assert.equal(resumed.headers['content-range'], 'bytes 20-103/104');
    assert.equal(
      (await app.inject({ url, headers: { ...headers, range: 'bytes=999-' } })).statusCode,
      416,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/device/updates/' + '0'.repeat(64), headers })).statusCode,
      404,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native title updates use a verified PS5 package manifest and resumable package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-native-update-'));
  const app = Fastify();
  const auth = { device: async () => ({}) };
  try {
    const release = path.join(root, 'native-updates', nativeUpdateFolder('PPSA99051'));
    const pkg = Buffer.alloc(0x10000);
    Buffer.from('verified PS5Library update package').copy(pkg);
    const crc = Buffer.alloc(4, 37);
    const delta = nativeDelta();
    const packageSha256 = createHash('sha256').update(pkg).digest('hex');
    const packageSha1 = createHash('sha1').update(pkg).digest('hex');
    const packageDigest = 'ab'.repeat(32);
    const crcSha256 = createHash('sha256').update(crc).digest('hex');
    const deltaSha256 = createHash('sha256').update(delta).digest('hex');
    await mkdir(path.join(release, 'releases'), { recursive: true });
    await writeFile(path.join(release, `${packageSha256}.pkg`), pkg);
    await writeFile(path.join(release, `${crcSha256}.crc`), crc);
    await writeFile(path.join(release, `${deltaSha256}.delta.pkg`), delta);
    await writeFile(path.join(release, 'icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const metadata = {
      schemaVersion: 1,
      titleId: 'PPSA99051',
      contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
      contentVersion: '01.001.000',
      baseContentVersion: '01.000.000',
      revision: 1,
      systemVersion: 0,
      package: {
        size: pkg.length,
        sha256: packageSha256,
        sha1: packageSha1,
        digest: packageDigest,
      },
      playgo: { size: crc.length, sha256: crcSha256 },
      delta: { size: delta.length, sha256: deltaSha256 },
    };
    await writeFile(path.join(release, 'latest.json'), JSON.stringify(metadata));
    await writeFile(path.join(release, 'releases', '1.json'), JSON.stringify(metadata));
    const config: any = {
      DATA_DIR: root,
      PUBLIC_URL: 'http://library.test:3150',
      features: { homeUpdateBridge: false },
      HOME_UPDATE_AGENT_URL: '',
    };
    await updateRoutes(app, config, auth as any);
    const version = await app.inject({ url: '/api/v1/native-updates/PPSA99051/version.xml' });
    assert.equal(version.statusCode, 200);
    assert.match(
      (await app.inject({ url: '/api/v1/native-updates/PPSA99051/from/01.000.000/version.xml' }))
        .payload,
      /manifest_url/,
    );
    assert.doesNotMatch(
      (await app.inject({ url: '/api/v1/native-updates/PPSA99051/from/00.999.000/version.xml' }))
        .payload,
      /manifest_url|delta_url/,
      'A patch must only be offered to its exact base version',
    );
    const deviceUpdate = await app.inject({
      url: '/api/v1/device/native-updates?baseContentVersion=01.000.000',
    });
    assert.deepEqual(deviceUpdate.json(), {
      titleId: 'PPSA99051',
      baseContentVersion: '01.000.000',
      contentVersion: '01.001.000',
      revision: 1,
      size: pkg.length,
    });
    assert.equal(
      (
        await app.inject({ url: '/api/v1/device/native-updates?baseContentVersion=00.999.000' })
      ).json(),
      null,
      'Settings discovery must not offer a release built for a different installed base',
    );
    assert.deepEqual(
      (await app.inject({ url: '/api/v1/device/native-updates' })).json(),
      deviceUpdate.json(),
      'Unqualified discovery remains available to already-published clients',
    );
    const direct = await app.inject({
      method: 'POST',
      url: '/api/v1/device/native-updates/install',
      payload: { titleId: 'PPSA99051', baseContentVersion: '01.000.000' },
    });
    assert.equal(direct.statusCode, 200, direct.body);
    assert.deepEqual(direct.json(), {
      titleId: 'PPSA99051',
      contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
      title: 'PS5Library',
      baseContentVersion: '01.000.000',
      contentVersion: '01.001.000',
      revision: 1,
      size: pkg.length,
      sha256: packageSha256,
      packageUrl: `/api/v1/native-updates/PPSA99051/1/packages/${packageSha256}.pkg`,
      iconUrl: '/api/v1/native-updates/PPSA99051/icon.png',
    });
    assert.equal((await app.inject({ url: direct.json().iconUrl })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/device/native-updates/install',
          payload: { titleId: 'PPSA99051', baseContentVersion: '00.999.000' },
        })
      ).statusCode,
      409,
    );
    assert.notEqual(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/device/native-updates/install',
          payload: {
            titleId: 'PPSA99051',
            baseContentVersion: '01.000.000',
            packageUrl: 'https://attacker.invalid/x.pkg',
          },
        })
      ).statusCode,
      200,
    );
    const manifestPath = /manifest_url="([^"]+)"/.exec(version.payload)?.[1];
    const deltaPath = /delta_url="([^"]+)"/.exec(version.payload)?.[1];
    const digest = /digest="([a-f0-9]{64})"/.exec(version.payload)?.[1];
    assert.ok(manifestPath);
    assert.ok(deltaPath);
    assert.ok(digest);
    const deltaResponse = await app.inject({
      url: new URL(deltaPath).pathname,
      headers: { range: 'bytes=9-' },
    });
    assert.equal(deltaResponse.statusCode, 206);
    assert.deepEqual(deltaResponse.rawPayload, delta.subarray(9));
    const manifest = await app.inject({ url: new URL(manifestPath).pathname });
    assert.equal(manifest.statusCode, 200);
    assert.equal(createHash('sha256').update(manifest.rawPayload).digest('hex'), digest);
    const body = manifest.json();
    assert.equal(body.originalFileSize, pkg.length);
    assert.equal(body.packageDigest, packageDigest.toUpperCase());
    assert.equal(body.pieces[0].hashValue, packageSha256);
    assert.equal(body.pieces[0].hashValue.length, 64);
    assert.equal(body.playgoChunkCrcHashValue, crcSha256);
    const packageResponse = await app.inject({
      url: new URL(body.pieces[0].url).pathname,
      headers: { range: 'bytes=9-' },
    });
    assert.equal(packageResponse.statusCode, 206);
    assert.deepEqual(packageResponse.rawPayload, pkg.subarray(9));
    const crcResponse = await app.inject({
      url: new URL(body.playgoChunkCrcUrl).pathname,
      headers: { range: `bytes=0-${crc.length - 2}` },
    });
    const crcTail = await app.inject({
      url: new URL(body.playgoChunkCrcUrl).pathname,
      headers: { range: `bytes=${crc.length - 1}-${crc.length - 1}` },
    });
    assert.equal(crcResponse.statusCode, 206);
    assert.equal(crcResponse.headers['content-range'], `bytes 0-${crc.length - 2}/${crc.length}`);
    assert.deepEqual(crcResponse.rawPayload, crc.subarray(0, -1));
    assert.equal(crcTail.statusCode, 206);
    assert.deepEqual(crcTail.rawPayload, crc.subarray(-1));
    assert.equal(
      (await app.inject({ url: `/api/v1/native-updates/PPSA99051/packages/${packageSha256}.pkg` }))
        .statusCode,
      404,
      'Mutable latest-package URLs are not exposed',
    );
    assert.equal(
      (await app.inject({ url: `/api/v1/native-updates/PPSA99051/playgo/${crcSha256}.crc` }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `/api/v1/native-updates/PPSA99051/delta/${deltaSha256}.pkg` }))
        .statusCode,
      404,
    );
    config.features.homeUpdateBridge = true;
    config.HOME_UPDATE_AGENT_URL = homeUpdateAgent;
    const mismatched = await app.inject({
      url: '/api/v1/native-updates/PPSA99051/from/00.999.000/version.xml',
    });
    assert.equal(mismatched.statusCode, 200);
    assert.doesNotMatch(
      mismatched.payload,
      /manifest_url|delta_url/,
      'A mismatched base must never reach the update agent',
    );
    const current = await app.inject({
      url: '/api/v1/native-updates/PPSA99051/from/01.001.000/version.xml',
    });
    assert.equal(current.statusCode, 200);
    assert.doesNotMatch(
      current.payload,
      /manifest_url|delta_url/,
      'The installed target version must not requeue its own patch',
    );
    await rm(path.join(release, 'latest.json'));
    assert.equal(
      (await app.inject({ url: new URL(manifestPath).pathname })).statusCode,
      200,
      'An in-flight release stays addressable after the advertised pointer changes',
    );
    assert.equal((await app.inject({ url: new URL(body.pieces[0].url).pathname })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: new URL(body.playgoChunkCrcUrl).pathname })).statusCode,
      200,
    );
    assert.equal((await app.inject({ url: new URL(deltaPath).pathname })).statusCode, 200);
    const changed = Buffer.from(pkg);
    changed[0] ^= 0xff;
    await writeFile(path.join(release, `${packageSha256}.pkg`), changed);
    assert.equal(
      (await app.inject({ url: new URL(manifestPath).pathname })).statusCode,
      409,
      'A changed package invalidates the verified release cache',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native title updater refuses a package that is not aligned to its 64-KiB CRC blocks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-native-update-alignment-')),
    app = Fastify(),
    pkg = Buffer.from('not block aligned'),
    crc = Buffer.alloc(4),
    delta = Buffer.from('delta');
  try {
    const release = path.join(root, 'native-updates', 'PS5Library [PPSA99051]'),
      packageSha256 = createHash('sha256').update(pkg).digest('hex'),
      crcSha256 = createHash('sha256').update(crc).digest('hex'),
      deltaSha256 = createHash('sha256').update(delta).digest('hex');
    await mkdir(release, { recursive: true });
    await writeFile(path.join(release, `${packageSha256}.pkg`), pkg);
    await writeFile(path.join(release, `${crcSha256}.crc`), crc);
    await writeFile(path.join(release, `${deltaSha256}.delta.pkg`), delta);
    await writeFile(
      path.join(release, 'latest.json'),
      JSON.stringify({
        schemaVersion: 1,
        titleId: 'PPSA99051',
        contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
        contentVersion: '01.001.000',
        baseContentVersion: '01.000.000',
        revision: 1,
        systemVersion: 0,
        package: {
          size: pkg.length,
          sha256: packageSha256,
          sha1: createHash('sha1').update(pkg).digest('hex'),
          digest: 'ab'.repeat(32),
        },
        playgo: { size: crc.length, sha256: crcSha256 },
        delta: { size: delta.length, sha256: deltaSha256 },
      }),
    );
    await updateRoutes(
      app,
      { DATA_DIR: root, PUBLIC_URL: 'http://library.test:3150' } as any,
      { device: async () => ({}) } as any,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/native-updates/PPSA99051/version.xml' })).statusCode,
      409,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('paired consoles obtain a private Master activation without exposing their local ID', async () => {
  const app = Fastify(),
    bootstrap = 'b'.repeat(64),
    nodeToken = 'c'.repeat(64),
    queries: string[] = [];
  let masterBody: any,
    approved = true,
    masterUrl = 'https://master.example';
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('community_master_connection'))
        return {
          rows: [
            {
              state: approved ? 'APPROVED' : 'PENDING',
              credential_cipher: seal(
                nodeToken,
                bootstrap,
                'community-node:https://master.example',
              ),
              master_url: 'https://master.example',
            },
          ],
        };
      return { rows: [], rowCount: 1 };
    },
  } as any;
  const fetcher = async (_url: any, init: any) => {
    assert.equal(init.headers.authorization, `Bearer ${nodeToken}`);
    masterBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        titleId: 'PPSA99051',
        contentVersion: '01.013.000',
        revision: 21,
        size: 72679424,
        masterUrl,
        activationToken: 'd'.repeat(64),
        expiresIn: 600,
        ...(masterBody.baseContentVersion
          ? {
              contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
              title: 'PS5Library',
              baseContentVersion: '01.012.000',
              sha256: 'e'.repeat(64),
            }
          : {}),
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    await updateRoutes(
      app,
      {
        DATA_DIR: 'missing',
        PUBLIC_URL: 'https://node.example',
        COMMUNITY_MASTER_URL: 'https://master.example',
        BOOTSTRAP_TOKEN: bootstrap,
      } as any,
      {
        device: async () => ({
          id: '13dc3569-622c-499e-a11a-53684669434b',
          user_id: '4a68bbbe-7d73-4b20-a82b-8b113ba03c1d',
          name: 'Living Room PS5',
          firmware: '4.51',
        }),
      } as any,
      db,
      fetcher as any,
    );
    const response = await app.inject({
      url: '/api/v1/device/native-updates?baseContentVersion=01.012.000',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().activationToken, 'd'.repeat(64));
    assert.match(masterBody.consoleRef, /^[a-f0-9]{64}$/);
    assert.notEqual(masterBody.consoleRef, '13dc3569-622c-499e-a11a-53684669434b');
    assert.equal(masterBody.displayName, 'Living Room PS5');
    assert.equal(masterBody.baseContentVersion, '01.012.000');
    const legacy = await app.inject({ url: '/api/v1/device/native-updates' });
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().activationToken, 'd'.repeat(64));
    assert.equal(
      masterBody.baseContentVersion,
      undefined,
      'Legacy Master discovery omits the installed base',
    );
    assert.equal(
      (
        await app.inject({ url: '/api/v1/device/native-updates?baseContentVersion=01.011.000' })
      ).json(),
      null,
      'Master discovery must not offer a release built for a different installed base',
    );
    const direct = await app.inject({
      method: 'POST',
      url: '/api/v1/device/native-updates/install',
      payload: { titleId: 'PPSA99051', baseContentVersion: '01.012.000' },
    });
    assert.equal(direct.statusCode, 200, direct.body);
    assert.equal(direct.json().sha256, 'e'.repeat(64));
    assert.equal(masterBody.baseContentVersion, '01.012.000');
    assert.equal(
      queries.some((sql) => sql.includes('console_notices')),
      false,
    );
    masterUrl = 'https://attacker.invalid';
    const foreign = await app.inject({
      url: '/api/v1/device/native-updates?baseContentVersion=01.012.000',
    });
    assert.equal(foreign.statusCode, 502);
    assert.equal(foreign.json().message, 'INVALID_MASTER_RESPONSE');
    assert.equal('activationToken' in foreign.json(), false);
    masterUrl = 'https://master.example';
    approved = false;
    const blocked = await app.inject({
      url: '/api/v1/device/native-updates?baseContentVersion=01.012.000',
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().message, 'MASTER_REGISTRATION_REQUIRED');
    assert.equal(
      queries.some((sql) => sql.includes('console_notices')),
      true,
    );
  } finally {
    await app.close();
  }
});
