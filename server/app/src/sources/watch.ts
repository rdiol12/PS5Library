import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseSchema, metadataSchema, type Release } from '../../../shared/schemas/index.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { existingWithin } from '../security/paths.js';
import { AppError } from '../security/errors.js';
import { runWorker } from '../library/inspect.js';
import { fileHash } from '../downloads/stream.js';
import {musicFormats} from '../artwork/trailers.js';
import {quotaExceeded} from '../storage/usage.js';

export function retryObservationError(error: unknown) {
  return ['WORKER_UNAVAILABLE','WORKER_TIMEOUT','INSPECTION_FAILED'].includes(String(error));
}

export function archiveBuildRequiredBytes(expandedSize: number) {
  const requiredBytes=expandedSize*5+64*1024**2;
  if(!Number.isSafeInteger(requiredBytes)||requiredBytes<0)throw new AppError('INPUT_TOO_LARGE',422);
  return requiredBytes;
}

export function shouldInspectObservation(state: unknown,error: unknown,requiredBytes?: unknown,quotaBytes=Number.MAX_SAFE_INTEGER) {
  if(typeof requiredBytes==='number'&&(!Number.isSafeInteger(requiredBytes)||quotaExceeded(0,requiredBytes,quotaBytes)))return false;
  return state!=='ERROR'||retryObservationError(error);
}

// PS5 param.json encodes the display firmware as decimal digits in a hex string.
export function minimumFirmware(value: unknown) {
  const match = typeof value === 'string' && /^0x([0-9]{2})([0-9]{2})[0-9a-f]{12}$/i.exec(value);
  return match ? `${Number(match[1])}.${match[2]}` : null;
}

export async function watchedMedia(config: Config, release: Release) {
  const candidate=path.join(config.DUMP_ROOT,'.ps5library',release.game.titleId,release.version);
  let music:{file:string;format:string}|null=null;
  const musicRoots=[candidate];
  if(release.format==='folder'&&release.kind!=='DLC')musicRoots.push(path.join(await existingWithin(config.DUMP_ROOT,path.resolve(config.DUMP_ROOT,release.location)),'sce_sys'));
  if(release.kind!=='DLC')for(const base of musicRoots){
    for(const name of base===candidate?['music']:['snd0','sndgame']){for(const [extension,format] of Object.entries(musicFormats)){
      const file=path.join(base,name+extension),info=await lstat(file).catch(()=>null);if(!info)continue;
      if(!info.isFile()||info.size>32*1024**2)throw new AppError('MEDIA_SIZE_LIMIT');
      music={file:await existingWithin(config.DUMP_ROOT,file),format};break;
    }if(music)break;}
    if(music&&base!==candidate){
      const param=await existingWithin(config.DUMP_ROOT,path.join(base,'param.json'));if((await lstat(param)).size>2*1024**2)throw new AppError('INPUT_TOO_LARGE');
      const identity=JSON.parse(await readFile(param,'utf8'));
      if(identity.titleId!==release.game.titleId||identity.contentId!==release.game.contentId||(identity.contentVersion||identity.masterVersion)!==release.version)throw new AppError('SOURCE_CHANGED',409);
    }
    if(music)break;
  }
  if(!await lstat(candidate).catch(()=>null))return {release,trailer:null,music};
  const root=await existingWithin(config.DUMP_ROOT,candidate),json=path.join(root,'metadata.json');
  const info=await lstat(json).catch(()=>null);let extra:Record<string,unknown>={};
  if(info){
    if(info.size>128*1024)throw new AppError('INPUT_TOO_LARGE');
    extra=JSON.parse(await readFile(await existingWithin(root,json),'utf8'));
    if(extra.titleId!==release.game.titleId||extra.contentId!==release.game.contentId||extra.version!==release.version)throw new AppError('METADATA_MISMATCH',409);
  }
  const art={...release.game.artwork};
  for(const kind of ['cover','hero','icon'] as const)for(const ext of ['webp','png','jpg']){
    const file=path.join(root,`${kind}.${ext}`);if(await lstat(file).catch(()=>null)){art[kind]=path.relative(config.DUMP_ROOT,await existingWithin(root,file)).split(path.sep).join('/');break;}
  }
  const game=metadataSchema.parse({...extra,...release.game,description:extra.description??release.game.description,genres:extra.genres??release.game.genres,artwork:art});
  const trailer=path.join(root,'trailer.mp4');
  return {release:{...release,game},trailer:await lstat(trailer).catch(()=>null)?await existingWithin(root,trailer):null,music};
}

async function signature(root: string) {
  const hash = createHash('sha256').update('watch-v4-base-tree'); let count = 0;
  if(/\.(rar|zip|7z)(\.001)?$/i.test(root))return hash.update(JSON.stringify(await runWorker(['archive-parts',root]))).digest('hex');
  const visit = async (file: string, depth: number): Promise<void> => {
    if (++count > 250000 || depth > 32) throw new AppError('INPUT_TOO_LARGE');
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new AppError('UNSAFE_PATH');
    hash.update(JSON.stringify([path.relative(root, file), info.size, info.mtimeMs, info.ctimeMs]));
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), depth + 1);
  };
  await visit(root, 0); return hash.digest('hex');
}

export async function discoverWatched(db: DB, config: Config, source: { id: string; config: { location: string; autoPrepare?:unknown } }, publish: (release:Release,prepareAutomatically?:boolean)=>Promise<void>) {
  if (!config.DUMP_ROOT) throw new AppError('DUMP_ROOT_NOT_CONFIGURED', 409);
  const root = await existingWithin(config.DUMP_ROOT, path.resolve(config.DUMP_ROOT, source.config.location));
  const candidates: string[] = []; let visited = 0;
  const find = async (folder: string, depth: number): Promise<void> => {
    if (++visited > 10000) throw new AppError('TOO_MANY_SOURCE_FOLDERS');
    if ((await lstat(folder)).isSymbolicLink()) return;
    if (await lstat(path.join(folder, 'sce_sys', 'param.json')).catch(() => null)) {
      candidates.push(folder);
      for(const item of await readdir(folder,{withFileTypes:true}))if(item.isDirectory()&&!item.isSymbolicLink()&&/^dlcs?$/i.test(item.name))await find(path.join(folder,item.name),depth+1);
      return;
    }
    if (depth >= 4) return;
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await find(file, depth + 1);
      else if (item.isFile() && /\.(pkg|ffpkg|ffpfs|ffpfsc|exfat|zip|rar|7z)(\.001)?$/i.test(item.name)) {
        const part=/\.part(\d+)\.rar$/i.exec(item.name);if(!part||Number(part[1])===1)candidates.push(file);
      }
    }
  };
  await find(root, 0);
  const present=candidates.map(file=>path.relative(root,file).split(path.sep).join('/')||'.');
  await db.query(`WITH missing AS (
      UPDATE source_observations SET state='MISSING',error='SOURCE_MISSING'
      WHERE source_id=$1 AND NOT(path=ANY($2::text[])) AND state<>'MISSING'
      RETURNING release->>'key' AS source_key
    )
    UPDATE source_releases SET metadata=metadata||jsonb_build_object('retiredAt',now(),'sourceMissingAt',now(),'retirementReason','SOURCE_MISSING')
    WHERE source_id=$1 AND NOT(metadata ? 'retiredAt') AND source_key IN (SELECT source_key FROM missing WHERE source_key IS NOT NULL)`,[source.id,present]);
  const order=(file:string)=>/\.(rar|zip|7z)(\.001)?$/i.test(file)?1:/\.(pkg|ffpkg|ffpfs|ffpfsc|exfat)$/i.test(file)?2:0;
  candidates.sort((a,b)=>order(a)-order(b));
  const releases: Release[] = [], errors: { path: string; error: string }[] = [];
  for (const file of candidates) {
    const relative = path.relative(root, file).split(path.sep).join('/') || '.';
    try {
      const stamp = await signature(file);
      const old = (await db.query('SELECT * FROM source_observations WHERE source_id=$1 AND path=$2', [source.id, relative])).rows[0];
      if (!old || old.signature !== stamp) {
        await db.query("INSERT INTO source_observations(source_id,path,signature) VALUES($1,$2,$3) ON CONFLICT(source_id,path) DO UPDATE SET signature=$3,changed_at=now(),state='STABILIZING',release=NULL,error=NULL", [source.id, relative, stamp]);
        continue;
      }
      if (Date.now() - new Date(old.changed_at).getTime() < 60000) continue;
      const knownRequiredBytes=old.details?.requiredBytes;
      if(!shouldInspectObservation(old.state,old.error,knownRequiredBytes,config.QUOTA_BYTES)) {
        const capacityBlocked=typeof knownRequiredBytes==='number'&&(!Number.isSafeInteger(knownRequiredBytes)||quotaExceeded(0,knownRequiredBytes,config.QUOTA_BYTES));
        const error=capacityBlocked?(Number.isSafeInteger(knownRequiredBytes)?'QUOTA_EXCEEDED':'INPUT_TOO_LARGE'):old.error;
        if(capacityBlocked)await db.query("UPDATE source_observations SET state='BLOCKED',error=$3 WHERE source_id=$1 AND path=$2",[source.id,relative,error]);
        errors.push({path:relative,error});continue;
      }
      if (old.release) {
        const release=releaseSchema.parse(old.release);
        const published=(await db.query('SELECT r.game_id,(SELECT count(*)::int FROM artwork a WHERE a.game_id=r.game_id) AS artwork_count FROM source_releases sr JOIN game_releases r ON r.id=sr.release_id WHERE sr.source_id=$1 AND sr.source_key=$2',[source.id,release.key])).rows[0];
        if(!published||source.config.autoPrepare||old.state==='MISSING')await publish(release);
        else if(Number(published.artwork_count)===0&&(release.format==='pkg'||Object.values(release.game.artwork??{}).some(Boolean)))await publish(release,false);
        if(old.state!=='READY'||old.error)await db.query("UPDATE source_observations SET state='READY',error=NULL WHERE source_id=$1 AND path=$2",[source.id,relative]);
        releases.push(release);continue;
      }
      await db.query("UPDATE source_observations SET state='INSPECTING',error=NULL WHERE source_id=$1 AND path=$2", [source.id, relative]);
      const inspected = await runWorker(['inspect', file]);
      if (!inspected.metadataVerified || !inspected.identity) throw new AppError('UNSUPPORTED_INPUT', 422);
      const identity = inspected.identity, folder = inspected.format === 'folder';
      if(inspected.kind==='UPDATE'&&!identity.baseContentVersion)throw new AppError('UPDATE_BASE_VERSION_MISSING',422);
      await db.query("UPDATE source_observations SET details=COALESCE(details,'{}'::jsonb)||$3 WHERE source_id=$1 AND path=$2",[source.id,relative,{title:identity.title,version:identity.version,titleId:identity.titleId,contentId:identity.contentId,identity,format:inspected.format}]);
      if(inspected.archive) {
        const requiredBytes=archiveBuildRequiredBytes(inspected.archive.expandedSize);
        await db.query('UPDATE source_observations SET details=$3 WHERE source_id=$1 AND path=$2',[source.id,relative,{title:identity.title,version:identity.version,titleId:identity.titleId,identity,archive:inspected.archive,requiredBytes}]);
        if(quotaExceeded(0,requiredBytes,config.QUOTA_BYTES))throw new AppError('QUOTA_EXCEEDED',409);
      }
      let param: any = {}, art: Record<string, string> = {};
      if (folder) {
        param = JSON.parse(await readFile(await existingWithin(file, path.join(file, 'sce_sys', 'param.json')), 'utf8'));
        for (const [kind, name] of [['cover', 'icon0.png'], ['icon', 'icon0.png'], ['hero', 'pic1.png']]) {
          const location = path.join(file, 'sce_sys', name!);
          if (await lstat(location).catch(() => null)) art[kind!] = path.relative(config.DUMP_ROOT,await existingWithin(file, location)).split(path.sep).join('/');
        }
        if (!art.hero && await lstat(path.join(file, 'sce_sys', 'pic0.png')).catch(() => null)) art.hero = path.relative(config.DUMP_ROOT,await existingWithin(file, path.join(file, 'sce_sys', 'pic0.png'))).split(path.sep).join('/');
      }
      const digest = folder ? await runWorker(['hash-base-tree', file]) : inspected.archive ? await runWorker(['hash-archive',file]) : {sha256: await fileHash(file), size: (await lstat(file)).size};
      if (stamp !== await signature(file)) {
        await db.query("UPDATE source_observations SET changed_at=now(),state='STABILIZING',release=NULL WHERE source_id=$1 AND path=$2", [source.id, relative]); continue;
      }
      const game = metadataSchema.parse({ title: identity.title, titleId: identity.titleId, contentId: identity.contentId, artwork: art });
      // Complete prepared folders are base bundles. Patch/DLC classification requires explicit inspected metadata.
      const release = releaseSchema.parse({ key: createHash('sha256').update(relative).digest('hex'), game, title:identity.title, kind:inspected.kind??'BASE', version: identity.version, baseContentVersion:identity.baseContentVersion, format: inspected.format,
        location: path.relative(config.DUMP_ROOT,file).split(path.sep).join('/'), ...digest, installedSize: folder ? digest.size : inspected.archive?.expandedSize, minimumFirmware: identity.minimumFirmware??minimumFirmware(param.requiredSystemSoftwareVersion), sdkVersion: param.sdkVersion ?? null });
      await db.query("UPDATE source_observations SET state='READY',release=$3,error=NULL WHERE source_id=$1 AND path=$2", [source.id, relative, release]);
      await publish(release);
      releases.push(release);
    } catch (error) {
      if(error instanceof AppError && error.code==='METADATA_MISMATCH')throw error;
      const code = error instanceof AppError ? error.code : error instanceof Error && error.message === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'INSPECTION_FAILED';
      await db.query("INSERT INTO source_observations(source_id,path,signature,state,error) VALUES($1,$2,'UNREADABLE',$4,$3) ON CONFLICT(source_id,path) DO UPDATE SET state=$4,error=$3", [source.id, relative, code, ['QUOTA_EXCEEDED','INSUFFICIENT_SPACE'].includes(code)?'BLOCKED':'ERROR']);
      errors.push({path: relative, error: code});
    }
  }
  return {releases, errors};
}
