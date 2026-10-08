import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {Auth} from '../auth/routes.js';
import type {Config} from '../config.js';
import {transaction,type DB} from '../db.js';
import {serveStoredFile} from '../downloads/serve.js';
import {presence} from '../library/policy.js';
import {AppError} from '../security/errors.js';
import {fileHandleHash,regularFile,sameFile,within} from '../security/paths.js';
import {bytes,localUserId,saveDirectory,savePlatform,sha256,titleId,uploadChunk,uuid} from '../../../shared/schemas/index.js';
import {quotaExceeded,requireDiskSpace,storageUsage} from '../storage/usage.js';
import {consoleSaveData} from './save-data.js';
import {appendUpload,resumeUpload} from '../storage/upload.js';

const slot=z.object({localUserId,platform:savePlatform,gameTitleId:titleId,saveTitleId:titleId,directory:saveDirectory}).strict();
const archivePath=z.string().min(1).max(180).regex(/^[A-Za-z0-9._/-]+$/).refine(value=>!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'));
const manifest=z.object({format:z.literal('RAW_CONSOLE_V1'),localUserId,platform:savePlatform,gameTitleId:titleId,saveTitleId:titleId,directory:saveDirectory,files:z.array(z.object({path:archivePath,size:bytes.min(1),sha256}).strict()).min(1).max(32)}).strict().refine(value=>new Set(value.files.map(file=>file.path)).size===value.files.length,'Duplicate archive path');
const start=z.object({totalBytes:bytes.min(1),sha256,manifest}).strict();
const failure=z.object({error:z.enum(['SAVE_SOURCE_UNAVAILABLE','SAVE_SOURCE_CHANGED','INSUFFICIENT_SPACE','SAVE_BACKUP_FAILED'])}).strict();
const part=(config:Config,id:string)=>path.join(config.DATA_DIR,'save-backups','.staging',`${id}.part`);
const finalRelative=(userId:string,id:string,digest:string)=>path.join('save-backups',userId,`${id}-${digest}.ps5save`);
const view=(row:any)=>({
  id:row.id,consoleId:row.console_id,localUserId:row.local_user_id,platform:row.platform,gameTitleId:row.game_title_id,saveTitleId:row.save_title_id,directory:row.directory,
  sourceModifiedAt:row.source_modified_at,format:row.format,state:row.state,totalBytes:row.total_bytes,uploadedBytes:row.uploaded_bytes,sha256:row.sha256,manifest:row.manifest,
  error:row.error,createdAt:row.created_at,updatedAt:row.updated_at,downloadUrl:row.state==='READY'?`/api/v1/save-backups/${row.id}/download`:null,
});

export async function saveBackupRoutes(app:FastifyInstance,db:DB,config:Config,auth:Auth){
  app.post('/api/v1/consoles/:id/saves/backups',async(req,reply)=>{
    const user=await auth.user(req),consoleId=uuid.parse((req.params as {id:string}).id),body=slot.parse(req.body);
    const source=await consoleSaveData(db,user.id,consoleId,body.localUserId,body.platform,body.gameTitleId,body.saveTitleId,body.directory);
    if(!source)throw new AppError('NOT_FOUND',404);
    if(source.capabilities.saveBackup!==true)throw new AppError('CAPABILITY_UNAVAILABLE',409,'This agent has not reported encrypted save-backup support.');
    if(presence(source.last_seen?new Date(source.last_seen).getTime():null)!=='ONLINE')throw new AppError('CONSOLE_OFFLINE',409);
    const id=randomUUID();
    await db.query(`INSERT INTO save_backups(id,user_id,console_id,local_user_id,platform,game_title_id,save_title_id,directory,source_modified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,user.id,consoleId,source.local_user_id,source.platform,source.game_title_id,source.save_title_id,source.directory,source.modified_at]);
    return reply.code(202).send({id,state:'REQUESTED'});
  });
  app.get('/api/v1/save-backups',async req=>(await db.query('SELECT * FROM save_backups WHERE user_id=$1 ORDER BY created_at DESC',[(await auth.user(req)).id])).rows.map(view));
  app.get('/api/v1/device/save-backups',async req=>{
    const device=await auth.device(req),row=(await db.query("SELECT * FROM save_backups WHERE console_id=$1 AND state IN ('REQUESTED','UPLOADING','VERIFYING') ORDER BY created_at LIMIT 1",[device.id])).rows[0];
    return row?view(row):null;
  });
  app.post('/api/v1/device/save-backups/:id/start',async req=>{
    const device=await auth.device(req),id=uuid.parse((req.params as {id:string}).id),body=start.parse(req.body);
    return transaction(db,async sql=>{
      const row=(await sql.query("SELECT * FROM save_backups WHERE id=$1 AND console_id=$2 AND state IN ('REQUESTED','UPLOADING') FOR UPDATE",[id,device.id])).rows[0];
      if(!row)throw new AppError('NOT_FOUND',404);
      if(body.manifest.localUserId!==row.local_user_id||body.manifest.platform!==row.platform||body.manifest.gameTitleId!==row.game_title_id||body.manifest.saveTitleId!==row.save_title_id||body.manifest.directory!==row.directory)throw new AppError('METADATA_MISMATCH',409);
      if(row.total_bytes!==null){const same=(await sql.query('SELECT $1::jsonb=$2::jsonb AS value',[row.manifest,body.manifest])).rows[0].value;if(row.total_bytes!==body.totalBytes||row.sha256!==body.sha256||!same)throw new AppError('METADATA_MISMATCH',409);}
      if(row.total_bytes===null){
        const used=await storageUsage(sql,{saveBackupId:id});
        if(quotaExceeded(used,body.totalBytes,config.QUOTA_BYTES))throw new AppError('QUOTA_EXCEEDED',409);
        await requireDiskSpace(config.DATA_DIR,body.totalBytes+config.DISK_MARGIN_BYTES);
      }
      const uploaded=await resumeUpload(part(config,id),body.totalBytes);
      await sql.query("UPDATE save_backups SET state='UPLOADING',total_bytes=$2,uploaded_bytes=$3,sha256=$4,manifest=$5,error=NULL,updated_at=now() WHERE id=$1",[id,body.totalBytes,uploaded,body.sha256,body.manifest]);
      return {uploadedBytes:uploaded};
    });
  });
  app.post('/api/v1/device/save-backups/:id/chunks',async req=>{
    const device=await auth.device(req),id=uuid.parse((req.params as {id:string}).id),body=uploadChunk.parse(req.body);
    return transaction(db,async sql=>{
      const row=(await sql.query("SELECT * FROM save_backups WHERE id=$1 AND console_id=$2 AND state='UPLOADING' FOR UPDATE",[id,device.id])).rows[0];if(!row)throw new AppError('NOT_FOUND',404);
      const uploaded=await appendUpload(part(config,id),body.offset,body.data,row.total_bytes);await sql.query('UPDATE save_backups SET uploaded_bytes=$2,updated_at=now() WHERE id=$1',[id,uploaded]);return {uploadedBytes:uploaded};
    });
  });
  app.post('/api/v1/device/save-backups/:id/complete',async req=>{
    const device=await auth.device(req),id=uuid.parse((req.params as {id:string}).id);
    const row=await transaction(db,async sql=>{const found=(await sql.query("SELECT * FROM save_backups WHERE id=$1 AND console_id=$2 AND state IN ('UPLOADING','VERIFYING') FOR UPDATE",[id,device.id])).rows[0];if(!found)throw new AppError('NOT_FOUND',404);if(found.uploaded_bytes!==found.total_bytes)throw new AppError('INCOMPLETE_INPUT',409);await sql.query("UPDATE save_backups SET state='VERIFYING',updated_at=now() WHERE id=$1",[id]);return found;});
    const relative=finalRelative(row.user_id,id,row.sha256),destination=within(config.DATA_DIR,path.join(config.DATA_DIR,relative)),staging=part(config,id);
    const source=(await lstat(staging).catch(()=>null))?.isFile()?staging:destination;let checked;
    try{checked=await regularFile(source,'r');if(checked.info.size!==row.total_bytes||await fileHandleHash(checked.handle)!==row.sha256)throw new AppError('CORRUPT_INPUT',409);const current=await lstat(source);if(!sameFile(current,checked.info))throw new AppError('CORRUPT_INPUT',409);}catch{await rm(staging,{force:true});await db.query("UPDATE save_backups SET state='ERROR',error='CORRUPT_INPUT',updated_at=now() WHERE id=$1",[id]);throw new AppError('CORRUPT_INPUT',409);}finally{await checked?.handle.close();}
    if(source===staging){await mkdir(path.dirname(destination),{recursive:true});await rename(staging,destination);}
    await db.query("UPDATE save_backups SET state='READY',relative_path=$2,error=NULL,updated_at=now() WHERE id=$1",[id,relative]);return {ok:true};
  });
  app.post('/api/v1/device/save-backups/:id/error',async req=>{
    const device=await auth.device(req),id=uuid.parse((req.params as {id:string}).id),body=failure.parse(req.body);
    if(!(await db.query("UPDATE save_backups SET state='ERROR',error=$3,updated_at=now() WHERE id=$1 AND console_id=$2 AND state IN ('REQUESTED','UPLOADING','VERIFYING')",[id,device.id,body.error])).rowCount)throw new AppError('NOT_FOUND',404);
    await rm(part(config,id),{force:true});return {ok:true};
  });
  app.get('/api/v1/save-backups/:id/download',async(req,reply)=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id),row=(await db.query("SELECT * FROM save_backups WHERE id=$1 AND user_id=$2 AND state='READY'",[id,user.id])).rows[0];if(!row)throw new AppError('NOT_FOUND',404);
    return serveStoredFile(req,reply,within(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path)),row.total_bytes,row.sha256,'application/vnd.ps5library.save');
  });
  app.delete('/api/v1/save-backups/:id',async req=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id),row=(await db.query("UPDATE save_backups SET state='CANCELLED',updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING relative_path",[id,user.id])).rows[0];if(!row)throw new AppError('NOT_FOUND',404);
    await rm(part(config,id),{force:true});if(row.relative_path)await rm(within(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path)),{force:true});await db.query('DELETE FROM save_backups WHERE id=$1 AND user_id=$2',[id,user.id]);return {ok:true};
  });
}
