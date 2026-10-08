import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { sourceSchema, releaseSchema, uuid, profileSchema, buildFormats, firmware, type Release } from '../../../shared/schemas/index.js';
import { connector } from '../sources/connectors.js';
import { discoverWatched, watchedMedia } from '../sources/watch.js';
import { accessibleSource, localSourceRoot } from '../sources/access.js';
import { storeTrailer } from '../artwork/trailers.js';
import { fileHash } from '../downloads/stream.js';
import { AppError } from '../security/errors.js';
import { existingWithin } from '../security/paths.js';
import { resolveMetadata } from '../library/policy.js';
import {backportNotice,deterministicProfileFailures,profileDiscoveryContext,profileHash} from '../library/backports.js';
import {runWorker} from '../library/inspect.js';
import { cacheArtwork, fetchArtwork, placeholder } from '../artwork/cache.js';
import {quotaMaximum} from '../storage/usage.js';

export async function catalogFor(db: DB, userId: string, query = '') {
  const games = (await db.query('SELECT g.*,EXISTS(SELECT 1 FROM saved_games s WHERE s.user_id=$1 AND s.game_id=g.id) AS saved FROM games g WHERE EXISTS(SELECT 1 FROM game_read_access access WHERE access.game_id=g.id AND access.user_id=$1) AND (title ILIKE $2 OR title_id ILIKE $2) ORDER BY title LIMIT 500', [userId, `%${query}%`])).rows;
  const trailers=(await db.query('SELECT t.* FROM game_media t JOIN games g ON g.id=t.game_id WHERE EXISTS(SELECT 1 FROM game_read_access access WHERE access.game_id=g.id AND access.user_id=$1)',[userId])).rows;
  const artwork=(await db.query('SELECT a.game_id,a.kind,a.sha256 FROM artwork a JOIN game_read_access access ON access.game_id=a.game_id WHERE access.user_id=$1',[userId])).rows;
  const hashes=new Map(artwork.map(a=>[`${a.game_id}:${a.kind}`,a.sha256]));
  const image=(id:string,kind:string)=>`/api/v1/artwork/${id}/${kind}?v=${hashes.get(`${id}:${kind}`)??'missing'}`;
  const releases = (await db.query(`SELECT r.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',sr.id,'name',s.name,'format',sr.metadata->>'format','size',sr.metadata->'size')) FROM source_releases sr JOIN sources s ON s.id=sr.source_id WHERE sr.release_id=r.id AND NOT (sr.metadata ? 'retiredAt')),'[]') AS sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'format',a.format,'size',a.size,'sha256',a.sha256)) FROM artifacts a WHERE a.release_id=r.id AND a.verified AND a.deleted_at IS NULL),'[]') AS artifacts,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'type',b.type,'size',b.size,'sha256',b.sha256,'inputHash',b.input_hash,'targetFirmware',b.target_firmware,'profileId',b.profile_id,'tested',b.tested)) FROM backport_artifacts b WHERE b.release_id=r.id AND b.deleted_at IS NULL),'[]') AS backports
    FROM game_releases r JOIN games g ON g.id=r.game_id WHERE EXISTS(SELECT 1 FROM game_read_access access WHERE access.game_id=g.id AND access.user_id=$1)
    AND (EXISTS(SELECT 1 FROM source_releases sr WHERE sr.release_id=r.id AND NOT (sr.metadata ? 'retiredAt')) OR EXISTS(SELECT 1 FROM artifacts a WHERE a.release_id=r.id AND a.verified AND a.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM backport_artifacts b WHERE b.release_id=r.id AND b.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM console_library_entries l JOIN consoles c ON c.id=l.console_id WHERE l.release_id=r.id AND l.state='READY_ON_PS5' AND c.user_id=$1))`, [userId])).rows;
  return games.map(g => ({ ...g.metadata, artwork: undefined, id: g.id, title: g.title, titleId: g.title_id, saved: g.saved, shared:g.shared,canManage:g.user_id===userId, addedAt: g.created_at,
    recentlyUpdated:releases.some(r=>r.game_id===g.id&&(r.kind==='UPDATE'||r.kind==='BASE'&&new Date(r.created_at).getTime()>new Date(g.created_at).getTime()+1000)),
    trailerState:trailers.find(t=>t.game_id===g.id&&t.kind==='trailer')?.state??null,
    trailer:trailers.filter(t=>t.game_id===g.id&&t.kind==='trailer'&&t.state==='READY').map(t=>({url:`/api/v1/trailers/${g.id}`,sha256:t.sha256,size:t.size,duration:t.duration}))[0]??null,
    musicState:trailers.find(t=>t.game_id===g.id&&t.kind==='music')?.state??null,
    music:trailers.filter(t=>t.game_id===g.id&&t.kind==='music'&&t.state==='READY').map(t=>({url:`/api/v1/music/${g.id}`,sha256:t.sha256,size:t.size,duration:t.duration}))[0]??null,
    coverUrl: image(g.id,'cover'), heroUrl: image(g.id,'hero'), iconUrl: image(g.id,'icon'),
    screenshotUrls: (g.metadata.artwork?.screenshots ?? []).map((_: unknown, i: number) => image(g.id,`screenshot-${i}`)),
    releases: releases.filter(r => r.game_id === g.id).sort((a,b)=>['BASE','UPDATE','DLC'].indexOf(a.kind)-['BASE','UPDATE','DLC'].indexOf(b.kind)||b.version.localeCompare(a.version)||String(a.metadata.title??'').localeCompare(String(b.metadata.title??''))).map(r => ({ ...r.metadata, id: r.id, contentId: r.content_id, version: r.version, kind: r.kind, sources: r.sources, artifacts: r.artifacts, backports:r.backports })) }));
}
export async function resolveSuccessfulProfileNotices(db:DB,scope:{releaseId:string;consoleIds:string[]},targetFirmware:string,runtime:string,inputHash:string){
  if(!scope.consoleIds.length)return;
  const context=`${targetFirmware}:${runtime}:${inputHash}`;
  const codes=['BACKPORT_NOT_INDEXED','BACKPORT_NO_MATCH','UNSUPPORTED_INPUT','ENCRYPTED_INPUT','INCOMPLETE_INPUT','MISSING_ARCHIVE_PART','CORRUPT_INPUT','INPUT_TOO_LARGE','SOURCE_CHANGED','PROFILE_GENERATION_FAILED','BACKPORT_TARGET_UNVERIFIED','PROFILE_MISMATCH'];
  await db.query("UPDATE console_notices SET resolved_at=now() WHERE release_id=$1 AND console_id=ANY($2::uuid[]) AND resolved_at IS NULL AND context=ANY($3::text[]) AND code=ANY($4::text[])",[scope.releaseId,scope.consoleIds,[context,`profile-v3:${context}`,`profile-v4:${context}`],codes]);
}
export const retryProfileAfterArtifact=(prior:{state:string;updated_at:string|Date}|undefined,artifact:{created_at:string|Date}|undefined)=>
  !!prior&&['ERROR','CANCELLED'].includes(prior.state)&&!!artifact&&new Date(artifact.created_at).getTime()>new Date(prior.updated_at).getTime();
export async function catalogRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth,
  prepare: (userId:string, body:{sourceReleaseId:string;method:'FPKG'|'SHADOWMOUNT';profileId?:string}, automatic?:boolean)=>Promise<unknown>,
  download: (userId:string, sourceId:string, automatic?:boolean)=>Promise<unknown>) {
  type ProfileRequest={sourceReleaseId:string;targetFirmware:string;runtime:string;installationMethod:'FPKG'|'SHADOWMOUNT'};
  const createProfile=async(userId:string,body:ProfileRequest,template?:z.infer<typeof profileSchema>,failureCache?:{releaseId:string;consoleIds:string[]})=>{
    const source=await accessibleSource(db,userId,body.sourceReleaseId);
    if(source.source_owner!==userId)throw new AppError('NOT_FOUND',404);
    if(source.metadata.retiredAt)throw new AppError('SOURCE_RETIRED',409,'Restore this dump from quarantine before generating another profile.');
    const profileInputHash=source.metadata.sourceTreeSha256??source.metadata.sha256;
    let input:string|undefined,explicitBackport=false;
    if(buildFormats.includes(source.metadata.format)&&['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type)){
      const root=localSourceRoot(config,source.type,source.source_owner);input=await existingWithin(root,path.resolve(root,source.metadata.location));
      if(source.metadata.format==='folder'){
        const candidate=path.join(input,'backport'),info=await stat(candidate).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
        if(info){await existingWithin(input,candidate);if(!info.isDirectory())throw new AppError('UNSAFE_PATH',409);explicitBackport=true;}
      }
    }
    const existing=(await db.query("SELECT id,profile FROM compatibility_profiles WHERE user_id=$1 AND title_id=$2 AND content_id=$3 AND game_version=$4 AND target_firmware=$5 AND runtime=$6 AND profile->>'installationMethod'=$7 AND profile->'inputHashes' ? $8 AND profile->>'testedState'<>'UNKNOWN' AND (profile->>'delivery'='INTEGRATED' OR jsonb_array_length(profile->'requiredLibraries')+jsonb_array_length(profile->'requiredPatches')+jsonb_array_length(COALESCE(profile->'requiredFiles','[]'::jsonb))>0) AND (NOT $9::boolean OR jsonb_array_length(COALESCE(profile->'requiredFiles','[]'::jsonb))>0) ORDER BY (profile->>'testedState'='TESTED') DESC,created_at DESC LIMIT 1",[userId,source.metadata.game.titleId,source.metadata.game.contentId,source.metadata.version,body.targetFirmware,body.runtime,body.installationMethod,profileInputHash,explicitBackport])).rows[0];
    if(existing){if(failureCache)await resolveSuccessfulProfileNotices(db,failureCache,body.targetFirmware,body.runtime,profileInputHash);return {...existing,reusable:false};}
    if(failureCache&&!explicitBackport){
      const context=profileDiscoveryContext(body.targetFirmware,body.runtime,profileInputHash),failure=(await db.query('SELECT code FROM console_notices WHERE release_id=$1 AND console_id=ANY($2::uuid[]) AND context=$3 AND resolved_at IS NULL AND code=ANY($4::text[]) ORDER BY created_at DESC LIMIT 1',[failureCache.releaseId,failureCache.consoleIds,context,deterministicProfileFailures])).rows[0];
      if(failure)throw new AppError(failure.code,409);
    }
    if(!buildFormats.includes(source.metadata.format)||!['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type))throw new AppError('UNSUPPORTED_INPUT',422,'Automatic profile discovery requires an owned prepared folder or archive.');
    if(!input){const root=localSourceRoot(config,source.type,source.source_owner);input=await existingWithin(root,path.resolve(root,source.metadata.location));}
    const identity={titleId:source.metadata.game.titleId,contentId:source.metadata.game.contentId,version:source.metadata.version,title:source.metadata.game.title,minimumFirmware:source.metadata.minimumFirmware};
    let raw:unknown=template?{...template,id:undefined,installationMethod:body.installationMethod,testedState:'UNTESTED'}:undefined;
    if(!raw&&source.metadata.format==='folder')raw=await runWorker(['generate-backport-profile',input,JSON.stringify(identity),body.targetFirmware,body.runtime,body.installationMethod,profileInputHash]);
    else if(!raw){
      const staging=path.join(config.DATA_DIR,'jobs',`profile-${randomUUID()}`),maximum=quotaMaximum(source.metadata.installedSize??source.metadata.size*8,config.QUOTA_BYTES);
      await mkdir(path.dirname(staging),{recursive:true});
      try{raw=await runWorker(['generate-backport-profile-archive',input,path.join(staging,'extracted'),JSON.stringify(identity),body.targetFirmware,body.runtime,body.installationMethod,profileInputHash,String(maximum)]);}
      finally{await rm(staging,{recursive:true,force:true});}
    }
    const generated=profileSchema.parse(raw);
    if(!generated.inputHashes.includes(profileInputHash))throw new AppError('SOURCE_CHANGED',409);
    const id=randomUUID(),profile={...generated,inputHashes:[...new Set([source.metadata.sha256,profileInputHash])],id};profileHash(profile);
    await db.query('INSERT INTO compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,userId,profile.titleId,profile.contentId,profile.gameVersion,profile.targetFirmware,profile.runtime,profile]);
    if(failureCache)await resolveSuccessfulProfileNotices(db,failureCache,body.targetFirmware,body.runtime,profileInputHash);
    return {id,profile,reusable:true};
  };
  const save = async (userId: string, id: string, saved: boolean) => {
    if (!(await db.query('SELECT g.id FROM games g JOIN game_read_access access ON access.game_id=g.id WHERE g.id=$1 AND access.user_id=$2', [id, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    if (saved) await db.query('INSERT INTO saved_games(user_id,game_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId,id]);
    else await db.query('DELETE FROM saved_games WHERE user_id=$1 AND game_id=$2', [userId,id]);
    return { saved };
  };
  app.post('/api/v1/games/:id/save', async req => save((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id),z.object({saved:z.boolean()}).parse(req.body).saved));
  app.post('/api/v1/device/games/:id/save', async req => save((await auth.device(req)).user_id,uuid.parse((req.params as {id:string}).id),z.object({saved:z.boolean()}).parse(req.body).saved));
  app.get('/api/v1/catalog', async req => catalogFor(db, (await auth.user(req)).id, z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.get('/api/v1/device/catalog', async req => catalogFor(db, (await auth.device(req)).user_id, z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.patch('/api/v1/games/:id/sharing', async req => {
    const user=await auth.user(req); if(user.role!=='ADMIN')throw new AppError('ADMIN_REQUIRED',403);
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({shared:z.boolean()}).parse(req.body);
    if(!(await db.query('UPDATE games SET shared=$3 WHERE id=$1 AND user_id=$2 RETURNING id',[id,user.id,body.shared])).rowCount)throw new AppError('NOT_FOUND',404);
    return body;
  });
  const ownedGame=async(id:string,userId:string)=>{
    const game=(await db.query('SELECT id,shared FROM games WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];
    if(!game)throw new AppError('NOT_FOUND',404);return game;
  };
  app.get('/api/v1/games/:id/shares',async req=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id),game=await ownedGame(id,user.id);
    const users=(await db.query(`SELECT u.id,u.username,EXISTS(SELECT 1 FROM game_shares s WHERE s.game_id=$1 AND s.user_id=u.id) AS granted
      FROM users u WHERE u.id<>$2 ORDER BY u.username`,[id,user.id])).rows;
    return {sharedToAll:game.shared,users};
  });
  app.put('/api/v1/games/:id/shares',async req=>{
    const user=await auth.user(req),id=uuid.parse((req.params as {id:string}).id),body=z.object({userIds:z.array(uuid).max(100)}).parse(req.body),userIds=[...new Set(body.userIds)];
    if(userIds.includes(user.id))throw new AppError('INVALID_SHARE_TARGET',400);
    await transaction(db,async sql=>{
      if(!(await sql.query('SELECT id FROM games WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id])).rowCount)throw new AppError('NOT_FOUND',404);
      if(userIds.length&&(await sql.query('SELECT count(*)::int AS count FROM users WHERE id=ANY($1::uuid[])',[userIds])).rows[0].count!==userIds.length)throw new AppError('INVALID_SHARE_TARGET',400);
      await sql.query('DELETE FROM game_shares WHERE game_id=$1',[id]);
      if(userIds.length)await sql.query('INSERT INTO game_shares(game_id,user_id,granted_by) SELECT $1,id,$2 FROM users WHERE id=ANY($3::uuid[])',[id,user.id,userIds]);
    });
    return {userIds};
  });
  app.get('/api/v1/sources', async req => {
    const user = await auth.user(req);
    return (await db.query("SELECT id,name,type,last_synced,error,config->>'autoPrepare' AS \"autoPrepare\",config->'shareCatalog' AS \"shareCatalog\",(SELECT COALESCE(jsonb_agg(jsonb_build_object('path',o.path,'state',o.state,'error',o.error,'details',o.details)),'[]') FROM source_observations o WHERE o.source_id=s.id) AS observations FROM sources s WHERE user_id=$1 ORDER BY name", [user.id])).rows;
  });
  app.post('/api/v1/sources', async (req, reply) => {
    const user = await auth.user(req), source = sourceSchema.parse(req.body), id = randomUUID();
    if (source.tokenEnv && user.role !== 'ADMIN') throw new AppError('ADMIN_CREDENTIAL_CONFIGURATION_REQUIRED', 403);
    if ((source.type==='WATCH_FOLDER'||source.shareCatalog||source.autoPrepare) && user.role!=='ADMIN')throw new AppError('ADMIN_REQUIRED',403);
    if (['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type) && (path.isAbsolute(source.location) || source.location.split(/[\\/]/).includes('..'))) throw new AppError('UNSAFE_PATH');
    if(source.type==='WATCH_FOLDER'&&!config.DUMP_ROOT)throw new AppError('DUMP_ROOT_NOT_CONFIGURED',409);
    await db.query('INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,$3,$4,$5)', [id, user.id, source.name, source.type, source]);
    return reply.code(201).send({ id });
  });
  const syncOne = async (userId: string, id: string) => {
    const user = { id: userId };
    const source = (await db.query('SELECT * FROM sources WHERE id=$1 AND user_id=$2', [id, user.id])).rows[0];
    if (!source) throw new AppError('NOT_FOUND', 404);
    try {
      const userConfig = { ...config, SOURCE_ROOT: path.join(config.SOURCE_ROOT, user.id) };
      const artworkErrors:string[]=[],preparationErrors:string[]=[];
      const consoles=source.config.autoPrepare?(await db.query("SELECT c.id,c.firmware,c.runtime,COALESCE(k.capabilities,'{}') AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.user_id=$1 AND c.firmware IS NOT NULL AND c.runtime<>'unknown'",[user.id])).rows:[];
      const importMedia=async(gameId:string,sourceReleaseId:string,release:Release,kind:'music'|'trailer',media:{file:string;format:string}|null|undefined)=>{
        if(!media)return;
        try{const size=(await stat(media.file)).size;if(size>(kind==='music'?32:512)*1024**2)throw new AppError('MEDIA_SIZE_LIMIT');
          const sha256=await fileHash(media.file);await storeTrailer(db,config,gameId,()=>createReadStream(media.file),size,{sourceReleaseId,sha256},kind,media.format);
        }catch(e){artworkErrors.push(`${release.game.title}: ${e instanceof AppError?e.code:kind.toUpperCase()+'_IMPORT_FAILED'}`);}
      };
      const publishReleases=async(releases:Release[],prepareAutomatically=true)=>{
        const trailers=new Map<string,string>();
        const musicFiles=new Map<string,{file:string;format:string}>();
        if(source.type==='WATCH_FOLDER')for(let i=0;i<releases.length;i++){
          const media=await watchedMedia(config,releases[i]!);releases[i]=media.release;if(media.trailer)trailers.set(media.release.key,media.trailer);if(media.music)musicFiles.set(media.release.key,media.music);
        }
        const artwork: { gameId: string; releaseId:string; sourceReleaseId:string; release: typeof releases[number] }[] = [];
        const rank=source.type==='WATCH_FOLDER'?1:3;
        await transaction(db, async sql => {
          for (const release of releases) {
            const existing = (await sql.query('SELECT * FROM games WHERE user_id=$1 AND title_id=$2', [user.id, release.game.titleId])).rows[0];
            const previous=(await sql.query('SELECT r.* FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id WHERE sr.source_id=$1 AND sr.source_key=$2',[source.id,release.key])).rows[0];
            if(previous&&previous.content_id===release.game.contentId&&previous.version===release.version&&previous.kind!==release.kind) {
              await sql.query('UPDATE game_releases SET kind=$2 WHERE id=$1',[previous.id,release.kind]);
              if(release.kind==='DLC')await sql.query("DELETE FROM metadata_records WHERE game_id=$1 AND (data->>'contentId'=$2 OR provider=$3)",[previous.game_id,previous.content_id,`inspection:${previous.id}`]);
            }
            const records = existing ? (await sql.query('SELECT rank,data FROM metadata_records WHERE game_id=$1', [existing.id])).rows : [];
            // DLC identity belongs to the release; its name/content ID cannot replace the base game's metadata.
            const observed=release.kind==='DLC'&&!records.length?(await sql.query("SELECT o.details->'identity' AS identity FROM source_observations o JOIN sources s ON s.id=o.source_id WHERE s.user_id=$1 AND o.details->>'titleId'=$2 AND o.details ? 'archive' ORDER BY o.changed_at DESC LIMIT 1",[user.id,release.game.titleId])).rows[0]?.identity:null;
            const metadata = release.kind==='DLC' ? records.length?resolveMetadata(records):observed?{...release.game,...observed}:{...release.game,title:release.game.titleId} : resolveMetadata([...records, { rank, data: release.game }]);
            const gameId = existing?.id ?? randomUUID();
            await sql.query('INSERT INTO games(id,user_id,title_id,title,metadata,shared) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,title_id) DO UPDATE SET title=$4,metadata=$5', [gameId, user.id, release.game.titleId, metadata.title, metadata,source.config.shareCatalog??false]);
            const { game, location, ...normalized } = release;
            normalized.title=release.title??release.game.title;
            const r = (await sql.query('INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(game_id,content_id,version,kind) DO UPDATE SET metadata=$6 RETURNING id', [randomUUID(), gameId, game.contentId, release.version, release.kind, normalized])).rows[0];
            const sr=(await sql.query("INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,source_key) DO UPDATE SET release_id=$3,metadata=CASE WHEN source_releases.metadata ? 'retiredAt' AND (NOT (source_releases.metadata ? 'sourceMissingAt') OR source_releases.metadata ? 'sourceRemovedAt') THEN source_releases.metadata ELSE $5 END RETURNING id", [randomUUID(), source.id, r.id, release.key, release])).rows[0];
            if(release.kind!=='DLC')await sql.query('INSERT INTO metadata_records(id,game_id,provider,rank,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(game_id,provider) DO UPDATE SET data=$5,rank=$4', [randomUUID(), gameId, `source:${source.id}`,rank, game]);
            artwork.push({ gameId,releaseId:r.id, sourceReleaseId:sr.id, release });
          }
          await sql.query('UPDATE sources SET last_synced=now(),error=NULL WHERE id=$1', [source.id]);
        });
        for (const { gameId,releaseId, sourceReleaseId, release } of artwork) {
          const art = release.kind==='DLC'?undefined:release.game.artwork;
          if(release.kind!=='DLC'&&release.format==='pkg'&&['LOCAL_FOLDER','WATCH_FOLDER'].includes(source.type)&&(!art?.cover||!art?.icon||!art?.hero)){
            const stage=path.join(config.DATA_DIR,'artwork','.staging',randomUUID());
            try{
              const sourceRoot=localSourceRoot(config,source.type,user.id),input=await existingWithin(sourceRoot,path.resolve(sourceRoot,release.location));
              await mkdir(stage,{recursive:true});const embedded=await runWorker(['extract-pkg-artwork',input,stage]);
              if(embedded.icon){const bytes=await readFile(await existingWithin(stage,path.resolve(embedded.icon)));if(!art?.icon)await cacheArtwork(db,config,gameId,bytes,'icon');if(!art?.cover)await cacheArtwork(db,config,gameId,bytes,'cover');}
              if(embedded.hero&&!art?.hero)await cacheArtwork(db,config,gameId,await readFile(await existingWithin(stage,path.resolve(embedded.hero))),'hero');
            }catch{artworkErrors.push(`${release.game.title}: embedded package artwork unavailable`);}
            finally{await rm(stage,{recursive:true,force:true});}
          }
          const entries = [['cover', art?.cover], ['hero', art?.hero], ['icon', art?.icon], ...(art?.screenshots ?? []).map((value, i) => [`screenshot-${i}`, value])];
          for (const [kind, location] of entries) if (kind && location) try {
            const localRoot = source.type==='WATCH_FOLDER'?path.resolve(config.DUMP_ROOT):source.type==='LOCAL_FOLDER'?path.resolve(localSourceRoot(config,source.type,user.id),source.config.location):undefined;
            const resolved = localRoot || /^https?:/.test(location) ? location : new URL(location, source.config.location).href;
            await cacheArtwork(db, config, gameId, await fetchArtwork(config, resolved, localRoot), kind);
          } catch { artworkErrors.push(`${release.game.title}: ${kind} unavailable`); }
          const trailer=trailers.get(release.key);
          await importMedia(gameId,sourceReleaseId,release,'trailer',trailer?{file:trailer,format:'mov'}:null);
          await importMedia(gameId,sourceReleaseId,release,'music',musicFiles.get(release.key));
          const profiledMethods=new Set<string>();
          if(prepareAutomatically&&source.config.autoPrepare) {
            const methods=source.config.autoPrepare==='BOTH'?['FPKG','SHADOWMOUNT']:[source.config.autoPrepare];
            if(release.kind!=='DLC'&&buildFormats.includes(release.format)&&/^\d{1,2}\.\d{2}$/.test(release.minimumFirmware??'')){
              const required=Number(release.minimumFirmware!.replace('.',''));
              const targets=new Map<string,{targetFirmware:string;runtime:string;methods:Map<'FPKG'|'SHADOWMOUNT',string[]>}>();
              for(const console of consoles)for(const method of methods){
                const target=Number(String(console.firmware).replace('.','')),capabilities=console.capabilities??{};
                if(!Number.isInteger(target)||target>=required||method==='FPKG'&&!capabilities.fpkgInstall||method==='SHADOWMOUNT'&&(!capabilities.shadowMount||!capabilities.backportOverlay))continue;
                const key=`${console.firmware}:${console.runtime}`,known=targets.get(key)??{targetFirmware:console.firmware,runtime:console.runtime,methods:new Map<'FPKG'|'SHADOWMOUNT',string[]>()};
                known.methods.set(method,[...(known.methods.get(method)??[]),console.id]);targets.set(key,known);
              }
              for(const target of targets.values()){
                let template:z.infer<typeof profileSchema>|undefined;
                for(const [method,consoleIds] of target.methods){
                  let generated:Awaited<ReturnType<typeof createProfile>>;
                  try{generated=await createProfile(user.id,{sourceReleaseId,targetFirmware:target.targetFirmware,runtime:target.runtime,installationMethod:method},template,{releaseId,consoleIds:[...target.methods.values()].flat()});}
                  catch(e){
                    const code=e instanceof AppError?e.code:'PROFILE_GENERATION_FAILED';preparationErrors.push(`${release.game.title}: ${code}`);
                    await Promise.all([...target.methods.values()].flat().map(consoleId=>backportNotice(db,user.id,consoleId,releaseId,code,profileDiscoveryContext(target.targetFirmware,target.runtime,release.sourceTreeSha256??release.sha256))));break;
                  }
                  if(generated.reusable)template=generated.profile;
                  try{
                    const prior=(await db.query("SELECT state,updated_at FROM jobs WHERE source_release_id=$1 AND config->'profile'->>'id'=$2 AND config->>'method'=$3 ORDER BY created_at DESC LIMIT 1",[sourceReleaseId,generated.id,method])).rows[0];
                    const artifact=prior&&['ERROR','CANCELLED'].includes(prior.state)?(await db.query("SELECT created_at FROM artifacts WHERE release_id=$1 AND format=$2 AND verified AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[releaseId,method==='FPKG'?'pkg':'ffpkg'])).rows[0]:undefined;
                    const scheduled=!prior||retryProfileAfterArtifact(prior,artifact);
                    if(scheduled)await prepare(user.id,{sourceReleaseId,method,profileId:generated.id});
                    if(scheduled||!['ERROR','CANCELLED'].includes(prior.state))profiledMethods.add(method);
                  }
                  catch(e){const code=e instanceof AppError?e.code:'PREPARATION_FAILED';preparationErrors.push(`${release.game.title}: ${code}`);await Promise.all(consoleIds.map(consoleId=>backportNotice(db,user.id,consoleId,releaseId,code,profileDiscoveryContext(target.targetFirmware,target.runtime,release.sourceTreeSha256??release.sha256))));}
                }
              }
            }
            if(buildFormats.includes(release.format))for(const method of methods){
              if(profiledMethods.has(method))continue;
              try{await prepare(user.id,{sourceReleaseId,method},true);}
              catch(e){preparationErrors.push(`${release.game.title}: ${e instanceof AppError?e.code:'PREPARATION_FAILED'}`);}
            }else try{await download(user.id,sourceReleaseId,true);}
            catch(e){preparationErrors.push(`${release.game.title}: ${e instanceof AppError?e.code:'PREPARATION_FAILED'}`);}
          }
        }
      };
      // Media has its own identity/hash; importing it does not reverify or rebuild the full dump.
      if(source.type==='WATCH_FOLDER')for(const known of (await db.query("SELECT sr.id,sr.metadata,r.game_id FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id WHERE sr.source_id=$1 AND NOT (sr.metadata ? 'retiredAt') AND r.kind<>'DLC' ORDER BY sr.id LIMIT 500",[source.id])).rows){
        try{const release=releaseSchema.parse(known.metadata);const media=await watchedMedia(config,release);await importMedia(known.game_id,known.id,release,'music',media.music);await importMedia(known.game_id,known.id,release,'trailer',media.trailer?{file:media.trailer,format:'mov'}:null);}
        catch(e){if(e instanceof AppError&&e.code==='METADATA_MISMATCH')throw e;artworkErrors.push('Existing title media is unavailable');}
      }
      const watched=source.type==='WATCH_FOLDER'?await discoverWatched(db,config,source,(release,automatic)=>publishReleases([release],automatic)):null;
      const releases=watched?.releases??await connector(source.config,userConfig).discover();
      if(!watched)await publishReleases(releases);
      const errors=[...preparationErrors,...(watched?.errors??[]).map(e=>`${e.path}: ${e.error}`)];
      await db.query('UPDATE sources SET last_synced=now(),error=$2 WHERE id=$1',[source.id,errors.length?errors.join('; ').slice(0,4000):null]);
      return { discovered: releases.length, artworkErrors, preparationErrors, inspectionErrors:watched?.errors??[] };
    } catch (error) { await db.query('UPDATE sources SET error=$2 WHERE id=$1', [source.id, error instanceof AppError ? error.code : 'SOURCE_SYNC_FAILED']); throw error; }
  };
  const scans=new Map<string,Promise<unknown>>();
  const syncSource=(userId:string,id:string)=>{
    const key=`${userId}:${id}`;if(scans.has(key))return scans.get(key)!;
    const pending=syncOne(userId,id).finally(()=>scans.delete(key));scans.set(key,pending);return pending;
  };
  app.post('/api/v1/sources/:id/sync', async req => syncSource((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)));
  let scanning = false;
  const scan = async () => {
    if (scanning) return; scanning = true;
    try {
      if(config.DUMP_ROOT)await transaction(db,async sql=>{
        await sql.query('SELECT pg_advisory_xact_lock(3150007)');
        const owner=(await sql.query("SELECT id FROM users WHERE role='ADMIN' ORDER BY created_at LIMIT 1")).rows[0];
        if(owner && !(await sql.query("SELECT id FROM sources WHERE type='WATCH_FOLDER' AND config->>'location'='.'")).rowCount)
          await sql.query("INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,'Watched games','WATCH_FOLDER',$3)",[randomUUID(),owner.id,sourceSchema.parse({name:'Watched games',type:'WATCH_FOLDER',location:'.',scanIntervalMinutes:1,autoPrepare:config.DUMP_AUTO_PREPARE,shareCatalog:true})]);
      });
      const due = (await db.query("UPDATE sources SET next_scan_at=now()+((config->>'scanIntervalMinutes')::int * interval '1 minute') WHERE id IN (SELECT id FROM sources WHERE config ? 'scanIntervalMinutes' AND next_scan_at<=now() ORDER BY next_scan_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING id,user_id")).rows;
      for (const source of due) {
        await syncSource(source.user_id, source.id).catch(() => {});
        await db.query("UPDATE sources SET next_scan_at=now()+((config->>'scanIntervalMinutes')::int * interval '1 minute') WHERE id=$1 AND config ? 'scanIntervalMinutes'",[source.id]);
      }
    } finally { scanning = false; }
  };
  const timer = setInterval(() => void scan().catch(e => console.error('Source scan:', e.code ?? e.name)), 10000);
  app.addHook('onClose', async () => { clearInterval(timer); await Promise.allSettled(scans.values()); while (scanning) await new Promise(resolve => setTimeout(resolve, 50)); });
  app.get('/api/v1/artwork/:gameId/:kind', async (req, reply) => {
    const params = z.object({ gameId: uuid, kind: z.string().regex(/^(cover|hero|icon|screenshot-\d{1,2})$/) }).parse(req.params);
    let userId: string;
    try { userId = (await auth.user(req)).id; } catch { userId = (await auth.device(req)).user_id; }
    if (!(await db.query('SELECT g.id FROM games g JOIN game_read_access access ON access.game_id=g.id WHERE g.id=$1 AND access.user_id=$2', [params.gameId, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    const row = (await db.query('SELECT * FROM artwork WHERE game_id=$1 AND kind=$2', [params.gameId, params.kind])).rows[0];
    reply.header('cache-control', 'private, max-age=3600').header('vary', 'Authorization, Cookie');
    if (!row) return reply.type('image/svg+xml').send(placeholder);
    const etag = `"${row.sha256}"`; reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/webp').send(createReadStream(await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path))));
  });
  app.get('/api/v1/profiles', async req => (await db.query('SELECT id,profile FROM compatibility_profiles WHERE user_id=$1', [(await auth.user(req)).id])).rows.map(r => ({ ...r.profile, id: r.id })));
  app.post('/api/v1/profiles/generate',async(req,reply)=>{
    const user=await auth.user(req);if(user.role!=='ADMIN')throw new AppError('ADMIN_REQUIRED',403);
    const body=z.object({sourceReleaseId:uuid,targetFirmware:firmware,runtime:z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),installationMethod:z.enum(['FPKG','SHADOWMOUNT'])}).parse(req.body);
    const {id,profile}=await createProfile(user.id,body);return reply.code(201).send({id,profile});
  });
  app.post('/api/v1/profiles', async (req, reply) => {
    const user = await auth.user(req), profile = profileSchema.parse(req.body), id = randomUUID();
    profileHash({...profile,id});
    await db.query('INSERT INTO compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, user.id, profile.titleId, profile.contentId, profile.gameVersion, profile.targetFirmware, profile.runtime, { ...profile, id }]);
    return reply.code(201).send({ id });
  });
}
