import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {configuration} from '../app/src/config.js';
import {database} from '../app/src/db.js';

export function relativeSource(root:string,value:string){
  const paths=/^[A-Za-z]:[\\/]/.test(root)?path.win32:path.posix;
  const relative=paths.relative(paths.resolve(root),paths.resolve(root,value));
  if(relative==='..'||relative.startsWith('..'+paths.sep)||paths.isAbsolute(relative))throw Error('Source path is outside its configured root');
  return relative.split(paths.sep).join('/')||'.';
}
export function portableRelease(original:any,root:string,sourceLocation:string,watched:boolean){
  const result=structuredClone(original);
  result.location=relativeSource(root,result.location);
  if(watched){
    const artwork=result.game?.artwork;
    if(artwork)for(const [kind,value] of Object.entries(artwork)){
      const convert=(v:string)=>/^https?:/.test(v)?v:relativeSource(root,v);
      artwork[kind]=Array.isArray(value)?value.map(convert):typeof value==='string'?convert(value):value;
    }
    const relative=path.posix.relative(sourceLocation.replaceAll('\\','/'),result.location)||'.';
    if(relative==='..'||relative.startsWith('../'))throw Error('Dump is outside its watched collection');
    result.key=createHash('sha256').update(relative).digest('hex');
  }
  return result;
}

// Run on the original host with its original .env, after stopping its API.
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const config=configuration(),db=database(config.DATABASE_URL),sql=await db.connect(),apply=process.argv.includes('--apply');
  try{
    await sql.query('BEGIN');await sql.query('SELECT pg_advisory_xact_lock(3150007)');
    if((await sql.query("SELECT id FROM jobs WHERE kind IN ('DOWNLOAD','BUILD') AND state NOT IN ('COMPLETED','ERROR','CANCELLED','PAUSED') LIMIT 1")).rowCount)throw Error('Wait for active server jobs to finish before moving the server');
    let count=0;
    const sources=(await sql.query("SELECT * FROM sources WHERE type IN ('WATCH_FOLDER','LOCAL_FOLDER')")).rows;
    for(const source of sources){
      const watched=source.type==='WATCH_FOLDER',root=watched?config.DUMP_ROOT:path.join(config.SOURCE_ROOT,source.user_id),location=source.config.location;
      for(const row of (await sql.query('SELECT * FROM source_releases WHERE source_id=$1',[source.id])).rows){
        const metadata=portableRelease(row.metadata,root,location,watched);
        await sql.query('UPDATE source_releases SET source_key=$2,metadata=$3 WHERE id=$1',[row.id,metadata.key,metadata]);count++;
        if(watched){
          await sql.query("UPDATE metadata_records SET data=jsonb_set(data,'{artwork}',$3) WHERE game_id=(SELECT game_id FROM game_releases WHERE id=$1) AND provider=$2",[row.release_id,`source:${source.id}`,JSON.stringify(metadata.game.artwork??{})]);
          await sql.query("UPDATE games SET metadata=jsonb_set(metadata,'{artwork}',$2) WHERE id=(SELECT game_id FROM game_releases WHERE id=$1)",[row.release_id,JSON.stringify(metadata.game.artwork??{})]);
        }
      }
      for(const row of (await sql.query('SELECT * FROM source_observations WHERE source_id=$1',[source.id])).rows){
        await sql.query('UPDATE source_observations SET path=$3,release=$4 WHERE source_id=$1 AND path=$2',[source.id,row.path,row.path.replaceAll('\\','/'),row.release?portableRelease(row.release,root,location,watched):null]);
      }
      for(const row of (await sql.query('SELECT * FROM jobs WHERE source_release_id IN (SELECT id FROM source_releases WHERE source_id=$1)',[source.id])).rows){
        if(row.config.sourceMetadata){row.config.sourceMetadata=portableRelease(row.config.sourceMetadata,root,location,watched);await sql.query('UPDATE jobs SET config=$2 WHERE id=$1',[row.id,row.config]);}
      }
    }
    await sql.query(apply?'COMMIT':'ROLLBACK');console.log(`${apply?'Converted':'Validated'} ${count} source releases. Accounts, credentials and artifact hashes are unchanged.`);
  }catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();await db.end();}
}
