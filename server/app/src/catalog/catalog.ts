import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import { queryOne, queryRows, transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { uuid } from '../../../shared/schemas/index.js';
import { placeholder } from '../artwork/cache.js';
import { AppError } from '../security/errors.js';
import { regularFileWithin } from '../security/paths.js';

export async function catalogFor(db: DB, userId: string, query = '') {
  const games = await queryRows(
    db,
    `SELECT g.*,
         EXISTS(SELECT 1 FROM saved_games s WHERE s.user_id=$1 AND s.game_id=g.id) AS saved
       FROM games g
       WHERE EXISTS(SELECT 1 FROM game_read_access access
                    WHERE access.game_id=g.id AND access.user_id=$1)
       AND (title ILIKE $2 OR title_id ILIKE $2)
       ORDER BY title LIMIT 500`,
    [userId, `%${query}%`],
  );
  if (!games.length) return [];
  const ids = games.map((game) => game.id as string);
  const [trailers, artwork, releases] = await Promise.all([
    queryRows(
      db,
      `SELECT t.* FROM game_media t
         WHERE t.game_id = ANY($2::uuid[])
         AND EXISTS(SELECT 1 FROM game_read_access access
                    WHERE access.game_id=t.game_id AND access.user_id=$1)`,
      [userId, ids],
    ),
    queryRows(
      db,
      `SELECT a.game_id, a.kind, a.sha256 FROM artwork a
         WHERE a.game_id = ANY($2::uuid[])
         AND EXISTS(SELECT 1 FROM game_read_access access
                    WHERE access.game_id=a.game_id AND access.user_id=$1)`,
      [userId, ids],
    ),
    queryRows(
      db,
      `SELECT r.*, COALESCE(s.v, '[]') AS sources,
           COALESCE(a.v, '[]') AS artifacts, COALESCE(b.v, '[]') AS backports
         FROM game_releases r
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id',sr.id, 'name',s.name, 'format',sr.metadata->>'format', 'size',sr.metadata->'size'
           )) AS v
           FROM source_releases sr
           JOIN sources s ON s.id = sr.source_id
           WHERE sr.release_id=r.id AND NOT (sr.metadata ? 'retiredAt')
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id',a.id, 'format',a.format, 'size',a.size, 'sha256',a.sha256
           )) AS v
           FROM artifacts a
           WHERE a.release_id=r.id AND a.verified AND a.deleted_at IS NULL
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id',b.id, 'type',b.type, 'size',b.size, 'sha256',b.sha256,
             'inputHash',b.input_hash, 'targetFirmware',b.target_firmware,
             'profileId',b.profile_id, 'tested',b.tested
           )) AS v
           FROM backport_artifacts b
           WHERE b.release_id=r.id AND b.deleted_at IS NULL
         ) b ON true
         WHERE r.game_id = ANY($1::uuid[])
         AND EXISTS(SELECT 1 FROM game_read_access access
                    WHERE access.game_id=r.game_id AND access.user_id=$2)
         AND (s.v IS NOT NULL OR a.v IS NOT NULL OR b.v IS NOT NULL OR EXISTS(
             SELECT 1 FROM console_library_entries l
             JOIN consoles c ON c.id = l.console_id
             WHERE l.release_id=r.id AND l.state='READY_ON_PS5' AND c.user_id=$2
         ))`,
      [ids, userId],
    ),
  ]);
  const hashes = new Map(artwork.map((a) => [`${a.game_id}:${a.kind}`, a.sha256]));
  const image = (id: string, kind: string) =>
    `/api/v1/artwork/${id}/${kind}?v=${hashes.get(`${id}:${kind}`) ?? 'missing'}`;
  const media = (gameId: string, kind: 'music' | 'trailer') => {
    const available = trailers.find(
      (item) => item.game_id === gameId && item.kind === kind && item.state === 'READY',
    );
    return {
      state: trailers.find((item) => item.game_id === gameId && item.kind === kind)?.state ?? null,
      item: available
        ? {
            url: `/api/v1/${kind === 'music' ? 'music' : 'trailers'}/${gameId}`,
            sha256: available.sha256,
            size: available.size,
            duration: available.duration,
          }
        : null,
    };
  };
  return games.map((g) => {
    const trailer = media(g.id, 'trailer'),
      music = media(g.id, 'music');
    return {
      ...g.metadata,
      artwork: undefined,
      id: g.id,
      title: g.title,
      titleId: g.title_id,
      saved: g.saved,
      shared: g.shared,
      canManage: g.user_id === userId,
      addedAt: g.created_at,
      recentlyUpdated: releases.some(
        (r) =>
          r.game_id === g.id &&
          (r.kind === 'UPDATE' ||
            (r.kind === 'BASE' &&
              new Date(r.created_at).getTime() > new Date(g.created_at).getTime() + 1000)),
      ),
      trailerState: trailer.state,
      trailer: trailer.item,
      musicState: music.state,
      music: music.item,
      coverUrl: image(g.id, 'cover'),
      heroUrl: image(g.id, 'hero'),
      iconUrl: image(g.id, 'icon'),
      screenshotUrls: (g.metadata.artwork?.screenshots ?? []).map((_: unknown, i: number) =>
        image(g.id, `screenshot-${i}`),
      ),
      releases: releases
        .filter((r) => r.game_id === g.id)
        .sort(
          (a, b) =>
            ['BASE', 'UPDATE', 'DLC'].indexOf(a.kind) - ['BASE', 'UPDATE', 'DLC'].indexOf(b.kind) ||
            b.version.localeCompare(a.version) ||
            String(a.metadata.title ?? '').localeCompare(String(b.metadata.title ?? '')),
        )
        .map((r) => ({
          ...r.metadata,
          id: r.id,
          contentId: r.content_id,
          version: r.version,
          kind: r.kind,
          sources: r.sources,
          artifacts: r.artifacts,
          backports: r.backports,
        })),
    };
  });
}

export function registerCatalogRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const gameId = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id),
    saved = (req: FastifyRequest) => z.object({ saved: z.boolean() }).parse(req.body).saved,
    query = (req: FastifyRequest) =>
      z.object({ q: z.string().max(200).default('') }).parse(req.query).q;
  const save = async (userId: string, id: string, saved: boolean) => {
    if (
      !(
        await db.query(
          `SELECT g.id
           FROM games g
           JOIN game_read_access access ON access.game_id = g.id
           WHERE g.id = $1 AND access.user_id = $2`,
          [id, userId],
        )
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    if (saved)
      await db.query(
        'INSERT INTO saved_games(user_id,game_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [userId, id],
      );
    else await db.query('DELETE FROM saved_games WHERE user_id=$1 AND game_id=$2', [userId, id]);
    return { saved };
  };
  app.post('/api/v1/games/:id/save', async (req) =>
    save((await auth.user(req)).id, gameId(req), saved(req)),
  );
  app.post('/api/v1/device/games/:id/save', async (req) =>
    save((await auth.device(req)).user_id, gameId(req), saved(req)),
  );
  app.get('/api/v1/catalog', async (req) => catalogFor(db, (await auth.user(req)).id, query(req)));
  app.get('/api/v1/device/catalog', async (req) =>
    catalogFor(db, (await auth.device(req)).user_id, query(req)),
  );
  app.patch('/api/v1/games/:id/sharing', async (req) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('ADMIN_REQUIRED', 403);
    const id = uuid.parse((req.params as { id: string }).id),
      body = z.object({ shared: z.boolean() }).parse(req.body);
    if (
      !(
        await db.query('UPDATE games SET shared=$3 WHERE id=$1 AND user_id=$2 RETURNING id', [
          id,
          user.id,
          body.shared,
        ])
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    return body;
  });
  const ownedGame = async (id: string, userId: string) => {
    const game = (
      await db.query('SELECT id,shared FROM games WHERE id=$1 AND user_id=$2', [id, userId])
    ).rows[0];
    if (!game) throw new AppError('NOT_FOUND', 404);
    return game;
  };
  app.get('/api/v1/games/:id/shares', async (req) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id),
      game = await ownedGame(id, user.id);
    const users = await queryRows(
      db,
      `SELECT u.id,u.username,EXISTS(SELECT 1 FROM game_shares s WHERE s.game_id=$1 AND s.user_id=u.id) AS granted
      FROM users u WHERE u.id<>$2 ORDER BY u.username`,
      [id, user.id],
    );
    return { sharedToAll: game.shared, users };
  });
  app.put('/api/v1/games/:id/shares', async (req) => {
    const user = await auth.user(req),
      id = uuid.parse((req.params as { id: string }).id),
      body = z.object({ userIds: z.array(uuid).max(100) }).parse(req.body),
      userIds = [...new Set(body.userIds)];
    if (userIds.includes(user.id)) throw new AppError('INVALID_SHARE_TARGET', 400);
    await transaction(db, async (sql) => {
      if (
        !(
          await sql.query('SELECT id FROM games WHERE id=$1 AND user_id=$2 FOR UPDATE', [
            id,
            user.id,
          ])
        ).rowCount
      )
        throw new AppError('NOT_FOUND', 404);
      if (
        userIds.length &&
        (
          await queryOne(sql, 'SELECT count(*)::int AS count FROM users WHERE id=ANY($1::uuid[])', [
            userIds,
          ])
        ).count !== userIds.length
      )
        throw new AppError('INVALID_SHARE_TARGET', 400);
      await sql.query('DELETE FROM game_shares WHERE game_id=$1', [id]);
      if (userIds.length)
        await sql.query(
          'INSERT INTO game_shares(game_id,user_id,granted_by) SELECT $1,id,$2 FROM users WHERE id=ANY($3::uuid[])',
          [id, user.id, userIds],
        );
    });
    return { userIds };
  });
  app.get('/api/v1/artwork/:gameId/:kind', async (req, reply) => {
    const params = z
      .object({
        gameId: uuid,
        kind: z.string().regex(/^(cover|hero|icon|screenshot-\d{1,2})$/),
      })
      .parse(req.params);
    let userId: string;
    try {
      userId = (await auth.user(req)).id;
    } catch {
      userId = (await auth.device(req)).user_id;
    }
    if (
      !(
        await db.query(
          `SELECT g.id
             FROM games g
             JOIN game_read_access access ON access.game_id = g.id
             WHERE g.id = $1 AND access.user_id = $2`,
          [params.gameId, userId],
        )
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    const row = await queryOne(db, 'SELECT * FROM artwork WHERE game_id=$1 AND kind=$2', [
      params.gameId,
      params.kind,
    ]);
    reply.header('cache-control', 'private, max-age=3600').header('vary', 'Authorization, Cookie');
    if (!row) return reply.type('image/svg+xml').send(placeholder);
    const etag = `"${row.sha256}"`;
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const checked = await regularFileWithin(
      config.DATA_DIR,
      path.join(config.DATA_DIR, row.relative_path),
      'r',
    );
    return reply.type('image/webp').send(checked.handle.createReadStream());
  });
}
