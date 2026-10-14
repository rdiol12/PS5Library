import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compact = (source: string) => source.replace(/\s+/g, '');

test('preparation cache verification runs before the quota transaction', async () => {
  const source = await readFile('app/src/jobs/preparation-routes.ts', 'utf8');
  const enqueue = source.slice(
    source.indexOf('function createPreparationEnqueue'),
    source.indexOf('function registerPreparationEndpoints'),
  );
  const transaction = enqueue.indexOf('transaction(db');
  assert.ok(transaction > 0);
  for (const operation of ['await stat(file)', 'await backportFiles(']) {
    const verification = enqueue.indexOf(operation);
    assert.ok(
      verification > 0 && verification < transaction,
      `${operation} must finish before the transaction starts`,
    );
  }
  assert.doesNotMatch(
    enqueue,
    /await fileHash\(file\)/,
    'A verified cached package is reused by existence and recorded byte size without re-hashing it',
  );
  assert.doesNotMatch(enqueue.slice(transaction), /await (?:stat|fileHash|backportFiles)\(/);
});

test('repeated automatic preparation skips before inspecting the cached package', async () => {
  const source = await readFile('app/src/jobs/preparation-routes.ts', 'utf8');
  const enqueue = source.slice(
    source.indexOf('function createPreparationEnqueue'),
    source.indexOf('function registerPreparationEndpoints'),
  );
  const precheck = enqueue.indexOf('SELECT 1 FROM automatic_preparations');
  assert.ok(precheck > 0 && precheck < enqueue.indexOf('await stat(file)'));
  assert.doesNotMatch(enqueue, /await fileHash\(file\)/);
});

test('cached FPKG with missing overlay queues an overlay-only build', async () => {
  const source = await readFile('app/src/jobs/preparation-routes.ts', 'utf8');
  const buildSource = await readFile('app/src/jobs/preparation.ts', 'utf8');
  const enqueue = compact(
    source.slice(
      source.indexOf('function createPreparationEnqueue'),
      source.indexOf('function registerPreparationEndpoints'),
    ),
  );
  assert.match(
    enqueue,
    /errorinstanceofAppError&&error\.code==='BACKPORT_FILES_MISSING'\)ready=false/,
  );
  assert.match(enqueue, /if\(valid&&ready\)return\{cached:true,artifactId:cached\.id\}/);
  assert.match(
    compact(buildSource),
    /profile\?\.delivery==='OVERLAY'.*?\?awaitrunWorker\(\['build-backport'/s,
  );
});

test('build destinations are checked before the package worker starts', async () => {
  const source = await readFile('app/src/jobs/preparation.ts', 'utf8');
  const prepare = compact(
    source.slice(source.indexOf('export async function prepare'), source.length),
  );
  const check = prepare.indexOf('awaitensurePublishDirectories('),
    build = prepare.indexOf("awaitrunWorker(['build-verified'");
  assert.ok(
    check > 0 && build > check,
    'an unwritable package or backport destination must fail before an expensive package build',
  );
});

test('artifact publishing delegates package SHA-256 to the path-confined worker before taking the advisory transaction lock', async () => {
  const source = await readFile('app/src/jobs/artifact-publication.ts', 'utf8');
  const publish = compact(source.slice(source.indexOf('export async function publishArtifact')));
  const transaction = publish.indexOf('transaction(db');
  assert.ok(transaction > 0);
  for (const operation of [
    "awaitrunWorker(['hash-file',filename]",
    "awaitrunWorker(['hash-tree'",
  ]) {
    const verification = publish.indexOf(operation);
    assert.ok(
      verification > 0 && verification < transaction,
      `${operation} must finish before the transaction starts`,
    );
  }
  assert.doesNotMatch(publish, /awaitfileHash\(filename/);
  assert.match(publish, /throttleWorkerProgress\(\(p\)=>publishProgress\(stage/);
  assert.match(publish, /hash-file',filename\],progress/);
  assert.match(publish, /actual\?\.sha256!==sha\|\|actual\?\.size!==size/);
  assert.match(publish, /sameFileIdentity\(before,after\)/);
  assert.doesNotMatch(
    publish.slice(transaction),
    /await(?:fileHash|runWorker\(\['hash-(?:file|tree)')/,
  );
});

test('retirement and recursive deletion keep slow filesystem work outside lock transactions', async () => {
  const preparation = await readFile('app/src/jobs/preparation-routes.ts', 'utf8'),
    trailers = await readFile('app/src/artwork/trailers.ts', 'utf8');
  const retire = preparation.slice(
    preparation.indexOf("  app.post('/api/v1/source-releases/:id/retire'"),
    preparation.indexOf('function registerArtifactDeletionRoutes'),
  );
  const compactRetire = compact(retire);
  const retireTransaction = compactRetire.slice(
    compactRetire.indexOf('constresult=awaittransaction'),
    compactRetire.indexOf('committed=true'),
  );
  assert.doesNotMatch(retireTransaction, /await(?:fileHash|runWorker|backportFiles)\(/);
  const stagedDelete = compact(
    preparation.slice(
      preparation.indexOf('async function stagedDeletion'),
      preparation.indexOf('async function matchingBackport'),
    ),
  );
  const deleteCommit = stagedDelete.indexOf('committed=true;');
  assert.ok(
    deleteCommit > stagedDelete.indexOf('transaction(db') &&
      stagedDelete.indexOf('awaitrm(') > deleteCommit,
    'staged metadata must commit before file cleanup',
  );
  assert.doesNotMatch(
    stagedDelete.slice(stagedDelete.indexOf('transaction(db'), deleteCommit),
    /awaitrm\(/,
  );
  const deletionRoutes = compact(
    preparation.slice(
      preparation.indexOf("  app.delete('/api/v1/backports/:id'"),
      preparation.indexOf('export async function preparationRoutes'),
    ),
  );
  assert.match(
    deletionRoutes,
    /awaitstage\(row\.relative_path,\{required:true,recursive:true\}\);awaitsql\.query\('UPDATEbackport_artifacts/,
  );
  assert.match(
    deletionRoutes,
    /awaitstage\(artifact\.relative_path\);awaitsql\.query\('UPDATEartifacts/,
  );
  const mediaDelete = compact(
    trailers.slice(trailers.indexOf('  app.delete(`/api/v1/games/:id/${kind}`')),
  );
  const mediaCommit = mediaDelete.indexOf('if(result.directory)');
  assert.ok(
    mediaCommit > mediaDelete.indexOf('transaction(db') &&
      mediaDelete.indexOf('awaitrm(') > mediaCommit,
    'media metadata must commit before recursive cleanup',
  );
  assert.doesNotMatch(
    mediaDelete.slice(mediaDelete.indexOf('transaction(db'), mediaCommit),
    /awaitrm\(/,
  );
});
