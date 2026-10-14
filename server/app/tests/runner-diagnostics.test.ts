import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupOrphanedQueueJobs,
  cleanupTerminalJobWorkspaces,
  closeIdleQueue,
  parseRedisInfo,
  queuedJobControlAllowed,
  retryableJobFailure,
  runActiveJob,
} from '../src/jobs/runner.js';

test('queue reconciliation removes only records that no longer exist in PostgreSQL', async () => {
  const removed: string[] = [];
  const knownWaiting = '156421b4-2940-4e88-8628-2fe40ba4280a',
    orphanDelayed = '356421b4-2940-4e88-8628-2fe40ba4280a',
    knownMedia = '656421b4-2940-4e88-8628-2fe40ba4280a',
    orphanMedia = '756421b4-2940-4e88-8628-2fe40ba4280a';
  const records = [
    [knownWaiting, 'download', 'waiting', {}],
    [orphanDelayed, 'download', 'delayed', {}],
    ['trailer-known', 'trailer', 'waiting', { id: knownMedia }],
    ['trailer-orphan', 'trailer', 'waiting', { id: orphanMedia }],
    ['future-job', 'future-task', 'waiting', {}],
  ].map(([id, name, state, data]) => ({
    id: id as string,
    name: name as string,
    state,
    data,
    remove: async () => void removed.push(id as string),
  }));
  const queue = {
    getJobs: async (states: string[]) =>
      records.filter((job) => states.includes(job.state as string)),
  };
  const db = {
    query: async (sql: string) => ({
      rows: sql.includes('game_media') ? [{ id: knownMedia }] : [{ id: knownWaiting }],
    }),
  };

  assert.deepEqual(await cleanupOrphanedQueueJobs(queue as any, db as any), {
    removed: 2,
    failed: 0,
  });
  assert.deepEqual(removed.sort(), [orphanDelayed, 'trailer-orphan'].sort());
});

test('closing a queue removes an empty namespace but preserves pending work', async () => {
  const actions: string[] = [];
  const queue = (waiting: number) => ({
    getJobCounts: async () => ({
      waiting,
      active: 0,
      delayed: 0,
      paused: 0,
      prioritized: 0,
      'waiting-children': 0,
    }),
    obliterate: async () => void actions.push('obliterate'),
    close: async () => void actions.push('close'),
  });

  await closeIdleQueue(queue(0) as any);
  assert.deepEqual(actions, ['obliterate', 'close']);
  actions.length = 0;
  await closeIdleQueue(queue(1) as any);
  assert.deepEqual(actions, ['close']);
});

test('Redis diagnostics keep only named INFO values', () => {
  assert.deepEqual(
    parseRedisInfo(
      '# Server\r\nredis_version:7.4.0\r\nuptime_in_seconds:123\r\nused_memory_human:2.5M\r\n',
    ),
    {
      redis_version: '7.4.0',
      uptime_in_seconds: '123',
      used_memory_human: '2.5M',
    },
  );
});

test('startup cleans terminal workspaces without discarding resumable failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-terminal-build-')),
    completed = '156421b4-2940-4e88-8628-2fe40ba4280a',
    active = '256421b4-2940-4e88-8628-2fe40ba4280a',
    retryable = '356421b4-2940-4e88-8628-2fe40ba4280a',
    corrupt = '456421b4-2940-4e88-8628-2fe40ba4280a',
    dismissed = '556421b4-2940-4e88-8628-2fe40ba4280a';
  await mkdir(path.join(root, 'jobs', completed), { recursive: true });
  await writeFile(path.join(root, 'jobs', completed, 'large.tmp'), 'temporary');
  await mkdir(path.join(root, 'jobs', retryable), { recursive: true });
  await writeFile(path.join(root, 'jobs', retryable, 'content.part'), 'resume me');
  await mkdir(path.join(root, 'jobs', corrupt), { recursive: true });
  await mkdir(path.join(root, 'jobs', dismissed), { recursive: true });
  await writeFile(path.join(root, 'jobs', dismissed, 'content.part'), 'dismissed');
  await mkdir(path.join(root, 'jobs', active), { recursive: true });
  await writeFile(path.join(root, 'jobs', active, 'keep.tmp'), 'active');
  await mkdir(path.join(root, 'jobs', 'not-a-job'));
  const db = {
    query: async (_sql: string, values?: unknown[]) => {
      assert.deepEqual(values, [[active, completed, corrupt, dismissed, retryable].sort()]);
      return {
        rows: [
          { id: completed, state: 'COMPLETED', error: null },
          { id: retryable, state: 'ERROR', error: 'DOWNLOAD_TIMEOUT' },
          { id: corrupt, state: 'ERROR', error: 'CORRUPT_INPUT' },
          { id: dismissed, state: 'ERROR', error: 'DOWNLOAD_TIMEOUT', dismissed_at: new Date() },
        ],
      };
    },
  } as any;
  try {
    assert.equal(await cleanupTerminalJobWorkspaces(db, root), 3);
    await assert.rejects(stat(path.join(root, 'jobs', completed)), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(root, 'jobs', corrupt)), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(root, 'jobs', dismissed)), { code: 'ENOENT' });
    assert.ok(await stat(path.join(root, 'jobs', retryable, 'content.part')));
    assert.ok(await stat(path.join(root, 'jobs', active, 'keep.tmp')));
    assert.ok(await stat(path.join(root, 'jobs', 'not-a-job')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace cleanup does not query job history when no workspace directory exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-terminal-empty-'));
  let queried = false;
  const db = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  } as any;
  try {
    assert.equal(await cleanupTerminalJobWorkspaces(db, root), 0);
    assert.equal(queried, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an inaccessible terminal workspace does not block cleanup of the others', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-terminal-denied-')),
    denied = '456421b4-2940-4e88-8628-2fe40ba4280a',
    removable = '556421b4-2940-4e88-8628-2fe40ba4280a';
  await mkdir(path.join(root, 'jobs', denied), { recursive: true });
  await mkdir(path.join(root, 'jobs', removable), { recursive: true });
  const db = {
    query: async (_sql: string, values?: unknown[]) => {
      assert.deepEqual(values, [[denied, removable].sort()]);
      return { rows: [{ id: denied }, { id: removable }] };
    },
  } as any;
  try {
    const remove = async (workspace: string) => {
      if (workspace.endsWith(denied)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      await rm(workspace, { recursive: true, force: true });
    };
    assert.equal(await cleanupTerminalJobWorkspaces(db, root, remove), 1);
    assert.ok(await stat(path.join(root, 'jobs', denied)));
    await assert.rejects(stat(path.join(root, 'jobs', removable)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stalled queue retry cannot overlap the same active job', async () => {
  const active = new Set<string>();
  let release!: () => void,
    starts = 0;
  const first = runActiveJob(active, 'same-job', async () => {
    starts++;
    await new Promise<void>((resolve) => (release = resolve));
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await runActiveJob(active, 'same-job', async () => {
      starts++;
    }),
    false,
  );
  release();
  assert.equal(await first, true);
  assert.equal(
    await runActiveJob(active, 'same-job', async () => {
      starts++;
    }),
    true,
  );
  assert.equal(starts, 2);
});

test('build jobs allow cancellation without allowing download-only controls', () => {
  assert.equal(queuedJobControlAllowed('BUILD', 'BUILDING', 'cancel'), true);
  for (const action of ['pause', 'resume'] as const)
    assert.equal(queuedJobControlAllowed('BUILD', 'BUILDING', action), false);
  for (const action of ['pause', 'resume', 'cancel'] as const)
    assert.equal(queuedJobControlAllowed('DOWNLOAD', 'DOWNLOADING', action), true);
  assert.equal(queuedJobControlAllowed('BUILD', 'COMPLETED', 'cancel'), false);
});

test('a transient storage mount denial is retried but a persistent denial fails', () => {
  assert.equal(retryableJobFailure(0, 'STORAGE_NOT_WRITABLE'), true);
  assert.equal(retryableJobFailure(2, 'STORAGE_NOT_WRITABLE'), false);
});
