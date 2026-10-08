import {z} from 'zod';

const titleId=z.string().regex(/^[A-Z]{4}[0-9]{5}$/),digest=z.string().regex(/^[a-f0-9]{64}$/),version=z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/);

export const communitySaveManifestSchema=z.object({
  schemaVersion:z.literal(1),
  platform:z.enum(['PS4','PS5']),
  gameTitleId:titleId,
  saveTitleId:titleId,
  directory:z.string().min(1).max(128).regex(/^[^/\\\x00-\x1f]+$/),
  gameVersion:version,
  region:z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/).optional(),
  archiveSha256:digest,
  archiveSize:z.number().int().positive().max(8*1024**3),
  fileCount:z.number().int().positive().max(10_000),
  exportedAt:z.string().datetime({offset:true}),
  source:z.object({firmware:version,runtime:z.string().min(1).max(80),exporterVersion:version}).strict(),
  portability:z.object({format:z.literal('PORTABLE_FILES'),platformMetadataExcluded:z.literal(true),embeddedAccountIdentifiersRemoved:z.literal(false),encryptionKeysIncluded:z.literal(false)}).strict(),
  compatibility:z.object({mode:z.literal('EXACT_GAME_VERSION'),gameVersion:version}).strict(),
}).strict().superRefine((value,context)=>{if(value.compatibility.gameVersion!==value.gameVersion)context.addIssue({code:'custom',path:['compatibility','gameVersion'],message:'Compatibility must match the exported game version exactly'});});

export type CommunitySaveManifest=z.infer<typeof communitySaveManifestSchema>;
