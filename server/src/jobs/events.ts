import type { SQL } from '../db.js';
export function jobJSON(row: any) {
  return { id: row.id, kind: row.kind, releaseId: row.release_id, artifactId: row.artifact_id, consoleId: row.console_id, storageId: row.storage_id,
    title: row.title, state: row.state, desiredState: row.desired_state, downloadedBytes: row.downloaded_bytes,
    totalBytes: row.total_bytes, speedBytesPerSecond: row.speed_bytes_per_second, etaSeconds: row.eta_seconds, progress: row.config?.progress ?? null, error: row.error, updatedAt: row.updated_at };
}
export async function jobEvent(sql: SQL, id: string) {
  await sql.query(`INSERT INTO job_events(job_id,user_id,state,progress)
    SELECT id,user_id,state,jsonb_build_object('downloadedBytes',downloaded_bytes,'totalBytes',total_bytes,'speedBytesPerSecond',speed_bytes_per_second,'etaSeconds',eta_seconds,'conversion',config->'progress') FROM jobs WHERE id=$1`, [id]);
}
