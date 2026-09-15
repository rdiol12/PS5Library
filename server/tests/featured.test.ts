import test from 'node:test';
import assert from 'node:assert/strict';
import { heroWindow, eligibleHero } from '../src/catalog/featured.js';
test('weekly hero uses Monday UTC and a full two-calendar-month exclusion', () => {
  assert.deepEqual(heroWindow(new Date('2026-09-15T20:00:00Z')), { week: '2026-09-14', next: '2026-09-21', cutoff: '2026-07-15T20:00:00.000Z' });
  assert.equal(heroWindow(new Date('2026-08-31T12:00:00Z')).cutoff, '2026-06-30T12:00:00.000Z');
  assert.equal(eligibleHero('same-image', [{ sha256:'same-image', selectedAt:'2026-08-01T00:00:00Z' }], new Date('2026-09-30T23:59:59Z')), false);
  assert.equal(eligibleHero('same-image', [{ sha256:'same-image', selectedAt:'2026-08-01T00:00:00Z' }], new Date('2026-10-01T00:00:00Z')), true);
  assert.equal(eligibleHero('new-image', [{ sha256:'same-image', selectedAt:'2026-09-14T00:00:00Z' }], new Date('2026-09-15T00:00:00Z')), true);
});
