import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const tool = fileURLToPath(
  new URL('../../../tools/native-pkg-updater/native-update.mjs', import.meta.url),
);

test('native update CLI validates source metadata and reads an empty publication state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-native-update-tool-')),
    source = path.join(root, 'source'),
    data = path.join(root, 'data');
  try {
    await mkdir(path.join(source, 'sce_sys'), { recursive: true });
    await writeFile(
      path.join(source, 'sce_sys', 'param.json'),
      JSON.stringify({
        titleId: 'PPSA99051',
        contentId: 'UP9000-PPSA99051_00-PS5LIBRARYHOMETE',
        contentVersion: '01.000.000',
      }),
    );
    const help = JSON.parse((await run(process.execPath, [tool, '--help'])).stdout),
      prerequisites = JSON.parse(
        (
          await run(process.execPath, [
            tool,
            'prerequisites',
            '--title-id',
            'PPSA99051',
            '--source',
            source,
          ])
        ).stdout,
      ),
      configured = JSON.parse(
        (
          await run(process.execPath, [
            tool,
            'configure',
            '--title-id',
            'PPSA99051',
            '--source',
            source,
            '--update-origin',
            'https://updates.example',
          ])
        ).stdout,
      ),
      configuredRequirements = JSON.parse(
        (
          await run(
            process.execPath,
            [tool, 'prerequisites', '--title-id', 'PPSA99051', '--source', source],
            { env: { ...process.env, PUBLIC_URL: 'https://updates.example' } },
          )
        ).stdout,
      ),
      status = JSON.parse(
        (
          await run(process.execPath, [
            tool,
            'status',
            '--title-id',
            'PPSA99051',
            '--data-dir',
            data,
          ])
        ).stdout,
      );
    assert.equal(help.tool, 'ps5library-native-update');
    assert.equal(prerequisites.ready, false);
    assert.equal(prerequisites.validated.titleId, 'PPSA99051');
    assert.equal(configured.changed, true);
    assert.equal(configuredRequirements.ready, true);
    assert.equal(
      JSON.parse(await readFile(path.join(source, 'sce_sys', 'param.json'), 'utf8')).versionFileUri,
      'https://updates.example/api/v1/native-updates/PPSA99051/from/01.000.000/version.xml',
    );
    assert.equal(status.served, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
