import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { queryOne, queryRows, transaction, type SQL } from '../db.js';
import {
  hardwareLookup,
  hardwareRecoveryToken,
  hash,
  seal,
  unseal,
  secret,
  sameSecret,
} from '../auth/credentials.js';
import { uuid, firmware } from '../../../shared/schemas/index.js';
import { AppError } from '../security/errors.js';
import { requireOwnedConsole, type ConsoleRouteContext } from './shared.js';

const pairingCode = () =>
  Array.from(randomBytes(5), (byte) => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[byte & 31]).join('');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pairingRequest = z.discriminatedUnion('clientKind', [
  z
    .object({
      deviceId: uuid,
      name: z.string().min(1).max(80),
      clientKind: z.literal('PS5'),
      firmware: firmware.nullable().optional(),
      hardwareProof: digest.optional(),
    })
    .strict(),
  z
    .object({
      deviceId: uuid,
      name: z.string().min(1).max(80),
      clientKind: z.literal('SIMULATOR'),
      firmware: firmware.nullable().optional(),
    })
    .strict(),
]);
const recoveryRequest = z.object({ deviceId: uuid, recoveryToken: digest }).strict();

const reconnectAgent = async (sql: SQL, pair: any, target: any, bound: any) => {
  const temporary = await queryOne(
    sql,
    'SELECT id,device_id,client_kind,firmware,firmware_checked_at,user_id FROM consoles WHERE id=$1 FOR UPDATE',
    [pair.console_id],
  );
  if (!target || !temporary || temporary.user_id || temporary.id === target.id)
    throw new AppError('INVALID_AGENT_PAIRING', 409);
  if (bound && bound.console_id !== target.id)
    throw new AppError('HARDWARE_IDENTITY_MISMATCH', 409);
  pair.console_id = target.id;
  await sql.query('UPDATE pairings SET console_id=$1 WHERE id=$2', [target.id, pair.id]);
  await sql.query('DELETE FROM consoles WHERE id=$1', [temporary.id]);
  await sql.query(
    "UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='AGENT' AND revoked_at IS NULL",
    [target.id],
  );
  await sql.query(
    'UPDATE consoles SET device_id=$2,client_kind=$3,firmware=COALESCE($4,firmware),firmware_checked_at=COALESCE($5,firmware_checked_at) WHERE id=$1',
    [
      target.id,
      temporary.device_id,
      temporary.client_kind,
      temporary.firmware,
      temporary.firmware_checked_at,
    ],
  );
};

export function registerPairingRoutes({ app, db, config, auth }: ConsoleRouteContext) {
  const prunePairings = async (sql: SQL) => {
    await sql.query('DELETE FROM pairings WHERE expires_at<=now()');
    await sql.query(
      'DELETE FROM consoles c WHERE c.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM pairings p WHERE p.console_id=c.id)',
    );
  };
  const bindHardware = async (sql: SQL, consoleId: string, lookup: string) => {
    const rows = await queryRows(
      sql,
      'SELECT * FROM console_hardware_identities WHERE console_id=$1 OR lookup_hash=$2 FOR UPDATE',
      [consoleId, lookup],
    );
    if (rows.some((row) => row.console_id !== consoleId || row.lookup_hash !== lookup))
      throw new AppError('HARDWARE_IDENTITY_MISMATCH', 409);
    let row = rows[0];
    if (!row) {
      const nonce = secret(),
        recoveryToken = hardwareRecoveryToken(lookup, nonce, config.BOOTSTRAP_TOKEN);
      await sql.query(
        'INSERT INTO console_hardware_identities(console_id,lookup_hash,nonce,recovery_token_hash) VALUES($1,$2,$3,$4)',
        [consoleId, lookup, nonce, hash(recoveryToken)],
      );
      return recoveryToken;
    }
    const recoveryToken = hardwareRecoveryToken(row.lookup_hash, row.nonce, config.BOOTSTRAP_TOKEN);
    if (!sameSecret(row.recovery_token_hash, hash(recoveryToken)))
      throw new AppError('HARDWARE_IDENTITY_MISMATCH', 409);
    await sql.query(
      'UPDATE console_hardware_identities SET recovery_disabled_at=NULL WHERE console_id=$1',
      [consoleId],
    );
    return recoveryToken;
  };
  app.get('/api/v1/notifications', async (req) =>
    queryRows(
      db,
      `SELECT id, console_id AS "consoleId", release_id AS "releaseId",
                  code, message, created_at AS "createdAt"
             FROM console_notices
            WHERE user_id=$1 AND resolved_at IS NULL
            ORDER BY created_at DESC
            LIMIT 100`,
      [(await auth.user(req)).id],
    ),
  );
  app.get('/api/v1/device/notifications', async (req) =>
    queryRows(
      db,
      `SELECT n.id,n.code,n.message,COALESCE(g.title,'PS5Library') AS title
    FROM console_notices n LEFT JOIN game_releases r ON r.id=n.release_id LEFT JOIN games g ON g.id=r.game_id
    WHERE n.console_id=$1 AND n.delivered_at IS NULL AND n.resolved_at IS NULL ORDER BY n.created_at LIMIT 20`,
      [(await auth.device(req)).id],
    ),
  );
  app.post('/api/v1/device/notifications/:id/ack', async (req) => {
    const c = await auth.device(req),
      id = uuid.parse((req.params as { id: string }).id);
    if (
      !(
        await db.query(
          'UPDATE console_notices SET delivered_at=now(),resolved_at=CASE WHEN resolve_on_delivery THEN now() ELSE resolved_at END WHERE id=$1 AND console_id=$2',
          [id, c.id],
        )
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    return { ok: true };
  });
  app.post(
    '/api/v1/pairings',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = pairingRequest.parse(req.body),
        lookup =
          body.clientKind === 'PS5' && body.hardwareProof
            ? hardwareLookup(body.hardwareProof, config.BOOTSTRAP_TOKEN)
            : null;
      const id = randomUUID(),
        code = pairingCode();
      let consoleId = randomUUID();
      const pollSecret = secret();
      await transaction(db, async (sql) => {
        await prunePairings(sql);
        const existing = await queryOne(
          sql,
          'SELECT id,user_id FROM consoles WHERE device_id=$1 FOR UPDATE',
          [body.deviceId],
        );
        if (
          existing?.user_id ||
          (existing &&
            (
              await sql.query('SELECT id FROM pairings WHERE console_id=$1 AND expires_at>now()', [
                existing.id,
              ])
            ).rowCount)
        )
          throw new AppError(
            'DEVICE_ALREADY_REGISTERED',
            409,
            'Use the stored device credential, or revoke and reset the device identity.',
          );
        if (existing) consoleId = existing.id;
        else
          await sql.query(
            'INSERT INTO consoles(id,device_id,name,client_kind) VALUES($1,$2,$3,$4)',
            [consoleId, body.deviceId, body.name, body.clientKind],
          );
        if (body.firmware !== undefined)
          await sql.query('UPDATE consoles SET firmware=$2,firmware_checked_at=now() WHERE id=$1', [
            consoleId,
            body.firmware,
          ]);
        await sql.query(
          "INSERT INTO pairings(id,console_id,code_hash,poll_hash,hardware_lookup_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
          [id, consoleId, hash(code), hash(pollSecret), lookup],
        );
      });
      return reply.code(201).send({
        id,
        code,
        pollSecret,
        expiresInSeconds: 600,
        pairingUrl: `${config.PUBLIC_URL}/pair?code=${code}`,
      });
    },
  );
  app.post(
    '/api/v1/frontend/pairings',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z.object({ deviceId: uuid }).parse(req.body);
      const id = randomUUID(),
        code = pairingCode(),
        pollSecret = secret();
      await transaction(db, async (sql) => {
        await prunePairings(sql);
        if (
          (
            await sql.query(
              'SELECT id FROM console_credentials WHERE frontend_device_id=$1 AND revoked_at IS NULL',
              [body.deviceId],
            )
          ).rowCount
        )
          throw new AppError('DEVICE_ALREADY_REGISTERED', 409);
        await sql.query(
          "INSERT INTO pairings(id,kind,frontend_device_id,code_hash,poll_hash,expires_at) VALUES($1,'FRONTEND',$2,$3,$4,now()+interval '10 minutes')",
          [id, body.deviceId, hash(code), hash(pollSecret)],
        );
      });
      return reply.code(201).send({
        id,
        code,
        pollSecret,
        expiresInSeconds: 600,
        pairingUrl: `${config.PUBLIC_URL}/pair?code=${code}&kind=frontend`,
      });
    },
  );
  app.post(
    '/api/v1/hardware/recover',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const body = recoveryRequest.parse(req.body);
      return transaction(db, async (sql) => {
        const row = await queryOne(
          sql,
          `SELECT i.console_id,i.lookup_hash,i.nonce,i.recovery_token_hash FROM console_hardware_identities i JOIN consoles c ON c.id=i.console_id
        WHERE c.user_id IS NOT NULL AND i.recovery_disabled_at IS NULL AND i.recovery_token_hash=$1 FOR UPDATE OF i,c`,
          [hash(body.recoveryToken)],
        );
        if (!row) throw new AppError('CONSOLE_NOT_ENROLLED', 404);
        const recoveryToken = hardwareRecoveryToken(
          row.lookup_hash,
          row.nonce,
          config.BOOTSTRAP_TOKEN,
        );
        if (
          !sameSecret(row.recovery_token_hash, hash(recoveryToken)) ||
          !sameSecret(body.recoveryToken, recoveryToken)
        )
          throw new AppError('CONSOLE_NOT_ENROLLED', 404);
        const credential = secret(),
          credentialId = randomUUID();
        await sql.query(
          "UPDATE console_credentials SET revoked_at=now() WHERE console_id=$1 AND kind='FRONTEND' AND revoked_at IS NULL",
          [row.console_id],
        );
        await sql.query(
          "INSERT INTO console_credentials(id,console_id,token_hash,kind,frontend_device_id) VALUES($1,$2,$3,'FRONTEND',$4)",
          [credentialId, row.console_id, hash(credential), body.deviceId],
        );
        await sql.query(
          'UPDATE console_hardware_identities SET last_recovered_at=now() WHERE console_id=$1',
          [row.console_id],
        );
        return { status: 'RECOVERED', consoleId: row.console_id, credential, recoveryToken };
      });
    },
  );
  app.post('/api/v1/device/hardware', async (req) => {
    const device = await auth.device(req),
      body = z.object({ hardwareProof: digest }).strict().parse(req.body),
      lookup = hardwareLookup(body.hardwareProof, config.BOOTSTRAP_TOKEN);
    if (device.credential_kind !== 'AGENT') throw new AppError('AGENT_REQUIRED', 403);
    return transaction(db, async (sql) => {
      if (
        !(
          await sql.query(
            "SELECT id FROM console_credentials WHERE id=$1 AND console_id=$2 AND kind='AGENT' AND revoked_at IS NULL FOR UPDATE",
            [device.credential_id, device.id],
          )
        ).rowCount
      )
        throw new AppError('UNAUTHORIZED', 401);
      return { recoveryToken: await bindHardware(sql, device.id, lookup) };
    });
  });
  app.post(
    '/api/v1/pairings/claim',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      let user: any, frontend: any;
      try {
        user = await auth.user(req);
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
        frontend = await auth.device(req);
        if (frontend.credential_kind !== 'FRONTEND') throw new AppError('FRONTEND_REQUIRED', 403);
      }
      const body = z
          .object({
            code: z
              .string()
              .toUpperCase()
              .regex(/^[2-9A-HJ-NP-Z]{5}$/),
            consoleId: uuid.optional(),
          })
          .parse(req.body),
        code = body.code;
      return transaction(db, async (sql) => {
        const pair = await queryOne(sql, 'SELECT * FROM pairings WHERE code_hash=$1 FOR UPDATE', [
          hash(code),
        ]);
        if (!pair || new Date(pair.expires_at).getTime() <= Date.now())
          throw new AppError('PAIRING_EXPIRED', 410);
        if (pair.claimed_at) throw new AppError('PAIRING_ALREADY_CLAIMED', 409);
        const bound = pair.hardware_lookup_hash
          ? await queryOne(
              sql,
              'SELECT * FROM console_hardware_identities WHERE lookup_hash=$1 FOR UPDATE',
              [pair.hardware_lookup_hash],
            )
          : null;
        if (frontend) {
          if (pair.kind !== 'AGENT' || body.consoleId)
            throw new AppError('AGENT_PAIRING_REQUIRED', 400);
          const target = await queryOne(
            sql,
            `SELECT c.id
                 FROM consoles c
                 JOIN console_credentials k ON k.console_id=c.id
                WHERE c.id=$1 AND k.id=$2 AND k.kind='FRONTEND'
                  AND k.revoked_at IS NULL AND c.user_id IS NOT NULL
                FOR UPDATE OF c,k`,
            [frontend.id, frontend.credential_id],
          );
          await reconnectAgent(sql, pair, target, bound);
        } else if (pair.kind === 'FRONTEND') {
          if (body.consoleId) {
            await requireOwnedConsole(sql, body.consoleId, user.id, true);
            pair.console_id = body.consoleId;
          } else {
            pair.console_id = randomUUID();
            await sql.query(
              "INSERT INTO consoles(id,device_id,user_id,name,client_kind) VALUES($1,$2,$3,'My PS5','PS5')",
              [pair.console_id, randomUUID(), user.id],
            );
          }
        } else {
          if (body.consoleId) {
            if (!pair.hardware_lookup_hash) throw new AppError('HARDWARE_IDENTITY_REQUIRED', 409);
            const target = await requireOwnedConsole(sql, body.consoleId, user.id, true);
            await reconnectAgent(sql, pair, target, bound);
          } else {
            if (bound)
              throw new AppError(
                'CONSOLE_ALREADY_REGISTERED',
                409,
                'Choose the existing PS5 to reconnect it.',
              );
            await sql.query('UPDATE consoles SET user_id=$1 WHERE id=$2', [
              user.id,
              pair.console_id,
            ]);
          }
        }
        if (pair.kind === 'AGENT' && pair.hardware_lookup_hash)
          await bindHardware(sql, pair.console_id, pair.hardware_lookup_hash);
        const credential = secret(),
          credentialId = randomUUID();
        await sql.query(
          'INSERT INTO console_credentials(id,console_id,token_hash,kind,frontend_device_id) VALUES($1,$2,$3,$4,$5)',
          [credentialId, pair.console_id, hash(credential), pair.kind, pair.frontend_device_id],
        );
        await sql.query(
          'UPDATE pairings SET claimed_at=now(),credential_cipher=$1,console_id=$3,credential_id=$4 WHERE id=$2',
          [seal(credential, config.BOOTSTRAP_TOKEN), pair.id, pair.console_id, credentialId],
        );
        await sql.query(
          'UPDATE users SET default_console_id=COALESCE(default_console_id,$1) WHERE id=$2',
          [pair.console_id, user?.id ?? frontend.user_id],
        );
        return { consoleId: pair.console_id };
      });
    },
  );
  app.post(
    '/api/v1/pairings/:id/poll',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
      const id = uuid.parse((req.params as { id: string }).id);
      const pollSecret = z
        .object({ pollSecret: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.body).pollSecret;
      const pair = (await db.query('SELECT * FROM pairings WHERE id=$1 AND expires_at>now()', [id]))
        .rows[0];
      if (!pair || !sameSecret(pair.poll_hash, hash(pollSecret)))
        throw new AppError('PAIRING_EXPIRED', 410);
      if (!pair.claimed_at) return { status: 'PENDING' };
      if (
        pair.credential_id &&
        !(
          await db.query('SELECT id FROM console_credentials WHERE id=$1 AND revoked_at IS NULL', [
            pair.credential_id,
          ])
        ).rowCount
      )
        throw new AppError('PAIRING_EXPIRED', 410);
      if (!pair.credential_cipher) throw new AppError('CREDENTIAL_ALREADY_ACKNOWLEDGED', 409);
      let recoveryToken: string | undefined;
      const identity = await queryOne(
        db,
        'SELECT lookup_hash,nonce FROM console_hardware_identities WHERE console_id=$1 AND recovery_disabled_at IS NULL',
        [pair.console_id],
      );
      if (identity)
        recoveryToken = hardwareRecoveryToken(
          identity.lookup_hash,
          identity.nonce,
          config.BOOTSTRAP_TOKEN,
        );
      return {
        status: 'PAIRED',
        consoleId: pair.console_id,
        credential: unseal(pair.credential_cipher, config.BOOTSTRAP_TOKEN),
        recoveryToken,
      };
    },
  );
}
