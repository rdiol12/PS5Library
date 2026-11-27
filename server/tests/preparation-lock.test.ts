import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compact = (source: string) => source.replace(/\s+/g, '');

test('preparation cache verification runs before the quota transaction', async () => {
  const source = await readFile('server/src/jobs/preparation.ts', 'utf8');
  const enqueue = source.slice(
    source.indexOf('  const enqueue = async'),
    source.indexOf("  app.post('/api/v1/preparations'"),
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
  const source = await readFile('server/src/jobs/preparation.ts', 'utf8');
  const enqueue = source.slice(
    source.indexOf('  const enqueue = async'),
    source.indexOf("  app.post('/api/v1/preparations'"),
  );
  const precheck = enqueue.indexOf('SELECT 1 FROM automatic_preparations');
  assert.ok(precheck > 0 && precheck < enqueue.indexOf('await stat(file)'));
  assert.doesNotMatch(enqueue, /await fileHash\(file\)/);
});

test('cached FPKG with missing overlay queues an overlay-only build', async () => {
  const source = await readFile('server/src/jobs/preparation.ts', 'utf8');
  const enqueue = compact(
    source.slice(
      source.indexOf('  const enqueue = async'),
      source.indexOf("  app.post('/api/v1/preparations'"),
    ),
  );
  assert.match(
    enqueue,
    /errorinstanceofAppError&&error\.code==='BACKPORT_FILES_MISSING'\)ready=false/,
  );
  assert.match(enqueue, /if\(valid&&ready\)return\{cached:true,artifactId:cached\.id\}/);
  assert.match(
    compact(source),
    /profile\?\.delivery==='OVERLAY'.*?\?awaitrunWorker\(\['build-backport'/s,
  );
});

test('build destinations are checked before the package worker starts', async () => {
  const source = await readFile('server/src/jobs/preparation.ts', 'utf8');
  const prepare = compact(
    source.slice(
      source.indexOf('export async function prepare'),
      source.indexOf('export async function preparationRoutes'),
    ),
  );
  const check = prepare.indexOf('awaitensurePublishDirectories('),
    build = prepare.indexOf("awaitrunWorker(['build-verified'");
  assert.ok(
    check > 0 && build > check,
    'an unwritable package or backport destination must fail before an expensive package build',
  );
});

test('verified folder builds reuse the scanned compatibility-tree hash', async () => {
  const source = compact(await readFile('server/src/jobs/preparation.ts', 'utf8'));
  assert.match(
    source,
    /String\(expected\.size\),\.\.\.profileArgs,\.\.\.\(profile\?\[profileInputHash\(source\)\]:\[\]\)/,
  );
});

test('artifact publishing delegates package SHA-256 to the path-confined worker before taking the advisory transaction lock', async () => {
  const source = await readFile('server/src/jobs/preparation.ts', 'utf8');
  const publish = compact(
    source.slice(
      source.indexOf('export async function publishArtifact'),
      source.indexOf('export async function prepare'),
    ),
  );
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
  const preparation = await readFile('server/src/jobs/preparation.ts', 'utf8'),
    trailers = await readFile('server/src/artwork/trailers.ts', 'utf8');
  const retire = preparation.slice(
    preparation.indexOf("  app.post('/api/v1/source-releases/:id/retire'"),
    preparation.indexOf("  app.delete('/api/v1/backports/:id'"),
  );
  const compactRetire = compact(retire);
  const retireTransaction = compactRetire.slice(
    compactRetire.indexOf('constresult=awaittransaction'),
    compactRetire.indexOf('committed=true'),
  );
  assert.doesNotMatch(retireTransaction, /await(?:fileHash|runWorker|backportFiles)\(/);
  const backportDelete = compact(
    preparation.slice(
      preparation.indexOf("  app.delete('/api/v1/backports/:id'"),
      preparation.indexOf("  app.delete('/api/v1/artifacts/:id'"),
    ),
  );
  const backportCommit = backportDelete.indexOf('committed=true;');
  assert.ok(
    backportCommit > backportDelete.indexOf('transaction(db') &&
      backportDelete.indexOf('awaitrm(') > backportCommit,
    'backport metadata must commit before recursive cleanup',
  );
  assert.doesNotMatch(
    backportDelete.slice(backportDelete.indexOf('transaction(db'), backportCommit),
    /awaitrm\(/,
  );
  const artifactDelete = compact(
    preparation.slice(
      preparation.indexOf("  app.delete('/api/v1/artifacts/:id'"),
      preparation.indexOf('  return { enqueue };'),
    ),
  );
  const artifactCommit = artifactDelete.indexOf('committed=true;');
  assert.ok(
    artifactCommit > artifactDelete.indexOf('transaction(db') &&
      artifactDelete.indexOf('awaitrm(') > artifactCommit,
    'artifact metadata must commit before package cleanup',
  );
  assert.doesNotMatch(
    artifactDelete.slice(artifactDelete.indexOf('transaction(db'), artifactCommit),
    /awaitrm\(/,
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
