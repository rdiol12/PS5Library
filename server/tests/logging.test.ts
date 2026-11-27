import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearDashboardLogs, readLogs, structuredLogger } from '../src/logging.js';

test('structured service logs are redacted, persisted and merged for the manager', async () => {
  const oldTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Jerusalem';
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-logs-'));
  try {
    const server = await structuredLogger(root, 'server'),
      worker = await structuredLogger(root, 'worker');
    await server.write('INFO', 'server.ready', 'Bearer ' + 'a'.repeat(64), {
      requestId: 'request-1',
    });
    await worker.write('ERROR', 'worker.failed', 'token=' + 'b'.repeat(64), {
      task: 'build',
      durationMs: 42,
    });
    const all = await readLogs(root, { limit: 10 });
    assert.deepEqual(new Set(all.map((entry) => entry.service)), new Set(['server', 'worker']));
    assert.ok(
      all.every((entry) =>
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+0[23]:00$/.test(entry.timestamp),
      ),
    );
    assert.ok(
      all.every(
        (entry) =>
          !JSON.stringify(entry).includes('a'.repeat(64)) &&
          !JSON.stringify(entry).includes('b'.repeat(64)),
      ),
    );
    const failures = await readLogs(root, { limit: 10, service: 'worker', level: 'ERROR' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.task, 'build');
    assert.equal(failures[0]?.durationMs, 42);
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
    await rm(root, { recursive: true, force: true });
  }
});

test('logger startup removes only expired local rotations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-log-retention-')),
    logs = path.join(root, 'logs'),
    outside = path.join(root, 'outside');
  try {
    await mkdir(logs);
    await Promise.all([
      writeFile(path.join(logs, 'worker.ndjson'), 'active'),
      writeFile(path.join(logs, 'server.ndjson'), 'active other service'),
      writeFile(path.join(logs, 'worker.1.ndjson'), 'expired'),
      writeFile(path.join(logs, 'worker.2.ndjson'), 'expired'),
      writeFile(path.join(logs, 'worker.2.ndjson.keep'), 'unrelated'),
      writeFile(path.join(logs, 'server.2.ndjson'), 'other service'),
      mkdir(path.join(logs, 'worker.4.ndjson')),
      mkdir(outside),
    ]);
    await writeFile(path.join(outside, 'marker'), 'outside');
    await symlink(outside, path.join(logs, 'worker.3.ndjson'), 'junction');

    await structuredLogger(root, 'worker');

    await assert.rejects(access(path.join(logs, 'worker.1.ndjson')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(logs, 'worker.2.ndjson')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(logs, 'worker.ndjson'), 'utf8'), 'active');
    assert.equal(await readFile(path.join(logs, 'worker.2.ndjson.keep'), 'utf8'), 'unrelated');
    await assert.rejects(access(path.join(logs, 'server.2.ndjson')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(logs, 'server.ndjson'), 'utf8'), 'active other service');
    assert.ok((await lstat(path.join(logs, 'worker.3.ndjson'))).isSymbolicLink());
    assert.equal(await readFile(path.join(outside, 'marker'), 'utf8'), 'outside');
    await access(path.join(logs, 'worker.4.ndjson'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard log clearing removes both services and rotations before one server audit entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-log-clear-')),
    logs = path.join(root, 'logs'),
    server = await structuredLogger(root, 'server');
  try {
    await server.write('INFO', 'server.old');
    await Promise.all([
      writeFile(path.join(logs, 'server.1.ndjson'), 'old server rotation'),
      writeFile(
        path.join(logs, 'worker.ndjson'),
        JSON.stringify({ service: 'worker', event: 'worker.old' }) + '\n',
      ),
      writeFile(path.join(logs, 'worker.1.ndjson'), 'old worker rotation'),
      writeFile(path.join(logs, 'worker.notes'), 'keep'),
    ]);
    await clearDashboardLogs(root, server);
    await server.write('WARN', 'admin.logs_cleared', 'Dashboard logs cleared');
    assert.deepEqual(
      (await readLogs(root, { limit: 10 })).map((entry) => entry.event),
      ['admin.logs_cleared'],
    );
    await assert.rejects(access(path.join(logs, 'worker.ndjson')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(logs, 'server.1.ndjson')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(logs, 'worker.1.ndjson')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(logs, 'worker.notes'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
