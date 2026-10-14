import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { discoverWatched } from '../src/sources/watch.js';

test('an unchanged published watch entry does not run preparation again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-watch-'));
  try {
    await writeFile(path.join(root, 'known.pkg'), 'pkg');
    const release = {
      key: 'known',
      game: {
        title: 'Known game',
        titleId: 'PPSA99999',
        contentId: 'IV0000-PPSA99999_00-PS5LIBRARYTEST00',
      },
      kind: 'BASE',
      version: '01.00',
      size: 3,
      format: 'pkg',
      sha256: 'a'.repeat(64),
      location: 'known.pkg',
    };
    let observation: any = null,
      publishes = 0,
      artworkCount = 1;
    const db = {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes("error='SOURCE_MISSING'")) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT * FROM source_observations'))
          return { rows: observation ? [observation] : [] };
        if (sql.startsWith('INSERT INTO source_observations')) {
          observation = {
            signature: args[2],
            changed_at: new Date(Date.now() - 120000),
            state: 'READY',
            error: null,
            release,
          };
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('SELECT r.game_id'))
          return { rows: [{ game_id: 'game', artwork_count: artworkCount }], rowCount: 1 };
        if (sql.startsWith('UPDATE source_observations')) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as any;
    const config = { DUMP_ROOT: root, QUOTA_BYTES: Number.MAX_SAFE_INTEGER } as any,
      source = { id: 'source', config: { location: '.' } };
    await discoverWatched(db, config, source, async () => {
      publishes++;
    });
    await discoverWatched(db, config, source, async () => {
      publishes++;
    });
    assert.equal(publishes, 0);
    artworkCount = 0;
    await discoverWatched(db, config, source, async (_release, automatic) => {
      assert.equal(automatic, false);
      publishes++;
    });
    assert.equal(publishes, 1, 'Missing artwork is retried without automatic preparation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
