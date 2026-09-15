import { randomBytes, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const secret = () => randomBytes(32).toString('hex');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function sameSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex')); }
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  return timingSafeEqual(await derive(password, salt, 64) as Buffer, Buffer.from(expected, 'hex'));
}
export function seal(plaintext: string, key: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(hash(key), 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(encrypted: string, key: string) {
  const bytes = Buffer.from(encrypted, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hash(key), 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
