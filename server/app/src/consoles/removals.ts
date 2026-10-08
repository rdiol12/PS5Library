import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {transaction,type DB} from '../db.js';
import type {Auth} from '../auth/routes.js';
import {uuid} from '../../../shared/schemas/index.js';
import {AppError} from '../security/errors.js';
import {jobEvent,jobJSON} from '../jobs/events.js';

export function removalSupported(entry:any,capabilities:any) {
  return entry.state==='READY_ON_PS5' && (entry.source==='MANAGED'&&!entry.registered || capabilities?.gameDeletion===true);
}
export async function removalRoutes(app:FastifyInstance,db:DB,auth:Auth) {
  const body=z.object({releaseId:uuid,storageId:z.string().min(1).max(64),confirm:z.literal(true)}).strict();
  const enqueue=async(userId:string,consoleId:string,raw:unknown)=>{
    const selected=body.parse(raw);
    return transaction(db,async sql=>{
      const c=(await sql.query('SELECT c.*,k.capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c',[consoleId,userId])).rows[0];
      if(!c)throw new AppError('NOT_FOUND',404);
      const entry=(await sql.query('SELECT l.*,g.title_id,r.content_id,r.version FROM console_library_entries l JOIN game_releases r ON r.id=l.release_id JOIN games g ON g.id=r.game_id WHERE l.console_id=$1 AND l.release_id=$2 AND l.storage_id=$3',[consoleId,selected.releaseId,selected.storageId])).rows[0];
      if(!entry)throw new AppError('NOT_FOUND',404);
      if(!removalSupported(entry,c.capabilities))throw new AppError('REMOVAL_UNAVAILABLE',409);
      const active=(await sql.query("SELECT j.* FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.console_id=$1 AND g.title_id=$2 AND j.kind IN ('TRANSFER','DELETE') AND j.state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')",[consoleId,entry.title_id])).rows;
      if(active.some(j=>j.kind==='TRANSFER'))throw new AppError('GAME_IN_USE',409,'Finish or cancel the game transfer first.');
      if(active.length)return {id:active[0].id};
      const id=randomUUID();
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,console_id,storage_id,state,config) VALUES($1,$2,'DELETE',$3,$4,$5,'QUEUED',$6)",[id,userId,selected.releaseId,consoleId,selected.storageId,{inventoryRevision:c.library_revision,titleId:entry.title_id,contentId:entry.content_id,version:entry.version,source:entry.source,relativePath:entry.relative_path,sha256:entry.sha256,size:entry.size,registered:entry.registered}]);
      await jobEvent(sql,id);return {id};
    });
  };
  app.post('/api/v1/consoles/:id/library/remove',async(req,reply)=>reply.code(202).send(await enqueue((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id),req.body)));
  app.post('/api/v1/device/consoles/:id/library/remove',async(req,reply)=>reply.code(202).send(await enqueue((await auth.device(req)).user_id,uuid.parse((req.params as {id:string}).id),req.body)));
  app.get('/api/v1/device/removals',async req=>{
    const c=await auth.device(req);
    return (await db.query("SELECT j.*,g.title FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.console_id=$1 AND j.kind='DELETE' AND j.state NOT IN ('COMPLETED','ERROR','CANCELLED') ORDER BY j.created_at LIMIT 20",[c.id])).rows.map(j=>({...jobJSON(j),...j.config}));
  });
  app.post('/api/v1/device/removals/:id/progress',async req=>{
    const c=await auth.device(req),id=uuid.parse((req.params as {id:string}).id),progress=z.object({state:z.enum(['DELETING','VERIFYING','COMPLETED','ERROR']),error:z.string().max(500).optional()}).parse(req.body);
    return transaction(db,async sql=>{
      const job=(await sql.query("SELECT * FROM jobs WHERE id=$1 AND console_id=$2 AND kind='DELETE' FOR UPDATE",[id,c.id])).rows[0];
      if(!job)throw new AppError('NOT_FOUND',404);
      const transitions:Record<string,string[]>={QUEUED:['DELETING','ERROR'],DELETING:['DELETING','VERIFYING','ERROR'],VERIFYING:['VERIFYING','COMPLETED','ERROR'],COMPLETED:['COMPLETED']};
      if(!transitions[job.state]?.includes(progress.state))throw new AppError('INVALID_JOB_TRANSITION',409);
      if(progress.state==='COMPLETED') {
        const inventory=(await sql.query("SELECT l.state,c.library_revision FROM console_library_entries l JOIN consoles c ON c.id=l.console_id WHERE l.console_id=$1 AND l.release_id=$2 AND l.storage_id=$3",[c.id,job.release_id,job.storage_id])).rows[0];
        if(!inventory||inventory.state!=='MISSING'||inventory.library_revision<=job.config.inventoryRevision)throw new AppError('INVENTORY_CONFIRMATION_REQUIRED',409);
      }
      await sql.query('UPDATE jobs SET state=$2,error=$3,updated_at=now() WHERE id=$1',[id,progress.state,progress.error??null]);await jobEvent(sql,id);return {ok:true};
    });
  });
}
