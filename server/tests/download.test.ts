import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadFile } from '../src/downloads/stream.js';
import { remote } from '../src/security/http.js';

test('streamed downloads resume with a valid range and reject corrupt content and SSRF', async () => {
  const data = Buffer.alloc(1024 * 1024, 42),
    requests: string[] = [];
  const server = createServer((req, res) => {
    const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    requests.push(req.headers.range ?? 'full');
    res.writeHead(start ? 206 : 200, {
      'content-length': data.length - start,
      etag: '"fixture-v1"',
      ...(start ? { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` } : {}),
    });
    res.end(data.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ps5library-download-'));
  const partPath = path.join(directory, 'content.part');
  let verifying = 0;
  const options = {
    location: `${origin}/file`,
    partPath,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    privateOrigins: [origin],
    margin: 0,
    progress: async () => {},
    onVerify: async () => {
      verifying++;
    },
  };
  try {
    await assert.rejects(remote(`${origin}/file`, { privateOrigins: [] }), /SSRF_BLOCKED/);
    await writeFile(partPath, data.subarray(0, 12345));
    await writeFile(
      `${partPath}.json`,
      JSON.stringify({ etag: '"fixture-v1"', location: options.location }),
    );
    const result = await downloadFile(options);
    assert.equal(result.size, data.length);
    assert.ok(requests.includes('bytes=12345-'));
    assert.equal(verifying, 1, 'the UI can enter VERIFYING before the checksum pass');
    assert.deepEqual(await readFile(partPath), data);
    await assert.rejects(downloadFile({ ...options, sha256: '0'.repeat(64) }), /CORRUPT_INPUT/);
    assert.equal(verifying, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cross-origin redirects strip credentials regardless of header casing', async () => {
  let received: { authorization?: string; cookie?: string } = {};
  const target = createServer((req, res) => {
    received = req.headers;
    res.end('ok');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetOrigin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `${targetOrigin}/redirected` });
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceOrigin = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  try {
    const response = await remote(`${sourceOrigin}/start`, {
      privateOrigins: [sourceOrigin, targetOrigin],
      headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'X-Preserved': 'yes' },
    });
    for await (const _chunk of response) {
      /* drain */
    }
    assert.equal(response.statusCode, 200);
    assert.equal(received.authorization, undefined);
    assert.equal(received.cookie, undefined);
    assert.equal((received as Record<string, string | undefined>)['x-preserved'], 'yes');
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});
