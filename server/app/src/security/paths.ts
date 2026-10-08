import path from 'node:path';
import { createHash } from 'node:crypto';
import { realpath, lstat, open, type FileHandle } from 'node:fs/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from './errors.js';

export function safeName(name: string) {
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('UNSAFE_PATH');
  return name;
}
export function within(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('UNSAFE_PATH');
  return path.resolve(candidate);
}
export async function existingWithin(root: string, candidate: string) {
  const resolved = within(await realpath(root), await realpath(within(root, candidate)));
  if ((await lstat(candidate)).isSymbolicLink()) throw new Error('UNSAFE_PATH');
  return resolved;
}
export const sameFile = (pathInfo: Awaited<ReturnType<typeof lstat>>, handleInfo: Awaited<ReturnType<FileHandle['stat']>>) => !pathInfo.isSymbolicLink() && pathInfo.isFile() && handleInfo.isFile() && pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino;
export async function regularFile(filename: string, flags: 'r'|'r+') { const handle = await open(filename, flags); try { const [pathInfo, info] = await Promise.all([lstat(filename), handle.stat()]); if (!sameFile(pathInfo, info)) throw new AppError('CORRUPT_INPUT', 409); return { handle, info }; } catch (error) { await handle.close(); throw error; } }
export async function fileHandleHash(handle: FileHandle) { const digest = createHash('sha256'); for await (const data of handle.createReadStream({ start: 0, autoClose: false })) digest.update(data); return digest.digest('hex'); }
export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
