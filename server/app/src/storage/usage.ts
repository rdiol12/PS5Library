import type {SQL} from '../db.js';
import {statfs} from 'node:fs/promises';
import {AppError} from '../security/errors.js';

export const quotaExceeded=(used:number,additional:number,quota:number)=>quota>0&&used+additional>quota;
export const quotaMaximum=(bytes:number,quota:number)=>quota>0?Math.min(bytes,quota):bytes;

export async function storageUsage(sql:SQL,exclude:{saveBackupId?:string;portableSaveId?:string}={}){
  await sql.query('SELECT pg_advisory_xact_lock(3150003)');
  const result=await sql.query(`SELECT (SELECT COALESCE(sum(size),0) FROM artifacts WHERE deleted_at IS NULL)+(SELECT COALESCE(sum(size),0) FROM backport_artifacts WHERE artifact_id IS NULL AND deleted_at IS NULL)+(SELECT COALESCE(sum(reserved_bytes),0) FROM game_media)+(SELECT COALESCE(sum(COALESCE((config->>'reservedBytes')::bigint,total_bytes)),0) FROM jobs WHERE kind IN ('DOWNLOAD','BUILD') AND state NOT IN ('COMPLETED','ERROR','CANCELLED'))+(SELECT COALESCE(sum(total_bytes),0) FROM save_backups WHERE id::text<>$1 AND state IN ('UPLOADING','VERIFYING','READY'))+(SELECT COALESCE(sum(total_bytes),0) FROM portable_save_archives WHERE id::text<>$2 AND state IN ('UPLOADING','VERIFYING','DOWNLOADING','READY')) AS bytes`,[exclude.saveBackupId??'',exclude.portableSaveId??'']);
  return Number(result.rows[0].bytes);
}
export async function requireDiskSpace(directory:string,bytes:number){const space=await statfs(directory);if(space.bavail*space.bsize<bytes)throw new AppError('INSUFFICIENT_SPACE',409);}
