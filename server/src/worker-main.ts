import { createServer } from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './security/errors.js';
import { runLocalTool, runLocalWorker, workerDisconnectSignal } from './library/inspect.js';
import { optimizeArtworkFile } from './artwork/optimize.js';
import { structuredLogger } from './logging.js';
import { workerProgressLogger } from './worker-progress.js';
import { mapWorkerRequest, mapWorkerResult, type WorkerRoot } from './worker-paths.js';

const socket = process.env.PACKAGE_WORKER_SOCKET ?? '/worker-ipc/worker.sock';
const port = process.env.PACKAGE_WORKER_PORT ? Number(process.env.PACKAGE_WORKER_PORT) : undefined,
  token = process.env.PACKAGE_WORKER_TOKEN ?? '';
const roots: WorkerRoot[] = [
  ['/data', process.env.PACKAGE_WORKER_DATA_DIR ?? ''],
  ['/dumps', process.env.PACKAGE_WORKER_DUMP_ROOT ?? ''],
  ['/sources', process.env.PACKAGE_WORKER_SOURCE_ROOT ?? ''],
];
if (
  port !== undefined &&
  (!Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    token.length < 32 ||
    roots.some(([, host]) => !path.isAbsolute(host)))
)
  throw Error(
    'Native package worker requires a valid port, token, and absolute data/dump/source roots.',
  );
const logs = await structuredLogger(process.env.DATA_DIR ?? '/data', 'worker');
const command = z.enum([
  'inspect',
  'extract-pkg-artwork',
  'encode-dds',
  'build',
  'build-verified',
  'build-backport',
  'hash-file',
  'hash-tree',
  'hash-base-tree',
  'archive-parts',
  'hash-archive',
  'build-archive',
  'extract-archive',
  'extract-zip',
  'fself-to-elf',
  'elf-to-fself',
  'generate-backport-profile',
  'generate-backport-profile-archive',
]);
const args = z.array(z.string().max(8192)).min(1).max(16),
  job = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('dotnet'),
      args: args.refine((value) => command.safeParse(value[0]).success),
      runKey: z.string().max(200).optional(),
    }),
    z.object({
      kind: z.literal('media'),
      command: z.enum(['ffmpeg', 'ffprobe']),
      args: z.array(z.string().max(8192)).max(100),
    }),
    z.object({
      kind: z.literal('image'),
      input: z.string().max(8192),
      output: z.string().max(8192),
      artworkKind: z.string().regex(/^(?:cover|hero|icon|screenshot[0-9]{1,3})$/),
    }),
  ]);
const artworkPath = (value: string) => {
  const root = '/data/artwork/.staging',
    relative = path.relative(root, path.resolve(value));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new AppError('INVALID_WORKER_REQUEST', 400);
  return path.resolve(value);
};
let active = 0;
const waiters: Array<() => void> = [];
const acquire = async () => {
  if (active < 2) {
    active++;
    return;
  }
  if (waiters.length >= 32) throw new AppError('WORKER_BUSY', 503);
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
};
const release = () => {
  active--;
  waiters.shift()?.();
};
// Detached runs survive the client (API server) disconnecting: the build keeps running and a
// reconnecting server reattaches by runKey instead of starting a duplicate build.
type DetachedRun = {
  lastEvent?: string;
  settled?: string;
  clients: Set<import('node:http').ServerResponse>;
  controller: AbortController;
  evict?: ReturnType<typeof setTimeout>;
};
const runs = new Map<string, DetachedRun>();
const RUN_RETENTION = 15 * 60_000;
const broadcast = (run: DetachedRun, line: string) => {
  for (const client of run.clients)
    try {
      client.write(line);
    } catch {
      run.clients.delete(client);
    }
};
const settleRun = (key: string, run: DetachedRun, line: string) => {
  run.settled = line;
  for (const client of run.clients)
    try {
      client.end(line);
    } catch {
      /* client already disconnected */
    }
  run.clients.clear();
  run.evict = setTimeout(() => {
    if (run.clients.size === 0) runs.delete(key);
  }, RUN_RETENTION);
  run.evict.unref?.();
};
const authorized = (header: string | undefined) => {
  if (port === undefined) return true;
  const actual = Buffer.from(header ?? ''),
    expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const shutdown = (reason: string) =>
  server.close(
    () =>
      void (async () => {
        await logs.write('INFO', 'worker.stopped', undefined, { signal: reason });
        if (port === undefined) await rm(socket, { force: true });
        await logs.flush();
      })(),
  );
const server = createServer((req, res) => {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (port !== undefined && req.method === 'POST' && req.url === '/shutdown') {
    if (active || waiters.length) {
      res.writeHead(409).end();
      return;
    }
    res.writeHead(202).end();
    setImmediate(() => shutdown('API'));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/active')) {
    const key = new URL(req.url, 'http://worker').searchParams.get('run') ?? '';
    const run = key ? runs.get(key) : undefined;
    res.writeHead(run && !run.settled ? 200 : 404).end();
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/cancel')) {
    const key = new URL(req.url, 'http://worker').searchParams.get('run') ?? '';
    const run = key ? runs.get(key) : undefined;
    if (run) run.controller.abort(new AppError('JOB_CANCELLED', 409, 'Build cancelled'));
    res.writeHead(run ? 202 : 404).end();
    return;
  }
  if (req.method !== 'POST' || (req.url !== '/run' && !req.url?.startsWith('/run'))) {
    res.writeHead(404).end();
    return;
  }
  const requestId = randomUUID(),
    started = process.hrtime.bigint(),
    signal = workerDisconnectSignal(res);
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on('end', async () => {
    try {
      const parsed = job.parse(JSON.parse(body));
      let task = parsed;
      if (port !== undefined) {
        if (parsed.kind !== 'dotnet') throw new AppError('INVALID_WORKER_REQUEST', 400);
        task = mapWorkerRequest(parsed, roots);
      }
      const taskName =
        task.kind === 'dotnet'
          ? task.args[0]!
          : task.kind === 'media'
            ? task.command
            : task.artworkKind;
      const runKey =
        parsed.kind === 'dotnet' && typeof parsed.runKey === 'string' && parsed.runKey
          ? parsed.runKey
          : undefined;
      void logs.write('INFO', 'worker.task_received', undefined, {
        requestId,
        task: taskName,
        kind: task.kind,
        active,
        waiting: waiters.length,
        runKey,
        reattach: runKey !== undefined && runs.has(runKey),
      });
      if (runKey) {
        const existing = runs.get(runKey);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (existing) {
          if (existing.evict) {
            clearTimeout(existing.evict);
            existing.evict = undefined;
          }
          if (existing.lastEvent) res.write(existing.lastEvent);
          if (existing.settled) {
            res.end(existing.settled);
            return;
          }
          existing.clients.add(res);
          res.on('close', () => existing.clients.delete(res));
          return;
        }
        const run: DetachedRun = { clients: new Set([res]), controller: new AbortController() };
        runs.set(runKey, run);
        res.on('close', () => run.clients.delete(res));
        void (async () => {
          const progress = workerProgressLogger(logs, {
            requestId,
            task: taskName,
            kind: task.kind,
          });
          try {
            await acquire();
            try {
              if (task.kind !== 'dotnet') throw new AppError('INVALID_WORKER_REQUEST', 400);
              const value = await runLocalWorker(
                task.args,
                async (value) => {
                  const line = JSON.stringify({ type: 'progress', value }) + '\n';
                  run.lastEvent = line;
                  broadcast(run, line);
                  await progress(value);
                },
                run.controller.signal,
              );
              settleRun(
                runKey,
                run,
                JSON.stringify({
                  type: 'result',
                  value: port === undefined ? value : mapWorkerResult(value, roots),
                }) + '\n',
              );
              void logs.write('INFO', 'worker.task_completed', undefined, {
                requestId,
                task: taskName,
                kind: task.kind,
                durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
                runKey,
              });
            } finally {
              release();
            }
          } catch (error) {
            const failure = error instanceof AppError ? error : new AppError('WORKER_FAILED', 422);
            void logs.write(
              'ERROR',
              'worker.task_failed',
              error instanceof Error ? error.message : failure.message,
              { requestId, code: failure.code, runKey },
            );
            settleRun(
              runKey,
              run,
              JSON.stringify({
                type: 'error',
                code: failure.code,
                statusCode: failure.statusCode,
                message: failure.message,
              }) + '\n',
            );
          }
        })();
        return;
      }
      await acquire();
      try {
        if (signal.aborted) throw signal.reason;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const progress = workerProgressLogger(logs, { requestId, task: taskName, kind: task.kind });
        const value =
          task.kind === 'dotnet'
            ? await runLocalWorker(
                task.args,
                async (value) => {
                  res.write(JSON.stringify({ type: 'progress', value }) + '\n');
                  await progress(value);
                },
                signal,
              )
            : task.kind === 'media'
              ? await runLocalTool(task.command, task.args)
              : await optimizeArtworkFile(
                  artworkPath(task.input),
                  artworkPath(task.output),
                  task.artworkKind,
                );
        res.end(
          JSON.stringify({
            type: 'result',
            value: port === undefined ? value : mapWorkerResult(value, roots),
          }) + '\n',
        );
        void logs.write('INFO', 'worker.task_completed', undefined, {
          requestId,
          task: taskName,
          kind: task.kind,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        });
      } finally {
        release();
      }
    } catch (error) {
      const failure =
        error instanceof AppError ? error : new AppError('INVALID_WORKER_REQUEST', 400);
      void logs.write(
        'ERROR',
        'worker.task_failed',
        error instanceof Error ? error.message : failure.message,
        {
          requestId,
          code: failure.code,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        },
      );
      if (!res.headersSent)
        res.writeHead(failure.statusCode, { 'content-type': 'application/x-ndjson' });
      res.end(
        JSON.stringify({
          type: 'error',
          code: failure.code,
          statusCode: failure.statusCode,
          message: failure.message,
        }) + '\n',
      );
    }
  });
});
if (port === undefined) {
  await mkdir(path.dirname(socket), { recursive: true });
  await rm(socket, { force: true });
  await new Promise<void>((resolve, reject) =>
    server.listen(socket, resolve).once('error', reject),
  );
  await chmod(socket, 0o660);
} else
  await new Promise<void>((resolve, reject) =>
    server.listen(port, '127.0.0.1', resolve).once('error', reject),
  );
await logs.write('INFO', 'worker.ready', undefined, {
  transport: port === undefined ? 'unix' : 'loopback',
  ...(port === undefined ? { socket } : { port }),
  concurrency: 2,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));
