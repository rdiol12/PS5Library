import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { acquireNativeWorkerStartLock, nativeWorkerStartLockName } from './native-worker-lock.mjs';

const action = process.argv[2] ?? 'start',
  configured = process.env.PACKAGE_WORKER_URL?.trim() ?? '';
if (!configured) {
  console.log('Native package worker is disabled.');
  process.exit(0);
}
const remote = new URL(configured);
if (
  remote.protocol !== 'http:' ||
  remote.hostname !== 'host.docker.internal' ||
  !remote.port ||
  remote.origin !== configured
)
  throw Error(
    'PACKAGE_WORKER_URL must be an exact host.docker.internal HTTP origin with an explicit port.',
  );
const token = process.env.PACKAGE_WORKER_TOKEN ?? '',
  data = path.resolve(process.env.DATA_DIR ?? ''),
  dumps = path.resolve(process.env.DUMP_ROOT ?? ''),
  sources = path.resolve(process.env.SOURCE_ROOT ?? '');
if (
  token.length < 32 ||
  !process.env.DATA_DIR ||
  !process.env.DUMP_ROOT ||
  !process.env.SOURCE_ROOT
)
  throw Error(
    'Native package worker requires PACKAGE_WORKER_TOKEN, DATA_DIR, DUMP_ROOT and SOURCE_ROOT.',
  );
const local = new URL(remote);
local.hostname = '127.0.0.1';
const health = async () => {
  try {
    return (
      await fetch(new URL('/health', local), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
};
const stop = async () => {
  if (!(await health())) {
    console.log('Native package worker is already offline.');
    return;
  }
  const response = await fetch(new URL('/shutdown', local), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2000),
  });
  if (response.status === 409)
    throw Error('Native package worker is busy; wait for its active build to finish.');
  if (!response.ok) throw Error(`Native package worker refused shutdown (${response.status}).`);
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await health())) {
      console.log('Native package worker stopped.');
      return;
    }
  }
  throw Error('Native package worker did not stop.');
};
if (action === 'status') {
  const healthy = await health();
  console.log(healthy ? 'Native package worker is healthy.' : 'Native package worker is offline.');
  process.exit(healthy ? 0 : 1);
}
if (action === 'stop') {
  await stop();
  process.exit(0);
}
if (action === 'restart') await stop();
else if (action !== 'start') throw Error('Usage: native-worker.mjs [start|stop|restart|status]');
const start = async () => {
  if (await health()) {
    console.log('Native package worker is already healthy.');
    return;
  }
  const release =
    process.platform === 'win32'
      ? await acquireNativeWorkerStartLock(nativeWorkerStartLockName(remote.port))
      : async () => {};
  try {
    if (await health()) {
      console.log('Native package worker is already healthy.');
      return;
    }
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw Error('Start the native worker through npm.');
    for (const [command, args] of [
      [process.execPath, [npmCli, 'run', 'build']],
      [
        'dotnet',
        ['publish', 'worker/PS5Library.Worker.csproj', '-c', 'Release', '--no-self-contained'],
      ],
    ]) {
      const result = spawnSync(command, args, {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        return;
      }
    }
    const logDir = path.join(data, 'logs');
    mkdirSync(logDir, { recursive: true });
    const stdout = openSync(path.join(logDir, 'native-worker.stdout.log'), 'a'),
      stderr = openSync(path.join(logDir, 'native-worker.stderr.log'), 'a');
    const env = {
      ...process.env,
      PACKAGE_WORKER_PORT: remote.port,
      PACKAGE_WORKER_DATA_DIR: data,
      PACKAGE_WORKER_DUMP_ROOT: dumps,
      PACKAGE_WORKER_SOURCE_ROOT: sources,
      DATA_DIR: data,
    };
    delete env.PACKAGE_WORKER_SOCKET;
    const child = spawn(process.execPath, ['dist/server/src/worker-main.js'], {
      cwd: process.cwd(),
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdout, stderr],
    });
    child.unref();
    closeSync(stdout);
    closeSync(stderr);
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await health()) {
        console.log('Native package worker started.');
        return;
      }
    }
    throw Error(
      `Native package worker did not start; inspect ${path.join(logDir, 'native-worker.stderr.log')}.`,
    );
  } finally {
    await release();
  }
};
await start();
