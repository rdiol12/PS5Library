import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { on } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { jobEvent } from '../../src/jobs/events.js';

test(
  'conversion details require an ADMIN owner across job, device and event APIs',
  { timeout: 45000 },
  async (t) => {
    const temp = path.resolve(os.tmpdir()),
      root = await mkdtemp(path.join(temp, 'ps5library-preparation-'));
    const base = configuration(),
      adminDb = database(base.DATABASE_URL);
    const schema = `preparation_${randomUUID().replaceAll('-', '')}`,
      url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
    };
    const db = database(config.DATABASE_URL),
      sockets: Array<{ terminate(): void }> = [];
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const conversion = {
      stage: 'Building package',
      completedStages: 3,
      totalStages: 7,
      package: { method: 'FPKG', state: 'BUILDING' },
      fakelib: { state: 'SEPARATED' },
    };
    const byteProgress = {
      downloadedBytes: 256,
      totalBytes: 1024,
      speedBytesPerSecond: 128,
      etaSeconds: 6,
    };
    const kinds = ['BUILD', 'DOWNLOAD', 'TRANSFER'] as const;
    const owners: Array<{
      role: string;
      token: string;
      deviceToken: string;
      jobs: Record<string, string>;
      artifactId: string;
      artifactPath: string;
      live?: Promise<any[]>;
    }> = [];
    const call = async (
      method: 'GET' | 'POST' | 'DELETE',
      route: string,
      payload?: unknown,
      token?: string,
    ) => {
      const response = await app!.inject({
        method,
        url: `/api/v1${route}`,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      assert.ok(response.statusCode < 400, `${route}: ${response.statusCode} ${response.body}`);
      return response.json();
    };
    const checkBytes = (value: any) => {
      for (const [key, expected] of Object.entries(byteProgress))
        assert.equal(value[key], expected, key);
    };
    try {
      await adminDb.query(`CREATE SCHEMA ${schema}`);
      app = await createApp(config);
      const admin = await call('POST', '/auth/register', {
        username: `admin-${randomUUID()}`,
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      const invite = await call('POST', '/admin/invites', {}, admin.token);
      const member = await call('POST', '/auth/register', {
        username: `member-${randomUUID()}`,
        password: 'test-password',
        inviteToken: invite.token,
      });
      assert.equal(admin.user.role, 'ADMIN');
      assert.equal(member.user.role, 'MEMBER');
      for (const account of [admin, member]) {
        const pairing = await call('POST', '/pairings', {
          deviceId: randomUUID(),
          name: `${account.user.role} test console`,
          clientKind: 'SIMULATOR',
        });
        await call('POST', '/pairings/claim', { code: pairing.code }, account.token);
        const device = await call('POST', `/pairings/${pairing.id}/poll`, {
          pollSecret: pairing.pollSecret,
        });
        const gameId = randomUUID(),
          releaseId = randomUUID(),
          artifactId = randomUUID(),
          artifactPath = `artifacts/${artifactId}.pkg`,
          jobs: Record<string, string> = {};
        await db.query(
          'INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5)',
          [
            gameId,
            account.user.id,
            'BREW05001',
            'Generated preparation fixture',
            { platform: 'PS5' },
          ],
        );
        await db.query(
          "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'01.00','BASE','{}')",
          [releaseId, gameId, 'IV0000-BREW05001_00-PS5LIBRARYAPP000'],
        );
        await db.query(
          'INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) ' +
            "VALUES($1,$2,'pkg',$3,$4,1024,true,'{}')",
          [artifactId, releaseId, artifactPath, 'a'.repeat(64)],
        );
        await db.query(
          'INSERT INTO ' +
            'console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) ' +
            "VALUES($1,'test','Test storage',$2,4096,4096,true,'[\"HOMEBREW\"]')",
          [device.consoleId, root],
        );
        for (const kind of kinds) {
          const id = (jobs[kind] = randomUUID()),
            state = { BUILD: 'BUILDING', DOWNLOAD: 'DOWNLOADING', TRANSFER: 'TRANSFERRING' }[kind];
          // Paused desired state prevents the runner from executing these presentation fixtures.
          await db.query(
            'INSERT INTO ' +
              'jobs(' +
              'id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,desired_state,' +
              'downloaded_bytes,total_bytes,speed_bytes_per_second,eta_seconds,config' +
              ') ' +
              "VALUES($1,$2,$3,$4,$5,$6,'test',$7,'PAUSED',256,1024,128,6,$8)",
            [
              id,
              account.user.id,
              kind,
              releaseId,
              kind === 'TRANSFER' ? artifactId : null,
              device.consoleId,
              state,
              { progress: kind === 'BUILD' ? conversion : null },
            ],
          );
        }
        const owner = {
          role: account.user.role,
          token: account.token,
          deviceToken: device.credential,
          jobs,
          artifactId,
          artifactPath,
          live: undefined as Promise<any[]> | undefined,
        };
        const socket = await app.injectWS('/api/v1/events/live?after=0', {
          headers: { cookie: `session=${account.token}`, origin: config.browserOrigins[0] },
        });
        sockets.push(socket);
        owner.live = (async () => {
          const events: any[] = [];
          for await (const [raw] of on(socket, 'message', { signal: AbortSignal.timeout(10000) })) {
            const message = JSON.parse(raw.toString());
            assert.equal(message.type, 'events');
            events.push(...message.events);
            if (events.length >= kinds.length) return events;
          }
          throw new Error('Live events ended before the seeded jobs arrived');
        })();
        owners.push(owner);
      }
      for (const owner of owners)
        for (const id of Object.values(owner.jobs)) await jobEvent(db, id);
      const liveEvents = await Promise.all(owners.map((owner) => owner.live!));
      for (const [index, owner] of owners.entries()) {
        const expectedIds = Object.values(owner.jobs).sort();
        for (const [route, token] of [
          ['/jobs', owner.token],
          ['/device/jobs', owner.deviceToken],
        ]) {
          const jobs = await call('GET', route!, undefined, token);
          await t.test(`${owner.role} ${route} keeps private lifecycle and byte progress`, () => {
            assert.deepEqual(jobs.map((job: any) => job.id).sort(), expectedIds);
            for (const kind of ['DOWNLOAD', 'TRANSFER'])
              checkBytes(jobs.find((job: any) => job.id === owner.jobs[kind]));
            const build = jobs.find((job: any) => job.id === owner.jobs.BUILD);
            assert.equal(build.state, 'BUILDING');
            assert.equal(build.desiredState, 'PAUSED');
            assert.deepEqual(build.progress, owner.role === 'ADMIN' ? conversion : null);
            assert.equal(
              jobs.find((job: any) => job.id === owner.jobs.TRANSFER).location,
              `Server cache / ${owner.artifactPath}`,
            );
          });
        }
        await t.test(
          `${owner.role} job details expose only permitted conversion detail`,
          async () => {
            const build = await call('GET', `/jobs/${owner.jobs.BUILD}`, undefined, owner.token);
            assert.equal(build.state, 'BUILDING');
            assert.deepEqual(build.progress, owner.role === 'ADMIN' ? conversion : null);
            for (const kind of ['DOWNLOAD', 'TRANSFER'])
              checkBytes(await call('GET', `/jobs/${owner.jobs[kind]}`, undefined, owner.token));
          },
        );
        const replay = await call('GET', '/events?after=0', undefined, owner.token);
        for (const [name, events] of [
          ['event replay', replay],
          ['live events', liveEvents[index]],
        ] as const)
          await t.test(`${owner.role} ${name} keeps bytes and private jobs`, () => {
            assert.deepEqual(events.map((event: any) => event.jobId).sort(), expectedIds);
            for (const kind of ['DOWNLOAD', 'TRANSFER'])
              checkBytes(events.find((event: any) => event.jobId === owner.jobs[kind]).progress);
            const detail = events.find((event: any) => event.jobId === owner.jobs.BUILD).progress
              .conversion;
            if (owner.role === 'ADMIN') assert.deepEqual(detail, conversion);
            else assert.ok(detail == null, 'Members must not receive conversion details');
          });
        await t.test(`${owner.role} paired profile reports the actual owner role`, async () => {
          assert.equal(
            (await call('GET', '/device/profile', undefined, owner.deviceToken)).role,
            owner.role,
          );
        });
        await t.test(`${owner.role} cannot read another owner's job details`, async () => {
          for (const id of Object.values(owners[1 - index]!.jobs)) {
            const response = await app!.inject({
              url: `/api/v1/jobs/${id}`,
              headers: { authorization: `Bearer ${owner.token}` },
            });
            assert.equal(response.statusCode, 404);
          }
        });
      }
      const owner = owners[0],
        outsider = owners[1];
      await db.query(
        "UPDATE jobs SET state='ERROR',error='BUILD_FAILED' WHERE id=ANY($1::uuid[])",
        [[owner.jobs.BUILD, outsider.jobs.BUILD]],
      );
      const memberBuildRetry = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${outsider.jobs.BUILD}/control`,
        payload: { action: 'retry' },
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      assert.equal(memberBuildRetry.statusCode, 403, memberBuildRetry.body);
      assert.equal(memberBuildRetry.json().error, 'ADMIN_REQUIRED');
      assert.deepEqual(
        (await db.query('SELECT state,error FROM jobs WHERE id=$1', [outsider.jobs.BUILD])).rows[0],
        { state: 'ERROR', error: 'BUILD_FAILED' },
      );
      const adminBuildRetry = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${owner.jobs.BUILD}/control`,
        payload: { action: 'retry' },
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.equal(adminBuildRetry.statusCode, 200, adminBuildRetry.body);
      assert.deepEqual(
        (await db.query('SELECT state,error FROM jobs WHERE id=$1', [owner.jobs.BUILD])).rows[0],
        { state: 'QUEUED', error: null },
      );
      await db.query(
        "UPDATE jobs SET state='ERROR',desired_state='RUNNING',error='TRANSFER_FAILED' WHERE id=$1",
        [owner.jobs.TRANSFER],
      );
      await call(
        'POST',
        `/device/jobs/${owner.jobs.TRANSFER}/control`,
        { action: 'retry' },
        owner.deviceToken,
      );
      assert.equal(
        (await db.query('SELECT state,error FROM jobs WHERE id=$1', [owner.jobs.TRANSFER])).rows[0]
          .state,
        'QUEUED_FOR_PS5',
      );
      assert.equal(
        (await db.query('SELECT state,error FROM jobs WHERE id=$1', [owner.jobs.TRANSFER])).rows[0]
          .error,
        null,
      );
      await db.query(
        "INSERT INTO native_download_grants(job_id,token_hash,token_cipher,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [owner.jobs.TRANSFER, randomUUID(), randomUUID()],
      );
      await call(
        'POST',
        `/device/jobs/${owner.jobs.TRANSFER}/control`,
        { action: 'cancel' },
        owner.deviceToken,
      );
      assert.deepEqual(
        (await db.query('SELECT state,desired_state FROM jobs WHERE id=$1', [owner.jobs.TRANSFER]))
          .rows[0],
        { state: 'CANCELLED', desired_state: 'CANCELLED' },
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM native_download_grants WHERE job_id=$1',
            [owner.jobs.TRANSFER],
          )
        ).rows[0].count,
        0,
        'Cancelling a transfer revokes its native download grant',
      );
      await db.query(
        "UPDATE jobs SET state='TRANSFERRING',desired_state='RUNNING',dismissed_at=NULL WHERE id=$1",
        [owner.jobs.TRANSFER],
      );
      await db.query(
        'INSERT INTO console_library_entries(console_id,release_id,storage_id,state) SELECT ' +
          "console_id,release_id,storage_id,'QUEUED_FOR_PS5' FROM jobs WHERE id=$1 ON " +
          "CONFLICT(console_id,release_id,storage_id) DO UPDATE SET state='QUEUED_FOR_PS5'",
        [owner.jobs.TRANSFER],
      );
      await call(
        'POST',
        `/device/tasks/${owner.jobs.TRANSFER}/progress`,
        { state: 'CANCELLED', downloadedBytes: 256 },
        owner.deviceToken,
      );
      assert.deepEqual(
        (
          await db.query(
            'SELECT state,desired_state,dismissed_at IS NOT NULL AS dismissed FROM jobs WHERE id=$1',
            [owner.jobs.TRANSFER],
          )
        ).rows[0],
        { state: 'CANCELLED', desired_state: 'CANCELLED', dismissed: true },
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM console_library_entries WHERE console_id=(SELECT ' +
              'console_id FROM jobs WHERE id=$1) AND release_id=(SELECT release_id FROM jobs WHERE id=$1) ' +
              "AND storage_id=(SELECT storage_id FROM jobs WHERE id=$1) AND state<>'MISSING'",
            [owner.jobs.TRANSFER],
          )
        ).rows[0].count,
        0,
        'Native cancellation clears the pending console-library placeholder',
      );
      assert.ok(
        !(await call('GET', '/device/jobs', undefined, owner.deviceToken)).some(
          (job: any) => job.id === owner.jobs.TRANSFER,
        ),
        'Native cancellation disappears from Activity',
      );
      await db.query(
        "UPDATE jobs SET state='ERROR',desired_state='RUNNING',dismissed_at=NULL,error='TRANSFER_FAILED' WHERE id=$1",
        [owner.jobs.TRANSFER],
      );
      const active = await app.inject({
        method: 'DELETE',
        url: `/api/v1/device/jobs/${owner.jobs.DOWNLOAD}`,
        headers: { authorization: `Bearer ${owner.deviceToken}` },
      });
      assert.equal(active.statusCode, 409, active.body);
      await db.query("UPDATE jobs SET state='ERROR',error='TRANSFER_FAILED' WHERE id=$1", [
        owner.jobs.TRANSFER,
      ]);
      const forbidden = await app.inject({
        method: 'DELETE',
        url: `/api/v1/device/jobs/${owner.jobs.TRANSFER}`,
        headers: { authorization: `Bearer ${outsider.deviceToken}` },
      });
      assert.equal(forbidden.statusCode, 404, forbidden.body);
      await call('DELETE', `/device/jobs/${owner.jobs.TRANSFER}`, undefined, owner.deviceToken);
      assert.ok(
        !(await call('GET', '/device/jobs', undefined, owner.deviceToken)).some(
          (job: any) => job.id === owner.jobs.TRANSFER,
        ),
      );
      await jobEvent(db, owner.jobs.TRANSFER);
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS count FROM job_events WHERE job_id=$1', [
            owner.jobs.TRANSFER,
          ])
        ).rows[0].count,
        0,
        'Dismissal removes events that can no longer be displayed',
      );
      const visibleEvents = await call('GET', '/events?after=0', undefined, owner.token);
      assert.ok(
        !visibleEvents.some((event: any) => event.jobId === owner.jobs.TRANSFER),
        'Dismissed jobs must not keep refreshing clients through the event feed',
      );
      assert.ok(
        visibleEvents.some((event: any) => event.jobId === owner.jobs.BUILD),
        'Visible jobs must still discover through the event feed',
      );
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS count FROM artifacts WHERE id=$1', [
            owner.artifactId,
          ])
        ).rows[0].count,
        1,
        'Removing download history must preserve the cached package',
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      await app?.close();
      await db.end();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminDb.end();
      assert.ok(root.startsWith(temp + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
