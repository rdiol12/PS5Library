import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { createApp } from '../../src/api/app.js';
import { runWorker } from '../../src/library/inspect.js';

test(
  'watched multipart RAR builds once; DLC content IDs stay under the base title',
  { timeout: 180000 },
  async () => {
    const base = configuration(),
      schema = 'archives_' + randomUUID().replaceAll('-', ''),
      root = path.resolve('data', schema),
      admin = database(base.DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DUMP_ROOT: path.join(root, 'dumps'),
      DISK_MARGIN_BYTES: 0,
    };
    await mkdir(config.DUMP_ROOT, { recursive: true });
    await cp('worker/Tests/Fixtures', config.DUMP_ROOT, { recursive: true });
    const db = database(config.DATABASE_URL),
      app = await createApp(config);
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) =>
      app.inject({
        method,
        url: '/api/v1' + url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      const owner = (
        await call('POST', '/auth/register', {
          username: 'archive-owner',
          password: 'sample-only-password',
          bootstrapToken: base.BOOTSTRAP_TOKEN,
        })
      ).json();
      const source = (
        await call(
          'POST',
          '/sources',
          {
            name: 'Archives',
            type: 'WATCH_FOLDER',
            location: '.',
            autoPrepare: 'FPKG',
            shareCatalog: true,
          },
          owner.token,
        )
      ).json();
      const original = await runWorker([
        'hash-archive',
        path.join(config.DUMP_ROOT, 'homebrew.part1.rar'),
      ]);
      await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      assert.equal(
        (await db.query('SELECT count(*)::int AS count FROM source_observations')).rows[0].count,
        1,
        'The volumes form one source',
      );
      await db.query("UPDATE source_observations SET changed_at=now()-interval '2 minutes'");
      const scanned = await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      assert.equal(scanned.statusCode, 200, scanned.body);
      let catalog: any[] = [];
      for (let i = 0; i < 1000; i++) {
        catalog = (await call('GET', '/catalog', undefined, owner.token)).json();
        if (
          catalog[0]?.releases[0]?.artifacts.length ||
          (await call('GET', '/jobs', undefined, owner.token))
            .json()
            .some((j: any) => j.state === 'ERROR')
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const jobs = (await call('GET', '/jobs', undefined, owner.token)).json();
      assert.equal(jobs[0].state, 'COMPLETED', JSON.stringify(jobs));
      assert.equal(catalog[0]?.title, 'Archive test homebrew');
      assert.equal(catalog[0]?.releases[0]?.sources[0]?.format, 'rar');
      assert.equal(catalog[0]?.releases[0]?.artifacts[0]?.format, 'pkg');
      assert.ok(
        (
          await db.query(
            "SELECT id FROM job_events WHERE state='EXTRACTING' AND progress->'conversion' ? 'extraction'",
          )
        ).rowCount,
        'Extraction exposes measured progress',
      );
      assert.deepEqual(
        await runWorker(['hash-archive', path.join(config.DUMP_ROOT, 'homebrew.part1.rar')]),
        original,
        'Original volumes unchanged',
      );
      await call('POST', `/sources/${source.id}/sync`, {}, owner.token);
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM jobs WHERE kind='BUILD'")).rows[0]
          .count,
        1,
      );
      const personal = path.join(config.SOURCE_ROOT, owner.user.id, 'addons');
      await mkdir(personal, { recursive: true });
      await writeFile(path.join(personal, 'demo.elf'), Buffer.alloc(4096));
      const releases = ['FIRSTADDON000000', 'SECONDADDON00000'].map((id, i) => ({
        key: id,
        game: {
          title: `Expansion ${i + 1}`,
          titleId: 'PPSA99994',
          contentId: `IV0000-PPSA99994_00-${id}`,
        },
        title: `Expansion ${i + 1}`,
        kind: 'DLC',
        version: '01.00',
        format: 'elf',
        size: 4096,
        sha256: '0'.repeat(64),
        location: 'demo.elf',
      }));
      await writeFile(
        path.join(personal, 'library.json'),
        JSON.stringify({ schemaVersion: 1, releases }),
      );
      const dlc = (
        await call(
          'POST',
          '/sources',
          { name: 'Add-ons', type: 'LOCAL_FOLDER', location: 'addons' },
          owner.token,
        )
      ).json();
      const synced = await call('POST', `/sources/${dlc.id}/sync`, {}, owner.token);
      assert.equal(synced.statusCode, 200, synced.body);
      catalog = (await call('GET', '/catalog', undefined, owner.token)).json();
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].title, 'Archive test homebrew');
      assert.deepEqual(
        catalog[0].releases
          .filter((r: any) => r.kind === 'DLC')
          .map((r: any) => r.title)
          .sort(),
        ['Expansion 1', 'Expansion 2'],
      );
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      assert.ok(root.startsWith(path.resolve('data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
