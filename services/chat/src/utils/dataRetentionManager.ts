import { getLogger } from '@dome/logging';
import { SecureD1Checkpointer } from '../checkpointer/secureD1Checkpointer';
import { getUserInfo, UserRole } from '@dome/common/src/middleware/enhancedAuthMiddleware';
import { Context } from 'hono';
import { ForbiddenError } from '@dome/common/src/errors/ServiceError';

/**
 * Data retention policy configuration
 */
export interface DataRetentionPolicy {
  /**
   * Default retention period in seconds
   * @default 30 days (2592000 seconds)
   */
  defaultRetentionPeriod: number;

  /**
   * Retention periods by data category in seconds
   */
  retentionPeriods: {
    /**
     * Retention period for chat history
     * @default 30 days (2592000 seconds)
     */
    chatHistory: number;

    /**
     * Retention period for user data
     * @default 90 days (7776000 seconds)
     */
    userData: number;

    /**
     * Retention period for system logs
     * @default 14 days (1209600 seconds)
     */
    systemLogs: number;

    /**
     * Retention period for analytics data
     * @default 365 days (31536000 seconds)
     */
    analyticsData: number;
  };

  /**
   * Data categories that require explicit user consent for retention
   */
  requiresConsentCategories: string[];

  /**
   * Data categories that should be encrypted
   */
  encryptedCategories: string[];

  /**
   * Data categories that should be anonymized after retention period
   * instead of being deleted
   */
  anonymizeAfterRetention: string[];
}

/**
 * Default data retention policy
 */
export const DEFAULT_RETENTION_POLICY: DataRetentionPolicy = {
  defaultRetentionPeriod: 30 * 24 * 60 * 60, // 30 days in seconds
  retentionPeriods: {
    chatHistory: 30 * 24 * 60 * 60, // 30 days
    userData: 90 * 24 * 60 * 60, // 90 days
    systemLogs: 14 * 24 * 60 * 60, // 14 days
    analyticsData: 365 * 24 * 60 * 60, // 365 days
  },
  requiresConsentCategories: ['chatHistory', 'userData'],
  encryptedCategories: ['chatHistory', 'userData'],
  anonymizeAfterRetention: ['analyticsData'],
};

/**
 * Data retention manager for implementing data retention policies
 */
export class DataRetentionManager {
  private logger = getLogger().child({ component: 'dataRetentionManager' });
  private policy: DataRetentionPolicy;
  private db: D1Database;
  private checkpointer: SecureD1Checkpointer;

  /**
   * Create a new data retention manager
   * @param db D1 database instance
   * @param checkpointer Secure D1 checkpointer
   * @param policy Data retention policy
   */
  constructor(
    db: D1Database,
    checkpointer: SecureD1Checkpointer,
    policy: DataRetentionPolicy = DEFAULT_RETENTION_POLICY,
  ) {
    this.db = db;
    this.checkpointer = checkpointer;
    this.policy = policy;
  }

  /**
   * Initialize the data retention manager
   * Creates necessary tables if they don't exist
   */
  async initialize(): Promise<void> {
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS data_retention_consents (
          user_id TEXT NOT NULL,
          data_category TEXT NOT NULL,
          consented_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (user_id, data_category)
        );
        
        CREATE TABLE IF NOT EXISTS data_retention_records (
          record_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          data_category TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          anonymized BOOLEAN DEFAULT 0
        );
        
        CREATE INDEX IF NOT EXISTS idx_data_retention_records_expires 
        ON data_retention_records(expires_at);
        
        CREATE INDEX IF NOT EXISTS idx_data_retention_records_user 
        ON data_retention_records(user_id);
      `);

      this.logger.info('DataRetentionManager initialized successfully');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to initialize DataRetentionManager');
      throw error;
    }
  }

  /**
   * Record user consent for data retention
   * @param userId User ID
   * @param dataCategory Data category
   * @param consentDurationDays Duration of consent in days (optional)
   */
  async recordConsent(
    userId: string,
    dataCategory: string,
    consentDurationDays?: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let expiresAt: number | null = null;

    if (consentDurationDays) {
      expiresAt = now + consentDurationDays * 24 * 60 * 60;
    }

    try {
      await this.db
        .prepare(
          `
          INSERT OR REPLACE INTO data_retention_consents 
          (user_id, data_category, consented_at, expires_at)
          VALUES (?, ?, ?, ?)
        `,
        )
        .bind(userId, dataCategory, now, expiresAt)
        .run();

      this.logger.info(
        {
          userId,
          dataCategory,
          consentDurationDays,
        },
        'User consent recorded',
      );
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId,
          dataCategory,
        },
        'Failed to record user consent',
      );
      throw error;
    }
  }

  /**
   * Check if user has consented to data retention
   * @param userId User ID
   * @param dataCategory Data category
   * @returns Whether user has consented
   */
  async hasConsent(userId: string, dataCategory: string): Promise<boolean> {
    try {
      const now = Math.floor(Date.now() / 1000);

      const result = await this.db
        .prepare(
          `
          SELECT 1 FROM data_retention_consents
          WHERE user_id = ?
          AND data_category = ?
          AND (expires_at IS NULL OR expires_at > ?)
        `,
        )
        .bind(userId, dataCategory, now)
        .first<{ 1: number }>();

      return !!result;
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId,
          dataCategory,
        },
        'Failed to check user consent',
      );
      return false;
    }
  }

  /**
   * Register a data record for retention
   * @param recordId Record ID
   * @param userId User ID
   * @param dataCategory Data category
   * @param context Hono context for user authentication
   */
  async registerDataRecord(
    recordId: string,
    userId: string,
    dataCategory: string,
    context?: Context,
  ): Promise<void> {
    try {
      // Check if this category requires consent
      if (this.policy.requiresConsentCategories.includes(dataCategory)) {
        const hasConsent = await this.hasConsent(userId, dataCategory);

        if (!hasConsent) {
          // If context is available, check if user is an admin
          if (context) {
            try {
              const userInfo = getUserInfo(context);

              if (userInfo.role !== UserRole.ADMIN) {
                throw new ForbiddenError(`User consent required for ${dataCategory}`);
              }
            } catch (error) {
              if (error instanceof ForbiddenError) {
                throw error;
              }

              throw new ForbiddenError(`User consent required for ${dataCategory}`);
            }
          } else {
            throw new ForbiddenError(`User consent required for ${dataCategory}`);
          }
        }
      }

      const now = Math.floor(Date.now() / 1000);

      // Get retention period for this category
      const retentionPeriod =
        this.policy.retentionPeriods[dataCategory as keyof typeof this.policy.retentionPeriods] ||
        this.policy.defaultRetentionPeriod;

      const expiresAt = now + retentionPeriod;

      await this.db
        .prepare(
          `
          INSERT OR REPLACE INTO data_retention_records
          (record_id, user_id, data_category, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        )
        .bind(recordId, userId, dataCategory, now, expiresAt)
        .run();

      this.logger.info(
        {
          recordId,
          userId,
          dataCategory,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        'Data record registered for retention',
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw error;
      }

      this.logger.error(
        {
          err: error,
          recordId,
          userId,
          dataCategory,
        },
        'Failed to register data record',
      );
      throw error;
    }
  }

  /**
   * Clean up expired data records
   * @returns Number of records processed
   */
  async cleanupExpiredData(): Promise<{
    deleted: number;
    anonymized: number;
  }> {
    try {
      const now = Math.floor(Date.now() / 1000);
      let deleted = 0;
      let anonymized = 0;

      // Get expired records
      const expiredRecords = await this.db
        .prepare(
          `
          SELECT record_id, user_id, data_category
          FROM data_retention_records
          WHERE expires_at < ? AND anonymized = 0
        `,
        )
        .bind(now)
        .all<{
          record_id: string;
          user_id: string;
          data_category: string;
        }>();

      if (!expiredRecords.results || expiredRecords.results.length === 0) {
        return { deleted: 0, anonymized: 0 };
      }

      // Process each expired record
      for (const record of expiredRecords.results) {
        // Check if this category should be anonymized
        if (this.policy.anonymizeAfterRetention.includes(record.data_category)) {
          // Anonymize the record
          await this.anonymizeData(record.record_id, record.data_category);

          // Mark as anonymized
          await this.db
            .prepare(
              `
              UPDATE data_retention_records
              SET anonymized = 1
              WHERE record_id = ?
            `,
            )
            .bind(record.record_id)
            .run();

          anonymized++;
        } else {
          // Delete the record
          await this.deleteData(record.record_id, record.data_category);

          // Remove from retention records
          await this.db
            .prepare(
              `
              DELETE FROM data_retention_records
              WHERE record_id = ?
            `,
            )
            .bind(record.record_id)
            .run();

          deleted++;
        }
      }

      this.logger.info(
        {
          deleted,
          anonymized,
          total: expiredRecords.results.length,
        },
        'Expired data cleanup completed',
      );

      return { deleted, anonymized };
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to clean up expired data');
      return { deleted: 0, anonymized: 0 };
    }
  }

  /**
   * Delete user data across all categories
   * @param userId User ID
   * @param context Hono context for user authentication
   * @returns Number of records deleted
   */
  async deleteUserData(userId: string, context?: Context): Promise<number> {
    try {
      // If context is available, verify user permissions
      if (context) {
        try {
          const userInfo = getUserInfo(context);

          // Only allow users to delete their own data unless they're an admin
          if (userInfo.role !== UserRole.ADMIN && userInfo.id !== userId) {
            throw new ForbiddenError('You can only delete your own data');
          }
        } catch (error) {
          if (error instanceof ForbiddenError) {
            throw error;
          }

          throw new ForbiddenError('Authentication required to delete user data');
        }
      }

      // Get all records for this user
      const userRecords = await this.db
        .prepare(
          `
          SELECT record_id, data_category
          FROM data_retention_records
          WHERE user_id = ?
        `,
        )
        .bind(userId)
        .all<{
          record_id: string;
          data_category: string;
        }>();

      if (!userRecords.results || userRecords.results.length === 0) {
        return 0;
      }

      // Delete each record
      for (const record of userRecords.results) {
        await this.deleteData(record.record_id, record.data_category);
      }

      // Remove from retention records
      const result = await this.db
        .prepare(
          `
          DELETE FROM data_retention_records
          WHERE user_id = ?
        `,
        )
        .bind(userId)
        .run();

      // Delete consent records
      await this.db
        .prepare(
          `
          DELETE FROM data_retention_consents
          WHERE user_id = ?
        `,
        )
        .bind(userId)
        .run();

      const deletedCount = result.meta?.changes || 0;

      this.logger.info(
        {
          userId,
          deletedCount,
        },
        'User data deleted',
      );

      return deletedCount;
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw error;
      }

      this.logger.error(
        {
          err: error,
          userId,
        },
        'Failed to delete user data',
      );
      throw error;
    }
  }

  /**
   * Delete specific data record
   * @param recordId Record ID
   * @param dataCategory Data category
   */
  private async deleteData(recordId: string, dataCategory: string): Promise<void> {
    try {
      // Handle different data categories
      switch (dataCategory) {
        case 'chatHistory':
          // Delete checkpoint
          await this.checkpointer.delete(recordId);
          break;

        case 'userData':
          // This would delete user data from appropriate tables
          // Implementation depends on the specific data structure
          break;

        case 'systemLogs':
          // This would delete system logs
          // Implementation depends on the logging system
          break;

        case 'analyticsData':
          // This would delete analytics data
          // Implementation depends on the analytics system
          break;

        default:
          this.logger.warn(
            {
              recordId,
              dataCategory,
            },
            'Unknown data category for deletion',
          );
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          recordId,
          dataCategory,
        },
        'Failed to delete data',
      );
      throw error;
    }
  }

  /**
   * Anonymize data record
   * @param recordId Record ID
   * @param dataCategory Data category
   */
  private async anonymizeData(recordId: string, dataCategory: string): Promise<void> {
    try {
      // Handle different data categories
      switch (dataCategory) {
        case 'analyticsData':
          // This would anonymize analytics data
          // Implementation depends on the analytics system
          // For example, replacing user ID with a hash or random ID
          break;

        default:
          this.logger.warn(
            {
              recordId,
              dataCategory,
            },
            'Unknown data category for anonymization',
          );
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          recordId,
          dataCategory,
        },
        'Failed to anonymize data',
      );
      throw error;
    }
  }

  /**
   * Get data retention statistics
   * @returns Statistics about data retention
   */
  async getStats(): Promise<{
    totalRecords: number;
    recordsByCategory: Record<string, number>;
    expiringRecords: number;
    anonymizedRecords: number;
    oldestRecord?: number;
    newestRecord?: number;
    recordsByUser?: Record<string, number>;
  }> {
    try {
      // Get total records
      const totalResult = await this.db
        .prepare('SELECT COUNT(*) as count FROM data_retention_records')
        .first<{ count: number }>();

      // Get records by category
      const categoryResults = await this.db
        .prepare(
          `
          SELECT data_category, COUNT(*) as count
          FROM data_retention_records
          GROUP BY data_category
        `,
        )
        .all<{
          data_category: string;
          count: number;
        }>();

      // Get expiring records (next 7 days)
      const now = Math.floor(Date.now() / 1000);
      const nextWeek = now + 7 * 24 * 60 * 60;

      const expiringResult = await this.db
        .prepare(
          `
          SELECT COUNT(*) as count
          FROM data_retention_records
          WHERE expires_at BETWEEN ? AND ?
        `,
        )
        .bind(now, nextWeek)
        .first<{ count: number }>();

      // Get anonymized records
      const anonymizedResult = await this.db
        .prepare(
          `
          SELECT COUNT(*) as count
          FROM data_retention_records
          WHERE anonymized = 1
        `,
        )
        .first<{ count: number }>();

      // Build records by category map
      const recordsByCategory: Record<string, number> = {};

      if (categoryResults.results) {
        for (const row of categoryResults.results) {
          recordsByCategory[row.data_category] = row.count;
        }
      }

      return {
        totalRecords: totalResult?.count || 0,
        recordsByCategory,
        expiringRecords: expiringResult?.count || 0,
        anonymizedRecords: anonymizedResult?.count || 0,
      };
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to get data retention stats');

      return {
        totalRecords: 0,
        recordsByCategory: {},
        expiringRecords: 0,
        anonymizedRecords: 0,
      };
    }
  }
}
