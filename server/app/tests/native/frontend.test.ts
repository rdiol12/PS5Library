import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { jobEvent } from '../../src/jobs/events.js';

test(
  'sandboxed storefront pairs, loads real account data and preserves its pairing',
  { timeout: 90000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', ''),
      workspace = process.cwd(),
      root = path.resolve('data', 'frontend-check-' + suffix);
    const config = {
      ...configuration({ ...process.env, OPERATOR_URL: '', OPERATOR_TOKEN: '' }),
      DUMP_ROOT: '',
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
    };
    const admin = database(config.DATABASE_URL),
      schema = 'frontend_' + suffix;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    config.DATABASE_URL = url.href;
    await mkdir(path.join(root, 'console'), { recursive: true });
    const app = await createApp(config),
      db = database(config.DATABASE_URL),
      execute = promisify(execFile);
    const arrivals: string[] = [];
    app.addHook('onRequest', async (req) => {
      arrivals.push(req.method + ' ' + req.url);
    });
    const call = async (route: string, body: unknown, token?: string) => {
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1' + route,
        payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      assert.ok(reply.statusCode < 400, reply.body);
      return reply.json();
    };
    const run = async (screen = 'My Library', frames = 120) =>
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
          `${root}/console:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library-native-host',
          '/state/config.json',
          '--size=640x360',
          `--frames=${frames}`,
          `--screen=${screen}`,
        ],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
    const waitFor = async (predicate: () => boolean, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail('Timed out waiting for native storefront activity');
    };
    try {
      await app.listen({ host: '0.0.0.0', port: 0 });
      const serverUrl = `http://host.docker.internal:${(app.server.address() as { port: number }).port}`;
      await writeFile(
        path.join(root, 'console/config.json'),
        JSON.stringify({ serverUrl, allowInsecureLan: true, storage: [] }),
      );
      const owner = await call('/auth/register', {
        username: 'native-ui-owner',
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      const agentPair = await call('/pairings', {
        deviceId: randomUUID(),
        name: 'My registered PS5',
        clientKind: 'SIMULATOR',
        firmware: '4.51',
      });
      const consoleId = (await call('/pairings/claim', { code: agentPair.code }, owner.token))
        .consoleId;
      await run();
      const statePath = path.join(root, 'console/device-state.json');
      let state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.ok(
        state.pairing?.code,
        'The native UI must request a frontend pairing without running the agent',
      );
      const identity = state.deviceId;
      await run();
      assert.equal(
        JSON.parse(await readFile(statePath, 'utf8')).pairing.id,
        state.pairing.id,
        'Restart reuses a pending code',
      );
      // An expired code is replaced, with the same persisted app identity.
      await db.query("UPDATE pairings SET expires_at=now()-interval '1 second' WHERE id=$1", [
        state.pairing.id,
      ]);
      await run();
      state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(state.deviceId, identity);
      assert.ok(state.pairing?.code);
      assert.equal(arrivals.filter((v) => v === 'POST /api/v1/frontend/pairings').length, 2);
      await call('/pairings/claim', { code: state.pairing.code, consoleId }, owner.token);
      await run('Profile');
      state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(state.consoleId, consoleId);
      assert.match(state.credential, /^[a-f0-9]{64}$/);
      assert.equal(state.pairing, null);
      const cache = JSON.parse(
        await readFile(path.join(root, 'console/catalog-cache.json'), 'utf8'),
      );
      assert.equal(cache.profile.username, 'native-ui-owner');
      assert.equal(cache.consoles[0].firmware, '4.51');
      assert.equal(cache.consoles.length, 1);
      assert.equal(cache.device.credential, undefined, 'Cached catalogs do not copy credentials');
      assert.equal(JSON.parse((await run('Settings')).stdout.trim()).screen, 'Settings');
      assert.equal(
        JSON.parse(await readFile(statePath, 'utf8')).credential,
        state.credential,
        'App restart keeps pairing',
      );
      assert.ok(
        arrivals.some((v) => v === 'GET /api/v1/device/native-updates'),
        'Native UI discovers the published update before the agent verifies its installed base',
      );
      const frontendSource = await readFile(
        path.join(workspace, '../frontend/ps5/frontend/storefront_core.cpp'),
        'utf8',
      );
      assert.match(
        frontendSource,
        /updateManifest_\["baseContentVersion"\].+app-update\/.+/s,
        'Native UI must pass the published base to the verifying agent',
      );
      assert.ok(
        arrivals.some((v) => v.startsWith('GET /api/v1/device/events?after=')),
        'Native UI opens the authenticated live event feed',
      );
      const eventReads = arrivals.filter((v) =>
          v.startsWith('GET /api/v1/device/events?after='),
        ).length,
        liveRun = run('Downloads', 300);
      await waitFor(
        () =>
          arrivals.filter((v) => v.startsWith('GET /api/v1/device/events?after=')).length >
          eventReads,
      );
      const before = arrivals.filter((v) => v === 'GET /api/v1/device/jobs').length,
        gameId = randomUUID(),
        releaseId = randomUUID(),
        jobId = randomUUID();
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA99998','Live progress check','{}')",
        [gameId, owner.user.id],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-PPSA99998_00-PS5LIBRARYTEST02','01.000.000','BASE','{}')",
        [releaseId, gameId],
      );
      await db.query(
        'INSERT INTO ' +
          'jobs(id,user_id,kind,release_id,state,desired_state,downloaded_bytes,total_bytes,speed_bytes_per_second,config) ' +
          "VALUES($1,$2,'DOWNLOAD',$3,'DOWNLOADING','PAUSED',64,128,32,'{}')",
        [jobId, owner.user.id, releaseId],
      );
      await jobEvent(db, jobId);
      await waitFor(() => arrivals.filter((v) => v === 'GET /api/v1/device/jobs').length > before);
      await liveRun;
      assert.ok(
        !arrivals.some((v) => /\/device\/(heartbeat|tasks|firmware)(\?|$)/.test(v)),
        'Native UI never runs payload tasks or firmware scans',
      );
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM console_heartbeats')).rows[0].n,
        0,
      );
      assert.equal((await db.query('SELECT count(*)::int AS n FROM consoles')).rows[0].n, 1);
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
