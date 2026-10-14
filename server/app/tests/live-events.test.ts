import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { jobJSON, liveJobEvents } from '../src/jobs/events.js';

const drain = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

test('build jobs report supplied compatibility files from their overlay profile', () => {
  const row = {
    id: 'job',
    kind: 'BUILD',
    config: {
      profile: {
        delivery: 'OVERLAY',
        requiredLibraries: [],
        requiredPatches: [],
        requiredFiles: [{ path: 'fakelib/compat.sprx', sha256: 'a'.repeat(64) }],
      },
      progress: { fakelib: { state: 'NOT_REQUIRED' } },
    },
  };
  assert.equal(jobJSON(row, true).compatibilityFilesSupplied, true);
  assert.equal(
    jobJSON(
      { ...row, config: { ...row.config, profile: { ...row.config.profile, requiredFiles: [] } } },
      true,
    ).compatibilityFilesSupplied,
    false,
  );
});

test('idle live events poll less often and recheck a revoked session', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const socket = Object.assign(new EventEmitter(), {
    bufferedAmount: 0,
    messages: [] as string[],
    closed: undefined as { code: number; reason: string } | undefined,
    send(message: string) {
      this.messages.push(message);
    },
    close(code: number, reason: string) {
      this.closed = { code, reason };
      this.emit('close');
    },
  });
  let eventQueries = 0,
    authQueries = 0,
    revoked = false;
  const cursors: number[] = [];
  liveJobEvents(
    socket,
    'owner',
    0,
    async (owner, cursor) => {
      assert.equal(owner, 'owner');
      cursors.push(cursor);
      eventQueries++;
      return eventQueries === 1 ? [{ id: 7, state: 'DOWNLOADING' }] : [];
    },
    async () => {
      authQueries++;
      if (revoked) throw new Error('revoked');
    },
  );
  await drain();
  assert.equal(eventQueries, 1);
  assert.equal(authQueries, 0);
  assert.deepEqual(JSON.parse(socket.messages[0]!), {
    type: 'events',
    events: [{ id: 7, state: 'DOWNLOADING' }],
  });

  t.mock.timers.tick(500);
  await drain();
  assert.deepEqual(cursors, [0, 7], 'active streams poll again after 500 ms');
  for (let i = 0; i < 14; i++) {
    t.mock.timers.tick(2_000);
    await drain();
  }
  assert.equal(eventQueries, 16, '30 seconds of idle streaming uses 16 event reads, down from 61');
  assert.equal(authQueries, 0, 'the handshake remains trusted until the periodic session check');

  revoked = true;
  t.mock.timers.tick(2_000);
  await drain();
  assert.equal(authQueries, 1);
  assert.equal(eventQueries, 16, 'revocation is checked before another event read');
  assert.deepEqual(socket.closed, { code: 1008, reason: 'Session expired' });
});
