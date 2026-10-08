import type { FastifyInstance,FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from './routes.js';
import { optimizeArtworkIsolated } from '../artwork/cache.js';
import { existingWithin } from '../security/paths.js';
import { AppError } from '../security/errors.js';
import { uuid } from '../../../shared/schemas/index.js';

export async function profileRoutes(app:FastifyInstance,db:DB,config:Config,auth:Auth){
  const owner=async(req:FastifyRequest)=>{try{return (await auth.user(req)).id as string;}catch(e){if(!(e instanceof AppError)||e.statusCode!==401)throw e;return (await auth.device(req)).user_id as string;}};
  const profile=async(id:string)=>{
    const rows=(query:string)=>db.query(query,[id]).then(result=>result.rows),[users,consoles,games,saves]=await Promise.all([
      rows('SELECT username,role,avatar_sha256 FROM users WHERE id=$1'),
      rows('SELECT id,name,last_seen AS "lastSeen",trophy_summary AS "trophySummary",trophy_synced_at AS "trophySyncedAt" FROM consoles WHERE user_id=$1 ORDER BY created_at'),
      rows(`SELECT l.console_id AS "consoleId",g.id AS "gameId",g.title,g.title_id AS "titleId",COALESCE(g.metadata->>'platform','PS5') AS platform,bool_or(l.state='READY_ON_PS5') AS available,COALESCE(array_agg(DISTINCT r.version ORDER BY r.version) FILTER(WHERE l.state='READY_ON_PS5'),'{}') AS versions
        FROM console_library_entries l JOIN consoles c ON c.id=l.console_id JOIN game_releases r ON r.id=l.release_id JOIN games g ON g.id=r.game_id WHERE c.user_id=$1 GROUP BY l.console_id,g.id ORDER BY g.title`),
      rows(`SELECT s.console_id AS "consoleId",s.local_user_id AS "localUserId",s.platform,s.game_title_id AS "gameTitleId",s.save_title_id AS "saveTitleId",s.directory,s.title,s.subtitle,s.detail,s.size_bytes AS "sizeBytes",s.modified_at AS "modifiedAt" FROM console_save_data s JOIN consoles c ON c.id=s.console_id WHERE c.user_id=$1 ORDER BY s.modified_at DESC,s.save_title_id,s.directory`),
    ]),user=users[0];
    return {username:user.username,role:user.role,avatarUrl:user.avatar_sha256?`/api/v1/profile/avatar?v=${user.avatar_sha256}`:null,consoles:consoles.map(c=>({...c,saveData:saves.filter(s=>s.consoleId===c.id).map(({consoleId:_,...save})=>save),games:games.filter(g=>g.consoleId===c.id).map(g=>({...g,coverUrl:`/api/v1/artwork/${g.gameId}/cover`,trophies:{status:'UNAVAILABLE'}}))}))};
  };
  app.get('/api/v1/profile',async req=>profile((await auth.user(req)).id));
  app.get('/api/v1/device/profile',async req=>profile((await auth.device(req)).user_id));
  const save=async(id:string,input:Buffer)=>{
    let data:Buffer;try{({data}=await optimizeArtworkIsolated(input,'icon',config.DATA_DIR));}catch(error){if(error instanceof AppError&&error.statusCode>=500)throw error;throw new AppError('INVALID_AVATAR',400);}
    if(data.length>262144)throw new AppError('INVALID_AVATAR',400);
    const hash=createHash('sha256').update(data).digest('hex');await db.query('UPDATE users SET avatar=$2,avatar_sha256=$3 WHERE id=$1',[id,data,hash]);return {avatarUrl:`/api/v1/profile/avatar?v=${hash}`};
  };
  app.post('/api/v1/profile/avatar',{bodyLimit:6*1024**2},async req=>{
    const user=await auth.user(req),body=z.object({data:z.string().min(4).max(4*Math.ceil(4*1024**2/3))}).parse(req.body),input=Buffer.from(body.data,'base64');
    if(input.length>4*1024**2||input.toString('base64')!==body.data)throw new AppError('INVALID_AVATAR',400);
    return save(user.id,input);
  });
  app.put('/api/v1/device/profile/avatar',async req=>{
    const device=await auth.device(req),body=z.object({gameId:uuid}).parse(req.body);
    const art=(await db.query("SELECT a.relative_path FROM artwork a JOIN game_read_access access ON access.game_id=a.game_id WHERE a.game_id=$1 AND access.user_id=$2 AND a.kind='icon'",[body.gameId,device.user_id])).rows[0];
    if(!art)throw new AppError('NOT_FOUND',404);
    return save(device.user_id,await readFile(await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,art.relative_path))));
  });
  app.delete('/api/v1/profile/avatar',async req=>{await db.query('UPDATE users SET avatar=NULL,avatar_sha256=NULL WHERE id=$1',[(await auth.user(req)).id]);return {ok:true};});
  app.delete('/api/v1/device/profile/avatar',async req=>{await db.query('UPDATE users SET avatar=NULL,avatar_sha256=NULL WHERE id=$1',[(await auth.device(req)).user_id]);return {ok:true};});
  app.get('/api/v1/profile/avatar',async(req,reply)=>{
    const user=(await db.query('SELECT avatar,avatar_sha256 FROM users WHERE id=$1',[await owner(req)])).rows[0];if(!user?.avatar)throw new AppError('NOT_FOUND',404);
    const etag=`"${user.avatar_sha256}"`;reply.header('etag',etag).header('cache-control','private, max-age=0, must-revalidate');
    if(req.headers['if-none-match']===etag)return reply.code(304).send();return reply.type('image/webp').send(user.avatar);
  });
}
