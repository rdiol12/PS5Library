import type {FastifyInstance} from 'fastify';
import {transaction,type DB} from '../db.js';
import type {Config} from '../config.js';
import type {Auth} from '../auth/routes.js';
import {uuid} from '../../../shared/schemas/index.js';
import {hash,secret,seal,unseal,sameSecret} from '../auth/credentials.js';
import {AppError} from '../security/errors.js';
import {serveFile} from '../downloads/serve.js';
import {existingWithin,regularFile} from '../security/paths.js';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {jobEvent} from '../jobs/events.js';
import sharp from 'sharp';
const iconToken=(jobId:string,downloadToken:string)=>hash(`native-icon\0${jobId}\0${downloadToken}`);
type SentRange=readonly [start:number,end:number];
const addRange=(ranges:SentRange[],start:number,end:number)=>{
  let index=0;
  while(index<ranges.length&&ranges[index]![1]<start)index++;
  while(index<ranges.length&&ranges[index]![0]<=end){const range=ranges[index]!;start=Math.min(start,range[0]);end=Math.max(end,range[1]);ranges.splice(index,1);}
  ranges.splice(index,0,[start,end]);
};
export function coalesceNativeProgress(write:(jobId:string,ranges:SentRange[])=>Promise<void>,failed:(error:unknown)=>void=console.error){
  const queued=new Map<string,SentRange[]>(),active=new Map<string,Promise<void>>();
  const enqueue=(jobId:string,ranges:SentRange[])=>{let pending=queued.get(jobId);if(!pending){pending=[];queued.set(jobId,pending);}for(const range of ranges)addRange(pending,range[0],range[1]);};
  const drain=(jobId:string)=>{
    const task=(async()=>{
      let failures=0;
      while(queued.has(jobId)&&failures<3){
        const ranges=queued.get(jobId)!;queued.delete(jobId);
        try{await write(jobId,ranges);failures=0;}catch(error){failed(error);enqueue(jobId,ranges);failures++;}
      }
    })().finally(()=>active.delete(jobId));
    active.set(jobId,task);
  };
  return {
    sent(jobId:string,start:number,end:number){enqueue(jobId,[[start,end]]);if(!active.has(jobId))drain(jobId);},
    close:async()=>{while(active.size)await Promise.allSettled([...active.values()]);}
  };
}
export async function nativeDownloadRoutes(app:FastifyInstance,db:DB,config:Config,auth:Auth){
  // The system service has no access to our Authorization header. Grant only this artifact/job.
  app.post('/api/v1/device/tasks/:id/native-download',async req=>{
    const c=await auth.device(req),id=uuid.parse((req.params as {id:string}).id);
    const job=(await db.query("SELECT j.id,EXISTS(SELECT 1 FROM game_releases icon_release JOIN artwork art ON art.game_id=icon_release.game_id AND art.kind IN ('icon','cover') WHERE icon_release.id=j.release_id) AS has_icon FROM jobs j JOIN artifacts a ON a.id=j.artifact_id JOIN game_releases r ON r.id=j.release_id WHERE j.id=$1 AND j.console_id=$2 AND j.kind='TRANSFER' AND j.config->>'method'='FPKG' AND a.format='pkg' AND a.verified AND j.desired_state='RUNNING' AND j.state IN ('QUEUED_FOR_PS5','TRANSFERRING') AND (j.config->>'firmware') IS NOT DISTINCT FROM $3 AND j.config->>'runtime'=$4 AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=$5)",[id,c.id,c.firmware,c.runtime,c.user_id])).rows[0];
    if(!job)throw new AppError('NOT_FOUND',404);
    const issuedToken=secret();
    const grant=(await db.query("INSERT INTO native_download_grants(job_id,token_hash,token_cipher,expires_at) VALUES($1,$2,$3,now()+interval '30 days') ON CONFLICT(job_id) DO UPDATE SET token_hash=excluded.token_hash,token_cipher=excluded.token_cipher,expires_at=excluded.expires_at RETURNING token_cipher",[id,hash(issuedToken),seal(issuedToken,config.BOOTSTRAP_TOKEN)])).rows[0];
    const downloadToken=unseal(grant.token_cipher,config.BOOTSTRAP_TOKEN);
    const artworkToken=iconToken(id,downloadToken);
    return {url:`/api/v1/native-downloads/${id}/${downloadToken}/game.pkg`,...(job.has_icon?{iconUrl:`/api/v1/native-downloads/${id}/${artworkToken}/icon.png`}:{})};
  });
  const progress=coalesceNativeProgress(async(id,ranges)=>{
    await transaction(db,async sql=>{
      const job=(await sql.query("SELECT downloaded_bytes,total_bytes,speed_bytes_per_second,extract(epoch FROM clock_timestamp()-updated_at) AS elapsed FROM jobs WHERE id=$1 AND desired_state='RUNNING' AND state IN ('QUEUED_FOR_PS5','TRANSFERRING') FOR UPDATE",[id])).rows[0];
      if(!job)return;
      await sql.query("UPDATE native_download_grants SET coverage=coverage+(SELECT range_agg(int8range(start_byte,end_byte,'[)')) FROM unnest($2::bigint[],$3::bigint[]) sent(start_byte,end_byte)) WHERE job_id=$1",[id,ranges.map(range=>range[0]),ranges.map(range=>range[1])]);
      const covered=(await sql.query('SELECT COALESCE(sum(upper(r)-lower(r)),0)::bigint AS bytes FROM native_download_grants n CROSS JOIN LATERAL unnest(n.coverage) r WHERE n.job_id=$1',[id])).rows[0].bytes;
      const downloaded=Math.max(job.downloaded_bytes,covered),elapsed=Number(job.elapsed);
      const speed=downloaded>job.downloaded_bytes&&elapsed>0?Math.floor((downloaded-job.downloaded_bytes)/elapsed):job.speed_bytes_per_second;
      const eta=speed>0?Math.ceil(Math.max(0,job.total_bytes-downloaded)/speed):null;
      await sql.query(`UPDATE jobs SET state='TRANSFERRING',downloaded_bytes=$2,speed_bytes_per_second=$3,eta_seconds=$4,config=jsonb_set(config,'{progress}','{"stage":"Native PS5 download","source":"HTTP_BYTES_SENT"}'),updated_at=now() WHERE id=$1`,[id,downloaded,speed,eta]);
      await jobEvent(sql,id);
    });
  },error=>{const value=error as {code?:string;name?:string};console.error('Native download progress:',value.code??value.name);});
  app.get('/api/v1/native-downloads/:id/:token/game.pkg',async(req,reply)=>{
    const {id,token}=req.params as {id:string;token:string};
    if(!uuid.safeParse(id).success||!/^[a-f0-9]{64}$/.test(token))throw new AppError('NOT_FOUND',404);
    const a=(await db.query(`SELECT a.*,j.id AS job_id FROM native_download_grants n JOIN jobs j ON j.id=n.job_id JOIN artifacts a ON a.id=j.artifact_id JOIN consoles c ON c.id=j.console_id JOIN game_releases r ON r.id=j.release_id
      WHERE n.job_id=$1 AND n.token_hash=$2 AND n.expires_at>now() AND a.verified AND a.deleted_at IS NULL AND j.desired_state='RUNNING' AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')
      AND (j.config->>'firmware') IS NOT DISTINCT FROM c.firmware AND j.config->>'runtime'=c.runtime
      AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=c.user_id)
      AND EXISTS(SELECT 1 FROM console_credentials cred WHERE cred.console_id=c.id AND cred.kind='AGENT' AND cred.revoked_at IS NULL)`,[id,hash(token)])).rows[0];
    if(!a)throw new AppError('NOT_FOUND',404);
    const file=await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,a.relative_path));
    if((await stat(file)).size!==a.size)throw new AppError('ARTIFACT_MISSING_OR_CHANGED',409);
    return serveFile(req,reply,file,a.size,a.sha256,'application/octet-stream',(start,end)=>progress.sent(id,start,end));
  });
  app.get('/api/v1/native-downloads/:id/:token/icon.png',async(req,reply)=>{
    const {id,token}=req.params as {id:string;token:string};
    if(!uuid.safeParse(id).success||!/^[a-f0-9]{64}$/.test(token))throw new AppError('NOT_FOUND',404);
    const art=(await db.query(`SELECT n.token_cipher,art.relative_path,art.size FROM native_download_grants n JOIN jobs j ON j.id=n.job_id JOIN game_releases r ON r.id=j.release_id JOIN consoles c ON c.id=j.console_id
      JOIN LATERAL (SELECT relative_path,size FROM artwork WHERE game_id=r.game_id AND kind IN ('icon','cover') ORDER BY (kind='icon') DESC LIMIT 1) art ON true
      WHERE n.job_id=$1 AND n.expires_at>now() AND j.desired_state='RUNNING' AND j.state NOT IN ('READY_ON_PS5','ERROR','CANCELLED')
      AND (j.config->>'firmware') IS NOT DISTINCT FROM c.firmware AND j.config->>'runtime'=c.runtime
      AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=c.user_id)
      AND EXISTS(SELECT 1 FROM console_credentials cred WHERE cred.console_id=c.id AND cred.kind='AGENT' AND cred.revoked_at IS NULL)`,[id])).rows[0];
    if(!art||!sameSecret(token,iconToken(id,unseal(art.token_cipher,config.BOOTSTRAP_TOKEN))))throw new AppError('NOT_FOUND',404);
    const size=Number(art.size);if(!Number.isSafeInteger(size)||size<1||size>16*1024**2)throw new AppError('NOT_FOUND',404);
    let checked;try{checked=await regularFile(await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,art.relative_path)),'r');if(checked.info.size!==size)throw new Error('changed');
      const png=await sharp(await checked.handle.readFile(),{limitInputPixels:16_000_000,animated:false,failOn:'warning'}).resize(256,256,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
      return reply.type('image/png').header('cache-control','private, no-store').send(png);
    }catch{throw new AppError('NOT_FOUND',404);}finally{await checked?.handle.close();}
  });
  return {close:progress.close};
}
