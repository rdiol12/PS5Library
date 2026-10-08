import { randomBytes, createHash, createHmac, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const secret = () => randomBytes(32).toString('hex');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function hardwareLookup(proof:string,key:string){
  if(!/^[a-f0-9]{64}$/.test(proof)||key.length<32)throw new Error('Invalid hardware identity input');
  const hmac=(domain:string,value:string)=>createHmac('sha256',key).update(domain).update('\0').update(Buffer.from(value,'hex')).digest('hex');
  return hmac('PS5Library hardware lookup v1',proof);
}
export function hardwareRecoveryToken(lookupHash:string,nonce:string,key:string){
  if(!/^[a-f0-9]{64}$/.test(lookupHash)||!/^[a-f0-9]{64}$/.test(nonce)||key.length<32)throw new Error('Invalid hardware recovery input');
  return createHmac('sha256',key).update('PS5Library hardware recovery v1').update('\0').update(Buffer.from(lookupHash,'hex')).update(Buffer.from(nonce,'hex')).digest('hex');
}
export function sameSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex')); }
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) return false;
  const [salt, expected] = stored.split(':') as [string,string];
  return timingSafeEqual(await derive(password, salt, 64) as Buffer, Buffer.from(expected, 'hex'));
}
export function seal(plaintext: string, key: string, context?: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(hash(key), 'hex'), iv);
  if (context) cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return (context ? 'v2:' : '') + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(encrypted: string, key: string, context?: string) {
  const contextual = encrypted.startsWith('v2:');
  if (contextual !== Boolean(context)) throw new Error('Ciphertext context mismatch');
  const bytes = Buffer.from(contextual ? encrypted.slice(3) : encrypted, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hash(key), 'hex'), bytes.subarray(0, 12));
  if (context) decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
