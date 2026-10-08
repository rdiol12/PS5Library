import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { existingWithin } from '../security/paths.js';
import { remoteBytes } from '../security/http.js';
import { AppError } from '../security/errors.js';
import { runSandboxArtwork } from '../library/inspect.js';
import {gameStorageFolder,safeStorageName} from '../storage/names.js';

const artworkLimit = 16 * 1024 ** 2;

export async function optimizeArtwork(input: Buffer, kind: string) {
  return (await import('./optimize.js')).optimizeArtwork(input, kind);
}

export async function optimizeArtworkIsolated(input: Buffer, kind: string, dataDir: string) {
  if (input.length > artworkLimit) throw new AppError('ARTWORK_TOO_LARGE');
  if (!process.env.PACKAGE_WORKER_SOCKET) return optimizeArtwork(input, kind);
  const stage = path.join(dataDir, 'artwork', '.staging', randomUUID());
  const source = path.join(stage, 'input');
  const output = path.join(stage, 'output.webp');
  try {
    await mkdir(stage, { recursive: true });
    await writeFile(source, input, { flag: 'wx' });
    const info = await runSandboxArtwork(source, output, kind);
    return { data: await readFile(output), info };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function cacheArtwork(db: DB, config: Config, gameId: string, input: Buffer, kind: string) {
  const inputHash = createHash('sha256').update(input).digest('hex');
  const cached = (await db.query('SELECT sha256,relative_path FROM artwork WHERE game_id=$1 AND kind=$2 AND input_sha256=$3', [gameId, kind, inputHash])).rows[0];
  if (cached && await stat(path.join(config.DATA_DIR, cached.relative_path)).catch(() => null)) return cached.sha256 as string;
  const { data, info } = await optimizeArtworkIsolated(input, kind, config.DATA_DIR);
  const hash = createHash('sha256').update(data).digest('hex');
  const game=(await db.query('SELECT title,title_id FROM games WHERE id=$1',[gameId])).rows[0];if(!game)throw new AppError('NOT_FOUND',404);
  const relativePath = path.posix.join('artwork',gameStorageFolder(game),`${safeStorageName(kind[0]!.toUpperCase()+kind.slice(1))} - ${hash.slice(0,12)}.webp`);
  await mkdir(path.dirname(path.join(config.DATA_DIR, relativePath)), { recursive: true });
  await writeFile(path.join(config.DATA_DIR, relativePath), data, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  await db.query('INSERT INTO artwork(id,game_id,kind,sha256,relative_path,width,height,size,input_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(game_id,kind) DO UPDATE SET sha256=$4,relative_path=$5,width=$6,height=$7,size=$8,input_sha256=$9', [randomUUID(), gameId, kind, hash, relativePath, info.width, info.height, data.length, inputHash]);
  return hash;
}
export async function fetchArtwork(config: Config, location: string, localRoot?: string) {
  if (localRoot && !/^https?:/.test(location)) {
    const file = await existingWithin(localRoot, path.resolve(localRoot, location));
    if ((await stat(file)).size > artworkLimit) throw new AppError('ARTWORK_TOO_LARGE');
    return readFile(file);
  }
  return remoteBytes(location, { privateOrigins: config.privateOrigins }, artworkLimit);
}
export const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#193443"/><stop offset="1" stop-color="#090f1d"/></linearGradient></defs><path fill="url(#g)" d="M0 0h600v800H0z"/><circle cx="300" cy="350" r="100" stroke="#66e5c2" stroke-width="3" fill="none"/><path d="M285 310l60 40-60 40z" fill="#66e5c2"/><text x="300" y="530" text-anchor="middle" fill="#91a8bd" font-family="sans-serif" font-size="21">PS5LIBRARY</text></svg>';
