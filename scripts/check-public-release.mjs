import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { releaseViolations } from './prepare-server-release.mjs';

const execute = promisify(execFile),
  forbidden = [
    /^master\//,
    /^dist-master\//,
    /^docker\/master\.Dockerfile(?:\.dockerignore)?$/,
    /^tools\/(?:ps5-dev|video)(?:\/|$)/,
    /^docs\/PROJECT_REVIEW_2026-09-20\.md$/,
    /^(?:data|\.secrets|ps5\/developer)\//,
    /^\.env(?:$|\.(?!example$).+)/,
    /(?:^|\/)(?:\.tmp-|tmp-|tmp-deploy-master|private-master-deploy)/,
    /\.(?:log|db|db-[^/]+|sqlite3?|elf|pkg|ffpkg|ffpfs|ffpfsc|exfat|pup|exe|dll|pdb|so|dylib|dmp|core|zip|7z|tar|tar\.[^/]+|tgz|gz|bz2|xz|zst|rar)$/i,
  ];
const syntheticFixtures = new Set([
  'worker/Tests/Fixtures/homebrew.part1.rar',
  'worker/Tests/Fixtures/homebrew.part2.rar',
  'worker/Tests/Fixtures/homebrew.part3.rar',
  'worker/Tests/Fixtures/homebrew.part4.rar',
]);
export const forbiddenPublicPaths = (paths) =>
  paths.filter((name) => {
    const file = name.replaceAll('\\', '/');
    return !syntheticFixtures.has(file) && forbidden.some((pattern) => pattern.test(file));
  });
export const publicReleaseFiles = async (cwd = '.') => {
  const files = (
    await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd,
      maxBuffer: 8 * 1024 ** 2,
    })
  ).stdout
    .split('\0')
    .filter(Boolean)
    .sort();
  return (
    await Promise.all(
      files.map(async (file) =>
        lstat(path.join(cwd, file)).then(
          () => file,
          (error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        ),
      ),
    )
  ).filter(Boolean);
};
export const publicReleaseViolations = async (cwd = '.') => {
  const files = await publicReleaseFiles(cwd),
    blocked = forbiddenPublicPaths(files),
    blockedSet = new Set(blocked),
    textual = files.filter((file) => !blockedSet.has(file));
  return [
    ...blocked,
    ...(await releaseViolations(path.resolve(cwd), {
      requireLicense: false,
      files: textual,
      textOnly: true,
      // Repository docs and tests intentionally contain non-production IP fixtures.
      scanIps: false,
    })),
  ].sort();
};
export const dockerContextAllowed = (name) => {
  const file = name.replaceAll('\\', '/').replace(/^\.\//, '');
  if (syntheticFixtures.has(file)) return true;
  if (forbidden.some((pattern) => pattern.test(file))) return false;
  if (
    [
      '.dockerignore',
      'LICENSE',
      'SERVER-LICENSE',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'docker/server.Dockerfile',
      'docker/postgres.Dockerfile',
      'scripts/portable-sources.ts',
    ].includes(file)
  )
    return true;
  if (
    file === 'server/schema.sql' ||
    /^server\/(?:src|public)\//.test(file) ||
    /^shared\//.test(file)
  )
    return true;
  if (
    /^worker\//.test(file) &&
    !/(?:^|\/)(?:bin|obj|build|dist|TestResults)(?:\/|$)/.test(file) &&
    !forbidden.some((pattern) => pattern.test(file))
  )
    return true;
  if (
    /^upstream\/LibProsperoPKG-drakmor\/(?:LICENSE|NOTICE|README\.md|src\/LibProsperoPkg\/)/.test(
      file,
    )
  )
    return (
      !/(?:^|\/)(?:\.git|bin|obj|build|dist|TestResults)(?:\/|$)/.test(file) &&
      !forbidden.some((pattern) => pattern.test(file))
    );
  return (
    /^upstream\/UFS2Tool\/(?:LICENSE|app\.manifest|[^/]+\.(?:cs|csproj))$/.test(file) &&
    !forbidden.some((pattern) => pattern.test(file))
  );
};

export const validateDockerIgnore = (text) => {
  const requiredIncludes = [
    '!.dockerignore',
    '!package.json',
    '!package-lock.json',
    '!tsconfig.json',
    '!LICENSE',
    '!SERVER-LICENSE',
    '!docker/',
    '!docker/server.Dockerfile',
    '!docker/postgres.Dockerfile',
    '!server/',
    '!server/src/',
    '!server/src/**',
    '!server/public/',
    '!server/public/**',
    '!server/schema.sql',
    '!shared/',
    '!shared/**',
    '!scripts/',
    '!scripts/portable-sources.ts',
    '!worker/',
    '!worker/**',
    '!upstream/',
    '!upstream/LibProsperoPKG-drakmor/',
    '!upstream/LibProsperoPKG-drakmor/LICENSE',
    '!upstream/LibProsperoPKG-drakmor/NOTICE',
    '!upstream/LibProsperoPKG-drakmor/README.md',
    '!upstream/LibProsperoPKG-drakmor/src/',
    '!upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/',
    '!upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/**',
    '!upstream/UFS2Tool/',
    '!upstream/UFS2Tool/*.cs',
    '!upstream/UFS2Tool/*.csproj',
    '!upstream/UFS2Tool/LICENSE',
    '!upstream/UFS2Tool/app.manifest',
    ...[...syntheticFixtures].map((file) => `!${file}`),
  ];
  const includes = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!'));
  const requiredExcludes = [
    '**/bin/**',
    '**/obj/**',
    '**/build/**',
    '**/dist/**',
    '**/TestResults/**',
    '**/.env',
    '**/.env.*',
    '**/.tmp-*',
    '**/tmp-*',
    '**/*.log',
    '**/*.db',
    '**/*.pkg',
    '**/*.elf',
    '**/*.pup',
    '**/*.zip',
    '**/*.tgz',
    '**/*.gz',
    '**/*.bz2',
    '**/*.xz',
    '**/*.zst',
    '**/*.rar',
  ];
  return (
    text.split(/\r?\n/, 1)[0] === '*' &&
    includes.length === requiredIncludes.length &&
    requiredIncludes.every((line) => includes.includes(line)) &&
    requiredExcludes.every((line) => text.split(/\r?\n/).includes(line))
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await publicReleaseFiles(),
    violations = await publicReleaseViolations();
  if (violations.length)
    throw new Error(
      `Private files or content are present in the public repository:\n${violations.join('\n')}`,
    );
  const dockerIgnore = await import('node:fs/promises').then((fs) =>
    fs.readFile(path.resolve('.dockerignore'), 'utf8'),
  );
  if (!validateDockerIgnore(dockerIgnore))
    throw new Error(
      'Docker context must remain the reviewed default-deny allowlist with dangerous file types excluded.',
    );
  console.log(
    `Public release path and text scan passed for ${files.length} tracked and nonignored files; generated release bundles are scanned separately.`,
  );
}
