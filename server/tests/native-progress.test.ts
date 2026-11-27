import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceNativeProgress, sampleNativeSpeed } from '../src/transfers/native.js';

test('native speed aggregates parallel range completions for at least one second', () => {
  const mib = 1024 ** 2;
  const first = sampleNativeSpeed(undefined, 18 * mib, 30 * mib, 0);
  const parallel = sampleNativeSpeed(first.sample, 36 * mib, first.speed, 30);
  assert.equal(
    parallel.speed,
    30 * mib,
    'a near-simultaneous completion preserves the measured speed',
  );
  assert.deepEqual(parallel.sample, first.sample, 'a short sample does not reset the baseline');

  const aggregate = sampleNativeSpeed(parallel.sample, 54 * mib, parallel.speed, 1030);
  assert.equal(aggregate.speed, Math.floor((36 * mib) / 1.03));
  assert.deepEqual(aggregate.sample, { bytes: 54 * mib, at: 1030 });
});

test('native progress keeps one write per job while preserving every sent range', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    active = new Map<string, number>(),
    maximum = new Map<string, number>(),
    batches = new Map<string, number>(),
    coverage = new Map<string, Set<number>>();
  let writes = 0,
    largestBatch = 0,
    closed = false;
  const progress = coalesceNativeProgress(async (jobId, ranges) => {
    const count = (active.get(jobId) ?? 0) + 1,
      batch = (batches.get(jobId) ?? 0) + 1;
    active.set(jobId, count);
    batches.set(jobId, batch);
    maximum.set(jobId, Math.max(maximum.get(jobId) ?? 0, count));
    writes++;
    largestBatch = Math.max(largestBatch, ranges.length);
    if (batch === 1) await blocked;
    const bytes = coverage.get(jobId) ?? new Set<number>();
    coverage.set(jobId, bytes);
    for (const [start, end] of ranges) for (let byte = start; byte < end; byte++) bytes.add(byte);
    active.set(jobId, count - 1);
  });

  for (let job = 0; job < 16; job++) progress.sent(String(job), 0, 10);
  for (let job = 0; job < 16; job++) {
    progress.sent(String(job), 5, 20);
    progress.sent(String(job), 30, 40);
    progress.sent(String(job), 0, 15);
  }
  const closing = progress.close().then(() => (closed = true));
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for in-flight and queued ranges');
  assert.equal(writes, 16, 'a burst starts at most one write per job');
  release();
  await closing;

  assert.equal(writes, 32, 'queued callbacks are flushed once per job');
  assert.equal(
    largestBatch,
    2,
    'overlapping callbacks coalesce without filling an unbounded queue',
  );
  for (let job = 0; job < 16; job++) {
    assert.equal(maximum.get(String(job)), 1);
    assert.equal(
      coverage.get(String(job))?.size,
      30,
      'overlaps are counted once and gaps are not counted',
    );
  }
});

test('native progress retries a failed batch without losing its ranges or hanging shutdown', async () => {
  let attempts = 0,
    failures = 0;
  const written: readonly [number, number][][] = [];
  const progress = coalesceNativeProgress(
    async (_jobId, ranges) => {
      attempts++;
      if (attempts === 1) throw new Error('transient database failure');
      written.push(ranges);
    },
    () => failures++,
  );

  progress.sent('job', 0, 10);
  progress.sent('job', 5, 20);
  await progress.close();

  assert.equal(attempts, 2);
  assert.equal(failures, 1);
  assert.deepEqual(written, [[[0, 20]]]);

  let permanentAttempts = 0;
  const broken = coalesceNativeProgress(
    async () => {
      permanentAttempts++;
      throw new Error('database unavailable');
    },
    () => {},
  );
  broken.sent('job', 0, 10);
  await broken.close();
  assert.equal(
    permanentAttempts,
    3,
    'Persistent failure has a bounded retry budget during shutdown',
  );
});
