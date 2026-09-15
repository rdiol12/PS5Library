import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { isPublicAddress } from './paths.js';
import { AppError } from './errors.js';

export interface RemoteOptions { privateOrigins: string[]; headers?: Record<string, string>; signal?: AbortSignal }
export async function remote(location: string, options: RemoteOptions, redirects = 0): Promise<http.IncomingMessage> {
  const url = new URL(location);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || redirects > 4) throw new AppError('SSRF_BLOCKED');
  const privateAllowed = options.privateOrigins.includes(url.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => (!privateAllowed && !isPublicAddress(a.address)) || ['linkLocal', 'multicast', 'unspecified'].includes(ipaddr.process(a.address).range()))) throw new AppError('SSRF_BLOCKED');
  if (url.protocol !== 'https:' && !privateAllowed) throw new AppError('HTTPS_REQUIRED');
  const pinned = addresses[0]!;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      headers: { 'user-agent': 'PS5Library/0.1', 'accept-encoding': 'identity', ...options.headers },
      signal: options.signal, timeout: 30_000,
      // Pin the validated DNS answer for the actual connection; no second resolver lookup.
      lookup: (_hostname, opts, callback) => opts.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, resolve);
    request.on('timeout', () => request.destroy(new AppError('DOWNLOAD_TIMEOUT', 504)));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (!response.headers.location) throw new AppError('INVALID_REDIRECT');
    const target = new URL(response.headers.location, url);
    const headers = { ...options.headers };
    if (target.origin !== url.origin) { delete headers.authorization; delete headers.cookie; }
    return remote(target.href, { ...options, headers }, redirects + 1);
  }
  return response;
}
export async function remoteBytes(location: string, options: RemoteOptions, maxBytes: number) {
  const response = await remote(location, options);
  if (response.statusCode !== 200) { response.destroy(); throw new AppError('SOURCE_HTTP_ERROR', 502); }
  let size = 0; const chunks: Buffer[] = [];
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) throw new AppError('INPUT_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { response.destroy(); }
}
