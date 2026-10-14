import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { updateRoutes } from '../../src/updates/routes.js';

test(
  'native updater verifies the server signature, resumes bytes and rejects corruption',
  { timeout: 90000 },
  async () => {
    const workspace = process.cwd(),
      relative = 'data/update-native-' + randomUUID(),
      root = path.join(workspace, relative);
    const app = Fastify(),
      token = randomUUID(),
      execute = promisify(execFile),
      requests: string[] = [];
    const key = generateKeyPairSync('ed25519'),
      body = Buffer.concat([Buffer.from([127, 69, 76, 70]), Buffer.alloc(1024 * 1024, 53)]);
    const hash = createHash('sha256').update(body).digest('hex');
    const payload = JSON.stringify({
      schemaVersion: 1,
      product: 'PS5Library',
      build: 2026091602,
      version: '0.2.1',
      sha256: hash,
      size: body.length,
    });
    const envelope = {
      payload,
      signature: sign(null, Buffer.from(payload), key.privateKey).toString('hex'),
    };
    try {
      await mkdir(path.join(root, 'updates'), { recursive: true });
      await mkdir(path.join(root, 'console'));
      await writeFile(path.join(root, 'updates', hash + '.elf'), body);
      await writeFile(path.join(root, 'updates/latest.json'), JSON.stringify(envelope));
      await writeFile(
        path.join(root, 'key.pem'),
        key.publicKey.export({ format: 'pem', type: 'spki' }),
      );
      app.addHook('onRequest', async (req) => {
        if (req.url.endsWith(hash)) requests.push(req.headers.range ?? 'full');
      });
      const launches: string[] = [];
      app.get('/launch', async (req) => {
        launches.push(req.url);
        return '';
      });
      await updateRoutes(
        app,
        { DATA_DIR: root } as any,
        {
          device: async (req: any) => {
            assert.equal(req.headers.authorization, 'Bearer ' + token);
            return {};
          },
        } as any,
      );
      const port = new URL(await app.listen({ host: '0.0.0.0', port: 0 })).port;
      const launch = (query: string) =>
        execute(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${path.resolve(workspace, '..')}:/workspace:ro`,
            'ps5library-build:0.43',
            'frontend/ps5/build/host/update-checks',
            '--launch',
            `http://host.docker.internal:${port}`,
            query,
          ],
          { windowsHide: true, timeout: 15000 },
        );
      await launch('/launch?titleId=CUSA12345');
      assert.deepEqual(launches, ['/launch?titleId=CUSA12345']);
      await assert.rejects(() => launch('/launch?titleId=CUSA12345&args=unexpected'));
      assert.equal(
        launches.length,
        1,
        'Reject injected arguments before sending a launcher request',
      );
      const run = () =>
        execute(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${path.resolve(workspace, '..')}:/workspace:ro`,
            '-v',
            `${root}:/state`,
            'ps5library-build:0.43',
            'frontend/ps5/build/host/update-checks',
            '--download',
            `http://host.docker.internal:${port}`,
            token,
            '/state/key.pem',
            '/state/console',
          ],
          { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 },
        );
      await writeFile(path.join(root, 'console', hash + '.part'), body.subarray(0, 1000));
      await run();
      assert.deepEqual(requests, ['bytes=1000-1048579']);
      assert.deepEqual(await readFile(path.join(root, 'console', hash + '.elf')), body);
      await rm(path.join(root, 'console', hash + '.elf'));
      body[5000] ^= 1;
      await writeFile(path.join(root, 'updates', hash + '.elf'), body);
      await assert.rejects(run);
      assert.equal(
        await readFile(path.join(root, 'console', hash + '.elf')).catch(() => null),
        null,
      );
      envelope.signature = '0'.repeat(128);
      await writeFile(path.join(root, 'updates/latest.json'), JSON.stringify(envelope));
      const before = requests.length;
      await assert.rejects(run);
      assert.equal(
        requests.length,
        before,
        'Reject bad signature before requesting executable bytes',
      );
    } finally {
      await app.close();
      assert.ok(root.startsWith(path.join(workspace, 'data') + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
