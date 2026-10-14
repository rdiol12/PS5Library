import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { queryOne, queryRows, transaction, type DB } from '../db.js';
import { seal, unseal } from '../auth/credentials.js';
import {
  firmware,
  launchTraceByteLimit,
  launchTraceSchema,
  uuid,
} from '../../../shared/schemas/index.js';
import { presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { removalSupported } from './removals.js';
import { requireOwnedConsole, type ConsoleRouteContext } from './shared.js';

const remotePlayAccountId = z
  .string()
  .regex(/^[A-Za-z0-9+/]{11}=$/)
  .refine(
    (value) =>
      Buffer.from(value, 'base64').length === 8 &&
      Buffer.from(value, 'base64').toString('base64') === value,
    'Expected the base64 form of an 8-byte account ID',
  );
const remotePlaySecret = z.object({
  pin: z.string().regex(/^\d{8}$/),
  accountId: remotePlayAccountId,
});
const remotePlayReport = z.discriminatedUnion('state', [
  remotePlaySecret.extend({ state: z.literal('READY') }).strict(),
  z.object({ state: z.literal('PAIRED') }).strict(),
  z.object({ state: z.literal('ERROR'), error: z.string().regex(/^[A-Z0-9_]{1,80}$/) }).strict(),
]);

type User = Awaited<ReturnType<ConsoleRouteContext['auth']['user']>>;

const routeId = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

export function registerConsoleRoutes(context: ConsoleRouteContext) {
  const { app, db, auth } = context;
  app.get('/api/v1/consoles', async (req) => listConsoles(db, await auth.user(req)));
  registerRemotePlayRoutes(context);
  registerRefreshRoutes(context);
  registerManagementRoutes(context);
  registerLibraryRoutes(context);
  registerLaunchTraceRoutes(context);
}

async function listConsoles(db: DB, user: User) {
  const consoles = await queryRows(
    db,
    `SELECT c.id,c.name,c.client_kind AS "clientKind",c.firmware,c.runtime,
            c.runtime_status AS "runtimeStatus",c.last_seen AS "lastSeen",
            COALESCE(k.capabilities,'{}') AS capabilities,
                (SELECT count(DISTINCT r.game_id)::int
                   FROM console_library_entries l
                   JOIN game_releases r ON r.id=l.release_id
                  WHERE l.console_id=c.id AND l.state='READY_ON_PS5') AS games,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'storageId',s.storage_id,
                      'displayName',s.display_name,
                      'totalBytes',s.total_bytes,
                      'freeBytes',s.free_bytes,
                      'writable',s.writable,
                      'installMethodsSupported',s.methods
                    ) ORDER BY s.display_name,s.storage_id
                  )
                    FROM console_storage_volumes s
                   WHERE s.console_id=c.id
                     AND (s.writable OR jsonb_array_length(s.methods)>0)
                ),'[]') AS storage
           FROM consoles c
           LEFT JOIN console_capabilities k ON k.console_id=c.id
          WHERE c.user_id=$1
          ORDER BY c.created_at`,
    [user.id],
  );
  return consoles.map((console) => ({
    ...console,
    presence: presence(console.lastSeen ? new Date(console.lastSeen).getTime() : null),
    isDefault: user.default_console_id === console.id,
  }));
}

function registerRemotePlayRoutes({ app, db, config, auth }: ConsoleRouteContext) {
  app.post(
    '/api/v1/consoles/:id/remote-play/pairing',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await auth.user(req),
        consoleId = routeId(req),
        requestId = randomUUID();
      const row = await transaction(db, async (sql) => {
        const console = await queryOne(
          sql,
          `SELECT c.last_seen,c.remote_play_pairing_state,c.remote_play_pairing_expires_at,COALESCE(k.capabilities,'{}'::jsonb) AS capabilities
        FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c`,
          [consoleId, user.id],
        );
        if (!console) throw new AppError('NOT_FOUND', 404);
        if (console.capabilities.remotePlayPairing !== true)
          throw new AppError(
            'CAPABILITY_UNAVAILABLE',
            409,
            'This PS5 has not reported native Remote Play pairing support.',
          );
        if (presence(console.last_seen ? new Date(console.last_seen).getTime() : null) !== 'ONLINE')
          throw new AppError(
            'CONSOLE_OFFLINE',
            409,
            'The PS5 agent must be online to request a Remote Play PIN.',
          );
        if (
          ['REQUESTED', 'READY'].includes(console.remote_play_pairing_state) &&
          new Date(console.remote_play_pairing_expires_at).getTime() > Date.now()
        )
          throw new AppError('REMOTE_PLAY_PAIRING_ACTIVE', 409);
        return queryOne(
          sql,
          `UPDATE consoles SET remote_play_pairing_id=$2,remote_play_pairing_state='REQUESTED',remote_play_pairing_cipher=NULL,remote_play_pairing_error=NULL,
        remote_play_pairing_expires_at=now()+interval '5 minutes',remote_play_pairing_updated_at=now() WHERE id=$1
        RETURNING remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_expires_at AS "expiresAt"`,
          [consoleId, requestId],
        );
      });
      return reply.code(201).send(row);
    },
  );
  app.get('/api/v1/consoles/:id/remote-play/pairing/:requestId', async (req) => {
    const user = await auth.user(req),
      params = req.params as { id: string; requestId: string },
      consoleId = uuid.parse(params.id),
      requestId = uuid.parse(params.requestId);
    let row = await queryOne(
      db,
      `SELECT remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_cipher AS cipher,
      remote_play_pairing_error AS error,remote_play_pairing_expires_at AS "expiresAt",remote_play_pairing_updated_at AS "updatedAt"
      FROM consoles WHERE id=$1 AND user_id=$2 AND remote_play_pairing_id=$3`,
      [consoleId, user.id, requestId],
    );
    if (!row) throw new AppError('NOT_FOUND', 404);
    if (
      ['REQUESTED', 'READY'].includes(row.state) &&
      new Date(row.expiresAt).getTime() <= Date.now()
    )
      row = await queryOne(
        db,
        `UPDATE consoles SET remote_play_pairing_state='ERROR',remote_play_pairing_cipher=NULL,
      remote_play_pairing_error='REMOTE_PLAY_PAIRING_EXPIRED',remote_play_pairing_updated_at=now() WHERE id=$1 AND remote_play_pairing_id=$2
      RETURNING remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_cipher AS cipher,remote_play_pairing_error AS error,
      remote_play_pairing_expires_at AS "expiresAt",remote_play_pairing_updated_at AS "updatedAt"`,
        [consoleId, requestId],
      );
    const secret =
      row.state === 'READY' && row.cipher
        ? remotePlaySecret.parse(JSON.parse(unseal(row.cipher, config.BOOTSTRAP_TOKEN)))
        : {};
    return {
      id: row.id,
      state: row.state,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
      ...(row.error ? { error: row.error } : {}),
      ...secret,
    };
  });
  app.get('/api/v1/device/remote-play/pairing', async (req) => {
    const device = await auth.device(req);
    await db.query(
      `UPDATE consoles SET remote_play_pairing_state='ERROR',remote_play_pairing_cipher=NULL,
      remote_play_pairing_error='REMOTE_PLAY_PAIRING_EXPIRED',remote_play_pairing_updated_at=now()
      WHERE id=$1 AND remote_play_pairing_state IN ('REQUESTED','READY') AND remote_play_pairing_expires_at<=now()`,
      [device.id],
    );
    const row = await queryOne(
      db,
      `SELECT remote_play_pairing_id AS id,remote_play_pairing_state AS state,remote_play_pairing_expires_at AS "expiresAt"
      FROM consoles WHERE id=$1 AND remote_play_pairing_state IN ('REQUESTED','READY') AND remote_play_pairing_expires_at>now()`,
      [device.id],
    );
    return row ?? null;
  });
  app.post('/api/v1/device/remote-play/pairing/:requestId', async (req) => {
    const device = await auth.device(req),
      requestId = uuid.parse((req.params as { requestId: string }).requestId),
      body = remotePlayReport.parse(req.body);
    await transaction(db, async (sql) => {
      const row = await queryOne(
        sql,
        'SELECT remote_play_pairing_state AS state FROM consoles WHERE id=$1 AND remote_play_pairing_id=$2 AND remote_play_pairing_expires_at>now() FOR UPDATE',
        [device.id, requestId],
      );
      if (!row) throw new AppError('REMOTE_PLAY_PAIRING_EXPIRED', 410);
      if (
        (body.state === 'READY' && row.state !== 'REQUESTED') ||
        (body.state === 'PAIRED' && row.state !== 'READY') ||
        (body.state === 'ERROR' && !['REQUESTED', 'READY'].includes(row.state))
      )
        throw new AppError('INVALID_PAIRING_STATE', 409);
      const cipher =
        body.state === 'READY'
          ? seal(
              JSON.stringify({ pin: body.pin, accountId: body.accountId }),
              config.BOOTSTRAP_TOKEN,
            )
          : null;
      const error = body.state === 'ERROR' ? body.error : null;
      await sql.query(
        `UPDATE consoles SET remote_play_pairing_state=$3,remote_play_pairing_cipher=$4,remote_play_pairing_error=$5,remote_play_pairing_updated_at=now()
        WHERE id=$1 AND remote_play_pairing_id=$2`,
        [device.id, requestId, body.state, cipher, error],
      );
    });
    return { ok: true };
  });
}

function registerRefreshRoutes({ app, db, auth }: ConsoleRouteContext) {
  for (const device of [false, true])
    app.post(`/api/v1/${device ? 'device/' : ''}consoles/:id/refresh`, async (req, reply) => {
      const owner = device ? (await auth.device(req)).user_id : (await auth.user(req)).id,
        id = routeId(req);
      const row = await queryOne(
        db,
        'UPDATE consoles SET firmware_request_id=COALESCE(firmware_request_id,$3) WHERE id=$1 AND user_id=$2 RETURNING firmware_request_id',
        [id, owner, randomUUID()],
      );
      if (!row) throw new AppError('NOT_FOUND', 404);
      return reply.code(202).send({ requestId: row.firmware_request_id });
    });
  app.post('/api/v1/device/firmware', async (req) => {
    const device = await auth.device(req),
      body = z.object({ firmware: firmware.nullable(), requestId: uuid }).parse(req.body);
    if (
      !(
        await db.query(
          'UPDATE consoles SET firmware=$2,firmware_checked_at=now(),firmware_request_id=NULL WHERE id=$1 AND firmware_request_id=$3',
          [device.id, body.firmware, body.requestId],
        )
      ).rowCount
    )
      throw new AppError('FIRMWARE_REFRESH_NOT_REQUESTED', 409);
    return { ok: true };
  });
}

function registerManagementRoutes({ app, db, auth }: ConsoleRouteContext) {
  app.get('/api/v1/device/consoles', async (req) => {
    const device = await auth.device(req);
    return listConsoles(
      db,
      await queryOne(db, 'SELECT id,default_console_id FROM users WHERE id=$1', [device.user_id]),
    );
  });
  app.patch('/api/v1/consoles/:id', async (req) => {
    const user = await auth.user(req),
      id = routeId(req);
    const body = z
      .object({ name: z.string().min(1).max(80).optional(), isDefault: z.boolean().optional() })
      .parse(req.body);
    return transaction(db, async (sql) => {
      await requireOwnedConsole(sql, id, user.id, true);
      if (body.name) await sql.query('UPDATE consoles SET name=$1 WHERE id=$2', [body.name, id]);
      if (body.isDefault)
        await sql.query('UPDATE users SET default_console_id=$1 WHERE id=$2', [id, user.id]);
      return { ok: true };
    });
  });
  app.post(
    '/api/v1/consoles/:id/notifications/test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await auth.user(req),
        consoleId = routeId(req);
      const found = await queryOne(
        db,
        "SELECT COALESCE(k.capabilities,'{}'::jsonb) AS capabilities FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.id=$1 AND c.user_id=$2",
        [consoleId, user.id],
      );
      if (!found) throw new AppError('NOT_FOUND', 404);
      if (found.capabilities.nativeNotifications !== true)
        throw new AppError(
          'CAPABILITY_UNAVAILABLE',
          409,
          'This PS5 has not reported native notification support.',
        );
      const id = randomUUID();
      await db.query(
        `INSERT INTO console_notices(
           id,user_id,console_id,release_id,code,context,message,resolve_on_delivery
         ) VALUES(
           $1,$2,$3,NULL,'NATIVE_TEST',$4,
           'PS5Library native notifications are connected.',true
         )`,
        [id, user.id, consoleId, randomUUID()],
      );
      return reply.code(202).send({ id });
    },
  );
  app.post('/api/v1/consoles/:id/revoke', async (req) => {
    const user = await auth.user(req),
      id = routeId(req);
    return transaction(db, async (sql) => {
      await requireOwnedConsole(sql, id, user.id, true);
      await sql.query('UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1', [id]);
      await sql.query(
        'UPDATE console_hardware_identities SET recovery_disabled_at=now() WHERE console_id=$1',
        [id],
      );
      return { ok: true };
    });
  });
  app.delete('/api/v1/admin/consoles/:id', async (req) => {
    const user = await auth.user(req);
    if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN', 403);
    const id = routeId(req);
    return transaction(db, async (sql) => {
      const console = await queryOne(
        sql,
        'SELECT c.id,i.lookup_hash FROM consoles c LEFT JOIN console_hardware_identities i ON i.console_id=c.id WHERE c.id=$1 FOR UPDATE OF c',
        [id],
      );
      if (!console) throw new AppError('NOT_FOUND', 404);
      const temporary = console.lookup_hash
        ? await queryRows(
            sql,
            'SELECT console_id FROM pairings WHERE hardware_lookup_hash=$1 AND console_id<>$2',
            [console.lookup_hash, id],
          )
        : [];
      await sql.query('DELETE FROM pairings WHERE console_id=$1 OR hardware_lookup_hash=$2', [
        id,
        console.lookup_hash,
      ]);
      await sql.query('UPDATE users SET default_console_id=NULL WHERE default_console_id=$1', [id]);
      await sql.query(
        `DELETE FROM save_imports WHERE console_id=$1 OR archive_id IN (SELECT id FROM portable_save_archives WHERE console_id=$1)
        OR rollback_backup_id IN (SELECT id FROM save_backups WHERE console_id=$1)`,
        [id],
      );
      await sql.query('DELETE FROM installations WHERE console_id=$1', [id]);
      await sql.query(
        'DELETE FROM native_download_grants WHERE job_id IN (SELECT id FROM jobs WHERE console_id=$1)',
        [id],
      );
      await sql.query(
        'DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE console_id=$1)',
        [id],
      );
      await sql.query('DELETE FROM jobs WHERE console_id=$1', [id]);
      await sql.query('DELETE FROM console_notices WHERE console_id=$1', [id]);
      await sql.query('DELETE FROM console_library_entries WHERE console_id=$1', [id]);
      await sql.query('DELETE FROM consoles WHERE id=$1', [id]);
      for (const row of temporary)
        await sql.query(
          'DELETE FROM consoles c WHERE c.id=$1 AND c.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM pairings p WHERE p.console_id=c.id)',
          [row.console_id],
        );
      return { ok: true };
    });
  });
}

function registerLibraryRoutes({ app, db, auth }: ConsoleRouteContext) {
  const library = async (userId: string, id: string) => {
    await requireOwnedConsole(db, id, userId);
    return (
      await queryRows(
        db,
        `SELECT l.release_id AS "releaseId",g.title,g.title_id AS "titleId",r.version,
                l.storage_id AS "storageId",l.state,l.registered,
                l.backport_profile_id AS "backportProfileId",l.source,
                l.backport_files AS "backportFiles",k.capabilities
           FROM console_library_entries l
           JOIN game_releases r ON r.id=l.release_id
           JOIN games g ON g.id=r.game_id
           LEFT JOIN console_capabilities k ON k.console_id=l.console_id
          WHERE l.console_id=$1`,
        [id],
      )
    ).map(({ capabilities, ...entry }) => ({
      ...entry,
      canDelete: removalSupported(entry, capabilities),
    }));
  };
  app.get('/api/v1/consoles/:id/library', async (req) =>
    library((await auth.user(req)).id, routeId(req)),
  );
  app.get('/api/v1/device/consoles/:id/library', async (req) =>
    library((await auth.device(req)).user_id, routeId(req)),
  );
}

function registerLaunchTraceRoutes({ app, db, auth }: ConsoleRouteContext) {
  app.post(
    '/api/v1/device/launch-traces',
    { bodyLimit: launchTraceByteLimit },
    async (req, reply) => {
      const device = await auth.device(req),
        trace = launchTraceSchema.parse(req.body),
        encoded = JSON.stringify(trace);
      if (Buffer.byteLength(encoded) > launchTraceByteLimit)
        throw new AppError('TRACE_TOO_LARGE', 413);
      const sha256 = createHash('sha256').update(encoded).digest('hex');
      const stored = await transaction(db, async (sql) => {
        await sql.query('SELECT id FROM consoles WHERE id=$1 FOR UPDATE', [device.id]);
        const existing = await queryOne(
          sql,
          `SELECT id,created_at AS "createdAt" FROM console_heartbeats WHERE console_id=$1 AND payload->>'launchTraceSha256'=$2 ORDER BY id DESC LIMIT 1`,
          [device.id, sha256],
        );
        if (existing) return { ...existing, created: false };
        const row = await queryOne(
          sql,
          'INSERT INTO console_heartbeats(console_id,payload) VALUES($1,$2) RETURNING id,created_at AS "createdAt"',
          [device.id, { launchTrace: trace, launchTraceSha256: sha256 }],
        );
        if (trace.mdbgExceptionStop) {
          const matches = await queryRows(
            sql,
            `SELECT j.id AS job_id,j.release_id,j.storage_id
          FROM jobs j JOIN game_releases r ON r.id=j.release_id JOIN games g ON g.id=r.game_id
          JOIN artifacts a ON a.id=j.artifact_id AND a.release_id=j.release_id
          JOIN console_library_entries l ON l.console_id=j.console_id AND l.release_id=j.release_id AND l.storage_id=j.storage_id
          WHERE j.console_id=$1 AND j.kind='TRANSFER' AND j.state='READY_ON_PS5' AND g.title_id=$2 AND l.state='READY_ON_PS5'
            AND ((j.config->>'method'='FPKG' AND a.inspection#>>'{installedImage,sha256}'=l.sha256 AND a.inspection#>>'{installedImage,size}'=l.size::text)
              OR (j.config->>'method'<>'FPKG' AND a.sha256=l.sha256 AND a.size=l.size))
            AND l.backport_profile_id IS NOT DISTINCT FROM COALESCE((j.config#>>'{backport,profile,id}')::uuid,a.profile_id)
            AND l.backport_files=COALESCE(j.config#>>'{backport,placement}'='SCAN_PATH',false)
          ORDER BY j.id LIMIT 2 FOR UPDATE OF j,l`,
            [device.id, trace.titleId],
          );
          if (matches.length === 1) {
            const failed = matches[0];
            const launchFailure = {
              traceSha256: sha256,
              state: trace.state,
              observedAtUnixMs: trace.mdbgExceptionObservedAtUnixMs ?? trace.traceCompletedAtUnixMs,
            };
            await sql.query(
              "UPDATE jobs SET config=config||jsonb_build_object('launchFailure',$2::jsonb) WHERE id=$1",
              [failed.job_id, JSON.stringify(launchFailure)],
            );
            await sql.query(
              "UPDATE console_library_entries SET state='ERROR',updated_at=now() WHERE console_id=$1 AND release_id=$2 AND storage_id=$3 AND state='READY_ON_PS5'",
              [device.id, failed.release_id, failed.storage_id],
            );
          }
        }
        return { ...row, created: true };
      });
      return reply.code(stored.created ? 201 : 200).send({
        id: stored.id,
        sha256,
        createdAt: stored.createdAt,
      });
    },
  );
  app.get('/api/v1/consoles/:id/launch-traces', async (req) => {
    const user = await auth.user(req),
      id = routeId(req),
      query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
        .strict()
        .parse(req.query);
    await requireOwnedConsole(db, id, user.id);
    return queryRows(
      db,
      `SELECT id, payload->>'launchTraceSha256' AS sha256,
                payload->'launchTrace' AS trace, created_at AS "createdAt"
           FROM console_heartbeats
          WHERE console_id=$1 AND payload ? 'launchTrace'
          ORDER BY id DESC
          LIMIT $2`,
      [id, query.limit],
    );
  });
}
