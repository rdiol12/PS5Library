import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';

const clientAddress = ['203', '0', '113', '7'].join('.');

test(
  'server manager starts without the optional operator and exposes redacted diagnostics only to administrators',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-manager-')),
      base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `manager_${randomUUID().replaceAll('-', '')}`,
      operatorToken = 'a'.repeat(64);
    let scoped: ReturnType<typeof database> | undefined;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    let operatorCalls = 0;
    const operatorFetch: typeof fetch = async (input, init) => {
      operatorCalls++;
      const endpoint = new URL(String(input));
      assert.equal(endpoint.origin, 'http://operator:3160');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${operatorToken}`);
      if (endpoint.pathname === '/v1/status')
        return Response.json({
          host: {
            uptimeSeconds: 3600,
            loadAverage: [0.1, 0.2, 0.3],
            cpuCount: 4,
            memory: { used: 1024, total: 4096 },
            disk: { used: 2048, free: 2048, total: 4096 },
          },
          services: [
            {
              id: 'worker',
              status: 'RUNNING',
              cpuPercent: 1.5,
              memoryBytes: 512,
              memoryLimit: 1024,
            },
            { id: 'server', status: 'RUNNING' },
            { id: 'postgres', status: 'RUNNING' },
            { id: 'redis', status: 'RUNNING' },
            { id: 'proxy', status: 'MISSING' },
          ],
        });
      assert.equal(endpoint.pathname, '/v1/services/worker/restart');
      assert.equal(init?.method, 'POST');
      return Response.json({ accepted: true }, { status: 202 });
    };
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: '',
      PACKAGE_WORKER_SOCKET: path.join(root, 'missing.sock'),
      OPERATOR_URL: '',
      OPERATOR_TOKEN: '',
      TRUST_PROXY_HOPS: 1,
    };
    const app = await createApp(config, { operatorFetch });
    const call = async (
      method: string,
      route: string,
      body?: unknown,
      token?: string,
      headers: Record<string, string> = {},
    ) => {
      const response = await app.inject({
        method: method as 'GET',
        url: '/api/v1' + route,
        payload: body,
        headers: {
          'x-forwarded-for': clientAddress,
          'user-agent': 'Manager test browser',
          ...headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      return { status: response.statusCode, body: response.json() };
    };
    try {
      const owner = (
        await call(
          'POST',
          '/auth/register',
          {
            username: 'manager-owner',
            password: 'test-password',
            bootstrapToken: base.BOOTSTRAP_TOKEN,
          },
          undefined,
          { 'x-forwarded-for': clientAddress, 'user-agent': 'Manager test browser' },
        )
      ).body;
      scoped = database(url.href);
      const gameId = randomUUID(),
        releaseId = randomUUID();
      await scoped.query(
        'INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5)',
        [gameId, owner.user.id, 'TEST00001', 'Paused job fixture', {}],
      );
      await scoped.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'1.00','BASE',$4)",
        [releaseId, gameId, 'TEST-CONTENT-ID', {}],
      );
      await scoped.query(
        "INSERT INTO jobs(id,user_id,kind,release_id,state,desired_state) VALUES($1,$2,'DOWNLOAD',$3,'PAUSED','PAUSED')",
        [randomUUID(), owner.user.id, releaseId],
      );
      const invite = (await call('POST', '/admin/invites', {}, owner.token)).body;
      const member = (
        await call('POST', '/auth/register', {
          username: 'manager-member',
          password: 'test-password',
          inviteToken: invite.token,
        })
      ).body;
      assert.equal((await call('GET', '/admin/status', undefined, member.token)).status, 403);
      assert.equal((await call('GET', '/admin/accounts', undefined, member.token)).status, 403);
      const withoutOperator = await call('GET', '/admin/status', undefined, owner.token);
      assert.equal(withoutOperator.status, 200);
      assert.equal(withoutOperator.body.services.operator.status, 'OFFLINE');
      assert.equal(withoutOperator.body.host, null);
      assert.deepEqual(withoutOperator.body.managedServices, []);
      assert.equal(withoutOperator.body.activeJobs, 0);
      assert.equal(operatorCalls, 0);
      assert.equal(
        (await call('POST', '/admin/services/worker/restart', { confirm: 'worker' }, owner.token))
          .status,
        503,
      );
      assert.equal(operatorCalls, 0);
      config.OPERATOR_URL = 'http://operator:3160';
      config.OPERATOR_TOKEN = operatorToken;
      const status = await call('GET', '/admin/status', undefined, owner.token);
      assert.equal(status.status, 200);
      assert.equal(status.body.services.database.status, 'CONNECTED');
      assert.equal(status.body.services.redis.status, 'CONNECTED');
      assert.equal(status.body.services.worker.status, 'OFFLINE');
      assert.equal(status.body.queue.consumerRunning, true);
      assert.equal(status.body.host.cpuCount, 4);
      assert.equal(status.body.managedServices[0].id, 'worker');
      const accounts = await call('GET', '/admin/accounts', undefined, owner.token);
      assert.equal(accounts.status, 200);
      assert.equal(
        accounts.body.find((entry: { username: string }) => entry.username === 'manager-owner')
          .sessions[0].ip,
        clientAddress,
      );
      assert.equal(
        (await call('POST', '/admin/services/worker/restart', { confirm: 'redis' }, owner.token))
          .status,
        400,
      );
      assert.equal(
        (await call('POST', '/admin/services/worker/restart', { confirm: 'worker' }, owner.token))
          .status,
        202,
      );
      assert.equal((await call('GET', '/admin/jobs?limit=10', undefined, owner.token)).status, 200);
      const logs = await call(
        'GET',
        '/admin/logs?service=server&level=INFO',
        undefined,
        owner.token,
      );
      assert.equal(logs.status, 200);
      assert.ok(
        logs.body.some(
          (entry: { event: string; service: string }) =>
            entry.event === 'server.initialized' && entry.service === 'server',
        ),
      );
    } finally {
      await app.close();
      await scoped?.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
