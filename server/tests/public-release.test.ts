import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  dockerContextAllowed,
  forbiddenPublicPaths,
  publicReleaseViolations,
  publicReleaseFiles,
  validateDockerIgnore,
} from '../../scripts/check-public-release.mjs';
import { prepareServerRelease, releaseViolations } from '../../scripts/prepare-server-release.mjs';

test('client binaries publish only through the explicit manual workflow', async () => {
  const workflow = await readFile('.github/workflows/client-release.yml', 'utf8');
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow, /PS5LibraryCompanion\.ipa/);
  assert.match(workflow, /ps5library-agent\.elf/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /if: \$\{\{ inputs\.publish_release \}\}/);
});

test('public releases reject Community Master implementation and private data', () => {
  assert.deepEqual(
    forbiddenPublicPaths([
      'server/src/main.ts',
      'master/src/app.ts',
      'dist-master/master/src/app.js',
      'docker/master.Dockerfile',
      '.env',
      'data/save.bin',
      '.tmp-private.json',
      'game.pkg',
    ]),
    [
      'master/src/app.ts',
      'dist-master/master/src/app.js',
      'docker/master.Dockerfile',
      '.env',
      'data/save.bin',
      '.tmp-private.json',
      'game.pkg',
    ],
  );
});

test('public release candidates include tracked and nonignored untracked files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-public-files-'));
  try {
    const run = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
    await run('init', '--quiet');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'tracked.txt'), 'tracked');
    await writeFile(path.join(root, 'deleted.txt'), 'removed');
    await run('add', '.gitignore', 'tracked.txt', 'deleted.txt');
    await rm(path.join(root, 'deleted.txt'));
    await writeFile(path.join(root, 'untracked.txt'), 'untracked');
    await writeFile(path.join(root, 'private.pkg'), 'private');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored');

    const files = await publicReleaseFiles(root);
    assert.deepEqual(files, ['.gitignore', 'private.pkg', 'tracked.txt', 'untracked.txt']);
    assert.deepEqual(forbiddenPublicPaths(files), ['private.pkg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('internal developer tools and private review notes are never public', () => {
  assert.deepEqual(
    forbiddenPublicPaths([
      'tools/ps5-dev/pkg_cli.py',
      'tools/video/converter.py',
      'docs/PROJECT_REVIEW_2026-09-20.md',
    ]),
    ['tools/ps5-dev/pkg_cli.py', 'tools/video/converter.py', 'docs/PROJECT_REVIEW_2026-09-20.md'],
  );
});

test('public CI runs the release boundary check', async () => {
  const workflow = await readFile('.github/workflows/server-checks.yml', 'utf8');
  assert.match(workflow, /- run: npm run check:public-release/);
  assert.match(workflow, /- run: node scripts\/upstream\.mjs LibProsperoPKG-drakmor UFS2Tool/);
  assert.ok(workflow.indexOf('scripts/upstream.mjs') < workflow.indexOf('- run: npm test'));
});

test('public release scan rejects a credential in an untracked README', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-untracked-secret-'));
  try {
    const run = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
    await run('init', '--quiet');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await run('add', '.gitignore');
    const credentialName = ['pass', 'word'].join('');
    await writeFile(
      path.join(root, 'README.md'),
      `${credentialName} = "real-looking-secret-value"\n`,
    );
    assert.deepEqual(await publicReleaseViolations(root), ['README.md:EMBEDDED_CREDENTIAL']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test paths do not exempt a credential merely because its value contains password', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-test-secret-'));
  try {
    const run = (...args: string[]) => promisify(execFile)('git', args, { cwd: root }),
      file = path.join(root, 'server', 'tests', 'leak.ts'),
      credentialName = ['api', 'Token'].join(''),
      credentialValue = ['My', 'Password', '123'].join('');
    await run('init', '--quiet');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${credentialName} = "${credentialValue}"\n`);
    assert.deepEqual(await publicReleaseViolations(root), [
      'server/tests/leak.ts:EMBEDDED_CREDENTIAL',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compressed archives are excluded from public and Docker release boundaries', async () => {
  const archives = ['private.tgz', 'private.gz', 'private.bz2', 'private.xz', 'private.zst'];
  assert.deepEqual(
    forbiddenPublicPaths(archives.map((file) => `worker/${file}`)),
    archives.map((file) => `worker/${file}`),
  );
  for (const file of archives) assert.equal(dockerContextAllowed(`worker/${file}`), false, file);

  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-compressed-release-'));
  try {
    await writeFile(path.join(root, 'private.tgz'), 'fixture');
    assert.deepEqual(await releaseViolations(root, { requireLicense: false }), [
      'private.tgz:PRIVATE_FILE',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker build context uses the public server allowlist', () => {
  for (const file of [
    'LICENSE',
    'SERVER-LICENSE',
    'package.json',
    'server/src/main.ts',
    'server/public/app.js',
    'server/schema.sql',
    'shared/schemas/index.ts',
    'worker/Pipeline.cs',
    'worker/Tests/Fixtures/homebrew.part1.rar',
    'upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/ProsperoPackageBuilder.cs',
    'upstream/UFS2Tool/Ufs2ImageCreator.cs',
    'upstream/UFS2Tool/app.manifest',
    'scripts/portable-sources.ts',
  ])
    assert.equal(dockerContextAllowed(file), true, file);
  for (const file of [
    '.env',
    'data/catalog.db',
    'master/src/app.ts',
    'ps5/agent/agent.cpp',
    'clients/ios/App.swift',
    '.tmp-roadcraft.json',
    'scripts/native-update.mjs',
    'worker/bin/worker.dll',
    'worker/private.zip',
    'worker/private.rar',
    'server/src/debug.log',
    'server/src/local.sqlite',
    'upstream/LibProsperoPKG-drakmor/.git/config',
    'upstream/UFS2Tool/UFS2Tool.GUI/MainWindow.cs',
    'private.pkg',
  ])
    assert.equal(dockerContextAllowed(file), false, file);
});

test('Docker ignore is the reviewed default-deny context allowlist', async () => {
  assert.equal(validateDockerIgnore(await readFile('.dockerignore', 'utf8')), true);
});

test('Docker operator is optional and cannot access the Docker socket', async () => {
  const compose = await readFile('docker/compose.yml', 'utf8');
  const serverStart = compose.indexOf('\n  server:\n'),
    operatorStart = compose.indexOf('\n  operator:\n'),
    brokerStart = compose.indexOf('\n  docker-broker:\n');
  const server = compose.slice(serverStart, operatorStart);
  const operator = compose.slice(operatorStart, brokerStart);
  const broker = compose.slice(brokerStart, compose.indexOf('\n  worker:\n', brokerStart));
  assert.match(server, /OPERATOR_URL: \$\{OPERATOR_URL:-\}/);
  assert.doesNotMatch(server, /operator: \{condition: service_healthy\}/);
  assert.match(operator, /profiles: \["operator"\]/);
  assert.doesNotMatch(operator, /\n\s+ports:/, 'Operator must never publish a host port');
  assert.doesNotMatch(
    operator,
    /docker\.sock/,
    'The request-facing operator must never access the Docker socket',
  );
  assert.doesNotMatch(
    operator,
    /user: "0:0"/,
    'The request-facing operator must remain unprivileged',
  );
  assert.match(operator, /DOCKER_BROKER_URL: http:\/\/docker-broker:3161/);
  assert.match(
    server,
    /networks: \[default, operator-control\]/,
    'Only the API joins the operator control network',
  );
  assert.match(
    operator,
    /networks: \[operator-control, operator-socket\]/,
    'Operator can reach only the API and fixed Docker broker',
  );
  assert.match(broker, /profiles: \["operator"\]/);
  assert.match(
    broker,
    /source: \/var\/run\/docker\.sock\n\s+target: \/var\/run\/docker\.sock/,
    'Only the fixed broker mounts the Docker socket',
  );
  assert.match(
    broker,
    /networks: \[operator-socket\]/,
    'The Docker broker must not share the API network',
  );
  assert.match(
    compose,
    /\nnetworks:\n  operator-control:\n    internal: true\n  operator-socket:\n    internal: true\s*$/,
    'Both operator networks must be internal',
  );
});

test('reverse proxy does not persist capability tokens from native download URLs', async () => {
  const caddy = await readFile('docker/Caddyfile', 'utf8');
  assert.doesNotMatch(caddy, /^\s*log\s*\{/m);
});

test('release content rejects personal network identifiers and literal credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-private-release-'));
  try {
    const email = ['person', 'private.dev'].join('@'),
      tokenName = ['api', 'Token'].join('');
    await writeFile(
      path.join(root, 'config.txt'),
      `console=10.0.0.1\nowner=${email}\n{"${tokenName}":"0123456789abcdef0123456789abcdef"}\n`,
    );
    await writeFile(
      path.join(root, 'icon.js'),
      'const icon=`<svg><path d="M1 2.3.7.7 1.7.7.7 2Z"/></svg>`;\n',
    );
    assert.deepEqual(await releaseViolations(root, { requireLicense: false }), [
      'config.txt:EMBEDDED_CREDENTIAL',
      'config.txt:NONLOCAL_IP',
      'config.txt:PERSONAL_EMAIL',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release content rejects private keys even inside vendored source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-upstream-private-key-'));
  try {
    const file = path.join(root, 'upstream', 'dependency', 'test-private.pem');
    await mkdir(path.dirname(file), { recursive: true });
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    await writeFile(file, `${begin}\nfixture\n${end}\n`);
    assert.deepEqual(await releaseViolations(root, { requireLicense: false }), [
      'upstream/dependency/test-private.pem:PRIVATE_KEY',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server release separates corresponding source from the prebuilt runtime bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-release-')),
    output = path.join(root, 'release');
  try {
    const release = await prepareServerRelease(output, { requireLicense: false });
    assert.equal(release.source, path.join(output, 'source'));
    assert.equal(release.runtime, path.join(output, 'runtime'));
    assert.ok((await stat(path.join(output, 'source', 'server', 'src', 'main.ts'))).isFile());
    assert.ok((await stat(path.join(output, 'source', 'server', 'schema.sql'))).isFile());
    assert.equal(
      await stat(path.join(output, 'source', 'server', 'migrations')).catch(() => null),
      null,
    );
    assert.ok(
      (
        await stat(path.join(output, 'source', 'upstream', 'LibProsperoPKG-drakmor', 'LICENSE'))
      ).isFile(),
    );
    assert.ok(
      (
        await stat(
          path.join(
            output,
            'source',
            'upstream',
            'LibProsperoPKG-drakmor',
            'src',
            'LibProsperoPkg',
            'Keys',
            'Data',
            'token.hex',
          ),
        )
      ).isFile(),
    );
    assert.equal(
      await stat(
        path.join(
          output,
          'source',
          'upstream',
          'LibProsperoPKG-drakmor',
          'src',
          'LibProsperoPkg',
          'Keys',
          'Data',
          'pkg_meta_rsa_key.pem',
        ),
      ).catch(() => null),
      null,
    );
    assert.doesNotMatch(
      await readFile(
        path.join(
          output,
          'source',
          'upstream',
          'LibProsperoPKG-drakmor',
          'src',
          'LibProsperoPkg',
          'LibProsperoPkg.csproj',
        ),
        'utf8',
      ),
      /pkg_meta_rsa_key\.pem/,
    );
    assert.ok(
      (await stat(path.join(output, 'source', 'upstream', 'UFS2Tool', 'app.manifest'))).isFile(),
    );
    for (const name of ['LibProsperoPKG-drakmor', 'UFS2Tool']) {
      const provenance = JSON.parse(
        await readFile(
          path.join(output, 'source', 'upstream', name, 'PS5Library.patch.json'),
          'utf8',
        ),
      );
      assert.match(provenance.baseCommit, /^[a-f0-9]{40}$/);
      assert.match(provenance.patchSha256, /^[a-f0-9]{64}$/);
      assert.ok(
        (await stat(path.join(output, 'source', 'upstream', name, 'PS5Library.patch'))).isFile(),
      );
    }
    assert.equal(await stat(path.join(output, 'runtime', 'server')).catch(() => null), null);
    assert.equal(await stat(path.join(output, 'runtime', 'worker')).catch(() => null), null);
    const sourcePackage = JSON.parse(
        await readFile(path.join(output, 'source', 'package.json'), 'utf8'),
      ),
      runtimePackage = JSON.parse(
        await readFile(path.join(output, 'runtime', 'package.json'), 'utf8'),
      );
    assert.doesNotMatch(sourcePackage.scripts['docker:up'], /native-worker/);
    assert.match(runtimePackage.scripts['docker:up'], /compose\.runtime\.yml/);
    assert.deepEqual(
      await releaseViolations(path.join(output, 'source'), { requireLicense: false }),
      [],
    );
    assert.deepEqual(
      await releaseViolations(path.join(output, 'runtime'), { requireLicense: false }),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
