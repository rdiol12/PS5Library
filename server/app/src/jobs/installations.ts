import { randomUUID } from 'node:crypto';
import {accessibleSource} from '../sources/access.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid, buildFormats } from '../../../shared/schemas/index.js';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { buildKey,packageBuildAllowed, type preparationRoutes } from './preparation.js';
import type { transferRoutes } from '../transfers/routes.js';
import {backportNotice} from '../library/backports.js';

type Queued = { id?:string; artifactId?:string; cached?:boolean; skipped?:boolean };
export async function installationRoutes(app:FastifyInstance,db:DB,auth:Auth,
  preparation:Awaited<ReturnType<typeof preparationRoutes>>,
  transfer:Awaited<ReturnType<typeof transferRoutes>>,
  download:(userId:string,sourceId:string)=>Promise<Queued>) {
  const selection=z.object({sourceReleaseId:uuid,consoleId:uuid,method:z.enum(['HOMEBREW','FPKG','SHADOWMOUNT']).optional()});
  const plan=async(userId:string,body:z.infer<typeof selection>)=>{
    const source=await accessibleSource(db,userId,body.sourceReleaseId), metadata=source.metadata;
    const consoleInfo=(await db.query('SELECT k.capabilities,u.role FROM consoles c JOIN users u ON u.id=c.user_id LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2',[body.consoleId,userId])).rows[0];
    if(!consoleInfo)throw new AppError('NOT_FOUND',404);
    const build=buildFormats.includes(metadata.format);
    if(metadata.format==='folder'&&!['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type))throw new AppError('UNSUPPORTED_INPUT',422);
    const capabilities=consoleInfo.capabilities??{};
    const methods:string[]=(build?['SHADOWMOUNT','FPKG']:[metadata.format==='elf'?'HOMEBREW':metadata.format==='pkg'?'FPKG':'SHADOWMOUNT']).filter(method=>capabilities[method==='SHADOWMOUNT'?'shadowMount':method==='FPKG'?'fpkgInstall':'homebrew']);
    if(capabilities.nativeDownloads&&methods.includes('FPKG'))methods.sort((a,b)=>Number(b==='FPKG')-Number(a==='FPKG'));
    const method=body.method??methods[0];
    if(!method||!methods.includes(method))return {method:null,methods,sourceReleaseId:source.id,releaseId:source.release_id,sourceSha256:metadata.sha256,estimated:false,
      allowed:false,reason:'UNSUPPORTED_METHOD',message:'This PS5 has not reported a supported installation method for this release. Your server copy is safe. Check My PS5 for runtime and storage support.',
      compatibility:{status:'UNSUPPORTED_METHOD',method:null,profileId:null,backportRequired:null},storage:[],artifactId:null};
    const exactInputHash=metadata.sourceTreeSha256??metadata.sha256,buildInputHash=build&&method==='SHADOWMOUNT'?exactInputHash:metadata.sha256;
    const installedSize=build&&method==='SHADOWMOUNT'?metadata.sourceTreeSize??metadata.installedSize??metadata.size:metadata.installedSize??metadata.size,size=build?Math.ceil(installedSize*1.1)+32*1024**2:metadata.size;
    const result=await transfer.plan(userId,source.release_id,body.consoleId,undefined,{format:build?(method==='FPKG'?'pkg':'ffpkg'):metadata.format,size,sha256:buildInputHash,baseSha256:metadata.sha256,sourceTreeSha256:exactInputHash,...(build?{cacheKey:buildKey(buildInputHash,method as 'FPKG'|'SHADOWMOUNT')}:{})});
    const storageAllowed=result.storage.some(s=>s.allowed),prepared=build?(packageBuildAllowed(consoleInfo.role)||!!result.artifactId):!!result.artifactId||!result.backportRequired;
    return {...result,method,methods,sourceReleaseId:source.id,releaseId:source.release_id,sourceSha256:metadata.sha256,estimated:build&&!result.artifactId,
      allowed:result.compatible&&storageAllowed&&prepared,
      reason:!result.compatible?result.reason:!storageAllowed?'INSUFFICIENT_OR_UNSUPPORTED_STORAGE':!prepared&&build&&!packageBuildAllowed(consoleInfo.role)?'ADMIN_REQUIRED':!prepared?result.reason:'READY_TO_PREPARE'};
  };
  const list=async(userId:string)=>(await db.query('SELECT i.id,i.state,i.error,i.method,i.source_release_id AS "sourceReleaseId",i.console_id AS "consoleId",i.storage_id AS "storageId",i.source_job_id AS "sourceJobId",i.transfer_job_id AS "transferJobId",i.artifact_id AS "artifactId",i.created_at AS "createdAt",g.title FROM installations i JOIN source_releases sr ON sr.id=i.source_release_id JOIN game_releases r ON r.id=sr.release_id JOIN games g ON g.id=r.game_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100',[userId])).rows;
  const reconcileOne=async(row:any)=>{
    try{
      if(row.transfer_job_id){
        const job=(await db.query('SELECT state,error FROM jobs WHERE id=$1',[row.transfer_job_id])).rows[0];
        await db.query("UPDATE installations SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND transfer_job_id=$4 AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[row.id,job.state,job.error,row.transfer_job_id]);
        return;
      }
      if(!row.source_job_id&&!row.artifact_id){
        const source=await accessibleSource(db,row.user_id,row.source_release_id);
        if(source.metadata.sha256!==row.source_sha256)throw new AppError('SOURCE_CHANGED',409);
        const current=await plan(row.user_id,{sourceReleaseId:source.id,consoleId:row.console_id,method:row.method});
        if(!current.allowed)throw new AppError(current.reason,409);
        if((current.compatibility.profileId??null)!==row.profile_id||('backport' in current?current.backport?.profileHash??null:null)!==row.profile_hash)throw new AppError('CONSOLE_CONFIGURATION_CHANGED',409);
        const queued:Queued=buildFormats.includes(source.metadata.format)?await preparation.enqueue(row.user_id,{sourceReleaseId:source.id,method:row.method,...(row.profile_id?{profileId:row.profile_id}:{})}):await download(row.user_id,source.id);
        const changed=await db.query("UPDATE installations SET source_job_id=$2,artifact_id=$3,state='PREPARING',updated_at=now() WHERE id=$1 AND source_job_id IS NULL AND artifact_id IS NULL AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') RETURNING id",[row.id,queued.id??null,queued.artifactId??null]);
        if(!changed.rowCount)return;
        row.source_job_id=queued.id??null;row.artifact_id=queued.artifactId??null;
      }
      if(!row.artifact_id){
        const job=(await db.query('SELECT state,error,artifact_id FROM jobs WHERE id=$1',[row.source_job_id])).rows[0];
        if(['ERROR','CANCELLED'].includes(job.state))throw new AppError(job.error??job.state,409);
        if(job.state!=='COMPLETED')return;
        const changed=await db.query("UPDATE installations SET artifact_id=$2,updated_at=now() WHERE id=$1 AND source_job_id=$3 AND artifact_id IS NULL AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') RETURNING id",[row.id,job.artifact_id,row.source_job_id]);
        if(!changed.rowCount)return;
        row.artifact_id=job.artifact_id;
      }
      const source=await accessibleSource(db,row.user_id,row.source_release_id);
      const actual=await transfer.plan(row.user_id,source.release_id,row.console_id,row.artifact_id);
      if(!actual.online){await db.query("UPDATE installations SET state='WAITING_FOR_PS5',updated_at=now() WHERE id=$1 AND artifact_id=$2 AND transfer_job_id IS NULL AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[row.id,row.artifact_id]);return;}
      if(!actual.allowed)throw new AppError(actual.reason,409);
      if(!actual.storage.find(s=>s.storageId===row.storage_id)?.allowed){await db.query("UPDATE installations SET state='WAITING_FOR_STORAGE',updated_at=now() WHERE id=$1 AND artifact_id=$2 AND transfer_job_id IS NULL AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[row.id,row.artifact_id]);return;}
      const queued=await transfer.enqueue(row.user_id,{artifactId:row.artifact_id,consoleId:row.console_id,storageId:row.storage_id,installationId:row.id});
      await db.query("UPDATE installations SET transfer_job_id=$2,state='QUEUED_FOR_PS5',error=NULL,updated_at=now() WHERE id=$1 AND artifact_id=$3 AND transfer_job_id IS NULL AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')",[row.id,queued.id,row.artifact_id]);
    }catch(error){
      if(!(error instanceof AppError))throw error;
      const changed=await db.query("UPDATE installations SET state='ERROR',error=$2,updated_at=now() WHERE id=$1 AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') RETURNING id",[row.id,error.code]);
      if(changed.rowCount){const source=await accessibleSource(db,row.user_id,row.source_release_id);await backportNotice(db,row.user_id,row.console_id,source.release_id,error.code,row.source_sha256);}
    }
  };
  const reconcile=async()=>{
    const coordinator=await db.connect();let locked=false;
    try{
      // ponytail: one coordinator per database; keep its session lock outside a transaction while nested work runs.
      locked=(await coordinator.query('SELECT pg_try_advisory_lock(3150006) AS locked')).rows[0].locked;
      if(!locked)return;
      const reconciled:string[]=[];
      for(let i=0;i<50;i++){
        const row=await transaction(db,async sql=>(await sql.query("SELECT * FROM installations WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') AND id<>ALL($1::uuid[]) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",[reconciled])).rows[0]);
        if(!row)break;
        reconciled.push(row.id);
        await reconcileOne(row);
      }
    }finally{
      if(locked)try{await coordinator.query('SELECT pg_advisory_unlock(3150006)');}catch(error){coordinator.release(error as Error);throw error;}
      coordinator.release();
    }
  };
  let current:Promise<unknown>|undefined,closed=false;
  const kick=()=>{if(closed||current)return;current=reconcile().catch(error=>console.error('Installation coordinator:',error.code??error.name)).finally(()=>{current=undefined;});};
  for(const device of [false,true]){
    const prefix=`/api/v1/${device?'device/':''}installations`;
    const owner=async(req:Parameters<Auth['user']>[0])=>device?(await auth.device(req)).user_id:(await auth.user(req)).id;
    app.get(prefix,async req=>list(await owner(req)));
    app.delete(`${prefix}/:id`,async req=>{
      const userId=await owner(req),id=uuid.parse((req.params as {id:string}).id);
      const changed=await db.query("UPDATE installations SET state='CANCELLED',error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND transfer_job_id IS NULL AND state NOT IN ('READY_ON_PS5','CANCELLED') RETURNING id",[id,userId]);
      if(changed.rowCount)return {ok:true};
      if(!(await db.query('SELECT id FROM installations WHERE id=$1 AND user_id=$2',[id,userId])).rowCount)throw new AppError('NOT_FOUND',404);
      throw new AppError('INSTALLATION_DELIVERY_STARTED',409);
    });
    app.post(`${prefix}/plan`,async req=>plan(await owner(req),selection.parse(req.body)));
    app.post(prefix,async(req,reply)=>{
      const userId=await owner(req),body=selection.extend({storageId:z.string().min(1).max(64)}).parse(req.body),selected=await plan(userId,body);
      if(!selected.allowed)throw new AppError(selected.reason,409);
      if(!selected.storage.find(s=>s.storageId===body.storageId)?.allowed)throw new AppError('INSUFFICIENT_OR_UNSUPPORTED_STORAGE',409);
      const id=randomUUID();
      const result=await transaction(db,async sql=>{
        if(!(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2',[body.consoleId,userId])).rowCount)throw new AppError('NOT_FOUND',404);
        if((await sql.query("SELECT 1 FROM console_library_entries l JOIN source_releases sr ON sr.release_id=l.release_id WHERE l.console_id=$1 AND sr.id=$2 AND l.state='READY_ON_PS5'",[body.consoleId,body.sourceReleaseId])).rowCount)throw new AppError('ALREADY_INSTALLED',409,'This release is already available on this PS5.');
        return (await sql.query("INSERT INTO installations(id,user_id,source_release_id,console_id,storage_id,method,source_sha256,profile_id,profile_hash,artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,source_release_id,console_id,storage_id,method) WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') DO UPDATE SET artifact_id=COALESCE(installations.artifact_id,EXCLUDED.artifact_id),updated_at=now() RETURNING id",[id,userId,body.sourceReleaseId,body.consoleId,body.storageId,selected.method,selected.sourceSha256,selected.compatibility.profileId,'backport' in selected?selected.backport?.profileHash??null:null,selected.artifactId])).rows[0];
      });
      kick();return reply.code(202).send(result);
    });
  }
  const timer=setInterval(kick,1000);kick();
  app.addHook('onClose',async()=>{closed=true;clearInterval(timer);await current;});
  return {close:async()=>{closed=true;clearInterval(timer);await current;}};
}
