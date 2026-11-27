import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationReservationBytes } from '../src/jobs/preparation.js';

test('direct FPKG reserves one worst-case output without relaxing staged builds', () => {
  const gib = 1024 ** 3,
    folder = Math.round(101.6 * gib),
    used = Math.round(92.7 * 1000 ** 3),
    quota = 384 * gib,
    overhead = 64 * 1024 ** 2,
    patchGrowth = 65536;
  const direct = preparationReservationBytes(folder, patchGrowth, 'folder', 'FPKG');
  assert.ok(used + direct <= quota);
  assert.ok(used + folder * 3 + patchGrowth * 5 + overhead > quota);
  assert.equal(direct, folder + patchGrowth + overhead);
  assert.equal(
    preparationReservationBytes(folder, patchGrowth, 'folder', 'SHADOWMOUNT'),
    folder * 4 + patchGrowth * 5 + overhead,
  );
  assert.equal(
    preparationReservationBytes(folder, patchGrowth, 'zip', 'FPKG'),
    folder * 5 + patchGrowth * 5 + overhead,
  );
});
