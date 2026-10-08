import { randomUUID, createHash } from 'node:crypto';
import {accessibleSource,sourceLocation} from '../sources/access.js';
import {constants,type Stats} from 'node:fs';
import { access, mkdir, readdir, stat, rename, rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid, buildFormats,profileSchema,releaseSchema,sha256 } from '../../../shared/schemas/index.js';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { existingWithin, within } from '../security/paths.js';
import { sourceHeaders } from '../sources/connectors.js';
import { downloadFile, fileHash } from '../downloads/stream.js';
import { runWorker } from '../library/inspect.js';
import { jobEvent } from './events.js';
import {backportFiles,profileHash} from '../library/backports.js';
import {quotaExceeded,quotaMaximum,requireDiskSpace,storageUsage} from '../storage/usage.js';
import {artifactStoragePath,releaseStorageFolder,safeStorageName} from '../storage/names.js';
import {throttleWorkerProgress} from '../worker-progress.js';

const builders = { FPKG: '5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e+ps5library-streaming-kraken-v1', SHADOWMOUNT: 'b5307a60d5b4e3a68ba680e0e33cfadf05017c77' };
export const buildKey = (sha: string, method: keyof typeof builders,profile?:string|null) => createHash('sha256').update(`pipeline-v8-playgo:${method}:${builders[method]}:${sha}${profile?`:backport-v5:${profile}`:''}`).digest('hex');
export const artifactBuildKey=(sha:string,method:keyof typeof builders,_profile?:z.infer<typeof profileSchema>|null)=>buildKey(sha,method,null);
export const legacyFpkgBuilderVersion=builders.FPKG.split('+',1)[0]!;
export const packageBuildAllowed=(role:string|undefined)=>role==='ADMIN';
export const transferArtifactUsable=(artifact:any)=>{
  if(!artifact?.builder_version)return true;
  const method=artifact.format==='pkg'?'FPKG':artifact.format==='ffpkg'?'SHADOWMOUNT':null;
  if(method&&artifact.cache_key===artifactBuildKey(artifact.input_hash,method))return true;
  const image=artifact.inspection?.installedImage;
  return artifact.format==='pkg'&&!artifact.profile_id&&typeof artifact.builder_version==='string'&&artifact.builder_version.endsWith(legacyFpkgBuilderVersion)&&artifact.inspection?.structurallyRecognized===true&&artifact.inspection?.metadataVerified===true&&Number.isSafeInteger(image?.size)&&image.size>0&&/^[0-9a-f]{64}$/.test(image?.sha256??'');
};
export const preparationReservationBytes=(size:number,patchGrowth:number,format:string,method:keyof typeof builders)=>format==='folder'&&method==='FPKG'?size+patchGrowth+64*1024**2:size*(format==='folder'?4:5)+patchGrowth*5+64*1024**2;
const sameFileIdentity=(left:Stats,right:Stats)=>left.dev===right.dev&&left.ino===right.ino&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs;
const profileInputHash=(source:any)=>source.sourceTreeSha256??source.sha256;
const suppliedCompatibilityMaterial=async(root:string|null)=>root!==null&&(await readdir(root,{withFileTypes:true})).some(entry=>['backport','backports','fakelib','fakelib2'].includes(entry.name.toLowerCase())&&(entry.isFile()||entry.isSymbolicLink()||entry.isDirectory()));
const buildInput=(source:any,method:keyof typeof builders)=>source.format==='folder'&&method==='SHADOWMOUNT'
  ? {sha256:profileInputHash(source),size:source.sourceTreeSize??source.size}
  : {sha256:source.sha256,size:source.size};

export async function ensurePublishDirectories(dataDir:string,row:Parameters<typeof releaseStorageFolder>[0],backport:boolean){
  const directories=[path.join(dataDir,'artifacts',releaseStorageFolder(row)),...(backport?[path.join(dataDir,'backports',releaseStorageFolder(row))]:[])];
  try{for(const directory of directories){await mkdir(directory,{recursive:true});await access(directory,constants.W_OK);}}
  catch(error){if(['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw new AppError('STORAGE_NOT_WRITABLE',500,'The configured server storage is not writable by the server container.');throw error;}
}

async function cachedBuildArtifact(db:DB,config:Config,releaseId:string,source:any,method:keyof typeof builders){
  const inputHash=buildInput(source,method).sha256,cacheKey=artifactBuildKey(inputHash,method);
  const exact=(await db.query('SELECT * FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',[releaseId,cacheKey])).rows[0];
  if(exact||method!=='FPKG'||source.format!=='folder'||!source.sourceTreeSha256||source.sourceTreeSha256===source.sha256)return exact;
  const legacyKey=artifactBuildKey(source.sourceTreeSha256,'FPKG'),legacy=(await db.query("SELECT * FROM artifacts WHERE release_id=$1 AND format='pkg' AND profile_id IS NULL AND input_hash=$2 AND cache_key=$3 AND verified AND deleted_at IS NULL AND right(builder_version,length($4))=$4 ORDER BY created_at DESC LIMIT 1",[releaseId,source.sourceTreeSha256,legacyKey,builders.FPKG])).rows[0];
  if(!legacy)return null;
  const file=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,legacy.relative_path)).catch(()=>null),before=file?await stat(file).catch(()=>null):null;
  if(!before?.isFile()||before.size!==Number(legacy.size))return null;
  return transaction(db,async sql=>{
    await sql.query('SELECT pg_advisory_xact_lock(3150003)');
    const currentExact=(await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',[releaseId,cacheKey])).rows[0];
    if(currentExact)return currentExact;
    const current=(await sql.query("SELECT * FROM artifacts WHERE id=$1 AND release_id=$2 AND format='pkg' AND profile_id IS NULL AND input_hash=$3 AND cache_key=$4 AND verified AND deleted_at IS NULL AND right(builder_version,length($5))=$5 FOR UPDATE",[legacy.id,releaseId,source.sourceTreeSha256,legacyKey,builders.FPKG])).rows[0],after=await stat(file!).catch(()=>null);
    if(!current||current.relative_path!==legacy.relative_path||current.sha256!==legacy.sha256||Number(current.size)!==Number(legacy.size)||!after||!sameFileIdentity(before,after))return null;
    return (await sql.query('UPDATE artifacts SET input_hash=$2,cache_key=$3 WHERE id=$1 RETURNING *',[legacy.id,source.sha256,cacheKey])).rows[0];
  });
}

export async function publishArtifact(db: DB, config: Config, row: any, result: any) {
  if(row.kind==='BUILD' && (result.libraryPolicy!=='CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC' || !result.builderVersion?.endsWith(builders[row.config.method as keyof typeof builders])))throw new AppError('WORKER_VERSION_MISMATCH',409,'Rebuild the package worker before preparing content.');
  const applied=row.config.profile?profileHash(row.config.profile):null;
  if((result.profileId??null)!==(row.config.profile?.id??null)||(result.profileHash??null)!==applied)throw new AppError('PROFILE_NOT_APPLIED',409);
  const cacheKey=row.kind==='BUILD'?artifactBuildKey(result.inputHash,row.config.method,row.config.profile):row.config.cacheKey??null;
  const relativePath = artifactStoragePath(row,result);
  const target = path.join(config.DATA_DIR, relativePath);
  const publishProgress=async(stage:string,completedBytes:number,totalBytes:number)=>{
    const progress={stage,completedStages:6,totalStages:7,operation:{completedBytes,totalBytes}};
    if(!(await db.query("UPDATE jobs SET config=jsonb_set(config,'{progress}',$2::jsonb),speed_bytes_per_second=0,eta_seconds=NULL,updated_at=now() WHERE id=$1 AND desired_state='RUNNING' RETURNING id",[row.id,JSON.stringify(progress)])).rowCount){
      const control=(await db.query('SELECT desired_state FROM jobs WHERE id=$1',[row.id])).rows[0];throw new AppError(control?.desired_state??'CANCELLED');
    }
    await jobEvent(db,row.id);
  };
  const verifyFile=async(filename:string,size:number,sha:string,stage:string)=>{
    const before=await stat(filename).catch(()=>null);if(before?.size!==size)throw new AppError('CACHE_CORRUPT',409);
    await publishProgress(stage,0,size);
    const progress=throttleWorkerProgress(p=>publishProgress(stage,p.operation?.completedBytes??0,p.operation?.totalBytes??size));
    const actual=await runWorker(['hash-file',filename],progress).catch(error=>{if(error instanceof AppError)throw error;return null;});
    const after=await stat(filename).catch(()=>null);
    if(actual?.sha256!==sha||actual?.size!==size||!after||!sameFileIdentity(before,after))throw new AppError('CACHE_CORRUPT',409);
    return after;
  };
  const backport=result.shadowMountBackport?(()=>{
    const value=z.object({outputPath:z.string(),sha256:z.string().regex(/^[0-9a-f]{64}$/),size:z.number().int().nonnegative().safe()}).parse(result.shadowMountBackport);
    const inputHash=z.string().regex(/^[0-9a-f]{64}$/).parse(row.config.sourceMetadata?.sourceTreeSha256??row.config.sourceMetadata?.sha256??result.inputHash),profileName=`Backport ${safeStorageName(row.config.profile?.targetFirmware??'Unknown firmware')} [${inputHash.slice(0,12)}${applied?`-${applied.slice(0,12)}`:''}]`;
    const relative=path.posix.join('backports',releaseStorageFolder(row),profileName),destination=within(config.DATA_DIR,path.join(config.DATA_DIR,relative));
    return {...value,inputHash,relative,destination};
  })():null;
  while(true){
    const artifact=(await db.query('SELECT id,relative_path,sha256,size FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified AND deleted_at IS NULL ORDER BY created_at LIMIT 1',[row.release_id,cacheKey])).rows[0];
    const artifactCheck=artifact?{filename:path.join(config.DATA_DIR,artifact.relative_path),info:await verifyFile(path.join(config.DATA_DIR,artifact.relative_path),artifact.size,artifact.sha256,'Verifying cached package')}:null;
    const targetInfo=artifact?null:await stat(target).catch(()=>null),targetCheck=artifact?null:targetInfo
      ? {info:await verifyFile(target,result.size,result.sha256,'Verifying published package'),outputInfo:null}
      : {info:null,outputInfo:await verifyFile(result.outputPath,result.size,result.sha256,'Verifying package for publish')};
    if(targetCheck&&!targetCheck.info&&targetCheck.outputInfo?.size!==result.size)throw new AppError('CACHE_CORRUPT',409);
    let backportCheck:null|{source:string;info:Stats}=null;
    if(backport){
      const existing=await stat(backport.destination).catch(()=>null),source=existing?backport.destination:await existingWithin(path.join(config.DATA_DIR,'jobs',uuid.parse(row.id)),backport.outputPath),before=await stat(source);
      await publishProgress('Verifying compatibility files',0,backport.size);
      const progress=throttleWorkerProgress(p=>publishProgress('Verifying compatibility files',p.operation?.completedBytes??0,p.operation?.totalBytes??backport.size));
      const actual=await runWorker(['hash-tree',source],progress),after=await stat(source).catch(()=>null);
      if(actual.sha256!==backport.sha256||actual.size!==backport.size||!after||!sameFileIdentity(before,after))throw new AppError('CACHE_CORRUPT',409);
      await publishProgress('Verifying compatibility files',backport.size,backport.size);backportCheck={source,info:after};
    }
    const published=await transaction(db, async sql => {
      // ponytail: one short publish/delete/quota lock; partition by volume if throughput requires it.
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const control = (await sql.query('SELECT desired_state FROM jobs WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
      if (control?.desired_state !== 'RUNNING') throw new AppError(control?.desired_state??'CANCELLED');
      const currentArtifact=(await sql.query('SELECT id,relative_path,sha256,size FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified AND deleted_at IS NULL ORDER BY created_at LIMIT 1',[row.release_id,cacheKey])).rows[0];
      if((!artifact)!==(!currentArtifact)||artifact&&currentArtifact&&(artifact.id!==currentArtifact.id||artifact.relative_path!==currentArtifact.relative_path||artifact.sha256!==currentArtifact.sha256||artifact.size!==currentArtifact.size))return null;
      if(backport&&backportCheck){
        const current=await stat(backportCheck.source).catch(()=>null);if(!current||!sameFileIdentity(current,backportCheck.info))return null;
        if(backportCheck.source!==backport.destination){if(await stat(backport.destination).catch(()=>null))return null;await mkdir(path.dirname(backport.destination),{recursive:true});await rename(backportCheck.source,backport.destination);}
        await sql.query(`INSERT INTO backport_artifacts(id,game_id,release_id,title_id,game_version,target_firmware,type,source,sha256,size,profile_id,tested,artifact_id,input_hash,relative_path,profile_hash)
          SELECT $1,r.game_id,r.id,g.title_id,r.version,$9,'SHADOWMOUNT_FOLDER','DUMP', $3,$4,$7,false,NULL,$5,$6,$8 FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.id=$2
          ON CONFLICT(relative_path) DO UPDATE SET deleted_at=NULL`,[randomUUID(),row.release_id,backport.sha256,backport.size,backport.inputHash,backport.relative,result.profileId??null,applied,row.config.profile?.targetFirmware??null]);
      }
      let publishedArtifact=currentArtifact;
      if(publishedArtifact){
        const current=artifactCheck&&await stat(artifactCheck.filename).catch(()=>null);if(!current||!artifactCheck||!sameFileIdentity(current,artifactCheck.info))return null;
      }else{
        await mkdir(path.dirname(target), { recursive: true });
        if(targetCheck?.info){const current=await stat(target).catch(()=>null);if(!current||!sameFileIdentity(current,targetCheck.info))return null;}
        else{
          if(await stat(target).catch(()=>null))return null;
          const output=await stat(result.outputPath).catch(()=>null);if(!output||!targetCheck?.outputInfo||!sameFileIdentity(output,targetCheck.outputInfo))throw new AppError('CACHE_CORRUPT',409);
          await rename(result.outputPath,target);
        }
        publishedArtifact = (await sql.query(`INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection,input_hash,builder_version,cache_key,profile_id,profile_hash)
          VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12) ON CONFLICT(relative_path) DO UPDATE SET verified=true,deleted_at=NULL,inspection=$7,input_hash=$8,builder_version=$9,cache_key=$10,profile_id=$11,profile_hash=$12 RETURNING id`,
        [randomUUID(), row.release_id, result.format, relativePath, result.sha256, result.size, result.inspection, result.inputHash ?? result.sha256, result.builderVersion ?? null,cacheKey,null,null])).rows[0];
      }
      if (result.inspection.metadataVerified && result.inspection.identity && result.inspection.kind!=='DLC' && row.config.sourceMetadata?.kind!=='DLC') {
        const identity = result.inspection.identity;
        const data = { titleId: identity.titleId, title: identity.title };
        await sql.query("INSERT INTO metadata_records(id,game_id,provider,rank,data) SELECT $1,game_id,$2,1,$3 FROM game_releases WHERE id=$4 ON CONFLICT(game_id,provider) DO UPDATE SET data=$3", [randomUUID(), `inspection:${row.release_id}`, data, row.release_id]);
        await sql.query("UPDATE games SET title=$2,metadata=metadata || $3::jsonb WHERE id=(SELECT game_id FROM game_releases WHERE id=$1)", [row.release_id, identity.title, data]);
      }
      const progress={stage:'Verified on server',completedStages:7,totalStages:7,package:{method:row.config.method,state:'VERIFIED'},fakelib:{state:backport?'VERIFIED':'NOT_REQUIRED',size:backport?.size}};
      await sql.query("UPDATE jobs SET state='COMPLETED',artifact_id=$2,downloaded_bytes=total_bytes,speed_bytes_per_second=0,eta_seconds=0,config=jsonb_set(config,'{progress}',$3::jsonb),updated_at=now() WHERE id=$1", [row.id, publishedArtifact.id,JSON.stringify(progress)]);
      await sql.query("INSERT INTO library_entries(user_id,release_id,artifact_id,state) VALUES($1,$2,$3,'READY_ON_SERVER') ON CONFLICT(user_id,release_id) DO UPDATE SET artifact_id=$3,state='READY_ON_SERVER'", [row.user_id, row.release_id, publishedArtifact.id]);
      await jobEvent(sql, row.id); return publishedArtifact.id as string;
    });
    if(published!==null)return published;
  }
}

export async function prepare(db: DB, config: Config, row: any) {
  const source = row.config.sourceMetadata;
  const expected=buildInput(source,row.config.method);
  const root = path.join(config.DATA_DIR, 'jobs', row.id); await mkdir(root, { recursive: true });
  const setStage = async (state: string, progress?: object) => {
    const changed=await db.query("UPDATE jobs SET state=$2,config=jsonb_set(config,'{progress}',$3),speed_bytes_per_second=0,updated_at=now() WHERE id=$1 AND desired_state='RUNNING' RETURNING id", [row.id, state, JSON.stringify(progress ?? { stage: state, completedStages: 0, totalStages: 7 })]);
    if(!changed.rowCount){const control=(await db.query('SELECT desired_state FROM jobs WHERE id=$1',[row.id])).rows[0];throw new AppError(control?.desired_state??'CANCELLED');}
    await jobEvent(db, row.id);
  };
  await db.query("UPDATE jobs SET attempts=attempts+1,error=NULL WHERE id=$1", [row.id]);
  if(row.attempts>0)await rm(within(config.DATA_DIR,path.join(root,'output')),{recursive:true,force:true});
  const [local,location]=await sourceLocation(config,row.config.sourceType,row.config.sourceOwner??row.user_id,source.location);
  const identity = { titleId: row.title_id, contentId: row.content_id, version: row.version };
  let input = location;
  if (source.format !== 'folder' && !local) {
    input = path.join(root, 'content.part'); await setStage('DOWNLOADING');
    await downloadFile({ location, local, partPath:input, size: source.size, sha256: source.sha256, privateOrigins: config.privateOrigins, headers: sourceHeaders(row.config.sourceConfig, location), margin: config.DISK_MARGIN_BYTES,
      progress: async p => { await setStage('DOWNLOADING'); await db.query('UPDATE jobs SET downloaded_bytes=$2,speed_bytes_per_second=$3,eta_seconds=$4 WHERE id=$1', [row.id, p.downloadedBytes, p.speedBytesPerSecond, p.etaSeconds]); await jobEvent(db, row.id); },
      onVerify:()=>setStage('VERIFYING',{stage:'Verifying source',completedStages:1,totalStages:7}) });
  }
  const profileArgs:string[]=[];const profile=row.config.profile?profileSchema.parse(row.config.profile):null;
  await ensurePublishDirectories(config.DATA_DIR,row,profile?.delivery==='OVERLAY');
  if(profile){
    const file=path.join(root,'profile.json');await writeFile(file,JSON.stringify(profile));profileArgs.push(file);
  }
  const cached=profile?.delivery==='OVERLAY'&&source.format==='folder'&&row.config.method==='FPKG'?await cachedBuildArtifact(db,config,row.release_id,source,'FPKG'):null;
  const cachedFile=cached?path.join(config.DATA_DIR,cached.relative_path):null,cachedInfo=cachedFile?await stat(cachedFile).catch(()=>null):null;
  const overlay=cached&&cachedInfo?.isFile()&&cachedInfo.size===Number(cached.size)
    ? await runWorker(['build-backport',input,path.join(root,'output'),row.config.method,JSON.stringify(identity),source.sha256,...profileArgs],throttleWorkerProgress(p=>setStage('BUILDING',p)))
    : null;
  const result=overlay?{...overlay,outputPath:cachedFile,format:cached.format,sha256:cached.sha256,size:Number(cached.size),builderVersion:cached.builder_version,releaseId:row.release_id,createdAt:new Date().toISOString(),inspection:cached.inspection,libraryPolicy:'CLEAN_PACKAGE_EXTERNAL_BACKPORT_AND_SEPARATE_DLC'}:source.format==='folder'
    ? await runWorker(['build-verified',input,path.join(root,'output'),row.config.method,JSON.stringify(identity),row.release_id,expected.sha256,String(expected.size),...profileArgs],throttleWorkerProgress(p=>setStage('BUILDING',p)))
    : await runWorker(['build-archive',input,path.join(root,'output'),row.config.method,JSON.stringify(identity),row.release_id,source.sha256,String(quotaMaximum(source.installedSize??source.size*8,config.QUOTA_BYTES)),...profileArgs],throttleWorkerProgress(p=>setStage(p.stage==='Extracting archive'?'EXTRACTING':'BUILDING',p)));
  await publishArtifact(db, config, row, result);
  await rm(within(config.DATA_DIR, root), { recursive: true, force: true });
}

export async function preparationRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth, reconcile: () => Promise<void>) {
  const bodySchema = z.object({ sourceReleaseId: uuid, method: z.enum(['FPKG','SHADOWMOUNT']),profileId:uuid.optional() });
  const enqueue = async (userId: string, body: z.infer<typeof bodySchema>, automatic = false) => {
    if(!config.features.newDownloads){if(automatic)return {skipped:true};throw new AppError('NEW_DOWNLOADS_DISABLED',403);}
    const source = await accessibleSource(db,userId,body.sourceReleaseId);
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (!buildFormats.includes(source.metadata.format) || ['folder','rar','7z'].includes(source.metadata.format) && !['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type)) throw new AppError('UNSUPPORTED_INPUT', 422, 'Use local prepared folders, complete local RAR/7z sets, or ZIP archives.');
    if(source.metadata.kind==='DLC')throw new AppError('UNSUPPORTED_INPUT',422,'Supplied DLC packages are cached directly and never rebuilt into the base game.');
    const profile=body.profileId?profileSchema.parse((await db.query('SELECT profile FROM compatibility_profiles WHERE id=$1 AND user_id=ANY($2::uuid[])',[body.profileId,[userId,source.source_owner]])).rows[0]?.profile):null;
    const exactInputHash=profileInputHash(source.metadata),input=buildInput(source.metadata,body.method);
    if(profile&&(profile.titleId!==source.metadata.game.titleId||profile.contentId!==source.metadata.game.contentId||profile.gameVersion!==source.metadata.version||!profile.inputHashes.includes(exactInputHash)||profile.installationMethod!==body.method||profile.testedState==='UNKNOWN'))throw new AppError('PROFILE_MISMATCH',409);
    const automaticInputHash=profile?exactInputHash:input.sha256;
    if(automatic&&(await db.query('SELECT 1 FROM automatic_preparations WHERE source_release_id=$1 AND input_hash=$2 AND method=$3',[source.id,automaticInputHash,body.method])).rowCount)return {skipped:true};
    const fingerprint=profile?profileHash(profile):null,key=buildKey(input.sha256,body.method,fingerprint),artifactKey=artifactBuildKey(input.sha256,body.method,profile);
    while(true){
      const cached=await cachedBuildArtifact(db,config,source.release_id,source.metadata,body.method);
      let filePresent=false,valid=false,ready=false,backportId:string|null=null,backportError:unknown;
      if(cached){
        const file=path.join(config.DATA_DIR,cached.relative_path),fileStat=await stat(file).catch(()=>null);
        filePresent=!!fileStat;valid=fileStat?.isFile()===true&&fileStat.size===cached.size;ready=valid;
        if(valid&&profile)try{const verified=await backportFiles(db,config,source.release_id,exactInputHash,profile);ready=!verified.needsPreparation;backportId=verified.backportId;}
        catch(error){
          if(error instanceof AppError&&error.code==='BACKPORT_FILES_MISSING')ready=false;else backportError=error;
          backportId=(await db.query("SELECT id FROM backport_artifacts WHERE release_id=$1 AND input_hash=ANY($2::text[]) AND type='SHADOWMOUNT_FOLDER' AND deleted_at IS NULL AND (profile_hash=$3 OR profile_hash IS NULL) ORDER BY (profile_hash IS NOT NULL) DESC,created_at DESC LIMIT 1",[source.release_id,profile.inputHashes,fingerprint])).rows[0]?.id??null;
        }
      }
      const result=await transaction(db,async sql=>{
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const current=(await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND cache_key=$2 AND verified ORDER BY created_at DESC LIMIT 1',[source.release_id,artifactKey])).rows[0];
        if((!cached)!==(!current)||cached&&current&&(cached.id!==current.id||cached.relative_path!==current.relative_path||cached.sha256!==current.sha256||cached.size!==current.size))return {retry:true as const};
        if(valid&&profile){
          const currentBackport=(await sql.query("SELECT id FROM backport_artifacts WHERE release_id=$1 AND input_hash=ANY($2::text[]) AND type='SHADOWMOUNT_FOLDER' AND deleted_at IS NULL AND (profile_hash=$3 OR profile_hash IS NULL) ORDER BY (profile_hash IS NOT NULL) DESC,created_at DESC LIMIT 1",[source.release_id,profile.inputHashes,fingerprint])).rows[0]?.id??null;
          if(currentBackport!==backportId)return {retry:true as const};
        }
        if(automatic&&!(await sql.query('INSERT INTO automatic_preparations(source_release_id,input_hash,method) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_release_id',[source.id,automaticInputHash,body.method])).rowCount)return {skipped:true};
        if(backportError)throw backportError;
        if(cached){
          if(valid&&ready)return {cached:true,artifactId:cached.id};
          if(!valid){await sql.query('UPDATE artifacts SET verified=false WHERE id=$1',[cached.id]);if(filePresent)throw new AppError('CACHE_CORRUPT',409,'Delete the changed cached file before preparing again.');}
        }
        const role=(await sql.query('SELECT role FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0]?.role as string|undefined;
        if(!packageBuildAllowed(role))throw new AppError('ADMIN_REQUIRED',403,'Only an administrator can prepare a new package.');
        if(source.metadata.retiredAt)throw new AppError('SOURCE_RETIRED',409,'Restore this dump from quarantine before rebuilding it.');
        const active=(await sql.query("SELECT id FROM jobs WHERE user_id=$1 AND source_release_id=$2 AND kind='BUILD' AND config->>'cacheKey'=$3 AND state NOT IN ('COMPLETED','ERROR','CANCELLED')",[userId,source.id,key])).rows[0];
        if(active)return {id:active.id,cached:false};
        const patchGrowth=(profile?.requiredPatches.filter(p=>p.bps||p.sdk||p.outputFormat).length??0)*65536;
        const reserve=preparationReservationBytes(source.metadata.format==='folder'?input.size:source.metadata.installedSize??source.metadata.size*8,patchGrowth,source.metadata.format,body.method);
        if(!Number.isSafeInteger(reserve))throw new AppError('INPUT_TOO_LARGE',422);
        if(quotaExceeded(await storageUsage(sql),reserve,config.QUOTA_BYTES))throw new AppError('QUOTA_EXCEEDED',409);
        await requireDiskSpace(path.join(config.DATA_DIR,'jobs'),reserve+config.DISK_MARGIN_BYTES);
        const id=randomUUID();
        await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,total_bytes,config) VALUES($1,$2,'BUILD',$3,$4,'QUEUED',$5,$6)",[id,userId,source.release_id,source.id,input.size,{sourceMetadata:source.metadata,sourceConfig:source.config,sourceType:source.type,sourceOwner:source.source_owner,method:body.method,cacheKey:key,reservedBytes:reserve,profile}]);
        await jobEvent(sql,id);return {id,cached:false};
      });
      if('retry' in result)continue;
      await reconcile();return result;
    }
  };
  app.post('/api/v1/preparations', async (req, reply) => reply.code(202).send(await enqueue((await auth.user(req)).id, bodySchema.parse(req.body))));
  app.post('/api/v1/device/preparations', async (req, reply) => reply.code(202).send(await enqueue((await auth.device(req)).user_id, bodySchema.parse(req.body))));
  app.get('/api/v1/artifacts', async req => (await db.query('SELECT a.id,a.format,a.size,a.sha256,a.verified,a.builder_version AS "builderVersion",a.created_at AS "createdAt",a.release_id AS "releaseId",g.title,r.version FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE g.user_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at DESC', [(await auth.user(req)).id])).rows);
  app.post('/api/v1/source-releases/:id/retire',async req=>{
    const user=await auth.user(req);if(user.role!=='ADMIN')throw new AppError('ADMIN_REQUIRED',403);
    if(!config.DUMP_ROOT)throw new AppError('DUMP_ROOT_NOT_CONFIGURED',409);
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({confirm:z.literal('RETIRE'),inputSha256:sha256,profileId:uuid.optional(),deleteSource:z.boolean().optional().default(false)}).strict().parse(req.body);
    const fileState:{rollbackMove?:{original:string;quarantine:string};cleanup?:{dumpRoot:string;quarantine:string}}={};let committed=false;
    try{
      const row=(await db.query(`SELECT sr.*,s.type,s.config,s.user_id AS source_owner,r.content_id,r.version,g.title_id
        FROM source_releases sr JOIN sources s ON s.id=sr.source_id JOIN game_releases r ON r.id=sr.release_id JOIN games g ON g.id=r.game_id
        WHERE sr.id=$1 AND s.user_id=$2`,[id,user.id])).rows[0];
      if(!row)throw new AppError('NOT_FOUND',404);
      if(row.type!=='WATCH_FOLDER')throw new AppError('UNSUPPORTED_INPUT',422,'Only watched dump folders can be retired.');
      const source=releaseSchema.parse(row.metadata);
      if(body.inputSha256!==source.sha256)throw new AppError('SOURCE_CHANGED',409);
      if(row.metadata.retiredAt&&(!body.deleteSource||row.metadata.sourceRemovedAt))return {ok:true,alreadyRetired:true,sourceDeleted:Boolean(row.metadata.sourceRemovedAt),quarantinePath:row.metadata.quarantinePath};
      if(source.format!=='folder'||source.location==='.')throw new AppError('UNSUPPORTED_INPUT',422,'Only an individual watched dump folder can be retired.');
      if((await db.query("SELECT 1 FROM jobs WHERE source_release_id=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')",[id])).rowCount||(await db.query("SELECT 1 FROM installations WHERE source_release_id=$1 AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[id])).rowCount)throw new AppError('SOURCE_IN_USE',409);
      const dumpRoot=await existingWithin(config.DUMP_ROOT,config.DUMP_ROOT),originalPath=within(dumpRoot,path.resolve(dumpRoot,source.location));
      if(originalPath===dumpRoot)throw new AppError('UNSAFE_PATH',409);
      const quarantineRelative=path.posix.join('.ps5library-trash',id,'input'),trashRoot=within(dumpRoot,path.join(dumpRoot,'.ps5library-trash')),quarantineParent=within(dumpRoot,path.join(trashRoot,id)),quarantine=within(dumpRoot,path.join(quarantineParent,'input'));
      const [originalInfo,quarantineInfo]=await Promise.all([stat(originalPath).catch(()=>null),stat(quarantine).catch(()=>null)]);
      if(originalInfo&&quarantineInfo)throw new AppError('QUARANTINE_CONFLICT',409);
      if(!originalInfo&&!quarantineInfo&&!row.metadata.retiredAt)throw new AppError('INPUT_NOT_FOUND',404);
      if(originalInfo)await existingWithin(dumpRoot,originalPath);
      if(quarantineInfo)await existingWithin(dumpRoot,quarantine);
      const sourcePath=originalInfo?originalPath:quarantineInfo?quarantine:null,sourceInfo=originalInfo??quarantineInfo;
      const rawProfile=body.profileId?(await db.query('SELECT profile FROM compatibility_profiles WHERE id=$1 AND user_id=$2',[body.profileId,user.id])).rows[0]?.profile:null;
      const profile=body.profileId?profileSchema.parse(rawProfile):null;
      if(profile&&(profile.id!==body.profileId||profile.titleId!==row.title_id||profile.contentId!==row.content_id||profile.gameVersion!==row.version||profile.installationMethod!=='FPKG'||profile.testedState==='UNKNOWN'||!profile.inputHashes.includes(profileInputHash(source))||profile.delivery==='OVERLAY'&&!profile.requiredLibraries.length&&!profile.requiredPatches.length&&!profile.requiredFiles.length))throw new AppError('PROFILE_MISMATCH',409);
      if(!profile&&await suppliedCompatibilityMaterial(sourcePath))throw new AppError('PROFILE_MISMATCH',409,'Select the exact compatibility profile before deleting a dump that contains backport files.');
      const fingerprint=profile?profileHash(profile):null;
      const artifact=(await db.query("SELECT * FROM artifacts WHERE release_id=$1 AND format='pkg' AND profile_id IS NULL AND verified AND deleted_at IS NULL AND input_hash=$2 AND cache_key=$3 ORDER BY created_at DESC LIMIT 1",[row.release_id,source.sha256,artifactBuildKey(source.sha256,'FPKG',profile)])).rows[0];
      if(!artifact||!artifact.builder_version?.endsWith(builders.FPKG))throw new AppError('FPKG_NOT_READY',409);
      const identity=artifact.inspection?.identity;
      if(artifact.inspection?.metadataVerified!==true||identity?.titleId!==row.title_id||identity?.contentId!==row.content_id||identity?.version!==row.version)throw new AppError('METADATA_MISMATCH',409);
      const packageFile=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,artifact.relative_path)).catch(()=>null),packageBefore=packageFile?await stat(packageFile).catch(()=>null):null;
      if(!packageFile||!packageBefore?.isFile()||packageBefore.size!==artifact.size||await fileHash(packageFile)!==artifact.sha256)throw new AppError('CACHE_CORRUPT',409);
      const packageInspection=await runWorker(['inspect',packageFile,JSON.stringify({titleId:row.title_id,contentId:row.content_id,version:row.version})]).catch(()=>null);
      const packageInfo=await stat(packageFile).catch(()=>null);
      if(packageInspection?.format!=='pkg'||packageInspection.structurallyRecognized!==true||packageInspection.metadataVerified!==true||packageInspection.kind!==source.kind||!packageInfo||!sameFileIdentity(packageBefore,packageInfo))throw new AppError('CACHE_CORRUPT',409);
      const backport=!profile||profile.delivery==='INTEGRATED'?null:(await db.query("SELECT * FROM backport_artifacts WHERE release_id=$1 AND input_hash=ANY($2::text[]) AND type='SHADOWMOUNT_FOLDER' AND profile_id=$3 AND profile_hash=$4 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[row.release_id,profile.inputHashes,body.profileId,fingerprint])).rows[0];
      if(profile?.delivery==='OVERLAY'&&!backport)throw new AppError('BACKPORT_FILES_MISSING',409);
      const verifiedBackport=profile?await backportFiles(db,config,row.release_id,profileInputHash(source),profile):null;
      if(verifiedBackport&&(verifiedBackport.needsPreparation||profile!.delivery==='OVERLAY'&&verifiedBackport.backportId!==backport.id))throw new AppError('BACKPORT_FILES_MISMATCH',409);
      const backportResult={backportId:backport?.id??null,tested:profile?.testedState==='TESTED'};
      for(const folder of [trashRoot,quarantineParent]){try{await mkdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const safe=await existingWithin(dumpRoot,folder);if(!(await stat(safe)).isDirectory())throw new AppError('UNSAFE_PATH',409);}
      if(!row.metadata.retiredAt){
        const digest=await runWorker(['hash-base-tree',await existingWithin(dumpRoot,sourcePath!)]),after=await stat(sourcePath!).catch(()=>null);
        if(digest.sha256!==source.sha256||digest.size!==source.size||source.sourceTreeSha256&&digest.sourceTreeSha256!==source.sourceTreeSha256||source.sourceTreeSize!==undefined&&digest.sourceTreeSize!==source.sourceTreeSize)throw new AppError('SOURCE_CHANGED',409);
        if(!sourceInfo||!after||!sameFileIdentity(sourceInfo,after))throw new AppError('SOURCE_CHANGED',409);
      }
      const rowState=JSON.stringify([row.source_id,row.release_id,row.type,row.config,row.content_id,row.version,row.title_id,row.metadata]);
      const result=await transaction(db,async sql=>{
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const current=(await sql.query(`SELECT sr.*,s.type,s.config,s.user_id AS source_owner,r.content_id,r.version,g.title_id
          FROM source_releases sr JOIN sources s ON s.id=sr.source_id JOIN game_releases r ON r.id=sr.release_id JOIN games g ON g.id=r.game_id
          WHERE sr.id=$1 AND s.user_id=$2 FOR UPDATE OF sr`,[id,user.id])).rows[0];
        if(!current||JSON.stringify([current.source_id,current.release_id,current.type,current.config,current.content_id,current.version,current.title_id,current.metadata])!==rowState)throw new AppError('SOURCE_CHANGED',409);
        if((await sql.query("SELECT 1 FROM jobs WHERE source_release_id=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')",[id])).rowCount||(await sql.query("SELECT 1 FROM installations WHERE source_release_id=$1 AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[id])).rowCount)throw new AppError('SOURCE_IN_USE',409);
        const currentRawProfile=body.profileId?(await sql.query('SELECT profile FROM compatibility_profiles WHERE id=$1 AND user_id=$2',[body.profileId,user.id])).rows[0]?.profile:null;
        if(profile){if(!currentRawProfile)throw new AppError('PROFILE_MISMATCH',409);const currentProfile=profileSchema.parse(currentRawProfile);if(profileHash(currentProfile)!==fingerprint)throw new AppError('PROFILE_MISMATCH',409);}
        const currentArtifact=(await sql.query("SELECT * FROM artifacts WHERE release_id=$1 AND format='pkg' AND profile_id IS NULL AND verified AND deleted_at IS NULL AND input_hash=$2 AND cache_key=$3 ORDER BY created_at DESC LIMIT 1",[row.release_id,source.sha256,artifactBuildKey(source.sha256,'FPKG',profile)])).rows[0];
        if(!currentArtifact||currentArtifact.id!==artifact.id||currentArtifact.sha256!==artifact.sha256||Number(currentArtifact.size)!==Number(artifact.size)||currentArtifact.relative_path!==artifact.relative_path||currentArtifact.builder_version!==artifact.builder_version||JSON.stringify(currentArtifact.inspection)!==JSON.stringify(artifact.inspection))throw new AppError('CACHE_CORRUPT',409);
        const currentPackage=await stat(packageFile).catch(()=>null);if(!currentPackage||!sameFileIdentity(packageInfo,currentPackage))throw new AppError('CACHE_CORRUPT',409);
        const currentBackport=!profile||profile.delivery==='INTEGRATED'?null:(await sql.query("SELECT * FROM backport_artifacts WHERE release_id=$1 AND input_hash=ANY($2::text[]) AND type='SHADOWMOUNT_FOLDER' AND profile_id=$3 AND profile_hash=$4 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[row.release_id,profile.inputHashes,body.profileId,fingerprint])).rows[0];
        if((currentBackport?.id??null)!==(backport?.id??null)||(currentBackport&&backport&&(currentBackport.sha256!==backport.sha256||Number(currentBackport.size)!==Number(backport.size)||currentBackport.relative_path!==backport.relative_path)))throw new AppError('BACKPORT_FILES_MISMATCH',409);
        const currentOriginal=await stat(originalPath).catch(()=>null),currentQuarantine=await stat(quarantine).catch(()=>null);
        if(Boolean(currentOriginal)!==Boolean(originalInfo)||Boolean(currentQuarantine)!==Boolean(quarantineInfo)||currentOriginal&&originalInfo&&!sameFileIdentity(currentOriginal,originalInfo)||currentQuarantine&&quarantineInfo&&!sameFileIdentity(currentQuarantine,quarantineInfo))throw new AppError('SOURCE_CHANGED',409);
        if(currentOriginal)await existingWithin(dumpRoot,originalPath);if(currentQuarantine)await existingWithin(dumpRoot,quarantine);
        if(!currentOriginal&&!currentQuarantine){
          if(body.deleteSource&&current.metadata.retiredAt){await sql.query("UPDATE source_releases SET metadata=metadata||jsonb_build_object('sourceRemovedAt',COALESCE(metadata->'sourceRemovedAt',to_jsonb(now()))) WHERE id=$1",[id]);return {ok:true,alreadyRetired:true,sourceDeleted:true,quarantinePath:quarantineRelative,artifactId:artifact.id,...backportResult};}
          throw new AppError('INPUT_NOT_FOUND',404);
        }
        if(currentOriginal){await rename(originalPath,quarantine);fileState.rollbackMove={original:originalPath,quarantine};}
        if(!current.metadata.retiredAt){
        await sql.query("UPDATE source_releases SET metadata=metadata||jsonb_build_object('retiredAt',now(),'quarantinePath',$2::text) WHERE id=$1",[id,quarantineRelative]);
        const watchRoot=within(dumpRoot,path.resolve(dumpRoot,row.config.location)),observation=path.relative(watchRoot,originalPath).split(path.sep).join('/')||'.';
        await sql.query("UPDATE source_observations SET state='RETIRED',error=NULL WHERE source_id=$1 AND path=$2",[row.source_id,observation]);
        }
        fileState.cleanup={dumpRoot,quarantine};
        return {ok:true,sourceDeleted:false,quarantinePath:quarantineRelative,artifactId:artifact.id,...backportResult};
      });
      committed=true;
      if(body.deleteSource&&fileState.cleanup){
        const pending=await stat(fileState.cleanup.quarantine).catch(()=>null);
        if(pending)await rm(await existingWithin(fileState.cleanup.dumpRoot,fileState.cleanup.quarantine),{recursive:true,force:true,maxRetries:2,retryDelay:100});
        await db.query("UPDATE source_releases SET metadata=metadata||jsonb_build_object('sourceRemovedAt',COALESCE(metadata->'sourceRemovedAt',to_jsonb(now()))) WHERE id=$1",[id]);
        return {...result,sourceDeleted:true};
      }
      return result;
    }catch(error){
      if(!committed&&fileState.rollbackMove&&!await stat(fileState.rollbackMove.original).catch(()=>null)&&await stat(fileState.rollbackMove.quarantine).catch(()=>null))await rename(fileState.rollbackMove.quarantine,fileState.rollbackMove.original);
      throw error;
    }
  });
  app.delete('/api/v1/backports/:id',async req=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id);
    let moved:{original:string;staged:string}|undefined,committed=false;
    try{
      const result=await transaction(db,async sql=>{
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const row=(await sql.query("SELECT b.* FROM backport_artifacts b JOIN games g ON g.id=b.game_id WHERE b.id=$1 AND g.user_id=$2 AND b.type='SHADOWMOUNT_FOLDER' AND b.deleted_at IS NULL FOR UPDATE OF b",[id,user.id])).rows[0];
        if(!row)throw new AppError('NOT_FOUND',404);
        if(row.profile_id)throw new AppError('BACKPORT_IN_USE',409);
        if((await sql.query("SELECT id FROM jobs WHERE config->'backport'->>'backportId'=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')",[id])).rowCount)throw new AppError('BACKPORT_IN_USE',409);
        const original=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path)),staged=within(config.DATA_DIR,`${original}.delete-${randomUUID()}`);
        await rename(original,staged);moved={original,staged};
        await sql.query('UPDATE backport_artifacts SET deleted_at=now() WHERE id=$1',[id]);return {ok:true,freedBytes:row.size};
      });
      committed=true;await rm(moved!.staged,{recursive:true,force:true});return result;
    }catch(error){
      if(!committed&&moved&&!await stat(moved.original).catch(()=>null)&&await stat(moved.staged).catch(()=>null))await rename(moved.staged,moved.original);
      throw error;
    }
  });
  app.delete('/api/v1/artifacts/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    let moved:{original:string;staged:string}|undefined,committed=false;
    try{
      const result=await transaction(db, async sql => {
        await sql.query('SELECT pg_advisory_xact_lock(3150003)');
        const artifact = (await sql.query('SELECT a.* FROM artifacts a JOIN game_releases r ON r.id=a.release_id JOIN games g ON g.id=r.game_id WHERE a.id=$1 AND g.user_id=$2 AND a.deleted_at IS NULL FOR UPDATE OF a', [id, user.id])).rows[0];
        if (!artifact) throw new AppError('NOT_FOUND', 404);
        if ((await sql.query("SELECT id FROM jobs WHERE artifact_id=$1 AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')", [id])).rowCount) throw new AppError('ARTIFACT_IN_USE', 409);
        const candidate=within(config.DATA_DIR,path.join(config.DATA_DIR,artifact.relative_path));
        if(await stat(candidate).catch(()=>null)){const original=await existingWithin(config.DATA_DIR,candidate),staged=within(config.DATA_DIR,`${original}.delete-${randomUUID()}`);await rename(original,staged);moved={original,staged};}
        await sql.query('UPDATE artifacts SET verified=false,deleted_at=now() WHERE id=$1', [id]);
        await sql.query('DELETE FROM library_entries WHERE artifact_id=$1', [id]);
        return { ok: true, freedBytes: artifact.size };
      });
      committed=true;if(moved)await rm(moved.staged,{force:true});return result;
    }catch(error){
      if(!committed&&moved&&!await stat(moved.original).catch(()=>null)&&await stat(moved.staged).catch(()=>null))await rename(moved.staged,moved.original);
      throw error;
    }
  });
  return { enqueue };
}
