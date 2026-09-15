import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { sourceSchema, uuid, profileSchema } from '../../../shared/schemas/index.js';
import { connector } from '../sources/connectors.js';
import { AppError } from '../security/errors.js';
import { resolveMetadata } from '../library/policy.js';
import { cacheArtwork, fetchArtwork, placeholder } from '../artwork/cache.js';

export async function catalogFor(db: DB, userId: string, query = '') {
  const games = (await db.query('SELECT g.*,EXISTS(SELECT 1 FROM saved_games s WHERE s.user_id=$1 AND s.game_id=g.id) AS saved FROM games g WHERE user_id=$1 AND (title ILIKE $2 OR title_id ILIKE $2) ORDER BY title LIMIT 500', [userId, `%${query}%`])).rows;
  const releases = (await db.query(`SELECT r.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',sr.id,'name',s.name,'format',sr.metadata->>'format','size',sr.metadata->'size')) FROM source_releases sr JOIN sources s ON s.id=sr.source_id WHERE sr.release_id=r.id AND s.user_id=$1),'[]') AS sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'format',a.format,'size',a.size,'sha256',a.sha256)) FROM artifacts a WHERE a.release_id=r.id AND a.verified),'[]') AS artifacts
    FROM game_releases r JOIN games g ON g.id=r.game_id WHERE g.user_id=$1`, [userId])).rows;
  return games.map(g => ({ ...g.metadata, id: g.id, title: g.title, titleId: g.title_id, saved: g.saved, addedAt: g.created_at,
    coverUrl: `/api/v1/artwork/${g.id}/cover`, heroUrl: `/api/v1/artwork/${g.id}/hero`, iconUrl: `/api/v1/artwork/${g.id}/icon`,
    screenshotUrls: (g.metadata.artwork?.screenshots ?? []).map((_: unknown, i: number) => `/api/v1/artwork/${g.id}/screenshot-${i}`),
    releases: releases.filter(r => r.game_id === g.id).map(r => ({ ...r.metadata, id: r.id, contentId: r.content_id, version: r.version, kind: r.kind, sources: r.sources, artifacts: r.artifacts })) }));
}
export async function catalogRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const save = async (userId: string, id: string, saved: boolean) => {
    if (!(await db.query('SELECT id FROM games WHERE id=$1 AND user_id=$2', [id, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    if (saved) await db.query('INSERT INTO saved_games(user_id,game_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId,id]);
    else await db.query('DELETE FROM saved_games WHERE user_id=$1 AND game_id=$2', [userId,id]);
    return { saved };
  };
  app.post('/api/v1/games/:id/save', async req => save((await auth.user(req)).id,uuid.parse((req.params as {id:string}).id),z.object({saved:z.boolean()}).parse(req.body).saved));
  app.post('/api/v1/device/games/:id/save', async req => save((await auth.device(req)).user_id,uuid.parse((req.params as {id:string}).id),z.object({saved:z.boolean()}).parse(req.body).saved));
  app.get('/api/v1/catalog', async req => catalogFor(db, (await auth.user(req)).id, z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.get('/api/v1/device/catalog', async req => catalogFor(db, (await auth.device(req)).user_id, z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.get('/api/v1/sources', async req => {
    const user = await auth.user(req);
    return (await db.query('SELECT id,name,type,last_synced,error FROM sources WHERE user_id=$1 ORDER BY name', [user.id])).rows;
  });
  app.post('/api/v1/sources', async (req, reply) => {
    const user = await auth.user(req), source = sourceSchema.parse(req.body), id = randomUUID();
    if (source.tokenEnv && user.role !== 'ADMIN') throw new AppError('ADMIN_CREDENTIAL_CONFIGURATION_REQUIRED', 403);
    if (source.type === 'LOCAL_FOLDER' && (path.isAbsolute(source.location) || source.location.split(/[\\/]/).includes('..'))) throw new AppError('UNSAFE_PATH');
    await db.query('INSERT INTO sources(id,user_id,name,type,config) VALUES($1,$2,$3,$4,$5)', [id, user.id, source.name, source.type, source]);
    return reply.code(201).send({ id });
  });
  const syncSource = async (userId: string, id: string) => {
    const user = { id: userId };
    const source = (await db.query('SELECT * FROM sources WHERE id=$1 AND user_id=$2', [id, user.id])).rows[0];
    if (!source) throw new AppError('NOT_FOUND', 404);
    try {
      const userConfig = { ...config, SOURCE_ROOT: path.join(config.SOURCE_ROOT, user.id) };
      const releases = await connector(source.config, userConfig).discover();
      const artwork: { gameId: string; release: typeof releases[number] }[] = [];
      await transaction(db, async sql => {
        for (const release of releases) {
          const existing = (await sql.query('SELECT id FROM games WHERE user_id=$1 AND title_id=$2', [user.id, release.game.titleId])).rows[0];
          const records = existing ? (await sql.query('SELECT rank,data FROM metadata_records WHERE game_id=$1', [existing.id])).rows : [];
          const metadata = resolveMetadata([...records, { rank: 3, data: release.game }]);
          const gameId = existing?.id ?? randomUUID();
          await sql.query('INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,title_id) DO UPDATE SET title=$4,metadata=$5', [gameId, user.id, release.game.titleId, metadata.title, metadata]);
          const { game, location, ...normalized } = release;
          const r = (await sql.query('INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(game_id,content_id,version,kind) DO UPDATE SET metadata=$6 RETURNING id', [randomUUID(), gameId, game.contentId, release.version, release.kind, normalized])).rows[0];
          await sql.query('INSERT INTO source_releases(id,source_id,release_id,source_key,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,source_key) DO UPDATE SET release_id=$3,metadata=$5', [randomUUID(), source.id, r.id, release.key, release]);
          await sql.query('INSERT INTO metadata_records(id,game_id,provider,rank,data) VALUES($1,$2,$3,3,$4) ON CONFLICT(game_id,provider) DO UPDATE SET data=$4', [randomUUID(), gameId, `source:${source.id}`, game]);
          artwork.push({ gameId, release });
        }
        await sql.query('UPDATE sources SET last_synced=now(),error=NULL WHERE id=$1', [source.id]);
      });
      const artworkErrors: string[] = [];
      for (const { gameId, release } of artwork) {
        const art = release.game.artwork;
        const entries = [['cover', art?.cover], ['hero', art?.hero], ['icon', art?.icon], ...(art?.screenshots ?? []).map((value, i) => [`screenshot-${i}`, value])];
        for (const [kind, location] of entries) if (kind && location) try {
          const localRoot = source.type === 'LOCAL_FOLDER' ? path.resolve(userConfig.SOURCE_ROOT, source.config.location) : undefined;
          const resolved = localRoot || /^https?:/.test(location) ? location : new URL(location, source.config.location).href;
          await cacheArtwork(db, config, gameId, await fetchArtwork(config, resolved, localRoot), kind);
        } catch { artworkErrors.push(`${release.game.title}: ${kind} unavailable`); }
      }
      return { discovered: releases.length, artworkErrors };
    } catch (error) { await db.query('UPDATE sources SET error=$2 WHERE id=$1', [source.id, error instanceof AppError ? error.code : 'SOURCE_SYNC_FAILED']); throw error; }
  };
  app.post('/api/v1/sources/:id/sync', async req => syncSource((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)));
  let scanning = false;
  const scan = async () => {
    if (scanning) return; scanning = true;
    try {
      const due = (await db.query("UPDATE sources SET next_scan_at=now()+((config->>'scanIntervalMinutes')::int * interval '1 minute') WHERE id IN (SELECT id FROM sources WHERE config ? 'scanIntervalMinutes' AND next_scan_at<=now() ORDER BY next_scan_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING id,user_id")).rows;
      for (const source of due) await syncSource(source.user_id, source.id).catch(() => {});
    } finally { scanning = false; }
  };
  const timer = setInterval(() => void scan().catch(e => console.error('Source scan:', e.code ?? e.name)), 10000);
  app.addHook('onClose', async () => { clearInterval(timer); while (scanning) await new Promise(resolve => setTimeout(resolve, 50)); });
  app.get('/api/v1/artwork/:gameId/:kind', async (req, reply) => {
    const params = z.object({ gameId: uuid, kind: z.string().regex(/^(cover|hero|icon|screenshot-\d{1,2})$/) }).parse(req.params);
    let userId: string;
    try { userId = (await auth.user(req)).id; } catch { userId = (await auth.device(req)).user_id; }
    if (!(await db.query('SELECT id FROM games WHERE id=$1 AND user_id=$2', [params.gameId, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    const row = (await db.query('SELECT * FROM artwork WHERE game_id=$1 AND kind=$2', [params.gameId, params.kind])).rows[0];
    reply.header('cache-control', 'private, max-age=3600').header('vary', 'Authorization, Cookie');
    if (!row) return reply.type('image/svg+xml').send(placeholder);
    const etag = `"${row.sha256}"`; reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/webp').send(createReadStream(path.join(config.DATA_DIR, row.relative_path)));
  });
  app.get('/api/v1/profiles', async req => (await db.query('SELECT id,profile FROM compatibility_profiles WHERE user_id=$1', [(await auth.user(req)).id])).rows.map(r => ({ ...r.profile, id: r.id })));
  app.post('/api/v1/profiles', async (req, reply) => {
    const user = await auth.user(req), profile = profileSchema.parse(req.body), id = randomUUID();
    await db.query('INSERT INTO compatibility_profiles(id,user_id,title_id,content_id,game_version,target_firmware,runtime,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, user.id, profile.titleId, profile.contentId, profile.gameVersion, profile.targetFirmware, profile.runtime, { ...profile, id }]);
    return reply.code(201).send({ id });
  });
}
