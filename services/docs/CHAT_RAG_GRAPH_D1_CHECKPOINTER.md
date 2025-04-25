# D1 Checkpointer Implementation for Chat RAG Graph

This document provides detailed pseudocode for implementing the D1 Checkpointer component of the Chat RAG Graph system. The checkpointer is responsible for persisting graph state to enable resumption of conversations and recovery from failures.

## 1. Overview

The D1 Checkpointer implements the `Checkpointer` interface from `@langchain/langgraph-checkpoint`. It uses Cloudflare's D1 database for state persistence, optimized for edge environments.

## 2. Schema Definition

```sql
-- D1 Schema for Checkpointer
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Index for efficient cleanup
CREATE INDEX IF NOT EXISTS idx_checkpoints_updated_at ON checkpoints(updated_at);
```

## 3. Implementation

```typescript
import { Checkpointer, SuperStep } from '@langchain/langgraph-checkpoint';
import { getLogger } from '@dome/logging';

/**
 * D1 Checkpointer for LangGraph state persistence
 * Optimized for Cloudflare Workers environment
 */
export class D1Checkpointer implements Checkpointer {
  private logger = getLogger();
  private db: D1Database;
  private ttlSeconds: number;

  /**
   * Create a new D1 Checkpointer
   * @param db D1 database instance
   * @param ttlSeconds Time-to-live in seconds for checkpoints (default: 24 hours)
   */
  constructor(db: D1Database, ttlSeconds = 86400) {
    this.db = db;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Initialize the checkpointer
   * Creates necessary tables if they don't exist
   */
  async initialize(): Promise<void> {
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          run_id TEXT PRIMARY KEY,
          step TEXT NOT NULL,
          state_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_checkpoints_updated_at 
        ON checkpoints(updated_at);
      `);
      this.logger.info('D1Checkpointer initialized successfully');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to initialize D1Checkpointer');
      throw error;
    }
  }

  /**
   * Read state from the database
   * @param runId Unique identifier for the conversation
   * @returns The stored state or null if not found
   */
  async read(runId: string): Promise<{ step: SuperStep; state: unknown } | null> {
    try {
      const result = await this.db
        .prepare('SELECT step, state_json FROM checkpoints WHERE run_id = ?')
        .bind(runId)
        .first<{ step: string; state_json: string }>();

      if (!result) {
        this.logger.debug({ runId }, 'No checkpoint found');
        return null;
      }

      this.logger.info({ runId, step: result.step }, 'Retrieved checkpoint');
      
      // Update the last accessed time
      await this.updateTimestamp(runId);
      
      return {
        step: result.step as SuperStep,
        state: JSON.parse(result.state_json),
      };
    } catch (error) {
      this.logger.error({ err: error, runId }, 'Error reading checkpoint');
      return null;
    }
  }

  /**
   * Write state to the database
   * @param runId Unique identifier for the conversation
   * @param step Current step in the graph
   * @param state State to persist
   */
  async write(runId: string, step: SuperStep, state: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const stateJson = JSON.stringify(state);
    
    try {
      // Check if record exists
      const exists = await this.db
        .prepare('SELECT 1 FROM checkpoints WHERE run_id = ?')
        .bind(runId)
        .first<{ 1: number }>();
      
      if (exists) {
        // Update existing record
        await this.db
          .prepare(`
            UPDATE checkpoints 
            SET step = ?, state_json = ?, updated_at = ? 
            WHERE run_id = ?
          `)
          .bind(step, stateJson, now, runId)
          .run();
      } else {
        // Insert new record
        await this.db
          .prepare(`
            INSERT INTO checkpoints (run_id, step, state_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(runId, step, stateJson, now, now)
          .run();
      }
      
      this.logger.info(
        { 
          runId, 
          step, 
          stateSize: stateJson.length,
        }, 
        'Checkpoint saved'
      );
    } catch (error) {
      this.logger.error(
        { 
          err: error, 
          runId, 
          step,
          stateSize: stateJson.length 
        }, 
        'Error writing checkpoint'
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
        .prepare('UPDATE checkpoints SET updated_at = ? WHERE run_id = ?')
        .bind(now, runId)
        .run();
    } catch (error) {
      this.logger.warn(
        { err: error, runId }, 
        'Failed to update checkpoint timestamp'
      );
      // Non-critical error, don't throw
    }
  }

  /**
   * Delete a specific checkpoint
   * @param runId Unique identifier for the conversation
   */
  async delete(runId: string): Promise<void> {
    try {
      await this.db
        .prepare('DELETE FROM checkpoints WHERE run_id = ?')
        .bind(runId)
        .run();
      
      this.logger.info({ runId }, 'Checkpoint deleted');
    } catch (error) {
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
        .prepare('DELETE FROM checkpoints WHERE updated_at < ?')
        .bind(cutoff)
        .run();
      
      const deletedCount = result.meta?.changes || 0;
      this.logger.info(
        { deletedCount, olderThan: maxAgeSeconds }, 
        'Cleaned up expired checkpoints'
      );
      
      return deletedCount;
    } catch (error) {
      this.logger.error(
        { err: error, maxAgeSeconds }, 
        'Error cleaning up checkpoints'
      );
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
      const stats = await this.db
        .prepare(`
          SELECT 
            COUNT(*) as total,
            MIN(created_at) as oldest,
            MAX(updated_at) as newest,
            AVG(LENGTH(state_json)) as avg_size
          FROM checkpoints
        `)
        .first<{
          total: number;
          oldest: number;
          newest: number;
          avg_size: number;
        }>();
      
      return {
        totalCheckpoints: stats?.total || 0,
        oldestCheckpoint: stats?.oldest || 0,
        newestCheckpoint: stats?.newest || 0,
        averageStateSize: Math.round(stats?.avg_size || 0),
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
}
```

## 4. Usage Example

```typescript
import { D1Checkpointer } from './checkpointer';
import { StateGraph } from '@langchain/langgraph';

// Initialize the checkpointer
const checkpointer = new D1Checkpointer(env.D1);
await checkpointer.initialize();

// Use in graph compilation
const graph = new StateGraph()
  // ... add nodes and edges
  .compile({
    checkpointer,
    reducers: { /* ... */ },
  });

// Execute with persistence
const result = await graph.invoke(initialState);

// Resume from checkpoint
const resumedResult = await graph.invoke(
  { newInput: 'additional data' },
  { runId: 'previous-run-id' }
);

// Scheduled cleanup (e.g., in a CRON trigger)
export async function scheduledCleanup(
  event: ScheduledEvent,
  env: Bindings,
  ctx: ExecutionContext
) {
  const checkpointer = new D1Checkpointer(env.D1);
  const deletedCount = await checkpointer.cleanup(7 * 86400); // 7 days
  console.log(`Cleaned up ${deletedCount} expired checkpoints`);
}
```

## 5. Performance Considerations

1. **State Size Management**
   - Large state objects can impact performance
   - Consider implementing state pruning for long conversations
   - Monitor `averageStateSize` metric

2. **Indexing Strategy**
   - The primary index is on `run_id` for fast lookups
   - Secondary index on `updated_at` optimizes cleanup operations

3. **Error Handling**
   - Robust error handling prevents data corruption
   - Non-critical errors (like timestamp updates) are logged but don't throw

4. **Cleanup Strategy**
   - Regular cleanup prevents database bloat
   - TTL-based approach balances persistence and resource usage
   - Consider implementing a scheduled cleanup via Cron Trigger

## 6. Monitoring and Observability

The D1Checkpointer includes comprehensive logging and statistics gathering:

1. **Logging**
   - All operations are logged with appropriate context
   - Error conditions include detailed diagnostics

2. **Statistics**
   - `getStats()` method provides insights into database usage
   - Monitor trends in checkpoint count and state size

3. **Integration with Metrics**
   - Export key metrics like state size and operation latency
   - Set up alerts for abnormal patterns

## 7. Future Enhancements

1. **Compression**
   - Add optional compression for large state objects
   - Trade CPU for storage efficiency

2. **Sharding**
   - Implement sharding for high-volume deployments
   - Partition by user ID or time ranges

3. **Versioning**
   - Add schema versioning for backward compatibility
   - Support migration between schema versions