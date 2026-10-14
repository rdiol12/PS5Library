import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compact = (source: string) => source.replace(/\s+/g, '');

test('verified artifacts are reused by regular-file type and recorded size without another SHA-256 pass', async () => {
  const download = await readFile('app/src/api/app.ts', 'utf8');
  const transfer = await readFile('app/src/transfers/routes.ts', 'utf8');
  const downloadReuse = download.slice(
    download.indexOf('  const enqueueDownload = async'),
    download.indexOf('  await catalogRoutes'),
  );
  const transferReuse = transfer.slice(
    transfer.indexOf('  const enqueue = async'),
    transfer.indexOf("  app.post('/api/v1/transfers'"),
  );

  assert.match(
    downloadReuse.replace(/\s+/g, ' '),
    /fileStat\?\.isFile\(\)\s*&&\s*fileStat\.size\s*===\s*Number\(cached\.size\)/,
  );
  assert.doesNotMatch(downloadReuse, /fileHash\(/);
  assert.match(
    transferReuse.replace(/\s+/g, ' '),
    /before\.isFile\(\)\s*\|\|\s*before\.size\s*!==\s*Number\(artifact\.size\)/,
  );
  assert.doesNotMatch(transferReuse, /fileHash\(/);
  const artifactDownload = transfer.slice(
    transfer.indexOf("  app.get('/api/v1/device/artifacts/:id'"),
  );
  assert.match(
    compact(artifactDownload),
    /serveStoredFile\(req,reply,file,Number\(a\.size\),a\.sha256,'application\/octet-stream',config\.DATA_DIR,?\)/,
  );
});
