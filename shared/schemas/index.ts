import { z } from 'zod';

export const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uuid = z.string().uuid();
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const titleId = z.string().regex(/^[A-Z]{4}[0-9]{5}$/);
export const firmware = z.string().regex(/^\d{1,2}\.\d{2}$/);
export const formats = z.enum(['elf', 'pkg', 'ffpkg', 'ffpfs', 'ffpfsc', 'exfat', 'folder', 'zip']);
export const methods = z.enum(['HOMEBREW', 'FPKG', 'SHADOWMOUNT']);
export const libraryStates = z.enum(['SERVER_ONLY', 'PREPARING', 'READY_ON_SERVER', 'QUEUED_FOR_PS5', 'TRANSFERRING', 'VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'MISSING', 'ERROR']);
export const capabilities = z.object({
  nativeNotifications: z.boolean().default(false), persistentAgent: z.boolean().default(false),
  shadowMount: z.boolean().default(false), fpkgInstall: z.boolean().default(false),
  storageEnumeration: z.boolean().default(false), rangeDownloads: z.boolean().default(false),
  inventoryScan: z.boolean().default(false), backportOverlay: z.boolean().default(false),
  shellIntegration: z.boolean().default(false), homebrew: z.boolean().default(false),
});
export const storageSchema = z.object({
  storageId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), displayName: z.string().min(1).max(80),
  path: z.string().min(1).max(1024), totalBytes: bytes, freeBytes: bytes, writable: z.boolean(),
  installMethodsSupported: z.array(methods).max(3),
}).refine(s => s.freeBytes <= s.totalBytes, 'Free space exceeds total space');
export const metadataSchema = z.object({
  title: z.string().min(1).max(200), titleId, contentId: z.string().regex(/^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/),
  description: z.string().max(12000).default(''), publisher: z.string().max(200).optional(), developer: z.string().max(200).optional(),
  releaseDate: z.string().date().optional(), genres: z.array(z.string().max(80)).max(20).default([]), platform: z.literal('PS5').default('PS5'),
  artwork: z.object({ cover: z.string().max(2048).optional(), hero: z.string().max(2048).optional(), icon: z.string().max(2048).optional(), screenshots: z.array(z.string().max(2048)).max(12).default([]) }).optional(),
}).refine(m => m.contentId.slice(7, 16) === m.titleId, 'Content ID and title ID disagree');
export const releaseSchema = z.object({
  key: z.string().min(1).max(150), game: metadataSchema, version: z.string().regex(/^\d{2}\.\d{2}(?:\.\d{3})?$/),
  kind: z.enum(['BASE', 'UPDATE', 'DLC']).default('BASE'), region: z.string().max(30).default('Unknown'),
  languages: z.array(z.string().max(20)).max(40).default([]), size: bytes, installedSize: bytes.optional(),
  minimumFirmware: firmware.nullable().default(null), sdkVersion: z.string().max(40).nullable().default(null),
  format: formats, sha256, location: z.string().min(1).max(2048),
});
export const manifestSchema = z.object({ schemaVersion: z.literal(1), releases: z.array(releaseSchema).max(10000) });
export const sourceSchema = z.object({
  name: z.string().min(1).max(120), type: z.enum(['LOCAL_FOLDER', 'STATIC_MANIFEST', 'PRIVATE_HTTP', 'GITHUB_RELEASE']),
  location: z.string().min(1).max(2048), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/).optional(),
  scanIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});
export const profileSchema = z.object({
  id: uuid.optional(), titleId, contentId: metadataSchema.shape?.contentId ?? z.string().min(1),
  gameVersion: z.string().min(1).max(30), inputHashes: z.array(sha256).min(1).max(1000),
  targetFirmware: firmware, runtime: z.string().min(1).max(80), installationMethod: methods,
  testedState: z.enum(['UNKNOWN', 'PROFILE_AVAILABLE', 'PREPARED', 'UNTESTED', 'TESTED']),
  requiredLibraries: z.array(z.object({ path: z.string().max(1024), sha256 })).max(100),
  requiredPatches: z.array(z.object({ path: z.string().max(1024), inputSha256: sha256, outputSha256: sha256 })).max(100),
  notes: z.string().max(10000).default(''),
});
export const inventoryItem = z.object({
  releaseId: uuid.optional(), titleId, contentId: z.string().min(1).max(80), version: z.string().min(1).max(30),
  title: z.string().min(1).max(200), storageId: storageSchema.shape.storageId, relativePath: z.string().min(1).max(1024),
  sha256, size: bytes, available: z.boolean(), registered: z.boolean(), backportProfileId: uuid.nullable().default(null),
});
export const heartbeatSchema = z.object({
  firmware: firmware.nullable(), runtime: z.string().max(80), clientVersion: z.string().max(40), agentVersion: z.string().max(40),
  shadowMountVersion: z.string().max(80).nullable().default(null), shadowMountFakelib: z.boolean().default(false), standaloneBackPork: z.boolean().default(false),
  capabilities, storage: z.array(storageSchema).max(30), libraryRevision: bytes,
  inventory: z.array(inventoryItem).max(10000).optional(), inventoryComplete: z.boolean().default(false),
  activeTransfers: z.array(uuid).max(30).default([]),
});
export const progressSchema = z.object({
  state: z.enum(['TRANSFERRING', 'VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'ERROR']),
  downloadedBytes: bytes, speedBytesPerSecond: bytes.default(0), sha256: sha256.optional(), error: z.string().max(1000).optional(),
});

export type Release = z.infer<typeof releaseSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type CompatibilityProfile = z.infer<typeof profileSchema>;
