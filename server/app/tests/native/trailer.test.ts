import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test(
  'native highlighted cover starts a cached trailer with audio after four seconds and cancels on navigation',
  { timeout: 90000 },
  async () => {
    const workspace = process.cwd(),
      root = path.resolve('data', 'native-trailer-' + randomUUID()),
      execute = promisify(execFile),
      credential = randomUUID(),
      gameId = randomUUID(),
      consoleId = randomUUID(),
      container = 'ps5library-video-' + randomUUID();
    let bytes: Buffer,
      musicBytes: Buffer,
      started = 0,
      firstRequest = 0,
      requests = 0,
      musicRequests = 0;
    const game: any = {
      id: gameId,
      title: 'Generated preview check',
      addedAt: '2026-09-16T00:00:00Z',
      releases: [{ id: randomUUID(), sources: [{ id: randomUUID() }], artifacts: [] }],
    };
    const media = (req: any, res: any, content: Buffer) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!match) {
        res.writeHead(200, { 'content-length': content.length });
        res.end(content);
        return;
      }
      const start = Number(match[1]),
        end = Number(match[2]);
      if (start < 0 || end < start || end >= content.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      const part = content.subarray(start, end + 1);
      res.writeHead(206, {
        'content-length': part.length,
        'content-range': `bytes ${start}-${end}/${content.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(part);
    };
    const api = createServer((req, res) => {
      req.resume();
      if (req.headers.authorization !== `Bearer ${credential}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === `/api/v1/trailers/${gameId}`) {
        requests++;
        firstRequest ||= Date.now();
        media(req, res, bytes);
        return;
      }
      if (req.url === `/api/v1/music/${gameId}`) {
        musicRequests++;
        media(req, res, musicBytes);
        return;
      }
      const console = { id: consoleId, name: 'Test console', library: [], storage: [] };
      const routes: Record<string, unknown> = {
        '/api/v1/device/catalog': [game],
        '/api/v1/device/status': console,
        '/api/v1/device/consoles': [console],
        '/api/v1/device/jobs': [],
        '/api/v1/device/tasks': [],
        '/api/v1/device/heartbeat': {},
        '/api/v1/device/profile': { username: 'Preview check', consoles: [] },
      };
      res.writeHead(req.url! in routes ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(routes[req.url!] ?? {}));
    });
    try {
      await mkdir(root, { recursive: true });
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${root}:/output`,
          'ps5library-build:0.43',
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=640x360:rate=30',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          '6',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-y',
          '/output/input.mp4',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      bytes = await readFile(path.join(root, 'input.mp4'));
      game.trailer = {
        url: `/api/v1/trailers/${gameId}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        duration: 6,
      };
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${root}:/output`,
          'ps5library-build:0.43',
          'ffmpeg',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:sample_rate=48000',
          '-t',
          '1',
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-y',
          '/output/music.mp4',
        ],
        { windowsHide: true, timeout: 30000 },
      );
      musicBytes = await readFile(path.join(root, 'music.mp4'));
      game.music = {
        url: `/api/v1/music/${gameId}`,
        sha256: createHash('sha256').update(musicBytes).digest('hex'),
        size: musicBytes.length,
        duration: 1,
      };
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
      const run = async (script: string, frames: number) => {
        const result = await execute(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            container,
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
          { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        return JSON.parse(result.stdout.trim());
      };
      const quick = await run('right,next', 180);
      assert.equal(quick.trailerStarts, 0);
      assert.equal(requests, 0, 'Quick navigation must not request video');
      started = Date.now();
      const playing = await run('', 760);
      assert.equal(playing.trailerStarts, 1);
      assert.ok(firstRequest - started >= 4000);
      assert.ok(playing.trailerFrames > 10, JSON.stringify(playing));
      assert.ok(playing.trailerAudioBytes > 10000, JSON.stringify(playing));
      assert.equal(playing.musicStarts, 1);
      assert.ok(
        playing.musicAudioBytes > 192000 * 2,
        'The one-second music loops before the trailer starts',
      );
      assert.equal(musicRequests, 1);
      const restrictedResult = await execute(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          'root',
          '--name',
          container,
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-e',
          'SDL_AUDIODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state:ro`,
          'ps5library-build:0.43',
          'sh',
          '-lc',
          'cp -a /state /tmp/state && chown -R nobody:nogroup /tmp/state && chown root:root ' +
            '/tmp/state/trailer-cache/*.mp4 && chmod 444 /tmp/state/trailer-cache/*.mp4 && exec runuser ' +
            '-u nobody -- /workspace/frontend/ps5/build/host/ps5library /tmp/state/config.json --size=640x360 ' +
            '--frames=760',
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      const restricted = JSON.parse(restrictedResult.stdout.trim());
      assert.ok(restricted.trailerFrames > 10, JSON.stringify(restricted));
      assert.ok(restricted.musicAudioBytes > 10000, JSON.stringify(restricted));
      const fetched = requests;
      const cancelled = await run([...Array(22).fill('wait'), 'next'].join(','), 750);
      assert.equal(cancelled.trailerStarts, 1);
      assert.equal(cancelled.trailerActive, false);
      assert.ok(cancelled.trailerFrames > 0);
      assert.equal(requests, fetched, 'Verified disk cache is reused');
    } finally {
      await execute('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
      if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
