import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { existingWithin } from '../security/paths.js';
import { remoteBytes } from '../security/http.js';
import { AppError } from '../security/errors.js';
sharp.cache({ memory: 32, files: 20, items: 100 });
export async function cacheArtwork(db: DB, config: Config, gameId: string, input: Buffer, kind: string) {
  if (input.length > 12 * 1024 ** 2) throw new AppError('ARTWORK_TOO_LARGE');
  const decoded = sharp(input, { limitInputPixels: 16_000_000, animated: false, failOn: 'warning' });
  const metadata = await decoded.metadata();
  if (!['png','jpeg','webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || (metadata.pages ?? 1) > 1) throw new AppError('INVALID_ARTWORK');
  const size = kind === 'hero' ? [1600, 900] : kind === 'icon' ? [256, 256] : kind.startsWith('screenshot') ? [1280, 720] : [600, 800];
  const { data, info } = await decoded.rotate().resize(size[0], size[1], { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const hash = createHash('sha256').update(data).digest('hex');
  const relativePath = path.join('artwork', hash.slice(0, 2), `${hash}.webp`);
  await mkdir(path.dirname(path.join(config.DATA_DIR, relativePath)), { recursive: true });
  await writeFile(path.join(config.DATA_DIR, relativePath), data, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  await db.query('INSERT INTO artwork(id,game_id,kind,sha256,relative_path,width,height,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(game_id,kind) DO UPDATE SET sha256=$4,relative_path=$5,width=$6,height=$7,size=$8', [randomUUID(), gameId, kind, hash, relativePath, info.width, info.height, data.length]);
  return hash;
}
export async function fetchArtwork(config: Config, location: string, localRoot?: string) {
  if (localRoot && !/^https?:/.test(location)) {
    const file = await existingWithin(localRoot, path.resolve(localRoot, location));
    if ((await stat(file)).size > 12 * 1024 ** 2) throw new AppError('ARTWORK_TOO_LARGE');
    return readFile(file);
  }
  return remoteBytes(location, { privateOrigins: config.privateOrigins }, 12 * 1024 ** 2);
}
export const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#193443"/><stop offset="1" stop-color="#090f1d"/></linearGradient></defs><path fill="url(#g)" d="M0 0h600v800H0z"/><circle cx="300" cy="350" r="100" stroke="#66e5c2" stroke-width="3" fill="none"/><path d="M285 310l60 40-60 40z" fill="#66e5c2"/><text x="300" y="530" text-anchor="middle" fill="#91a8bd" font-family="sans-serif" font-size="21">PS5LIBRARY</text></svg>';
