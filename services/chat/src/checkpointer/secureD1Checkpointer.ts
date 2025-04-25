import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
} from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';
import { getLogger } from '@dome/logging';
import {
  getUserInfo,
  UserInfo,
  UserRole,
} from '@dome/common/src/middleware/enhancedAuthMiddleware.js';
// @ts-ignore - Using local mocks instead of @dome/errors
import { ForbiddenError, UnauthorizedError, BadRequestError } from '../utils/errorMocks';
import { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, lt, and, sql } from 'drizzle-orm';
import { checkpoints } from '../db/schema';

/**
 * Encryption service for securing sensitive data
 */
class EncryptionService {
  private encryptionKey: CryptoKey | null = null;

  /**
   * Initialize the encryption service with a key
   * @param env Environment bindings containing the encryption key
   */
  async initialize(env: Env): Promise<void> {
    if (!env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    // Convert the base64 key to a CryptoKey
    const keyData = this.base64ToArrayBuffer(env.ENCRYPTION_KEY);
    this.encryptionKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  /**
   * Encrypt sensitive data
   * @param data Data to encrypt
   * @returns Encrypted data as a base64 string with IV
   */
  async encrypt(data: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption service not initialized');
    }

    // Generate a random IV for each encryption
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt the data
    const dataBuffer = new TextEncoder().encode(data);
    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      this.encryptionKey,
      dataBuffer,
    );

    // Combine IV and encrypted data
    const result = new Uint8Array(iv.length + encryptedBuffer.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encryptedBuffer), iv.length);

    // Return as base64
    return this.arrayBufferToBase64(result);
  }

  /**
   * Decrypt sensitive data
   * @param encryptedData Encrypted data as a base64 string with IV
   * @returns Decrypted data
   */
  async decrypt(encryptedData: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption service not initialized');
    }

    // Convert base64 to array buffer
    const data = this.base64ToArrayBuffer(encryptedData);

    // Extract IV (first 12 bytes)
    const iv = data.slice(0, 12);

    // Extract encrypted data
    const encryptedBuffer = data.slice(12);

    // Decrypt the data
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      this.encryptionKey,
      encryptedBuffer,
    );

    // Return as string
    return new TextDecoder().decode(decryptedBuffer);
  }

  /**
   * Convert base64 string to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

/**
 * Interface for sensitive fields that need encryption
 */
interface SensitiveFields {
  // Fields that should be encrypted
  sensitiveFields: string[];
  // Fields that should be redacted in logs
  redactedFields: string[];
}

/**
 * Secure D1 Checkpointer for LangGraph state persistence
 * Implements field-level encryption and user-based access controls
 */
export class SecureD1Checkpointer extends BaseCheckpointSaver {
  private logger = getLogger();
  private db: ReturnType<typeof drizzle>;
  private ttlSeconds: number;
  private encryptionService: EncryptionService;
  private context?: Context;
  private sensitiveFields: SensitiveFields;

  /**
   * Create a new Secure D1 Checkpointer
   * @param d1db D1 database instance
   * @param env Environment bindings
   * @param context Hono context for user authentication
   * @param ttlSeconds Time-to-live in seconds for checkpoints (default: 24 hours)
   * @param sensitiveFields Configuration for sensitive fields
   */
  constructor(
    d1db: D1Database,
    env: Env,
    context?: Context,
    ttlSeconds = 86400,
    sensitiveFields: SensitiveFields = {
      sensitiveFields: ['messages', 'chatHistory', 'generatedText'],
      redactedFields: ['messages', 'chatHistory', 'generatedText', 'docs'],
    },
  ) {
    super();
    this.db = drizzle(d1db);
    this.ttlSeconds = ttlSeconds;
    this.encryptionService = new EncryptionService();
    this.context = context;
    this.sensitiveFields = sensitiveFields;

    // Initialize encryption service
    this.encryptionService.initialize(env).catch(error => {
      this.logger.error({ err: error }, 'Failed to initialize encryption service');
      throw error;
    });
  }

  /**
   * Initialize the checkpointer
   * Creates necessary tables if they don't exist
   */
  async initialize(): Promise<void> {
    // No need to create tables with Drizzle as migrations handle this
    try {
      this.logger.info('SecureD1Checkpointer initialized successfully');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to initialize SecureD1Checkpointer');
      throw error;
    }
  }

  /**
   * Read state from the database with access control
   * @param runId Unique identifier for the conversation
   * @returns The stored state or null if not found
   */
  async getTuple(
    config: RunnableConfig,
  ): Promise<
    | {
        config: RunnableConfig;
        checkpoint: Checkpoint;
        metadata?: CheckpointMetadata;
        parentConfig?: RunnableConfig;
      }
    | undefined
  > {
    const runId = config.configurable?.runId as string;
    if (!runId) {
      throw new BadRequestError('runId is required in config');
    }

    const result = await this.readCheckpoint(runId);
    if (!result) {
      return undefined;
    }

    return {
      config,
      checkpoint: result.checkpoint as Checkpoint,
      metadata: result.metadata as CheckpointMetadata,
      parentConfig: result.parentConfig,
    };
  }

  async readCheckpoint(
    runId: string,
  ): Promise<{ checkpoint: unknown; metadata?: unknown; parentConfig?: RunnableConfig } | null> {
    try {
      // Get user info if context is available
      const userInfo = this.context ? this.getUserInfo() : null;

      // Build query based on user role
      let query = this.db
        .select({
          step: checkpoints.step,
          stateJson: checkpoints.stateJson,
          userId: checkpoints.userId,
        })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId));

      // For non-admin users, enforce access control
      if (userInfo && userInfo.role !== UserRole.ADMIN) {
        query = this.db
          .select({
            step: checkpoints.step,
            stateJson: checkpoints.stateJson,
            userId: checkpoints.userId,
          })
          .from(checkpoints)
          .where(and(eq(checkpoints.runId, runId), eq(checkpoints.userId, userInfo.id)));
      }

      const result = await query.get();

      if (!result) {
        this.logger.debug({ runId }, 'No checkpoint found');
        return null;
      }

      // Verify access rights
      if (userInfo && userInfo.role !== UserRole.ADMIN && result.userId !== userInfo.id) {
        this.logger.warn(
          {
            runId,
            userId: userInfo.id,
            ownerUserId: result.userId,
          },
          'Unauthorized access attempt to checkpoint',
        );
        throw new ForbiddenError('You do not have permission to access this checkpoint');
      }

      this.logger.info(
        {
          runId,
          step: result.step,
          userId: result.userId,
        },
        'Retrieved checkpoint',
      );

      // Update the last accessed time
      await this.updateTimestamp(runId);

      // Parse and decrypt state
      const state = await this.decryptState(JSON.parse(result.stateJson));

      return {
        checkpoint: state,
        metadata: {
          source: 'loop',
          step: parseInt(result.step),
          writes: null,
        },
        parentConfig: undefined,
      };
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
        throw error;
      }

      this.logger.error(
        {
          err: error,
          runId,
        },
        'Error reading checkpoint',
      );
      return null;
    }
  }

  /**
   * Write state to the database with encryption and access control
   * @param runId Unique identifier for the conversation
   * @param step Current step in the graph
   * @param state State to persist
   */
  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig },
  ): AsyncGenerator<{
    config: RunnableConfig;
    checkpoint: Checkpoint;
    metadata?: CheckpointMetadata;
    parentConfig?: RunnableConfig;
  }> {
    // Implementation for listing checkpoints
    // This is a placeholder that yields nothing
    return;
  }

  /**
   * Implement the putWrites method required by BaseCheckpointSaver
   */
  async putWrites(config: RunnableConfig, writes: any[], taskId: string): Promise<void> {
    // Implementation for storing writes
    // This is a placeholder that does nothing
    return;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const runId = config.configurable?.runId as string;
    if (!runId) {
      throw new BadRequestError('runId is required in config');
    }

    await this.writeCheckpoint(runId, metadata.step.toString(), checkpoint);

    return config;
  }

  async writeCheckpoint(runId: string, step: string, state: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    try {
      // Get user info if context is available
      const userInfo = this.context ? this.getUserInfo() : null;
      const userId = userInfo?.id || 'system';

      // Encrypt sensitive fields
      const encryptedState = await this.encryptState(state);
      const stateJson = JSON.stringify(encryptedState);

      // Sanitize state for logging
      const sanitizedState = this.sanitizeStateForLogging(state);

      // Check if record exists and verify ownership
      const existingRecord = await this.db
        .select({ userId: checkpoints.userId })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .get();

      if (existingRecord) {
        // Verify ownership for non-admin users
        if (userInfo && userInfo.role !== UserRole.ADMIN && existingRecord.userId !== userInfo.id) {
          this.logger.warn(
            {
              runId,
              userId: userInfo.id,
              ownerUserId: existingRecord.userId,
            },
            'Unauthorized write attempt to checkpoint',
          );
          throw new ForbiddenError('You do not have permission to modify this checkpoint');
        }

        // Update existing record
        await this.db
          .update(checkpoints)
          .set({
            step: step,
            stateJson: stateJson,
            updatedAt: now,
          })
          .where(eq(checkpoints.runId, runId))
          .run();
      } else {
        // Insert new record
        await this.db
          .insert(checkpoints)
          .values({
            runId: runId,
            userId: userId,
            step: step,
            stateJson: stateJson,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      this.logger.info(
        {
          runId,
          step,
          userId,
          stateSize: stateJson.length,
          state: sanitizedState,
        },
        'Checkpoint saved',
      );
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
        throw error;
      }

      this.logger.error(
        {
          err: error,
          runId,
          step,
        },
        'Error writing checkpoint',
      );
      throw error;
    }
  }

  /**
   * Update the last accessed timestamp for a checkpoint
   * @param runId Unique identifier for the conversation
   */
  private async updateTimestamp(runId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.db
        .update(checkpoints)
        .set({ updatedAt: now })
        .where(eq(checkpoints.runId, runId))
        .run();
    } catch (error) {
      this.logger.warn({ err: error, runId }, 'Failed to update checkpoint timestamp');
      // Non-critical error, don't throw
    }
  }

  /**
   * Delete a specific checkpoint with access control
   * @param runId Unique identifier for the conversation
   */
  async delete(runId: string): Promise<void> {
    try {
      // Get user info if context is available
      const userInfo = this.context ? this.getUserInfo() : null;

      // For non-admin users, verify ownership
      if (userInfo && userInfo.role !== UserRole.ADMIN) {
        const record = await this.db
          .select({ userId: checkpoints.userId })
          .from(checkpoints)
          .where(eq(checkpoints.runId, runId))
          .get();

        if (record && record.userId !== userInfo.id) {
          this.logger.warn(
            {
              runId,
              userId: userInfo.id,
              ownerUserId: record.userId,
            },
            'Unauthorized delete attempt of checkpoint',
          );
          throw new ForbiddenError('You do not have permission to delete this checkpoint');
        }
      }

      // Delete the checkpoint
      await this.db.delete(checkpoints).where(eq(checkpoints.runId, runId)).run();

      this.logger.info({ runId }, 'Checkpoint deleted');
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
        throw error;
      }

      this.logger.error({ err: error, runId }, 'Error deleting checkpoint');
      throw error;
    }
  }

  /**
   * Clean up expired checkpoints
   * @param maxAgeSeconds Maximum age in seconds (defaults to ttlSeconds)
   */
  async cleanup(maxAgeSeconds = this.ttlSeconds): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;

    try {
      const result = await this.db
        .delete(checkpoints)
        .where(lt(checkpoints.updatedAt, cutoff))
        .run();

      const deletedCount = result.meta?.changes || 0;
      this.logger.info(
        { deletedCount, olderThan: maxAgeSeconds },
        'Cleaned up expired checkpoints',
      );

      return deletedCount;
    } catch (error) {
      this.logger.error({ err: error, maxAgeSeconds }, 'Error cleaning up checkpoints');
      return 0;
    }
  }

  /**
   * Get statistics about stored checkpoints
   */
  async getStats(): Promise<{
    totalCheckpoints: number;
    oldestCheckpoint: number;
    newestCheckpoint: number;
    averageStateSize: number;
    checkpointsByUser?: Record<string, number>;
  }> {
    try {
      // For complex aggregations, we'll use a SQL query with Drizzle's sql template
      const stats = await this.db.get<{
        total: number;
        oldest: number;
        newest: number;
        avg_size: number;
      }>(sql`
        SELECT
          COUNT(*) as total,
          MIN(created_at) as oldest,
          MAX(updated_at) as newest,
          AVG(LENGTH(state_json)) as avg_size
        FROM checkpoints
      `);

      // Get user info if context is available
      const userInfo = this.context ? this.getUserInfo() : null;

      // For admin users, include checkpoint counts by user
      let checkpointsByUser: Record<string, number> | undefined = undefined;

      if (userInfo?.role === UserRole.ADMIN) {
        const userStats = await this.db.all<{
          user_id: string;
          count: number;
        }>(sql`
          SELECT user_id, COUNT(*) as count
          FROM checkpoints
          GROUP BY user_id
        `);

        if (userStats) {
          checkpointsByUser = {};
          for (const row of userStats) {
            checkpointsByUser[row.user_id] = row.count;
          }
        }
      }

      return {
        totalCheckpoints: stats?.total || 0,
        oldestCheckpoint: stats?.oldest || 0,
        newestCheckpoint: stats?.newest || 0,
        averageStateSize: Math.round(stats?.avg_size || 0),
        checkpointsByUser,
      };
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting checkpoint stats');
      return {
        totalCheckpoints: 0,
        oldestCheckpoint: 0,
        newestCheckpoint: 0,
        averageStateSize: 0,
      };
    }
  }

  /**
   * Get user info from context
   * @returns User information
   * @throws UnauthorizedError if user info is not available
   */
  private getUserInfo(): UserInfo {
    if (!this.context) {
      throw new UnauthorizedError('Context not available for user authentication');
    }

    try {
      return getUserInfo(this.context);
    } catch (error) {
      throw new UnauthorizedError('User authentication required');
    }
  }

  /**
   * Encrypt sensitive fields in state
   * @param state State object
   * @returns State with encrypted sensitive fields
   */
  private async encryptState(state: unknown): Promise<unknown> {
    if (!state || typeof state !== 'object') {
      return state;
    }

    const result = { ...(state as Record<string, any>) };

    for (const field of this.sensitiveFields.sensitiveFields) {
      if (field in result && result[field] !== undefined && result[field] !== null) {
        // Encrypt the field
        const serialized = JSON.stringify(result[field]);
        result[field] = await this.encryptionService.encrypt(serialized);
      }
    }

    return result;
  }

  /**
   * Decrypt sensitive fields in state
   * @param state State object with encrypted fields
   * @returns State with decrypted fields
   */
  private async decryptState(state: unknown): Promise<unknown> {
    if (!state || typeof state !== 'object') {
      return state;
    }

    const result = { ...(state as Record<string, any>) };

    for (const field of this.sensitiveFields.sensitiveFields) {
      if (field in result && typeof result[field] === 'string') {
        try {
          // Decrypt the field
          const decrypted = await this.encryptionService.decrypt(result[field]);
          result[field] = JSON.parse(decrypted);
        } catch (error) {
          // If decryption fails, keep the original value
          this.logger.warn({ field }, 'Failed to decrypt field');
        }
      }
    }

    return result;
  }

  /**
   * Sanitize state for logging by redacting sensitive fields
   * @param state State object
   * @returns Sanitized state for logging
   */
  private sanitizeStateForLogging(state: unknown): unknown {
    if (!state || typeof state !== 'object') {
      return state;
    }

    const result = { ...(state as Record<string, any>) };

    for (const field of this.sensitiveFields.redactedFields) {
      if (field in result) {
        if (Array.isArray(result[field])) {
          result[field] = `[Array with ${result[field].length} items]`;
        } else if (typeof result[field] === 'object' && result[field] !== null) {
          result[field] = '[Object]';
        } else {
          result[field] = '[REDACTED]';
        }
      }
    }

    return result;
  }
}
