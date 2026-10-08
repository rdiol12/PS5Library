import { z } from 'zod';

export const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uuid = z.string().uuid();
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const titleId = z.string().regex(/^[A-Z]{4}[0-9]{5}$/);
export const firmware = z.string().regex(/^\d{1,2}\.\d{2}$/);
export const localUserId = z.string().regex(/^[a-f0-9]{8}$/);
export const savePlatform = z.enum(['PS4','PS5']);
export const saveDirectory = z.string().min(1).max(128).regex(/^[^/\\\x00-\x1f]+$/);
export const uploadChunk = z.object({offset:bytes,data:z.string().min(4).max(4*Math.ceil(1024**2/3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict();
export const launchTraceByteLimit=1024**2;
const launchTraceCode=z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/),signedInteger=z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const launchHistoryName=z.string().min(6).max(255).regex(/^[^/\\\x00-\x1f]+\.json$/);
const hex64=z.string().regex(/^0x[0-9a-f]{16}$/),launchRegisters=z.object({
  pid:z.number().int().positive().max(0x7fffffff),threadId:bytes.max(0x7fffffff),
  rax:hex64,rbx:hex64,rcx:hex64,rdx:hex64,rsi:hex64,rdi:hex64,rbp:hex64,rsp:hex64,
  r8:hex64,r9:hex64,r10:hex64,r11:hex64,r12:hex64,r13:hex64,r14:hex64,r15:hex64,rip:hex64,eflags:hex64,
}).strict(),launchModuleSection=z.object({address:hex64,size:bytes.max(8*1024**3),protection:bytes.max(0xffffffff)}).strict(),launchModule=z.object({
  file:z.string().max(127),library:z.string().max(127),path:z.string().max(1023),handle:hex64,fingerprint:z.string().regex(/^[a-f0-9]{40}$/).optional(),sdkVersion:hex64,sections:z.array(launchModuleSection).max(4),
}).strict(),launchStackPointer=z.object({stackOffset:bytes.max(0x3ff8),address:hex64,module:bytes.max(256),moduleOffset:hex64}).strict(),launchExceptionSnapshot=z.discriminatedUnion('status',[
  z.object({schemaVersion:z.literal(1),status:z.literal('COMPLETE'),capturedAtUnixMs:bytes,stackBase:hex64,stackSize:z.literal(0x4000),stackSha256:sha256,modules:z.array(launchModule).max(257),stackCodePointers:z.array(launchStackPointer).max(2048),registers:launchRegisters}).strict(),
  z.object({schemaVersion:z.literal(1),status:z.literal('FAILED'),capturedAtUnixMs:bytes,error:z.literal('EXCEPTION_SNAPSHOT_FAILED'),registers:launchRegisters}).strict(),
]);
export const launchTraceSchema=z.object({
  schemaVersion:z.literal(1),titleId,source:z.enum(['AGENT','MANUAL']),state:launchTraceCode,
  traceStartedAtUnixMs:bytes,traceCompletedAtUnixMs:bytes,
  processObserved:z.boolean(),pid:z.number().int().positive().max(0x7fffffff).optional(),processObservedAtUnixMs:bytes.optional(),processExitAtUnixMs:bytes.optional(),
  mdbgPolled:z.boolean(),mdbgAvailable:z.boolean(),mdbgExceptionStop:z.boolean(),mdbgCallResult:signedInteger.optional(),mdbgStatus:signedInteger.optional(),mdbgFlags:bytes.optional(),mdbgObservedAtUnixMs:bytes.optional(),mdbgExceptionFlags:bytes.optional(),mdbgExceptionObservedAtUnixMs:bytes.optional(),
  klogAvailable:z.boolean(),klogLookbackBytes:bytes.max(1024**2),klogError:z.string().max(1024).optional(),klog:z.string().max(256*1024),klogTruncated:z.boolean(),
  errorHistoryAccessible:z.boolean(),errorHistory:z.array(z.union([
    z.object({name:launchHistoryName,content:z.unknown().refine(value=>value!==undefined)}).strict(),
    z.object({name:launchHistoryName,readError:z.literal(true)}).strict(),
  ])).max(32),errorHistoryTruncated:z.boolean(),
  launchRequestedAtUnixMs:bytes.optional(),bigAppObservedAtUnixMs:bytes.optional(),stateChangedAtUnixMs:bytes.optional(),launchCompletedAtUnixMs:bytes.optional(),
  launchResult:z.object({initialize:signedInteger,user:signedInteger,launch:signedInteger}).strict().optional(),
  exceptionSnapshot:launchExceptionSnapshot.optional(),
}).strict().refine(trace=>trace.traceCompletedAtUnixMs>=trace.traceStartedAtUnixMs,'Trace completion precedes its start')
  .refine(trace=>trace.processObserved===(trace.pid!==undefined),'Observed process and PID disagree');
export const formats = z.enum(['elf', 'pkg', 'ffpkg', 'ffpfs', 'ffpfsc', 'exfat', 'folder', 'zip', 'rar', '7z']);
export const buildFormats: readonly string[] = ['folder','zip','rar','7z'];
export const methods = z.enum(['HOMEBREW', 'FPKG', 'SHADOWMOUNT']);
export const libraryStates = z.enum(['SERVER_ONLY', 'PREPARING', 'READY_ON_SERVER', 'QUEUED_FOR_PS5', 'TRANSFERRING', 'VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'MISSING', 'ERROR']);
export const capabilities = z.object({
  nativeNotifications: z.boolean().default(false), nativeDownloads:z.boolean().default(false), nativeDownloadProgress:z.boolean().default(false), nativeUpdateBridge:z.boolean().default(false), persistentAgent: z.boolean().default(false),
  shadowMount: z.boolean().default(false), fpkgInstall: z.boolean().default(false),
  storageEnumeration: z.boolean().default(false), rangeDownloads: z.boolean().default(false),
  inventoryScan: z.boolean().default(false), backportOverlay: z.boolean().default(false), integratedBackportProfiles:z.boolean().default(false),
  shellIntegration: z.boolean().default(false), homebrew: z.boolean().default(false),
  gameDeletion: z.boolean().default(false), gameMove:z.boolean().default(false), remotePlayPairing: z.boolean().default(false), saveBackup: z.boolean().default(false), saveExport:z.boolean().default(false),saveImport:z.boolean().default(false),saveRollback:z.boolean().default(false),
});
export const storageSchema = z.object({
  storageId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), displayName: z.string().min(1).max(80),
  path: z.string().min(1).max(1024), totalBytes: bytes, freeBytes: bytes, writable: z.boolean(),
  installMethodsSupported: z.array(methods).max(3), nativeMoveStorageType:z.number().int().min(0).max(2).nullable().default(null),
}).refine(s => s.freeBytes <= s.totalBytes, 'Free space exceeds total space');
export const metadataSchema = z.object({
  title: z.string().min(1).max(200), titleId, contentId: z.string().regex(/^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/),
  description: z.string().max(12000).default(''), publisher: z.string().max(200).optional(), developer: z.string().max(200).optional(),
  releaseDate: z.string().date().optional(), genres: z.array(z.string().max(80)).max(20).default([]), platform: z.enum(['PS5','PS4']).default('PS5'),
  artwork: z.object({ cover: z.string().max(2048).optional(), hero: z.string().max(2048).optional(), icon: z.string().max(2048).optional(), screenshots: z.array(z.string().max(2048)).max(12).default([]) }).optional(),
}).refine(m => m.contentId.slice(7, 16) === m.titleId, 'Content ID and title ID disagree');
export const releaseSchema = z.object({
  key: z.string().min(1).max(150), game: metadataSchema, version: z.string().regex(/^\d{2}\.\d{2,3}(?:\.\d{3})?$/),
  baseContentVersion: z.string().regex(/^\d{2}\.\d{3}\.\d{3}$/).optional(),
  kind: z.enum(['BASE', 'UPDATE', 'DLC']).default('BASE'), region: z.string().max(30).default('Unknown'),
  title: z.string().min(1).max(200).optional(),
  languages: z.array(z.string().max(20)).max(40).default([]), size: bytes, installedSize: bytes.optional(),
  minimumFirmware: firmware.nullable().default(null), sdkVersion: z.string().max(40).nullable().default(null),
  format: formats, sha256, sourceTreeSha256:sha256.optional(),sourceTreeSize:bytes.optional(),location: z.string().min(1).max(2048),
}).superRefine((release,context)=>{
  if(release.kind==='UPDATE'&&!release.baseContentVersion)context.addIssue({code:'custom',path:['baseContentVersion'],message:'UPDATE requires its exact base content version'});
  if(release.baseContentVersion&&release.version<=release.baseContentVersion)context.addIssue({code:'custom',path:['baseContentVersion'],message:'UPDATE version must be newer than its base'});
});
export const manifestSchema = z.object({ schemaVersion: z.literal(1), releases: z.array(releaseSchema).max(10000) });
export const sourceSchema = z.object({
  name: z.string().min(1).max(120), type: z.enum(['LOCAL_FOLDER', 'STATIC_MANIFEST', 'PRIVATE_HTTP', 'GITHUB_RELEASE','WATCH_FOLDER']),
  location: z.string().min(1).max(2048), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/).optional(),
  scanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  autoPrepare: z.enum(['FPKG','SHADOWMOUNT','BOTH']).optional(),
  shareCatalog: z.boolean().default(false),
});
export const profileSchema = z.object({
  id: uuid.optional(), titleId, contentId: metadataSchema.shape?.contentId ?? z.string().min(1),
  gameVersion: z.string().min(1).max(30), inputHashes: z.array(sha256).min(1).max(1000),
  targetFirmware: firmware, runtime: z.string().min(1).max(80), installationMethod: methods,
  delivery: z.enum(['OVERLAY','INTEGRATED']).default('OVERLAY'),
  testedState: z.enum(['UNKNOWN', 'PROFILE_AVAILABLE', 'PREPARED', 'UNTESTED', 'TESTED']),
  requiredLibraries: z.array(z.object({ path: z.string().min(1).max(1024).regex(/^fakelib2?\/[A-Za-z0-9._/-]+$/).refine(p=>p.split('/').every(s=>s!=='.'&&s!=='..'&&s.length>0)), sha256 })).max(100),
  requiredFiles:z.array(z.object({path:z.string().min(1).max(1024).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(s=>s.length>0&&s.length<=180&&s!=='.'&&s!=='..'&&!/[<>:"|?*\x00-\x1f]/.test(s)&&!/[. ]$/.test(s)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))),sha256})).max(10000).default([]),
  requiredPatches: z.array(z.object({
    path: z.string().min(1).max(1024).regex(/^[A-Za-z0-9._/-]+$/).refine(p=>p.split('/').every(s=>s!=='.'&&s!=='..'&&s.length>0)&&!/^dlcs?\//i.test(p)), inputSha256: sha256, outputSha256: sha256,
    bps:z.object({data:z.string().min(28).max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),sha256}).strict().optional(),
    sdk:z.object({ps5:z.number().int().positive().max(0xffffffff),ps4:z.number().int().positive().max(0xffffffff)}).strict().optional(),
    outputFormat:z.enum(['ELF','FSELF']).optional(),
  }).strict().refine(p=>!p.sdk||!!p.outputFormat,'SDK edits require an explicit ELF or FSELF output')).max(100),
  notes: z.string().max(10000).default(''),
}).refine(p=>new Set(p.requiredPatches.map(f=>f.path.toLowerCase())).size===p.requiredPatches.length,'Duplicate patch targets')
  .refine(p=>new Set(p.requiredFiles.map(f=>f.path.toLowerCase())).size===p.requiredFiles.length,'Duplicate supplied backport files')
  .refine(p=>p.requiredFiles.every(f=>![...p.requiredLibraries,...p.requiredPatches].some(other=>other.path.toLowerCase()===f.path.toLowerCase())),'Supplied backport file conflicts with a generated overlay target')
  .refine(p=>p.delivery==='OVERLAY'||p.requiredLibraries.length+p.requiredPatches.length+p.requiredFiles.length===0,'Integrated backports cannot declare external files')
  .refine(p=>new TextEncoder().encode(JSON.stringify(p)).length<=900000,'Profile exceeds the bounded worker manifest');
export const inventoryItem = z.object({
  releaseId: uuid.optional(), titleId, contentId: z.string().min(1).max(80), version: z.string().min(1).max(30),
  title: z.string().min(1).max(200), storageId: storageSchema.shape.storageId, relativePath: z.string().min(1).max(1024),
  sha256: sha256.nullable(), size: bytes.nullable(), available: z.boolean(), registered: z.boolean(), backportProfileId: uuid.nullable().default(null),
  source: z.enum(['MANAGED','EXISTING_DUMP','INSTALLED_TITLE']).default('MANAGED'), platform:z.enum(['PS5','PS4']).default('PS5'), backportFiles: z.boolean().default(false),
}).refine(i=>i.contentId.slice(7,16)===i.titleId,'Content ID and title ID disagree')
  .refine(i=>i.source==='MANAGED'?(i.sha256!==null&&i.size!==null):i.sha256===null&&i.backportProfileId===null&&(i.source==='EXISTING_DUMP'?i.size===null:i.size!==null&&i.size>0),'Discovered content does not claim whole-content verification; installed packages require a measured size')
  .refine(i=>i.source!=='INSTALLED_TITLE'||(i.platform==='PS4'?/^CUSA[0-9]{5}$/:/^PPSA[0-9]{5}$/).test(i.titleId),'Installed-title platform and title ID disagree');
export const heartbeatSchema = z.object({
  trophySummary: z.object({source:z.literal('LOCAL_SUMMARY'),localUserId,sourceSha256:sha256,modifiedAt:bytes,earnedTrophies:z.object({platinum:z.number().int().min(0).max(1000000),gold:z.number().int().min(0).max(1000000),silver:z.number().int().min(0).max(1000000),bronze:z.number().int().min(0).max(1000000)})}).nullable().optional(),
  saveData: z.object({source:z.literal('LOCAL_SAVE_DATABASES'),localUserId,complete:z.boolean(),items:z.array(z.object({platform:savePlatform,gameTitleId:titleId,saveTitleId:titleId,directory:saveDirectory,title:z.string().max(200),subtitle:z.string().max(200),detail:z.string().max(1000),sizeBytes:bytes,modifiedAt:bytes}).strict()).max(4096)}).strict().refine(s=>new Set(s.items.map(i=>`${i.platform}\0${i.saveTitleId}\0${i.directory}`)).size===s.items.length,'Duplicate save slot').nullable().optional(),
  firmware: firmware.nullable().optional(), runtime: z.string().max(80), clientVersion: z.string().max(40), agentVersion: z.string().max(40),
  shadowMountVersion: z.string().max(80).nullable().default(null), shadowMountFakelib: z.boolean().default(false), standaloneBackPork: z.boolean().default(false),
  runtimeStatus: z.object({shadowMount:z.enum(['RUNNING','NOT_RUNNING','UNKNOWN']).default('UNKNOWN'),kstuff:z.enum(['RUNNING','NOT_RUNNING','UNKNOWN']).default('UNKNOWN'),backPork:z.enum(['RUNNING','NOT_RUNNING','UNKNOWN']).default('UNKNOWN'),fakelibEnabled:z.boolean().nullable().default(null),backportConflict:z.boolean().default(false),externalFpkgPatch:z.boolean().default(false)}).default({shadowMount:'UNKNOWN',kstuff:'UNKNOWN',backPork:'UNKNOWN',fakelibEnabled:null,backportConflict:false,externalFpkgPatch:false}),
  capabilities, storage: z.array(storageSchema).max(30), libraryRevision: bytes,
  inventory: z.array(inventoryItem).max(10000).optional(), inventoryComplete: z.boolean().default(false),
  activeTransfers: z.array(uuid).max(30).default([]),
});
export const progressSchema = z.object({
  state: z.enum(['TRANSFERRING', 'VERIFYING', 'REGISTERING', 'READY_ON_PS5', 'ERROR']),
  downloadedBytes: bytes, speedBytesPerSecond: bytes.default(0), sha256: sha256.optional(), error: z.string().max(1000).optional(),
  backportProfileHash:sha256.optional(),
  backportDownloadedBytes:bytes.optional(),
});

export type Release = z.infer<typeof releaseSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type CompatibilityProfile = z.infer<typeof profileSchema>;
