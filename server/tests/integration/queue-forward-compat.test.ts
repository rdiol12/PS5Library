import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { configuration } from '../../src/config.js';
import { startRunner } from '../../src/jobs/runner.js';

test('an older runner defers an unknown future queue job without consuming it', async () => {
  const base = configuration(),
    root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-future-queue-')),
    databaseUrl = `postgres://queue-check:${randomUUID()}@localhost/queue-check`,
    name = `ps5library-${createHash('sha256').update(databaseUrl).digest('hex').slice(0, 12)}`,
    redis = new URL(base.REDIS_URL),
    connection = {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      password: redis.password || undefined,
      db: Number(redis.pathname.slice(1) || 0),
    },
    queue = new Queue(name, { connection }),
    events: string[] = [],
    db = { query: async () => ({ rows: [], rowCount: 0 }) };
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    await queue.waitUntilReady();
    await queue.add('future-v2', { payload: true }, { jobId: 'future-job' });
    runner = await startRunner(
      db as never,
      { ...base, DATABASE_URL: databaseUrl, DATA_DIR: root } as never,
      { write: async (_level: string, event: string) => void events.push(event) } as never,
    );
    let state = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      state = (await queue.getJob('future-job'))
        ? await (await queue.getJob('future-job'))!.getState()
        : 'missing';
      if (state === 'delayed' || state === 'completed' || state === 'failed' || state === 'missing')
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state, 'delayed');
    assert.ok(events.includes('queue.job_unsupported_deferred'));
  } finally {
    await runner?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
