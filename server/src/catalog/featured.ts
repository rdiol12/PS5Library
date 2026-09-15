import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { transaction, type DB } from '../db.js';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import { uuid } from '../../../shared/schemas/index.js';
import { AppError } from '../security/errors.js';
import { placeholder } from '../artwork/cache.js';

export function heroWindow(now: Date) {
  const week = new Date(now); week.setUTCHours(0,0,0,0); week.setUTCDate(week.getUTCDate() - (week.getUTCDay()+6)%7);
  const next = new Date(week); next.setUTCDate(next.getUTCDate()+7);
  const cutoff = new Date(now), day = cutoff.getUTCDate(); cutoff.setUTCDate(1); cutoff.setUTCMonth(cutoff.getUTCMonth()-2);
  cutoff.setUTCDate(Math.min(day,new Date(Date.UTC(cutoff.getUTCFullYear(),cutoff.getUTCMonth()+1,0)).getUTCDate()));
  return { week: week.toISOString().slice(0,10), next: next.toISOString().slice(0,10), cutoff: cutoff.toISOString() };
}
export function eligibleHero(sha256: string, history: {sha256:string;selectedAt:string}[], now: Date) {
  const cutoff=heroWindow(now).cutoff;
  return !history.some(item=>item.sha256===sha256 && new Date(item.selectedAt).getTime()>new Date(cutoff).getTime());
}
export async function featuredSelection(db: DB, userId: string, now=new Date()) {
  const window=heroWindow(now);
  return transaction(db,async sql=>{
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3150004))',[userId]);
    let selection=(await sql.query('SELECT * FROM featured_history WHERE user_id=$1 AND week_of=$2',[userId,window.week])).rows[0];
    if(!selection){
      const history=(await sql.query('SELECT sha256,selected_at AS "selectedAt" FROM featured_history WHERE user_id=$1 AND selected_at>$2',[userId,window.cutoff])).rows;
      const candidates=(await sql.query("SELECT a.* FROM artwork a JOIN games g ON g.id=a.game_id WHERE g.user_id=$1 AND a.kind='hero' ORDER BY md5(a.sha256 || $2) LIMIT 5000",[userId,window.week])).rows;
      const image=candidates.find(a=>eligibleHero(a.sha256,history,now));
      if(image)selection=(await sql.query('INSERT INTO featured_history(id,user_id,game_id,week_of,sha256,relative_path,selected_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),userId,image.game_id,window.week,image.sha256,image.relative_path,now])).rows[0];
    }
    return {state:selection?'SELECTED':'NEEDS_ARTWORK',gameId:selection?.game_id??null,heroUrl:selection?`/api/v1/featured/artwork/${selection.id}`:null,weekOf:window.week,nextRotationAt:`${window.next}T00:00:00.000Z`,minimumRepeatInterval:'2 calendar months'};
  });
}
export async function featuredRoutes(app: FastifyInstance,db: DB,config: Config,auth: Auth){
  app.get('/api/v1/featured',async req=>featuredSelection(db,(await auth.user(req)).id));
  app.get('/api/v1/device/featured',async req=>featuredSelection(db,(await auth.device(req)).user_id));
  app.get('/api/v1/featured/artwork/:id',async(req,reply)=>{
    let userId: string;try{userId=(await auth.user(req)).id;}catch{userId=(await auth.device(req)).user_id;}
    const id=uuid.parse((req.params as {id:string}).id);
    const selection=(await db.query('SELECT * FROM featured_history WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];
    if(!selection)throw new AppError('NOT_FOUND',404);
    const etag=`"${selection.sha256}"`;reply.header('etag',etag).header('cache-control','private,max-age=604800').header('vary','Authorization, Cookie');
    if(req.headers['if-none-match']===etag)return reply.code(304).send();
    const file=path.join(config.DATA_DIR,selection.relative_path);
    if(!await stat(file).catch(()=>null))return reply.type('image/svg+xml').send(placeholder);
    return reply.type('image/webp').send(createReadStream(file));
  });
}
