import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { transferRoutes } from '../src/transfers/routes.js';
import { artifactStoragePath, releaseStorageFolder } from '../src/storage/names.js';
import { nativeAssetFileName, nativeUpdateFolder } from '../src/updates/native.js';
import {
  nativeWorkerAutostartFile,
  nativeWorkerAutostartScript,
} from '../../scripts/native-worker-autostart.mjs';
import {
  acquireNativeWorkerStartLock,
  nativeWorkerStartLockName,
} from '../../scripts/native-worker-lock.mjs';

test('persistent game files use readable game, version, and type names', () => {
  const row = {
      title: 'Open:Story/Deluxe',
      title_id: 'PPSA99783',
      version: '01.000.031',
      release_kind: 'BASE',
      release_id: '8eb2bc2e-ad1d-4994-94e6-53d0c893e2e2',
    },
    hash = '6a0f1fa69e8584a75432464684b92b14f26cf4fa3dcd26b0a5f11b8e038931a2';
  assert.equal(
    releaseStorageFolder(row),
    'Open_Story_Deluxe [PPSA99783]/01.000.031 - BASE [8eb2bc2e]',
  );
  assert.equal(
    artifactStoragePath(row, { sha256: hash, format: 'pkg' }),
    'artifacts/Open_Story_Deluxe [PPSA99783]/01.000.031 - BASE [8eb2bc2e]/Open_Story_Deluxe ' +
      '[PPSA99783] - 01.000.031 - BASE - 6a0f1fa69e85.pkg',
  );
  assert.equal(nativeUpdateFolder('PPSA99783'), 'OpenStory [PPSA99783]');
  assert.equal(
    nativeAssetFileName('PPSA99783', 'package', hash),
    'OpenStory [PPSA99783] - Full Update - 6a0f1fa69e85.pkg',
  );
});

test('Docker startup paths accept explicit persistent-storage and watch folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-docker-paths-')),
    data = path.join(root, 'server-data'),
    dumps = path.join(root, 'watched-dumps'),
    sources = path.join(root, 'sources');
  try {
    await writeFile(
      path.join(root, '.env'),
      'DATABASE_URL=postgresql://user:password@127.0.0.1:5432/test\n',
    );
    await promisify(execFile)(
      process.execPath,
      [
        path.resolve('scripts/docker-configure.mjs'),
        '--data-dir',
        data,
        '--dump-root',
        dumps,
        '--source-root',
        sources,
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/test' },
      },
    );
    const env = await readFile(path.join(root, '.env'), 'utf8');
    for (const [key, value] of Object.entries({
      DATA_DIR: data,
      DUMP_ROOT: dumps,
      SOURCE_ROOT: sources,
      DOCKER_DATA_DIR: data,
      DOCKER_DUMP_ROOT: dumps,
      DOCKER_SOURCE_ROOT: sources,
    }))
      assert.match(
        env,
        new RegExp(
          `^${key}=${value.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'm',
        ),
      );
    if (process.platform === 'win32') {
      assert.match(env, /^PACKAGE_WORKER_URL=http:\/\/host\.docker\.internal:3152$/m);
      assert.match(env, /^PACKAGE_WORKER_TOKEN=.{64}$/m);
    }
    for (const directory of [
      'artifacts',
      'backports',
      'jobs',
      'trailers',
      'logs',
      path.join('artwork', '.staging'),
    ])
      assert.ok(
        (await stat(path.join(data, directory))).isDirectory(),
        `${directory} must exist before the non-root containers start`,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only the API container can retire watched dumps', async () => {
  const compose = await readFile(path.resolve('docker/compose.yml'), 'utf8'),
    server = compose.split('\n  operator:')[0]!.split('\n  server:')[1]!,
    worker = compose.split('\n  worker:')[1]!.split('\n  postgres:')[0]!;
  assert.match(server, /target: \/dumps\r?\n(?!\s+read_only: true)/);
  assert.match(worker, /target: \/dumps\r?\n\s+read_only: true/);
});

test('Docker configuration keeps one valid native worker token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-worker-token-'));
  try {
    await writeFile(
      path.join(root, '.env'),
      [
        'DATABASE_URL=postgresql://user:password@127.0.0.1:5432/test',
        'PACKAGE_WORKER_URL=http://host.docker.internal:3152',
        'PACKAGE_WORKER_TOKEN=',
        'PACKAGE_WORKER_TOKEN=short',
        '',
      ].join('\n'),
    );
    await promisify(execFile)(process.execPath, [path.resolve('scripts/docker-configure.mjs')], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/test' },
    });
    const env = await readFile(path.join(root, '.env'), 'utf8'),
      tokens = [...env.matchAll(/^PACKAGE_WORKER_TOKEN=(.*)$/gm)];
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]![1]!.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup keeps Docker Desktop on the image app identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-setup-user-'));
  try {
    await writeFile(
      path.join(root, '.env.example'),
      [
        'DATABASE_PASSWORD=GENERATE_WITH_NPM_RUN_SETUP',
        'BOOTSTRAP_TOKEN=GENERATE_WITH_NPM_RUN_SETUP',
        'OPERATOR_TOKEN=GENERATE_WITH_NPM_RUN_SETUP',
        'PUID=1000',
        'PGID=1000',
        '',
      ].join('\n'),
    );
    await promisify(execFile)(process.execPath, [path.resolve('scripts/setup.mjs')], { cwd: root });
    const env = await readFile(path.join(root, '.env'), 'utf8'),
      expected = process.platform === 'win32' ? 1654 : (process.getuid?.() ?? 1000);
    assert.match(env, new RegExp(`^PUID=${expected}$`, 'm'));
    assert.match(
      env,
      new RegExp(
        `^PGID=${process.platform === 'win32' ? 1654 : (process.getgid?.() ?? 1000)}$`,
        'm',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native worker manager requests authenticated graceful shutdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-worker-stop-')),
    token = 't'.repeat(64),
    authorization: string[] = [];
  const server = createServer((req, res) => {
    authorization.push(req.headers.authorization ?? '');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(202).end();
      server.close();
      return;
    }
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Test worker did not bind');
    await promisify(execFile)(
      process.execPath,
      [path.resolve('scripts/native-worker.mjs'), 'stop'],
      {
        cwd: root,
        env: {
          ...process.env,
          PACKAGE_WORKER_URL: `http://host.docker.internal:${address.port}`,
          PACKAGE_WORKER_TOKEN: token,
          DATA_DIR: root,
          DUMP_ROOT: root,
          SOURCE_ROOT: root,
        },
      },
    );
    assert.deepEqual(authorization, [`Bearer ${token}`, `Bearer ${token}`]);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows native worker autostart uses the current-user Startup folder without credentials', () => {
  const options = {
      root: 'C:\\PS5 Library',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      npmCli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    },
    script = nativeWorkerAutostartScript(options);

  assert.equal(
    nativeWorkerAutostartFile('C:\\Users\\owner\\AppData\\Roaming'),
    'C:\\Users\\owner\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\PS5Library Native Package Worker.vbs',
  );
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /npm-cli\.js/);
  assert.match(script, /worker:native:start/);
  assert.match(script, /, 0, False\s*$/);
  assert.doesNotMatch(script, /TOKEN|PASSWORD|SECRET/i);
});

test('docker deployment restarts the native worker so code updates take effect', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  assert.match(manifest.scripts['docker:up'], /worker:native:restart/);
});

test(
  'native worker start lock serializes processes and releases a dead owner',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-worker-lock-')),
      lock = nativeWorkerStartLockName((process.pid % 65_534) + 1),
      trace = path.join(root, 'trace.log'),
      helper = path.join(root, 'lock-helper.mjs'),
      moduleUrl = new URL('../../scripts/native-worker-lock.mjs', import.meta.url).href;
    try {
      await writeFile(
        helper,
        `import { appendFile } from 'node:fs/promises';\n` +
          `import { acquireNativeWorkerStartLock } from ${JSON.stringify(moduleUrl)};\n` +
          `const release = await acquireNativeWorkerStartLock(process.argv[2], { pollMs: 10, waitMs: 2000 });\n` +
          `await appendFile(process.argv[3], 'start\\n');\n` +
          `await new Promise(resolve => setTimeout(resolve, 100));\n` +
          `if (process.argv[4] === 'crash') process.exit(0);\n` +
          `await appendFile(process.argv[3], 'end\\n');\n` +
          `await release();\n`,
      );
      const run = (mode = 'normal') =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [helper, lock, trace, mode], {
              stdio: 'inherit',
            });
            child.once('error', reject);
            child.once('exit', (code) =>
              code === 0 ? resolve() : reject(Error(`Lock helper exited ${code}`)),
            );
          }),
        first = run(),
        second = run();
      await Promise.all([first, second]);
      assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), [
        'start',
        'end',
        'start',
        'end',
      ]);

      await run('crash');
      const release = await acquireNativeWorkerStartLock(lock, { pollMs: 10, waitMs: 500 });
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('download routes cannot serve files outside DATA_DIR', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ps5library-data-path-')),
    data = path.join(parent, 'data'),
    outside = path.join(parent, 'outside.bin'),
    id = randomUUID();
  await mkdir(data);
  await writeFile(outside, 'secret');
  const config = { DATA_DIR: data, DISK_MARGIN_BYTES: 0, BOOTSTRAP_TOKEN: 'x'.repeat(32) } as any;
  const auth = {
    device: async () => ({ id: 'console' }),
    user: async () => ({ id: 'user' }),
  } as any;
  const artifactDb = {
    query: async (sql: string) => ({
      rows: sql.includes('SELECT a.* FROM artifacts')
        ? [{ id, relative_path: '../outside.bin', size: 6, sha256: '0'.repeat(64) }]
        : [],
    }),
  } as any;
  const downloads = Fastify();
  await transferRoutes(downloads, artifactDb, config, auth);
  try {
    assert.notEqual(
      (await downloads.inject({ url: `/api/v1/device/artifacts/${id}` })).statusCode,
      200,
    );
  } finally {
    await downloads.close();
    await rm(parent, { recursive: true, force: true });
  }
});
