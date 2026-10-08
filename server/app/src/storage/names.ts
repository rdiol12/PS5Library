import path from 'node:path';
import {sha256,uuid} from '../../../shared/schemas/index.js';

export const safeStorageName=(value:string)=>value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,80)||'Unknown';
export const gameStorageFolder=(game:{title:string;title_id:string})=>`${safeStorageName(game.title)} [${safeStorageName(game.title_id)}]`;
export const releaseStorageFolder=(row:{title:string;title_id:string;version:string;release_kind:string;release_id:string})=>path.posix.join(gameStorageFolder(row),`${safeStorageName(row.version)} - ${safeStorageName(row.release_kind)} [${uuid.parse(row.release_id).slice(0,8)}]`);
export const artifactStoragePath=(row:{title:string;title_id:string;version:string;release_kind:string;release_id:string},result:{sha256:string;format:string})=>path.posix.join('artifacts',releaseStorageFolder(row),`${gameStorageFolder(row)} - ${safeStorageName(row.version)} - ${safeStorageName(row.release_kind)} - ${sha256.parse(result.sha256).slice(0,12)}.${safeStorageName(result.format).toLowerCase()}`);
