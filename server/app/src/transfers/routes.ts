import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { serveFile,serveStoredFile } from '../downloads/serve.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { bytes, sha256, uuid, progressSchema } from '../../../shared/schemas/index.js';
import { compatibility, planStorage, presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { jobEvent, jobJSON } from '../jobs/events.js';
import { buildKey,legacyFpkgBuilderVersion,transferArtifactUsable } from '../jobs/preparation.js';
import {backportFiles,backportNotice,backportMessages} from '../library/backports.js';
import {existingWithin} from '../security/paths.js';
import {nativeDownloadRoutes} from './native.js';
import {inspect} from '../library/inspect.js';

const installedImageSchema=z.object({size:bytes.refine(value=>value>0),sha256}).strict();
const installedImage=(inspection:unknown,sourceSize:number)=>{const parsed=installedImageSchema.safeParse((inspection as any)?.installedImage);return parsed.success&&parsed.data.size<=sourceSize?parsed.data:null;};
const contentVersion=z.string().regex(/^\d{2}\.\d{3}\.\d{3}$/);

export async function transferRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth, inspectFile=inspect) {
  const native=await nativeDownloadRoutes(app,db,config,auth);
  const artifactInspections=new Map<string,Promise<Awaited<ReturnType<typeof inspect>>>>();
  async function plan(userId: string, releaseId: string, consoleId: string, artifactId?: string, preparation?: {format:string;size:number;sha256:string;baseSha256?:string;sourceTreeSha256?:string;cacheKey?:string}) {
    const c = (await db.query("SELECT c.*,COALESCE(k.capabilities,'{}') AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2", [consoleId, userId])).rows[0];
    const r = (await db.query('SELECT r.*,g.title_id,g.user_id AS source_owner FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.id=$1 AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=g.id AND access.user_id=$2)', [releaseId, userId])).rows[0];
    if (!c || !r) throw new AppError('NOT_FOUND', 404);
    const requestedInputHash=artifactId?null:preparation?.sha256??r.metadata.sha256??null;
    let a = (await db.query('SELECT * FROM artifacts WHERE release_id=$1 AND verified AND deleted_at IS NULL AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR format=$3) AND ($4::text IS NULL OR cache_key=$4) AND ($5::text IS NULL OR sha256=$5) AND ($6::text IS NULL OR COALESCE(input_hash,sha256)=$6) ORDER BY created_at DESC LIMIT 1', [releaseId, artifactId ?? null, preparation?.format??null, preparation?.cacheKey??null, preparation&&!preparation.cacheKey?preparation.sha256:null,requestedInputHash])).rows[0];
    if(!a&&!artifactId&&preparation?.format==='pkg')a=(await db.query('SELECT * FROM artifacts WHERE release_id=$1 AND format=\'pkg\' AND input_hash=$2 AND right(builder_version,length($3))=$3 AND profile_id IS NULL AND verified AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',[releaseId,preparation.sha256,legacyFpkgBuilderVersion])).rows[0];
    if(a&&!transferArtifactUsable(a))a=undefined;
    const profiles = (await db.query('SELECT profile FROM compatibility_profiles WHERE user_id=ANY($1::uuid[]) AND title_id=$2 ORDER BY created_at DESC', [[userId,r.source_owner], r.title_id])).rows.map(p => p.profile);
    const applicableProfiles=a?.profile_id?profiles.filter(p=>p.id===a.profile_id):profiles;
    // A builder may normalize metadata. Never lower the original dump's firmware requirement.
    const builtFirmware=a?.inspection?.identity?.minimumFirmware;
    const minimumFirmware=r.metadata.minimumFirmware&&builtFirmware&&Number(builtFirmware)>Number(r.metadata.minimumFirmware)?builtFirmware:r.metadata.minimumFirmware??null;
    const inputHash=preparation?.sha256 ?? a?.input_hash ?? a?.sha256 ?? r.metadata.sha256,baseInputHash=preparation?.baseSha256??r.metadata.sha256,exactInputHash=preparation?.sourceTreeSha256??r.metadata.sourceTreeSha256??baseInputHash;
    const checkedRelease={ titleId: r.title_id, contentId: r.content_id, version: r.version, sha256:baseInputHash, sourceTreeSha256:exactInputHash, minimumFirmware, format: a?.format ?? preparation?.format ?? r.metadata.format };
    const checkedConsole={ firmware: c.firmware, runtime: c.runtime, capabilities: c.capabilities, shadowMountFakelib: c.shadowmount_fakelib, standaloneBackPork: c.standalone_backpork };
    const result = compatibility(checkedRelease,checkedConsole,applicableProfiles);
    const baseVersion=r.kind==='UPDATE'?contentVersion.safeParse(r.metadata?.baseContentVersion):null;
    const baseContentVersion=baseVersion?.success?baseVersion.data:null;
    const installedBase=baseContentVersion&&r.version>baseContentVersion?(await db.query("SELECT e.storage_id FROM console_library_entries e JOIN game_releases installed ON installed.id=e.release_id JOIN games game ON game.id=installed.game_id WHERE e.console_id=$1 AND e.state='READY_ON_PS5' AND e.registered AND game.title_id=$2 AND installed.content_id=$3 AND installed.version=$4 ORDER BY e.updated_at DESC LIMIT 1",[consoleId,r.title_id,r.content_id,baseContentVersion])).rows[0]:null;
    if(result.method==='FPKG'&&(!['BASE','UPDATE'].includes(r.kind)||!r.title_id.startsWith('PPSA')))result.status='UNSUPPORTED_METHOD';
    if(r.kind==='UPDATE'&&!baseVersion?.success)result.status='UPDATE_BASE_VERSION_MISSING';
    else if(r.kind==='UPDATE'&&(!installedBase||r.version<=baseContentVersion!))result.status='UPDATE_BASE_NOT_INSTALLED';
    if(c.firmware_request_id)result.status='FIRMWARE_REFRESH_PENDING';
    let backport:Awaited<ReturnType<typeof backportFiles>>|null=null;
    if(result.profileId&&['MATCHING_BACKPORT_AVAILABLE','BACKPORT_UNTESTED'].includes(result.status)){
      const candidates=applicableProfiles.map(p=>({profile:p,match:compatibility(checkedRelease,checkedConsole,[p])})).filter(p=>['MATCHING_BACKPORT_AVAILABLE','BACKPORT_UNTESTED'].includes(p.match.status)).sort((a,b)=>Number(b.profile.testedState==='TESTED')-Number(a.profile.testedState==='TESTED'));
      const failures:string[]=[];
      for(const candidate of candidates)try{
        backport=await backportFiles(db,config,releaseId,exactInputHash,candidate.profile);
        Object.assign(result,candidate.match);
        if(backport.needsPreparation)a=undefined;
        break;
      }catch(error){if(error instanceof z.ZodError)failures.push('PROFILE_MISMATCH');else if(error instanceof AppError)failures.push(error.code);else throw error;}
      if(!backport)result.status=failures.includes('BACKPORT_FILES_MISMATCH')?'BACKPORT_FILES_MISMATCH':failures[0]??'BACKPORT_NO_MATCH';
    }
    if(!result.backportRequired&&a?.profile_id){
      const format=a.format;
      a=(await db.query('SELECT * FROM artifacts WHERE release_id=$1 AND COALESCE(input_hash,sha256)=$2 AND format=$3 AND profile_id IS NULL AND verified AND deleted_at IS NULL AND ($4::uuid IS NULL OR id=$4) ORDER BY created_at DESC LIMIT 1',[releaseId,inputHash,format,artifactId??null])).rows[0];
      if(a?.builder_version&&['pkg','ffpkg'].includes(a.format)&&a.cache_key!==buildKey(inputHash,a.format==='pkg'?'FPKG':'SHADOWMOUNT',null))a=undefined;
    }
    const compatible=result.status==='NATIVE_COMPATIBLE'||result.status==='MATCHING_BACKPORT_AVAILABLE'||result.status==='BACKPORT_UNTESTED';
    const context=`${c.firmware}:${c.runtime}:${exactInputHash}`;
    await backportNotice(db,userId,consoleId,releaseId,result.status,context);
    if(compatible)await db.query('UPDATE console_notices SET resolved_at=now() WHERE console_id=$1 AND release_id=$2 AND code=ANY($3::text[]) AND code<>$4 AND resolved_at IS NULL',[consoleId,releaseId,Object.keys(backportMessages),result.status]);
    const online = presence(c.last_seen ? new Date(c.last_seen).getTime() : null) === 'ONLINE';
    const overlayBytes=backport?.placement==='SCAN_PATH'?backport.size:0;
    const packageBytes=a?.size??preparation?.size??r.metadata.size??0;
    const components={game:r.kind==='UPDATE'?0:packageBytes,update:r.kind==='UPDATE'?packageBytes:0,backport:overlayBytes,temporary:packageBytes+overlayBytes,margin:config.DISK_MARGIN_BYTES};
    const volumes=(await db.query("SELECT * FROM console_storage_volumes WHERE console_id=$1 AND (writable OR jsonb_array_length(methods)>0) ORDER BY display_name,storage_id", [consoleId])).rows;
    const internal=volumes.filter(s=>s.path==='/data'||s.path==='/user');
    const internalDestination=internal.find(s=>s.methods.includes(result.method??''));
    const storage = volumes.filter(s=>!internalDestination||!internal.includes(s)||s===internalDestination).map(s => {
      const destination=planStorage({freeBytes:s.free_bytes,writable:s.writable,installMethodsSupported:s.methods},result.method??'',components),needsStage=result.method==='FPKG'&&s.path==='/mnt/ext0';
      const stage=needsStage?volumes.find(candidate=>candidate.path==='/user'&&candidate.methods.includes('FPKG')):null;
      const staging=stage?planStorage({freeBytes:stage.free_bytes,writable:stage.writable,installMethodsSupported:stage.methods},'FPKG',components):null;
      const updateStorageAllowed=r.kind!=='UPDATE'||s.storage_id===installedBase?.storage_id;
      return {storageId:s.storage_id,displayName:s===internalDestination?'Internal Storage':s.display_name,...destination,
        allowed:updateStorageAllowed&&destination.allowed&&(!needsStage||staging?.allowed===true),reason:!updateStorageAllowed?'UPDATE_STORAGE_MISMATCH':destination.reason??(needsStage&&!stage?'INTERNAL_STAGING_UNAVAILABLE':staging?.reason?`INTERNAL_STAGING_${staging.reason}`:null),
        stagingStorageId:stage?.storage_id??null,stagingRequiredBytes:staging?.requiredBytes??0,stagingFreeBytes:stage?.free_bytes??0};
    });
    return { compatibility: result, online, artifactId: a?.id ?? null, baseContentVersion,backportRequired:result.backportRequired,backportArtifactId:backport?.backportId??null,backport,components,storage,firmware:c.firmware,runtime:c.runtime,
      compatible,allowed: !!a && online && compatible,
      message:backportMessages[result.status]??null,
      reason: !compatible ? result.status : !a ? 'PREPARE_ON_SERVER_FIRST' : !online ? 'CONSOLE_OFFLINE' : result.status };
  }
  app.post('/api/v1/transfers/plan', async req => {
    const u = await auth.user(req), b = z.object({ releaseId: uuid, consoleId: uuid }).parse(req.body);
    return plan(u.id, b.releaseId, b.consoleId);
  });
  app.post('/api/v1/device/transfers/plan', async req => {
    const c = await auth.device(req), b = z.object({ releaseId: uuid, consoleId: uuid.optional() }).parse(req.body);
    return plan(c.user_id, b.releaseId, b.consoleId ?? c.id);
  });
  const enqueue = async (userId: string, body: { artifactId: string; consoleId: string; storageId: string; installationId?:string }) => {
    if(body.installationId){const old=(await db.query("SELECT id FROM jobs WHERE user_id=$1 AND config->>'installationId'=$2 AND kind='TRANSFER'",[userId,body.installationId])).rows[0];if(old)return {id:old.id as string};}
    const artifact = (await db.query('SELECT a.*,g.title_id,r.content_id,r.version,r.kind,r.metadata FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE a.id=$1 AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=g.id AND access.user_id=$2) AND a.verified', [body.artifactId, userId])).rows[0];
    if (!artifact) throw new AppError('NOT_FOUND', 404);
    const selected = await plan(userId, artifact.release_id, body.consoleId, artifact.id);
    if (!selected.allowed) throw new AppError(selected.reason, 409);
    if(selected.compatibility.method==='FPKG'&&!installedImage(artifact.inspection,artifact.size)){
      let pending=artifactInspections.get(artifact.id);
      if(!pending){
        pending=(async()=>{
          const file=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,artifact.relative_path)),before=await stat(file);
          if(!before.isFile()||before.size!==Number(artifact.size))throw new AppError('ARTIFACT_MISSING_OR_CHANGED',409);
          const inspection=await inspectFile(file,'pkg',{titleId:artifact.title_id,contentId:artifact.content_id,version:artifact.version}),after=await stat(file);
          if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||!installedImage(inspection,artifact.size))throw new AppError('ARTIFACT_INSPECTION_REQUIRED',409);
          await db.query("UPDATE artifacts SET inspection=$2 WHERE id=$1 AND verified AND sha256=$3 AND size=$4 AND NOT inspection?'installedImage'",[artifact.id,inspection,artifact.sha256,artifact.size]);
          return inspection;
        })().finally(()=>artifactInspections.delete(artifact.id));
        artifactInspections.set(artifact.id,pending);
      }
      artifact.inspection=await pending;
    }
    const destination = selected.storage.find(s => s.storageId === body.storageId);
    if (!destination?.allowed) throw new AppError('INSUFFICIENT_OR_UNSUPPORTED_STORAGE', 409);
    const id = randomUUID();
    await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      if (!(await sql.query('SELECT id FROM artifacts WHERE id=$1 AND verified', [artifact.id])).rowCount) throw new AppError('ARTIFACT_MISSING_OR_CHANGED', 409);
      await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE', [body.consoleId, userId]);
      if(artifact.kind==='UPDATE'&&!(await sql.query("SELECT 1 FROM console_library_entries e JOIN game_releases installed ON installed.id=e.release_id JOIN games game ON game.id=installed.game_id WHERE e.console_id=$1 AND e.storage_id=$2 AND e.state='READY_ON_PS5' AND e.registered AND game.title_id=$3 AND installed.content_id=$4 AND installed.version=$5",[body.consoleId,body.storageId,artifact.title_id,artifact.content_id,selected.baseContentVersion])).rowCount)throw new AppError('UPDATE_BASE_CHANGED',409);
      if((await sql.query("SELECT id FROM jobs WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND kind='TRANSFER' AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[body.consoleId,artifact.release_id,body.storageId])).rowCount)throw new AppError('TRANSFER_ALREADY_QUEUED',409,'Wait for this title transfer to finish or cancel it before starting another installation method.');
      if((await sql.query("SELECT j.id FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.console_id=$1 AND j.kind='DELETE' AND j.state NOT IN ('COMPLETED','ERROR','CANCELLED') AND g.title_id=(SELECT g2.title_id FROM game_releases r2 JOIN games g2 ON g2.id=r2.game_id WHERE r2.id=$2)",[body.consoleId,artifact.release_id])).rowCount)throw new AppError('GAME_IN_USE',409,'Wait for this game removal to finish.');
      const reservedAt=async(storageId:string)=>(await sql.query("SELECT COALESCE(sum((CASE WHEN storage_id=$2 THEN COALESCE((config->>'reservedBytes')::bigint,0) ELSE 0 END)+(CASE WHEN config->>'stagingStorageId'=$2 THEN COALESCE((config->>'stagingReservedBytes')::bigint,0) ELSE 0 END)),0)::bigint AS bytes FROM jobs WHERE kind='TRANSFER' AND console_id=$1 AND (storage_id=$2 OR config->>'stagingStorageId'=$2) AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[body.consoleId,storageId])).rows[0].bytes as number;
      const reserved=await reservedAt(body.storageId);
      if (destination.freeBytes < reserved + destination.requiredBytes) throw new AppError('INSUFFICIENT_SPACE', 409);
      if(destination.stagingStorageId&&destination.stagingFreeBytes<await reservedAt(destination.stagingStorageId)+destination.stagingRequiredBytes)throw new AppError('INSUFFICIENT_INTERNAL_SPACE',409);
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,config) VALUES($1,$2,'TRANSFER',$3,$4,$5,$6,'QUEUED_FOR_PS5',$7,$8)", [id, userId, artifact.release_id, artifact.id, body.consoleId, body.storageId, artifact.size, { method: selected.compatibility.method, reservedBytes: destination.requiredBytes, stagingStorageId:destination.stagingStorageId??undefined,stagingReservedBytes:destination.stagingRequiredBytes||undefined,installationId:body.installationId,backport:selected.backport,baseContentVersion:selected.baseContentVersion??undefined,firmware:selected.firmware,runtime:selected.runtime }]);
      await sql.query("INSERT INTO console_library_entries(console_id,release_id,storage_id,state) VALUES($1,$2,$3,'QUEUED_FOR_PS5') ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET state='QUEUED_FOR_PS5',updated_at=now()", [body.consoleId, artifact.release_id, body.storageId]);
      await jobEvent(sql, id);
    });
    return { id };
  };
  app.post('/api/v1/transfers', async (req, reply) => {
    const user = await auth.user(req), body = z.object({ artifactId: uuid, consoleId: uuid, storageId: z.string().max(64) }).parse(req.body);
    return reply.code(202).send(await enqueue(user.id, body));
  });
  app.post('/api/v1/device/transfers', async (req, reply) => {
    const c = await auth.device(req), body = z.object({ artifactId: uuid, storageId: z.string().max(64), consoleId: uuid.optional() }).parse(req.body);
    return reply.code(202).send(await enqueue(c.user_id, { ...body, consoleId: body.consoleId ?? c.id }));
  });
  app.get('/api/v1/device/tasks', async req => {
    const c = await auth.device(req);
    const jobs=(await db.query("SELECT j.*,a.sha256,a.format,a.inspection,g.title,g.title_id,r.content_id,r.version,r.kind AS release_kind FROM jobs j JOIN artifacts a ON a.id=j.artifact_id JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.console_id=$1 AND j.kind='TRANSFER' AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') ORDER BY j.created_at", [c.id])).rows;
    const tasks=[];
    for(const j of jobs){
      if(j.config.firmware!==undefined&&(j.config.firmware!==c.firmware||j.config.runtime!==c.runtime)){
        await db.query("UPDATE jobs SET state='ERROR',error='CONSOLE_CONFIGURATION_CHANGED',updated_at=now() WHERE id=$1",[j.id]);await db.query("UPDATE console_library_entries SET state='ERROR',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3",[c.id,j.release_id,j.storage_id]);await jobEvent(db,j.id);continue;
      }
      const image=j.config.method==='FPKG'?installedImage(j.inspection,j.total_bytes):null;
      if(j.config.method==='FPKG'&&!image){await db.query("UPDATE jobs SET state='ERROR',error='ARTIFACT_INSPECTION_REQUIRED',updated_at=now() WHERE id=$1",[j.id]);await db.query("UPDATE console_library_entries SET state='ERROR',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3",[c.id,j.release_id,j.storage_id]);await jobEvent(db,j.id);continue;}
      const profile=j.config.backport;
      tasks.push({ ...jobJSON(j), sha256: j.sha256, format: j.format, method: j.config.method, title: j.title, titleId: j.title_id, contentId: j.content_id, version: j.version,releaseKind:j.release_kind,baseContentVersion:j.config.baseContentVersion??null,backport:profile?.placement==='SCAN_PATH'?profile:null,backportProfileId:profile?.profile?.id??null,backportProfileHash:profile?.profileHash??null,installedImage:image, artifactUrl: `/api/v1/device/artifacts/${j.artifact_id}` });
    }return tasks;
  });
  app.get('/api/v1/device/tasks/:id/backport/:index',async(req,reply)=>{
    const c=await auth.device(req),params=z.object({id:uuid,index:z.coerce.number().int().min(0).max(200)}).parse(req.params);
    const job=(await db.query("SELECT j.config FROM jobs j JOIN game_releases r ON r.id=j.release_id WHERE j.id=$1 AND j.console_id=$2 AND j.kind='TRANSFER' AND j.desired_state='RUNNING' AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=$3)",[params.id,c.id,c.user_id])).rows[0];
    const plan=job?.config.backport,file=plan?.files[params.index];if(!file||plan.placement!=='SCAN_PATH')throw new AppError('NOT_FOUND',404);
    const b=(await db.query('SELECT relative_path FROM backport_artifacts WHERE id=$1 AND deleted_at IS NULL',[plan.backportId])).rows[0];if(!b)throw new AppError('BACKPORT_FILES_MISSING',409);
    const root=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,b.relative_path)),location=await existingWithin(root,path.join(root,file.path));
    if((await stat(location)).size!==file.size)throw new AppError('BACKPORT_FILES_MISMATCH',409);
    return serveFile(req,reply,location,file.size,file.sha256);
  });
  app.post('/api/v1/device/tasks/:id/progress', async req => {
    const c = await auth.device(req), id = uuid.parse((req.params as { id: string }).id), body = progressSchema.parse(req.body);
    return transaction(db, async sql => {
      const job = (await sql.query('SELECT j.*,a.sha256,a.inspection FROM jobs j JOIN artifacts a ON a.id=j.artifact_id WHERE j.id=$1 AND j.console_id=$2 FOR UPDATE OF j', [id, c.id])).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      if(job.config.firmware!==undefined&&(job.config.firmware!==c.firmware||job.config.runtime!==c.runtime))throw new AppError('CONSOLE_CONFIGURATION_CHANGED',409);
      if(body.backportDownloadedBytes!==undefined){
        if(!job.config.backport||body.backportDownloadedBytes>job.config.backport.size)throw new AppError('INVALID_JOB_TRANSITION',409);
        await sql.query("UPDATE jobs SET config=jsonb_set(config,'{progress}',$2) WHERE id=$1",[id,JSON.stringify({stage:'Preparing compatibility files',completedBytes:body.backportDownloadedBytes,totalBytes:job.config.backport.size})]);
      }else if(['VERIFYING','REGISTERING','READY_ON_PS5','ERROR'].includes(body.state))await sql.query("UPDATE jobs SET config=config-'progress' WHERE id=$1",[id]);
      const transitions: Record<string, string[]> = { QUEUED_FOR_PS5: ['TRANSFERRING','ERROR'], TRANSFERRING: ['TRANSFERRING','VERIFYING','ERROR'], VERIFYING: ['TRANSFERRING','VERIFYING','REGISTERING','READY_ON_PS5','ERROR'], REGISTERING: ['REGISTERING','READY_ON_PS5','ERROR'], READY_ON_PS5: ['READY_ON_PS5'] };
      if (!transitions[job.state]?.includes(body.state) || body.downloadedBytes > job.total_bytes || job.desired_state !== 'RUNNING') throw new AppError('INVALID_JOB_TRANSITION', 409);
      if (['VERIFYING','REGISTERING','READY_ON_PS5'].includes(body.state) && (body.downloadedBytes !== job.total_bytes || body.sha256 !== job.sha256)) throw new AppError('VERIFICATION_REQUIRED', 409);
      if(['REGISTERING','READY_ON_PS5'].includes(body.state)&&job.config.backport&&body.backportProfileHash!==job.config.backport.profileHash)throw new AppError('BACKPORT_VERIFICATION_REQUIRED',409);
      if (body.state === 'READY_ON_PS5') {
        const image=job.config.method==='FPKG'?installedImage(job.inspection,job.total_bytes):{size:job.total_bytes,sha256:job.sha256};
        if(!image)throw new AppError('ARTIFACT_INSPECTION_REQUIRED',409);
        const inventory = (await sql.query("SELECT * FROM console_library_entries WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='READY_ON_PS5' AND sha256=$4 AND size=$5", [c.id, job.release_id, job.storage_id, image.sha256, image.size])).rows[0];
        if (!inventory || (job.config.method !== 'HOMEBREW' && !inventory.registered)) throw new AppError('INVENTORY_CONFIRMATION_REQUIRED', 409);
        if(job.config.backport&&(inventory.backport_profile_id!==job.config.backport.profile.id||inventory.backport_files!==(job.config.backport.placement==='SCAN_PATH')))throw new AppError('BACKPORT_VERIFICATION_REQUIRED',409);
      }
      const eta = body.speedBytesPerSecond ? Math.ceil((job.total_bytes - body.downloadedBytes) / body.speedBytesPerSecond) : null;
      await sql.query('UPDATE jobs SET state=$2,downloaded_bytes=$3,speed_bytes_per_second=$4,eta_seconds=$5,error=$6,updated_at=now() WHERE id=$1', [id, body.state, body.downloadedBytes, body.speedBytesPerSecond, eta, body.error ?? null]);
      if (body.state !== 'READY_ON_PS5') await sql.query('UPDATE console_library_entries SET state=$4,updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3', [c.id, job.release_id, job.storage_id, body.state]);
      await jobEvent(sql, id); return { ok: true };
    });
  });
  app.get('/api/v1/device/artifacts/:id', async (req, reply) => {
    const c = await auth.device(req), id = uuid.parse((req.params as { id: string }).id);
    const a = (await db.query("SELECT a.* FROM artifacts a JOIN game_releases r ON r.id=a.release_id WHERE a.id=$1 AND a.verified AND EXISTS(SELECT 1 FROM jobs j WHERE j.artifact_id=a.id AND j.console_id=$2 AND j.kind='TRANSFER' AND j.desired_state='RUNNING') AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=$3)", [id, c.id,c.user_id])).rows[0];
    if (!a) throw new AppError('NOT_FOUND', 404);
    const file = await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,a.relative_path));
    return serveStoredFile(req,reply,file,Number(a.size),a.sha256);
  });
  return { plan, enqueue,close:native.close };
}
