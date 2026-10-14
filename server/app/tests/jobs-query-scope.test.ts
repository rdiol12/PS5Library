import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('job queue positions rank only the requested user jobs', async () => {
  const source = await readFile('app/src/jobs/routes.ts', 'utf8');
  const start = source.indexOf('  const listJobs');
  const end = source.indexOf('  const jobOrder', start);
  assert.ok(start >= 0 && end > start, 'listJobs source was not found');

  const listJobs = source.slice(start, end).replace(/\s+/g, ' ');
  assert.match(listJobs, /WITH q AS \(.*FROM jobs WHERE user_id\s*=\s*\$1 AND kind IN/);
  assert.match(
    listJobs,
    /page AS \(.*LIMIT 100/,
    'The bounded job page is selected before lookup joins',
  );
  assert.match(
    listJobs,
    /ORDER BY q\.queue_position NULLS LAST, j\.created_at DESC, j\.id DESC LIMIT 100/,
  );
  assert.match(listJobs, /ORDER BY p\.queue_position NULLS LAST, p\.created_at DESC, p\.id DESC/);
});
