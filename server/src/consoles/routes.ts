import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { hash, seal, unseal, secret, sameSecret } from '../auth/credentials.js';
import { heartbeatSchema, uuid } from '../../../shared/schemas/index.js';
import { presence } from '../library/policy.js';
import { AppError } from '../security/errors.js';
import { safeName } from '../security/paths.js';

export async function consoleRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  app.post('/api/v1/pairings', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ deviceId: uuid, name: z.string().min(1).max(80), clientKind: z.enum(['PS5','SIMULATOR']) }).parse(req.body);
    const id = randomUUID(), code = randomBytes(5).toString('hex').toUpperCase();let consoleId=randomUUID();
    const pollSecret = secret();
    await transaction(db, async sql => {
      const existing = (await sql.query('SELECT id,user_id FROM consoles WHERE device_id=$1 FOR UPDATE', [body.deviceId])).rows[0];
      if (existing?.user_id || existing&&(await sql.query('SELECT id FROM pairings WHERE console_id=$1 AND expires_at>now()',[existing.id])).rowCount) throw new AppError('DEVICE_ALREADY_REGISTERED', 409, 'Use the stored device credential, or revoke and reset the device identity.');
      if(existing)consoleId=existing.id;else await sql.query('INSERT INTO consoles(id,device_id,name,client_kind) VALUES($1,$2,$3,$4)', [consoleId, body.deviceId, body.name, body.clientKind]);
      await sql.query("INSERT INTO pairings(id,console_id,code_hash,poll_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [id, consoleId, hash(code), hash(pollSecret)]);
    });
    return reply.code(201).send({ id, code, pollSecret, expiresInSeconds: 600, pairingUrl: `${config.PUBLIC_URL}/pair?code=${code}` });
  });
  app.post('/api/v1/pairings/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const user = await auth.user(req);
    const code = z.object({ code: z.string().regex(/^[a-fA-F0-9]{10}$/) }).parse(req.body).code.toUpperCase();
    return transaction(db, async sql => {
      const pair = (await sql.query('SELECT * FROM pairings WHERE code_hash=$1 FOR UPDATE', [hash(code)])).rows[0];
      if (!pair || new Date(pair.expires_at).getTime() <= Date.now()) throw new AppError('PAIRING_EXPIRED', 410);
      if (pair.claimed_at) throw new AppError('PAIRING_ALREADY_CLAIMED', 409);
      const credential = secret();
      await sql.query('UPDATE consoles SET user_id=$1 WHERE id=$2', [user.id, pair.console_id]);
      await sql.query('INSERT INTO console_credentials(id,console_id,token_hash) VALUES($1,$2,$3)', [randomUUID(), pair.console_id, hash(credential)]);
      await sql.query('UPDATE pairings SET claimed_at=now(),credential_cipher=$1 WHERE id=$2', [seal(credential, config.BOOTSTRAP_TOKEN), pair.id]);
      await sql.query('UPDATE users SET default_console_id=COALESCE(default_console_id,$1) WHERE id=$2', [pair.console_id, user.id]);
      return { consoleId: pair.console_id };
    });
  });
  app.post('/api/v1/pairings/:id/poll', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async req => {
    const id = uuid.parse((req.params as { id: string }).id);
    const pollSecret = z.object({ pollSecret: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body).pollSecret;
    const pair = (await db.query('SELECT * FROM pairings WHERE id=$1 AND expires_at>now()', [id])).rows[0];
    if (!pair || !sameSecret(pair.poll_hash, hash(pollSecret))) throw new AppError('PAIRING_EXPIRED', 410);
    if (!pair.claimed_at) return { status: 'PENDING' };
    if (!pair.credential_cipher) throw new AppError('CREDENTIAL_ALREADY_ACKNOWLEDGED', 409);
    return { status: 'PAIRED', consoleId: pair.console_id, credential: unseal(pair.credential_cipher, config.BOOTSTRAP_TOKEN) };
  });
  const listConsoles = async (user: any) => {
    const rows = (await db.query(`SELECT c.*,COALESCE(k.capabilities,'{}') AS capabilities,
      (SELECT count(*)::int FROM console_library_entries l WHERE l.console_id=c.id AND l.state='READY_ON_PS5') AS games,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('storageId',s.storage_id,'displayName',s.display_name,'totalBytes',s.total_bytes,'freeBytes',s.free_bytes,'writable',s.writable,'installMethodsSupported',s.methods)) FROM console_storage s WHERE s.console_id=c.id),'[]') AS storage
      FROM consoles c LEFT JOIN console_capabilities k ON k.console_id=c.id WHERE c.user_id=$1 ORDER BY c.created_at`, [user.id])).rows;
    return rows.map(c => ({ id: c.id, name: c.name, clientKind: c.client_kind, firmware: c.firmware, runtime: c.runtime, lastSeen: c.last_seen, presence: presence(c.last_seen ? new Date(c.last_seen).getTime() : null), games: c.games, storage: c.storage, capabilities: c.capabilities, isDefault: user.default_console_id === c.id }));
  };
  app.get('/api/v1/consoles', async req => listConsoles(await auth.user(req)));
  app.get('/api/v1/device/consoles', async req => {
    const device = await auth.device(req);
    return listConsoles((await db.query('SELECT id,default_console_id FROM users WHERE id=$1', [device.user_id])).rows[0]);
  });
  app.patch('/api/v1/consoles/:id', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ name: z.string().min(1).max(80).optional(), isDefault: z.boolean().optional() }).parse(req.body);
    return transaction(db, async sql => {
      if (!(await sql.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rowCount) throw new AppError('NOT_FOUND', 404);
      if (body.name) await sql.query('UPDATE consoles SET name=$1 WHERE id=$2', [body.name, id]);
      if (body.isDefault) await sql.query('UPDATE users SET default_console_id=$1 WHERE id=$2', [id, user.id]);
      return { ok: true };
    });
  });
  app.post('/api/v1/consoles/:id/revoke', async req => {
    const user = await auth.user(req), id = uuid.parse((req.params as { id: string }).id);
    if (!(await db.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2', [id, user.id])).rowCount) throw new AppError('NOT_FOUND', 404);
    await db.query('UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1', [id]);
    return { ok: true };
  });
  const library = async (userId: string, id: string) => {
    if (!(await db.query('SELECT id FROM consoles WHERE id=$1 AND user_id=$2', [id, userId])).rowCount) throw new AppError('NOT_FOUND', 404);
    return (await db.query('SELECT l.*,g.title,g.title_id,r.version FROM console_library_entries l JOIN game_releases r ON r.id=l.release_id JOIN games g ON g.id=r.game_id WHERE l.console_id=$1', [id])).rows.map(r => ({ releaseId: r.release_id, title: r.title, titleId: r.title_id, version: r.version, storageId: r.storage_id, state: r.state, registered: r.registered, backportProfileId: r.backport_profile_id }));
  };
  app.get('/api/v1/consoles/:id/library', async req => library((await auth.user(req)).id, uuid.parse((req.params as { id: string }).id)));
  app.get('/api/v1/device/consoles/:id/library', async req => library((await auth.device(req)).user_id, uuid.parse((req.params as { id: string }).id)));
  const heartbeat = async (device: any, raw: unknown) => {
    const body = heartbeatSchema.parse(raw);
    for (const item of body.inventory ?? []) item.relativePath.split('/').forEach(safeName);
    await transaction(db, async sql => {
      const current = (await sql.query('SELECT library_revision FROM consoles WHERE id=$1 FOR UPDATE', [device.id])).rows[0];
      await sql.query('UPDATE consoles SET last_seen=now(),firmware=$2,runtime=$3,client_version=$4,agent_version=$5,shadowmount_version=$6,shadowmount_fakelib=$7,standalone_backpork=$8 WHERE id=$1', [device.id, body.firmware, body.runtime, body.clientVersion, body.agentVersion, body.shadowMountVersion, body.shadowMountFakelib, body.standaloneBackPork]);
      await sql.query('INSERT INTO console_capabilities(console_id,capabilities) VALUES($1,$2) ON CONFLICT(console_id) DO UPDATE SET capabilities=$2', [device.id, body.capabilities]);
      await sql.query('INSERT INTO console_heartbeats(console_id,payload) VALUES($1,$2)', [device.id, { ...body, inventory: undefined }]);
      await sql.query('UPDATE pairings SET credential_cipher=NULL WHERE console_id=$1', [device.id]);
      await sql.query('UPDATE console_storage SET writable=false WHERE console_id=$1', [device.id]);
      for (const s of body.storage) await sql.query('INSERT INTO console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(console_id,storage_id) DO UPDATE SET display_name=$3,path=$4,total_bytes=$5,free_bytes=$6,writable=$7,methods=$8,last_seen=now()', [device.id, s.storageId, s.displayName, s.path, s.totalBytes, s.freeBytes, s.writable, JSON.stringify(s.installMethodsSupported)]);
      if (body.inventory && body.libraryRevision > current.library_revision) {
        for (const item of body.inventory) {
          let releaseId = item.releaseId;
          if (releaseId) {
            const release = (await sql.query('SELECT g.title_id,r.content_id,r.version FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.id=$1 AND g.user_id=$2', [releaseId, device.user_id])).rows[0];
            if (!release) throw new AppError('NOT_FOUND', 404);
            if (release.title_id !== item.titleId || release.content_id !== item.contentId || release.version !== item.version) throw new AppError('METADATA_MISMATCH', 409);
          } else {
            const game = (await sql.query('INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,title_id) DO UPDATE SET title=games.title RETURNING id', [randomUUID(), device.user_id, item.titleId, item.title, { title: item.title, titleId: item.titleId, contentId: item.contentId }])).rows[0];
            releaseId = (await sql.query("INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,'BASE',$5) ON CONFLICT(game_id,content_id,version,kind) DO UPDATE SET metadata=game_releases.metadata RETURNING id", [randomUUID(), game.id, item.contentId, item.version, { format: 'unknown', minimumFirmware: null }])).rows[0].id;
          }
          if (!body.storage.some(s => s.storageId === item.storageId)) throw new AppError('UNKNOWN_STORAGE');
          if (item.backportProfileId && !(await sql.query('SELECT id FROM compatibility_profiles WHERE id=$1 AND user_id=$2 AND title_id=$3 AND content_id=$4 AND game_version=$5', [item.backportProfileId, device.user_id, item.titleId, item.contentId, item.version])).rowCount) throw new AppError('PROFILE_MISMATCH', 409);
          await sql.query(`INSERT INTO console_library_entries(console_id,release_id,storage_id,state,relative_path,sha256,size,registered,backport_profile_id,revision)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(console_id,release_id,storage_id) DO UPDATE SET state=$4,relative_path=$5,sha256=$6,size=$7,registered=$8,backport_profile_id=$9,revision=$10,updated_at=now()`,
          [device.id, releaseId, item.storageId, item.available ? 'READY_ON_PS5' : 'MISSING', item.relativePath, item.sha256, item.size, item.registered, item.backportProfileId, body.libraryRevision]);
        }
        if (body.inventoryComplete) await sql.query("UPDATE console_library_entries SET state='MISSING',updated_at=now() WHERE console_id=$1 AND revision<$2 AND state='READY_ON_PS5'", [device.id, body.libraryRevision]);
        await sql.query('UPDATE consoles SET library_revision=$2 WHERE id=$1', [device.id, body.libraryRevision]);
      }
    });
    return { ok: true, serverTime: new Date().toISOString(), heartbeatIntervalSeconds: 10 };
  };
  app.post('/api/v1/device/heartbeat', async req => heartbeat(await auth.device(req), req.body));
  app.get('/api/v1/device/status', async req => {
    const c = await auth.device(req);
    return { id: c.id, name: c.name, firmware: c.firmware, runtime: c.runtime,
      storage: (await db.query('SELECT storage_id AS "storageId",display_name AS "displayName",total_bytes AS "totalBytes",free_bytes AS "freeBytes",writable FROM console_storage WHERE console_id=$1', [c.id])).rows,
      library: (await db.query('SELECT release_id AS "releaseId",state,storage_id AS "storageId",registered FROM console_library_entries WHERE console_id=$1', [c.id])).rows };
  });
  app.get('/api/v1/device/live', { websocket: true, preValidation:async req=>{await auth.device(req);} }, (socket, req) => {
    // Messages are serialized so a delayed snapshot cannot overwrite a newer one.
    let chain = Promise.resolve();
    socket.on('message', raw => { chain = chain.then(async () => {
      const device = await auth.device(req);
      socket.send(JSON.stringify(await heartbeat(device, JSON.parse(raw.toString()))));
    }).catch(() => { socket.close(1008, 'Invalid heartbeat or credential'); }); });
  });
}
