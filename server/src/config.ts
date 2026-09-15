import path from 'node:path';
import { z } from 'zod';
export function configuration(env = process.env) {
  const values = z.object({
    DATABASE_URL: z.string().url(), REDIS_URL: z.string().url(), BOOTSTRAP_TOKEN: z.string().min(32),
    HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3150),
    PUBLIC_URL: z.string().url().default('http://127.0.0.1:3150'), DATA_DIR: z.string().default('./data'),
    SOURCE_ROOT: z.string().default('./data/sources'), PRIVATE_HTTP_ORIGINS: z.string().default(''),
    QUOTA_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(100 * 1024 ** 3),
    DISK_MARGIN_BYTES: z.coerce.number().int().nonnegative().default(1024 ** 3),
  }).parse(env);
  return { ...values, DATA_DIR: path.resolve(values.DATA_DIR), SOURCE_ROOT: path.resolve(values.SOURCE_ROOT), privateOrigins: values.PRIVATE_HTTP_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) };
}
export type Config = ReturnType<typeof configuration>;
