import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  runSandboxArtwork,
  runSandboxTool,
  runWorker,
  workerDisconnectSignal,
  workerTempDirectory,
} from '../src/library/inspect.js';
import { mapWorkerRequest, mapWorkerResult } from '../src/worker-paths.js';
import { profileRoutes } from '../src/auth/profile.js';
import type { DB } from '../src/db.js';
import type { Config } from '../src/config.js';
import type { Auth } from '../src/auth/routes.js';

test('large package builds keep temporary files in their job output', () => {
  assert.equal(
    workerTempDirectory(['build-verified', '/dumps/game', '/data/jobs/one/output']),
    path.resolve('/data/jobs/one/output'),
  );
  assert.equal(workerTempDirectory(['inspect', '/dumps/game.pkg']), undefined);
});

test('native worker maps only configured virtual roots', () => {
  const roots = [
    ['/data', path.resolve('A:/ps5library-data')],
    ['/dumps', path.resolve('A:/ps5/games')],
    ['/sources', path.resolve('C:/sources')],
  ] as const;
  const mapped = mapWorkerRequest(
    {
      kind: 'dotnet' as const,
      args: [
        'build-verified',
        '/dumps/Game',
        '/data/jobs/one/output',
        'FPKG',
        '{}',
        'release',
        'hash',
        '1',
        '/data/jobs/one/profile.json',
      ],
    },
    roots,
  );
  assert.equal(mapped.args[1], path.resolve('A:/ps5/games/Game'));
  assert.equal(mapped.args[2], path.resolve('A:/ps5library-data/jobs/one/output'));
  assert.equal(
    mapWorkerResult(
      { outputPath: path.resolve('A:/ps5library-data/jobs/one/output/game.pkg') },
      roots,
    ).outputPath,
    '/data/jobs/one/output/game.pkg',
  );
  assert.throws(
    () => mapWorkerRequest({ kind: 'dotnet' as const, args: ['inspect', '/etc/passwd'] }, roots),
    /INVALID_WORKER_REQUEST/,
  );
});

test('package and media commands use the configured isolated worker socket', async () => {
  const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ps5library-${randomUUID()}`
        : path.join(os.tmpdir(), `ps5library-${randomUUID()}.sock`),
    seen: unknown[] = [];
  const server = createServer((req, res) => {
    let input = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (input += chunk));
    req.on('end', () => {
      const body = JSON.parse(input);
      seen.push(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (body.kind === 'dotnet') {
        res.write(
          JSON.stringify({
            type: 'progress',
            value: { stage: 'Inspecting', completedStages: 1, totalStages: 7 },
          }) + '\n',
        );
        res.end(JSON.stringify({ type: 'result', value: { format: 'pkg' } }) + '\n');
      } else if (body.kind === 'media')
        res.end(JSON.stringify({ type: 'result', value: { stdout: '{}', stderr: '' } }) + '\n');
      else
        res.end(
          JSON.stringify({ type: 'result', value: { width: 600, height: 800, size: 123 } }) + '\n',
        );
    });
  });
  const old = process.env.PACKAGE_WORKER_SOCKET,
    oldUrl = process.env.PACKAGE_WORKER_URL;
  process.env.PACKAGE_WORKER_SOCKET = socket;
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(socket, resolve).once('error', reject),
    );
    let stages = 0;
    process.env.PACKAGE_WORKER_URL = 'http://127.0.0.1:1';
    assert.equal(
      (await runSandboxTool('ffprobe', ['-of', 'json', '/data/trailer.mp4'])).stdout,
      '{}',
    );
    assert.equal(
      (
        await runSandboxArtwork(
          '/data/artwork/.staging/one/input',
          '/data/artwork/.staging/one/output',
          'cover',
        )
      ).width,
      600,
    );
    delete process.env.PACKAGE_WORKER_URL;
    assert.equal(
      (
        await runWorker(['inspect', '/dumps/game.pkg'], async () => {
          stages++;
        })
      ).format,
      'pkg',
    );
    assert.equal(stages, 1);
    assert.deepEqual(seen, [
      { kind: 'media', command: 'ffprobe', args: ['-of', 'json', '/data/trailer.mp4'] },
      {
        kind: 'image',
        input: '/data/artwork/.staging/one/input',
        output: '/data/artwork/.staging/one/output',
        artworkKind: 'cover',
      },
      { kind: 'dotnet', args: ['inspect', '/dumps/game.pkg'] },
    ]);
  } finally {
    if (old === undefined) delete process.env.PACKAGE_WORKER_SOCKET;
    else process.env.PACKAGE_WORKER_SOCKET = old;
    if (oldUrl === undefined) delete process.env.PACKAGE_WORKER_URL;
    else process.env.PACKAGE_WORKER_URL = oldUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(socket, { force: true });
  }
});

test('package commands can use the authenticated native host worker', async () => {
  const seen: { authorization?: string; body?: unknown } = {},
    server = createServer((req, res) => {
      let input = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (input += chunk));
      req.on('end', () => {
        seen.authorization = req.headers.authorization;
        seen.body = JSON.parse(input);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(JSON.stringify({ type: 'result', value: { format: 'pkg' } }) + '\n');
      });
    });
  const oldUrl = process.env.PACKAGE_WORKER_URL,
    oldToken = process.env.PACKAGE_WORKER_TOKEN,
    oldSocket = process.env.PACKAGE_WORKER_SOCKET;
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('TCP test worker did not bind');
    process.env.PACKAGE_WORKER_URL = `http://127.0.0.1:${address.port}`;
    process.env.PACKAGE_WORKER_TOKEN = 't'.repeat(64);
    process.env.PACKAGE_WORKER_SOCKET =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\missing-${randomUUID()}`
        : path.join(os.tmpdir(), `missing-${randomUUID()}.sock`);
    assert.equal((await runWorker(['inspect', '/dumps/game.pkg'])).format, 'pkg');
    assert.equal(seen.authorization, `Bearer ${'t'.repeat(64)}`);
    assert.deepEqual(seen.body, { kind: 'dotnet', args: ['inspect', '/dumps/game.pkg'] });
  } finally {
    for (const [name, value] of [
      ['PACKAGE_WORKER_URL', oldUrl],
      ['PACKAGE_WORKER_TOKEN', oldToken],
      ['PACKAGE_WORKER_SOCKET', oldSocket],
    ] as const)
      value === undefined ? delete process.env[name] : (process.env[name] = value);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('catalog inspection falls back to the isolated worker when the native worker is offline', async () => {
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ps5library-${randomUUID()}`
      : path.join(os.tmpdir(), `ps5library-${randomUUID()}.sock`);
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ type: 'result', value: { format: 'folder' } }) + '\n');
    });
  });
  const oldUrl = process.env.PACKAGE_WORKER_URL,
    oldToken = process.env.PACKAGE_WORKER_TOKEN,
    oldSocket = process.env.PACKAGE_WORKER_SOCKET;
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(socket, resolve).once('error', reject),
    );
    process.env.PACKAGE_WORKER_URL = 'http://127.0.0.1:1';
    process.env.PACKAGE_WORKER_TOKEN = 't'.repeat(64);
    process.env.PACKAGE_WORKER_SOCKET = socket;
    assert.equal((await runWorker(['inspect', '/dumps/new-game'])).format, 'folder');
  } finally {
    for (const [name, value] of [
      ['PACKAGE_WORKER_URL', oldUrl],
      ['PACKAGE_WORKER_TOKEN', oldToken],
      ['PACKAGE_WORKER_SOCKET', oldSocket],
    ] as const)
      value === undefined ? delete process.env[name] : (process.env[name] = value);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(socket, { force: true });
  }
});

test('an interrupted worker response rejects instead of leaving the build pending', async () => {
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ps5library-${randomUUID()}`
      : path.join(os.tmpdir(), `ps5library-${randomUUID()}.sock`);
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        JSON.stringify({
          type: 'progress',
          value: { stage: 'Building package', completedStages: 3, totalStages: 7 },
        }) + '\n',
        () => res.destroy(),
      );
    });
  });
  const old = process.env.PACKAGE_WORKER_SOCKET;
  process.env.PACKAGE_WORKER_SOCKET = socket;
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(socket, resolve).once('error', reject),
    );
    await assert.rejects(
      Promise.race([
        runWorker(['inspect', '/dumps/game.pkg']),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Worker disconnect was not detected')), 750).unref();
        }),
      ]),
      (error) => (error as { code?: string }).code === 'WORKER_UNAVAILABLE',
    );
  } finally {
    if (old === undefined) delete process.env.PACKAGE_WORKER_SOCKET;
    else process.env.PACKAGE_WORKER_SOCKET = old;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(socket, { force: true });
  }
});

test('cancelled build progress disconnects the native worker request', async () => {
  let response: import('node:http').ServerResponse | undefined, closed!: () => void;
  const disconnected = new Promise<void>((resolve) => (closed = resolve)),
    server = createServer((req, res) => {
      response = res;
      workerDisconnectSignal(res).addEventListener('abort', closed, { once: true });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(
          JSON.stringify({
            type: 'progress',
            value: { stage: 'Building package', completedStages: 3, totalStages: 7 },
          }) + '\n',
        );
      });
    });
  const oldUrl = process.env.PACKAGE_WORKER_URL,
    oldToken = process.env.PACKAGE_WORKER_TOKEN;
  try {
    await new Promise<void>((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('TCP test worker did not bind');
    process.env.PACKAGE_WORKER_URL = `http://127.0.0.1:${address.port}`;
    process.env.PACKAGE_WORKER_TOKEN = 't'.repeat(64);
    await assert.rejects(
      Promise.race([
        runWorker(['build-verified'], async () => {
          throw new Error('cancel requested');
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Worker request stayed connected')), 750),
        ),
      ]),
      /cancel requested/,
    );
    await Promise.race([
      disconnected,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Worker request stayed connected')), 750),
      ),
    ]);
  } finally {
    if (oldUrl === undefined) delete process.env.PACKAGE_WORKER_URL;
    else process.env.PACKAGE_WORKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PACKAGE_WORKER_TOKEN;
    else process.env.PACKAGE_WORKER_TOKEN = oldToken;
    response?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('avatar upload reports an unavailable isolated worker instead of blaming the image', async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'ps5library-avatar-')),
    old = process.env.PACKAGE_WORKER_SOCKET;
  process.env.PACKAGE_WORKER_SOCKET =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\missing-${randomUUID()}`
      : path.join(data, 'missing.sock');
  const app = Fastify();
  await profileRoutes(
    app,
    {} as DB,
    { DATA_DIR: data } as Config,
    { user: async () => ({ id: randomUUID() }) } as unknown as Auth,
  );
  try {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/profile/avatar',
      payload: { data: image.toString('base64') },
    });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /WORKER_UNAVAILABLE/);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.PACKAGE_WORKER_SOCKET;
    else process.env.PACKAGE_WORKER_SOCKET = old;
    await rm(data, { recursive: true, force: true });
  }
});
