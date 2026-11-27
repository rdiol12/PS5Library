import test from 'node:test';
import assert from 'node:assert/strict';
import {
  throttleWorkerProgress,
  validWorkerProgress,
  workerProgressLogger,
} from '../src/worker-progress.js';

test('worker progress throttling keeps stage changes and completion immediate', async () => {
  const seen: number[] = [];
  let now = 0;
  const progress = throttleWorkerProgress(
    async (value) => {
      seen.push(value.operation?.completedBytes ?? -1);
    },
    () => now,
  );
  const event = (stage: string, completedBytes: number) => ({
    stage,
    completedStages: 3,
    totalStages: 7,
    operation: { completedBytes, totalBytes: 100 },
  });

  await progress(event('Building package', 10));
  now = 1_000;
  await progress(event('Building package', 20));
  now = 1_001;
  await progress(event('Verifying package', 30));
  now = 1_002;
  await progress(event('Verifying package', 100));

  assert.deepEqual(seen, [10, 30, 100]);
});

test('worker progress retries an event when its sink fails', async () => {
  let attempts = 0;
  const progress = throttleWorkerProgress(
    async () => {
      if (++attempts === 1) throw Error('temporary write failure');
    },
    () => 0,
  );
  const event = {
    stage: 'Building package',
    completedStages: 3,
    totalStages: 7,
    operation: { completedBytes: 10, totalBytes: 100 },
  };

  await assert.rejects(progress(event), /temporary write failure/);
  await progress(event);

  assert.equal(attempts, 2);
});

test('worker progress logs stages while deduplicating and throttling byte updates', async () => {
  const entries: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let now = 0;
  const progress = workerProgressLogger(
    {
      write: async (_level, event, _message, fields) => {
        entries.push({ event, fields });
      },
    },
    { requestId: 'request-1', task: 'build-archive', kind: 'dotnet' },
    () => now,
  );
  const extraction = (completedBytes: number) => ({
    stage: 'Extracting archive',
    completedStages: 0,
    totalStages: 7,
    extraction: { completedBytes, totalBytes: 100 },
    package: { state: 'EXTRACTING' },
    fakelib: { state: 'WAITING' },
  });
  const staging = (completedBytes: number, totalBytes = 100) => ({
    stage: 'Copying to staging',
    completedStages: 2,
    totalStages: 7,
    staging: { completedBytes, totalBytes },
    package: { state: 'STAGING' },
    fakelib: { state: 'COPYING' },
  });
  const operation = (completedBytes: number) => ({
    stage: 'Building package',
    completedStages: 3,
    totalStages: 7,
    operation: { completedBytes, totalBytes: 200 },
    package: { state: 'BUILDING' },
    fakelib: { state: 'SEPARATED' },
  });

  await progress({
    stage: 'Inspecting input',
    completedStages: 0,
    totalStages: 7,
    package: { state: 'WAITING' },
    fakelib: { state: 'UNKNOWN' },
  });
  await progress(extraction(10));
  await progress(extraction(10));
  now = 1_000;
  await progress(extraction(20));
  now = 5_000;
  await progress(extraction(20));
  now = 5_001;
  await progress(extraction(100));
  now = 10_001;
  await progress(staging(25, 1_000));
  now = 15_001;
  await progress(staging(999, 1_000));
  now = 15_002;
  await progress(staging(1_000, 1_000));
  now = 20_002;
  await progress(operation(50));
  now = 25_002;
  await progress(operation(200));

  assert.equal(entries.length, 9);
  assert.ok(
    entries.every(
      (entry) =>
        entry.event === 'worker.task_progress' &&
        entry.fields.requestId === 'request-1' &&
        entry.fields.task === 'build-archive',
    ),
  );
  assert.equal(entries[0]?.fields.percent, undefined);
  assert.equal(entries[5]?.fields.percent, 99);
  assert.deepEqual(entries[6]?.fields, {
    requestId: 'request-1',
    task: 'build-archive',
    kind: 'dotnet',
    stage: 'Copying to staging',
    state: 'STAGING',
    libraryState: 'COPYING',
    completedStages: 2,
    totalStages: 7,
    completedBytes: 1_000,
    totalBytes: 1_000,
    percent: 100,
  });
  assert.deepEqual(entries[8]?.fields, {
    requestId: 'request-1',
    task: 'build-archive',
    kind: 'dotnet',
    stage: 'Building package',
    state: 'BUILDING',
    libraryState: 'SEPARATED',
    completedStages: 3,
    totalStages: 7,
    completedBytes: 200,
    totalBytes: 200,
    percent: 100,
  });
  assert.ok(validWorkerProgress(operation(50)));
  assert.ok(
    !validWorkerProgress({ ...operation(50), staging: { completedBytes: 25, totalBytes: 100 } }),
  );
  assert.ok(
    !validWorkerProgress({ ...staging(25), extraction: { completedBytes: 25, totalBytes: 100 } }),
  );
  assert.ok(
    !validWorkerProgress({ ...staging(25), staging: { completedBytes: 101, totalBytes: 100 } }),
  );
});
