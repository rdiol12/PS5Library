import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AppError } from '../security/errors.js';

sharp.cache({ memory: 32, files: 20, items: 100 });
export const artworkLimit = 16 * 1024 ** 2;

export async function optimizeArtwork(input: Buffer, kind: string) {
  if (input.length > artworkLimit) throw new AppError('ARTWORK_TOO_LARGE');
  const decoded = sharp(input, { limitInputPixels: 16_000_000, animated: false, failOn: 'warning' });
  const metadata = await decoded.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || (metadata.pages ?? 1) > 1) throw new AppError('INVALID_ARTWORK');
  const size = kind === 'hero' ? [1600, 900] : kind === 'icon' ? [256, 256] : kind.startsWith('screenshot') ? [1280, 720] : [600, 800];
  const { data, info } = await decoded.rotate().resize(size[0], size[1], { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  return { data, info };
}

export async function optimizeArtworkFile(input: string, output: string, kind: string) {
  const { data, info } = await optimizeArtwork(await readFile(input), kind);
  await writeFile(output, data, { flag: 'wx' });
  return { width: info.width, height: info.height, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
