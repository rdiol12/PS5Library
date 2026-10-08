import {randomUUID} from 'node:crypto';
import type { SQL } from '../db.js';

type LiveEvent={id:number;[key:string]:unknown};
type LiveEventSocket={bufferedAmount:number;send(message:string):void;close(code:number,reason:string):void;on(event:'close',listener:()=>void):unknown};
const activePollMs=500,idlePollMs=2_000,sessionCheckMs=30_000;

export function liveJobEvents(socket:LiveEventSocket,ownerId:string,cursor:number,events:(ownerId:string,after:number)=>Promise<LiveEvent[]>,reauthenticate:()=>Promise<unknown>){
  let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,lastAuthenticated=Date.now();
  const stop=()=>{stopped=true;if(timer)clearTimeout(timer);};
  socket.on('close',stop);
  const poll=async()=>{
    let delay=idlePollMs;
    try{
      if(Date.now()-lastAuthenticated>=sessionCheckMs){await reauthenticate();lastAuthenticated=Date.now();}
      const rows=await events(ownerId,cursor);
      if(stopped)return;
      if(rows.length){
        if(socket.bufferedAmount>1024**2){stop();socket.close(1008,'Client too slow');return;}
        socket.send(JSON.stringify({type:'events',events:rows}));cursor=rows.at(-1)!.id;delay=activePollMs;
      }
    }catch{stop();socket.close(1008,'Session expired');return;}
    if(!stopped)timer=setTimeout(()=>void poll(),delay);
  };
  void poll();
}

export function jobJSON(row: any, preparationVisible = false) {
  return { id: row.id, kind: row.kind, releaseId: row.release_id, sourceReleaseId: row.source_release_id, artifactId: row.artifact_id, consoleId: row.console_id, storageId: row.storage_id,
    title: row.title, state: row.state, desiredState: row.desired_state, downloadedBytes: row.downloaded_bytes,
    totalBytes: row.total_bytes, speedBytesPerSecond: row.speed_bytes_per_second, etaSeconds: row.eta_seconds, progress: row.kind === 'BUILD' && !preparationVisible ? null : row.config?.progress ?? null,
    error: row.error, queuePosition: row.queue_position ?? null, location: row.console_path ? `${row.storage_name ?? row.storage_id} / ${row.console_path}` : row.artifact_path ? `Server cache / ${row.artifact_path}` : null, updatedAt: row.updated_at };
}
export async function jobEvent(sql: SQL, id: string) {
  await sql.query(`WITH job AS MATERIALIZED (
      SELECT j.*,g.title FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.id=$1 AND j.dismissed_at IS NULL
    ), event AS (
      INSERT INTO job_events(job_id,user_id,state,progress)
      SELECT id,user_id,state,jsonb_build_object('downloadedBytes',downloaded_bytes,'totalBytes',total_bytes,'speedBytesPerSecond',speed_bytes_per_second,'etaSeconds',eta_seconds,'conversion',config->'progress') FROM job
    )
    INSERT INTO console_notices(id,user_id,console_id,release_id,code,context,message,resolve_on_delivery)
    SELECT $2,user_id,console_id,release_id,
      CASE state WHEN 'TRANSFERRING' THEN 'TRANSFER_STARTED' WHEN 'READY_ON_PS5' THEN 'TRANSFER_READY' ELSE 'TRANSFER_FAILED' END,
      id::text,
      CASE state WHEN 'TRANSFERRING' THEN title||' download started.' WHEN 'READY_ON_PS5' THEN title||' is ready to play.' ELSE title||' download failed. Open Downloads for details.' END,
      true
    FROM job WHERE kind='TRANSFER' AND state IN ('TRANSFERRING','READY_ON_PS5','ERROR') AND (state='ERROR' OR config->>'method' IS DISTINCT FROM 'FPKG')
    ON CONFLICT(console_id,release_id,code,context) DO NOTHING`, [id,randomUUID()]);
}
