import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test(
  'visible artwork recovers when its first request precedes the upload',
  { timeout: 60000 },
  async () => {
    const workspace = process.cwd(),
      relative = `data/artwork-check-${randomUUID()}`,
      root = path.join(workspace, relative);
    const container = `ps5library-artwork-${randomUUID()}`,
      execute = promisify(execFile);
    const image = await readFile(path.join(workspace, '../frontend/ps5/assets/icon0.png'));
    const consoleId = randomUUID(),
      gameId = randomUUID(),
      credential = randomUUID();
    const artworkUrl = `/api/v1/games/${gameId}/artwork/cover`;
    const game = {
      id: gameId,
      title: 'Artwork upload regression',
      coverUrl: artworkUrl,
      heroUrl: artworkUrl,
      releases: [
        { id: randomUUID(), kind: 'BASE', version: '01.00', sources: [{ id: randomUUID() }] },
      ],
    };
    const console = { id: consoleId, name: 'Artwork test console', library: [], storage: [] };
    let artworkRequests = 0;
    const api = createServer((request, response) => {
      request.resume();
      if (request.headers.authorization !== `Bearer ${credential}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      if (request.url === artworkUrl) {
        if (++artworkRequests === 1) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png', etag: '"uploaded"' });
        response.end(image);
        return;
      }
      const routes: Record<string, unknown> = {
        '/api/v1/device/catalog': [game],
        '/api/v1/device/status': console,
        '/api/v1/device/consoles': [console],
        '/api/v1/device/jobs': [],
        '/api/v1/device/tasks': [],
        '/api/v1/device/heartbeat': {},
      };
      response.writeHead(request.url! in routes ? 200 : 404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(routes[request.url!] ?? { error: 'TEST_ROUTE_NOT_FOUND' }));
    });
    try {
      await mkdir(root, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        api.once('error', reject);
        api.listen(0, '0.0.0.0', resolve);
      });
      const serverUrl = `http://host.docker.internal:${(api.address() as { port: number }).port}`;
      await writeFile(
        path.join(root, 'config.json'),
        JSON.stringify({
          serverUrl,
          allowInsecureLan: true,
          font: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          storage: [],
        }),
      );
      await writeFile(
        path.join(root, 'device-state.json'),
        JSON.stringify({
          serverUrl,
          deviceId: randomUUID(),
          consoleId,
          credential,
          libraryRevision: 0,
        }),
      );
      // Frame-limited runs wait 10 ms per frame, allowing the five-second retry window to elapse.
      const result = await execute(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          container,
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library',
          '/state/config.json',
          '--size=640x360',
          '--frames=700',
        ],
        { windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 },
      );
      const metrics = JSON.parse(result.stdout.trim());
      assert.equal(metrics.preview, false, 'Exercise the real HTTP artwork loader');
      assert.ok(artworkRequests > 0, 'The visible game must request its artwork');
      assert.ok(
        metrics.textureBytes > 0,
        `Artwork must appear without restarting after upload; requests=${artworkRequests}, textureBytes=${metrics.textureBytes}`,
      );
    } finally {
      await execute('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
      if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
      assert.ok(root.startsWith(path.join(workspace, 'data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
