import { Queue, Worker } from 'bullmq';
import { mkdir, rename, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { transaction, type DB } from '../db.js';
import { downloadFile } from '../downloads/stream.js';
import { inspect } from '../library/inspect.js';
import { existingWithin } from '../security/paths.js';
import { sourceHeaders } from '../sources/connectors.js';
import { AppError } from '../security/errors.js';
import { jobEvent } from './events.js';
import { prepare, publishArtifact } from './preparation.js';

export async function startRunner(db: DB, config: Config) {
  const url = new URL(config.REDIS_URL);
  const connection = { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, db: Number(url.pathname.slice(1) || 0), ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
  // A separate queue per database/schema keeps isolated integration checks out of live queues.
  const { createHash } = await import('node:crypto');
  const name = `ps5library-${createHash('sha256').update(config.DATABASE_URL).digest('hex').slice(0, 12)}`;
  const queue = new Queue(name, { connection });
  const worker = new Worker(name, async queued => {
    const row = (await db.query('SELECT j.*,sr.metadata AS source_metadata,s.config AS source_config,s.type AS source_type,g.title_id,r.content_id,r.version FROM jobs j JOIN source_releases sr ON sr.id=j.source_release_id JOIN sources s ON s.id=sr.source_id JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id WHERE j.id=$1', [queued.id])).rows[0];
    if (!row || ['COMPLETED','ERROR','CANCELLED'].includes(row.state) || row.desired_state !== 'RUNNING') return;
    const partPath = path.join(config.DATA_DIR, 'jobs', row.id, 'content.part');
    try {
      if (row.kind === 'BUILD') { await prepare(db, config, row); return; }
      await db.query("UPDATE jobs SET state='DOWNLOADING',attempts=attempts+1,error=NULL,updated_at=now() WHERE id=$1", [row.id]);
      await jobEvent(db, row.id);
      const source = row.config.sourceMetadata;
      const local = row.config.sourceType === 'LOCAL_FOLDER';
      const location = local ? await existingWithin(path.join(config.SOURCE_ROOT, row.user_id), source.location) : source.location;
      const output = await downloadFile({ location, local, partPath, size: source.size, sha256: source.sha256,
        privateOrigins: config.privateOrigins, headers: sourceHeaders(row.config.sourceConfig, local ? undefined : location), margin: config.DISK_MARGIN_BYTES,
        progress: async progress => {
          const control = (await db.query('SELECT desired_state FROM jobs WHERE id=$1', [row.id])).rows[0].desired_state;
          if (control !== 'RUNNING') throw new AppError(control);
          await transaction(db, async sql => {
            await sql.query('UPDATE jobs SET downloaded_bytes=$2,total_bytes=$3,speed_bytes_per_second=$4,eta_seconds=$5,updated_at=now() WHERE id=$1', [row.id, progress.downloadedBytes, progress.totalBytes, progress.speedBytesPerSecond, progress.etaSeconds]);
            await jobEvent(sql, row.id);
          });
        },
      });
      await db.query("UPDATE jobs SET state='VERIFYING',speed_bytes_per_second=0,updated_at=now() WHERE id=$1", [row.id]); await jobEvent(db, row.id);
      const inspection = await inspect(partPath, source.format, { titleId: row.title_id, contentId: row.content_id, version: row.version });
      await publishArtifact(db, config, row, { ...output, outputPath: partPath, format: source.format, inspection });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'DOWNLOAD_FAILED';
      const state = ['PAUSED','CANCELLED'].includes(code) ? code : row.attempts < 2 && ['DOWNLOAD_FAILED','DOWNLOAD_HTTP_ERROR','DOWNLOAD_TIMEOUT','INCOMPLETE_INPUT'].includes(code) ? 'RETRYING' : 'ERROR';
      await db.query('UPDATE jobs SET state=$2,error=$3,speed_bytes_per_second=0,eta_seconds=NULL,updated_at=now() WHERE id=$1', [row.id, state, state === 'PAUSED' ? null : code]);
      await jobEvent(db, row.id);
      if (state === 'CANCELLED' || code === 'CORRUPT_INPUT') await rm(partPath, { force: true });
      if (state === 'RETRYING') throw error;
    }
  }, { connection, concurrency: 2 });
  worker.on('error', error => console.error('Queue worker error:', error.message));
  queue.on('error', error => console.error('Queue error:', error.message));
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return; reconciling = true;
    try {
      const jobs = (await db.query("SELECT id FROM jobs WHERE kind IN ('DOWNLOAD','BUILD') AND desired_state='RUNNING' AND state IN ('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING')")).rows;
      for (const job of jobs) await queue.add('download', {}, { jobId: job.id, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
    } finally { reconciling = false; }
  };
  await worker.waitUntilReady(); await reconcile();
  const timer = setInterval(() => void reconcile().catch(e => console.error('Queue reconciliation:', e.message)), 2000);
  return { reconcile, close: async () => { clearInterval(timer); await worker.close(); await queue.close(); } };
}
