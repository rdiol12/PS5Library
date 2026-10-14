import { z } from 'zod';
import type { Config } from '../config.js';
import { queryOne, type DB } from '../db.js';
import { seal, unseal } from '../auth/credentials.js';
import { AppError } from '../security/errors.js';

export class MasterError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export async function throwUserMasterError(db: DB, userId: string, error: MasterError) {
  if (error.status === 401)
    await db.query(
      "UPDATE community_user_connections SET state='ERROR',session_cipher=NULL,error='REAUTHENTICATION_REQUIRED',updated_at=now() WHERE user_id=$1",
      [userId],
    );
  throw new AppError(
    error.status === 401 ? 'COMMUNITY_ACCOUNT_REAUTHENTICATION_REQUIRED' : error.code,
    error.status,
  );
}

const masterErrorCodes = new Set(
  `ALREADY_CONNECTED ALREADY_FRIENDS
   ARCHIVE_COLLISION ARCHIVE_CORRUPT ARCHIVE_MISMATCH ARCHIVE_SIZE_MISMATCH ARCHIVE_UNAVAILABLE
   AUTHORIZATION_CONSUMED AUTHORIZATION_DENIED AUTHORIZATION_EXPIRED AUTHORIZATION_NOT_FOUND AUTHORIZATION_PENDING
   CHALLENGE_EXPIRED CONNECTION_BANNED CONNECTION_PENDING CONNECTION_REVOKED FORBIDDEN
   FRIEND_REQUEST_EXISTS FRIEND_REQUESTS_DISABLED GAME_SESSION_ADAPTER_DISABLED GAME_SESSION_FULL
   HANDLE_UNAVAILABLE INSUFFICIENT_SPACE INTERNAL_ERROR INVALID_ARCHIVE_BODY INVALID_INPUT INVALID_PORTABLE_ARCHIVE
   NOT_FOUND PASSKEY_REQUIRED PASSKEY_VERIFICATION_FAILED PUBLICATION_CHANGED RECOVERY_FAILED SAVE_QUOTA_EXCEEDED
   TERMS_ACCEPTANCE_REQUIRED TERMS_CHANGED TOKEN_REUSE_DETECTED UNAUTHORIZED UPDATE_NOT_FOUND`
    .trim()
    .split(/\s+/),
);
const safeMasterError = (value: unknown) =>
  typeof value === 'string' && masterErrorCodes.has(value) ? value : 'MASTER_REQUEST_FAILED';
const masterToken = z.string().regex(/^[a-f0-9]{64}$/);

export const nodeCipherContext = (url: string) => `community-node:${url}`;
export const deviceCipherContext = (url: string, userId: string) =>
  `community-device:${url}:${userId}`;
export const sessionCipherContext = (url: string, userId: string) =>
  `community-session:${url}:${userId}`;
export const openCommunityCipher = (encrypted: string, key: string, context: string) =>
  unseal(encrypted, key, encrypted.startsWith('v2:') ? context : undefined);

const userRefreshes = new WeakMap<DB, Map<string, Promise<string>>>();
export const identitySessionSchema = z
  .object({
    account: z
      .object({
        id: z.string().uuid(),
        handle: z.string().regex(/^[a-z0-9_]{3,32}$/),
        displayName: z.string().min(1).max(80),
        friendRequestPolicy: z.enum(['EVERYONE', 'NOBODY']),
      })
      .strict(),
    accessToken: z.string().regex(/^[a-f0-9]{64}$/),
    accessTokenExpiresIn: z.number().int().min(60).max(3600),
    refreshToken: z.string().regex(/^[0-9a-f-]{36}\.[a-f0-9]{64}$/),
  })
  .strict();
const sealedSessionSchema = z
  .object({
    userId: z.string().uuid(),
    accessToken: z.string().regex(/^[a-f0-9]{64}$/),
    accessExpiresAt: z.number().int().positive(),
    refreshToken: z.string().regex(/^[0-9a-f-]{36}\.[a-f0-9]{64}$/),
  })
  .strict();
const refreshedSessionSchema = identitySessionSchema.omit({ account: true });

async function responseJson(response: Response) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new AppError('MASTER_RESPONSE_TOO_LARGE', 502);
      chunks.push(chunk);
    }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function masterRequest(
  config: Config,
  route: string,
  options: { method?: string; body?: unknown; token?: string; userToken?: string } = {},
  fetcher: typeof fetch = fetch,
) {
  if (!config.COMMUNITY_MASTER_URL) throw new AppError('COMMUNITY_MASTER_NOT_CONFIGURED', 409);
  const url = new URL(route, config.COMMUNITY_MASTER_URL);
  if (url.origin !== config.COMMUNITY_MASTER_URL) throw new AppError('INVALID_MASTER_ROUTE', 500);
  const response = await fetcher(url, {
    method: options.method ?? 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.userToken ? { 'x-ps5library-user-token': options.userToken } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await responseJson(response).catch((error) => {
    if (error instanceof SyntaxError) throw new AppError('INVALID_MASTER_RESPONSE', 502);
    throw error;
  });
  if (!response.ok) throw new MasterError(response.status, safeMasterError(body.error));
  return body;
}

export async function approvedMasterCredential(db: DB, config: Config) {
  const row = await queryOne(
    db,
    'SELECT credential_cipher,state,master_url FROM community_master_connection WHERE singleton',
    [],
  );
  if (!row?.credential_cipher || row.state !== 'APPROVED')
    throw new AppError('COMMUNITY_MASTER_NOT_APPROVED', 409);
  if (row.master_url !== config.COMMUNITY_MASTER_URL)
    throw new AppError('COMMUNITY_MASTER_CHANGED', 409);
  try {
    return await openMasterCredential(db, config, row);
  } catch {
    throw new AppError('COMMUNITY_CREDENTIAL_UNREADABLE', 409);
  }
}

export async function openMasterCredential(db: DB, config: Config, row: any) {
  const token = masterToken.parse(
    openCommunityCipher(
      row.credential_cipher,
      config.BOOTSTRAP_TOKEN,
      nodeCipherContext(row.master_url),
    ),
  );
  if (!row.credential_cipher.startsWith('v2:'))
    await db.query(
      'UPDATE community_master_connection SET credential_cipher=$2,updated_at=now() WHERE singleton AND credential_cipher=$1',
      [
        row.credential_cipher,
        seal(token, config.BOOTSTRAP_TOKEN, nodeCipherContext(row.master_url)),
      ],
    );
  return token;
}

export async function approvedMasterUserCredential(
  db: DB,
  config: Config,
  userId: string,
  fetcher: typeof fetch = fetch,
  allowPending = false,
) {
  try {
    const load = async () => {
      const row = await queryOne(db, 'SELECT * FROM community_user_connections WHERE user_id=$1', [
        userId,
      ]);
      if (
        !row ||
        (row.state !== 'CONNECTED' && !(allowPending && row.state === 'DISCONNECT_PENDING')) ||
        !row.session_cipher
      )
        throw new AppError('COMMUNITY_ACCOUNT_NOT_CONNECTED', 409);
      if (row.master_url !== config.COMMUNITY_MASTER_URL)
        throw new AppError('COMMUNITY_MASTER_CHANGED', 409);
      let session: z.infer<typeof sealedSessionSchema>;
      try {
        session = sealedSessionSchema.parse(
          JSON.parse(
            openCommunityCipher(
              row.session_cipher,
              config.BOOTSTRAP_TOKEN,
              sessionCipherContext(row.master_url, userId),
            ),
          ),
        );
      } catch {
        throw new AppError('COMMUNITY_CREDENTIAL_UNREADABLE', 409);
      }
      if (session.userId !== userId) throw new AppError('COMMUNITY_CREDENTIAL_UNREADABLE', 409);
      if (!row.session_cipher.startsWith('v2:')) {
        const upgraded = seal(
          JSON.stringify(session),
          config.BOOTSTRAP_TOKEN,
          sessionCipherContext(row.master_url, userId),
        );
        if (
          (
            await db.query(
              'UPDATE community_user_connections SET session_cipher=$2,updated_at=now() WHERE user_id=$1 AND session_cipher=$3',
              [userId, upgraded, row.session_cipher],
            )
          ).rowCount
        )
          row.session_cipher = upgraded;
      }
      return { row, session };
    };
    const loaded = await load();
    if (loaded.session.accessExpiresAt > Date.now() + 30_000) return loaded.session.accessToken;
    // ponytail: one Node process coalesces refresh rotation; use a distributed lock if Node replicas are introduced.
    let refreshes = userRefreshes.get(db);
    if (!refreshes) {
      refreshes = new Map();
      userRefreshes.set(db, refreshes);
    }
    const active = refreshes.get(userId);
    if (active) return await active;
    const refresh = (async () => {
      const current = await load();
      if (current.session.accessExpiresAt > Date.now() + 30_000) return current.session.accessToken;
      const nodeToken = await approvedMasterCredential(db, config),
        refreshed = refreshedSessionSchema.parse(
          await masterRequest(
            config,
            '/api/v1/identity/refresh',
            {
              method: 'POST',
              token: nodeToken,
              userToken: current.session.accessToken,
              body: { refreshToken: current.session.refreshToken },
            },
            fetcher,
          ),
        ),
        next = {
          userId,
          accessToken: refreshed.accessToken,
          accessExpiresAt: Date.now() + refreshed.accessTokenExpiresIn * 1000,
          refreshToken: refreshed.refreshToken,
        },
        cipher = seal(
          JSON.stringify(next),
          config.BOOTSTRAP_TOKEN,
          sessionCipherContext(current.row.master_url, userId),
        );
      if (
        (
          await db.query(
            'UPDATE community_user_connections SET session_cipher=$2,error=NULL,updated_at=now() WHERE user_id=$1 AND session_cipher=$3 AND state=$4',
            [userId, cipher, current.row.session_cipher, current.row.state],
          )
        ).rowCount
      )
        return refreshed.accessToken;
      const winner = await load();
      if (winner.session.accessExpiresAt > Date.now() + 30_000) return winner.session.accessToken;
      throw new AppError('COMMUNITY_SESSION_CHANGED', 409);
    })();
    refreshes.set(userId, refresh);
    try {
      return await refresh;
    } finally {
      if (refreshes.get(userId) === refresh) refreshes.delete(userId);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof MasterError) await throwUserMasterError(db, userId, error);
    if (error instanceof z.ZodError) throw new AppError('INVALID_MASTER_RESPONSE', 502);
    throw new AppError('MASTER_UNREACHABLE', 502);
  }
}
