import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import ipaddr from 'ipaddr.js';

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
export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
