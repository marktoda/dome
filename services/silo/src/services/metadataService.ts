import { getLogger, metrics } from '@dome/logging';
import { drizzle } from 'drizzle-orm/d1';
import { contents } from '../db/schema';
import { ContentMetadata } from '../types';

/**
 * MetadataService - A wrapper around D1 for content metadata operations
 * This service encapsulates all interactions with the D1 database
 */
export class MetadataService {
  private db: ReturnType<typeof drizzle>;

  constructor(private env: any) {
    this.db = drizzle(env.DB);
  }

  /**
   * Insert new content metadata
   * Uses onConflictDoNothing for idempotent operations
   */
  async insertMetadata(data: Omit<ContentMetadata, 'version'> & { sha256?: string | null }) {
    const startTime = Date.now();

    try {
      const result = await this.db
        .insert(contents)
        .values({
          ...data,
          version: 1,
        })
        .onConflictDoNothing();

      metrics.timing('silo.d1.insert.latency_ms', Date.now() - startTime);
      getLogger().debug({ id: data.id }, 'Content metadata inserted');

      return result;
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'insert' });
      getLogger().error({ error, id: data.id }, 'Error inserting content metadata');
      throw error;
    }
  }

  /**
   * Get content metadata by ID
   */
  async getMetadataById(id: string): Promise<ContentMetadata | null> {
    const startTime = Date.now();

    try {
      const result = await this.env.DB.prepare(
        `
        SELECT 
          id, 
          user_id as userId, 
          content_type as contentType, 
          size, 
          r2_key as r2Key, 
          sha256,
          created_at as createdAt,
          version
        FROM contents
        WHERE id = ?
      `,
      )
        .bind(id)
        .first();

      metrics.timing('silo.d1.get.latency_ms', Date.now() - startTime);

      return result as ContentMetadata | null;
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'get' });
      getLogger().error({ error, id }, 'Error getting content metadata');
      throw error;
    }
  }

  /**
   * Get content metadata for multiple IDs
   */
  async getMetadataByIds(ids: string[]): Promise<ContentMetadata[]> {
    if (ids.length === 0) return [];

    const startTime = Date.now();

    try {
      const placeholders = ids.map(() => '?').join(',');
      const { results } = (await this.env.DB.prepare(
        `
        SELECT 
          id, 
          user_id as userId, 
          content_type as contentType, 
          size, 
          r2_key as r2Key, 
          sha256,
          created_at as createdAt,
          version
        FROM contents
        WHERE id IN (${placeholders})
      `,
      )
        .bind(...ids)
        .all()) as { results: ContentMetadata[] };

      metrics.timing('silo.d1.get_many.latency_ms', Date.now() - startTime);

      return results;
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'get_many' });
      getLogger().error({ error, ids }, 'Error getting content metadata for multiple IDs');
      throw error;
    }
  }

  /**
   * Delete content metadata by ID
   */
  async deleteMetadata(id: string) {
    const startTime = Date.now();

    try {
      const result = await this.env.DB.prepare(
        `
        DELETE FROM contents
        WHERE id = ?
      `,
      )
        .bind(id)
        .run();

      metrics.timing('silo.d1.delete.latency_ms', Date.now() - startTime);
      getLogger().debug({ id }, 'Content metadata deleted');

      return result;
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'delete' });
      getLogger().error({ error, id }, 'Error deleting content metadata');
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  async getStats() {
    const startTime = Date.now();

    try {
      // Total count and size
      const countResult = (await this.env.DB.prepare(
        `
        SELECT COUNT(*) as total, SUM(size) as totalSize
        FROM contents
      `,
      ).first()) as { total: number; totalSize: number };

      // Counts by content type
      const typeResult = (await this.env.DB.prepare(
        `
        SELECT content_type as contentType, COUNT(*) as count
        FROM contents
        GROUP BY content_type
      `,
      ).all()) as { results: Array<{ contentType: string; count: number }> };

      const byType: Record<string, number> = {};
      for (const row of typeResult.results) {
        byType[row.contentType] = row.count;
      }

      const stats = {
        total: countResult.total ?? 0,
        totalSize: countResult.totalSize ?? 0,
        byType,
      };

      metrics.timing('silo.d1.stats.latency_ms', Date.now() - startTime);

      return stats;
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'stats' });
      getLogger().error({ error }, 'Error getting storage statistics');
      throw error;
    }
  }
}

export function createMetadataService(env: any): MetadataService {
  return new MetadataService(env);
}
