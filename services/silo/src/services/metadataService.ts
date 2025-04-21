import { getLogger, metrics } from '@dome/logging';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc, count, sum, or, isNull, inArray } from 'drizzle-orm';
import { contents } from '../db/schema';
import { SiloContentMetadata, SiloStatsResponse } from '@dome/common';

/**
 * MetadataService - A wrapper around D1 for content metadata operations
 * This service encapsulates all interactions with the D1 database
 */
export class MetadataService {
  private db: ReturnType<typeof drizzle>;

  constructor(private env: Env) {
    this.db = drizzle(env.DB);
  }

  /**
   * Insert new content metadata
   * Uses onConflictDoNothing for idempotent operations
   */
  async insertMetadata(data: Omit<SiloContentMetadata, 'version'> & { sha256?: string | null }) {
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
  async getMetadataById(id: string): Promise<SiloContentMetadata | null> {
    const startTime = Date.now();

    try {
      try {
        const result = await this.db.select().from(contents).where(eq(contents.id, id)).get();

        metrics.timing('silo.d1.get.latency_ms', Date.now() - startTime);

        return result as SiloContentMetadata | null;
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ id }, 'Contents table does not exist yet, returning null');
          return null;
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'get' });
      getLogger().error({ error, id }, 'Error getting content metadata');
      throw error;
    }
  }

  /**
   * Get content metadata for multiple IDs
   * @param ids - Array of content IDs to retrieve
   * @param userId - Optional user ID to filter results by
   */
  async getMetadataByIds(ids: string[]): Promise<SiloContentMetadata[]> {
    if (ids.length === 0) return [];

    const startTime = Date.now();

    try {
      try {
        getLogger().info(
          {
            ids,
          },
          'getMetadataByIds called',
        );

        const results = await this.db
          .select()
          .from(contents)
          .where(inArray(contents.id, ids)) // 👈 correct
          .all();

        getLogger().info(
          {
            resultCount: results.length,
            results,
          },
          'getMetadataByIds result',
        );

        metrics.timing('silo.d1.get_many.latency_ms', Date.now() - startTime);

        return results as SiloContentMetadata[];
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ ids }, 'Contents table does not exist yet, returning empty array');
          return [];
        }

        // Log detailed error information
        getLogger().error(
          {
            error:
              error instanceof Error
                ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
                : String(error),
            ids,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
          },
          'Error in DB query in getMetadataByIds',
        );

        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'get_many' });

      getLogger().error(
        {
          error:
            error instanceof Error
              ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
              : String(error),
          ids,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'Error getting content metadata for multiple IDs',
      );

      // Return empty array instead of throwing to make the function more resilient
      return [];
    }
  }

  /**
   * Delete content metadata by ID
   */
  async deleteMetadata(id: string) {
    const startTime = Date.now();

    try {
      try {
        const result = await this.db.delete(contents).where(eq(contents.id, id)).run();

        metrics.timing('silo.d1.delete.latency_ms', Date.now() - startTime);
        getLogger().debug({ id }, 'Content metadata deleted');

        return result;
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ id }, 'Contents table does not exist yet, nothing to delete');
          return { changes: 0 };
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'delete' });
      getLogger().error({ error, id }, 'Error deleting content metadata');
      throw error;
    }
  }

  /**
   * Get content metadata for a specific user with pagination and filtering
   */
  async getMetadataByUserId(
    userId: string,
    category?: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<SiloContentMetadata[]> {
    const startTime = Date.now();

    try {
      try {
        // Build the query conditions
        const conditions = category
          ? and(eq(contents.userId, userId), eq(contents.category, category))
          : eq(contents.userId, userId);

        // Execute the query with all conditions
        const results = await this.db
          .select()
          .from(contents)
          .where(conditions)
          .orderBy(desc(contents.createdAt))
          .limit(limit)
          .offset(offset)
          .all();

        getLogger().info({ userId, category, limit, offset }, 'Query parameters');
        getLogger().info({ resultCount: results.length }, 'Results count');

        metrics.timing('silo.d1.get_by_user.latency_ms', Date.now() - startTime);

        return results as SiloContentMetadata[];
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ userId }, 'Contents table does not exist yet, returning empty array');
          return [];
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'get_by_user' });
      getLogger().error({ error, userId }, 'Error getting content metadata for user');
      throw error;
    }
  }

  /**
   * Get total count of content for a user with optional filtering
   */
  async getContentCountForUser(userId: string, category?: string): Promise<number> {
    const startTime = Date.now();

    try {
      try {
        // Build the query conditions
        const conditions = category
          ? and(eq(contents.userId, userId), eq(contents.category, category))
          : eq(contents.userId, userId);

        // Execute the query with all conditions
        const result = await this.db
          .select({ count: count() })
          .from(contents)
          .where(conditions)
          .get();

        metrics.timing('silo.d1.count.latency_ms', Date.now() - startTime);

        return result?.count || 0;
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ userId }, 'Contents table does not exist yet, returning count 0');
          return 0;
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'count' });
      getLogger().error({ error, userId }, 'Error getting content count for user');
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<SiloStatsResponse> {
    const startTime = Date.now();

    try {
      try {
        // Total count and size
        const countResult = await this.db
          .select({
            total: count(),
            totalSize: sum(contents.size),
          })
          .from(contents)
          .get();

        // Counts by category
        const categoryResults = await this.db
          .select({
            category: contents.category,
            count: count(),
          })
          .from(contents)
          .groupBy(contents.category)
          .all();

        const byType: Record<string, number> = {};
        for (const row of categoryResults) {
          byType[row.category] = row.count;
        }

        const stats = {
          total: countResult?.total ?? 0,
          totalSize: parseInt(countResult?.totalSize ?? '0'),
          byType,
        };

        metrics.timing('silo.d1.stats.latency_ms', Date.now() - startTime);

        return stats;
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn('Contents table does not exist yet, returning empty stats');
          return {
            total: 0,
            totalSize: 0,
            byType: {},
          };
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'stats' });
      getLogger().error({ error }, 'Error getting storage statistics');
      throw error;
    }
  }

  /**
   * Update content metadata with enriched information (title, summary)
   */
  async updateEnrichedMetadata(
    id: string,
    data: { title?: string; summary?: string },
  ): Promise<void> {
    const startTime = Date.now();

    try {
      try {
        // Only update if there's data to update
        if (!data.title && !data.summary) {
          getLogger().warn({ id }, 'No enriched data to update');
          return;
        }

        // Build the update object with only the fields that are provided
        const updateData: { title?: string; summary?: string } = {};
        if (data.title) updateData.title = data.title;
        if (data.summary) updateData.summary = data.summary;

        // Execute the update
        const result = await this.db
          .update(contents)
          .set(updateData)
          .where(eq(contents.id, id))
          .run();

        metrics.timing('silo.d1.update_enriched.latency_ms', Date.now() - startTime);
        getLogger().info(
          { id, hasTitle: !!data.title, hasSummary: !!data.summary },
          'Content metadata enriched',
        );

        return;
      } catch (error) {
        // Check if the error is because the table doesn't exist
        if (error instanceof Error && error.message.includes('no such table: contents')) {
          getLogger().warn({ id }, 'Contents table does not exist yet, nothing to update');
          return;
        }
        throw error;
      }
    } catch (error) {
      metrics.increment('silo.d1.errors', 1, { operation: 'update_enriched' });
      getLogger().error({ error, id }, 'Error updating enriched content metadata');
      throw error;
    }
  }
}

export function createMetadataService(env: Env): MetadataService {
  return new MetadataService(env);
}
