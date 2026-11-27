import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../src/api/app.js';
import { hash } from '../../src/auth/credentials.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';

test(
  '20 authenticated Range artifact streams complete with exact bytes',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-download-capacity-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `download_capacity_${randomUUID().replaceAll('-', '')}`;
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
      const userId = registered.json().user.id;
      const count = 20,
        rangeSize = 256 * 1024,
        data = randomBytes(count * rangeSize),
        gameId = randomUUID(),
        releaseId = randomUUID(),
        artifactId = randomUUID(),
        relative = 'artifacts/capacity.pkg',
        sha256 = createHash('sha256').update(data).digest('hex');
      await mkdir(path.join(root, 'artifacts'));
      await writeFile(path.join(root, relative), data);
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'CAP000001','Capacity artifact','{}')",
        [gameId, userId],
      );
      await db.query(
        'INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) ' +
          "VALUES($1,$2,'IV0000-CAP000001_00-CAPACITYTEST0000','01.00','BASE','{}')",
        [releaseId, gameId],
      );
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,$5,true,'{}')",
        [artifactId, releaseId, relative, sha256, data.length],
      );
      const consoleIds = Array.from({ length: count }, () => randomUUID()),
        deviceIds = consoleIds.map(() => randomUUID()),
        credentialIds = consoleIds.map(() => randomUUID()),
        tokens = consoleIds.map(() => randomBytes(32).toString('hex')),
        jobIds = consoleIds.map(() => randomUUID());
      await db.query(
        'INSERT INTO consoles(id,device_id,user_id,name,client_kind) SELECT ' +
          "id,device_id,$3,'Capacity PS5 '||n,'SIMULATOR' FROM unnest($1::uuid[],$2::uuid[]) WITH " +
          'ORDINALITY AS seed(id,device_id,n)',
        [consoleIds, deviceIds, userId],
      );
      await db.query(
        'INSERT INTO console_credentials(id,console_id,token_hash,last_seen_at,last_ip) SELECT ' +
          "credential_id,console_id,token_hash,now(),'127.0.0.1'::inet FROM " +
          'unnest($1::uuid[],$2::uuid[],$3::text[]) AS seed(credential_id,console_id,token_hash)',
        [credentialIds, consoleIds, tokens.map(hash)],
      );
      await db.query(
        'INSERT INTO jobs(id,user_id,kind,release_id,artifact_id,console_id,state,total_bytes) ' +
          "SELECT job_id,$2,'TRANSFER',$3,$4,console_id,'TRANSFERRING',$5 FROM " +
          'unnest($1::uuid[],$6::uuid[]) AS seed(job_id,console_id)',
        [jobIds, userId, releaseId, artifactId, data.length, consoleIds],
      );
      const origin = await app.listen({ host: '127.0.0.1', port: 0 }),
        started = performance.now();
      const streams = tokens.map(async (token, index) => {
        const first = index * rangeSize,
          last = first + rangeSize - 1,
          requestStarted = performance.now(),
          response = await fetch(`${origin}/api/v1/device/artifacts/${artifactId}`, {
            headers: { authorization: `Bearer ${token}`, range: `bytes=${first}-${last}` },
            signal: AbortSignal.timeout(10000),
          });
        assert.equal(response.status, 206);
        assert.equal(
          response.headers.get('content-range'),
          `bytes ${first}-${last}/${data.length}`,
        );
        assert.equal(response.headers.get('content-length'), String(rangeSize));
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        if (!response.body) throw new Error('Artifact response has no body');
        const digest = createHash('sha256');
        let received = 0;
        for await (const chunk of response.body) {
          digest.update(chunk);
          received += chunk.byteLength;
        }
        assert.equal(received, rangeSize);
        assert.equal(
          digest.digest('hex'),
          createHash('sha256')
            .update(data.subarray(first, last + 1))
            .digest('hex'),
        );
        assert.equal(response.bodyUsed, true);
        return performance.now() - requestStarted;
      });
      const durations = (await Promise.all(streams)).sort((a, b) => a - b),
        elapsedMs = performance.now() - started,
        p95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
      assert.equal(durations.length, count);
      t.diagnostic(
        `${count} authenticated Range streams: elapsed ${elapsedMs.toFixed(1)} ms, p95 ${p95Ms.toFixed(1)} ms`,
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
