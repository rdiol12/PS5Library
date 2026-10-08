import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { AppError } from '../security/errors.js';
import { uuid } from '../../../shared/schemas/index.js';
import { fileHash } from '../downloads/stream.js';
import { serveFile } from '../downloads/serve.js';
import {runSandboxTool} from '../library/inspect.js';
import {quotaExceeded,requireDiskSpace,storageUsage} from '../storage/usage.js';
import {gameStorageFolder} from '../storage/names.js';
import {within} from '../security/paths.js';

const inputLimit=512*1024**2, outputLimit=128*1024**2, execute=promisify(execFile);
export const mediaDirectory=(config:Config,row:{id:string;relative_path?:string|null})=>within(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path??path.posix.join('trailers',uuid.parse(row.id))));
const mediaFile=(config:Config,row:{id:string;relative_path?:string|null;kind:string})=>path.join(mediaDirectory(config,row),row.kind==='music'?'Music.mp4':'Trailer.mp4');
export const musicFormats:Record<string,string>={'.at9':'wav','.wav':'wav','.ogg':'ogg','.mp3':'mp3','.flac':'flac','.m4a':'mov'};
const musicTypes:Record<string,string>={'audio/wav':'wav','audio/ogg':'ogg','audio/mpeg':'mp3','audio/flac':'flac','audio/mp4':'mov'};

export async function prepareTrailer(db:DB,config:Config,id:string) {
  const row=(await db.query("UPDATE game_media SET state='PREPARING',updated_at=now() WHERE id=$1 AND state IN ('QUEUED','PREPARING') RETURNING *",[id])).rows[0];
  if(!row)return;
  const music=row.kind==='music',maximum=music?8*1024**2:outputLimit;
  const root=mediaDirectory(config,row),container=`ps5library-trailer-${id}`;
  const run=async(command:'ffmpeg'|'ffprobe',args:string[])=>config.TRAILER_WORKER_MODE==='SANDBOX'
    ?runSandboxTool(command,args.map(arg=>arg==='/input.mp4'?path.join(root,'input.mp4'):arg==='/output/trailer.part.mp4'?path.join(root,'output','trailer.part.mp4'):arg))
    :config.TRAILER_WORKER_MODE==='LOCAL'
    ?execute(command,args.map(arg=>arg==='/input.mp4'?path.join(root,'input.mp4'):arg==='/output/trailer.part.mp4'?path.join(root,'output','trailer.part.mp4'):arg),{windowsHide:true,timeout:300000,maxBuffer:1024*1024})
    :execute('docker',['run','--rm','--name',container,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','2','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','-v',`${path.join(root,'input.mp4')}:/input.mp4:ro`,'-v',`${path.join(root,'output')}:/output`,config.TRAILER_WORKER_IMAGE,command,...args],{windowsHide:true,timeout:300000,maxBuffer:1024*1024});
  try {
    await mkdir(path.join(root,'output'),{recursive:true});
    const videoArgs=music?['-map','0:a:0','-vn']:['-map','0:v:0','-map','0:a:0?','-vf','scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,fps=30','-c:v','libx264','-threads','2','-preset','veryfast','-crf','24','-maxrate','2M','-bufsize','4M','-pix_fmt','yuv420p'];
    await run('ffmpeg',['-v','error','-nostdin','-protocol_whitelist','file','-f',row.input_format,'-i','/input.mp4',...videoArgs,'-t','180','-map_metadata','-1','-c:a','aac','-b:a','128k','-ac','2','-ar','48000','-movflags','+faststart','-fs',String(maximum),'-y','/output/trailer.part.mp4']);
    const probe=JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file','-f','mov','-show_streams','-show_format','-of','json','/output/trailer.part.mp4'])).stdout);
    const video=probe.streams.find((s:any)=>s.codec_type==='video'),audio=probe.streams.find((s:any)=>s.codec_type==='audio'),duration=Number(probe.format.duration),file=path.join(root,'output','trailer.part.mp4'),size=(await stat(file)).size;
    if((music?video||!audio:!video||video.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||video.width>1280||video.height>720)||!(duration>0&&duration<=180.1)||size>=maximum||(audio&&(audio.codec_name!=='aac'||audio.channels!==2||audio.sample_rate!=='48000')))throw new Error('Invalid normalized media');
    const sha256=await fileHash(file);await rename(file,mediaFile(config,row));await rm(path.join(root,'output'),{recursive:true,force:true});
    await rm(path.join(root,'input.mp4'),{force:true});
    await db.query("UPDATE game_media SET state='READY',size=$2,sha256=$3,duration=$4,reserved_bytes=$2,error=NULL,updated_at=now() WHERE id=$1",[id,size,sha256,duration]);
  } catch {
    // Only this job's named container and UUID directory are ever removed.
    if(config.TRAILER_WORKER_MODE==='DOCKER')await execute('docker',['rm','-f',container],{windowsHide:true,timeout:15000}).catch(()=>{});
    await rm(root,{recursive:true,force:true});
    await db.query("UPDATE game_media SET state='ERROR',reserved_bytes=0,error='TRAILER_PREPARATION_FAILED',updated_at=now() WHERE id=$1",[id]);
  }
}

export async function storeTrailer(db:DB,config:Config,gameId:string,input:Readable|(()=>Readable),expected:number,automatic?:{sourceReleaseId:string;sha256:string},kind:'trailer'|'music'='trailer',inputFormat='mov') {
    const id=randomUUID();
    const maximum=kind==='music'?8*1024**2:outputLimit;
    if(!Number.isSafeInteger(expected)||expected<=0||expected>(kind==='music'?32*1024**2:inputLimit))throw new AppError('MEDIA_SIZE_LIMIT',413);
    if(!['mov','wav','ogg','mp3','flac'].includes(inputFormat))throw new AppError('UNSUPPORTED_MEDIA',415);
    const relativePath=await transaction(db,async sql=>{
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      if(automatic && !(await sql.query("INSERT INTO automatic_preparations(source_release_id,input_hash,method) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_release_id",[automatic.sourceReleaseId,automatic.sha256,kind.toUpperCase()])).rowCount)return false;
      const old=(await sql.query('SELECT state FROM game_media WHERE game_id=$1 AND kind=$2',[gameId,kind])).rows[0];
      if(old&&old.state!=='ERROR'&&automatic)return false;
      if(old&&old.state!=='ERROR')throw new AppError('TRAILER_ALREADY_EXISTS',409);
      if(quotaExceeded(await storageUsage(sql),expected+maximum,config.QUOTA_BYTES))throw new AppError('QUOTA_EXCEEDED',409);
      await requireDiskSpace(config.DATA_DIR,expected+maximum+config.DISK_MARGIN_BYTES);
      const game=(await sql.query('SELECT title,title_id FROM games WHERE id=$1',[gameId])).rows[0];if(!game)throw new AppError('NOT_FOUND',404);
      const relative=path.posix.join('trailers',gameStorageFolder(game),`${kind==='music'?'Music':'Trailer'} [${id.slice(0,8)}]`);
      await sql.query('DELETE FROM game_media WHERE game_id=$1 AND kind=$2',[gameId,kind]);
      await sql.query("INSERT INTO game_media(id,game_id,state,reserved_bytes,kind,input_format,relative_path) VALUES($1,$2,'UPLOADING',$3,$4,$5,$6)",[id,gameId,expected+maximum,kind,inputFormat,relative]);return relative;
    });
    if(!relativePath){if(typeof input!=='function')input.destroy();return {skipped:true};}
    const row={id,kind,relative_path:relativePath},root=mediaDirectory(config,row);
    try {
      await mkdir(root,{recursive:true});let bytes=0;
      const limit=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>expected?new AppError('TRAILER_SIZE_LIMIT',413):null,chunk);}});
      await pipeline(typeof input==='function'?input():input,limit,createWriteStream(path.join(root,'upload.part'),{flags:'wx'}),{signal:AbortSignal.timeout(10*60*1000)});
      if(bytes!==expected)throw new AppError('INCOMPLETE_INPUT');
      if(automatic && await fileHash(path.join(root,'upload.part'))!==automatic.sha256)throw new AppError('SOURCE_CHANGED',409);
      await rename(path.join(root,'upload.part'),path.join(root,'input.mp4'));
      await db.query("UPDATE game_media SET state='QUEUED',updated_at=now() WHERE id=$1",[id]);
    } catch(error) {
      await rm(root,{recursive:true,force:true});await db.query("UPDATE game_media SET state='ERROR',reserved_bytes=0,error='UPLOAD_FAILED',updated_at=now() WHERE id=$1",[id]);throw error;
    }
    return {id,state:'QUEUED'};
}

export async function trailerRoutes(app:FastifyInstance,db:DB,config:Config,auth:Auth,reconcile:()=>Promise<void>) {
  app.addContentTypeParser(['video/mp4',...Object.keys(musicTypes)],(_req,payload,done)=>done(null,payload));
  const owned=async(userId:string,id:string)=>{
    if(!(await db.query('SELECT id FROM games WHERE id=$1 AND user_id=$2',[id,userId])).rowCount)throw new AppError('NOT_FOUND',404);
  };
  for(const kind of ['trailer','music'] as const){
  app.put(`/api/v1/games/:id/${kind}`,{onRequest:async req=>{await owned((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id));}},async(req,reply)=>{
    const type=req.headers['content-type']?.split(';')[0]??'',format=kind==='music'?musicTypes[type]:type==='video/mp4'?'mov':undefined;
    if(!format)throw new AppError('UNSUPPORTED_MEDIA',415);
    const result=await storeTrailer(db,config,uuid.parse((req.params as {id:string}).id),req.body as Readable,Number(req.headers['content-length']),undefined,kind,format);
    await reconcile();return reply.code(202).send(result);
  });
  app.get(`/api/v1/${kind==='music'?'music':'trailers'}/:gameId`,async(req,reply)=>{
    let userId;try{userId=(await auth.user(req)).id;}catch(error){if(!(error instanceof AppError)||error.code!=='UNAUTHORIZED')throw error;userId=(await auth.device(req)).user_id;}
    const gameId=uuid.parse((req.params as {gameId:string}).gameId);
    if(!(await db.query('SELECT game_id FROM game_read_access WHERE game_id=$1 AND user_id=$2',[gameId,userId])).rowCount)throw new AppError('NOT_FOUND',404);
    const row=(await db.query("SELECT * FROM game_media WHERE game_id=$1 AND kind=$2 AND state='READY'",[gameId,kind])).rows[0];if(!row)throw new AppError('NOT_FOUND',404);
    return serveFile(req,reply,mediaFile(config,row),row.size,row.sha256,kind==='music'?'audio/mp4':'video/mp4');
  });
  app.delete(`/api/v1/games/:id/${kind}`,async req=>{
    const gameId=uuid.parse((req.params as {id:string}).id);await owned((await auth.user(req)).id,gameId);
    const result=await transaction(db,async sql=>{
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const row=(await sql.query('SELECT * FROM game_media WHERE game_id=$1 AND kind=$2 FOR UPDATE',[gameId,kind])).rows[0];
      if(!row)return {ok:true};if(!['READY','ERROR'].includes(row.state))throw new AppError('TRAILER_BUSY',409);
      await sql.query('DELETE FROM game_media WHERE id=$1',[row.id]);return {ok:true,directory:mediaDirectory(config,row)};
    });
    if(result.directory)await rm(result.directory,{recursive:true,force:true});return {ok:true};
  });
  }
}
