import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compact = (source: string) => source.replace(/\s+/g, '');

test('compatibility planning uses the published manifest instead of rescanning its files', async () => {
  const [source, routes] = await Promise.all([
    readFile('app/src/library/backports.ts', 'utf8'),
    readFile('app/src/transfers/planning.ts', 'utf8'),
  ]);
  const resolver = source.slice(
    source.indexOf('export async function backportFiles'),
    source.indexOf('export const backportMessages'),
  );
  const compactRoutes = compact(routes);
  const compactResolver = compact(resolver);
  assert.match(
    compactRoutes,
    /backportFiles\(db,config,releaseId,exactInputHash,candidate\.profile,false,?\)/,
    'Interactive planning must select manifest-only verification',
  );
  assert.match(
    compactResolver,
    /root&&\(!prepared\|\|verifyContent\)/,
    'Raw, destructive and publication paths retain exact tree verification',
  );
  assert.match(
    compactResolver,
    /prepared&&expectedHash&&!verifyContent\?expectedHash:awaitfileHandleHash\(checked\.handle\)/,
    'Planning must reuse profile-bound hashes',
  );
});

test('an active exact-profile build is preparing rather than missing its backport', async () => {
  const routes = compact(await readFile('app/src/transfers/planning.ts', 'utf8'));
  assert.match(
    routes,
    /preparation&&errorinstanceofAppError&&error\.code==='BACKPORT_FILES_MISSING'/,
  );
  assert.match(
    routes,
    /config->'profile'->>'id'=\$2/,
    'Only the active build for the selected exact profile may suppress the missing-files state',
  );
  assert.match(
    routes,
    /desired_state='RUNNING'/,
    'Paused or cancelled preparation must not be reported as active',
  );
  assert.match(
    routes,
    /status:'BACKPORT_PREPARING'/,
    'The UI receives a truthful transient state instead of an available or missing backport',
  );
  assert.match(
    routes,
    /result\.status==='BACKPORT_PREPARING'/,
    'A user may join the already-running exact build',
  );
});
