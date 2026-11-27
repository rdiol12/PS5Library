import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { transferRoutes } from '../src/transfers/routes.js';
import { buildKey } from '../src/jobs/preparation.js';
import { profileHash } from '../src/library/backports.js';

test('catalog PATCH planning requires its exact installed base and preserves that base in the device task', async () => {
  const app = Fastify(),
    root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-transfer-')),
    userId = randomUUID(),
    consoleId = randomUUID(),
    gameId = randomUUID(),
    releaseId = randomUUID(),
    artifactId = randomUUID();
  const titleId = 'PPSA12345',
    contentId = 'UP0000-PPSA12345_00-CATALOGPATCH0001',
    baseContentVersion = '01.000.000',
    contentVersion = '01.001.000',
    sha256 = 'a'.repeat(64),
    size = 0x10000;
  const release = {
    id: releaseId,
    game_id: gameId,
    title_id: titleId,
    source_owner: userId,
    content_id: contentId,
    version: contentVersion,
    kind: 'UPDATE',
    metadata: { format: 'pkg', size, sha256, minimumFirmware: '4.00', baseContentVersion },
  };
  const artifact: any = {
    id: artifactId,
    release_id: releaseId,
    relative_path: 'legacy.pkg',
    format: 'pkg',
    size,
    sha256,
    verified: true,
    inspection: {
      kind: 'UPDATE',
      metadataVerified: true,
      identity: { titleId, contentId, version: contentVersion },
      installedImage: { size, sha256 },
    },
  };
  await writeFile(path.join(root, artifact.relative_path), Buffer.alloc(size));
  const consoleRow = {
    id: consoleId,
    user_id: userId,
    firmware: '4.51',
    runtime: 'etaHEN',
    capabilities: { fpkgInstall: true, nativeDownloads: true },
    shadowmount_fakelib: false,
    standalone_backpork: false,
    last_seen: new Date(),
  };
  const volumes = [
    {
      storage_id: 'internal',
      display_name: 'Internal Storage',
      path: '/user',
      free_bytes: size * 10,
      writable: true,
      methods: ['FPKG'],
    },
    {
      storage_id: 'm2',
      display_name: 'M.2 SSD',
      path: '/mnt/ext1',
      free_bytes: size * 10,
      writable: true,
      methods: ['FPKG'],
    },
  ];
  let installedVersion: string | null = baseContentVersion,
    queued: any;
  const query = async (sql: string, values: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.includes('SELECT j.*, a.sha256'))
      return {
        rows: queued
          ? [
              {
                ...queued,
                sha256,
                format: 'pkg',
                inspection: artifact.inspection,
                title: 'Catalog patch game',
                title_id: titleId,
                content_id: contentId,
                version: contentVersion,
                release_kind: 'UPDATE',
                release_metadata: release.metadata,
              },
            ]
          : [],
        rowCount: queued ? 1 : 0,
      };
    if (normalized.includes('SELECT a.*, g.title_id'))
      return {
        rows: [
          {
            ...artifact,
            title_id: titleId,
            content_id: contentId,
            version: contentVersion,
            kind: 'UPDATE',
            metadata: release.metadata,
          },
        ],
        rowCount: 1,
      };
    if (normalized.includes("COALESCE(k.capabilities,'{}')"))
      return { rows: [consoleRow], rowCount: 1 };
    if (normalized.includes('SELECT r.*, g.title_id')) return { rows: [release], rowCount: 1 };
    if (normalized.includes('SELECT * FROM artifacts WHERE release_id'))
      return { rows: [artifact], rowCount: 1 };
    if (normalized.includes('SELECT profile FROM compatibility_profiles'))
      return { rows: [], rowCount: 0 };
    if (normalized.includes('console_library_entries')) {
      const installed = {
        release_id: randomUUID(),
        title_id: titleId,
        content_id: contentId,
        version: installedVersion,
        kind: 'BASE',
        storage_id: 'm2',
        state: 'READY_ON_PS5',
        registered: true,
      };
      const rows =
        installedVersion === null ||
        (values.includes(baseContentVersion) && installedVersion !== baseContentVersion)
          ? []
          : [installed];
      return { rows, rowCount: rows.length };
    }
    if (normalized.includes('FROM console_storage_volumes'))
      return { rows: volumes, rowCount: volumes.length };
    if (normalized.includes('SELECT id FROM artifacts WHERE id='))
      return { rows: [{ id: artifactId }], rowCount: 1 };
    if (normalized.includes('SELECT id FROM consoles WHERE id='))
      return { rows: [{ id: consoleId }], rowCount: 1 };
    if (normalized.includes('SELECT id FROM jobs WHERE console_id='))
      return { rows: queued ? [{ id: queued.id }] : [], rowCount: queued ? 1 : 0 };
    if (normalized.includes('SELECT j.id FROM jobs j JOIN game_releases'))
      return { rows: [], rowCount: 0 };
    if (normalized.includes('SELECT COALESCE(sum(')) return { rows: [{ bytes: 0 }], rowCount: 1 };
    if (normalized.startsWith('UPDATE artifacts SET inspection=')) {
      artifact.inspection = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes('INSERT INTO jobs(')) {
      queued = {
        id: values[0],
        user_id: values[1],
        kind: 'TRANSFER',
        release_id: values[2],
        artifact_id: values[3],
        console_id: values[4],
        storage_id: values[5],
        state: 'QUEUED_FOR_PS5',
        desired_state: 'RUNNING',
        downloaded_bytes: 0,
        total_bytes: values[6],
        speed_bytes_per_second: 0,
        eta_seconds: null,
        config: values[7],
      };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as any,
    auth = {
      user: async () => ({ id: userId }),
      device: async () => ({ id: consoleId, user_id: userId, firmware: '4.51', runtime: 'etaHEN' }),
    } as any;
  let inspectCalls = 0;
  const inspectFile = async () => {
    inspectCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ...artifact.inspection, installedImage: { size, sha256 } };
  };
  try {
    await transferRoutes(
      app,
      db,
      { DATA_DIR: root, DISK_MARGIN_BYTES: 0, BOOTSTRAP_TOKEN: 'b'.repeat(64) } as any,
      auth,
      inspectFile as any,
    );
    const plan = () =>
      app.inject({ method: 'POST', url: '/api/v1/device/transfers/plan', payload: { releaseId } });
    const exact = (await plan()).json();
    installedVersion = '01.000.001';
    const mismatch = (await plan()).json();
    installedVersion = null;
    const missing = (await plan()).json();
    installedVersion = baseContentVersion;
    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/v1/device/transfers',
      payload: { artifactId, storageId: 'm2' },
    });
    const task = (await app.inject({ url: '/api/v1/device/tasks' })).json()[0];
    assert.equal(inspectCalls, 0, 'A freshly built artifact is not rescanned when queued');
    artifact.inspection = {
      kind: 'UPDATE',
      metadataVerified: true,
      identity: { titleId, contentId, version: contentVersion },
    };
    const retried = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/device/transfers',
        payload: { artifactId, storageId: 'm2' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/device/transfers',
        payload: { artifactId, storageId: 'm2' },
      }),
    ]);
    assert.deepEqual(
      retried.map((response) => response.statusCode),
      [409, 409],
    );
    assert.equal(inspectCalls, 1, 'Concurrent legacy retries share one package inspection');
    assert.deepEqual(
      {
        exactAllowed: exact.allowed,
        exactStorage: exact.storage
          .filter((value: any) => value.allowed)
          .map((value: any) => value.storageId),
        mismatchAllowed: mismatch.allowed,
        missingAllowed: missing.allowed,
        enqueueStatus: enqueue.statusCode,
        task: task && {
          titleId: task.titleId,
          releaseKind: task.releaseKind,
          baseContentVersion: task.baseContentVersion,
          version: task.version,
          artifactUrl: task.artifactUrl,
        },
      },
      {
        exactAllowed: true,
        exactStorage: ['m2'],
        mismatchAllowed: false,
        missingAllowed: false,
        enqueueStatus: 202,
        task: {
          titleId,
          releaseKind: 'UPDATE',
          baseContentVersion,
          version: contentVersion,
          artifactUrl: `/api/v1/device/artifacts/${artifactId}`,
        },
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
