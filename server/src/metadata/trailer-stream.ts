import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { AppError } from '../security/errors.js';

// Resolves a YouTube trailer to the direct stream addresses a client then fetches by itself; no
// video passes through this server and nothing is written to disk. Addresses expire and are bound
// to the public IP that asked for them, so this only suits clients on the server's own network.

const run = promisify(execFile);
const heights = [360, 480, 720, 1080] as const;
export type StreamHeight = (typeof heights)[number];
export const streamHeight = (value: unknown): StreamHeight =>
  heights.includes(Number(value) as StreamHeight) ? (Number(value) as StreamHeight) : 1080;
const format = (height: StreamHeight) =>
  `bv*[vcodec^=avc1][height<=${height}][protocol=https]+ba[acodec^=mp4a][protocol=https]`;

export type TrailerStream = {
  videoId: string;
  duration: number | null;
  expiresAt: string;
  // `address` is the host's IPv4 address, for clients that cannot do the name lookup themselves.
  video: {
    url: string;
    address?: string;
    codec: string;
    width: number;
    height: number;
    size: number | null;
  };
  audio: { url: string; address?: string; codec: string; size: number | null };
};

const cache = new Map<string, TrailerStream>();
const pending = new Map<string, Promise<TrailerStream>>();
const streamHost = /(^|\.)googlevideo\.com$/;

const address = (value: unknown) => {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || !streamHost.test(url.hostname))
    throw new AppError('TRAILER_STREAM_UNAVAILABLE', 502);
  return url;
};

export function parseResolved(videoId: string, output: string, now = Date.now()): TrailerStream {
  const data = JSON.parse(output),
    formats: any[] = data.requested_formats ?? [],
    video = formats.find((item) => item.vcodec && item.vcodec !== 'none'),
    audio = formats.find((item) => item.acodec && item.acodec !== 'none' && item !== video);
  if (!video || !audio) throw new AppError('TRAILER_STREAM_UNAVAILABLE', 502);
  const videoUrl = address(video.url),
    audioUrl = address(audio.url),
    expire = Number(videoUrl.searchParams.get('expire')) * 1000,
    // Leave a margin so a client never starts on an address about to lapse.
    expiresAt = Number.isFinite(expire) && expire > now ? expire - 10 * 60_000 : now + 60 * 60_000;
  return {
    videoId,
    duration: Number.isFinite(data.duration) ? Number(data.duration) : null,
    expiresAt: new Date(expiresAt).toISOString(),
    video: {
      url: videoUrl.href,
      codec: String(video.vcodec),
      width: Number(video.width),
      height: Number(video.height),
      size: Number.isSafeInteger(video.filesize) ? video.filesize : null,
    },
    audio: {
      url: audioUrl.href,
      codec: String(audio.acodec),
      size: Number.isSafeInteger(audio.filesize) ? audio.filesize : null,
    },
  };
}

// The listing mixes short trailers with long reviews and gameplay videos, and some entries
// cannot be played at all. Lengths are read once per video and remembered in memory.
const lengths = new Map<string, number | null>();
async function videoLength(videoId: string) {
  if (lengths.has(videoId)) return lengths.get(videoId)!;
  const value = await run(
    'yt-dlp',
    [
      '--no-warnings',
      '--no-playlist',
      '--no-cache-dir',
      '--print',
      '%(duration)s',
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeout: 30_000, maxBuffer: 1024 ** 2, windowsHide: true },
  )
    .then(({ stdout }) => {
      const seconds = Number(stdout.trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    })
    .catch(() => null);
  if (lengths.size >= 2000) lengths.delete(lengths.keys().next().value!);
  lengths.set(videoId, value);
  return value;
}

// Playable videos, best first: those within the wanted length in their listed order, then the
// rest from shortest to longest.
export async function trailerCandidates(videoIds: string[], maxDuration?: number) {
  const ids = videoIds.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)).slice(0, 8),
    known: { id: string; seconds: number }[] = [];
  for (let start = 0; start < ids.length; start += 3)
    for (const [index, seconds] of (
      await Promise.all(ids.slice(start, start + 3).map(videoLength))
    ).entries())
      if (seconds) known.push({ id: ids[start + index]!, seconds });
  const fits = (item: { seconds: number }) => !maxDuration || item.seconds <= maxDuration;
  return [
    ...known.filter(fits),
    ...known.filter((item) => !fits(item)).sort((a, b) => a.seconds - b.seconds),
  ].map((item) => item.id);
}

export async function resolveTrailerStream(
  videoId: string,
  height: StreamHeight = 1080,
): Promise<TrailerStream> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new AppError('NOT_FOUND', 404);
  const key = `${videoId}:${height}`,
    known = cache.get(key);
  if (known && Date.parse(known.expiresAt) > Date.now()) return known;
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 3) throw new AppError('TRAILER_STREAM_BUSY', 503);
  const task = run(
    'yt-dlp',
    [
      '--no-warnings',
      '--no-playlist',
      '--no-cache-dir',
      '-f',
      format(height),
      '-j',
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeout: 45_000, maxBuffer: 16 * 1024 ** 2, windowsHide: true },
  )
    .then(async ({ stdout }) => {
      const resolved = parseResolved(videoId, stdout);
      // Some client profiles return addresses YouTube refuses to serve directly; never hand one out.
      for (const track of [resolved.video, resolved.audio]) {
        const url = track.url;
        track.address = await lookup(new URL(url).hostname, { family: 4 })
          .then((found) => found.address)
          .catch(() => undefined);
        const probe = await fetch(url, {
          headers: { range: 'bytes=0-1' },
          signal: AbortSignal.timeout(10_000),
        });
        await probe.body?.cancel();
        if (!probe.ok) throw new AppError('TRAILER_STREAM_UNAVAILABLE', 502);
      }
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, resolved);
      return resolved;
    })
    .catch((error) => {
      throw error instanceof AppError ? error : new AppError('TRAILER_STREAM_UNAVAILABLE', 502);
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
