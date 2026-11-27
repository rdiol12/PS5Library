import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile),
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  gitOptions = { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, windowsHide: true };
const git = (repository, args, options = {}) =>
  execute('git', ['-C', repository, ...args], { ...gitOptions, ...options });
const normalizedRemote = (value) =>
  value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '');
const normalizedPatch = (value) => value.replaceAll('\r\n', '\n');

function patchPath(workspaceRoot, entry) {
  if (!entry.patch) return null;
  const patches = path.resolve(workspaceRoot, 'patches'),
    resolved = path.resolve(workspaceRoot, entry.patch);
  if (
    path.isAbsolute(entry.patch) ||
    (resolved !== patches && !resolved.startsWith(patches + path.sep))
  )
    throw Error(`Invalid upstream patch path for ${entry.name}`);
  return resolved;
}

export async function loadUpstreamEntries(workspaceRoot = projectRoot) {
  const entries = JSON.parse(
    (await readFile(path.join(workspaceRoot, 'docs', 'upstream-lock.json'), 'utf8')).replace(
      /^\uFEFF/,
      '',
    ),
  );
  if (!Array.isArray(entries)) throw Error('Invalid upstream lock file');
  for (const entry of entries) {
    if (
      !entry ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name) ||
      typeof entry.url !== 'string' ||
      !/^[a-f0-9]{40}$/.test(entry.commit)
    )
      throw Error('Invalid upstream lock entry');
    patchPath(workspaceRoot, entry);
  }
  return entries;
}

async function entryFor(workspaceRoot, repository, requested) {
  if (requested) return requested;
  const name = path.basename(repository),
    entry = (await loadUpstreamEntries(workspaceRoot)).find((item) => item.name === name);
  if (!entry) throw Error(`Missing upstream lock for ${name}`);
  return entry;
}

export async function verifyUpstreamRepository({
  workspaceRoot = projectRoot,
  repository,
  entry: requestedEntry,
}) {
  const entry = await entryFor(workspaceRoot, repository, requestedEntry),
    head = (await git(repository, ['rev-parse', 'HEAD'])).stdout.trim(),
    origin = (await git(repository, ['remote', 'get-url', 'origin'])).stdout.trim();
  if (head !== entry.commit) throw Error(`Unexpected ${entry.name} base commit`);
  if (normalizedRemote(origin) !== normalizedRemote(entry.url))
    throw Error(`Unexpected origin for ${entry.name}`);

  const status = (await git(repository, ['status', '--porcelain=v1', '--untracked-files=all']))
      .stdout,
    untracked = status.split(/\r?\n/).filter((line) => line.startsWith('?? ')),
    actual = normalizedPatch(
      (
        await git(repository, [
          'diff',
          'HEAD',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-renames',
        ])
      ).stdout,
    ),
    expectedFile = patchPath(workspaceRoot, entry),
    expected = expectedFile ? normalizedPatch(await readFile(expectedFile, 'utf8')) : '';
  if (untracked.length || actual !== expected)
    throw Error(`Unexpected local changes in upstream/${entry.name}`);
  return true;
}

async function syncEntry(workspaceRoot, entry) {
  const target = path.join(workspaceRoot, 'upstream', entry.name),
    exists = await stat(path.join(target, '.git')).catch(() => null);
  if (!exists) {
    if (await stat(target).catch(() => null))
      throw Error(`upstream/${entry.name} exists but is not a Git repository`);
    await execute('git', ['clone', entry.url, target], {
      ...gitOptions,
      encoding: undefined,
      stdio: 'inherit',
    });
  } else {
    const status = (await git(target, ['status', '--porcelain=v1', '--untracked-files=all']))
      .stdout;
    if (status.trim()) {
      try {
        await verifyUpstreamRepository({ workspaceRoot, repository: target, entry });
        return;
      } catch (error) {
        throw new Error(
          `Preserve unexpected local changes in upstream/${entry.name} before updating`,
          { cause: error },
        );
      }
    }
  }

  const origin = (await git(target, ['remote', 'get-url', 'origin'])).stdout.trim();
  if (normalizedRemote(origin) !== normalizedRemote(entry.url))
    throw Error(`Unexpected origin for ${entry.name}`);
  const head = (await git(target, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== entry.commit) {
    await git(target, ['fetch', 'origin', entry.commit], {
      encoding: undefined,
      stdio: 'inherit',
    });
    await git(target, ['checkout', '--detach', entry.commit], {
      encoding: undefined,
      stdio: 'inherit',
    });
  }
  const patch = patchPath(workspaceRoot, entry);
  if (patch) {
    await git(target, ['apply', '--check', patch]);
    await git(target, ['apply', '--whitespace=nowarn', patch]);
  }
  await verifyUpstreamRepository({ workspaceRoot, repository: target, entry });
}

export async function syncUpstreams({ workspaceRoot = projectRoot, names = [] } = {}) {
  const entries = await loadUpstreamEntries(workspaceRoot),
    requested = new Set(names),
    selected = names.length ? entries.filter((entry) => requested.delete(entry.name)) : entries;
  if (requested.size) throw Error(`Unknown upstream project: ${[...requested].join(', ')}`);
  await mkdir(path.join(workspaceRoot, 'upstream'), { recursive: true });
  for (const entry of selected) await syncEntry(workspaceRoot, entry);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const names = process.argv.slice(2);
  await syncUpstreams({ names });
  console.log(`Pinned upstream source is ready${names.length ? `: ${names.join(', ')}` : ''}.`);
}
