import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../src/api/app.js';
import { hash } from '../../src/auth/credentials.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';

test(
  '20 authenticated clients can read the catalog, jobs and consoles together',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-read-capacity-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `read_capacity_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
        ...base,
        DATABASE_URL: url.href,
        DATA_DIR: root,
        SOURCE_ROOT: path.join(root, 'sources'),
        DUMP_ROOT: '',
        OPERATOR_URL: '',
        OPERATOR_TOKEN: '',
      },
      app = await createApp(config),
      db = database(config.DATABASE_URL);
    try {
      const registered = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          username: `capacity-${randomUUID()}`,
          password: 'test-password',
          bootstrapToken: config.BOOTSTRAP_TOKEN,
        },
      });
      assert.equal(registered.statusCode, 201, registered.body);
      const user = registered.json().user;
      const count = 50,
        gameIds = Array.from({ length: count }, () => randomUUID()),
        releaseIds = gameIds.map(() => randomUUID()),
        sourceReleaseIds = gameIds.map(() => randomUUID()),
        artifactIds = gameIds.map(() => randomUUID()),
        titleIds = gameIds.map((_, i) => `CAP${String(i).padStart(7, '0')}`),
        titles = gameIds.map((_, i) => `Capacity Game ${String(i + 1).padStart(2, '0')}`),
        sourceId = randomUUID();
      await db.query(
        'INSERT INTO games(id,user_id,title_id,title,metadata) SELECT ' +
          "id,$4,title_id,title,jsonb_build_object('publisher','Capacity " +
          "Studio','description',title||' release fixture') FROM " +
          'unnest($1::uuid[],$2::text[],$3::text[]) AS seed(id,title_id,title)',
        [gameIds, titleIds, titles, user.id],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) SELECT ' +
          "release_id,game_id,'IV0000-'||title_id||'_00-CAPACITYTEST0000','01.00','BASE',jsonb_build_object('title',title) " +
          'FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::text[]) AS ' +
          'seed(release_id,game_id,title_id,title)',
        [releaseIds, gameIds, titleIds, titles],
      );
      await db.query(
        "INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Capacity source','REMOTE_HTTP','{}')",
        [sourceId, user.id],
      );
      await db.query(
        'INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) SELECT ' +
          "source_release_id,$2,release_id,'capacity-'||n,jsonb_build_object('format','pkg','size',1048576) " +
          'FROM unnest($1::uuid[],$3::uuid[]) WITH ORDINALITY AS seed(source_release_id,release_id,n)',
        [sourceReleaseIds, sourceId, releaseIds],
      );
      await db.query(
        'INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) ' +
          'SELECT ' +
          "artifact_id,release_id,'pkg','artifacts/capacity-'||n||'.pkg',$3,1048576,true,'{}'::jsonb " +
          'FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY AS seed(artifact_id,release_id,n)',
        [artifactIds, releaseIds, 'a'.repeat(64)],
      );
      await db.query(
        'INSERT INTO ' +
          'jobs(id,user_id,kind,release_id,source_release_id,artifact_id,state,downloaded_bytes,total_bytes,config) ' +
          'SELECT ' +
          "gen_random_uuid(),$1,'DOWNLOAD',release_id,source_release_id,artifact_id,'COMPLETED',1048576,1048576,'{}'::jsonb " +
          'FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) AS ' +
          'seed(release_id,source_release_id,artifact_id)',
        [user.id, releaseIds, sourceReleaseIds, artifactIds],
      );
      const consoleIds = Array.from({ length: 5 }, () => randomUUID()),
        deviceIds = consoleIds.map(() => randomUUID()),
        consoleNames = consoleIds.map((_, i) => `Capacity PS5 ${i + 1}`);
      await db.query(
        'INSERT INTO consoles(id,device_id,user_id,name,client_kind,last_seen,firmware,runtime) ' +
          "SELECT id,device_id,$4,name,'SIMULATOR',now(),'9.60','capacity' FROM " +
          'unnest($1::uuid[],$2::uuid[],$3::text[]) AS seed(id,device_id,name)',
        [consoleIds, deviceIds, consoleNames, user.id],
      );
      await db.query(
        'INSERT INTO console_capabilities(console_id,capabilities) SELECT ' +
          'id,\'{"fpkgInstall":true}\'::jsonb FROM unnest($1::uuid[]) AS seed(id)',
        [consoleIds],
      );
      await db.query(
        'INSERT INTO ' +
          'console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) ' +
          "SELECT id,'internal','Internal SSD','/user',2000000000,1000000000,true,'[\"FPKG\"]'::jsonb " +
          'FROM unnest($1::uuid[]) AS seed(id)',
        [consoleIds],
      );
      const tokens = Array.from({ length: 20 }, () => randomBytes(32).toString('hex')),
        agents = tokens.map((_, i) => `Capacity client ${i + 1}`);
      await db.query(
        'INSERT INTO sessions(token_hash,user_id,expires_at,last_seen_at,last_ip,user_agent) SELECT ' +
          "token_hash,$2,now()+interval '1 hour',now(),'127.0.0.1',agent FROM " +
          'unnest($1::text[],$3::text[]) AS seed(token_hash,agent)',
        [tokens.map(hash), user.id, agents],
      );
      const routes = ['/catalog', '/jobs', '/consoles'] as const,
        started = performance.now(),
        requests = tokens.flatMap((token, client) =>
          routes.map(async (route) => {
            const requestStarted = performance.now(),
              response = await app.inject({
                url: `/api/v1${route}`,
                headers: { authorization: `Bearer ${token}`, 'user-agent': agents[client]! },
              });
            return {
              client,
              route,
              status: response.statusCode,
              durationMs: performance.now() - requestStarted,
              body: response.json(),
            };
          }),
        );
      let timer: NodeJS.Timeout | undefined;
      const responses = await Promise.race([
          Promise.all(requests),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Concurrent read burst exceeded 10 seconds')),
              10000,
            );
            timer.unref();
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        }),
        elapsedMs = performance.now() - started,
        durations = responses.map((response) => response.durationMs).sort((a, b) => a - b),
        p95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
      assert.equal(responses.length, 60);
      assert.deepEqual(
        responses
          .filter((response) => response.status !== 200)
          .map((response) => ({
            client: response.client,
            route: response.route,
            status: response.status,
          })),
        [],
      );
      for (const response of responses)
        assert.equal(
          response.body.length,
          response.route === '/catalog'
            ? count
            : response.route === '/jobs'
              ? count
              : consoleIds.length,
          response.route,
        );
      t.diagnostic(
        `20 clients / 60 reads: elapsed ${elapsedMs.toFixed(1)} ms, p95 ${p95Ms.toFixed(1)} ms`,
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(os.tmpdir() + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
