import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { queryRows, transaction, type DB, type SQL } from '../db.js';
import { heartbeatSchema, type Heartbeat } from '../../../shared/schemas/index.js';
import { AppError } from '../security/errors.js';
import { safeName } from '../security/paths.js';
import type { ConsoleRouteContext } from './shared.js';

type Device = Awaited<ReturnType<ConsoleRouteContext['auth']['device']>>;

const heartbeat = async (db: DB, device: Device, raw: unknown) => {
  const report = heartbeatSchema.parse(raw);
  validateReport(report);
  await transaction(db, async (sql) => {
    const [locked] = report.inventory
      ? await queryRows(sql, 'SELECT library_revision FROM consoles WHERE id=$1 FOR UPDATE', [
          device.id,
        ])
      : [];
    await recordConsoleState(sql, device.id, report);
    await recordSaves(sql, device.id, report);
    await recordStorage(sql, device.id, report);
    if (report.inventory && report.libraryRevision > Number(locked.library_revision)) {
      await reconcileInventory(sql, device, report);
    }
  });
  const [current] = await queryRows(
    db,
    'SELECT firmware_request_id,library_revision FROM consoles WHERE id=$1',
    [device.id],
  );
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    heartbeatIntervalSeconds: 10,
    firmwareRequestId: current.firmware_request_id,
    libraryRevision: Number(current.library_revision),
  };
};

function validateReport(report: Heartbeat) {
  for (const item of report.inventory ?? []) item.relativePath.split('/').forEach(safeName);
  const storageIds = new Set(report.storage.map(({ storageId }) => storageId));
  if (report.inventory?.some(({ storageId }) => !storageIds.has(storageId)))
    throw new AppError('UNKNOWN_STORAGE');
}

async function recordConsoleState(sql: SQL, consoleId: string, report: Heartbeat) {
  // Older clients can initialize a missing registration measurement once.
  await sql.query(
    `UPDATE consoles SET
       last_seen=now(),
       firmware=CASE WHEN firmware_checked_at IS NULL THEN $2 ELSE firmware END,
       firmware_checked_at=COALESCE(firmware_checked_at,now()),
       runtime=$3,client_version=$4,agent_version=$5,shadowmount_version=$6,
       shadowmount_fakelib=$7,standalone_backpork=$8,runtime_status=$9,
       trophy_summary=COALESCE($10::jsonb,trophy_summary),
       trophy_synced_at=CASE WHEN $10::jsonb IS NOT NULL AND trophy_summary IS DISTINCT FROM $10::jsonb
                             THEN now() ELSE trophy_synced_at END
     WHERE id=$1`,
    [
      consoleId,
      report.firmware ?? null,
      report.runtime,
      report.clientVersion,
      report.agentVersion,
      report.shadowMountVersion,
      report.shadowMountFakelib,
      report.standaloneBackPork,
      report.runtimeStatus,
      report.trophySummary ?? null,
    ],
  );
  await sql.query(
    `INSERT INTO console_capabilities(console_id,capabilities) VALUES($1,$2)
     ON CONFLICT(console_id) DO UPDATE SET capabilities=EXCLUDED.capabilities
     WHERE console_capabilities.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
    [consoleId, report.capabilities],
  );
  await sql.query(
    `INSERT INTO console_heartbeats(console_id,payload) VALUES($1,$2)
     ON CONFLICT(console_id) WHERE NOT(payload ? 'launchTrace')
     DO UPDATE SET payload=EXCLUDED.payload,created_at=now()
     WHERE console_heartbeats.payload IS DISTINCT FROM EXCLUDED.payload`,
    [consoleId, { ...report, inventory: undefined, libraryRevision: undefined }],
  );
  await sql.query(
    "UPDATE pairings SET credential_cipher=NULL WHERE console_id=$1 AND kind='AGENT' AND credential_cipher IS NOT NULL",
    [consoleId],
  );
}

async function recordSaves(sql: SQL, consoleId: string, { saveData }: Heartbeat) {
  if (!saveData) return;
  const items = JSON.stringify(saveData.items);
  await sql.query(
    `INSERT INTO console_save_data(
       console_id,local_user_id,platform,game_title_id,save_title_id,directory,
       title,subtitle,detail,size_bytes,modified_at,scan_id)
     SELECT $1,$2,item.platform,item."gameTitleId",item."saveTitleId",item.directory,
            item.title,item.subtitle,item.detail,item."sizeBytes",item."modifiedAt",$4
     FROM jsonb_to_recordset($3::jsonb) AS item(
       platform text,"gameTitleId" text,"saveTitleId" text,directory text,
       title text,subtitle text,detail text,"sizeBytes" bigint,"modifiedAt" bigint)
     ON CONFLICT(console_id,local_user_id,platform,save_title_id,directory) DO UPDATE SET
       game_title_id=EXCLUDED.game_title_id,title=EXCLUDED.title,subtitle=EXCLUDED.subtitle,
       detail=EXCLUDED.detail,size_bytes=EXCLUDED.size_bytes,modified_at=EXCLUDED.modified_at,
       scan_id=EXCLUDED.scan_id,updated_at=now()
     WHERE (console_save_data.game_title_id,console_save_data.title,console_save_data.subtitle,
            console_save_data.detail,console_save_data.size_bytes,console_save_data.modified_at)
       IS DISTINCT FROM
           (EXCLUDED.game_title_id,EXCLUDED.title,EXCLUDED.subtitle,
            EXCLUDED.detail,EXCLUDED.size_bytes,EXCLUDED.modified_at)`,
    [consoleId, saveData.localUserId, items, randomUUID()],
  );
  if (saveData.complete)
    await sql.query(
      `DELETE FROM console_save_data saved WHERE console_id=$1 AND local_user_id=$2 AND NOT EXISTS(
         SELECT 1 FROM jsonb_to_recordset($3::jsonb)
           AS seen(platform text,"saveTitleId" text,directory text)
         WHERE seen.platform=saved.platform AND seen."saveTitleId"=saved.save_title_id
           AND seen.directory=saved.directory)`,
      [consoleId, saveData.localUserId, items],
    );
}

async function recordStorage(sql: SQL, consoleId: string, report: Heartbeat) {
  await sql.query(
    `UPDATE console_storage SET writable=false,methods='[]'::jsonb,total_bytes=0,free_bytes=0
     WHERE console_id=$1 AND NOT(storage_id=ANY($2::text[]))
       AND (writable OR methods<>'[]'::jsonb OR total_bytes<>0 OR free_bytes<>0)`,
    [consoleId, report.storage.map(({ storageId }) => storageId)],
  );
  await sql.query(
    `INSERT INTO console_storage(
       console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods)
     SELECT $1,storage."storageId",storage."displayName",storage.path,
            storage."totalBytes",storage."freeBytes",storage.writable,
            storage."installMethodsSupported"
     FROM jsonb_to_recordset($2::jsonb) AS storage(
       "storageId" text,"displayName" text,path text,"totalBytes" bigint,
       "freeBytes" bigint,writable boolean,"installMethodsSupported" jsonb)
     ON CONFLICT(console_id,storage_id) DO UPDATE SET
       display_name=EXCLUDED.display_name,path=EXCLUDED.path,total_bytes=EXCLUDED.total_bytes,
       free_bytes=EXCLUDED.free_bytes,writable=EXCLUDED.writable,methods=EXCLUDED.methods,last_seen=now()
     WHERE (console_storage.display_name,console_storage.path,console_storage.total_bytes,
            console_storage.free_bytes,console_storage.writable,console_storage.methods)
       IS DISTINCT FROM
           (EXCLUDED.display_name,EXCLUDED.path,EXCLUDED.total_bytes,
            EXCLUDED.free_bytes,EXCLUDED.writable,EXCLUDED.methods)`,
    [consoleId, JSON.stringify(report.storage)],
  );
}

const releaseKey = (gameId: string, contentId: string, version: string) =>
  JSON.stringify([gameId, contentId, version]);
const uniqueBy = <T>(items: T[], key: (item: T) => string) => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

async function reconcileInventory(sql: SQL, device: Device, report: Heartbeat) {
  const inventory = report.inventory!;
  const requestedIds = [
    ...new Set(inventory.flatMap(({ releaseId }) => (releaseId ? [releaseId] : []))),
  ];
  const releases = requestedIds.length
    ? await queryRows(
        sql,
        `SELECT r.id,g.title_id AS "titleId",r.content_id AS "contentId",r.version
         FROM game_releases r JOIN games g ON g.id=r.game_id
         WHERE r.id=ANY($1::uuid[]) AND EXISTS(
           SELECT 1 FROM game_read_access access
           WHERE access.game_id=g.id AND access.user_id=$2)`,
        [requestedIds, device.user_id],
      )
    : [];
  const releaseById = new Map(releases.map((release) => [release.id, release]));
  if (releaseById.size !== requestedIds.length) throw new AppError('NOT_FOUND', 404);
  for (const item of inventory) {
    if (!item.releaseId) continue;
    const release = releaseById.get(item.releaseId);
    if (
      release.titleId !== item.titleId ||
      release.contentId !== item.contentId ||
      release.version !== item.version
    )
      throw new AppError('METADATA_MISMATCH', 409);
  }

  const discovered = inventory.filter(({ releaseId }) => !releaseId);
  const gameSeeds = uniqueBy(
    discovered.map((item) => ({
      id: randomUUID(),
      titleId: item.titleId,
      title: item.title,
      metadata: {
        title: item.title,
        titleId: item.titleId,
        contentId: item.contentId,
        platform: item.platform,
      },
    })),
    ({ titleId }) => titleId,
  );
  if (gameSeeds.length)
    await sql.query(
      `INSERT INTO games(id,user_id,title_id,title,metadata)
       SELECT seed.id,$2,seed."titleId",seed.title,seed.metadata
       FROM jsonb_to_recordset($1::jsonb)
         AS seed(id uuid,"titleId" text,title text,metadata jsonb)
       ON CONFLICT(user_id,title_id) DO NOTHING`,
      [JSON.stringify(gameSeeds), device.user_id],
    );
  const games = gameSeeds.length
    ? await queryRows(
        sql,
        'SELECT id,title_id AS "titleId" FROM games WHERE user_id=$1 AND title_id=ANY($2::text[])',
        [device.user_id, gameSeeds.map(({ titleId }) => titleId)],
      )
    : [];
  const gameByTitle = new Map(games.map((game) => [game.titleId, game.id]));
  const releaseSeeds = uniqueBy(
    discovered.map((item) => {
      const gameId = gameByTitle.get(item.titleId)!;
      return {
        id: randomUUID(),
        gameId,
        contentId: item.contentId,
        version: item.version,
        metadata: {
          format:
            item.source === 'EXISTING_DUMP'
              ? 'folder'
              : item.source === 'INSTALLED_TITLE'
                ? 'pkg'
                : 'unknown',
          minimumFirmware: null,
          size: item.size,
          source: item.source,
        },
      };
    }),
    ({ gameId, contentId, version }) => releaseKey(gameId, contentId, version),
  );
  if (releaseSeeds.length)
    await sql.query(
      `INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata)
       SELECT seed.id,seed."gameId",seed."contentId",seed.version,'BASE',seed.metadata
       FROM jsonb_to_recordset($1::jsonb)
         AS seed(id uuid,"gameId" uuid,"contentId" text,version text,metadata jsonb)
       ON CONFLICT(game_id,content_id,version,kind) DO NOTHING`,
      [JSON.stringify(releaseSeeds)],
    );
  const discoveredReleases = releaseSeeds.length
    ? await queryRows(
        sql,
        `SELECT id,game_id AS "gameId",content_id AS "contentId",version
         FROM game_releases WHERE kind='BASE' AND game_id=ANY($1::uuid[])`,
        [[...new Set(releaseSeeds.map(({ gameId }) => gameId))]],
      )
    : [];
  const discoveredReleaseByKey = new Map(
    discoveredReleases.map((release) => [
      releaseKey(release.gameId, release.contentId, release.version),
      release.id,
    ]),
  );
  await reconcileLibraryEntries(sql, device, report, gameByTitle, discoveredReleaseByKey);
}

async function reconcileLibraryEntries(
  sql: SQL,
  device: Device,
  report: Heartbeat,
  gameByTitle: Map<string, string>,
  discoveredReleaseByKey: Map<string, string>,
) {
  const inventory = report.inventory!;
  const profileIds = [
    ...new Set(
      inventory.flatMap(({ backportProfileId }) => (backportProfileId ? [backportProfileId] : [])),
    ),
  ];
  const profiles = profileIds.length
    ? await queryRows(
        sql,
        `SELECT p.id,p.title_id AS "titleId",p.content_id AS "contentId",p.game_version AS version
         FROM compatibility_profiles p WHERE p.id=ANY($1::uuid[]) AND (
           p.user_id=$2 OR EXISTS(
             SELECT 1 FROM games g JOIN game_read_access access ON access.game_id=g.id
             WHERE g.user_id=p.user_id AND g.title_id=p.title_id AND access.user_id=$2))`,
        [profileIds, device.user_id],
      )
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const resolved = new Map<string, unknown>();
  for (const item of inventory) {
    const releaseId =
      item.releaseId ??
      discoveredReleaseByKey.get(
        releaseKey(gameByTitle.get(item.titleId)!, item.contentId, item.version),
      );
    if (!releaseId) throw new AppError('NOT_FOUND', 404);
    const profile = item.backportProfileId ? profileById.get(item.backportProfileId) : null;
    const staleProfile =
      !!item.backportProfileId &&
      (!profile ||
        profile.titleId !== item.titleId ||
        profile.contentId !== item.contentId ||
        profile.version !== item.version);
    resolved.set(`${releaseId}\0${item.storageId}`, {
      releaseId,
      storageId: item.storageId,
      state: staleProfile ? 'ERROR' : item.available ? 'READY_ON_PS5' : 'MISSING',
      relativePath: item.relativePath,
      sha256: item.sha256,
      size: item.size,
      registered: item.registered,
      backportProfileId: staleProfile ? null : (item.backportProfileId ?? null),
      source: item.source,
      backportFiles: staleProfile ? false : item.backportFiles,
    });
  }
  const entries = [...resolved.values()];
  if (entries.length)
    await sql.query(
      `INSERT INTO console_library_entries(
         console_id,release_id,storage_id,state,relative_path,sha256,size,registered,
         backport_profile_id,revision,source,backport_files)
       SELECT $1,observed."releaseId",observed."storageId",
         CASE WHEN observed.state='READY_ON_PS5' AND EXISTS(
           SELECT 1 FROM jobs j JOIN artifacts a ON a.id=j.artifact_id AND a.release_id=j.release_id
           WHERE j.console_id=$1 AND j.release_id=observed."releaseId"
             AND j.storage_id=observed."storageId" AND j.kind='TRANSFER'
             AND j.state='READY_ON_PS5' AND j.config?'launchFailure'
             AND ((j.config->>'method'='FPKG'
                   AND a.inspection#>>'{installedImage,sha256}'=observed.sha256
                   AND a.inspection#>>'{installedImage,size}'=observed.size::text)
               OR (j.config->>'method'<>'FPKG' AND a.sha256=observed.sha256 AND a.size=observed.size))
             AND observed."backportProfileId" IS NOT DISTINCT FROM
                 COALESCE((j.config#>>'{backport,profile,id}')::uuid,a.profile_id)
             AND observed."backportFiles"=
                 COALESCE(j.config#>>'{backport,placement}'='SCAN_PATH',false))
         THEN 'ERROR' ELSE observed.state END,
         observed."relativePath",observed.sha256,observed.size,observed.registered,
         observed."backportProfileId",$3,observed.source,observed."backportFiles"
       FROM jsonb_to_recordset($2::jsonb) AS observed(
         "releaseId" uuid,"storageId" text,state text,"relativePath" text,sha256 text,
         size bigint,registered boolean,"backportProfileId" uuid,source text,"backportFiles" boolean)
       ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET
         state=EXCLUDED.state,relative_path=EXCLUDED.relative_path,sha256=EXCLUDED.sha256,
         size=EXCLUDED.size,registered=EXCLUDED.registered,
         backport_profile_id=EXCLUDED.backport_profile_id,revision=EXCLUDED.revision,
         source=EXCLUDED.source,backport_files=EXCLUDED.backport_files,updated_at=now()
       WHERE (console_library_entries.state,console_library_entries.relative_path,
              console_library_entries.sha256,console_library_entries.size,
              console_library_entries.registered,console_library_entries.backport_profile_id,
              console_library_entries.source,console_library_entries.backport_files)
         IS DISTINCT FROM
             (EXCLUDED.state,EXCLUDED.relative_path,EXCLUDED.sha256,EXCLUDED.size,
              EXCLUDED.registered,EXCLUDED.backport_profile_id,EXCLUDED.source,EXCLUDED.backport_files)`,
      [device.id, JSON.stringify(entries), report.libraryRevision],
    );
  if (report.inventoryComplete)
    await sql.query(
      `UPDATE console_library_entries item SET state='MISSING',updated_at=now()
       WHERE console_id=$1 AND state='READY_ON_PS5' AND NOT EXISTS(
         SELECT 1 FROM jsonb_to_recordset($2::jsonb)
           AS observed("releaseId" uuid,"storageId" text)
         WHERE observed."releaseId"=item.release_id AND observed."storageId"=item.storage_id)`,
      [device.id, JSON.stringify(entries)],
    );
  await sql.query('UPDATE consoles SET library_revision=$2 WHERE id=$1', [
    device.id,
    report.libraryRevision,
  ]);
}

export function registerConsoleHeartbeatRoutes({ app, db, config, auth }: ConsoleRouteContext) {
  app.post('/api/v1/device/heartbeat', async (req) =>
    heartbeat(db, await auth.device(req), req.body),
  );
  app.get('/api/v1/device/status', async (req) => {
    const console = await auth.device(req);
    return {
      id: console.id,
      name: console.name,
      firmware: console.firmware,
      runtime: console.runtime,
      runtimeStatus: console.runtime_status,
      storage: await queryRows(
        db,
        `SELECT storage_id AS "storageId",display_name AS "displayName",path,
                  total_bytes AS "totalBytes",free_bytes AS "freeBytes",writable
           FROM console_storage_volumes
           WHERE console_id=$1 AND (writable OR jsonb_array_length(methods)>0)
           ORDER BY display_name,storage_id`,
        [console.id],
      ),
      library: await queryRows(
        db,
        `SELECT release_id AS "releaseId",state,storage_id AS "storageId",
                  relative_path AS "relativePath",registered,source,
                  backport_files AS "backportFiles"
           FROM console_library_entries WHERE console_id=$1`,
        [console.id],
      ),
    };
  });
  app.get(
    '/api/v1/device/live',
    { websocket: true, preValidation: async (req) => void (await auth.device(req)) },
    (socket, req) => {
      let busy = false;
      socket.on('message', async (raw) => {
        if (!deviceLiveMessageAllowed(config, socket)) return;
        if (busy) return socket.close(1008, 'Heartbeat already pending');
        busy = true;
        try {
          socket.send(
            JSON.stringify(await heartbeat(db, await auth.device(req), JSON.parse(raw.toString()))),
          );
        } catch {
          socket.close(1008, 'Invalid heartbeat or credential');
        } finally {
          busy = false;
        }
      });
    },
  );
}

export const deviceLiveMessageAllowed = (
  config: Pick<Config, 'features'>,
  socket: { close(code: number, reason: string): unknown },
) => {
  if (config.features.ps5Connections) return true;
  socket.close(1008, 'PS5 connections disabled');
  return false;
};
