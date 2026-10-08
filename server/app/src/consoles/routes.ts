import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DB, type SQL } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { hardwareLookup, hardwareRecoveryToken, hash, seal, unseal, secret, sameSecret } from '../auth/credentials.js';
import { heartbeatSchema, launchTraceByteLimit, launchTraceSchema, uuid, firmware } from '../../../shared/schemas/index.js';
import { presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { safeName } from '../security/paths.js';
import { removalSupported } from './removals.js';

const pairingCode=()=>Array.from(randomBytes(5),byte=>'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[byte&31]).join('');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const pairingRequest=z.discriminatedUnion('clientKind',[
  z.object({deviceId:uuid,name:z.string().min(1).max(80),clientKind:z.literal('PS5'),firmware:firmware.nullable().optional(),hardwareProof:digest.optional()}).strict(),
  z.object({deviceId:uuid,name:z.string().min(1).max(80),clientKind:z.literal('SIMULATOR'),firmware:firmware.nullable().optional()}).strict(),
]);
const recoveryRequest=z.object({deviceId:uuid,recoveryToken:digest}).strict();
const remotePlayAccountId=z.string().regex(/^[A-Za-z0-9+/]{11}=$/).refine(value=>Buffer.from(value,'base64').length===8&&Buffer.from(value,'base64').toString('base64')===value,'Expected the base64 form of an 8-byte account ID');
const remotePlayReport=z.discriminatedUnion('state',[
  z.object({state:z.literal('READY'),pin:z.string().regex(/^\d{8}$/),accountId:remotePlayAccountId}).strict(),
  z.object({state:z.literal('PAIRED')}).strict(),
  z.object({state:z.literal('ERROR'),error:z.string().regex(/^[A-Z0-9_]{1,80}$/)}).strict(),
]);

export async function consoleRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const prunePairings=async(sql:SQL)=>{await sql.query('DELETE FROM pairings WHERE expires_at<=now()');await sql.query('DELETE FROM consoles c WHERE c.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM pairings p WHERE p.console_id=c.id)');};
  const bindHardware=async(sql:SQL,consoleId:string,lookup:string)=>{
    const rows=(await sql.query('SELECT * FROM console_hardware_identities WHERE console_id=$1 OR lookup_hash=$2 FOR UPDATE',[consoleId,lookup])).rows;
    if(rows.some(row=>row.console_id!==consoleId||row.lookup_hash!==lookup))throw new AppError('HARDWARE_IDENTITY_MISMATCH',409);
    let row=rows[0];
    if(!row){const nonce=secret(),recoveryToken=hardwareRecoveryToken(lookup,nonce,config.BOOTSTRAP_TOKEN);await sql.query('INSERT INTO console_hardware_identities(console_id,lookup_hash,nonce,recovery_token_hash) VALUES($1,$2,$3,$4)',[consoleId,lookup,nonce,hash(recoveryToken)]);return recoveryToken;}
    const recoveryToken=hardwareRecoveryToken(row.lookup_hash,row.nonce,config.BOOTSTRAP_TOKEN);
    if(!sameSecret(row.recovery_token_hash,hash(recoveryToken)))throw new AppError('HARDWARE_IDENTITY_MISMATCH',409);
    await sql.query('UPDATE console_hardware_identities SET recovery_disabled_at=NULL WHERE console_id=$1',[consoleId]);
    return recoveryToken;
  };
  app.get('/api/v1/notifications',async req=>(await db.query('SELECT id,console_id AS "consoleId",release_id AS "releaseId",code,message,created_at AS "createdAt" FROM console_notices WHERE user_id=$1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 100',[(await auth.user(req)).id])).rows);
  app.get('/api/v1/device/notifications',async req=>(await db.query(`SELECT n.id,n.code,n.message,COALESCE(g.title,'PS5Library') AS title
    FROM console_notices n LEFT JOIN game_releases r ON r.id=n.release_id LEFT JOIN games g ON g.id=r.game_id
    WHERE n.console_id=$1 AND n.delivered_at IS NULL AND n.resolved_at IS NULL ORDER BY n.created_at LIMIT 20`,[(await auth.device(req)).id])).rows);
  app.post('/api/v1/device/notifications/:id/ack',async req=>{
    const c=await auth.device(req),id=uuid.parse((req.params as {id:string}).id);
    if(!(await db.query('UPDATE console_notices SET delivered_at=now(),resolved_at=CASE WHEN resolve_on_delivery THEN now() ELSE resolved_at END WHERE id=$1 AND console_id=$2',[id,c.id])).rowCount)throw new AppError('NOT_FOUND',404);return {ok:true};
  });
  app.post('/api/v1/pairings', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body=pairingRequest.parse(req.body),lookup=body.clientKind==='PS5'&&body.hardwareProof?hardwareLookup(body.hardwareProof,config.BOOTSTRAP_TOKEN):null;
    const id = randomUUID(), code = pairingCode();let consoleId=randomUUID();
    const pollSecret = secret();
    await transaction(db, async sql => {
      await prunePairings(sql);
      const existing = (await sql.query('SELECT id,user_id FROM consoles WHERE device_id=$1 FOR UPDATE', [body.deviceId])).rows[0];
      if (existing?.user_id || existing&&(await sql.query('SELECT id FROM pairings WHERE console_id=$1 AND expires_at>now()',[existing.id])).rowCount) throw new AppError('DEVICE_ALREADY_REGISTERED', 409, 'Use the stored device credential, or revoke and reset the device identity.');
      if(existing)consoleId=existing.id;else await sql.query('INSERT INTO consoles(id,device_id,name,client_kind) VALUES($1,$2,$3,$4)', [consoleId, body.deviceId, body.name, body.clientKind]);
      if(body.firmware!==undefined)await sql.query('UPDATE consoles SET firmware=$2,firmware_checked_at=now() WHERE id=$1',[consoleId,body.firmware]);
      await sql.query("INSERT INTO pairings(id,console_id,code_hash,poll_hash,hardware_lookup_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')", [id, consoleId, hash(code), hash(pollSecret),lookup]);
    });
    return reply.code(201).send({ id, code, pollSecret, expiresInSeconds: 600, pairingUrl: `${config.PUBLIC_URL}/pair?code=${code}` });
  });
  app.post('/api/v1/frontend/pairings', {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (req,reply) => {
    const body=z.object({deviceId:uuid}).parse(req.body);
    const id=randomUUID(),code=pairingCode(),pollSecret=secret();
    await transaction(db,async sql=>{await prunePairings(sql);if((await sql.query("SELECT id FROM console_credentials WHERE frontend_device_id=$1 AND revoked_at IS NULL",[body.deviceId])).rowCount)throw new AppError('DEVICE_ALREADY_REGISTERED',409);await sql.query("INSERT INTO pairings(id,kind,frontend_device_id,code_hash,poll_hash,expires_at) VALUES($1,'FRONTEND',$2,$3,$4,now()+interval '10 minutes')",[id,body.deviceId,hash(code),hash(pollSecret)]);});
    return reply.code(201).send({id,code,pollSecret,expiresInSeconds:600,pairingUrl:`${config.PUBLIC_URL}/pair?code=${code}&kind=frontend`});
  });
  app.post('/api/v1/hardware/recover',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
    const body=recoveryRequest.parse(req.body);
    return transaction(db,async sql=>{
      const row=(await sql.query(`SELECT i.console_id,i.lookup_hash,i.nonce,i.recovery_token_hash FROM console_hardware_identities i JOIN consoles c ON c.id=i.console_id
        WHERE c.user_id IS NOT NULL AND i.recovery_disabled_at IS NULL AND i.recovery_token_hash=$1 FOR UPDATE OF i,c`,[hash(body.recoveryToken)])).rows[0];
      if(!row)throw new AppError('CONSOLE_NOT_ENROLLED',404);
      const recoveryToken=hardwareRecoveryToken(row.lookup_hash,row.nonce,config.BOOTSTRAP_TOKEN);
      if(!sameSecret(row.recovery_token_hash,hash(recoveryToken))||!sameSecret(body.recoveryToken,recoveryToken))throw new AppError('CONSOLE_NOT_ENROLLED',404);
      const credential=secret(),credentialId=randomUUID();
      await sql.query("UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='FRONTEND' AND revoked_at IS NULL",[row.console_id]);
      await sql.query("INSERT INTO console_credentials(id,console_id,token_hash,kind,frontend_device_id) VALUES($1,$2,$3,'FRONTEND',$4)",[credentialId,row.console_id,hash(credential),body.deviceId]);
      await sql.query('UPDATE console_hardware_identities SET last_recovered_at=now() WHERE console_id=$1',[row.console_id]);
      return {status:'RECOVERED',consoleId:row.console_id,credential,recoveryToken};
    });
  });
  app.post('/api/v1/device/hardware',async req=>{
    const device=await auth.device(req),body=z.object({hardwareProof:digest}).strict().parse(req.body),lookup=hardwareLookup(body.hardwareProof,config.BOOTSTRAP_TOKEN);
    if(device.credential_kind!=='AGENT')throw new AppError('AGENT_REQUIRED',403);
    return transaction(db,async sql=>{if(!(await sql.query('SELECT id FROM console_credentials WHERE id=$1 AND console_id=$2 AND kind=\'AGENT\' AND revoked_at IS NULL FOR UPDATE',[device.credential_id,device.id])).rowCount)throw new AppError('UNAUTHORIZED',401);return {recoveryToken:await bindHardware(sql,device.id,lookup)};});
  });
  app.post('/api/v1/pairings/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    let user:any,frontend:any;
    try{user=await auth.user(req);}catch(error){
      if(!(error instanceof AppError)||error.statusCode!==401)throw error;
      frontend=await auth.device(req);
      if(frontend.credential_kind!=='FRONTEND')throw new AppError('FRONTEND_REQUIRED',403);
    }
    const body = z.object({code:z.string().toUpperCase().regex(/^[2-9A-HJ-NP-Z]{5}$/),consoleId:uuid.optional()}).parse(req.body),code=body.code;
    return transaction(db, async sql => {
      const pair = (await sql.query('SELECT * FROM pairings WHERE code_hash=$1 FOR UPDATE', [hash(code)])).rows[0];
      if (!pair || new Date(pair.expires_at).getTime() <= Date.now()) throw new AppError('PAIRING_EXPIRED', 410);
      if (pair.claimed_at) throw new AppError('PAIRING_ALREADY_CLAIMED', 409);
      const bound=pair.hardware_lookup_hash?(await sql.query('SELECT * FROM console_hardware_identities WHERE lookup_hash=$1 FOR UPDATE',[pair.hardware_lookup_hash])).rows[0]:null;
      if(frontend){
        if(pair.kind!=='AGENT'||body.consoleId)throw new AppError('AGENT_PAIRING_REQUIRED',400);
        const target=(await sql.query("SELECT c.id FROM consoles c JOIN console_credentials k ON k.console_id=c.id WHERE c.id=$1 AND k.id=$2 AND k.kind='FRONTEND' AND k.revoked_at IS NULL AND c.user_id IS NOT NULL FOR UPDATE OF c,k",[frontend.id,frontend.credential_id])).rows[0];
        const temporary=(await sql.query('SELECT id,device_id,client_kind,firmware,firmware_checked_at,user_id FROM consoles WHERE id=$1 FOR UPDATE',[pair.console_id])).rows[0];
        if(!target||!temporary||temporary.user_id||temporary.id===target.id)throw new AppError('INVALID_AGENT_PAIRING',409);
        if(bound&&bound.console_id!==target.id)throw new AppError('HARDWARE_IDENTITY_MISMATCH',409);
        pair.console_id=target.id;
        await sql.query('UPDATE pairings SET console_id=$1 WHERE id=$2',[target.id,pair.id]);
        await sql.query('DELETE FROM consoles WHERE id=$1',[temporary.id]);
        await sql.query("UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='AGENT' AND revoked_at IS NULL",[target.id]);
        await sql.query('UPDATE consoles SET device_id=$2,client_kind=$3,firmware=COALESCE($4,firmware),firmware_checked_at=COALESCE($5,firmware_checked_at) WHERE id=$1',[target.id,temporary.device_id,temporary.client_kind,temporary.firmware,temporary.firmware_checked_at]);
      }else if(pair.kind==='FRONTEND') {
        if(body.consoleId){
          if(!(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE',[body.consoleId,user.id])).rowCount)throw new AppError('NOT_FOUND',404);
          pair.console_id=body.consoleId;
        }else{
          pair.console_id=randomUUID();
          await sql.query("INSERT INTO consoles(id,device_id,user_id,name,client_kind) VALUES($1,$2,$3,'My PS5','PS5')",[pair.console_id,randomUUID(),user.id]);
        }
      } else {
        if(body.consoleId){
          if(!pair.hardware_lookup_hash)throw new AppError('HARDWARE_IDENTITY_REQUIRED',409);
          const target=(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE',[body.consoleId,user.id])).rows[0];
          const temporary=(await sql.query('SELECT id,device_id,client_kind,firmware,firmware_checked_at,user_id FROM consoles WHERE id=$1 FOR UPDATE',[pair.console_id])).rows[0];
          if(!target)throw new AppError('NOT_FOUND',404);if(!temporary||temporary.user_id||temporary.id===target.id)throw new AppError('INVALID_AGENT_PAIRING',409);
          if(bound&&bound.console_id!==target.id)throw new AppError('HARDWARE_IDENTITY_MISMATCH',409);
          pair.console_id=target.id;await sql.query('UPDATE pairings SET console_id=$1 WHERE id=$2',[target.id,pair.id]);await sql.query('DELETE FROM consoles WHERE id=$1',[temporary.id]);
          await sql.query("UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='AGENT' AND revoked_at IS NULL",[target.id]);
          await sql.query('UPDATE consoles SET device_id=$2,client_kind=$3,firmware=COALESCE($4,firmware),firmware_checked_at=COALESCE($5,firmware_checked_at) WHERE id=$1',[target.id,temporary.device_id,temporary.client_kind,temporary.firmware,temporary.firmware_checked_at]);
        }else{
          if(bound)throw new AppError('CONSOLE_ALREADY_REGISTERED',409,'Choose the existing PS5 to reconnect it.');
          await sql.query('UPDATE consoles SET user_id=$1 WHERE id=$2', [user.id, pair.console_id]);
        }
      }
      if(pair.kind==='AGENT'&&pair.hardware_lookup_hash)await bindHardware(sql,pair.console_id,pair.hardware_lookup_hash);
      const credential=secret(),credentialId=randomUUID();
      await sql.query('INSERT INTO console_credentials(id,console_id,token_hash,kind,frontend_device_id) VALUES($1,$2,$3,$4,$5)',[credentialId,pair.console_id,hash(credential),pair.kind,pair.frontend_device_id]);
      await sql.query('UPDATE pairings SET claimed_at=now(),credential_cipher=$1,console_id=$3,credential_id=$4 WHERE id=$2', [seal(credential, config.BOOTSTRAP_TOKEN), pair.id,pair.console_id,credentialId]);
      await sql.query('UPDATE users SET default_console_id=COALESCE(default_console_id,$1) WHERE id=$2', [pair.console_id, user?.id??frontend.user_id]);
      return { consoleId: pair.console_id };
    });
  });
  app.post('/api/v1/pairings/:id/poll', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async req => {
    const id = uuid.parse((req.params as { id: string }).id);
    const pollSecret = z.object({ pollSecret: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body).pollSecret;
    const pair = (await db.query('SELECT * FROM pairings WHERE id=$1 AND expires_at>now()', [id])).rows[0];
    if (!pair || !sameSecret(pair.poll_hash, hash(pollSecret))) throw new AppError('PAIRING_EXPIRED', 410);
    if (!pair.claimed_at) return { status: 'PENDING' };
    if(pair.credential_id&&!(await db.query('SELECT id FROM console_credentials WHERE id=$1 AND revoked_at IS NULL',[pair.credential_id])).rowCount)throw new AppError('PAIRING_EXPIRED',410);
    if (!pair.credential_cipher) throw new AppError('CREDENTIAL_ALREADY_ACKNOWLEDGED', 409);
    let recoveryToken:string|undefined;const identity=(await db.query('SELECT lookup_hash,nonce FROM console_hardware_identities WHERE console_id=$1 AND recovery_disabled_at IS NULL',[pair.console_id])).rows[0];if(identity)recoveryToken=hardwareRecoveryToken(identity.lookup_hash,identity.nonce,config.BOOTSTRAP_TOKEN);
    return { status: 'PAIRED', consoleId: pair.console_id, credential: unseal(pair.credential_cipher, config.BOOTSTRAP_TOKEN),recoveryToken };
  });
  const listConsoles = async (user: any) => {
    const rows = (await db.query(`SELECT c.*,COALESCE(k.capabilities,'{}') AS capabilities,
      (SELECT count(DISTINCT r.game_id)::int FROM console_library_entries l JOIN game_releases r ON r.id=l.release_id WHERE l.console_id=c.id AND l.state='READY_ON_PS5') AS games,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('storageId',s.storage_id,'displayName',s.display_name,'totalBytes',s.total_bytes,'freeBytes',s.free_bytes,'writable',s.writable,'installMethodsSupported',s.methods) ORDER BY s.display_name,s.storage_id) FROM console_storage_volumes s WHERE s.console_id=c.id AND (s.writable OR jsonb_array_length(s.methods)>0)),'[]') AS storage
      FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.user_id=$1 ORDER BY c.created_at`, [user.id])).rows;
    return rows.map(c => ({ id: c.id, name: c.name, clientKind: c.client_kind, firmware: c.firmware, runtime: c.runtime, runtimeStatus:c.runtime_status, lastSeen: c.last_seen, presence: presence(c.last_seen ? new Date(c.last_seen).getTime() : null), games: c.games, storage: c.storage, capabilities: c.capabilities, isDefault: user.default_console_id === c.id }));
  };
  app.get('/api/v1/consoles', async req => listConsoles(await auth.user(req)));
  app.post('/api/v1/consoles/:id/remote-play/pairing',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const user=await auth.user(req),consoleId=uuid.parse((req.params as {id:string}).id),requestId=randomUUID();
    const row=await transaction(db,async sql=>{
      const console=(await sql.query(`SELECT c.last_seen,c.remote_play_pairing_state,c.remote_play_pairing_expires_at,COALESCE(k.capabilities,'{}'::jsonb) AS capabilities
        FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c`,[consoleId,user.id])).rows[0];
      if(!console)throw new AppError('NOT_FOUND',404);
      if(console.capabilities.remotePlayPairing!==true)throw new AppError('CAPABILITY_UNAVAILABLE',409,'This PS5 has not reported native Remote Play pairing support.');
      if(presence(console.last_seen?new Date(console.last_seen).getTime():null)!=='ONLINE')throw new AppError('CONSOLE_OFFLINE',409,'The PS5 agent must be online to request a Remote Play PIN.');
      if(['REQUESTED','READY'].includes(console.remote_play_pairing_state)&&new Date(console.remote_play_pairing_expires_at).getTime()>Date.now())throw new AppError('REMOTE_PLAY_PAIRING_ACTIVE',409);
      return (await sql.query(`UPDATE consoles SET remote_play_pairing_id=$2,remote_play_pairing_state='REQUESTED',remote_play_pairing_cipher=NULL,remote_play_pairing_error=NULL,
        remote_play_pairing_expires_at=now()+interval '5 minutes',remote_play_pairing_updated_at=now() WHERE id=$1
        RETURNING remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_expires_at AS "expiresAt"`,[consoleId,requestId])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.get('/api/v1/consoles/:id/remote-play/pairing/:requestId',async req=>{
    const user=await auth.user(req),params=req.params as {id:string;requestId:string},consoleId=uuid.parse(params.id),requestId=uuid.parse(params.requestId);
    let row=(await db.query(`SELECT remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_cipher AS cipher,
      remote_play_pairing_error AS error,remote_play_pairing_expires_at AS "expiresAt",remote_play_pairing_updated_at AS "updatedAt"
      FROM consoles WHERE id=$1 AND user_id=$2 AND remote_play_pairing_id=$3`,[consoleId,user.id,requestId])).rows[0];
    if(!row)throw new AppError('NOT_FOUND',404);
    if(['REQUESTED','READY'].includes(row.state)&&new Date(row.expiresAt).getTime()<=Date.now())row=(await db.query(`UPDATE consoles SET remote_play_pairing_state='ERROR',remote_play_pairing_cipher=NULL,
      remote_play_pairing_error='REMOTE_PLAY_PAIRING_EXPIRED',remote_play_pairing_updated_at=now() WHERE id=$1 AND remote_play_pairing_id=$2
      RETURNING remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_cipher AS cipher,remote_play_pairing_error AS error,
      remote_play_pairing_expires_at AS "expiresAt",remote_play_pairing_updated_at AS "updatedAt"`,[consoleId,requestId])).rows[0];
    const result:{id:string;state:string;expiresAt:Date;updatedAt:Date;error?:string;pin?:string;accountId?:string}={id:row.id,state:row.state,expiresAt:row.expiresAt,updatedAt:row.updatedAt};
    if(row.error)result.error=row.error;
    if(row.state==='READY'&&row.cipher)Object.assign(result,z.object({pin:z.string().regex(/^\d{8}$/),accountId:remotePlayAccountId}).parse(JSON.parse(unseal(row.cipher,config.BOOTSTRAP_TOKEN))));
    return result;
  });
  app.get('/api/v1/device/remote-play/pairing',async req=>{
    const device=await auth.device(req);
    await db.query(`UPDATE consoles SET remote_play_pairing_state='ERROR',remote_play_pairing_cipher=NULL,
      remote_play_pairing_error='REMOTE_PLAY_PAIRING_EXPIRED',remote_play_pairing_updated_at=now()
      WHERE id=$1 AND remote_play_pairing_state IN ('REQUESTED','READY') AND remote_play_pairing_expires_at<=now()`,[device.id]);
    const row=(await db.query(`SELECT remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_expires_at AS "expiresAt"
      FROM consoles WHERE id=$1 AND remote_play_pairing_state IN ('REQUESTED','READY') AND remote_play_pairing_expires_at>now()`,[device.id])).rows[0];
    return row??null;
  });
  app.post('/api/v1/device/remote-play/pairing/:requestId',async req=>{
    const device=await auth.device(req),requestId=uuid.parse((req.params as {requestId:string}).requestId),body=remotePlayReport.parse(req.body);
    await transaction(db,async sql=>{
      const row=(await sql.query('SELECT remote_play_pairing_state AS state FROM consoles WHERE id=$1 AND remote_play_pairing_id=$2 AND remote_play_pairing_expires_at>now() FOR UPDATE',[device.id,requestId])).rows[0];
      if(!row)throw new AppError('REMOTE_PLAY_PAIRING_EXPIRED',410);
      if(body.state==='READY'&&row.state!=='REQUESTED'||body.state==='PAIRED'&&row.state!=='READY'||body.state==='ERROR'&&!['REQUESTED','READY'].includes(row.state))throw new AppError('INVALID_PAIRING_STATE',409);
      const cipher=body.state==='READY'?seal(JSON.stringify({pin:body.pin,accountId:body.accountId}),config.BOOTSTRAP_TOKEN):null;
      const error=body.state==='ERROR'?body.error:null;
      await sql.query(`UPDATE consoles SET remote_play_pairing_state=$3,remote_play_pairing_cipher=$4,remote_play_pairing_error=$5,remote_play_pairing_updated_at=now()
        WHERE id=$1 AND remote_play_pairing_id=$2`,[device.id,requestId,body.state,cipher,error]);
    });
    return {ok:true};
  });
  for(const device of [false,true])app.post(`/api/v1/${device?'device/':''}consoles/:id/refresh`,async(req,reply)=>{
    const owner=device?(await auth.device(req)).user_id:(await auth.user(req)).id,id=uuid.parse((req.params as {id:string}).id);
    const row=(await db.query('UPDATE consoles SET firmware_request_id=COALESCE(firmware_request_id,$3) WHERE id=$1 AND user_id=$2 RETURNING firmware_request_id',[id,owner,randomUUID()])).rows[0];
    if(!row)throw new AppError('NOT_FOUND',404);return reply.code(202).send({requestId:row.firmware_request_id});
  });
  app.post('/api/v1/device/firmware',async req=>{
    const device=await auth.device(req),body=z.object({firmware:firmware.nullable(),requestId:uuid}).parse(req.body);
    if(!(await db.query('UPDATE consoles SET firmware=$2,firmware_checked_at=now(),firmware_request_id=NULL WHERE id=$1 AND firmware_request_id=$3',[device.id,body.firmware,body.requestId])).rowCount)throw new AppError('FIRMWARE_REFRESH_NOT_REQUESTED',409);
    return {ok:true};
  });
  app.get('/api/v1/device/consoles', async req => {
    const device = await auth.device(req);
    return listConsoles((await db.query('SELECT id,default_console_id FROM users WHERE id=$1', [device.user_id])).rows[0]);
  });
  app.patch('/api/v1/consoles/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ name: z.string().min(1).max(80).optional(), isDefault: z.boolean().optional() }).parse(req.body);
    return transaction(db, async sql => {
      if (!(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rowCount) throw new AppError('NOT_FOUND', 404);
      if (body.name) await sql.query('UPDATE consoles SET name=$1 WHERE id=$2', [body.name, id]);
      if (body.isDefault) await sql.query('UPDATE users SET default_console_id=$1 WHERE id=$2', [id, user.id]);
      return { ok: true };
    });
  });
  app.post('/api/v1/consoles/:id/notifications/test',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const user=await auth.user(req),consoleId=uuid.parse((req.params as {id:string}).id);
    const found=(await db.query("SELECT COALESCE(k.capabilities,'{}'::jsonb) AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2",[consoleId,user.id])).rows[0];
    if(!found)throw new AppError('NOT_FOUND',404);
    if(found.capabilities.nativeNotifications!==true)throw new AppError('CAPABILITY_UNAVAILABLE',409,'This PS5 has not reported native notification support.');
    const id=randomUUID();
    await db.query("INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message,resolve_on_delivery) VALUES($1,$2,$3,NULL,'NATIVE_TEST',$4,'PS5Library native notifications are connected.',true)",[id,user.id,consoleId,randomUUID()]);
    return reply.code(202).send({id});
  });
  app.post('/api/v1/consoles/:id/revoke', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    return transaction(db,async sql=>{if(!(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id])).rowCount)throw new AppError('NOT_FOUND',404);await sql.query('UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1',[id]);await sql.query('UPDATE console_hardware_identities SET recovery_disabled_at=now() WHERE console_id=$1',[id]);return {ok:true};});
  });
  app.delete('/api/v1/admin/consoles/:id',async req=>{
    const user=await auth.user(req);if(user.role!=='ADMIN')throw new AppError('FORBIDDEN',403);
    const id=uuid.parse((req.params as {id:string}).id);
    return transaction(db,async sql=>{
      const console=(await sql.query('SELECT c.id,i.lookup_hash FROM consoles c LEFT JOIN console_hardware_identities i ON i.console_id=c.id WHERE c.id=$1 FOR UPDATE OF c',[id])).rows[0];if(!console)throw new AppError('NOT_FOUND',404);
      const temporary=console.lookup_hash?(await sql.query('SELECT console_id FROM pairings WHERE hardware_lookup_hash=$1 AND console_id<>$2',[console.lookup_hash,id])).rows:[];
      await sql.query('DELETE FROM pairings WHERE console_id=$1 OR hardware_lookup_hash=$2',[id,console.lookup_hash]);
      await sql.query('UPDATE users SET default_console_id=NULL WHERE default_console_id=$1',[id]);
      await sql.query(`DELETE FROM save_imports WHERE console_id=$1 OR archive_id IN (SELECT id FROM portable_save_archives WHERE console_id=$1)
        OR rollback_backup_id IN (SELECT id FROM save_backups WHERE console_id=$1)`,[id]);
      await sql.query('DELETE FROM installations WHERE console_id=$1',[id]);
      await sql.query('DELETE FROM native_download_grants WHERE job_id IN (SELECT id FROM jobs WHERE console_id=$1)',[id]);
      await sql.query('DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE console_id=$1)',[id]);
      await sql.query('DELETE FROM jobs WHERE console_id=$1',[id]);
      await sql.query('DELETE FROM console_notices WHERE console_id=$1',[id]);
      await sql.query('DELETE FROM console_library_entries WHERE console_id=$1',[id]);
      await sql.query('DELETE FROM consoles WHERE id=$1',[id]);
      for(const row of temporary)await sql.query('DELETE FROM consoles c WHERE c.id=$1 AND c.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM pairings p WHERE p.console_id=c.id)',[row.console_id]);
      return {ok:true};
    });
  });
  const library = async (userId: string, id: string) => {
    if (!(await db.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2', [id, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    return (await db.query('SELECT l.*,g.title,g.title_id,r.version,k.capabilities FROM console_library_entries l JOIN game_releases r ON r.id=l.release_id JOIN games g ON g.id=r.game_id LEFT JOIN console_capabilities k ON k.console_id=l.console_id WHERE l.console_id=$1', [id])).rows.map(r => ({ releaseId: r.release_id, title: r.title, titleId: r.title_id, version: r.version, storageId: r.storage_id, state: r.state, registered: r.registered, backportProfileId: r.backport_profile_id, source:r.source, backportFiles:r.backport_files,canDelete:removalSupported(r,r.capabilities) }));
  };
  app.get('/api/v1/consoles/:id/library', async req => library((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)));
  app.get('/api/v1/device/consoles/:id/library', async req => library((await auth.device(req)).user_id, uuid.parse((req.params as { id: string }).id)));
  app.post('/api/v1/device/launch-traces',{bodyLimit:launchTraceByteLimit},async(req,reply)=>{
    const device=await auth.device(req),trace=launchTraceSchema.parse(req.body),encoded=JSON.stringify(trace);
    if(Buffer.byteLength(encoded)>launchTraceByteLimit)throw new AppError('TRACE_TOO_LARGE',413);
    const sha256=createHash('sha256').update(encoded).digest('hex');
    const stored=await transaction(db,async sql=>{
      await sql.query('SELECT id FROM consoles WHERE id=$1 FOR UPDATE',[device.id]);
      const existing=(await sql.query(`SELECT id,created_at AS "createdAt" FROM console_heartbeats WHERE console_id=$1 AND payload->>'launchTraceSha256'=$2 ORDER BY id DESC LIMIT 1`,[device.id,sha256])).rows[0];
      if(existing)return {...existing,created:false};
      const row=(await sql.query('INSERT INTO console_heartbeats(console_id,payload) VALUES($1,$2) RETURNING id,created_at AS "createdAt"',[device.id,{launchTrace:trace,launchTraceSha256:sha256}])).rows[0];
      if(trace.mdbgExceptionStop){
        const matches=(await sql.query(`SELECT j.id AS job_id,j.release_id,j.storage_id
          FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id
          JOIN artifacts a ON a.id=j.artifact_id AND a.release_id=j.release_id
          JOIN console_library_entries l ON l.console_id=j.console_id AND l.release_id=j.release_id AND l.storage_id=j.storage_id
          WHERE j.console_id=$1 AND j.kind='TRANSFER' AND j.state='READY_ON_PS5' AND g.title_id=$2 AND l.state='READY_ON_PS5'
            AND ((j.config->>'method'='FPKG' AND a.inspection#>>'{installedImage,sha256}'=l.sha256 AND a.inspection#>>'{installedImage,size}'=l.size::text)
              OR (j.config->>'method'<>'FPKG' AND a.sha256=l.sha256 AND a.size=l.size))
            AND l.backport_profile_id IS NOT DISTINCT FROM COALESCE((j.config#>>'{backport,profile,id}')::uuid,a.profile_id)
            AND l.backport_files=COALESCE(j.config#>>'{backport,placement}'='SCAN_PATH',false)
          ORDER BY j.id LIMIT 2 FOR UPDATE OF j,l`,[device.id,trace.titleId])).rows;
        if(matches.length===1){
          const failed=matches[0];
          const launchFailure={traceSha256:sha256,state:trace.state,observedAtUnixMs:trace.mdbgExceptionObservedAtUnixMs??trace.traceCompletedAtUnixMs};
          await sql.query("UPDATE jobs SET config=config||jsonb_build_object('launchFailure',$2::jsonb) WHERE id=$1",[failed.job_id,JSON.stringify(launchFailure)]);
          await sql.query("UPDATE console_library_entries SET state='ERROR',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='READY_ON_PS5'",[device.id,failed.release_id,failed.storage_id]);
        }
      }
      return {...row,created:true};
    });
    return reply.code(stored.created?201:200).send({id:stored.id,sha256,createdAt:stored.createdAt});
  });
  app.get('/api/v1/consoles/:id/launch-traces',async req=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id),query=z.object({limit:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(req.query);
    if(!(await db.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2',[id,user.id])).rowCount)throw new AppError('NOT_FOUND',404);
    return (await db.query(`SELECT id,payload->>'launchTraceSha256' AS sha256,payload->'launchTrace' AS trace,created_at AS "createdAt" FROM console_heartbeats WHERE console_id=$1 AND payload ? 'launchTrace' ORDER BY id DESC LIMIT $2`,[id,query.limit])).rows;
  });
  const heartbeat = async (device: any, raw: unknown) => {
    const body = heartbeatSchema.parse(raw);
    for (const item of body.inventory ?? []) item.relativePath.split('/').forEach(safeName);
    const storageIds=new Set(body.storage.map(storage=>storage.storageId));
    if(body.inventory?.some(item=>!storageIds.has(item.storageId)))throw new AppError('UNKNOWN_STORAGE');
    const saveScanId=body.saveData?randomUUID():null;
    await transaction(db, async sql => {
      const current = body.inventory?(await sql.query('SELECT library_revision FROM consoles WHERE id=$1 FOR UPDATE', [device.id])).rows[0]:null;
      // Older clients can initialize a missing registration measurement once.
      await sql.query('UPDATE consoles SET last_seen=now(),firmware=CASE WHEN firmware_checked_at IS NULL THEN $2 ELSE firmware END,firmware_checked_at=COALESCE(firmware_checked_at,now()),runtime=$3,client_version=$4,agent_version=$5,shadowmount_version=$6,shadowmount_fakelib=$7,standalone_backpork=$8,runtime_status=$9 WHERE id=$1', [device.id, body.firmware??null, body.runtime, body.clientVersion, body.agentVersion, body.shadowMountVersion, body.shadowMountFakelib, body.standaloneBackPork, body.runtimeStatus]);
      if(body.trophySummary)await sql.query('UPDATE consoles SET trophy_summary=$2::jsonb,trophy_synced_at=now() WHERE id=$1 AND trophy_summary IS DISTINCT FROM $2::jsonb',[device.id,body.trophySummary]);
      if(body.saveData){
        await sql.query(`INSERT INTO console_save_data(console_id,local_user_id,platform,game_title_id,save_title_id,directory,title,subtitle,detail,size_bytes,modified_at,scan_id)
          SELECT $1,$2,item.platform,item."gameTitleId",item."saveTitleId",item.directory,item.title,item.subtitle,item.detail,item."sizeBytes",item."modifiedAt",$4
          FROM jsonb_to_recordset($3::jsonb) AS item(platform text,"gameTitleId" text,"saveTitleId" text,directory text,title text,subtitle text,detail text,"sizeBytes" bigint,"modifiedAt" bigint)
          ON CONFLICT(console_id,local_user_id,platform,save_title_id,directory) DO UPDATE SET game_title_id=EXCLUDED.game_title_id,title=EXCLUDED.title,subtitle=EXCLUDED.subtitle,detail=EXCLUDED.detail,size_bytes=EXCLUDED.size_bytes,modified_at=EXCLUDED.modified_at,scan_id=EXCLUDED.scan_id,updated_at=now()
          WHERE (console_save_data.game_title_id,console_save_data.title,console_save_data.subtitle,console_save_data.detail,console_save_data.size_bytes,console_save_data.modified_at) IS DISTINCT FROM (EXCLUDED.game_title_id,EXCLUDED.title,EXCLUDED.subtitle,EXCLUDED.detail,EXCLUDED.size_bytes,EXCLUDED.modified_at)`,
          [device.id,body.saveData.localUserId,JSON.stringify(body.saveData.items),saveScanId]);
        if(body.saveData.complete)await sql.query(`DELETE FROM console_save_data saved WHERE console_id=$1 AND local_user_id=$2 AND NOT EXISTS(
          SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS seen(platform text,"saveTitleId" text,directory text)
          WHERE seen.platform=saved.platform AND seen."saveTitleId"=saved.save_title_id AND seen.directory=saved.directory)`,[device.id,body.saveData.localUserId,JSON.stringify(body.saveData.items)]);
      }
      await sql.query('INSERT INTO console_capabilities(console_id,capabilities) VALUES($1,$2) ON CONFLICT(console_id) DO UPDATE SET capabilities=EXCLUDED.capabilities WHERE console_capabilities.capabilities IS DISTINCT FROM EXCLUDED.capabilities', [device.id, body.capabilities]);
      await sql.query("INSERT INTO console_heartbeats(console_id,payload) VALUES($1,$2) ON CONFLICT(console_id) WHERE NOT(payload ? 'launchTrace') DO UPDATE SET payload=EXCLUDED.payload,created_at=now() WHERE console_heartbeats.payload IS DISTINCT FROM EXCLUDED.payload", [device.id, { ...body, inventory: undefined,libraryRevision:undefined }]);
      await sql.query("UPDATE pairings SET credential_cipher=NULL WHERE console_id=$1 AND kind='AGENT' AND credential_cipher IS NOT NULL", [device.id]);
      await sql.query("UPDATE console_storage SET writable=false,methods='[]'::jsonb,total_bytes=0,free_bytes=0 WHERE console_id=$1 AND NOT(storage_id=ANY($2::text[])) AND (writable OR methods<>'[]'::jsonb OR total_bytes<>0 OR free_bytes<>0)", [device.id, body.storage.map(s=>s.storageId)]);
      await sql.query(`INSERT INTO console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods)
        SELECT $1,storage."storageId",storage."displayName",storage.path,storage."totalBytes",storage."freeBytes",storage.writable,storage."installMethodsSupported"
        FROM jsonb_to_recordset($2::jsonb) AS storage("storageId" text,"displayName" text,path text,"totalBytes" bigint,"freeBytes" bigint,writable boolean,"installMethodsSupported" jsonb)
        ON CONFLICT(console_id,storage_id) DO UPDATE SET display_name=EXCLUDED.display_name,path=EXCLUDED.path,total_bytes=EXCLUDED.total_bytes,free_bytes=EXCLUDED.free_bytes,writable=EXCLUDED.writable,methods=EXCLUDED.methods,last_seen=now()
        WHERE (console_storage.display_name,console_storage.path,console_storage.total_bytes,console_storage.free_bytes,console_storage.writable,console_storage.methods)
          IS DISTINCT FROM (EXCLUDED.display_name,EXCLUDED.path,EXCLUDED.total_bytes,EXCLUDED.free_bytes,EXCLUDED.writable,EXCLUDED.methods)`,[device.id,JSON.stringify(body.storage)]);
      if (body.inventory && body.libraryRevision > current!.library_revision) {
        const requestedReleaseIds=[...new Set(body.inventory.flatMap(item=>item.releaseId?[item.releaseId]:[]))];
        const releases=requestedReleaseIds.length?(await sql.query(`SELECT r.id,g.title_id AS "titleId",r.content_id AS "contentId",r.version FROM game_releases r JOIN games g ON g.id=r.game_id
          WHERE r.id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM game_read_access access WHERE access.game_id=g.id AND access.user_id=$2)`,[requestedReleaseIds,device.user_id])).rows:[];
        const releaseById=new Map(releases.map(release=>[release.id,release]));
        if(releaseById.size!==requestedReleaseIds.length)throw new AppError('NOT_FOUND',404);
        for(const item of body.inventory)if(item.releaseId){const release=releaseById.get(item.releaseId);if(release.titleId!==item.titleId||release.contentId!==item.contentId||release.version!==item.version)throw new AppError('METADATA_MISMATCH',409);}

        const discovered=body.inventory.filter(item=>!item.releaseId),gameSeeds=[...new Map(discovered.map(item=>[item.titleId,{id:randomUUID(),titleId:item.titleId,title:item.title,metadata:{title:item.title,titleId:item.titleId,contentId:item.contentId,platform:item.platform}}])).values()];
        if(gameSeeds.length)await sql.query(`INSERT INTO games(id,user_id,title_id,title,metadata)
          SELECT seed.id,$2,seed."titleId",seed.title,seed.metadata FROM jsonb_to_recordset($1::jsonb) AS seed(id uuid,"titleId" text,title text,metadata jsonb)
          ON CONFLICT(user_id,title_id) DO NOTHING`,[JSON.stringify(gameSeeds),device.user_id]);
        const gameRows=gameSeeds.length?(await sql.query('SELECT id,title_id AS "titleId" FROM games WHERE user_id=$1 AND title_id=ANY($2::text[])',[device.user_id,gameSeeds.map(seed=>seed.titleId)])).rows:[];
        const gameByTitle=new Map(gameRows.map(game=>[game.titleId,game.id]));
        const releaseKey=(gameId:string,contentId:string,version:string)=>JSON.stringify([gameId,contentId,version]);
        const releaseSeeds=[...new Map(discovered.map(item=>{const gameId=gameByTitle.get(item.titleId)!;return [releaseKey(gameId,item.contentId,item.version),{id:randomUUID(),gameId,contentId:item.contentId,version:item.version,metadata:{format:item.source==='EXISTING_DUMP'?'folder':item.source==='INSTALLED_TITLE'?'pkg':'unknown',minimumFirmware:null,size:item.size,source:item.source}}];})).values()];
        if(releaseSeeds.length)await sql.query(`INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata)
          SELECT seed.id,seed."gameId",seed."contentId",seed.version,'BASE',seed.metadata FROM jsonb_to_recordset($1::jsonb) AS seed(id uuid,"gameId" uuid,"contentId" text,version text,metadata jsonb)
          ON CONFLICT(game_id,content_id,version,kind) DO NOTHING`,[JSON.stringify(releaseSeeds)]);
        const discoveredReleases=releaseSeeds.length?(await sql.query(`SELECT id,game_id AS "gameId",content_id AS "contentId",version FROM game_releases
          WHERE kind='BASE' AND game_id=ANY($1::uuid[])`,[[...new Set(releaseSeeds.map(seed=>seed.gameId))]])).rows:[];
        const discoveredReleaseByKey=new Map(discoveredReleases.map(release=>[releaseKey(release.gameId,release.contentId,release.version),release.id]));
        const profileIds=[...new Set(body.inventory.flatMap(item=>item.backportProfileId?[item.backportProfileId]:[]))];
        const profiles=profileIds.length?(await sql.query(`SELECT p.id,p.title_id AS "titleId",p.content_id AS "contentId",p.game_version AS version FROM compatibility_profiles p
          WHERE p.id=ANY($1::uuid[]) AND (p.user_id=$2 OR EXISTS(SELECT 1 FROM games g JOIN game_read_access access ON access.game_id=g.id WHERE g.user_id=p.user_id AND g.title_id=p.title_id AND access.user_id=$2))`,[profileIds,device.user_id])).rows:[];
        const profileById=new Map(profiles.map(profile=>[profile.id,profile]));
        const resolved=new Map<string,unknown>();
        for(const item of body.inventory){
          const releaseId=item.releaseId??discoveredReleaseByKey.get(releaseKey(gameByTitle.get(item.titleId)!,item.contentId,item.version));
          if(!releaseId)throw new AppError('NOT_FOUND',404);
          const profile=item.backportProfileId?profileById.get(item.backportProfileId):null,staleProfile=!!item.backportProfileId&&(!profile||profile.titleId!==item.titleId||profile.contentId!==item.contentId||profile.version!==item.version);
          resolved.set(`${releaseId}\0${item.storageId}`,{releaseId,storageId:item.storageId,state:staleProfile?'ERROR':item.available?'READY_ON_PS5':'MISSING',relativePath:item.relativePath,sha256:item.sha256,size:item.size,registered:item.registered,backportProfileId:staleProfile?null:item.backportProfileId??null,source:item.source,backportFiles:staleProfile?false:item.backportFiles});
        }
        const entries=[...resolved.values()];
        if(entries.length)await sql.query(`INSERT INTO console_library_entries(console_id,release_id,storage_id,state,relative_path,sha256,size,registered,backport_profile_id,revision,source,backport_files)
          SELECT $1,observed."releaseId",observed."storageId",CASE WHEN observed.state='READY_ON_PS5' AND EXISTS(SELECT 1 FROM jobs j JOIN artifacts a ON a.id=j.artifact_id AND a.release_id=j.release_id
            WHERE j.console_id=$1 AND j.release_id=observed."releaseId" AND j.storage_id=observed."storageId" AND j.kind='TRANSFER' AND j.state='READY_ON_PS5' AND j.config?'launchFailure'
              AND ((j.config->>'method'='FPKG' AND a.inspection#>>'{installedImage,sha256}'=observed.sha256 AND a.inspection#>>'{installedImage,size}'=observed.size::text)
                OR (j.config->>'method'<>'FPKG' AND a.sha256=observed.sha256 AND a.size=observed.size))
              AND observed."backportProfileId" IS NOT DISTINCT FROM COALESCE((j.config#>>'{backport,profile,id}')::uuid,a.profile_id)
              AND observed."backportFiles"=COALESCE(j.config#>>'{backport,placement}'='SCAN_PATH',false)) THEN 'ERROR' ELSE observed.state END,
            observed."relativePath",observed.sha256,observed.size,observed.registered,observed."backportProfileId",$3,observed.source,observed."backportFiles"
          FROM jsonb_to_recordset($2::jsonb) AS observed("releaseId" uuid,"storageId" text,state text,"relativePath" text,sha256 text,size bigint,registered boolean,"backportProfileId" uuid,source text,"backportFiles" boolean)
          ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET state=EXCLUDED.state,relative_path=EXCLUDED.relative_path,sha256=EXCLUDED.sha256,size=EXCLUDED.size,registered=EXCLUDED.registered,backport_profile_id=EXCLUDED.backport_profile_id,revision=EXCLUDED.revision,source=EXCLUDED.source,backport_files=EXCLUDED.backport_files,updated_at=now()
          WHERE (console_library_entries.state,console_library_entries.relative_path,console_library_entries.sha256,console_library_entries.size,console_library_entries.registered,console_library_entries.backport_profile_id,console_library_entries.source,console_library_entries.backport_files)
            IS DISTINCT FROM (EXCLUDED.state,EXCLUDED.relative_path,EXCLUDED.sha256,EXCLUDED.size,EXCLUDED.registered,EXCLUDED.backport_profile_id,EXCLUDED.source,EXCLUDED.backport_files)`,[device.id,JSON.stringify(entries),body.libraryRevision]);
        if (body.inventoryComplete) await sql.query(`UPDATE console_library_entries item SET state='MISSING',updated_at=now() WHERE console_id=$1 AND state='READY_ON_PS5' AND NOT EXISTS(
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS observed("releaseId" uuid,"storageId" text) WHERE observed."releaseId"=item.release_id AND observed."storageId"=item.storage_id)`, [device.id, JSON.stringify(entries)]);
        await sql.query('UPDATE consoles SET library_revision=$2 WHERE id=$1', [device.id, body.libraryRevision]);
      }
    });
    const current=(await db.query('SELECT firmware_request_id,library_revision FROM consoles WHERE id=$1',[device.id])).rows[0];
    return { ok: true, serverTime: new Date().toISOString(), heartbeatIntervalSeconds: 10,firmwareRequestId:current.firmware_request_id,libraryRevision:Number(current.library_revision) };
  };
  app.post('/api/v1/device/heartbeat', async req => heartbeat(await auth.device(req), req.body));
  app.get('/api/v1/device/status', async req => {
    const c = await auth.device(req);
    return { id: c.id, name: c.name, firmware: c.firmware, runtime: c.runtime, runtimeStatus:c.runtime_status,
      storage: (await db.query("SELECT storage_id AS \"storageId\",display_name AS \"displayName\",path,total_bytes AS \"totalBytes\",free_bytes AS \"freeBytes\",writable FROM console_storage_volumes WHERE console_id=$1 AND (writable OR jsonb_array_length(methods)>0) ORDER BY display_name,storage_id", [c.id])).rows,
      library: (await db.query('SELECT release_id AS "releaseId",state,storage_id AS "storageId",relative_path AS "relativePath",registered,source,backport_files AS "backportFiles" FROM console_library_entries WHERE console_id=$1', [c.id])).rows };
  });
  app.get('/api/v1/device/live', { websocket: true, preValidation:async req=>{await auth.device(req);} }, (socket, req) => {
    let busy=false;
    socket.on('message', async raw => {
      if(busy)return socket.close(1008,'Heartbeat already pending');
      busy=true;
      try{const device=await auth.device(req);socket.send(JSON.stringify(await heartbeat(device,JSON.parse(raw.toString()))));}
      catch{socket.close(1008,'Invalid heartbeat or credential');}
      finally{busy=false;}
    });
  });
}
