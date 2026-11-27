import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLiveMessageAllowed } from '../src/consoles/routes.js';

test('an existing agent socket stops accepting messages after PS5 connections are disabled', () => {
  const config = { features: { ps5Connections: true } },
    closed = { code: 0, reason: '' };
  const socket = {
    close: (code: number, reason: string) => Object.assign(closed, { code, reason }),
  };
  assert.equal(deviceLiveMessageAllowed(config as any, socket), true);
  config.features.ps5Connections = false;
  assert.equal(deviceLiveMessageAllowed(config as any, socket), false);
  assert.deepEqual(closed, { code: 1008, reason: 'PS5 connections disabled' });
});
