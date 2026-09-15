export type { Release, SourceConfig, Heartbeat, CompatibilityProfile } from '../schemas/index.js';
export interface Progress {
  downloadedBytes: number; totalBytes: number | null; speedBytesPerSecond: number; etaSeconds: number | null;
}
export interface JobEvent { id: string; jobId: string; state: string; progress: Progress; createdAt: string }
export interface MetadataProvider {
  id: string;
  searchGame(query: { titleId?: string; contentId?: string; title?: string }): Promise<Record<string, unknown>[]>;
  getGameMetadata(id: string): Promise<Record<string, unknown> | null>;
}
export interface SourceConnector {
  id: string;
  discover(): Promise<import('../schemas/index.js').Release[]>;
  getRelease(key: string): Promise<import('../schemas/index.js').Release>;
  resolveDownloads(key: string): Promise<{ location: string; sha256: string; size: number }>;
}
