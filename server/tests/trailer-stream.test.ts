import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResolved, resolveTrailerStream } from '../src/metadata/trailer-stream.js';

const output = (videoHost = 'rr1---sn-abc.googlevideo.com') =>
  JSON.stringify({
    duration: 90,
    requested_formats: [
      {
        url: `https://${videoHost}/videoplayback?expire=2000000000&ip=203.0.113.9`,
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 1920,
        height: 1080,
        filesize: 24796405,
      },
      {
        url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?expire=2000000000&mime=audio',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        filesize: 1458178,
      },
    ],
  });

test('a resolved trailer exposes separate video and audio addresses with an early expiry', () => {
  const stream = parseResolved('Qqzj-j4qk0E', output(), 1_900_000_000_000);
  assert.equal(stream.video.width, 1920);
  assert.equal(stream.video.codec, 'avc1.640028');
  assert.equal(stream.audio.codec, 'mp4a.40.2');
  assert.equal(stream.duration, 90);
  assert.equal(
    Date.parse(stream.expiresAt),
    2_000_000_000_000 - 10 * 60_000,
    'Clients stop using an address ten minutes before YouTube expires it',
  );
});

test('only YouTube video hosts over HTTPS are ever handed to a client', () => {
  assert.throws(() => parseResolved('Qqzj-j4qk0E', output('evil.example')), {
    code: 'TRAILER_STREAM_UNAVAILABLE',
  });
  assert.throws(() => parseResolved('Qqzj-j4qk0E', JSON.stringify({ requested_formats: [] })), {
    code: 'TRAILER_STREAM_UNAVAILABLE',
  });
});

test('malformed video ids are rejected before any lookup runs', async () => {
  await assert.rejects(resolveTrailerStream('../etc/passwd'), { code: 'NOT_FOUND' });
});
