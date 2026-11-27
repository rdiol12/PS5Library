import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadUpstreamEntries, verifyUpstreamRepository } from './upstream.mjs';

const execute = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedSegments = new Set([
  '.git',
  'bin',
  'obj',
  'build',
  'dist',
  'node_modules',
  'TestResults',
]);
const forbiddenFile =
  /\.(?:log|db|db-[^/]+|sqlite3?|elf|pkg|ffpkg|ffpfs|ffpfsc|exfat|pup|exe|dll|pdb|so|dylib|dmp|core|key|zip|7z|tar|tar\.[^/]+|tgz|gz|bz2|xz|zst|rar)$/i;
const syntheticFixtures = new Set([
  'worker/Tests/Fixtures/homebrew.part1.rar',
  'worker/Tests/Fixtures/homebrew.part2.rar',
  'worker/Tests/Fixtures/homebrew.part3.rar',
  'worker/Tests/Fixtures/homebrew.part4.rar',
]);
const testCredentialFixtures = new Set([
  'backport-test-password',
  'catalog-owner-password',
  'community-password',
  'content-owner-password',
  'elevenchars',
  'family-password-one',
  'family-password-two',
  'feature-test-password',
  'friend-integration-password',
  'native-check-password-1234',
  'owner-password',
  'retirement-test-password',
  'runtime-member-password',
  'runtime-settings-password',
  'secret value',
  'twelve-chars',
  'watch-missing-password',
  'watch-profile-password',
]);
const normalizedRelative = (file) => path.relative(root, file).split(path.sep).join('/');
const forbiddenSource = (file) => {
  const relative = normalizedRelative(file),
    name = path.basename(file);
  return (
    !syntheticFixtures.has(relative) &&
    (forbiddenFile.test(relative) ||
      name === '.env' ||
      name.startsWith('.env.') ||
      name.startsWith('.tmp-') ||
      name.startsWith('tmp-'))
  );
};

const copyFile = async (from, to) => {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
};
const copyTree = async (from, to) =>
  cp(from, to, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(from, source),
        parts = relative.split(path.sep);
      return !parts.some((part) => excludedSegments.has(part)) && !forbiddenSource(source);
    },
  });
const copyEntries = async (output, entries) => {
  for (const [source, target = source] of entries)
    await copyFile(path.join(root, source), path.join(output, target));
};

async function packageJson(runtime) {
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  source.scripts = runtime
    ? {
        setup: 'node scripts/setup.mjs',
        'docker:configure': 'node --env-file=.env scripts/docker-configure.mjs',
        'docker:up':
          'npm run docker:configure && docker compose --env-file .env -f docker/compose.yml -f docker/compose.runtime.yml up -d --wait',
        'docker:restart':
          'docker compose --env-file .env -f docker/compose.yml -f docker/compose.runtime.yml restart server',
        'docker:logs':
          'docker compose --env-file .env -f docker/compose.yml -f docker/compose.runtime.yml logs -f --tail=200 server worker redis',
      }
    : {
        build: source.scripts.build,
        start: source.scripts.start,
        dev: source.scripts.dev,
        migrate: source.scripts.migrate,
        'build:worker': source.scripts['build:worker'],
        'test:worker': source.scripts['test:worker'],
        setup: 'node scripts/setup.mjs',
        'docker:configure': 'node --env-file=.env scripts/docker-configure.mjs',
        'docker:up':
          'npm run docker:configure && docker compose --env-file .env -f docker/compose.yml up -d --build --wait',
        'docker:restart': 'docker compose --env-file .env -f docker/compose.yml restart server',
        'docker:logs':
          'docker compose --env-file .env -f docker/compose.yml logs -f --tail=200 server worker redis',
        'test:container': 'node --env-file=.env scripts/check-container.mjs',
      };
  if (runtime) {
    delete source.dependencies;
    delete source.devDependencies;
  }
  return JSON.stringify(source, null, 2) + '\n';
}

async function copyUpstream(output) {
  const locks = await loadUpstreamEntries(root);
  for (const name of ['LibProsperoPKG-drakmor', 'UFS2Tool']) {
    const entry = locks.find((item) => item.name === name);
    if (!entry) throw Error(`Missing upstream lock for ${name}`);
    const source = path.join(root, 'upstream', name);
    await verifyUpstreamRepository({ workspaceRoot: root, repository: source, entry });
    const tracked = (
      await execute('git', ['-C', source, 'ls-files', '-z'], { maxBuffer: 64 * 1024 ** 2 })
    ).stdout
      .split('\0')
      .filter(Boolean);
    if (name === 'LibProsperoPKG-drakmor') {
      const destination = path.join(output, 'upstream', name, 'src', 'LibProsperoPkg');
      for (const file of tracked)
        if (file.startsWith('src/LibProsperoPkg/'))
          await copyFile(path.join(source, file), path.join(output, 'upstream', name, file));
      const projectFile = path.join(destination, 'LibProsperoPkg.csproj');
      const project = await readFile(projectFile, 'utf8');
      if (!project.includes('<EmbeddedResource Include="Keys\\Data\\pkg_meta_rsa_key.pem">'))
        throw Error('Pinned LibProsperoPKG private-key layout changed');
      const sanitized = project
        .replace(
          /\s*<EmbeddedResource Include="Keys\\Data\\pkg_meta_rsa_key\.pem">[\s\S]*?<\/EmbeddedResource>/,
          '',
        )
        .replace(
          'Publishing profile material: a legacy self-test PEM plus all public RSA-3072 banks',
          'Public RSA-3072 banks',
        );
      if (sanitized.includes('pkg_meta_rsa_key.pem'))
        throw Error('Pinned LibProsperoPKG private-key removal failed');
      await writeFile(projectFile, sanitized);
      await rm(path.join(destination, 'Keys', 'Data', 'pkg_meta_rsa_key.pem'));
      for (const file of ['LICENSE', 'NOTICE', 'README.md'])
        if (tracked.includes(file))
          await copyFile(path.join(source, file), path.join(output, 'upstream', name, file));
    } else {
      await mkdir(path.join(output, 'upstream', name), { recursive: true });
      for (const file of tracked)
        if (
          !file.includes('/') &&
          (/\.(?:cs|csproj)$/i.test(file) || ['LICENSE', 'app.manifest'].includes(file))
        )
          await copyFile(path.join(source, file), path.join(output, 'upstream', name, file));
    }
    if (entry.patch) {
      const sourcePatch = path.resolve(root, entry.patch),
        destination = path.join(output, 'upstream', name),
        patch = await readFile(sourcePatch);
      await copyFile(sourcePatch, path.join(destination, 'PS5Library.patch'));
      await writeFile(
        path.join(destination, 'PS5Library.patch.json'),
        JSON.stringify(
          {
            upstream: entry.url,
            baseCommit: entry.commit,
            patch: 'PS5Library.patch',
            patchSha256: createHash('sha256').update(patch).digest('hex'),
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
}

export async function releaseViolations(
  directory,
  { requireLicense = true, files = null, textOnly = false, scanIps = true } = {},
) {
  const violations = [];
  if (requireLicense && !(await stat(path.join(directory, 'LICENSE')).catch(() => null)))
    violations.push('PROJECT_LICENSE_MISSING');
  const inspect = async (file, relative) => {
    if (
      ((/(?:^|\/)(?:\.env(?:\..*)?|\.tmp-[^/]*|tmp-[^/]*)$/.test(relative) &&
        relative !== '.env.example') ||
        forbiddenFile.test(relative)) &&
      !syntheticFixtures.has(relative)
    ) {
      violations.push(`${relative}:PRIVATE_FILE`);
      return;
    }
    const data = await readFile(file),
      firstParty = !relative.startsWith('upstream/');
    if (data.includes(0)) {
      if (
        !textOnly &&
        firstParty &&
        !syntheticFixtures.has(relative) &&
        !/^server\/public\/fonts\/[^/]+\.ttf$/i.test(relative)
      )
        violations.push(`${relative}:UNREVIEWED_BINARY`);
      return;
    }
    const text = data.toString('utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) violations.push(`${relative}:PRIVATE_KEY`);
    if (
      firstParty &&
      (/[A-Za-z]:\\Users\\/i.test(text) ||
        /(?:^|[\s"'=(])\/home\/(?!user(?:\/|\b))[^/\s]+/im.test(text))
    )
      violations.push(`${relative}:PERSONAL_PATH_OR_HOST`);
    if (firstParty) {
      const scanText = text.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
      for (const match of scanText.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z0-9-]+\.ts\.net\b/gi))
        if (!/(?:^|\.)(?:example(?:-[a-z0-9-]+)?|name)\./i.test(match[0]))
          violations.push(`${relative}:PERSONAL_PATH_OR_HOST`);
      if (scanIps)
        for (const match of scanText.matchAll(
          /(?:^|[\s"'=:/])((?:\d{1,3}\.){3}\d{1,3})(?=$|[\s"',/:])/gm,
        )) {
          const ip = match[1],
            octets = ip.split('.').map(Number);
          if (octets.every((value) => value <= 255) && !['0.0.0.0', '127.0.0.1'].includes(ip))
            violations.push(`${relative}:NONLOCAL_IP`);
        }
      for (const match of scanText.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi))
        if (
          !/(?:^|\.)example\.(?:com|net|org)$/i.test(match[1]) &&
          !/(?:^|\.)(?:example|test|invalid|localhost)$/i.test(match[1])
        )
          violations.push(`${relative}:PERSONAL_EMAIL`);
      for (const match of scanText.matchAll(
        /(?<![-\w])(?:password|passwd|secret|token|api[_-]?key|api[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/gi,
      )) {
        const obviousTestFixture =
          /(?:^|\/)(?:tests?|Checks)\//i.test(relative) &&
          (testCredentialFixtures.has(match[2]) || /^(.)\1{15,}$/.test(match[2]));
        if (
          !obviousTestFixture &&
          !/^(?:GENERATE_WITH_|sample-|example-|placeholder-|replace-|test-|\[redacted\])/i.test(
            match[2],
          )
        )
          violations.push(`${relative}:EMBEDDED_CREDENTIAL`);
      }
    }
    if (relative === '.env.example')
      for (const line of text.split(/\r?\n/)) {
        const match = /^(?:[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY)[A-Z0-9_]*)=(.*)$/.exec(
          line,
        );
        if (match && match[1] && !/^(?:GENERATE_WITH_NPM_RUN_SETUP|<[^>]+>)$/.test(match[1]))
          violations.push(`${relative}:EMBEDDED_CREDENTIAL`);
      }
  };
  const visit = async (folder) => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name),
        relative = path.relative(directory, file).split(path.sep).join('/');
      if (item.isSymbolicLink()) {
        violations.push(`${relative}:SYMLINK`);
        continue;
      }
      if (item.isDirectory()) {
        if (/^(?:master|dist-master|data|\.secrets|ps5|clients)(?:\/|$)/.test(relative))
          violations.push(`${relative}:PRIVATE_PATH`);
        else await visit(file);
        continue;
      }
      await inspect(file, relative);
    }
  };
  if (files)
    for (const relative of files) {
      const file = path.resolve(directory, relative),
        info = await lstat(file);
      if (info.isSymbolicLink()) violations.push(`${relative}:SYMLINK`);
      else if (info.isFile()) await inspect(file, relative.replaceAll('\\', '/'));
    }
  else await visit(directory);
  return [...new Set(violations)].sort();
}

export async function prepareServerRelease(destination, { requireLicense = true } = {}) {
  const output = path.resolve(destination),
    temporary = await mkdtemp(path.join(os.tmpdir(), 'ps5library-release-'));
  try {
    // Never leave a previously generated tree behind after a later privacy or
    // licensing check fails; stale output is too easy to publish by mistake.
    await rm(output, { recursive: true, force: true });
    const license = path.join(root, 'SERVER-LICENSE');
    if (requireLicense && !(await stat(license).catch(() => null)))
      throw Error('Server release blocked:\nSERVER_LICENSE_MISSING');
    const common = [
      ['.env.example'],
      ['SERVER.md', 'README.md'],
      ['docker/compose.yml'],
      ['docker/compose.runtime.yml'],
      ['docker/Caddyfile'],
      ['scripts/setup.mjs'],
      ['scripts/docker-configure.mjs'],
    ];
    const source = path.join(temporary, 'source'),
      runtime = path.join(temporary, 'runtime');
    await mkdir(source, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await copyEntries(source, [
      ...common,
      ['.dockerignore'],
      ['package-lock.json'],
      ['tsconfig.json'],
      ['server/schema.sql'],
      ['docker/server.Dockerfile'],
      ['docker/postgres.Dockerfile'],
      ['scripts/check-container.mjs'],
      ['scripts/portable-sources.ts'],
    ]);
    for (const folder of ['server/src', 'server/public', 'shared', 'worker'])
      await copyTree(path.join(root, folder), path.join(source, folder));
    await copyUpstream(source);
    await writeFile(path.join(source, 'package.json'), await packageJson(false));
    const releaseIgnore = '.env\ndata/\ndist/\nnode_modules/\n**/bin/\n**/obj/\n*.log\n';
    await writeFile(path.join(source, '.gitignore'), releaseIgnore);
    if (await stat(license).catch(() => null)) {
      await copyFile(license, path.join(source, 'LICENSE'));
      await copyFile(license, path.join(source, 'SERVER-LICENSE'));
    }
    await copyEntries(runtime, common);
    await writeFile(path.join(runtime, 'package.json'), await packageJson(true));
    await writeFile(path.join(runtime, '.gitignore'), releaseIgnore);
    if (await stat(license).catch(() => null))
      await copyFile(license, path.join(runtime, 'LICENSE'));
    const violations = [
      ...(await releaseViolations(source, { requireLicense })).map((item) => `source:${item}`),
      ...(await releaseViolations(runtime, { requireLicense })).map((item) => `runtime:${item}`),
    ];
    if (violations.length) throw Error(`Server release blocked:\n${violations.join('\n')}`);
    await mkdir(path.dirname(output), { recursive: true });
    await cp(temporary, output, { recursive: true });
    return { output, source: path.join(output, 'source'), runtime: path.join(output, 'runtime') };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const output = path.join(root, 'dist-server-release');
  await prepareServerRelease(output);
  console.log(`Prepared public source and runtime bundles in ${path.relative(root, output)}.`);
}
