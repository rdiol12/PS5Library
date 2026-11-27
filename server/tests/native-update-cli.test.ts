import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, copyFile, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const childProcessHook = String.raw`
const childProcess=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {syncBuiltinESMExports}=require('node:module');
const original=childProcess.execFile;
childProcess.execFile=function(command,args,...tail){
  fs.appendFileSync(process.env.NATIVE_UPDATE_TRACE,JSON.stringify({command:String(command),args})+'\n');
  const callback=tail.find(value=>typeof value==='function');
  const options=tail.find(value=>value&&typeof value==='object')??{};
  const script=String(args?.[0]??'').replaceAll('\\','/');
  const finish=(error,stdout='',stderr='')=>process.nextTick(()=>callback(error,stdout,stderr));
  if(process.env.NATIVE_UPDATE_HOOK_MODE==='publish-only'&&script.endsWith('scripts/check-native-update.mjs')){
    finish(Object.assign(new Error('redundant check invoked'),{code:77}),'','redundant check invoked');
    return;
  }
  if(process.env.NATIVE_UPDATE_HOOK_MODE==='reuse-worker'&&path.basename(String(command)).toLowerCase().startsWith('dotnet')&&args?.[0]==='build'){
    finish(Object.assign(new Error('existing worker was rebuilt'),{code:78}),'','existing worker was rebuilt');
    return;
  }
  if(process.env.NATIVE_UPDATE_HOOK_MODE==='publisher-worker'&&path.basename(String(command)).toLowerCase().startsWith('dotnet')){
    if(args?.[1]==='inspect'){
      process.nextTick(() =>
        callback(null, {
          stdout: JSON.stringify({
            format: 'pkg',
            kind: 'UPDATE',
            structurallyRecognized: true,
            metadataVerified: true,
            identity: {
              titleId: 'PPSA99783',
              contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
              version: '01.000.022',
              minimumFirmware: '4.50',
            },
          }),
          stderr: '',
        }),
      );
      return;
    }
    if(args?.[1]==='package-chunk-crc'){
      fs.writeFileSync(args[3],Buffer.alloc(4,1));
      process.nextTick(()=>callback(null,{stdout:'',stderr:''}));
      return;
    }
  }
  if(script.endsWith('scripts/publish-native-update.mjs')){
    if(process.env.NATIVE_UPDATE_HOOK_MODE==='reuse-worker'){
      const release=path.join(options.env.DATA_DIR,'native-updates','PS5Library [PPSA99051]');
      const metadata={revision:1,baseContentVersion:'01.037.000',contentVersion:'01.038.000',package:{size:65536},delta:{size:fs.statSync(args[3]).size}};
      fs.mkdirSync(path.join(release,'releases'),{recursive:true});
      fs.writeFileSync(path.join(release,'latest.json'),JSON.stringify(metadata));
      fs.writeFileSync(path.join(release,'releases','1.json'),JSON.stringify(metadata));
      process.nextTick(()=>callback(null,{stdout:JSON.stringify({published:true,contentVersion:'01.038.000'})+'\n',stderr:''}));
      return;
    }
    finish(null,JSON.stringify({published:true,contentVersion:'01.038.000'})+'\n');
    return;
  }
  return original.call(this,command,args,...tail);
};
syncBuiltinESMExports();
`;

test('native update CLI requires explicit title, validation source, and publish icon', async () => {
  const run = promisify(execFile),
    invoke = (args: string[]) => run(process.execPath, ['scripts/native-update.mjs', ...args]);
  const errorJson = (error: any) => JSON.parse(error.stderr);
  const help = JSON.parse((await invoke(['--help'])).stdout);
  assert.match(help.titleOption, /required/i);
  assert.match(help.commands.publish, /--icon <png>/);
  for (const command of ['configure', 'prerequisites', 'inspect', 'build', 'publish', 'status']) {
    await assert.rejects(
      invoke([command]),
      (error) => errorJson(error).message === 'Missing --title-id',
    );
  }
  await assert.rejects(
    invoke(['prerequisites', '--title-id', 'PPSA99051']),
    (error) => errorJson(error).message === 'Missing --source',
  );
  await assert.rejects(
    invoke([
      'publish',
      '--title-id',
      'PPSA99051',
      '--package',
      'missing.pkg',
      '--delta',
      'missing.delta.pkg',
      '--base-version',
      '01.000.000',
    ]),
    (error) => errorJson(error).message === 'Missing --icon',
  );
  await assert.rejects(
    run(process.execPath, [
      'scripts/publish-native-update.mjs',
      'missing.pkg',
      '01.000.000',
      'missing.delta.pkg',
      '--title-id',
      'PPSA99051',
    ]),
    (error) => /Missing --icon/.test(error.stderr),
  );
  await assert.rejects(
    run(process.execPath, [
      'scripts/publish-native-update.mjs',
      'missing.pkg',
      '01.000.000',
      'missing.delta.pkg',
      '--icon',
      'missing.png',
    ]),
    (error) => /Missing --title-id/.test(error.stderr),
  );
});

test('native app build requires its own exact Home update feed', async () => {
  const run = promisify(execFile),
    script = path.resolve('ps5/native/build.py'),
    base = [
      '--upstream',
      '.',
      '--mode',
      'app',
      '--content-version',
      '01.071.000',
      '--print-version-file-uri',
    ];
  const current =
    'https://library.example/api/v1/native-updates/PPSA99051/from/01.071.000/version.xml';
  assert.equal(
    (await run('python', [script, ...base, '--version-file-uri', current])).stdout.trim(),
    current,
  );
  await assert.rejects(
    run('python', [
      script,
      ...base,
      '--version-file-uri',
      current.replace('01.071.000', '01.047.000'),
    ]),
    (error) => /must be an HTTP\(S\) URL for/.test((error as any).stderr),
  );
  await assert.rejects(
    run('python', [script, ...base], {
      env: {
        ...process.env,
        PS5LIBRARY_NATIVE_VERSION_URI: '',
        PUBLIC_URL: '',
        COMMUNITY_MASTER_URL: '',
      },
    }),
    (error) => /app builds require an update origin/.test((error as any).stderr),
  );
});

test('native update publish delegates once to the gated publisher', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-publish-once-')),
    pkg = path.join(root, 'candidate.pkg'),
    delta = path.join(root, 'candidate.delta.pkg'),
    icon = path.join(root, 'title-icon.png'),
    trace = path.join(root, 'calls.jsonl'),
    preload = path.join(root, 'child-hook.cjs'),
    run = promisify(execFile);
  try {
    await writeFile(pkg, 'package fixture');
    await writeFile(delta, 'delta fixture');
    await writeFile(icon, 'title icon fixture');
    await writeFile(preload, childProcessHook);
    const env = {
      ...process.env,
      NATIVE_UPDATE_TRACE: trace,
      NATIVE_UPDATE_HOOK_MODE: 'publish-only',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    };
    const result = JSON.parse(
      (
        await run(
          process.execPath,
          [
            'scripts/native-update.mjs',
            'publish',
            '--title-id',
            'PPSA99051',
            '--package',
            pkg,
            '--delta',
            delta,
            '--base-version',
            '01.037.000',
            '--icon',
            icon,
            '--data-dir',
            path.join(root, 'data'),
          ],
          { env },
        )
      ).stdout,
    );
    assert.equal(result.published.published, true);
    assert.equal('validation' in result, false);
    const calls = (await readFile(trace, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => String(call.args[0]).replaceAll('\\', '/').split('/').at(-1)),
      ['publish-native-update.mjs'],
    );
    assert.equal(calls[0].args[calls[0].args.indexOf('--icon') + 1], path.resolve(icon));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publisher atomically replaces a stale per-title icon with the explicit PNG', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-icon-')),
    pkg = path.join(root, 'candidate.pkg'),
    delta = path.join(root, 'candidate.delta.pkg'),
    icon = path.join(root, 'openstory.png'),
    trace = path.join(root, 'calls.jsonl'),
    preload = path.join(root, 'child-hook.cjs'),
    data = path.join(root, 'data'),
    release = path.join(data, 'native-updates', 'OpenStory [PPSA99783]'),
    run = promisify(execFile);
  const packageBytes = Buffer.alloc(0x10000),
    deltaBytes = Buffer.alloc(0x84),
    png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
  try {
    packageBytes.set([0x7f, 0x46, 0x49, 0x48]);
    packageBytes.writeBigUInt64LE(0n, 0x58);
    packageBytes.writeBigUInt64BE(0x10000n, 0x430);
    packageBytes.writeBigUInt64BE(0n, 0x4b0);
    packageBytes.writeBigUInt64BE(0x10000n, 0x4b8);
    packageBytes[0xfe0] = 1;
    deltaBytes.set([0x7f, 0x43, 0x4e, 0x54]);
    deltaBytes.writeUInt32BE(8, 0x10);
    deltaBytes.writeUInt16BE(6, 0x14);
    deltaBytes.writeBigUInt64BE(0x80n, 0x20);
    deltaBytes.write('UP9000-PPSA99783_00-OPENSTORYPS50000', 0x40, 'ascii');
    deltaBytes.writeUInt32BE(0x23, 0x74);
    deltaBytes.set([0x7f, 0x52, 0x4c, 0x43], 0x80);
    await mkdir(release, { recursive: true });
    await writeFile(pkg, packageBytes);
    await writeFile(delta, deltaBytes);
    await writeFile(icon, png);
    await writeFile(
      path.join(release, 'icon.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    );
    await writeFile(preload, childProcessHook);
    const env = {
      ...process.env,
      DATA_DIR: data,
      NATIVE_UPDATE_TRACE: trace,
      NATIVE_UPDATE_HOOK_MODE: 'publisher-worker',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    };
    await run(
      process.execPath,
      [
        'scripts/publish-native-update.mjs',
        pkg,
        '01.000.021',
        delta,
        '--title-id',
        'PPSA99783',
        '--icon',
        icon,
      ],
      { env },
    );
    assert.deepEqual(await readFile(path.join(release, 'icon.png')), png);
    assert.match(
      await readFile(path.join(release, 'CONTENTS.txt'), 'utf8'),
      /OpenStory \[PPSA99783\].*Full update package: OpenStory \[PPSA99783\] - Full Update - /s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publisher leaves the active icon unchanged when the release revision conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-icon-conflict-')),
    pkg = path.join(root, 'candidate.pkg'),
    delta = path.join(root, 'candidate.delta.pkg'),
    icon = path.join(root, 'openstory.png'),
    trace = path.join(root, 'calls.jsonl'),
    preload = path.join(root, 'child-hook.cjs'),
    data = path.join(root, 'data'),
    release = path.join(data, 'native-updates', 'OpenStory [PPSA99783]'),
    releases = path.join(release, 'releases'),
    run = promisify(execFile);
  const packageBytes = Buffer.alloc(0x10000),
    deltaBytes = Buffer.alloc(0x84),
    oldIcon = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    newIcon = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
    prior = { revision: 0, contentVersion: '01.000.021' };
  try {
    packageBytes.set([0x7f, 0x46, 0x49, 0x48]);
    packageBytes.writeBigUInt64LE(0n, 0x58);
    packageBytes.writeBigUInt64BE(0x10000n, 0x430);
    packageBytes.writeBigUInt64BE(0n, 0x4b0);
    packageBytes.writeBigUInt64BE(0x10000n, 0x4b8);
    packageBytes[0xfe0] = 1;
    deltaBytes.set([0x7f, 0x43, 0x4e, 0x54]);
    deltaBytes.writeUInt32BE(8, 0x10);
    deltaBytes.writeUInt16BE(6, 0x14);
    deltaBytes.writeBigUInt64BE(0x80n, 0x20);
    deltaBytes.write('UP9000-PPSA99783_00-OPENSTORYPS50000', 0x40, 'ascii');
    deltaBytes.writeUInt32BE(0x23, 0x74);
    deltaBytes.set([0x7f, 0x52, 0x4c, 0x43], 0x80);
    await mkdir(releases, { recursive: true });
    await writeFile(pkg, packageBytes);
    await writeFile(delta, deltaBytes);
    await writeFile(icon, newIcon);
    await writeFile(path.join(release, 'icon.png'), oldIcon);
    await writeFile(path.join(release, 'latest.json'), JSON.stringify(prior));
    await writeFile(path.join(releases, '1.json'), JSON.stringify(prior));
    await writeFile(preload, childProcessHook);
    const env = {
      ...process.env,
      DATA_DIR: data,
      NATIVE_UPDATE_TRACE: trace,
      NATIVE_UPDATE_HOOK_MODE: 'publisher-worker',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    };
    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/publish-native-update.mjs',
          pkg,
          '01.000.021',
          delta,
          '--title-id',
          'PPSA99783',
          '--icon',
          icon,
        ],
        { env },
      ),
      (error) => /Immutable native release already exists/.test((error as any).stderr),
    );
    assert.deepEqual(await readFile(path.join(release, 'icon.png')), oldIcon);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native update gate reuses an existing release worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-worker-reuse-')),
    pkg = path.join(root, 'candidate.pkg'),
    delta = path.join(root, 'candidate.delta.pkg'),
    trace = path.join(root, 'calls.jsonl'),
    preload = path.join(root, 'child-hook.cjs'),
    run = promisify(execFile);
  const worker = path.resolve('worker/bin/Release/net10.0/PS5Library.Worker.dll'),
    workerExists = Boolean(await lstat(worker).catch(() => null));
  try {
    await writeFile(pkg, 'package fixture');
    await writeFile(delta, 'delta fixture');
    await writeFile(preload, childProcessHook);
    if (!workerExists) {
      await mkdir(path.dirname(worker), { recursive: true });
      await writeFile(worker, 'worker fixture');
    }
    const env = {
      ...process.env,
      NATIVE_UPDATE_TRACE: trace,
      NATIVE_UPDATE_HOOK_MODE: 'reuse-worker',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    };
    const result = JSON.parse(
      (
        await run(
          process.execPath,
          [
            'scripts/check-native-update.mjs',
            pkg,
            '01.037.000',
            delta,
            '--title-id',
            'PPSA99051',
            '--icon',
            'ps5/assets/icon0.png',
          ],
          { env },
        )
      ).stdout,
    );
    assert.equal(result.passed, true);
    const calls = (await readFile(trace, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.some(
        (call) =>
          path.basename(call.command).toLowerCase().startsWith('dotnet') &&
          call.args[0] === 'build',
      ),
      false,
    );
    assert.equal(
      calls.filter((call) =>
        String(call.args[0]).replaceAll('\\', '/').endsWith('scripts/publish-native-update.mjs'),
      ).length,
      1,
    );
  } finally {
    if (!workerExists) await rm(worker, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('publisher cannot reactivate a quarantined content version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-quarantine-')),
    pkg = path.join(root, 'candidate.pkg'),
    delta = path.join(root, 'candidate.delta.pkg'),
    trace = path.join(root, 'calls.jsonl'),
    preload = path.join(root, 'child-hook.cjs'),
    data = path.join(root, 'data'),
    release = path.join(data, 'native-updates', 'OpenStory [PPSA99783]'),
    releases = path.join(release, 'releases'),
    run = promisify(execFile);
  const packageBytes = Buffer.alloc(0x10000),
    deltaBytes = Buffer.alloc(0x84);
  try {
    packageBytes.set([0x7f, 0x46, 0x49, 0x48]);
    packageBytes.writeBigUInt64LE(0n, 0x58);
    packageBytes.writeBigUInt64BE(0x10000n, 0x430);
    packageBytes.writeBigUInt64BE(0n, 0x4b0);
    packageBytes.writeBigUInt64BE(0x10000n, 0x4b8);
    packageBytes[0xfe0] = 1;
    deltaBytes.set([0x7f, 0x43, 0x4e, 0x54]);
    deltaBytes.writeUInt32BE(8, 0x10);
    deltaBytes.writeUInt16BE(6, 0x14);
    deltaBytes.writeBigUInt64BE(0x80n, 0x20);
    deltaBytes.write('UP9000-PPSA99783_00-OPENSTORYPS50000', 0x40, 'ascii');
    deltaBytes.writeUInt32BE(0x23, 0x74);
    deltaBytes.set([0x7f, 0x52, 0x4c, 0x43], 0x80);
    const prior = {
      schemaVersion: 1,
      titleId: 'PPSA99783',
      contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
      contentVersion: '01.000.022',
      baseContentVersion: '01.000.021',
      revision: 20,
      systemVersion: 0,
      package: {
        size: packageBytes.length,
        sha256: createHash('sha256').update(packageBytes).digest('hex'),
        sha1: createHash('sha1').update(packageBytes).digest('hex'),
        digest: `01${'00'.repeat(31)}`,
      },
      playgo: { size: 4, sha256: createHash('sha256').update(Buffer.alloc(4, 1)).digest('hex') },
      delta: { size: deltaBytes.length, sha256: '55'.repeat(32) },
    };
    await mkdir(releases, { recursive: true });
    await writeFile(pkg, packageBytes);
    await writeFile(delta, deltaBytes);
    await writeFile(preload, childProcessHook);
    await writeFile(path.join(releases, '20.json'), JSON.stringify(prior));
    await writeFile(
      path.join(release, 'latest.quarantined-console-crash-01.000.022.json'),
      JSON.stringify(prior),
    );
    const env = {
      ...process.env,
      DATA_DIR: data,
      NATIVE_UPDATE_TRACE: trace,
      NATIVE_UPDATE_HOOK_MODE: 'publisher-worker',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    };
    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/publish-native-update.mjs',
          pkg,
          '01.000.021',
          delta,
          '--title-id',
          'PPSA99783',
          '--icon',
          'ps5/assets/icon0.png',
        ],
        { env },
      ),
      (error) => /quarantined/i.test((error as any).stderr),
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/publish-native-update.mjs',
          pkg,
          '01.000.021',
          delta,
          '--repair',
          '--title-id',
          'PPSA99783',
          '--icon',
          'ps5/assets/icon0.png',
        ],
        { env },
      ),
      (error) => /quarantined/i.test((error as any).stderr),
    );
    await assert.rejects(lstat(path.join(release, 'latest.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(releases, '21.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native update CLI validates the Home update URI and fixed title before packaging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-update-cli-')),
    source = path.join(root, 'PPSA99051'),
    param = path.join(source, 'sce_sys', 'param.json'),
    run = promisify(execFile);
  const metadata = {
    titleId: 'PPSA99051',
    contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
    contentVersion: '01.034.000',
    versionFileUri:
      'https://updates.example/api/v1/native-updates/PPSA99051/from/01.034.000/version.xml',
  };
  try {
    await mkdir(path.dirname(param), { recursive: true });
    await writeFile(param, JSON.stringify(metadata));
    const environment = { ...process.env, PUBLIC_URL: 'https://updates.example' };
    delete environment.COMMUNITY_MASTER_URL;
    delete environment.PS5LIBRARY_NATIVE_VERSION_URI;
    const valid = JSON.parse(
      (
        await run(
          process.execPath,
          [
            'scripts/native-update.mjs',
            'prerequisites',
            '--title-id',
            'PPSA99051',
            '--source',
            source,
          ],
          { env: environment },
        )
      ).stdout,
    );
    assert.equal(valid.ready, true);
    assert.equal(valid.validated.contentVersion, '01.034.000');
    assert.equal(valid.validated.originVerified, true);
    const unverified = JSON.parse(
      (
        await run(
          process.execPath,
          [
            'scripts/native-update.mjs',
            'prerequisites',
            '--title-id',
            'PPSA99051',
            '--source',
            source,
          ],
          { env: { ...environment, PUBLIC_URL: '' } },
        )
      ).stdout,
    );
    assert.equal(unverified.ready, false);
    assert.equal(unverified.validated.originVerified, false);
    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/native-update.mjs',
          'build',
          '--title-id',
          'PPSA99051',
          '--source',
          source,
          '--output',
          path.join(root, 'update.pkg'),
          '--reference',
          path.join(root, 'missing.pkg'),
          '--base-version',
          '01.033.000',
        ],
        { env: { ...environment, PUBLIC_URL: '' } },
      ),
      (error) => JSON.parse((error as any).stderr).code === 'UPDATE_ORIGIN_NOT_CONFIGURED',
    );
    await writeFile(
      param,
      JSON.stringify({
        ...metadata,
        versionFileUri: 'https://updates.example/api/v1/native-updates/PPSA99051/version.xml',
      }),
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          'scripts/native-update.mjs',
          'prerequisites',
          '--title-id',
          'PPSA99051',
          '--source',
          source,
        ],
        { env: environment },
      ),
      (error) => JSON.parse((error as any).stderr).code === 'INVALID_VERSION_FILE_URI',
    );
    await assert.rejects(
      run(process.execPath, ['scripts/native-update.mjs', 'status', '--title-id', 'PPSA12345']),
      (error) => JSON.parse((error as any).stderr).code === 'UNSUPPORTED_TITLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenStory has its own exact identity and local Home update URI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openstory-update-cli-')),
    source = path.join(root, 'PPSA99783'),
    param = path.join(source, 'sce_sys', 'param.json'),
    run = promisify(execFile);
  const metadata = {
    titleId: 'PPSA99783',
    contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
    contentVersion: '01.000.002',
    versionFileUri:
      'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.002/version.xml',
  };
  const env = {
    ...process.env,
    PUBLIC_URL: 'http://library.test:3150',
    COMMUNITY_MASTER_URL: 'https://master.example',
    PS5LIBRARY_NATIVE_VERSION_URI: '',
  };
  try {
    await mkdir(path.dirname(param), { recursive: true });
    await writeFile(param, JSON.stringify(metadata));
    const args = [
      'scripts/native-update.mjs',
      'prerequisites',
      '--title-id',
      'PPSA99783',
      '--source',
      source,
    ];
    const valid = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(valid.ready, true);
    assert.equal(valid.validated.contentId, metadata.contentId);
    await writeFile(
      param,
      JSON.stringify({ ...metadata, contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE' }),
    );
    await assert.rejects(
      run(process.execPath, args, { env }),
      (error) => JSON.parse((error as any).stderr).code === 'UNSUPPORTED_TITLE',
    );
    await writeFile(
      param,
      JSON.stringify({
        ...metadata,
        versionFileUri: metadata.versionFileUri.replace('01.000.002', '01.000.001'),
      }),
    );
    await assert.rejects(
      run(process.execPath, args, { env }),
      (error) => JSON.parse((error as any).stderr).code === 'INVALID_VERSION_FILE_URI',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native update source accepts nptitle.dat only for its exact title', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-nptitle-')),
    source = path.join(root, 'PPSA99783'),
    sys = path.join(source, 'sce_sys'),
    run = promisify(execFile);
  const args = [
      'scripts/native-update.mjs',
      'prerequisites',
      '--title-id',
      'PPSA99783',
      '--source',
      source,
    ],
    env = { ...process.env, PUBLIC_URL: 'http://library.test:3150' };
  const nptitle = Buffer.alloc(160);
  nptitle.write('NPTD');
  nptitle.writeUInt32BE(0x80, 4);
  nptitle.write('PPSA99783_00', 0x10);
  try {
    await mkdir(sys, { recursive: true });
    await writeFile(
      path.join(sys, 'param.json'),
      JSON.stringify({
        titleId: 'PPSA99783',
        contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
        contentVersion: '01.000.002',
        versionFileUri:
          'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.002/version.xml',
      }),
    );
    await writeFile(path.join(sys, 'nptitle.dat'), nptitle);
    assert.equal(JSON.parse((await run(process.execPath, args, { env })).stdout).ready, true);
    nptitle.write('PPSA99051_00', 0x10);
    await writeFile(path.join(sys, 'nptitle.dat'), nptitle);
    await assert.rejects(
      run(process.execPath, args, { env }),
      (error) => JSON.parse((error as any).stderr).code === 'INVALID_NPTITLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI warns before packaging and explicitly injects a backed-up exact-version update URI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-configure-')),
    param = path.join(root, 'sce_sys', 'param.json'),
    run = promisify(execFile);
  const original = JSON.stringify({
    titleId: 'PPSA99783',
    contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
    contentVersion: '01.000.003',
    localizedParameters: { defaultLanguage: 'en-US' },
    customField: 17,
  });
  const env = { ...process.env, PUBLIC_URL: 'http://library.test:3150' },
    args = ['scripts/native-update.mjs'],
    selection = ['--title-id', 'PPSA99783', '--source', root];
  try {
    await mkdir(path.dirname(param));
    await writeFile(param, original);
    const missing = JSON.parse(
      (await run(process.execPath, [...args, 'prerequisites', ...selection], { env })).stdout,
    );
    assert.equal(missing.ready, false);
    assert.equal(missing.warnings[0].code, 'MISSING_VERSION_FILE_URI');
    assert.match(missing.warnings[0].message, /configure/);
    if (process.platform === 'win32')
      await assert.rejects(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/build-native-update.ps1',
            '-SourceFolder',
            root,
            '-OutputPackage',
            path.join(root, 'unused.pkg'),
            '-ReferencePackage',
            path.join(root, 'missing.pkg'),
            '-BaseContentVersion',
            '01.000.002',
            '-TitleId',
            'PPSA99783',
          ],
          { env },
        ),
        (error) => /MISSING_VERSION_FILE_URI/.test((error as any).stdout + (error as any).stderr),
      );
    await writeFile(
      param,
      JSON.stringify({ ...JSON.parse(original), versionFileUri: ' '.repeat(255) }),
    );
    assert.equal(
      JSON.parse(
        (await run(process.execPath, [...args, 'prerequisites', ...selection], { env })).stdout,
      ).warnings[0].code,
      'MISSING_VERSION_FILE_URI',
    );
    const tooLong = 'https://' + ['a', 'b', 'c'].map((c) => c.repeat(63)).join('.');
    await assert.rejects(
      run(process.execPath, [...args, 'configure', ...selection, '--update-origin', tooLong], {
        env,
      }),
      (error) => JSON.parse((error as any).stderr).code === 'INVALID_VERSION_FILE_URI',
    );
    await writeFile(param, original);
    const configure = [
      ...args,
      'configure',
      ...selection,
      '--update-origin',
      'http://library.test:3150',
    ];
    const configured = JSON.parse((await run(process.execPath, configure, { env })).stdout);
    assert.equal(configured.changed, true);
    const updated = JSON.parse(await readFile(param, 'utf8'));
    assert.equal(
      updated.versionFileUri,
      'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.003/version.xml',
    );
    assert.equal(updated.customField, 17);
    assert.deepEqual(updated.localizedParameters, { defaultLanguage: 'en-US' });
    assert.equal(await readFile(configured.backup, 'utf8'), original);
    assert.equal(
      JSON.parse((await run(process.execPath, configure, { env })).stdout).changed,
      false,
    );
    const other = [...args, 'configure', ...selection, '--update-origin', 'https://other.test'];
    await assert.rejects(
      run(process.execPath, other, { env }),
      (error) => JSON.parse((error as any).stderr).code === 'VERSION_FILE_URI_EXISTS',
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          ...args,
          'configure',
          ...selection,
          '--update-origin',
          'http://user:password@library.test/path',
        ],
        { env },
      ),
      (error) => JSON.parse((error as any).stderr).code === 'INVALID_UPDATE_ORIGIN',
    );
    assert.equal(JSON.parse(await readFile(param, 'utf8')).versionFileUri, updated.versionFileUri);
    assert.equal(
      JSON.parse((await run(process.execPath, [...other, '--force'], { env })).stdout).changed,
      true,
    );
    assert.equal(await readFile(configured.backup, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'native update build stages an executable override without changing source content',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-executable-')),
      run = promisify(execFile);
    const toolkit = path.join(root, 'toolkit'),
      source = path.join(root, 'source'),
      system = path.join(source, 'sce_sys'),
      executable = path.join(root, 'eboot.elf'),
      reference = path.join(root, 'reference.pkg'),
      record = path.join(root, 'staged-source.txt');
    try {
      await mkdir(path.join(toolkit, 'toolchain', 'ext'), { recursive: true });
      await mkdir(system, { recursive: true });
      await writeFile(
        path.join(system, 'param.json'),
        JSON.stringify({
          titleId: 'PPSA99783',
          contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
          contentVersion: '01.000.003',
          versionFileUri:
            'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.003/version.xml',
        }),
      );
      await writeFile(path.join(source, 'eboot.bin'), 'original packaged executable');
      await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]));
      await writeFile(reference, 'reference fixture');
      const publisher = path.join(toolkit, 'toolchain', 'prospero-pub-cmd.exe'),
        stub = path.join(root, 'Publisher.cs');
      await writeFile(stub, 'class Publisher { static int Main(string[] args) { return 0; } }');
      await run(
        path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        ['/nologo', `/out:${publisher}`, stub],
        { windowsHide: true },
      );
      await copyFile(publisher, path.join(toolkit, 'toolchain', 'ext', 'sc2.exe'));
      await writeFile(
        path.join(toolkit, 'build-from-folder.ps1'),
        `param($SourceFolder,$OutputPackage,$ReferencePackage,$CompressionLevel,$Python,[switch]$Force)
[IO.File]::WriteAllText($env:STAGED_SOURCE_RECORD, [IO.Path]::GetFullPath($SourceFolder))
$bytes = [IO.File]::ReadAllBytes((Join-Path $SourceFolder 'eboot.bin'))
if ($bytes.Length -ne 8 -or $bytes[0] -ne 0x7f -or $bytes[1] -ne 0x45 -or $bytes[2] -ne 0x4c -or $bytes[3] -ne 0x46) { exit 22 }
$nptitle = [IO.File]::ReadAllBytes((Join-Path $SourceFolder 'sce_sys/nptitle.dat'))
$nptitleId = [Text.Encoding]::ASCII.GetString($nptitle, 16, 16).TrimEnd([char]0)
if (
  $nptitle.Length -ne 160 -or
  [Text.Encoding]::ASCII.GetString($nptitle, 0, 4) -ne 'NPTD' -or
  $nptitle[7] -ne 0x80 -or
  $nptitleId -ne 'PPSA99783_00'
) { exit 24 }
for ($i = 32; $i -lt 160; $i++) { if ($nptitle[$i] -ne 0) { exit 25 } }
exit 23
`,
      );
      await assert.rejects(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/build-native-update.ps1',
            '-SourceFolder',
            source,
            '-Executable',
            executable,
            '-GenerateUnsignedNptitle',
            '-OutputPackage',
            path.join(root, 'candidate.pkg'),
            '-ReferencePackage',
            reference,
            '-BaseContentVersion',
            '01.000.002',
            '-TitleId',
            'PPSA99783',
            '-ToolkitDirectory',
            toolkit,
          ],
          {
            env: {
              ...process.env,
              PUBLIC_URL: 'http://library.test:3150',
              STAGED_SOURCE_RECORD: record,
            },
            windowsHide: true,
          },
        ),
        (error) =>
          /Package builder failed with exit code 23/.test(
            (error as any).stdout + (error as any).stderr,
          ),
      );
      assert.equal(
        await readFile(path.join(source, 'eboot.bin'), 'utf8'),
        'original packaged executable',
      );
      await assert.rejects(lstat(path.join(system, 'nptitle.dat')), { code: 'ENOENT' });
      const staged = (await readFile(record, 'utf8')).trim();
      assert.notEqual(path.resolve(staged), path.resolve(source));
      await assert.rejects(lstat(staged), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'native update build identifies a no-passcode reference before invoking the package builder',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-reference-preflight-')),
      run = promisify(execFile);
    const toolkit = path.join(root, 'toolkit'),
      source = path.join(root, 'source'),
      output = path.join(root, 'candidate.pkg'),
      reference = path.join(root, 'reference.pkg'),
      builderMarker = path.join(root, 'builder-ran.txt');
    try {
      await mkdir(path.join(toolkit, 'toolchain', 'ext'), { recursive: true });
      await mkdir(path.join(source, 'sce_sys'), { recursive: true });
      await writeFile(
        path.join(source, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: 'PPSA99783',
          contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
          contentVersion: '01.000.003',
          versionFileUri:
            'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.003/version.xml',
        }),
      );
      await writeFile(reference, 'plaintext reference fixture');
      await writeFile(
        path.join(toolkit, 'build-from-folder.ps1'),
        `param($SourceFolder,$OutputPackage,$ReferencePackage,$CompressionLevel,$Python,[switch]$Force)
[IO.File]::WriteAllText($env:BUILDER_MARKER, 'invoked')
exit 23
`,
      );
      const stub = path.join(root, 'Publisher.cs'),
        publisher = path.join(toolkit, 'toolchain', 'prospero-pub-cmd.exe');
      await writeFile(
        stub,
        `using System;
class Publisher {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "img_file_list") {
      if (Array.IndexOf(args, "--no_passcode") >= 0) {
        Console.WriteLine("PLAINTEXT_REFERENCE_PREFLIGHT_STDOUT");
        return 0;
      }
      Console.WriteLine("REFERENCE_PREFLIGHT_STDOUT");
      Console.Error.WriteLine("[Error] Could not open or read package(pfs) file.");
      return 29;
    }
    return 0;
  }
}
`,
      );
      await run(
        path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        ['/nologo', `/out:${publisher}`, stub],
        { windowsHide: true },
      );
      await copyFile(publisher, path.join(toolkit, 'toolchain', 'ext', 'sc2.exe'));
      await assert.rejects(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/build-native-update.ps1',
            '-SourceFolder',
            source,
            '-OutputPackage',
            output,
            '-ReferencePackage',
            reference,
            '-BaseContentVersion',
            '01.000.002',
            '-TitleId',
            'PPSA99783',
            '-ToolkitDirectory',
            toolkit,
          ],
          {
            env: {
              ...process.env,
              PUBLIC_URL: 'http://library.test:3150',
              BUILDER_MARKER: builderMarker,
            },
            windowsHide: true,
          },
        ),
        (error) => {
          const message = (error as any).stdout + (error as any).stderr;
          assert.match(message, /REFERENCE_PLAINTEXT_NATIVE_UPDATE_UNSUPPORTED/);
          assert.match(message, /img_create --ref_pkg_path/);
          return true;
        },
      );
      await assert.rejects(lstat(builderMarker), { code: 'ENOENT' });
      const logs = path.join(root, 'candidate-build-logs');
      assert.match(
        await readFile(path.join(logs, '00-reference-preflight.stdout.log'), 'utf8'),
        /REFERENCE_PREFLIGHT_STDOUT/,
      );
      assert.match(
        await readFile(path.join(logs, '00-reference-preflight.stderr.log'), 'utf8'),
        /Could not open or read package\(pfs\) file/,
      );
      assert.match(
        await readFile(path.join(logs, '00-reference-no-passcode.stdout.log'), 'utf8'),
        /PLAINTEXT_REFERENCE_PREFLIGHT_STDOUT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'patch build records retail format warnings and continues to integrity',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-update-verify-')),
      run = promisify(execFile);
    const toolkit = path.join(root, 'toolkit'),
      source = path.join(root, 'source'),
      output = path.join(root, 'candidate.pkg'),
      reference = path.join(root, 'reference.pkg');
    try {
      await mkdir(path.join(toolkit, 'toolchain', 'ext'), { recursive: true });
      await mkdir(path.join(source, 'sce_sys'), { recursive: true });
      await writeFile(
        path.join(source, 'sce_sys', 'param.json'),
        JSON.stringify({
          titleId: 'PPSA99783',
          contentId: 'UP9000-PPSA99783_00-OPENSTORYPS50000',
          contentVersion: '01.000.003',
          versionFileUri:
            'http://library.test:3150/api/v1/native-updates/PPSA99783/from/01.000.003/version.xml',
        }),
      );
      await writeFile(reference, 'reference fixture');
      await writeFile(
        path.join(toolkit, 'build-from-folder.ps1'),
        `param($SourceFolder,$OutputPackage,$ReferencePackage,$CompressionLevel,$Python,[switch]$Force)
[IO.File]::WriteAllText($OutputPackage, 'patch test fixture')
[IO.File]::WriteAllText($OutputPackage + '.remastered.pkg', 'remastered test fixture')
exit 0
`,
      );
      const stub = path.join(root, 'Publisher.cs'),
        publisher = path.join(toolkit, 'toolchain', 'prospero-pub-cmd.exe');
      await writeFile(
        stub,
        `using System;
class Publisher {
  static int Main(string[] args) {
    if (args[0] == "img_file_list") return 0;
    if (args[0] != "img_verify") { Console.WriteLine("FORMAT_CHECK_WAS_SKIPPED"); return 2; }
    string command = string.Join(" ", args);
    if (command.Contains("--format_check on")) {
      Console.WriteLine("[Error] SDK version must be 2.00.00.00-00.00.00.0.0.");
      Console.WriteLine("[Error] The following directory is mandatory, but not found. (about)");
      return 1;
    }
    Console.WriteLine("INTEGRITY_CHECK_RAN");
    return 0;
  }
}
`,
      );
      await run(
        path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        ['/nologo', `/out:${publisher}`, stub],
        { windowsHide: true },
      );
      await copyFile(publisher, path.join(toolkit, 'toolchain', 'ext', 'sc2.exe'));
      await assert.rejects(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/build-native-update.ps1',
            '-SourceFolder',
            source,
            '-OutputPackage',
            output,
            '-ReferencePackage',
            reference,
            '-BaseContentVersion',
            '01.000.002',
            '-TitleId',
            'PPSA99783',
            '-ToolkitDirectory',
            toolkit,
          ],
          { env: { ...process.env, PUBLIC_URL: 'http://library.test:3150' }, windowsHide: true },
        ),
        (error) => {
          const message = (error as any).stdout + (error as any).stderr;
          assert.match(message, /Unable to inspect patch layout/);
          return true;
        },
      );
      assert.match(await readFile(`${output}.validation.log`, 'utf8'), /SDK version must be 2\.00/);
      assert.match(await readFile(`${output}.integrity.log`, 'utf8'), /INTEGRITY_CHECK_RAN/);
      await assert.rejects(readFile(`${output}.delta.pkg`), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
