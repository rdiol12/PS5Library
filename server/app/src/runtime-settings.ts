import { z } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { AppError } from './security/errors.js';

const settingsSchema = z
  .object({
    companionApp: z.boolean(),
    ps5Connections: z.boolean(),
    accountRegistration: z.boolean(),
    community: z.boolean(),
    newDownloads: z.boolean(),
    homeUpdateBridge: z.boolean(),
    quotaBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    diskMarginBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const storedSettings = settingsSchema.partial().strict();
export const runtimeSettingsPatch = storedSettings.refine(
  (value) => Object.keys(value).length > 0,
  'Supply at least one setting',
);
export const runtimeSettingsUpdate = z
  .object({ revision: z.number().int().positive(), settings: runtimeSettingsPatch })
  .strict();
export type RuntimeSettings = z.infer<typeof settingsSchema>;

const immediate = [
  ['companionApp', 'ENABLE_COMPANION_APP', 'Companion app', 'boolean'],
  ['ps5Connections', 'ENABLE_PS5_CONNECTIONS', 'PS5 connections', 'boolean'],
  ['accountRegistration', 'ALLOW_ACCOUNT_REGISTRATION', 'Account registration', 'boolean'],
  ['community', 'ENABLE_COMMUNITY_FEATURES', 'Community features', 'boolean'],
  ['newDownloads', 'ENABLE_NEW_DOWNLOADS', 'New downloads', 'boolean'],
  ['homeUpdateBridge', 'ENABLE_HOME_UPDATE_BRIDGE', 'Home update bridge', 'boolean'],
  ['quotaBytes', 'QUOTA_BYTES', 'Storage quota', 'bytes'],
  ['diskMarginBytes', 'DISK_MARGIN_BYTES', 'Disk safety margin', 'bytes'],
] as const;
const restart = [
  ['HOST', 'Bind address'],
  ['PORT', 'Listen port'],
  ['PUBLIC_URL', 'Public URL'],
  ['BROWSER_ORIGINS', 'Browser origins'],
  ['TRUST_PROXY_HOPS', 'Trusted proxy hops'],
  ['DATA_DIR', 'Data directory'],
  ['SOURCE_ROOT', 'Source directory'],
  ['DUMP_ROOT', 'Dump watch directory'],
  ['DUMP_AUTO_PREPARE', 'Automatic preparation mode'],
  ['PRIVATE_HTTP_ORIGINS', 'Private repository origins'],
  ['TRAILER_WORKER_IMAGE', 'Trailer worker image'],
  ['TRAILER_WORKER_MODE', 'Trailer worker mode'],
  ['PACKAGE_WORKER_SOCKET', 'Package worker socket'],
  ['PACKAGE_WORKER_URL', 'Package worker URL'],
  ['COMMUNITY_MASTER_URL', 'Community server URL'],
  ['HOME_UPDATE_AGENT_URL', 'Home update agent URL'],
  ['OPERATOR_URL', 'Operator URL'],
  ['DATABASE_URL', 'Database connection', true],
  ['REDIS_URL', 'Redis connection', true],
  ['BOOTSTRAP_TOKEN', 'Bootstrap token', true],
  ['PACKAGE_WORKER_TOKEN', 'Package worker token', true],
  ['OPERATOR_TOKEN', 'Operator token', true],
] as const;
export const runtimeSettingDefinitions = (config: Config, value: RuntimeSettings) => [
  ...immediate.map(([key, env, label, type]) => ({
    key,
    env,
    label,
    type,
    apply: 'immediate' as const,
    writable: true,
    ...(key === 'companionApp' ? { enforcement: 'client-declared' as const } : {}),
    ...(key === 'homeUpdateBridge'
      ? {
          requires: ['HOME_UPDATE_AGENT_URL'],
          available: Boolean(config.HOME_UPDATE_AGENT_URL),
          effective: value.homeUpdateBridge && Boolean(config.HOME_UPDATE_AGENT_URL),
        }
      : {}),
  })),
  ...restart.map(([key, label, secret = false]) => ({
    key,
    env: key,
    label,
    type: secret ? 'secret' : 'string',
    apply: 'restart' as const,
    writable: false,
    ...(secret ? { secret: true } : {}),
  })),
];

const defaults = (config: Config): RuntimeSettings => ({
  ...config.features,
  quotaBytes: config.QUOTA_BYTES,
  diskMarginBytes: config.DISK_MARGIN_BYTES,
});
const apply = (config: Config, value: RuntimeSettings) => {
  Object.assign(config.features, {
    companionApp: value.companionApp,
    ps5Connections: value.ps5Connections,
    accountRegistration: value.accountRegistration,
    community: value.community,
    newDownloads: value.newDownloads,
    homeUpdateBridge: value.homeUpdateBridge,
  });
  config.QUOTA_BYTES = value.quotaBytes;
  config.DISK_MARGIN_BYTES = value.diskMarginBytes;
};
type Row = { settings: unknown; revision: number; updated_at: Date | string };
const parsed = (row: Row, config: Config) => ({
  settings: settingsSchema.parse({ ...defaults(config), ...storedSettings.parse(row.settings) }),
  revision: row.revision,
  updatedAt: row.updated_at,
});

export async function runtimeSettings(db: DB, config: Config) {
  await db.query(
    'INSERT INTO runtime_settings(singleton,settings) VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING',
    [defaults(config)],
  );
  const current = parsed(
    (
      await db.query<Row>(
        'SELECT settings,revision,updated_at FROM runtime_settings WHERE singleton',
      )
    ).rows[0]!,
    config,
  );
  apply(config, current.settings);
  let snapshot = current;
  return {
    get: () => ({ ...snapshot, definitions: runtimeSettingDefinitions(config, snapshot.settings) }),
    update: async (
      expectedRevision: number,
      patch: z.infer<typeof runtimeSettingsPatch>,
      userId: string,
    ) => {
      const row = (
        await db.query<Row>(
          `UPDATE runtime_settings SET settings=settings || $1::jsonb,revision=revision+1,updated_by=$3,updated_at=now()
        WHERE singleton AND revision=$2 RETURNING settings,revision,updated_at`,
          [patch, expectedRevision, userId],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          'SETTINGS_CHANGED',
          409,
          'Settings changed in another session. Reload and try again.',
        );
      snapshot = parsed(row, config);
      apply(config, snapshot.settings);
      return { ...snapshot, definitions: runtimeSettingDefinitions(config, snapshot.settings) };
    },
  };
}
