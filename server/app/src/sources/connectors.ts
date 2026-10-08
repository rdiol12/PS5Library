import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { manifestSchema, type Release, type SourceConfig } from '../../../shared/schemas/index.js';
import type { SourceConnector } from '../../../shared/types/index.js';
import type { Config } from '../config.js';
import { existingWithin } from '../security/paths.js';
import { AppError } from '../security/errors.js';
import { remoteBytes } from '../security/http.js';

export function sourceHeaders(source: SourceConfig, target?: string): Record<string, string> {
  if (!source.tokenEnv) return {};
  // Only administrator-configured repository credentials may leave the process.
  if (!source.tokenEnv.startsWith('REPOSITORY_TOKEN_')) throw new AppError('INVALID_CREDENTIAL_REFERENCE');
  const origin = source.type === 'GITHUB_RELEASE' ? 'https://api.github.com' : new URL(source.location).origin;
  if (target && new URL(target).origin !== origin) return {};
  const token = process.env[source.tokenEnv];
  if (!token) throw new AppError('SOURCE_CREDENTIAL_MISSING');
  return { authorization: `Bearer ${token}`, ...(source.type === 'GITHUB_RELEASE' ? { accept: 'application/octet-stream' } : {}) };
}
export class StaticManifestSource implements SourceConnector {
  id = 'STATIC_MANIFEST';
  constructor(protected source: SourceConfig, protected config: Config) {}
  protected async manifestUrl() { return this.source.location; }
  async discover() {
    const url = await this.manifestUrl();
    const bytes = await remoteBytes(url, { privateOrigins: this.config.privateOrigins, headers: sourceHeaders(this.source, url) }, 8 * 1024 ** 2);
    return manifestSchema.parse(JSON.parse(bytes.toString('utf8'))).releases.map(release => ({ ...release, location: new URL(release.location, url).href }));
  }
  async getRelease(key: string) { const release = (await this.discover()).find(r => r.key === key); if (!release) throw new AppError('RELEASE_NOT_FOUND', 404); return release; }
  async resolveDownloads(key: string) { const { location, sha256, size } = await this.getRelease(key); return { location, sha256, size }; }
}
export class PrivateHTTPRepositorySource extends StaticManifestSource { override id = 'PRIVATE_HTTP'; }
export class GitHubReleaseSource extends StaticManifestSource {
  override id = 'GITHUB_RELEASE';
  protected override async manifestUrl() {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.source.location)) throw new AppError('INVALID_REPOSITORY');
    const response = await remoteBytes(`https://api.github.com/repos/${this.source.location}/releases/latest`, { privateOrigins: [], headers: { ...sourceHeaders(this.source), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } }, 2 * 1024 ** 2);
    const release = JSON.parse(response.toString('utf8'));
    const asset = release.assets?.find((a: { name: string }) => a.name === 'ps5library.json');
    if (!asset?.url || new URL(asset.url).origin !== 'https://api.github.com') throw new AppError('MANIFEST_NOT_FOUND', 404);
    return asset.url as string;
  }
}
export class LocalFolderSource extends StaticManifestSource {
  override id = 'LOCAL_FOLDER';
  override async discover(): Promise<Release[]> {
    const root = await existingWithin(this.config.SOURCE_ROOT, path.resolve(this.config.SOURCE_ROOT, this.source.location));
    const manifestPath = await existingWithin(root, path.join(root, 'library.json'));
    if ((await stat(manifestPath)).size > 8 * 1024 ** 2) throw new AppError('INPUT_TOO_LARGE');
    const releases = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8'))).releases;
    return Promise.all(releases.map(async release => ({ ...release, location: path.relative(this.config.SOURCE_ROOT,await existingWithin(root,path.resolve(root,release.location))).split(path.sep).join('/') })));
  }
}
export function connector(source: SourceConfig, config: Config): SourceConnector {
  if (source.type === 'WATCH_FOLDER') throw new AppError('WATCH_SCAN_REQUIRES_DATABASE');
  const Adapter = { LOCAL_FOLDER: LocalFolderSource, STATIC_MANIFEST: StaticManifestSource, PRIVATE_HTTP: PrivateHTTPRepositorySource, GITHUB_RELEASE: GitHubReleaseSource }[source.type];
  return new Adapter(source, config);
}
