import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

test(
  'delayed installation plan focuses the supported method before storage',
  { timeout: 30000 },
  async () => {
    const workspace = process.cwd(),
      root = path.resolve('data', 'storage-focus-' + randomUUID()),
      execute = promisify(execFile),
      credential = randomUUID(),
      consoleId = randomUUID(),
      gameId = randomUUID();
    const game = {
      id: gameId,
      title: 'Storage selection check',
      heroUrl: 'catalog-hero',
      releases: [
        { id: randomUUID(), kind: 'BASE', version: '01.00', sources: [{ id: randomUUID() }] },
      ],
    };
    const console = {
      id: consoleId,
      name: 'Test PS5',
      presence: 'ONLINE',
      storage: [],
      library: [],
    };
    let plans = 0;
    const api = createServer((req, res) => {
      req.resume();
      if (req.headers.authorization !== `Bearer ${credential}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/api/v1/device/installations/plan') {
        plans++;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              method: 'HOMEBREW',
              methods: ['HOMEBREW'],
              allowed: true,
              compatibility: { status: 'NATIVE_COMPATIBLE' },
              storage: [
                {
                  storageId: 'internal',
                  displayName: 'Internal Storage',
                  freeBytes: 1000000000,
                  requiredBytes: 1000,
                  allowed: true,
                  reason: null,
                },
              ],
            }),
          );
        }, 750);
        return;
      }
      const routes: Record<string, unknown> = {
        '/api/v1/device/catalog': [game],
        '/api/v1/device/status': console,
        '/api/v1/device/consoles': [console],
        '/api/v1/device/jobs': [],
        '/api/v1/device/tasks': [],
        '/api/v1/device/heartbeat': {},
        '/api/v1/device/profile': { username: 'Test', role: 'ADMIN', consoles: [] },
      };
      res
        .writeHead(req.url! in routes ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(routes[req.url!] ?? {}));
    });
    try {
      await mkdir(root, { recursive: true });
      await new Promise<void>((resolve) => api.listen(0, '0.0.0.0', resolve));
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
      await writeFile(
        path.join(root, 'catalog-cache.json'),
        JSON.stringify({
          serverUrl,
          device: { consoleId },
          catalog: [game],
          consoles: [console],
          status: console,
          library: [],
          jobs: [],
        }),
      );
      const script = [
        ...Array(4).fill('wait'),
        'select',
        'select',
        ...Array(6).fill('wait'),
        'down',
        'down',
        'down',
      ].join(',');
      const run = (script: string, frames: number) =>
        execute(
          'docker',
          [
            'run',
            '--rm',
            '-e',
            'SDL_VIDEODRIVER=dummy',
            '-e',
            'SDL_AUDIODRIVER=dummy',
            '-v',
            `${path.resolve(workspace, '..')}:/workspace:ro`,
            '-v',
            `${root}:/state`,
            'ps5library-build:0.43',
            'frontend/ps5/build/host/ps5library',
            '/state/config.json',
            '--size=640x360',
            `--frames=${frames}`,
            `--script=${script}`,
          ],
          { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        );
      const result = await run(script, 400);
      assert.equal(plans, 1, result.stdout);
      assert.equal(
        JSON.parse(result.stdout.trim()).focus,
        'method:HOMEBREW',
        'An async plan must focus the recommended installation method',
      );
      const boot = JSON.parse(await readFile(path.join(root, 'update-boot.json'), 'utf8'));
      assert.match(boot.launchId, /^[a-f0-9]{32}$/);
      const destination = await run(script + ',down', 450);
      assert.equal(
        JSON.parse(destination.stdout.trim()).focus,
        'destination:0',
        'Down advances from the supported method to its first writable destination',
      );
      assert.notEqual(
        JSON.parse(await readFile(path.join(root, 'update-boot.json'), 'utf8')).launchId,
        boot.launchId,
        'The launch window must distinguish new startup from a previous boot receipt',
      );
    } finally {
      if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'controller can reach header utilities, Options, and clean Back',
  { timeout: 60000 },
  async (t) => {
    const workspace = process.cwd(),
      relative = `data/storefront-check-${randomUUID()}`,
      root = path.join(workspace, relative);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'config.json'),
      JSON.stringify({
        serverUrl: '',
        font: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        storage: [],
      }),
    );
    await writeFile(
      path.join(root, 'preview.json'),
      JSON.stringify({ catalog: [], consoles: [], jobs: [], library: [] }),
    );
    const execute = promisify(execFile);
    const run = async (script: string, frames: number) => {
      const result = await execute(
        'docker',
        [
          'run',
          '--rm',
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library',
          '/state/config.json',
          '--preview',
          `--script=${script}`,
          `--frames=${frames}`,
        ],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(result.stdout.trim());
    };
    try {
      await t.test(
        'shoulder tab switching leaves Search and Profile reachable with Right',
        async () => {
          const rendered = await run('next,next,next,right', 205);
          assert.equal(rendered.focus, 'search');
          assert.ok(
            rendered.backdropCompositions > 0 && rendered.backdropCompositions < 10,
            'Static background must be reused across frames',
          );
          assert.equal((await run('next,next,next,right,right', 230)).focus, 'settings');
          assert.equal((await run('next,next,next,right,right,right', 255)).focus, 'profile');
        },
      );
      await t.test('Options opens one settings context over the current screen', async () => {
        const menu = await run('settings', 90);
        assert.equal(menu.screen, 'Home');
        assert.equal(menu.focus, 'network');
      });
      await t.test('Circle on Home exits the host preview cleanly', async () => {
        const stayed = await run('back', 180);
        assert.ok(stayed.frames >= 25);
        assert.equal(stayed.screen, 'Home');
      });
    } finally {
      assert.ok(root.startsWith(path.join(workspace, 'data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Downloads uses Cross for details and Options for the focused job menu',
  { timeout: 30000 },
  async () => {
    const workspace = process.cwd(),
      relative = `data/download-context-${randomUUID()}`,
      root = path.join(workspace, relative),
      releaseId = randomUUID(),
      gameId = randomUUID(),
      jobId = randomUUID();
    const execute = promisify(execFile);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, 'config.json'),
        JSON.stringify({
          serverUrl: '',
          font: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          storage: [],
        }),
      );
      await writeFile(
        path.join(root, 'preview.json'),
        JSON.stringify({
          catalog: [
            {
              id: gameId,
              title: 'Failed download',
              releases: [{ id: releaseId, kind: 'BASE', version: '01.00', sources: [] }],
            },
          ],
          consoles: [],
          library: [],
          profile: { role: 'ADMIN' },
          jobs: [
            {
              id: jobId,
              kind: 'BUILD',
              releaseId,
              title: 'Failed download',
              state: 'ERROR',
              error: 'CORRUPT_INPUT',
              location: 'Server cache / artifacts/failed.pkg',
            },
          ],
        }),
      );
      const run = async (script: string) =>
        JSON.parse(
          (
            await execute(
              'docker',
              [
                'run',
                '--rm',
                '-e',
                'SDL_VIDEODRIVER=dummy',
                '-e',
                'SDL_AUDIODRIVER=dummy',
                '-v',
                `${path.resolve(workspace, '..')}:/workspace:ro`,
                '-v',
                `${root}:/state`,
                'ps5library-build:0.43',
                'frontend/ps5/build/host/ps5library',
                '/state/config.json',
                '--preview',
                '--screen=Downloads',
                `--script=${script}`,
                '--frames=100',
              ],
              { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim(),
        );
      assert.equal((await run('select')).screen, 'Game', 'Cross opens the full game page');
      const menu = await run('settings');
      assert.equal(
        menu.screen,
        'Downloads',
        'Options keeps the Downloads page behind its context menu',
      );
      assert.equal(menu.focus, 'job-retry', 'A failed job focuses Retry in its context menu');
      await writeFile(
        path.join(root, 'preview.json'),
        JSON.stringify({
          catalog: [
            {
              id: gameId,
              title: 'Active download',
              releases: [{ id: releaseId, kind: 'BASE', version: '01.00', sources: [] }],
            },
          ],
          consoles: [],
          library: [],
          profile: { role: 'ADMIN' },
          jobs: [
            {
              id: jobId,
              kind: 'TRANSFER',
              releaseId,
              title: 'Active download',
              state: 'TRANSFERRING',
              downloadedBytes: 10,
              totalBytes: 100,
            },
          ],
        }),
      );
      assert.equal(
        (await run('settings')).focus,
        'job-cancel',
        'An active transfer must expose Cancel in its Options menu',
      );
    } finally {
      assert.ok(root.startsWith(path.join(workspace, 'data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Downloads shows an accepted installation while it waits for the PS5',
  { timeout: 30000 },
  async () => {
    const workspace = process.cwd(),
      root = path.resolve('data', 'waiting-install-' + randomUUID()),
      execute = promisify(execFile),
      credential = randomUUID(),
      consoleId = randomUUID(),
      installationId = randomUUID(),
      sourceReleaseId = randomUUID();
    let installationReads = 0,
      installationCancellations = 0;
    const console = {
      id: consoleId,
      name: 'Test PS5',
      presence: 'OFFLINE',
      storage: [],
      library: [],
    };
    const installation = {
      id: installationId,
      state: 'WAITING_FOR_PS5',
      error: null,
      method: 'FPKG',
      sourceReleaseId,
      consoleId,
      storageId: 'internal',
      sourceJobId: null,
      transferJobId: null,
      artifactId: randomUUID(),
      createdAt: new Date().toISOString(),
      title: 'Waiting game',
    };
    const api = createServer((req, res) => {
      req.resume();
      if (req.headers.authorization !== `Bearer ${credential}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/api/v1/device/installations') installationReads++;
      if (req.method === 'DELETE' && req.url === `/api/v1/device/installations/${installationId}`) {
        installationCancellations++;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      const routes: Record<string, unknown> = {
        '/api/v1/device/status': console,
        '/api/v1/device/catalog': [],
        '/api/v1/device/jobs': [],
        '/api/v1/device/installations': [installation],
        '/api/v1/device/consoles': [console],
        '/api/v1/device/profile': { username: 'Test', role: 'ADMIN', consoles: [] },
        '/api/v1/device/tasks': [],
        '/api/v1/device/heartbeat': {},
      };
      res
        .writeHead(req.url! in routes ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(routes[req.url!] ?? {}));
    });
    try {
      await mkdir(root, { recursive: true });
      await new Promise<void>((resolve) => api.listen(0, '0.0.0.0', resolve));
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
      const result = await execute(
        'docker',
        [
          'run',
          '--rm',
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-e',
          'SDL_AUDIODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library',
          '/state/config.json',
          '--size=640x360',
          '--screen=Downloads',
          '--frames=180',
        ],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      assert.ok(installationReads > 0, 'Downloads must fetch durable installation requests');
      assert.equal(
        JSON.parse(result.stdout.trim()).focus,
        `installation:${installationId}`,
        'A waiting installation must remain visible after the server accepts it',
      );
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-e',
          'SDL_AUDIODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library',
          '/state/config.json',
          '--size=640x360',
          '--screen=Downloads',
          '--script=wait,wait,settings,select',
          '--frames=180',
        ],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(installationCancellations, 1, 'Options can cancel a waiting installation');
    } finally {
      if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('Profile exposes the linked account friend presence', { timeout: 30000 }, async () => {
  const workspace = process.cwd(),
    relative = `data/profile-friends-${randomUUID()}`,
    root = path.join(workspace, relative),
    consoleId = randomUUID(),
    friendId = randomUUID(),
    execute = promisify(execFile);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'config.json'),
      JSON.stringify({
        serverUrl: '',
        font: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        storage: [],
      }),
    );
    await writeFile(
      path.join(root, 'preview.json'),
      JSON.stringify({
        catalog: [],
        jobs: [],
        library: [],
        consoles: [{ id: consoleId, name: 'Test PS5' }],
        profile: {
          username: 'Test user',
          role: 'MEMBER',
          consoles: [{ id: consoleId, name: 'Test PS5', presence: 'ONLINE', games: [] }],
        },
        communityAccount: {
          state: 'CONNECTED',
          account: { handle: 'test_master', displayName: 'Test Master' },
        },
        communityFriends: [
          {
            id: friendId,
            handle: 'alice_451',
            displayName: 'Alice',
            state: 'ONLINE',
            updatedAt: new Date().toISOString(),
            session: {
              id: randomUUID(),
              adapterId: 'homebrew-test-v1',
              gameTitleId: 'PPSA99999',
              gameVersion: '1.0.0',
              playerCount: 1,
              maxPlayers: 2,
              expiresAt: new Date(Date.now() + 90_000).toISOString(),
            },
          },
        ],
      }),
    );
    const result = await execute(
      'docker',
      [
        'run',
        '--rm',
        '-e',
        'SDL_VIDEODRIVER=dummy',
        '-e',
        'SDL_AUDIODRIVER=dummy',
        '-v',
        `${path.resolve(workspace, '..')}:/workspace:ro`,
        '-v',
        `${root}:/state`,
        'ps5library-build:0.43',
        'frontend/ps5/build/host/ps5library',
        '/state/config.json',
        '--preview',
        '--screen=Profile',
        '--script=down,down,right,right,right,select,down',
        '--frames=210',
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      JSON.parse(result.stdout.trim()).focus,
      `friend:${friendId}`,
      'Friends tab must expose the first friend to controller focus',
    );
  } finally {
    assert.ok(root.startsWith(path.join(workspace, 'data') + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'offline mode uses the cached store until the user reconnects',
  { timeout: 30000 },
  async () => {
    const workspace = process.cwd(),
      root = path.resolve('data', 'offline-store-' + randomUUID()),
      execute = promisify(execFile),
      credential = 'a'.repeat(64),
      consoleId = randomUUID(),
      gameId = randomUUID();
    let arrivals = 0;
    const api = createServer((req, res) => {
      arrivals++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    try {
      await mkdir(root, { recursive: true });
      await new Promise<void>((resolve) => api.listen(0, '0.0.0.0', resolve));
      const serverUrl = `http://host.docker.internal:${(api.address() as { port: number }).port}`;
      await writeFile(
        path.join(root, 'config.json'),
        JSON.stringify({
          serverUrl: '',
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
          libraryRevision: 1,
        }),
      );
      await writeFile(path.join(root, 'offline-mode.json'), 'true');
      await writeFile(
        path.join(root, 'catalog-cache.json'),
        JSON.stringify({
          serverUrl,
          device: { consoleId },
          catalog: [{ id: gameId, title: 'Cached game', releases: [] }],
          consoles: [{ id: consoleId, name: 'Cached PS5' }],
          status: { id: consoleId },
          library: [],
          jobs: [],
          profile: { username: 'Cached user' },
        }),
      );
      const run = async (script = '') =>
        JSON.parse(
          (
            await execute(
              'docker',
              [
                'run',
                '--rm',
                '-e',
                'SDL_VIDEODRIVER=dummy',
                '-e',
                'SDL_AUDIODRIVER=dummy',
                '-v',
                `${path.resolve(workspace, '..')}:/workspace:ro`,
                '-v',
                `${root}:/state`,
                'ps5library-build:0.43',
                'frontend/ps5/build/host/ps5library-native-host',
                '/state/config.json',
                '--size=640x360',
                '--frames=120',
                `--script=${script}`,
              ],
              { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
            )
          ).stdout.trim(),
        );
      const cached = await run();
      assert.equal(cached.offlineMode, true);
      assert.equal(cached.offline, true);
      assert.equal(
        cached.focus,
        `home:${gameId}`,
        'Offline Home must focus the cached console game without a configured server',
      );
      assert.equal(arrivals, 0, 'Explicit offline mode must not contact the library server');
      await writeFile(
        path.join(root, 'config.json'),
        JSON.stringify({
          serverUrl,
          allowInsecureLan: true,
          font: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          storage: [],
        }),
      );
      await run('settings,down,select');
      assert.equal(JSON.parse(await readFile(path.join(root, 'offline-mode.json'), 'utf8')), false);
      assert.ok(arrivals > 0, 'Turning offline mode off reconnects to the configured server');
    } finally {
      if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
