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
  const data = Buffer.alloc(1024 * 1024, 42), requests: string[] = [];
  const server = createServer((req, res) => {
    const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0); requests.push(req.headers.range ?? 'full');
    res.writeHead(start ? 206 : 200, { 'content-length': data.length - start, etag: '"fixture-v1"', ...(start ? { 'content-range': `bytes ${start}-${data.length-1}/${data.length}` } : {}) });
    res.end(data.subarray(start));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ps5library-download-'));
  const partPath = path.join(directory, 'content.part');
  const options = { location: `${origin}/file`, partPath, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), privateOrigins: [origin], margin: 0, progress: async () => {} };
  try {
    await assert.rejects(remote(`${origin}/file`, { privateOrigins: [] }), /SSRF_BLOCKED/);
    await writeFile(partPath, data.subarray(0, 12345));
    await writeFile(`${partPath}.json`, JSON.stringify({ etag: '"fixture-v1"', location: options.location }));
    const result = await downloadFile(options);
    assert.equal(result.size, data.length); assert.ok(requests.includes('bytes=12345-'));
    assert.deepEqual(await readFile(partPath), data);
    await assert.rejects(downloadFile({ ...options, sha256: '0'.repeat(64) }), /CORRUPT_INPUT/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
