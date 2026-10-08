import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {sha256,titleId,uuid} from '../../../shared/schemas/index.js';
import type {Auth} from '../auth/routes.js';
import type {DB} from '../db.js';
import {AppError} from '../security/errors.js';

const maxProfileBytes=1024*1024;
const profileBase64=z.string().min(4).max(4*Math.ceil(maxProfileBytes/3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const gameVersion=z.string().min(1).max(40).regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/);
const processName=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const contentId=z.string().regex(/^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/);
const provenanceUrl=z.string().url().max(2048).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;},'Provenance URL must be HTTPS without credentials');
const provenance=z.object({
  sourceType:z.enum(['LOCAL_FILE','USER_AUTHORED','UPSTREAM_SNAPSHOT']),sourceName:z.string().min(1).max(200),
  sourceFile:z.string().min(1).max(1024),sourceUrl:provenanceUrl.optional(),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),
}).strict().superRefine((value,ctx)=>{if(value.sourceType==='UPSTREAM_SNAPSHOT'&&!value.sourceCommit)ctx.addIssue({code:'custom',path:['sourceCommit'],message:'Upstream snapshots require an exact commit'});});
const patchBytes=z.string().min(2).max(8192).regex(/^(?:[a-fA-F0-9]{2})+$/);
const jsonPatch=z.object({offset:z.string().min(1).max(16).regex(/^[a-fA-F0-9]+$/),on:patchBytes,off:patchBytes,section:z.union([z.literal(0),z.literal('0')]).optional()}).strict()
  .refine(value=>value.on.length===value.off.length,{message:'Enabled and expected bytes must have equal length'});
const jsonMod=z.object({name:z.string().min(1).max(120),hint:z.string().max(500).nullable().optional(),description:z.string().max(500).optional(),type:z.literal('checkbox'),memory:z.array(jsonPatch).min(1).max(64)}).strict();
const jsonCheat=z.object({name:z.string().min(1).max(200),id:titleId,version:gameVersion,process:processName,mods:z.array(jsonMod).min(1).max(128),credits:z.array(z.string().min(1).max(120)).max(64).optional()}).strict();

export const cheatProfileImport=z.object({
  titleId,gameVersion,process:processName,contentId:contentId.optional(),targetExecutableSha256:sha256.optional(),
  format:z.enum(['JSON','MC4','SHN']),profileBase64,profileSha256:sha256.optional(),provenance,
}).strict().superRefine((value,ctx)=>{if(value.contentId&&value.contentId.slice(7,16)!==value.titleId)ctx.addIssue({code:'custom',path:['contentId'],message:'Content ID and title ID disagree'});});

export const cheatProfileTarget=z.object({titleId,gameVersion,process:processName,contentId:contentId.optional(),targetExecutableSha256:sha256.optional()}).strict();
export type CheatProfileTarget=z.infer<typeof cheatProfileTarget>;

export function decodeCheatProfile(input:z.infer<typeof cheatProfileImport>){
  const body=Buffer.from(input.profileBase64,'base64');
  if(!body.length||body.length>maxProfileBytes||body.toString('base64')!==input.profileBase64)throw new AppError('INVALID_PROFILE',400);
  const digest=createHash('sha256').update(body).digest('hex');
  if(input.profileSha256&&input.profileSha256!==digest)throw new AppError('PROFILE_HASH_MISMATCH',409);
  return {body,sha256:digest};
}

export function validateJsonCheatProfile(body:Buffer,target:{titleId:string;gameVersion:string;process:string}){
  const text=body.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(body)||text.includes('\0'))throw new AppError('INVALID_PROFILE',400);
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new AppError('INVALID_PROFILE',400);}
  const profile=jsonCheat.parse(parsed);
  if(profile.id!==target.titleId||profile.version!==target.gameVersion||profile.process!==target.process)throw new AppError('METADATA_MISMATCH',409);
  let total=0;const names=new Set<string>();
  for(const mod of profile.mods){
    if(names.has(mod.name))throw new AppError('INVALID_PROFILE',400);names.add(mod.name);
    const ranges:Array<[bigint,bigint]>=[];
    for(const patch of mod.memory){
      const start=BigInt(`0x${patch.offset}`),length=BigInt(patch.on.length/2),end=start+length;
      if(end>0x7fffffffffffffffn)throw new AppError('INVALID_PROFILE',400);
      if(ranges.some(([from,to])=>start<to&&end>from))throw new AppError('INVALID_PROFILE',400);
      ranges.push([start,end]);total+=patch.on.length/2;
    }
  }
  if(total>64*1024)throw new AppError('INVALID_PROFILE',400);
  return profile;
}

export function cheatProfileMatches(profile:CheatProfileTarget,target:CheatProfileTarget){
  return profile.titleId===target.titleId&&profile.gameVersion===target.gameVersion&&profile.process===target.process
    &&(!profile.contentId||profile.contentId===target.contentId)
    &&(!profile.targetExecutableSha256||profile.targetExecutableSha256===target.targetExecutableSha256);
}

const rowJSON=(row:any,payload=false)=>({
  id:row.id,titleId:row.title_id,gameVersion:row.game_version,process:row.process_name,contentId:row.content_id,
  targetExecutableSha256:row.target_executable_sha256,format:row.format,profileSha256:row.profile_sha256,
  provenance:row.provenance,approvalState:row.approval_state,testState:row.test_state,
  targetVerification:row.target_executable_sha256?'HASH_MATCHED':'UNVERIFIED_TARGET',createdAt:row.created_at,updatedAt:row.updated_at,
  ...(payload?{profileBase64:(row.profile_body as Buffer).toString('base64')}:{})
});

export async function cheatProfileRoutes(app:FastifyInstance,db:DB,auth:Auth){
  const admin=async(req:FastifyRequest)=>{const user=await auth.user(req);if(user.role!=='ADMIN')throw new AppError('FORBIDDEN',403);return user;};
  app.post('/api/v1/admin/cheat-profiles',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
    const user=await admin(req),input=cheatProfileImport.parse(req.body),decoded=decodeCheatProfile(input),id=randomUUID();
    if(input.format==='JSON')validateJsonCheatProfile(decoded.body,input);
    const row=(await db.query(`INSERT INTO cheat_profiles(id,created_by,title_id,game_version,process_name,content_id,target_executable_sha256,format,profile_body,profile_sha256,provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,user.id,input.titleId,input.gameVersion,input.process,input.contentId??null,input.targetExecutableSha256??null,input.format,decoded.body,decoded.sha256,input.provenance])).rows[0];
    return reply.code(201).send(rowJSON(row));
  });
  app.patch('/api/v1/admin/cheat-profiles/:id',async req=>{
    await admin(req);const id=uuid.parse((req.params as {id:string}).id),state=z.object({approvalState:z.enum(['PENDING','APPROVED','REJECTED']).optional(),testState:z.enum(['UNTESTED','TESTED','FAILED']).optional()}).strict().refine(value=>value.approvalState!==undefined||value.testState!==undefined).parse(req.body);
    const row=(await db.query('UPDATE cheat_profiles SET approval_state=COALESCE($2,approval_state),test_state=COALESCE($3,test_state),updated_at=now() WHERE id=$1 RETURNING *',[id,state.approvalState??null,state.testState??null])).rows[0];
    if(!row)throw new AppError('NOT_FOUND',404);return rowJSON(row);
  });
  app.get('/api/v1/cheat-profiles',async req=>{
    await auth.user(req);const target=cheatProfileTarget.parse(req.query);
    const rows=(await db.query(`SELECT * FROM cheat_profiles WHERE approval_state='APPROVED' AND test_state<>'FAILED' AND title_id=$1 AND game_version=$2 AND process_name=$3
      AND (content_id IS NULL OR content_id=$4) AND (target_executable_sha256 IS NULL OR target_executable_sha256=$5)
      ORDER BY (target_executable_sha256 IS NOT NULL) DESC,(content_id IS NOT NULL) DESC,created_at DESC LIMIT 100`,[target.titleId,target.gameVersion,target.process,target.contentId??null,target.targetExecutableSha256??null])).rows;
    return rows.filter(row=>cheatProfileMatches({titleId:row.title_id,gameVersion:row.game_version,process:row.process_name,contentId:row.content_id??undefined,targetExecutableSha256:row.target_executable_sha256??undefined},target)).map(row=>rowJSON(row,true));
  });
}
