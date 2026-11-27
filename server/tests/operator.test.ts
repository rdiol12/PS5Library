import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerBrokerAction } from '../src/operator-client.js';

test('Docker broker accepts only status and fixed-service restart routes', () => {
  assert.deepEqual(dockerBrokerAction('GET', '/v1/status'), { kind: 'status' });
  assert.deepEqual(dockerBrokerAction('POST', '/v1/services/worker/restart'), {
    kind: 'restart',
    service: 'worker',
  });
  for (const [method, route] of [
    ['GET', '/containers/json'],
    ['POST', '/v1/services/arbitrary/restart'],
    ['POST', '/v1/services/worker/start'],
    ['DELETE', '/v1/services/worker/restart'],
    ['POST', '/v1/services/worker/../server/restart'],
  ])
    assert.equal(dockerBrokerAction(method, route), null, `${method} ${route}`);
});
