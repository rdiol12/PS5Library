import type {DB} from '../db.js';
import {AppError} from '../security/errors.js';
import type {Config} from '../config.js';
import path from 'node:path';
import {existingWithin} from '../security/paths.js';

export async function accessibleSource(db:DB,userId:string,id:string){
  const source=(await db.query('SELECT sr.*,s.config,s.type,s.user_id AS source_owner FROM source_releases sr JOIN sources s ON s.id=sr.source_id JOIN game_releases r ON r.id=sr.release_id WHERE sr.id=$1 AND EXISTS(SELECT 1 FROM game_content_access access WHERE access.game_id=r.game_id AND access.user_id=$2)',[id,userId])).rows[0];
  if(!source)throw new AppError('NOT_FOUND',404);return source;
}
export function localSourceRoot(config:Config,sourceType:string,owner:string){
  if(sourceType==='WATCH_FOLDER'){if(!config.DUMP_ROOT)throw new AppError('DUMP_ROOT_NOT_CONFIGURED',409);return path.resolve(config.DUMP_ROOT);}
  return path.join(config.SOURCE_ROOT,owner);
}
export async function sourceLocation(config:Config,sourceType:string,owner:string,location:string):Promise<[boolean,string]>{const local=['LOCAL_FOLDER','WATCH_FOLDER'].includes(sourceType);if(!local)return [false,location];const root=localSourceRoot(config,sourceType,owner);return [true,await existingWithin(root,path.resolve(root,location))];}
