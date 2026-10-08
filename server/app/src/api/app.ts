import Fastify, {type FastifyRequest} from 'fastify';
import {request as httpRequest} from 'node:http';
import {accessibleSource} from '../sources/access.js';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database, migrate, transaction } from '../db.js';
import type { Config } from '../config.js';
import { authentication, authRoutes } from '../auth/routes.js';
import {hash} from '../auth/credentials.js';
import { profileRoutes } from '../auth/profile.js';
import { trailerRoutes } from '../artwork/trailers.js';
import { consoleRoutes } from '../consoles/routes.js';
import { removalRoutes } from '../consoles/removals.js';
import { saveBackupRoutes } from '../consoles/save-backups.js';
import { catalogRoutes } from '../catalog/routes.js';
import { updateRoutes } from '../updates/routes.js';
import { transferRoutes } from '../transfers/routes.js';
import { queuedJobControlAllowed, reorderQueuedJobs, startRunner } from '../jobs/runner.js';
import { packageBuildAllowed, preparationRoutes } from '../jobs/preparation.js';
import { installationRoutes } from '../jobs/installations.js';
import { jobEvent, jobJSON, liveJobEvents } from '../jobs/events.js';
import { AppError } from '../security/errors.js';
import { uuid } from '../../../shared/schemas/index.js';
import { readLogs,serverLogger, type LogLevel } from '../logging.js';
import {communityRoutes} from '../community/routes.js';
import {communitySaveRoutes} from '../community/saves.js';
import {quotaExceeded,storageUsage} from '../storage/usage.js';
import {managedService,operatorStatus,restartManagedService} from '../operator-client.js';
import {cheatProfileRoutes} from '../cheats/profiles.js';
import {cheatDeliveryRoutes} from '../cheats/deliveries.js';

const packageWorkerStatus=(config:Pick<Config,'PACKAGE_WORKER_SOCKET'|'PACKAGE_WORKER_URL'|'PACKAGE_WORKER_TOKEN'>)=>new Promise<{status:'CONNECTED'|'OFFLINE';latencyMs:number}>(resolve=>{
  const started=process.hrtime.bigint();let settled=false;
  const finish=(status:'CONNECTED'|'OFFLINE')=>{if(settled)return;settled=true;resolve({status,latencyMs:Math.round(Number(process.hrtime.bigint()-started)/1e6)});};
  const receive=(response:import('node:http').IncomingMessage)=>{response.resume();response.on('end',()=>finish(response.statusCode===200?'CONNECTED':'OFFLINE'));};
  const request=config.PACKAGE_WORKER_URL?httpRequest(new URL('/health',config.PACKAGE_WORKER_URL),{method:'GET',timeout:1000,headers:{authorization:`Bearer ${config.PACKAGE_WORKER_TOKEN}`}},receive):httpRequest({socketPath:config.PACKAGE_WORKER_SOCKET,path:'/health',method:'GET',timeout:1000},receive);
  request.on('timeout',()=>request.destroy());request.on('error',()=>finish('OFFLINE'));request.end();
});
const newWorkRoutes=new Set(['/api/v1/downloads','/api/v1/device/downloads','/api/v1/preparations','/api/v1/device/preparations','/api/v1/installations','/api/v1/device/installations','/api/v1/transfers','/api/v1/device/transfers']);
const ipLimitedRoutes=new Set(['/api/v1/auth/register','/api/v1/auth/login','/api/v1/pairings','/api/v1/frontend/pairings','/api/v1/pairings/claim','/api/v1/pairings/:id/poll','/api/v1/hardware/recover']);
export const generalIpBackstopMax=12_000;
export const rateLimitKey=(req:FastifyRequest)=>{
  const route=req.routeOptions.url??req.url.split('?')[0]!;
  if(ipLimitedRoutes.has(route))return `ip:${req.ip}`;
  const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],credential=bearer??req.cookies.session;
  return credential&&/^[a-f0-9]{64}$/.test(credential)?`credential:${hash(credential)}`:`ip:${req.ip}`;
};

export async function createApp(config: Config,overrides:{communityFetch?:typeof fetch;operatorFetch?:typeof fetch}={}) {
  await mkdir(config.DATA_DIR, { recursive: true }); await mkdir(path.join(config.DATA_DIR,'jobs'),{recursive:true}); await mkdir(config.SOURCE_ROOT, { recursive: true });
  const db = database(config.DATABASE_URL);
  await migrate(db);
  const logs=await serverLogger(config.DATA_DIR),startedAt=new Date().toISOString(),requestStarted=new WeakMap<object,bigint>();
  const runner = await startRunner(db, config,logs);
  const trustProxy:boolean|((address:string,hop:number)=>boolean)=config.TRUST_PROXY_HOPS?(_address,hop)=>hop<config.TRUST_PROXY_HOPS:false;
  const app = Fastify({ bodyLimit: 4 * 1024 ** 2, logger: false, trustProxy });
  await app.register(cookie);
  await app.register(rateLimit, { max: 500, timeWindow: '1 minute',keyGenerator:rateLimitKey });
  app.addHook('onRequest',app.rateLimit({max:generalIpBackstopMax,timeWindow:'1 minute',groupId:'ip-backstop',keyGenerator:req=>`ip:${req.ip}`}));
  await app.register(websocket, { options: { maxPayload: 4 * 1024 ** 2 } });
  app.addHook('onRequest', async (req, reply) => {
    requestStarted.set(req,process.hrtime.bigint());
    reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('x-frame-options','DENY');
    if(config.PUBLIC_URL.startsWith('https:'))reply.header('strict-transport-security','max-age=31536000');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/')||['/','/pair','/profile','/app.js','/style.css'].includes(req.url.split('?')[0]!)) reply.header('cache-control','no-store');
    const route=req.url.split('?')[0]!,rawClient=req.headers['x-ps5library-client'],client=Array.isArray(rawClient)?rawClient[0]:rawClient;
    if(route.startsWith('/api/')&&client==='companion'&&!config.features.companionApp)throw new AppError('COMPANION_APP_DISABLED',403);
    if(route.startsWith('/api/')&&!config.features.ps5Connections&&(client==='ps5'||route.startsWith('/api/v1/device/')||route==='/api/v1/hardware/recover'))throw new AppError('PS5_CONNECTIONS_DISABLED',403);
    if(!config.features.community&&(route.startsWith('/api/v1/community/')||route.startsWith('/api/v1/device/community/')||(req.method==='POST'&&(route.startsWith('/api/v1/admin/community/')||route.startsWith('/api/v1/portable-saves/')&&route.endsWith('/publish')))))throw new AppError('COMMUNITY_FEATURES_DISABLED',403);
    if(!config.features.newDownloads&&req.method==='POST'&&newWorkRoutes.has(route))throw new AppError('NEW_DOWNLOADS_DISABLED',403);
    if (req.headers.origin && !config.browserOrigins.includes(req.headers.origin)) throw new AppError('ORIGIN_DENIED', 403);
  });
  app.addHook('onResponse',async(req,reply)=>{
    const route=req.routeOptions.url||req.url.split('?')[0]!,started=requestStarted.get(req),statusCode=reply.statusCode;
    if(route==='/health'||route==='/app.js'||route==='/style.css'||(route==='/api/v1/device/events'&&statusCode<400))return;
    const level:LogLevel=statusCode>=500?'ERROR':statusCode>=400?'WARN':'INFO';
    void logs.write(level,'http.request',undefined,{requestId:req.id,method:req.method,route,statusCode,durationMs:started?Math.round(Number(process.hrtime.bigint()-started)/1e6):undefined,range:route.startsWith('/api/v1/native-updates/')?req.headers.range??null:undefined});
  });
  app.setErrorHandler((error: any, req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof AppError) { void logs.write('WARN','http.rejected',error.message,{requestId:req.id,method:req.method,route:req.routeOptions.url,statusCode:error.statusCode,code:error.code}); return reply.code(error.statusCode).send({ error: error.code, message: error.message }); }
    if (error.code === '23505') return reply.code(409).send({ error: 'ALREADY_EXISTS' });
    if (error.code === 'ENOENT') return reply.code(404).send({ error: 'INPUT_NOT_FOUND' });
    if (error.message === 'METADATA_MISMATCH' || error.message === 'UNSAFE_PATH') return reply.code(409).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'REQUEST_REJECTED' });
    void logs.write('ERROR','http.error',error.message,{requestId:req.id,method:req.method,route:req.routeOptions.url,statusCode:500});
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  const auth = authentication(db);
  app.get('/api/v1/service-info',async()=>({service:'ps5library-node',apiVersion:1}));
  await authRoutes(app, db, config, auth);
  await cheatProfileRoutes(app,db,auth);
  await cheatDeliveryRoutes(app,db,auth);
  const admin=async(req:Parameters<typeof auth.user>[0])=>{const user=await auth.user(req);if(user.role!=='ADMIN')throw new AppError('FORBIDDEN',403);return user;};
  app.get('/api/v1/admin/status',async req=>{
    await admin(req);
    const databaseStarted=process.hrtime.bigint();
    const status=(await db.query(`SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM consoles) AS consoles,
      (SELECT count(*)::int FROM consoles WHERE last_seen>now()-interval '30 seconds') AS "onlineConsoles",
      (SELECT count(*)::int FROM sources) AS sources,
      (SELECT count(*)::int FROM jobs WHERE dismissed_at IS NULL AND state NOT IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED')) AS "activeJobs",
      (SELECT count(*)::int FROM jobs WHERE dismissed_at IS NULL AND state='ERROR') AS "failedJobs",
      (SELECT count(*)::int FROM pairings WHERE claimed_at IS NULL AND expires_at>now()) AS "pendingPairings",
      (SELECT COALESCE(sum(size),0) FROM artifacts WHERE deleted_at IS NULL) AS "artifactBytes"`)).rows[0];
    const databaseLatencyMs=Math.round(Number(process.hrtime.bigint()-databaseStarted)/1e6);
    const [redis,worker,control]=await Promise.all([runner.diagnostics().catch(()=>({status:'OFFLINE',latencyMs:null,queue:null})),packageWorkerStatus(config),config.OPERATOR_URL?operatorStatus(config,overrides.operatorFetch).catch(()=>null):null]);
    return {...status,startedAt,uptimeSeconds:Math.floor(process.uptime()),features:config.features,database:'CONNECTED',services:{api:{status:'CONNECTED',uptimeSeconds:Math.floor(process.uptime())},database:{status:'CONNECTED',latencyMs:databaseLatencyMs},redis,worker,operator:{status:control?'CONNECTED':'OFFLINE'}},queue:redis.queue,host:control?.host??null,managedServices:control?.services??[]};
  });
  app.get('/api/v1/admin/accounts',async req=>{
    await admin(req);
    const [users,sessions,devices]=await Promise.all([
      db.query('SELECT id,username,role,created_at AS "createdAt" FROM users ORDER BY created_at'),
      db.query(`SELECT user_id AS "userId",created_at AS "createdAt",last_seen_at AS "lastSeenAt",host(last_ip) AS ip,user_agent AS "userAgent",expires_at AS "expiresAt" FROM sessions WHERE expires_at>now() ORDER BY last_seen_at DESC`),
      db.query(`SELECT c.user_id AS "userId",c.id AS "consoleId",c.device_id AS "deviceId",c.name,c.client_kind AS "clientKind",c.firmware,c.runtime,c.agent_version AS "agentVersion",c.last_seen AS "consoleLastSeen",CASE WHEN c.last_seen>now()-interval '30 seconds' THEN 'ONLINE' WHEN c.last_seen>now()-interval '5 minutes' THEN 'STALE' ELSE 'OFFLINE' END AS presence,k.kind AS "credentialKind",k.last_seen_at AS "lastSeenAt",host(k.last_ip) AS ip,k.revoked_at AS "revokedAt" FROM consoles c JOIN console_credentials k ON k.console_id=c.id WHERE c.user_id IS NOT NULL ORDER BY c.name,k.created_at`),
    ]);
    return users.rows.map(user=>({...user,sessions:sessions.rows.filter(row=>row.userId===user.id),devices:devices.rows.filter(row=>row.userId===user.id)}));
  });
  app.get('/api/v1/admin/logs',async req=>{await admin(req);const query=z.object({limit:z.coerce.number().int().min(1).max(500).default(200),level:z.enum(['INFO','WARN','ERROR']).optional(),service:z.enum(['server','worker']).optional()}).parse(req.query);return readLogs(config.DATA_DIR,query);});
  app.get('/api/v1/admin/jobs',async req=>{await admin(req);const {limit}=z.object({limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(req.query);return (await db.query(`SELECT j.id,j.kind,j.state,j.downloaded_bytes AS "downloadedBytes",j.total_bytes AS "totalBytes",j.speed_bytes_per_second AS "speedBytesPerSecond",j.config->'progress' AS progress,j.error,j.attempts,j.updated_at AS "updatedAt",u.username,g.title
    FROM jobs j JOIN users u ON u.id=j.user_id LEFT JOIN game_releases r ON r.id=j.release_id LEFT JOIN games g ON g.id=r.game_id ORDER BY j.updated_at DESC LIMIT $1`,[limit])).rows;});
  app.delete('/api/v1/admin/logs',async req=>{const user=await admin(req);await logs.clear();await logs.write('WARN','admin.logs_cleared',`Logs cleared by ${user.username}`);return {ok:true};});
  app.post('/api/v1/admin/services/:service/restart',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{
    const user=await admin(req),service=managedService.parse((req.params as {service:string}).service),body=z.object({confirm:z.string()}).strict().parse(req.body);
    if(body.confirm!==service)throw new AppError('CONFIRMATION_REQUIRED',400);
    try{await restartManagedService(config,service,overrides.operatorFetch);}catch(error){throw new AppError(error instanceof Error&&error.message==='SERVICE_NOT_FOUND'?'SERVICE_NOT_FOUND':'OPERATOR_UNAVAILABLE',503);}
    await logs.write('WARN','admin.service_restart',`Service restart requested by ${user.username}`,{target:service,ip:req.ip});return reply.code(202).send({accepted:true,service});
  });
  await communityRoutes(app,db,config,auth,logs,overrides.communityFetch);
  await communitySaveRoutes(app,db,config,auth,logs,overrides.communityFetch);
  await profileRoutes(app, db, config, auth);
  await consoleRoutes(app, db, config, auth);
  await saveBackupRoutes(app,db,config,auth);
  await updateRoutes(app, config, auth,db);
  const transfers = await transferRoutes(app, db, config, auth);
  await trailerRoutes(app,db,config,auth,runner.reconcile);
  const preparation = await preparationRoutes(app, db, config, auth, runner.reconcile);
  await removalRoutes(app,db,auth);
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok', version: '0.1.0' }; });
  for (const [url, file, contentType] of [['/','index.html','text/html'], ['/pair','index.html','text/html'], ['/profile','index.html','text/html'], ['/app.js','app.js','application/javascript'], ['/style.css','style.css','text/css']]) {
    app.get(url!, async (_req, reply) => reply.type(contentType!).send(await readFile(path.resolve('app/public', file!), 'utf8')));
  }
  for(const file of ['space-grotesk-medium.ttf','space-grotesk-bold.ttf'])app.get(`/fonts/${file}`,async(_req,reply)=>reply.type('font/ttf').header('cache-control','public, max-age=31536000, immutable').send(await readFile(path.resolve('app/public/fonts',file))));
  const enqueueDownload = async (userId: string, sourceReleaseId: string, automatic = false) => {
    if(!config.features.newDownloads){if(automatic)return {skipped:true};throw new AppError('NEW_DOWNLOADS_DISABLED',403);}
    const source = await accessibleSource(db,userId,sourceReleaseId);
    if (!source) throw new AppError('NOT_FOUND', 404);
    if (['folder','zip','rar','7z'].includes(source.metadata.format)) throw new AppError('BUILD_REQUIRED', 409);
    if(automatic&&(await db.query("SELECT 1 FROM automatic_preparations WHERE source_release_id=$1 AND input_hash=$2 AND method='DOWNLOAD'",[source.id,source.metadata.sha256])).rowCount)return {skipped:true};
    const result = await transaction(db, async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(3150003)');
      const cached=(await sql.query('SELECT * FROM artifacts WHERE release_id=$1 AND sha256=$2 AND verified',[source.release_id,source.metadata.sha256])).rows[0];
      if(cached){const file=path.join(config.DATA_DIR,cached.relative_path);const fileStat=await stat(file).catch(()=>null);if(fileStat?.isFile()&&fileStat.size===Number(cached.size)){if(automatic)await sql.query("INSERT INTO automatic_preparations(source_release_id,input_hash,method) VALUES($1,$2,'DOWNLOAD') ON CONFLICT DO NOTHING",[source.id,source.metadata.sha256]);return {cached:true,artifactId:cached.id as string};}await sql.query('UPDATE artifacts SET verified=false WHERE id=$1',[cached.id]);if(fileStat)throw new AppError('CACHE_CORRUPT',409);}
      if((await sql.query("SELECT metadata ? 'retiredAt' AS retired FROM source_releases WHERE id=$1 FOR UPDATE",[source.id])).rows[0]?.retired)return {retired:true as const};
      if(automatic && !(await sql.query("INSERT INTO automatic_preparations(source_release_id,input_hash,method) VALUES($1,$2,'DOWNLOAD') ON CONFLICT DO NOTHING RETURNING source_release_id",[source.id,source.metadata.sha256])).rowCount) return {skipped:true};
      const active=(await sql.query("SELECT id FROM jobs WHERE source_release_id=$1 AND user_id=$2 AND kind='DOWNLOAD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED')",[source.id,userId])).rows[0];
      if(active)return {id:active.id as string,cached:false};
      if (quotaExceeded(await storageUsage(sql),source.metadata.size,config.QUOTA_BYTES)) throw new AppError('QUOTA_EXCEEDED', 409);
      const id = randomUUID();
      await sql.query("INSERT INTO jobs(id,user_id,kind,release_id,source_release_id,state,total_bytes,config) VALUES($1,$2,'DOWNLOAD',$3,$4,'QUEUED',$5,$6)", [id, userId, source.release_id, sourceReleaseId, source.metadata.size, { sourceMetadata: source.metadata, sourceConfig: source.config, sourceType: source.type, sourceOwner:source.source_owner }]);
      await jobEvent(sql, id);
      return {id,cached:false};
    });
    if('retired' in result)throw new AppError('SOURCE_RETIRED',409,'Restore this dump before downloading it again.');
    await runner.reconcile(); return result;
  };
  await catalogRoutes(app, db, config, auth, preparation.enqueue, enqueueDownload);
  const installations=await installationRoutes(app,db,auth,preparation,transfers,enqueueDownload);
  app.post('/api/v1/downloads', async (req, reply) => {
    const user = await auth.user(req), body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(user.id, body.sourceReleaseId));
  });
  app.post('/api/v1/device/downloads', async (req, reply) => {
    const consoleInfo = await auth.device(req), body = z.object({ sourceReleaseId: uuid }).parse(req.body);
    return reply.code(202).send(await enqueueDownload(consoleInfo.user_id, body.sourceReleaseId));
  });
  const listJobs = async (userId: string) => (await db.query(`SELECT j.*,g.title,u.role AS viewer_role,a.relative_path AS artifact_path,l.relative_path AS console_path,s.display_name AS storage_name,q.queue_position
    FROM jobs j JOIN users u ON u.id=j.user_id JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id LEFT JOIN artifacts a ON a.id=j.artifact_id
    LEFT JOIN (SELECT id,row_number() OVER(PARTITION BY user_id ORDER BY CASE WHEN state='QUEUED' THEN 1 ELSE 0 END,queue_order NULLS LAST,created_at,id)::int AS queue_position FROM jobs WHERE user_id=$1 AND kind IN ('DOWNLOAD','BUILD') AND desired_state='RUNNING' AND state IN ('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING')) q ON q.id=j.id
    LEFT JOIN console_library_entries l ON l.console_id=j.console_id AND l.release_id=j.release_id AND l.storage_id=j.storage_id
    LEFT JOIN console_storage s ON s.console_id=j.console_id AND s.storage_id=j.storage_id
    WHERE j.user_id=$1 AND j.dismissed_at IS NULL ORDER BY q.queue_position NULLS LAST,j.created_at DESC LIMIT 100`, [userId])).rows.map(row => jobJSON(row, row.viewer_role === 'ADMIN'));
  app.get('/api/v1/jobs', async req => listJobs((await auth.user(req)).id));
  app.get('/api/v1/device/jobs', async req => listJobs((await auth.device(req)).user_id));
  const jobOrder=z.object({ids:z.array(uuid).max(100).refine(ids=>new Set(ids).size===ids.length)}).strict();
  app.post('/api/v1/jobs/reorder',async req=>{const ids=await reorderQueuedJobs(db,(await auth.user(req)).id,jobOrder.parse(req.body).ids);await runner.reconcile();return {ids};});
  app.get('/api/v1/jobs/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    const job = (await db.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [id, user.id])).rows[0];
    if (!job) throw new AppError('NOT_FOUND', 404); return jobJSON(job, user.role === 'ADMIN');
  });
  const controlJob = async (userId: string, id: string, action: 'pause'|'resume'|'cancel'|'retry') => {
    await transaction(db, async sql => {
      const job = (await sql.query('SELECT j.*,u.role AS owner_role FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1 AND j.user_id=$2 AND j.dismissed_at IS NULL FOR UPDATE OF j,u', [id, userId])).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      if(action==='retry'){
        if(job.state!=='ERROR')throw new AppError('UNSUPPORTED_JOB_CONTROL',409);
        if(job.kind==='BUILD'&&!packageBuildAllowed(job.owner_role))throw new AppError('ADMIN_REQUIRED',403);
        const state=job.kind==='TRANSFER'?'QUEUED_FOR_PS5':'QUEUED';
        await sql.query('UPDATE jobs SET desired_state=\'RUNNING\',state=$2,attempts=0,error=NULL,speed_bytes_per_second=0,eta_seconds=NULL,updated_at=now() WHERE id=$1',[id,state]);
        if(job.kind==='TRANSFER')await sql.query("UPDATE console_library_entries SET state='QUEUED_FOR_PS5',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3",[job.console_id,job.release_id,job.storage_id]);
      }else if(job.kind==='TRANSFER'){
        if(action!=='cancel'||['READY_ON_PS5','CANCELLED'].includes(job.state))throw new AppError('UNSUPPORTED_JOB_CONTROL',409);
        await sql.query("UPDATE jobs SET desired_state='CANCELLED',state='CANCELLED',speed_bytes_per_second=0,eta_seconds=NULL,updated_at=now() WHERE id=$1",[id]);
        await sql.query("DELETE FROM console_library_entries WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='QUEUED_FOR_PS5'",[job.console_id,job.release_id,job.storage_id]);
        await sql.query("UPDATE console_library_entries SET state='MISSING',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state NOT IN ('READY_ON_PS5','MISSING')",[job.console_id,job.release_id,job.storage_id]);
      }else{
        if (!queuedJobControlAllowed(job.kind,job.state,action)) throw new AppError('UNSUPPORTED_JOB_CONTROL', 409);
        const desired = action === 'pause' ? 'PAUSED' : action === 'cancel' ? 'CANCELLED' : 'RUNNING',state = desired === 'RUNNING' ? 'QUEUED' : desired;
        await sql.query('UPDATE jobs SET desired_state=$2,state=$3,updated_at=now() WHERE id=$1', [id, desired, state]);
      }
      await jobEvent(sql, id);
    });
    await runner.reconcile(); return { ok: true };
  };
  const jobControl=z.object({action:z.enum(['pause','resume','cancel','retry'])});
  app.post('/api/v1/jobs/:id/control',async req=>controlJob((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id),jobControl.parse(req.body).action));
  app.post('/api/v1/device/jobs/:id/control',async req=>controlJob((await auth.device(req)).user_id,uuid.parse((req.params as {id:string}).id),jobControl.parse(req.body).action));
  const dismissJob=async(userId:string,id:string)=>{
    const result=await db.query(`WITH dismissed AS (
      UPDATE jobs SET dismissed_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND dismissed_at IS NULL AND state IN ('COMPLETED','READY_ON_PS5','ERROR','CANCELLED') RETURNING id
    ), removed AS (
      DELETE FROM job_events e USING dismissed d WHERE e.job_id=d.id
    ) SELECT id FROM dismissed`,[id,userId]);
    if(result.rowCount)return {ok:true};
    if(!(await db.query('SELECT id FROM jobs WHERE id=$1 AND user_id=$2 AND dismissed_at IS NULL',[id,userId])).rowCount)throw new AppError('NOT_FOUND',404);
    throw new AppError('JOB_STILL_ACTIVE',409);
  };
  app.delete('/api/v1/jobs/:id',async req=>dismissJob((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id)));
  app.delete('/api/v1/device/jobs/:id',async req=>dismissJob((await auth.device(req)).user_id,uuid.parse((req.params as {id:string}).id)));
  const events = async (userId: string, after: number) => (await db.query(`SELECT e.id,e.job_id AS "jobId",e.state,CASE WHEN u.role='ADMIN' THEN e.progress ELSE e.progress-'conversion' END AS progress,e.created_at AS "createdAt" FROM job_events e JOIN jobs j ON j.id=e.job_id AND j.user_id=e.user_id AND j.dismissed_at IS NULL JOIN users u ON u.id=e.user_id WHERE e.user_id=$1 AND e.id>$2 ORDER BY e.id LIMIT 500`, [userId, after])).rows;
  app.get('/api/v1/events', async req => {
    const user = await auth.user(req), after = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after;
    return events(user.id, after);
  });
  const liveOwners=new WeakMap<object,string>();
  app.get('/api/v1/events/live',{websocket:true,preValidation:async req=>{liveOwners.set(req,(await auth.user(req)).id);}},(socket,req)=>{
    const ownerId=liveOwners.get(req);liveOwners.delete(req);
    if(!ownerId){socket.close(1008,'Session expired');return;}
    const after=z.object({after:z.coerce.number().int().min(0).default(0)}).parse(req.query).after;
    liveJobEvents(socket,ownerId,after,events,async()=>{if((await auth.user(req)).id!==ownerId)throw new AppError('UNAUTHORIZED',401);});
  });
  app.get('/api/v1/device/events', async req => {
    const after=z.object({after:z.coerce.number().int().min(0).default(0)}).parse(req.query).after;
    return {type:'events',events:await events((await auth.device(req)).user_id,after)};
  });
  await logs.write('INFO','server.initialized',`PS5Library initialized on ${config.HOST}:${config.PORT}`);
  app.addHook('onClose', async () => { await logs.write('INFO','server.stopping');await installations.close(); await runner.close(); await transfers.close(); await db.end();await logs.flush(); });
  return app;
}
