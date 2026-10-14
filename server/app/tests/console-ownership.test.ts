import assert from 'node:assert/strict';
import test from 'node:test';
import { requireOwnedConsole } from '../src/consoles/shared.js';

test('console ownership checks preserve parameters and optional row locking', async () => {
  const calls: { text: string; values?: unknown[] }[] = [];
  const sql = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: values?.[0] === 'missing' ? [] : [{ id: 'console' }], rowCount: 1 };
    },
  };

  assert.deepEqual(await requireOwnedConsole(sql as never, 'console', 'owner', true), {
    id: 'console',
  });
  assert.match(calls[0]!.text, /FOR UPDATE$/);
  assert.deepEqual(calls[0]!.values, ['console', 'owner']);

  await assert.rejects(requireOwnedConsole(sql as never, 'missing', 'owner'), {
    code: 'NOT_FOUND',
    statusCode: 404,
  });
  assert.doesNotMatch(calls[1]!.text, /FOR UPDATE/);
});
