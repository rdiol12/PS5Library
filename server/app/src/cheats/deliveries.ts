import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {uuid} from '../../../shared/schemas/index.js';
import type {Auth} from '../auth/routes.js';
import type {DB} from '../db.js';
import {AppError} from '../security/errors.js';

const params=z.object({consoleId:uuid,profileId:uuid});
const receipt=z.object({
  state:z.enum(['RECEIVED','REJECTED','DELETED']),
  profileSha256:z.string().regex(/^[a-f0-9]{64}$/),
  error:z.string().min(1).max(120).regex(/^[A-Z0-9_]+$/).optional(),
}).strict().superRefine((value,context)=>{
  if(value.state==='REJECTED'&&!value.error)context.addIssue({code:'custom',path:['error'],message:'Rejected delivery requires an error code'});
  if(value.state!=='REJECTED'&&value.error)context.addIssue({code:'custom',path:['error'],message:'Only rejected delivery accepts an error code'});
});

export function cheatDeliveryFileName(titleId:string,version:string,process:string){
  if(!/^(?:PPSA|CUSA)\d{5}$/.test(titleId)||!/^[0-9]{1,3}(?:\.[0-9]{1,3}){1,2}$/.test(version)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(process))throw new AppError('INVALID_PROFILE',400);
  return `${titleId}_${version}_${process}.json`;
}
export function verifiedCheatDeliveryTarget(profile:{title_id:string;game_version:string;process_name:string;target_executable_sha256?:string|null}){
  if(!profile.target_executable_sha256||!/^[a-f0-9]{64}$/.test(profile.target_executable_sha256))throw new AppError('CHEAT_TARGET_HASH_REQUIRED',409);
  return cheatDeliveryFileName(profile.title_id,profile.game_version,profile.process_name);
}

const deliveryJSON=(row:any)=>({
  id:row.id,profileId:row.profile_id,consoleId:row.console_id,state:row.state,error:row.error,
  attempts:row.attempts,createdAt:row.created_at,updatedAt:row.updated_at,receivedAt:row.received_at,
});

export async function cheatDeliveryRoutes(app:FastifyInstance,db:DB,auth:Auth){
  app.post('/api/v1/consoles/:consoleId/cheat-profiles/:profileId/delivery',async(req,reply)=>{
    const user=await auth.user(req),target=params.parse(req.params);
    const profile=(await db.query(`SELECT p.* FROM cheat_profiles p JOIN consoles c ON c.id=$2 AND c.user_id=$3
      WHERE p.id=$1 AND p.approval_state='APPROVED' AND p.test_state<>'FAILED' AND p.format='JSON'
      AND EXISTS(SELECT 1 FROM console_library_entries l JOIN game_releases r ON r.id=l.release_id JOIN games g ON g.id=r.game_id
        WHERE l.console_id=c.id AND l.state='READY_ON_PS5' AND g.title_id=p.title_id AND r.version=p.game_version
          AND (p.content_id IS NULL OR r.content_id=p.content_id))`,[target.profileId,target.consoleId,user.id])).rows[0];
    if(!profile)throw new AppError('NO_EXACT_INSTALLED_MATCH',409);
    const targetKey=verifiedCheatDeliveryTarget(profile);
    const id=randomUUID(),row=(await db.query(`INSERT INTO cheat_deliveries(id,profile_id,console_id,requested_by,target_key,state,error,attempts,last_attempt_at,received_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'QUEUED',NULL,0,NULL,NULL,now())
      ON CONFLICT(console_id,target_key) WHERE state<>'DELETED' DO UPDATE SET requested_by=EXCLUDED.requested_by,state='QUEUED',error=NULL,attempts=0,last_attempt_at=NULL,received_at=NULL,updated_at=now()
        WHERE cheat_deliveries.profile_id=EXCLUDED.profile_id
      RETURNING *`,[id,target.profileId,target.consoleId,user.id,targetKey])).rows[0];
    if(!row)throw new AppError('CHEAT_TARGET_CONFLICT',409);
    return reply.code(202).send(deliveryJSON(row));
  });

  app.get('/api/v1/consoles/:consoleId/cheat-deliveries',async req=>{
    const user=await auth.user(req),consoleId=uuid.parse((req.params as {consoleId:string}).consoleId);
    if(!(await db.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2',[consoleId,user.id])).rowCount)throw new AppError('NOT_FOUND',404);
    return (await db.query('SELECT * FROM cheat_deliveries WHERE console_id=$1 ORDER BY created_at DESC LIMIT 100',[consoleId])).rows.map(deliveryJSON);
  });

  app.delete('/api/v1/consoles/:consoleId/cheat-profiles/:profileId/delivery',async(req,reply)=>{
    const user=await auth.user(req),target=params.parse(req.params);
    const row=(await db.query(`UPDATE cheat_deliveries d SET state='DELETE_REQUESTED',error=NULL,updated_at=now()
      FROM consoles c WHERE d.console_id=c.id AND d.console_id=$1 AND d.profile_id=$2 AND c.user_id=$3 AND d.state<>'DELETED' RETURNING d.*`,[target.consoleId,target.profileId,user.id])).rows[0];
    if(!row)throw new AppError('NOT_FOUND',404);return reply.code(202).send(deliveryJSON(row));
  });

  app.get('/api/v1/device/cheat-deliveries',async req=>{
    const device=await auth.device(req);
    const row=(await db.query(`SELECT d.*,p.title_id,p.game_version,p.process_name,p.content_id,p.target_executable_sha256,p.format,p.profile_body,p.profile_sha256,p.provenance
      FROM cheat_deliveries d JOIN cheat_profiles p ON p.id=d.profile_id
      WHERE d.console_id=$1 AND d.state IN ('QUEUED','DELETE_REQUESTED') ORDER BY d.created_at LIMIT 1`,[device.id])).rows[0];
    if(!row)return null;
    await db.query('UPDATE cheat_deliveries SET attempts=attempts+1,last_attempt_at=now(),updated_at=now() WHERE id=$1',[row.id]);
    const expected=verifiedCheatDeliveryTarget(row);
    if(row.target_key!==expected)throw new AppError('INVALID_CHEAT_DELIVERY',409);
    const common={id:row.id,profileId:row.profile_id,profileSha256:row.profile_sha256,fileName:expected};
    if(row.state==='DELETE_REQUESTED')return {...common,action:'DELETE'};
    return {...common,action:'PLACE',titleId:row.title_id,gameVersion:row.game_version,process:row.process_name,
      contentId:row.content_id,targetExecutableSha256:row.target_executable_sha256,format:row.format,
      profileBase64:(row.profile_body as Buffer).toString('base64'),provenance:row.provenance};
  });

  app.post('/api/v1/device/cheat-deliveries/:id/receipt',async req=>{
    const device=await auth.device(req),id=uuid.parse((req.params as {id:string}).id),body=receipt.parse(req.body);
    const expected=body.state==='DELETED'?'DELETE_REQUESTED':body.state==='RECEIVED'?'QUEUED':null;
    const row=(await db.query(`UPDATE cheat_deliveries d SET state=$3,error=$4,received_at=CASE WHEN $3='RECEIVED' THEN now() ELSE received_at END,updated_at=now()
      FROM cheat_profiles p WHERE d.id=$1 AND d.console_id=$2 AND d.profile_id=p.id AND ($5::text IS NULL OR d.state=$5) AND d.state IN ('QUEUED','DELETE_REQUESTED') AND p.profile_sha256=$6 RETURNING d.id`,
      [id,device.id,body.state,body.error??null,expected,body.profileSha256])).rows[0];
    if(!row)throw new AppError('DELIVERY_STATE_MISMATCH',409);return {ok:true};
  });
}
