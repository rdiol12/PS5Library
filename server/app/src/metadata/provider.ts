import type { MetadataProvider } from '../../../shared/types/index.js';
import type { DB } from '../db.js';
export class ExactCatalogMetadataProvider implements MetadataProvider {
  id = 'exact-catalog';
  constructor(private db: DB, private userId: string) {}
  async searchGame(query: { titleId?: string; contentId?: string; title?: string }) {
    // Explicit exact identity only. External title search is a user-reviewed suggestion.
    if (!query.titleId && !query.contentId) return [];
    return (await this.db.query('SELECT DISTINCT g.id,g.metadata FROM games g LEFT JOIN game_releases r ON r.game_id=g.id WHERE g.user_id=$1 AND (g.title_id=$2 OR r.content_id=$3)', [this.userId, query.titleId ?? null, query.contentId ?? null])).rows.map(r => ({ id: r.id, ...r.metadata }));
  }
  async getGameMetadata(id: string) { return (await this.db.query('SELECT metadata FROM games WHERE id=$1 AND user_id=$2', [id, this.userId])).rows[0]?.metadata ?? null; }
}
