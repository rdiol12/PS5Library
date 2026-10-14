import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('console heartbeat reconciles storage and inventory with bounded SQL', async () => {
  const source = await readFile('app/src/consoles/heartbeat-routes.ts', 'utf8');
  const heartbeat = source.slice(
    source.indexOf('const heartbeat = async'),
    source.indexOf("app.post('/api/v1/device/heartbeat'"),
  );
  assert.doesNotMatch(
    heartbeat,
    /for \(const s of body\.storage\) await sql\.query/,
    'Heartbeat work must not add a SQL query per reported volume',
  );
  assert.doesNotMatch(
    heartbeat,
    /for \(const item of body\.inventory\) \{\s*let releaseId/,
    'Heartbeat work must not resolve each reported title with separate SQL queries',
  );
  assert.match(
    heartbeat,
    /INSERT INTO game_releases[\s\S]+jsonb_to_recordset/,
    'Discovered releases are inserted as a set',
  );
  assert.match(
    heartbeat,
    /INSERT INTO console_library_entries[\s\S]+jsonb_to_recordset/,
    'Inventory entries are reconciled in one statement',
  );
});
