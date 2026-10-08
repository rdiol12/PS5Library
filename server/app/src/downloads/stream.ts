import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { remote } from '../security/http.js';
import { AppError } from '../security/errors.js';
import type { Progress } from '../../../shared/types/index.js';
import {requireDiskSpace} from '../storage/usage.js';

export async function fileHash(filename: string, progress?: (completedBytes: number) => Promise<void>) {
  const digest = createHash('sha256');
  let completedBytes=0,lastProgress=performance.now();
  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk);completedBytes+=chunk.length;
    const now=performance.now();if(progress&&now-lastProgress>=5_000){await progress(completedBytes);lastProgress=now;}
  }
  await progress?.(completedBytes);
  return digest.digest('hex');
}
export async function downloadFile(options: {
  location: string; local?: boolean; partPath: string; size: number; sha256: string; privateOrigins: string[];
  headers?: Record<string, string>; margin: number; signal?: AbortSignal; progress: (value: Progress) => Promise<void>; onVerify?: () => Promise<void>;
}) {
  await mkdir(path.dirname(options.partPath), { recursive: true });
  let offset = (await stat(options.partPath).catch(() => null))?.size ?? 0;
  if (offset > options.size) throw new AppError('CORRUPT_INPUT');
  await requireDiskSpace(path.dirname(options.partPath),options.size-offset+options.margin);
  let stream;
  if (options.local) {
    if ((await stat(options.location)).size !== options.size) throw new AppError('METADATA_MISMATCH');
    stream = createReadStream(options.location, { start: offset, signal: options.signal });
  } else {
    const previous = JSON.parse(await readFile(`${options.partPath}.json`, 'utf8').catch(() => '{}'));
    const headers = { ...options.headers };
    if (offset && previous.location === options.location && typeof previous.etag === 'string' && !previous.etag.startsWith('W/')) {
      headers.range = `bytes=${offset}-`; headers['if-range'] = previous.etag;
    } else offset = 0;
    const response = await remote(options.location, { privateOrigins: options.privateOrigins, headers, signal: options.signal });
    if (response.statusCode === 200) offset = 0;
    else if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '');
      if (!range || Number(range[1]) !== offset || Number(range[3]) !== options.size || Number(range[2]) !== options.size - 1) { response.destroy(); throw new AppError('INVALID_CONTENT_RANGE'); }
    } else if (response.statusCode === 416 && offset === options.size) {
      response.destroy();
      await options.onVerify?.();
      if (await fileHash(options.partPath) !== options.sha256) throw new AppError('CORRUPT_INPUT');
      return { size: options.size, sha256: options.sha256 };
    } else { response.destroy(); throw new AppError('DOWNLOAD_HTTP_ERROR', 502); }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); throw new AppError('UNEXPECTED_ENCODING'); }
    if (response.headers['content-length'] && Number(response.headers['content-length']) !== options.size - offset) { response.destroy(); throw new AppError('INCOMPLETE_INPUT'); }
    await writeFile(`${options.partPath}.json`, JSON.stringify({ location: options.location, etag: response.headers.etag ?? null }), { mode: 0o600 });
    stream = response;
  }
  const file = await open(options.partPath, offset ? 'a' : 'w', 0o600);
  let received = offset, last = 0; const start = performance.now();
  try {
    for await (const chunk of stream) {
      if (received + chunk.length > options.size) throw new AppError('CORRUPT_INPUT');
      // FileHandle.write can be partial; account only for bytes actually persisted.
      let written = 0;
      while (written < chunk.length) written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
      received += chunk.length;
      const now = performance.now();
      if (now - last > 1000) {
        const speed = Math.round((received - offset) * 1000 / Math.max(1, now - start));
        await options.progress({ downloadedBytes: received, totalBytes: options.size, speedBytesPerSecond: speed, etaSeconds: speed ? Math.ceil((options.size - received) / speed) : null });
        last = now;
      }
    }
    await file.sync();
  } finally { stream.destroy(); await file.close(); }
  if (received !== options.size) throw new AppError('INCOMPLETE_INPUT');
  await options.progress({ downloadedBytes: received, totalBytes: options.size, speedBytesPerSecond: 0, etaSeconds: 0 });
  await options.onVerify?.();
  const digest = await fileHash(options.partPath);
  if (digest !== options.sha256) throw new AppError('CORRUPT_INPUT');
  return { size: received, sha256: digest };
}
