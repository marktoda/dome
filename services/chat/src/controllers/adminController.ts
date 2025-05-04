import { getLogger, logError, metrics } from '@dome/common';
import { withContext } from '@dome/common';
import { z } from 'zod';
import { Services } from '../services';

// Define schemas for response validation
const checkpointStatsResponseSchema = z.object({
  totalCheckpoints: z.number(),
  oldestCheckpoint: z.number(),
  newestCheckpoint: z.number(),
  averageStateSize: z.number(),
  checkpointsByUser: z.record(z.string(), z.number()).optional(),
});

const cleanupResponseSchema = z.object({
  deletedCount: z.number(),
});

const dataRetentionStatsResponseSchema = z.object({
  totalRecords: z.number(),
  recordsByCategory: z.record(z.string(), z.number()),
  recordsByUser: z.record(z.string(), z.number()).optional(),
  oldestRecord: z.number(),
  newestRecord: z.number(),
});

const consentRequestSchema = z.object({
  durationDays: z
    .number()
    .min(1)
    .max(365 * 5), // Max 5 years
});

/**
 * Admin Controller
 *
 * Handles administrative operations including checkpoint management,
 * data retention, and user consent management.
 */
export class AdminController {
  private logger = getLogger().child({ component: 'AdminController' });

  /**
   * Create a new AdminController
   * @param env Environment bindings
   * @param services Service container
   */
  constructor(private readonly env: Env, private readonly services: Services) {}

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<z.infer<typeof checkpointStatsResponseSchema>> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'getCheckpointStats',
      },
      async () => {
        try {
          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Get stats
          const stats = await this.services.checkpointer.getStats();

          // Track metrics
          metrics.increment('chat_orchestrator.admin.checkpoint_stats', 1);

          return stats;
        } catch (error) {
          logError(error, 'Error getting checkpoint stats');
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'getCheckpointStats',
          });
          throw error;
        }
      },
    );
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<z.infer<typeof cleanupResponseSchema>> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'cleanupCheckpoints',
      },
      async () => {
        try {
          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Clean up expired checkpoints
          const deletedCount = await this.services.checkpointer.cleanup();

          // Track metrics
          metrics.increment('chat_orchestrator.admin.checkpoint_cleanup', 1);
          metrics.increment('chat_orchestrator.admin.checkpoints_deleted', deletedCount);

          return { deletedCount };
        } catch (error) {
          logError(error, 'Error cleaning up checkpoints');
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'cleanupCheckpoints',
          });
          throw error;
        }
      },
    );
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<z.infer<typeof dataRetentionStatsResponseSchema>> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'getDataRetentionStats',
      },
      async () => {
        try {
          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Initialize data retention manager
          await this.services.dataRetention.initialize();

          // Get raw stats
          const raw = await this.services.dataRetention.getStats();

          // Adapt to response schema
          const stats: z.infer<typeof dataRetentionStatsResponseSchema> = {
            totalRecords: raw.totalRecords,
            recordsByCategory: raw.recordsByCategory,
            oldestRecord: (raw as any).oldestRecord,
            newestRecord: (raw as any).newestRecord,
            recordsByUser: (raw as any).recordsByUser,
          };

          // Track metrics
          metrics.increment('chat_orchestrator.admin.data_retention_stats', 1);

          return stats;
        } catch (error) {
          logError(error, 'Error getting data retention stats');
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'getDataRetentionStats',
          });
          throw error;
        }
      },
    );
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'cleanupExpiredData',
      },
      async () => {
        try {
          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Initialize data retention manager
          await this.services.dataRetention.initialize();

          // Clean up expired data
          const raw = await this.services.dataRetention.cleanupExpiredData();

          // Determine deleted count
          const deletedCount = (raw as any).deletedCount ?? raw.deleted;

          // Track metrics
          metrics.increment('chat_orchestrator.admin.data_cleanup', 1);
          if (deletedCount) {
            metrics.increment('chat_orchestrator.admin.records_deleted', deletedCount);
          }

          // Return unified result
          return { deletedCount };
        } catch (error) {
          logError(error, 'Error cleaning up expired data');
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'cleanupExpiredData',
          });
          throw error;
        }
      },
    );
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'deleteUserData',
        userId,
      },
      async () => {
        try {
          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Initialize data retention manager
          await this.services.dataRetention.initialize();

          // Delete user data
          const deletedCount = await this.services.dataRetention.deleteUserData(userId);

          // Track metrics
          metrics.increment('chat_orchestrator.admin.user_data_deleted', 1, {
            userId,
          });
          metrics.increment('chat_orchestrator.admin.records_deleted', deletedCount);

          return { deletedCount };
        } catch (error) {
          logError(error, 'Error deleting user data', { userId });
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'deleteUserData',
            userId,
          });
          throw error;
        }
      },
    );
  }

  /**
   * Record user consent
   * @param userId User ID
   * @param dataCategory Data category
   * @param request Consent request
   * @returns Success result
   */
  async recordConsent(
    userId: string,
    dataCategory: string,
    request: z.infer<typeof consentRequestSchema>,
  ): Promise<{ success: boolean }> {
    return withContext(
      {
        service: 'chat-orchestrator',
        operation: 'recordConsent',
        userId,
        dataCategory,
      },
      async () => {
        try {
          // Validate request
          const validatedRequest = consentRequestSchema.parse(request);

          // Initialize checkpointer
          await this.services.checkpointer.initialize();

          // Initialize data retention manager
          await this.services.dataRetention.initialize();

          // Record consent
          await this.services.dataRetention.recordConsent(
            userId,
            dataCategory,
            validatedRequest.durationDays,
          );

          // Track metrics
          metrics.increment('chat_orchestrator.admin.consent_recorded', 1, {
            userId,
            dataCategory,
          });

          return { success: true };
        } catch (error) {
          logError(error, 'Error recording user consent', { userId, dataCategory });
          metrics.increment('chat_orchestrator.admin.errors', 1, {
            operation: 'recordConsent',
            userId,
            dataCategory,
          });
          throw error;
        }
      },
    );
  }
}

/**
 * Create a new AdminController
 * @param env Environment bindings
 * @param services Service container
 * @returns AdminController instance
 */
export function createAdminController(env: Env, services: Services): AdminController {
  return new AdminController(env, services);
}
