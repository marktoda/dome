import { getLogger, logError, getUserInfo, UserRole, ForbiddenError } from '@dome/common';
import { D1Checkpointer } from '../checkpointer/d1Checkpointer';
import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { dataRetentionConsents, dataRetentionRecords } from '../db/schema';
import { and, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';

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
   * Data categories that require user consent
   */
  requiresConsentCategories: string[];

  /**
   * Data categories that should be encrypted
   */
  encryptedCategories: string[];

  /**
   * Data categories that should be anonymized after retention period
   */
  anonymizeAfterRetention: string[];
}

/**
 * Default retention policy
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
  private checkpointer: D1Checkpointer;

  /**
   * Create a new data retention manager
   * @param db D1 database instance
   * @param checkpointer Secure D1 checkpointer
   * @param policy Data retention policy
   */
  constructor(
    db: D1Database,
    checkpointer: D1Checkpointer,
    policy: DataRetentionPolicy = DEFAULT_RETENTION_POLICY,
  ) {
    this.db = db;
    this.checkpointer = checkpointer;
    this.policy = policy;
  }

  /**
   * Initialize the data retention manager
   */
  async initialize(): Promise<void> {
    try {
      // Initialize tables if they don't exist
      // This is now handled by Drizzle migrations
    } catch (error) {
      logError(error, 'Failed to initialize data retention manager');
      throw error;
    }
  }

  /**
   * Check if user has consented to data retention for a category
   * @param userId User ID
   * @param dataCategory Data category
   * @returns True if user has consented
   */
  async hasConsent(userId: string, dataCategory: string): Promise<boolean> {
    // All users are considered to have consent for now
    return true;
  }

  /**
   * Record user consent for data retention
   * @param userId User ID
   * @param dataCategory Data category
   * @param durationDays Duration in days (optional)
   */
  async recordConsent(userId: string, dataCategory: string, durationDays?: number): Promise<void> {
    try {
      // Initialize Drizzle with the D1 database
      const db = drizzle(this.db);

      // Calculate expiration date if provided
      const expiresAt = durationDays ? Date.now() + durationDays * 24 * 60 * 60 * 1000 : null;

      // Insert or update consent record using Drizzle
      await db
        .insert(dataRetentionConsents)
        .values({
          userId,
          dataCategory,
          consentedAt: Date.now(),
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [dataRetentionConsents.userId, dataRetentionConsents.dataCategory],
          set: {
            consentedAt: Date.now(),
            expiresAt,
          },
        });

      this.logger.info(
        {
          userId,
          dataCategory,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : 'never',
        },
        'User consent recorded',
      );
    } catch (error) {
      logError(
        error,
        'Failed to record user consent',
        {
          userId,
          dataCategory,
        },
      );
      throw error;
    }
  }

  /**
   * Register data record for retention
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
        // Check if user has consented
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

      const now = Date.now();

      // Get retention period for this category
      const retentionPeriod =
        this.policy.retentionPeriods[dataCategory as keyof typeof this.policy.retentionPeriods] ||
        this.policy.defaultRetentionPeriod;

      const expiresAt = now + retentionPeriod * 1000; // Convert seconds to milliseconds

      // Initialize Drizzle with the D1 database
      const db = drizzle(this.db);

      // Insert record using Drizzle
      await db.insert(dataRetentionRecords).values({
        recordId,
        userId,
        dataCategory,
        createdAt: now,
        expiresAt,
        anonymized: false,
      });

      this.logger.info(
        {
          recordId,
          userId,
          dataCategory,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        'Data record registered for retention',
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw error;
      }
  
        logError(
          error,
          'Failed to register data record',
          {
            recordId,
            userId,
            dataCategory,
          },
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
      const now = Date.now();
      let deleted = 0;
      let anonymized = 0;

      // Initialize Drizzle with the D1 database
      const db = drizzle(this.db);

      // Get expired records using Drizzle
      const expiredRecords = await db
        .select()
        .from(dataRetentionRecords)
        .where(
          and(lte(dataRetentionRecords.expiresAt, now), eq(dataRetentionRecords.anonymized, false)),
        )
        .limit(100);

      if (expiredRecords.length === 0) {
        return { deleted: 0, anonymized: 0 };
      }

      // Process each expired record
      for (const record of expiredRecords) {
        // Check if this category should be anonymized
        if (this.policy.anonymizeAfterRetention.includes(record.dataCategory)) {
          // Anonymize the record
          await this.anonymizeData(record.recordId, record.dataCategory);

          // Mark as anonymized using Drizzle
          await db
            .update(dataRetentionRecords)
            .set({ anonymized: true })
            .where(eq(dataRetentionRecords.recordId, record.recordId));

          anonymized++;
        } else {
          // Delete the record
          await this.deleteData(record.recordId, record.dataCategory);

          // Remove from retention records using Drizzle
          await db
            .delete(dataRetentionRecords)
            .where(eq(dataRetentionRecords.recordId, record.recordId));

          deleted++;
        }
      }

      this.logger.info(
        {
          deleted,
          anonymized,
          total: expiredRecords.length,
        },
        'Expired data cleanup completed',
      );

      return { deleted, anonymized };
    } catch (error) {
      logError(error, 'Failed to clean up expired data');
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

      // Initialize Drizzle with the D1 database
      const db = drizzle(this.db);

      // Get all records for this user using Drizzle
      const userRecords = await db
        .select({
          recordId: dataRetentionRecords.recordId,
          dataCategory: dataRetentionRecords.dataCategory,
        })
        .from(dataRetentionRecords)
        .where(eq(dataRetentionRecords.userId, userId));

      if (userRecords.length === 0) {
        return 0;
      }

      // Delete each record
      for (const record of userRecords) {
        await this.deleteData(record.recordId, record.dataCategory);
      }

      // Remove from retention records using Drizzle
      const result = await db
        .delete(dataRetentionRecords)
        .where(eq(dataRetentionRecords.userId, userId));

      // Delete consent records using Drizzle
      await db.delete(dataRetentionConsents).where(eq(dataRetentionConsents.userId, userId));

      const deletedCount = userRecords.length;

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
  
        logError(
          error,
          'Failed to delete user data',
          { userId },
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
      logError(
        error,
        'Failed to delete data',
        {
          recordId,
          dataCategory,
        },
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
        error,
        'Failed to anonymize data',
        {
          recordId,
          dataCategory,
        },
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
      // Initialize Drizzle with the D1 database
      const db = drizzle(this.db);

      // Get total records using Drizzle
      const totalResult = await db
        .select({
          count: sql`count(*)`,
        })
        .from(dataRetentionRecords);

      // Get records by category using Drizzle
      const categoryResults = await db
        .select({
          dataCategory: dataRetentionRecords.dataCategory,
          count: sql`count(*)`,
        })
        .from(dataRetentionRecords)
        .groupBy(dataRetentionRecords.dataCategory);

      // Get expiring records (next 7 days)
      const now = Date.now();
      const nextWeek = now + 7 * 24 * 60 * 60 * 1000; // Convert days to milliseconds

      const expiringResult = await db
        .select({
          count: sql`count(*)`,
        })
        .from(dataRetentionRecords)
        .where(
          and(
            gte(dataRetentionRecords.expiresAt, now),
            lte(dataRetentionRecords.expiresAt, nextWeek),
          ),
        );

      // Get anonymized records using Drizzle
      const anonymizedResult = await db
        .select({
          count: sql`count(*)`,
        })
        .from(dataRetentionRecords)
        .where(eq(dataRetentionRecords.anonymized, true));

      // Build records by category map
      const recordsByCategory: Record<string, number> = {};

      // Process category results from Drizzle
      for (const row of categoryResults) {
        recordsByCategory[row.dataCategory] = Number(row.count);
      }

      return {
        totalRecords: Number(totalResult[0]?.count || 0),
        recordsByCategory,
        expiringRecords: Number(expiringResult[0]?.count || 0),
        anonymizedRecords: Number(anonymizedResult[0]?.count || 0),
      };
    } catch (error) {
      logError(error, 'Failed to get data retention stats');

      return {
        totalRecords: 0,
        recordsByCategory: {},
        expiringRecords: 0,
        anonymizedRecords: 0,
      };
    }
  }
}
