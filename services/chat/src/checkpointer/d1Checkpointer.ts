import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
} from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';
import { getLogger, logError } from '@dome/common';
import { drizzle } from 'drizzle-orm/d1';
import { eq, lt, sql } from 'drizzle-orm';
import { checkpoints } from '../db/schema';

/**
 * D1 Checkpointer for LangGraph state persistence
 * Optimized for Cloudflare Workers environment
 * Uses Drizzle ORM for database operations
 */
export class D1Checkpointer extends BaseCheckpointSaver {
  private logger = getLogger().child({ component: 'D1Checkpointer' });
  private db: ReturnType<typeof drizzle>;
  private ttlSeconds: number;

  /**
   * Create a new D1 Checkpointer
   * @param d1db D1 database instance
   * @param ttlSeconds Time-to-live in seconds for checkpoints (default: 24 hours)
   */
  constructor(d1db: D1Database, ttlSeconds = 86400) {
    super();
    this.db = drizzle(d1db);
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Initialize the checkpointer
   * Creates necessary tables if they don't exist
   */
  async initialize(): Promise<void> {
    // No need to create tables with Drizzle as migrations handle this
    try {
      this.logger.info('D1Checkpointer initialized successfully');
    } catch (error) {
      logError(error, 'Failed to initialize D1Checkpointer');
      throw error;
    }
  }

  /**
   * Read state from the database
   * @param runId Unique identifier for the conversation
   * @returns The stored state or null if not found
   */
  async getTuple(config: RunnableConfig): Promise<
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
      throw new Error('runId is required in config');
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
      const result = await this.db
        .select({
          step: checkpoints.step,
          stateJson: checkpoints.stateJson,
        })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .get();

      if (!result) {
        this.logger.debug({ runId }, 'No checkpoint found');
        return null;
      }

      this.logger.info({ runId, step: result.step }, 'Retrieved checkpoint');

      // Update the last accessed time
      await this.updateTimestamp(runId);

      const state = JSON.parse(result.stateJson);

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
      logError(error, 'Error reading checkpoint', { runId });
      return null;
    }
  }

  /**
   * Implement the list method required by BaseCheckpointSaver
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

  /**
   * Implement the put method required by BaseCheckpointSaver
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const runId = config.configurable?.runId as string;
    if (!runId) {
      throw new Error('runId is required in config');
    }

    await this.writeCheckpoint(runId, metadata.step.toString(), checkpoint);

    return config;
  }

  /**
   * Write state to the database
   * @param runId Unique identifier for the conversation
   * @param step Current step in the graph
   * @param state State to persist
   */
  async writeCheckpoint(runId: string, step: string, state: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const stateJson = JSON.stringify(state);

    try {
      // Check if record exists
      const exists = await this.db
        .select({ count: checkpoints.runId })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .get();

      if (exists) {
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
          stateSize: stateJson.length,
          // Only log metadata, not the full state
        },
        'Checkpoint saved',
      );
    } catch (error) {
      logError(
        error,
        'Error writing checkpoint',
        {
          runId,
          step,
          stateSize: stateJson.length,
        },
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
   * Delete a specific checkpoint
   * @param runId Unique identifier for the conversation
   */
  async delete(runId: string): Promise<void> {
    try {
      await this.db.delete(checkpoints).where(eq(checkpoints.runId, runId)).run();

      this.logger.info({ runId }, 'Checkpoint deleted');
    } catch (error) {
      logError(error, 'Error deleting checkpoint', { runId });
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
      logError(error, 'Error cleaning up checkpoints', { maxAgeSeconds });
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
  }> {
    try {
      // For complex aggregations, we'll use a SQL query with Drizzle's sql template
      // This is one case where raw SQL is still useful with Drizzle
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

      return {
        totalCheckpoints: stats?.total || 0,
        oldestCheckpoint: stats?.oldest || 0,
        newestCheckpoint: stats?.newest || 0,
        averageStateSize: Math.round(stats?.avg_size || 0),
      };
    } catch (error) {
      logError(error, 'Error getting checkpoint stats');
      return {
        totalCheckpoints: 0,
        oldestCheckpoint: 0,
        newestCheckpoint: 0,
        averageStateSize: 0,
      };
    }
  }
}
