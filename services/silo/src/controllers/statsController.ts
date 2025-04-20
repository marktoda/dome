import { getLogger, metrics } from '@dome/logging';
import { SiloStatsResponse } from '@dome/common';
import { MetadataService } from '../services/metadataService';

/**
 * StatsController handles business logic for statistics operations
 * Uses MetadataService to retrieve storage statistics
 */
export class StatsController {
  constructor(private env: any, private metadataService: MetadataService) {}

  /**
   * Get storage statistics
   * Retrieves total content count, total size, and counts by content type.
   */
  async getStats(): Promise<SiloStatsResponse> {
    try {
      // Get stats from MetadataService
      const stats = await this.metadataService.getStats();

      metrics.increment('silo.rpc.stats.success', 1);
      getLogger().info(stats, 'Stats retrieved successfully');

      return stats;
    } catch (error) {
      metrics.increment('silo.rpc.errors', 1, { method: 'stats' });
      getLogger().error({ error }, 'Error in getStats');
      throw error;
    }
  }
}

export function createStatsController(env: any, metadataService: MetadataService): StatsController {
  return new StatsController(env, metadataService);
}
