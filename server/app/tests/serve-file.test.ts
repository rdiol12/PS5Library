import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { serveFile } from '../src/downloads/serve.js';

test('stored package streams use a Docker-bind-friendly read buffer', async () => {
  const file = process.execPath,
    size = (await stat(file)).size;
  let body: any;
  const reply = {
    header() {
      return this;
    },
    type() {
      return this;
    },
    send(value: any) {
      body = value;
      return value;
    },
  };
  serveFile({ headers: {}, method: 'GET' } as any, reply as any, file, size, '0'.repeat(64));
  assert.equal(body.readableHighWaterMark, 1024 * 1024);
  body.destroy();
});

test('stored package streams reject unsupported or malformed byte ranges', () => {
  for (const range of ['bytes=-500', 'bytes=0-1,3-4', 'bytes=4-nope', 'bytes=8-4']) {
    let status = 200,
      body: any,
      contentRange = '';
    const reply = {
      header(name: string, value: string) {
        if (name === 'content-range') contentRange = value;
        return this;
      },
      code(value: number) {
        status = value;
        return this;
      },
      send(value: any) {
        body = value;
        return value;
      },
    };
    serveFile(
      { headers: { range }, method: 'GET' } as any,
      reply as any,
      process.execPath,
      8,
      '0'.repeat(64),
    );
    assert.equal(status, 416, range);
    assert.equal(contentRange, 'bytes */8');
    assert.deepEqual(body, { error: 'INVALID_RANGE' });
  }
});
