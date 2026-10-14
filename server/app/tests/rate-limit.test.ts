import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { installRateLimits, rateLimitKey } from '../src/api/app.js';

const token = (value: number) => value.toString(16).padStart(64, '0');
const exampleAddress = (last: number) => ['203', '0', '113', last].join('.');
const alternateAddress = ['198', '51', '100', '8'].join('.');

test('20 authenticated clients behind one proxy keep independent request budgets', async (t) => {
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  await app.register(cookie);
  await installRateLimits(app);
  app.get('/api/v1/catalog', async () => ({ ok: true }));

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, client) =>
      Array.from({ length: 500 }, (_, request) =>
        app.inject({
          url: '/api/v1/catalog',
          headers:
            client < 10
              ? { authorization: `Bearer ${token(client + 1)}` }
              : {
                  cookie: `session=${token(client + 1)}`,
                  'x-forwarded-for': `203.0.113.${(request % 250) + 1}`,
                },
        }),
      ),
    ).flat(),
  );

  assert.equal(responses.length, 10_000);
  assert.ok(
    responses.every((response) => response.statusCode === 200),
    responses.find((response) => response.statusCode !== 200)?.body,
  );
});

test('login remains IP limited even when credentials and forwarded headers rotate', async (t) => {
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(rateLimit, { max: 2, timeWindow: '1 minute', keyGenerator: rateLimitKey });
  app.post('/api/v1/auth/login', async () => ({ ok: true }));

  for (let i = 1; i <= 2; i++)
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { authorization: `Bearer ${token(i)}`, 'x-forwarded-for': `203.0.113.${i}` },
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { authorization: `Bearer ${token(3)}`, 'x-forwarded-for': alternateAddress },
      })
    ).statusCode,
    429,
  );
});

test('the IP backstop does not disable a route-specific limit', async (t) => {
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  await app.register(cookie);
  await installRateLimits(app, 100);
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
    async () => ({ ok: true }),
  );

  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login' })).statusCode, 429);
});

test('pairing claims remain IP limited when authenticated credentials rotate', async (t) => {
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(rateLimit, { max: 2, timeWindow: '1 minute', keyGenerator: rateLimitKey });
  app.post('/api/v1/pairings/claim', async () => ({ ok: true }));

  for (let i = 1; i <= 2; i++)
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/pairings/claim',
          headers: { authorization: `Bearer ${token(i)}` },
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/pairings/claim',
        headers: { authorization: `Bearer ${token(3)}` },
      })
    ).statusCode,
    429,
  );
});

test('rotating untrusted credentials cannot evade the IP backstop', async (t) => {
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  await app.register(cookie);
  await installRateLimits(app, 2);
  app.get('/api/v1/catalog', async () => ({ ok: true }));

  for (let i = 1; i <= 2; i++)
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/catalog',
          headers: { authorization: `Bearer ${token(i)}` },
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (await app.inject({ url: '/api/v1/catalog', headers: { authorization: `Bearer ${token(3)}` } }))
      .statusCode,
    429,
  );
});

test('one trusted reverse-proxy hop preserves separate client IP budgets', async (t) => {
  const app = Fastify({ trustProxy: (_address, hop) => hop < 1 });
  t.after(() => app.close());
  await app.register(cookie);
  await installRateLimits(app, 2);
  app.get('/api/v1/catalog', async (req) => ({ ip: req.ip }));

  for (const ip of [exampleAddress(10), exampleAddress(11)])
    for (let request = 0; request < 2; request++) {
      const response = await app.inject({
        url: '/api/v1/catalog',
        headers: { 'x-forwarded-for': ip },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ip, ip);
    }
  for (const ip of [exampleAddress(10), exampleAddress(11)])
    assert.equal(
      (await app.inject({ url: '/api/v1/catalog', headers: { 'x-forwarded-for': ip } })).statusCode,
      429,
    );
});
