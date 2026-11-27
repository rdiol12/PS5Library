import type { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { AppError } from '../security/errors.js';
import { regularFile, regularFileWithin } from '../security/paths.js';

export function serveFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  size: number,
  sha256: string,
  contentType = 'application/octet-stream',
  sent?: (start: number, end: number) => void,
  handle?: FileHandle,
) {
  let start = 0;
  let end = size - 1;
  reply
    .header('accept-ranges', 'bytes')
    .header('etag', `"${sha256}"`)
    .header('cache-control', 'private, no-store');
  if (req.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    const requestedStart = Number(range?.[1]);
    const requestedEnd = range?.[2] ? Number(range[2]) : null;
    if (
      !range ||
      !Number.isSafeInteger(requestedStart) ||
      requestedStart >= size ||
      (requestedEnd !== null &&
        (!Number.isSafeInteger(requestedEnd) || requestedEnd < requestedStart))
    ) {
      void handle?.close();
      return reply
        .code(416)
        .header('content-range', `bytes */${size}`)
        .send({ error: 'INVALID_RANGE' });
    }
    if (!req.headers['if-range'] || req.headers['if-range'] === `"${sha256}"`) {
      start = requestedStart;
      end = requestedEnd === null ? end : Math.min(requestedEnd, end);
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    }
  }
  const stream = handle
    ? handle.createReadStream({ start, end, highWaterMark: 1024 * 1024 })
    : createReadStream(file, { start, end, highWaterMark: 1024 * 1024 });
  if (sent && req.method !== 'HEAD') {
    let cursor = start;
    let last = Date.now();
    let reported = start;
    const report = () => {
      if (cursor > reported) {
        sent(start, cursor);
        reported = cursor;
        last = Date.now();
      }
    };
    stream.on('data', (chunk) => {
      cursor += chunk.length;
      if (Date.now() - last >= 1000) report();
    });
    stream.on('close', report);
  }
  return reply
    .type(contentType)
    .header('content-length', end - start + 1)
    .send(stream);
}

export async function serveStoredFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  size: number,
  sha256: string,
  contentType = 'application/octet-stream',
  root?: string,
) {
  let checked;
  try {
    checked = root ? await regularFileWithin(root, file, 'r') : await regularFile(file, 'r');
  } catch {
    throw new AppError('CORRUPT_INPUT', 409);
  }
  if (checked.info.size !== size) {
    await checked.handle.close();
    throw new AppError('CORRUPT_INPUT', 409);
  }
  return serveFile(req, reply, file, size, sha256, contentType, undefined, checked.handle);
}
