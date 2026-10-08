import {createHash,randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import type {DB} from '../db.js';
import type {Config} from '../config.js';
import {profileSchema,type CompatibilityProfile} from '../../../shared/schemas/index.js';
import {existingWithin,safeName} from '../security/paths.js';
import {fileHash} from '../downloads/stream.js';
import {AppError} from '../security/errors.js';
import {runWorker} from './inspect.js';

export function profileHash(p:CompatibilityProfile){
  const order=(a:{path:string},b:{path:string})=>a.path<b.path?-1:a.path>b.path?1:0;
  for(const patch of p.requiredPatches)if(patch.bps){const bytes=Buffer.from(patch.bps.data,'base64');if(bytes.length<19||bytes.length>65536||bytes.subarray(0,4).toString()!=='BPS1'||bytes.toString('base64')!==patch.bps.data||createHash('sha256').update(bytes).digest('hex')!==patch.bps.sha256||crc32(bytes.subarray(0,-4))!==bytes.readUInt32LE(bytes.length-4))throw new AppError('BACKPORT_PATCH_CORRUPT',409);}
  return createHash('sha256').update(JSON.stringify([p.delivery==='INTEGRATED'?'backport-v6-integrated':'backport-v7-complete-overlay',p.id,p.titleId,p.contentId,p.gameVersion,[...p.inputHashes].sort(),p.targetFirmware,p.runtime,p.installationMethod,
    [...p.requiredLibraries].sort(order).map(f=>[f.path,f.sha256]),[...p.requiredPatches].sort(order).map(f=>f.bps||f.sdk||f.outputFormat?[f.path,f.inputSha256,f.outputSha256,f.bps?.sha256??null,f.sdk?.ps5??null,f.sdk?.ps4??null,f.outputFormat??null]:[f.path,f.inputSha256,f.outputSha256]),[...p.requiredFiles].sort(order).map(f=>[f.path,f.sha256])])).digest('hex');
}
export async function backportFiles(db:DB,config:Config,releaseId:string,inputHash:string,raw:unknown){
  const profile=profileSchema.parse(raw),fingerprint=profileHash(profile);
  if(!profile.id||!profile.inputHashes.includes(inputHash)||profile.testedState==='UNKNOWN')throw new AppError('PROFILE_MISMATCH',409);
  if(profile.delivery==='INTEGRATED'){
    return {profile,profileHash:fingerprint,backportId:null,files:[],size:0,needsPreparation:false,placement:'INTEGRATED' as const};
  }
  if(!profile.requiredLibraries.length&&!profile.requiredPatches.length&&!profile.requiredFiles.length)throw new AppError('BACKPORT_FILES_MISSING',409);
  if(new Set(profile.requiredLibraries.map(f=>f.path.toLowerCase())).size!==profile.requiredLibraries.length||new Set(profile.requiredLibraries.map(f=>f.path.split('/')[0])).size>1)throw new AppError('PROFILE_MISMATCH',409,'Select either fakelib or the exclusive fakelib2 policy.');
  const row=(await db.query("SELECT * FROM backport_artifacts WHERE release_id=$1 AND input_hash=ANY($2::text[]) AND type='SHADOWMOUNT_FOLDER' AND deleted_at IS NULL AND (profile_hash=$3 OR profile_hash IS NULL) ORDER BY (profile_hash IS NOT NULL) DESC,created_at DESC LIMIT 1",[releaseId,profile.inputHashes,fingerprint])).rows[0];
  if((profile.requiredLibraries.length||profile.requiredFiles.length)&&!row)throw new AppError('BACKPORT_FILES_MISSING',409);
  const prepared=row?.profile_hash===fingerprint;
  let needsPreparation=!prepared;
  const files:{path:string;sha256:string;size:number}[]=[];
  try{
    const root=row?await existingWithin(config.DATA_DIR,path.join(config.DATA_DIR,row.relative_path)):null;
    if(root){const tree=await runWorker(['hash-tree',root]);if(tree.sha256!==row.sha256||tree.size!==row.size)throw new AppError('BACKPORT_FILES_MISMATCH',409);}
    const expected=new Map<string,string|null>();
    if(prepared){
      for(const file of [...profile.requiredLibraries,...profile.requiredFiles])expected.set(file.path,file.sha256);
      for(const patch of profile.requiredPatches){
        const current=expected.get(patch.path);if(current&&current!==patch.outputSha256)throw new AppError('PROFILE_MISMATCH',409);
        expected.set(patch.path,patch.outputSha256);
      }
      if(!expected.has('sce_sys/param.json'))expected.set('sce_sys/param.json',null);
    }else for(const file of profile.requiredLibraries)expected.set(file.path,file.sha256);
    for(const [relative,expectedHash] of expected){
      relative.split('/').forEach(safeName);
      if(!root)throw new AppError('BACKPORT_FILES_MISSING',409);
      const file=await existingWithin(root,path.join(root,relative)),info=await stat(file);
      if(!info.isFile()||info.size>512*1024**2)throw new AppError('BACKPORT_FILES_MISMATCH',409);
      const actual=await fileHash(file);
      if(expectedHash&&actual!==expectedHash){
        const patch=profile.requiredPatches.find(p=>p.path===relative&&p.outputSha256===expectedHash&&p.inputSha256===actual&&(p.bps||p.sdk||p.outputFormat));
        if(prepared||!patch)throw new AppError('BACKPORT_FILES_MISMATCH',409);
        needsPreparation=true;
      }
      files.push({path:relative,sha256:actual,size:info.size});
    }
  }catch(e){if(e instanceof AppError)throw e;throw new AppError((e as NodeJS.ErrnoException).code==='ENOENT'?'BACKPORT_FILES_MISSING':'BACKPORT_FILES_MISMATCH',409);}
  return {profile,profileHash:fingerprint,backportId:row?.id??null,files,size:files.reduce((sum,f)=>sum+f.size,0),needsPreparation,placement:'SCAN_PATH' as const};
}
export const backportMessages:Record<string,string>={
  BACKPORT_NOT_INDEXED:'No exact backport profile has been indexed for this release and PS5 yet. Add or rescan its backport folder before downloading.',
  BACKPORT_NO_MATCH:'An indexed backport exists for this release, but it does not match the exact input, firmware, runtime and installation method.',
  BACKPORT_FILES_MISSING:'This PS5 needs backport files that are missing from the server. Ask the server owner to add them before downloading.',
  BACKPORT_FILES_MISMATCH:'The backport files have changed or do not match this release. Download is blocked until they are verified.',
  BACKPORT_PATCH_MISSING:'This backport requires a game file or patch recipe that is missing from the server.',
  BACKPORT_PATCH_CORRUPT:'The supplied backport patch failed validation. Preparation is blocked.',
  BACKPORT_PATCH_INPUT_MISMATCH:'The supplied patch does not match this game file. Preparation is blocked.',
  BACKPORT_PATCH_OUTPUT_MISMATCH:'The patched file failed its expected checksum. Nothing was published.',
  BACKPORT_PATCH_EXPANSION_UNSUPPORTED:'This patch expands a module beyond the supported limit. Preparation was stopped.',
  BACKPORT_SDK_RECORD_MISSING:'This module has no supported SDK record. A different exact patch is required.',
  BACKPORT_TARGET_UNVERIFIED:'This firmware has no verified SDK profile. Automatic backport preparation was stopped.',
  UNSUPPORTED_INPUT:'This release contains an executable or archive that the server cannot safely backport. Add an exact compatible profile or a supported dump.',
  ENCRYPTED_INPUT:'This release is encrypted, so the server cannot inspect or backport it.',
  INCOMPLETE_INPUT:'This release is incomplete. Restore every required file or archive part before preparing it.',
  MISSING_ARCHIVE_PART:'This release is missing an archive part. Restore the complete set before preparing it.',
  CORRUPT_INPUT:'This release failed integrity checks. Replace it with a verified copy before preparing it.',
  INPUT_TOO_LARGE:'This release contains a module that exceeds the safe automatic backport limit. Add an exact compatible profile instead.',
  SOURCE_CHANGED:'This release changed during verification. Automatic preparation stopped and will require a stable rescan.',
  PROFILE_GENERATION_FAILED:'The server could not generate a compatibility profile for this exact release.',
  BACKPORT_RUNTIME_UNAVAILABLE:'This PS5 needs backport support. Start a compatible ShadowMountPlus runtime and refresh its status.',
  INTEGRATED_BACKPORT_AGENT_REQUIRED:'Update and restart the PS5Library Agent before installing this game with its built-in backport.',
  BACKPORT_UNTESTED:'A matching backport is available but has not been tested on this firmware.',
  PROFILE_MISMATCH:'The backport profile does not match this game, firmware or library policy.',
};
export const deterministicProfileFailures=['UNSUPPORTED_INPUT','ENCRYPTED_INPUT','INCOMPLETE_INPUT','MISSING_ARCHIVE_PART','CORRUPT_INPUT','INPUT_TOO_LARGE','BACKPORT_FILES_MISSING','BACKPORT_TARGET_UNVERIFIED','PROFILE_MISMATCH'];
export const profileDiscoveryContext=(targetFirmware:string,runtime:string,inputHash:string)=>`profile-v4:${targetFirmware}:${runtime}:${inputHash}`;
export async function backportNotice(db:DB,userId:string,consoleId:string,releaseId:string,code:string,context:string){
  if(!backportMessages[code])return;
  await db.query('INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(console_id,release_id,code,context) DO NOTHING',[randomUUID(),userId,consoleId,releaseId,code,context,backportMessages[code]]);
}
