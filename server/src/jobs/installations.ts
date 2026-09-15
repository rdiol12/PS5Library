import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid } from '../../../shared/schemas/index.js';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { buildKey, type preparationRoutes } from './preparation.js';
import type { transferRoutes } from '../transfers/routes.js';

type Queued = { id?:string; artifactId?:string; cached?:boolean };
export async function installationRoutes(app:FastifyInstance,db:DB,auth:Auth,
  preparation:Awaited<ReturnType<typeof preparationRoutes>>,
  transfer:Awaited<ReturnType<typeof transferRoutes>>,
  download:(userId:string,sourceId:string)=>Promise<Queued>) {
  const selection=z.object({sourceReleaseId:uuid,consoleId:uuid,method:z.enum(['HOMEBREW','FPKG','SHADOWMOUNT']).optional()});
  const sourceFor=async(userId:string,id:string)=>{
    const source=(await db.query('SELECT sr.*,s.type FROM source_releases sr JOIN sources s ON s.id=sr.source_id WHERE sr.id=$1 AND s.user_id=$2',[id,userId])).rows[0];
    if(!source)throw new AppError('NOT_FOUND',404);return source;
  };
  const plan=async(userId:string,body:z.infer<typeof selection>)=>{
    const source=await sourceFor(userId,body.sourceReleaseId), metadata=source.metadata;
    const consoleInfo=(await db.query('SELECT k.capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2',[body.consoleId,userId])).rows[0];
    if(!consoleInfo)throw new AppError('NOT_FOUND',404);
    const build=['folder','zip'].includes(metadata.format);
    if(metadata.format==='folder'&&source.type!=='LOCAL_FOLDER')throw new AppError('UNSUPPORTED_INPUT',422);
    const methods:string[]=build?[...(consoleInfo.capabilities?.shadowMount?['SHADOWMOUNT']:[]),...(consoleInfo.capabilities?.fpkgInstall?['FPKG']:[])]:[metadata.format==='elf'?'HOMEBREW':metadata.format==='pkg'?'FPKG':'SHADOWMOUNT'];
    const method=body.method??methods[0];
    if(!method||!methods.includes(method))throw new AppError('UNSUPPORTED_METHOD',409);
    const size=build?Math.ceil((metadata.installedSize??metadata.size)*1.1)+32*1024**2:metadata.size;
    const result=await transfer.plan(userId,source.release_id,body.consoleId,undefined,{format:build?(method==='FPKG'?'pkg':'ffpkg'):metadata.format,size,sha256:metadata.sha256,...(build?{cacheKey:buildKey(metadata.sha256,method as 'FPKG'|'SHADOWMOUNT')}:{})});
    return {...result,method,methods,sourceReleaseId:source.id,releaseId:source.release_id,sourceSha256:metadata.sha256,estimated:build&&!result.artifactId,
      allowed:result.compatibility.status==='NATIVE_COMPATIBLE'&&result.storage.some(s=>s.allowed),
      reason:result.compatibility.status==='NATIVE_COMPATIBLE'?'READY_TO_PREPARE':result.reason==='PREPARE_ON_SERVER_FIRST'?result.compatibility.status:result.reason};
  };
  const list=async(userId:string)=>(await db.query('SELECT i.id,i.state,i.error,i.method,i.source_release_id AS "sourceReleaseId",i.console_id AS "consoleId",i.storage_id AS "storageId",i.source_job_id AS "sourceJobId",i.transfer_job_id AS "transferJobId",i.artifact_id AS "artifactId",i.created_at AS "createdAt",g.title FROM installations i JOIN source_releases sr ON sr.id=i.source_release_id JOIN game_releases r ON r.id=sr.release_id JOIN games g ON g.id=r.game_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100',[userId])).rows;
  const reconcile=async()=>transaction(db,async sql=>{
    // ponytail: one coordinator per database; workers perform the expensive builds outside this transaction.
    if(!(await sql.query('SELECT pg_try_advisory_xact_lock(3150006) AS locked')).rows[0].locked)return;
    const rows=(await sql.query("SELECT * FROM installations WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED")).rows;
    for(const row of rows){
      try{
        if(row.transfer_job_id){const job=(await sql.query('SELECT state,error FROM jobs WHERE id=$1',[row.transfer_job_id])).rows[0];await sql.query('UPDATE installations SET state=$2,error=$3,updated_at=now() WHERE id=$1',[row.id,job.state,job.error]);continue;}
        if(!row.source_job_id&&!row.artifact_id){
          const source=await sourceFor(row.user_id,row.source_release_id);
          if(source.metadata.sha256!==row.source_sha256)throw new AppError('SOURCE_CHANGED',409);
          const queued:Queued=['folder','zip'].includes(source.metadata.format)?await preparation.enqueue(row.user_id,{sourceReleaseId:source.id,method:row.method}):await download(row.user_id,source.id);
          row.source_job_id=queued.id??null;row.artifact_id=queued.artifactId??null;
          await sql.query("UPDATE installations SET source_job_id=$2,artifact_id=$3,state='PREPARING',updated_at=now() WHERE id=$1",[row.id,row.source_job_id,row.artifact_id]);
        }
        if(!row.artifact_id){
          const job=(await sql.query('SELECT state,error,artifact_id FROM jobs WHERE id=$1',[row.source_job_id])).rows[0];
          if(['ERROR','CANCELLED'].includes(job.state))throw new AppError(job.error??job.state,409);
          if(job.state!=='COMPLETED')continue;
          row.artifact_id=job.artifact_id;await sql.query('UPDATE installations SET artifact_id=$2 WHERE id=$1',[row.id,row.artifact_id]);
        }
        const source=await sourceFor(row.user_id,row.source_release_id);
        const actual=await transfer.plan(row.user_id,source.release_id,row.console_id,row.artifact_id);
        if(!actual.online){await sql.query("UPDATE installations SET state='WAITING_FOR_PS5',updated_at=now() WHERE id=$1",[row.id]);continue;}
        if(!actual.allowed)throw new AppError(actual.reason,409);
        if(!actual.storage.find(s=>s.storageId===row.storage_id)?.allowed){await sql.query("UPDATE installations SET state='WAITING_FOR_STORAGE',updated_at=now() WHERE id=$1",[row.id]);continue;}
        const queued=await transfer.enqueue(row.user_id,{artifactId:row.artifact_id,consoleId:row.console_id,storageId:row.storage_id,installationId:row.id});
        await sql.query("UPDATE installations SET transfer_job_id=$2,state='QUEUED_FOR_PS5',error=NULL,updated_at=now() WHERE id=$1",[row.id,queued.id]);
      }catch(error){if(!(error instanceof AppError))throw error;await sql.query("UPDATE installations SET state='ERROR',error=$2,updated_at=now() WHERE id=$1",[row.id,error.code]);}
    }
  });
  let current:Promise<unknown>|undefined,closed=false;
  const kick=()=>{if(closed||current)return;current=reconcile().catch(error=>console.error('Installation coordinator:',error.code??error.name)).finally(()=>{current=undefined;});};
  for(const device of [false,true]){
    const prefix=`/api/v1/${device?'device/':''}installations`;
    const owner=async(req:Parameters<Auth['user']>[0])=>device?(await auth.device(req)).user_id:(await auth.user(req)).id;
    app.get(prefix,async req=>list(await owner(req)));
    app.post(`${prefix}/plan`,async req=>plan(await owner(req),selection.parse(req.body)));
    app.post(prefix,async(req,reply)=>{
      const userId=await owner(req),body=selection.extend({storageId:z.string().min(1).max(64)}).parse(req.body),selected=await plan(userId,body);
      if(!selected.allowed)throw new AppError(selected.reason,409);
      if(!selected.storage.find(s=>s.storageId===body.storageId)?.allowed)throw new AppError('INSUFFICIENT_OR_UNSUPPORTED_STORAGE',409);
      const id=randomUUID();
      const result=(await db.query("INSERT INTO installations(id,user_id,source_release_id,console_id,storage_id,method,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,source_release_id,console_id,storage_id,method) WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED') DO UPDATE SET updated_at=now() RETURNING id",[id,userId,body.sourceReleaseId,body.consoleId,body.storageId,selected.method,selected.sourceSha256])).rows[0];
      kick();return reply.code(202).send(result);
    });
  }
  const timer=setInterval(kick,1000);kick();
  app.addHook('onClose',async()=>{closed=true;clearInterval(timer);await current;});
  return {close:async()=>{closed=true;clearInterval(timer);await current;}};
}
