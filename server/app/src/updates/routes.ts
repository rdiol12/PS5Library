import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import { readFile, stat, lstat } from 'node:fs/promises';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { serveFile } from '../downloads/serve.js';
import { AppError } from '../security/errors.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/),contentVersion=z.string().regex(/^\d{2}\.\d{3}\.\d{3}$/);
import {nativeAssetPath,nativeTitles,nativeReleaseLoader,nativeTitleId,nativeUpdateFolder,noNativeUpdate,xml,type NativeRelease} from './native.js';
import type {DB} from '../db.js';
import {approvedMasterCredential,masterRequest} from '../community/routes.js';

export async function updateRoutes(app: FastifyInstance, config: Config, auth: Auth,db?:DB,fetcher:typeof fetch=fetch) {
  const root = path.join(config.DATA_DIR, 'updates'),nativeUpdates=new Map<string,{load:ReturnType<typeof nativeReleaseLoader>;icon:()=>Promise<{file:string;size:number;sha256:string}>}>();
  for(const [titleId,title] of Object.entries(nativeTitles)){
    const nativeRoot = path.join(config.DATA_DIR, 'native-updates', nativeUpdateFolder(titleId)),loadNativeRelease=nativeReleaseLoader(nativeRoot,titleId);
    const nativeBase=`/api/v1/native-updates/${titleId}`;
    const publicUrl = (route: string) => new URL(route, config.PUBLIC_URL).toString();
    const manifest = (release: NativeRelease) => JSON.stringify({
      originalFileSize: release.package.size, packageDigest: release.package.digest.toUpperCase(), numberOfSplitFiles: 1,
      pieces: [{ url: publicUrl(`/api/v1/native-updates/${titleId}/${release.revision}/packages/${release.package.sha256}.pkg`), fileOffset: 0, fileSize: release.package.size, hashValue: release.package.sha256 }],
      playgoChunkCrcHashValue: release.playgo.sha256,
      playgoChunkCrcUrl: publicUrl(`/api/v1/native-updates/${titleId}/${release.revision}/playgo/${release.playgo.sha256}.crc`),
    });
    const sendVersion=(reply:FastifyReply,release:NativeRelease|null)=>{
      if (!release) return reply.header('Cache-Control','no-store').type('application/xml; charset=utf-8').send(noNativeUpdate(titleId));
      const manifestUrl = publicUrl(`/api/v1/native-updates/${titleId}/${release.revision}/manifest.json`);
      const manifestDigest = createHash('sha256').update(manifest(release)).digest('hex');
      const deltaUrl = publicUrl(`/api/v1/native-updates/${titleId}/${release.revision}/delta/${release.delta.sha256}.pkg`);
      const body = `<?xml version="1.0" encoding="UTF-8"?><title_patch ac_set_rev="0" nptitleid="${titleId}_00" schema_ver="1.0"><app_tag content_id="${title.contentId}" name="${xml(title.name)}" revision="${release.revision}"><package content_ver="${release.contentVersion}" delta_url="${xml(deltaUrl)}" digest="${manifestDigest}" mandatory="false" manifest_url="${xml(manifestUrl)}" metadata_ver="${release.revision}" pfs_revision="${release.revision}" system_ver="${release.systemVersion}"/></app_tag></title_patch>`;
      return reply.header('Cache-Control','no-store').type('application/xml; charset=utf-8').send(body);
    };
    const nativeAsset=(kind:'package'|'playgo'|'delta')=>async(req:FastifyRequest,reply:FastifyReply)=>{
      const {revision:raw,hash:rawHash}=req.params as {revision:string;hash:string},revision=z.coerce.number().int().positive().parse(raw),hash=digest.parse(rawHash),release=await loadNativeRelease(revision),asset=release?.[kind];
      if(!release||!asset||hash!==asset.sha256)throw new AppError('UPDATE_NOT_FOUND',404);
      return serveFile(req,reply,await nativeAssetPath(nativeRoot,titleId,kind,hash),asset.size,hash);
    };
    const nativeIcon=async()=>{const file=path.join(nativeRoot,'icon.png'),info=await lstat(file).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink()||info.size<8||info.size>2*1024*1024)throw new AppError('INVALID_NATIVE_UPDATE',409);const data=await readFile(file);if(!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new AppError('INVALID_NATIVE_UPDATE',409);return {file,size:info.size,sha256:createHash('sha256').update(data).digest('hex')};};
    nativeUpdates.set(titleId,{load:loadNativeRelease,icon:nativeIcon});
    if(titleId===nativeTitleId)app.get(`${nativeBase}/version.xml`, async (_req, reply) => sendVersion(reply,await loadNativeRelease()));
    app.get(`${nativeBase}/from/:base/version.xml`, async (req, reply) => {
      const base=contentVersion.parse((req.params as {base:string}).base),release=await loadNativeRelease();
      const exact=release?.baseContentVersion===base?release:null;
      if(exact&&config.features?.homeUpdateBridge===true&&config.HOME_UPDATE_AGENT_URL)return reply.code(307).header('Cache-Control','no-store').header('Location',`${config.HOME_UPDATE_AGENT_URL}/api/v1/agent/home-update/${titleId}/${base}`).send();
      return sendVersion(reply,exact);
    });
    app.get(`${nativeBase}/:revision/manifest.json`, async (req, reply) => {
      const revision = z.coerce.number().int().positive().parse((req.params as { revision: string }).revision), release = await loadNativeRelease(revision);
      if (!release) throw new AppError('UPDATE_NOT_FOUND', 404);
      return reply.header('Cache-Control','no-store').type('application/json').send(manifest(release));
    });
    app.get(`${nativeBase}/:revision/packages/:hash.pkg`,nativeAsset('package'));
    app.get(`${nativeBase}/:revision/playgo/:hash.crc`,nativeAsset('playgo'));
    app.get(`${nativeBase}/:revision/delta/:hash.pkg`,nativeAsset('delta'));
    app.get(`${nativeBase}/icon.png`,async(req,reply)=>{const icon=await nativeIcon();return serveFile(req,reply,icon.file,icon.size,icon.sha256,'image/png');});
  }
  const loadNativeRelease=nativeUpdates.get(nativeTitleId)!.load;
  const masterUpdate=z.object({titleId:z.literal(nativeTitleId),contentId:z.literal(nativeTitles[nativeTitleId]!.contentId).optional(),title:z.literal(nativeTitles[nativeTitleId]!.name).optional(),baseContentVersion:contentVersion.optional(),contentVersion,revision:z.number().int().positive(),size:z.number().int().positive(),sha256:digest.optional(),masterUrl:z.string().url(),activationToken:digest,expiresIn:z.number().int().positive()}).strict();
  const fromMaster=async(device:any,baseContentVersion?:string)=>{
    if(!db)throw new AppError('COMMUNITY_MASTER_UNAVAILABLE',503);
    try{
      const nodeToken=await approvedMasterCredential(db,config),consoleRef=createHmac('sha256',config.BOOTSTRAP_TOKEN).update(device.id).digest('hex'),body:any={consoleRef,displayName:device.name,firmware:device.firmware??null};if(baseContentVersion)body.baseContentVersion=baseContentVersion;
      const result=masterUpdate.nullable().parse(await masterRequest(config,'/api/v1/native-updates/consoles/activation',{method:'POST',token:nodeToken,body},fetcher));
      if(result&&result.masterUrl!==config.COMMUNITY_MASTER_URL)throw new AppError('INVALID_MASTER_RESPONSE',502);return result;
    }catch(error){
      await db.query(`INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message,resolve_on_delivery) SELECT $1,$2,$3,NULL,'MASTER_REGISTRATION_REQUIRED','native-update','Register this Library Server with PS5Library Master to receive app updates.',true WHERE NOT EXISTS(SELECT 1 FROM console_notices WHERE console_id=$3 AND code='MASTER_REGISTRATION_REQUIRED' AND resolved_at IS NULL)`,[randomUUID(),device.user_id,device.id]);
      if(error instanceof AppError&&error.code==='COMMUNITY_MASTER_NOT_APPROVED')throw new AppError('MASTER_REGISTRATION_REQUIRED',409);if(error instanceof AppError&&error.code==='INVALID_MASTER_RESPONSE')throw error;
      throw new AppError('MASTER_UPDATE_UNAVAILABLE',503);
    }
  };
  app.get('/api/v1/device/native-updates', async req => {
    const device=await auth.device(req),request=z.object({baseContentVersion:contentVersion.optional()}).strict().parse(req.query),base=request.baseContentVersion;
    if(config.COMMUNITY_MASTER_URL){const release=await fromMaster(device,base);return base===undefined||release?.baseContentVersion===base?release:null;}
    const release = await loadNativeRelease();
    return release&&(base===undefined||release.baseContentVersion===base) ? { titleId: release.titleId, contentVersion: release.contentVersion, revision: release.revision, size: release.package.size } : null;
  });
  app.post('/api/v1/device/native-updates/install',async req=>{
    const device=await auth.device(req),request=z.object({titleId:z.string().refine(value=>Object.hasOwn(nativeTitles,value)),baseContentVersion:contentVersion}).strict().parse(req.body),base=request.baseContentVersion,title=nativeTitles[request.titleId]!,native=nativeUpdates.get(request.titleId)!;
    if(config.COMMUNITY_MASTER_URL&&request.titleId===nativeTitleId){const release=await fromMaster(device,base);if(!release)return null;if(release.baseContentVersion!==base||release.contentId!==title.contentId||release.title!==title.name||!release.sha256)throw new AppError('MASTER_DIRECT_UPDATE_UNAVAILABLE',503);return release;}
    const release=await native.load();if(!release)throw new AppError('UPDATE_NOT_FOUND',404);if(release.baseContentVersion!==base)throw new AppError('NATIVE_UPDATE_BASE_MISMATCH',409);await native.icon();
    return {titleId:release.titleId,contentId:release.contentId,title:title.name,baseContentVersion:release.baseContentVersion,contentVersion:release.contentVersion,revision:release.revision,size:release.package.size,sha256:release.package.sha256,packageUrl:`/api/v1/native-updates/${request.titleId}/${release.revision}/packages/${release.package.sha256}.pkg`,iconUrl:`/api/v1/native-updates/${request.titleId}/icon.png`};
  });
  app.get('/api/v1/device/updates', async (req, reply) => {
    await auth.device(req);
    const file = path.join(root, 'latest.json');
    const info = await stat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    // Legacy json-c clients need a delimiter to finish parsing a scalar response.
    if (!info) return reply.type('application/json').send('null\n');
    if (info.size > 8192) throw new AppError('INVALID_UPDATE', 409);
    return z.object({ payload: z.string().max(4096), signature: z.string().regex(/^[a-f0-9]{128}$/) }).parse(JSON.parse(await readFile(file, 'utf8')));
  });
  app.get('/api/v1/device/updates/:hash', async (req, reply) => {
    await auth.device(req);
    const hash = z.string().regex(/^[a-f0-9]{64}$/).parse((req.params as { hash: string }).hash);
    const file = path.join(root, hash + '.elf');
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) return reply.code(404).send({ error: 'UPDATE_NOT_FOUND' });
    return serveFile(req, reply, file, info.size, hash);
  });
}
