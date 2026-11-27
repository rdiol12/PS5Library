import { createServer } from 'node:net';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const nativeWorkerStartLockName = (port) => {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535)
    throw Error('Native-worker lock requires a valid port.');
  return `\\\\.\\pipe\\ps5library-native-worker-start-${port}`;
};

const listen = (name) =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy()),
      failed = (error) => {
        if (error.code === 'EADDRINUSE') resolve(null);
        else reject(error);
      };
    server.once('error', failed);
    server.listen(name, () => {
      server.off('error', failed);
      server.unref();
      resolve(server);
    });
  });

export async function acquireNativeWorkerStartLock(name, { pollMs = 100, waitMs = 300_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const server = await listen(name);
    if (server) {
      let released = false;
      return () =>
        new Promise((resolve, reject) => {
          if (released) return resolve();
          released = true;
          server.close((error) => (error ? reject(error) : resolve()));
        });
    }
    if (Date.now() >= deadline)
      throw Error('Timed out waiting for another native-worker startup to finish.');
    await sleep(pollMs);
  }
}
